import { Component, FileView, Notice, TFile, type App, type Plugin } from "obsidian";
import { patchPluginData } from "../plugin-data";
import { anchorFromActiveSelection } from "./annotation-anchor";
import { AnnotationLayer } from "./annotation-layer";
import {
	applyPdfAnnotationStyleSettings,
	clearPdfAnnotationStyleSettings,
	DEFAULT_PDF_ANNOTATION_SETTINGS,
	loadPdfAnnotationSettings,
	type PdfAnnotationSettings,
} from "./annotation-settings";
import { PdfAnnotationStore } from "./annotation-store";
import { makeAnnotationId, type MarginSide, type PdfAnnotation } from "./annotation-types";
import { getActivePDFView, onPageReady, onTextLayerReady, type PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { attachRectSelectListener, type RectSelectController } from "./rect-select";

/** How a newly created note should appear. */
export interface NewNoteForm {
	pinned: boolean;
	side: MarginSide;
	collapsed: boolean;
}

interface ViewState {
	pages: Map<number, PDFPageView>;
	layer: AnnotationLayer;
	currentPath: () => string | null;
}

/**
 * Owns the PDF-annotation feature end to end: scans open PDF views, tracks their
 * pages, places new notes, and keeps each view's annotation layer up to date.
 */
export class PdfAnnotationsController {
	readonly store: PdfAnnotationStore;
	settings: PdfAnnotationSettings = DEFAULT_PDF_ANNOTATION_SETTINGS;

	private rectSelect: RectSelectController = { armed: false };
	private pendingPlacement: NewNoteForm | null = null;
	private states = new WeakMap<FileView, ViewState>();
	private tracked = new WeakSet<FileView>();
	/**
	 * The PDF view to act on. Tracked separately from "the active view" because
	 * the annotation list panel becomes the active view the moment it's clicked —
	 * asking Obsidian for the active PDF at that point returns nothing, which is
	 * why the panel used to blank out and its rows did nothing.
	 */
	private lastPdfView: FileView | null = null;

	constructor(
		private plugin: Plugin,
		private app: App
	) {
		this.store = new PdfAnnotationStore(app, plugin);
	}

	async onload(): Promise<void> {
		this.settings = await loadPdfAnnotationSettings(this.plugin);
		applyPdfAnnotationStyleSettings(this.settings);
		this.plugin.register(() => clearPdfAnnotationStyleSettings());

		try {
			await this.store.load(this.settings.dataPath);
		} catch (e) {
			new Notice(String(e instanceof Error ? e.message : e));
			throw e;
		}

		// Any mutation from anywhere — including the list panel, which owns no
		// layer of its own — has to reach the on-page rendering. Without this,
		// deleting or editing a note in the panel updated the panel and the file
		// but left the note sitting on the PDF until the next page render.
		// (Layer rebuilds are debounced and skip while a note is being dragged or
		// edited, so the extra churn from in-layer edits is harmless.)
		this.plugin.register(this.store.onChange(() => this.rebuildAll()));

		this.app.workspace.onLayoutReady(() => this.scanPDFViews());
		this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.scanPDFViews()));
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.scanPDFViews();
				this.targetPdfView(); // refresh the remembered PDF while one has focus
			})
		);
		// Plain path-string keys would otherwise orphan a file's notes on rename/move.
		this.plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "pdf") this.store.renameFile(oldPath, file.path);
			})
		);
		// The rail is positioned against the visible width of the pane, so a pane
		// resize moves it; pdf.js doesn't necessarily re-render pages for that.
		this.plugin.registerEvent(this.app.workspace.on("resize", () => this.rebuildAll()));
	}

	async saveSettings(next: PdfAnnotationSettings): Promise<void> {
		const pathChanged = next.dataPath !== this.settings.dataPath;
		this.settings = next;
		applyPdfAnnotationStyleSettings(this.settings);
		await patchPluginData(this.plugin, { pdfAnnotationSettings: this.settings });
		if (pathChanged) await this.store.relocate(next.dataPath);
		this.rebuildAll();
	}

	/** Partial update used by in-canvas affordances (e.g. dragging the rail wider). */
	patchSettings(patch: Partial<PdfAnnotationSettings>): void {
		void this.saveSettings({ ...this.settings, ...patch });
	}

	/**
	 * The PDF view to act on: the active one if a PDF has focus, otherwise the
	 * last PDF that did — as long as it's still open somewhere.
	 */
	private targetPdfView(): FileView | null {
		const active = getActivePDFView(this.app);
		if (active) {
			this.lastPdfView = active;
			return active;
		}
		const stillOpen = this.app.workspace.getLeavesOfType("pdf").some((l) => l.view === this.lastPdfView);
		if (!stillOpen) this.lastPdfView = null;
		return this.lastPdfView;
	}

	/** The PDF the panel should be showing. */
	currentPdfTarget(): TFile | null {
		const file = this.targetPdfView()?.file;
		return file instanceof TFile && file.extension === "pdf" ? file : null;
	}

	hasActivePDFView(): boolean {
		return !!getActivePDFView(this.app);
	}

	/**
	 * Starts placing a note: anchors to the active text selection if there is
	 * one, otherwise arms a one-shot drag so the user can box the region the note
	 * refers to.
	 */
	addNote(form: NewNoteForm): void {
		const sel = anchorFromActiveSelection();
		if (sel) {
			this.place(sel.file.path, sel.pageNumber, sel.rect, form);
			return;
		}
		this.pendingPlacement = form;
		this.rectSelect.armed = true;
		new Notice("在 PDF 上拖一个框,标出这条批注指的位置");
	}

	/**
	 * Opens the PDF at the note's page, then flashes it.
	 *
	 * Reuses the leaf the PDF is already in (the common case — you're browsing
	 * the list panel of a PDF you already have open) rather than opening a
	 * second copy. Navigating an ALREADY-open file to a page/subpath is
	 * `View.setEphemeralState()`, not `setState()` — `setState()`'s shape is
	 * per-view persisted state (`{file, subpath}` isn't a key it understands for
	 * FileView), which is why this silently did nothing before.
	 */
	async revealAnnotation(pdfPath: string, ann: PdfAnnotation): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType("pdf")
			.find((l) => (l.view as FileView).file?.path === pdfPath);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			existing.view.setEphemeralState({ subpath: `#page=${ann.page}` });
		} else {
			await this.app.workspace.openLinkText(`${pdfPath}#page=${ann.page}`, "", false);
		}

		// Give pdf.js a beat to render the target page before looking for the element.
		window.setTimeout(() => {
			const view = this.targetPdfView();
			const state = view ? this.states.get(view) : null;
			state?.layer.reveal(state.pages, ann);
		}, 350);
	}

	private place(pdfPath: string, pageNumber: number, rect: PdfRect, form: NewNoteForm): void {
		const ann: PdfAnnotation = {
			id: makeAnnotationId(),
			page: pageNumber,
			anchor: rect,
			pinned: form.pinned,
			collapsed: form.collapsed,
			side: form.side,
			text: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.store.upsert(pdfPath, ann);

		const view = getActivePDFView(this.app);
		const state = view ? this.states.get(view) : null;
		if (state) state.layer.rebuild(pdfPath, state.pages);
	}

	private rebuildAll(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const state = this.states.get(leaf.view as FileView);
			const path = state?.currentPath();
			if (state && path) state.layer.rebuild(path, state.pages);
		}
	}

	private scanPDFViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const view = leaf.view as FileView;
			if (this.tracked.has(view)) continue;
			this.tracked.add(view);
			this.attachPageHandlers(view);
		}
	}

	private attachPageHandlers(view: FileView): void {
		const component = new Component();
		this.plugin.addChild(component);

		const pages = new Map<number, PDFPageView>();
		const layer = new AnnotationLayer(
			this.app,
			component,
			this.store,
			() => this.settings,
			(patch) => this.patchSettings(patch)
		);

		// Obsidian reuses the same FileView (and pdf.js viewer) when the user opens a
		// different PDF in the same tab — read view.file fresh each time instead of
		// capturing it, so notes follow the file actually open.
		let lastPath: string | null = null;
		const currentPath = (): string | null => {
			const file = view.file;
			if (!(file instanceof TFile)) return null;
			if (file.path !== lastPath) {
				pages.clear();
				lastPath = file.path;
			}
			return file.path;
		};

		this.states.set(view, { pages, layer, currentPath });
		component.register(() => layer.destroy());

		const trackedPageDivs = new WeakSet<HTMLDivElement>();

		onPageReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			const path = currentPath();
			pages.set(pageNumber, pageView);

			if (!trackedPageDivs.has(pageView.div)) {
				trackedPageDivs.add(pageView.div);
				const detach = attachRectSelectListener(pageView, this.rectSelect, (rect) => {
					const pending = this.pendingPlacement;
					this.pendingPlacement = null;
					const p = currentPath();
					if (pending && p) this.place(p, pageNumber, rect, pending);
				});
				component.register(detach);
			}

			if (path) layer.rebuild(path, pages);
		});

		// Positions depend on each page's rendered box, which can shift slightly
		// once the text layer settles — cheap enough to just redo it.
		onTextLayerReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			pages.set(pageNumber, pageView);
			const path = currentPath();
			if (path) layer.rebuild(path, pages);
		});
	}
}
