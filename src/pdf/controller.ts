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
import {
	canonicalOf,
	differentLanguage,
	findNameCandidates,
	fingerprintsPair,
	sameGeometry,
	ScriptSampler,
	type PdfFingerprint,
} from "./counterpart";
import { getActivePDFView, getPdfDocument, onPageReady, onTextLayerReady, type PdfRect } from "./pdf-layer";
import { getTextLayerInfo } from "./selection-geom";
import type { PDFPageView } from "./pdfjs-types";
import { attachRectSelectListener, type RectSelectController } from "./rect-select";
import { findScrollAncestor } from "./scroll-container";

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
	/** Accumulates the script mix of the open document, for counterpart detection. */
	sampler: ScriptSampler;
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
	 * Records what we can see of the open document (page count, page box, script
	 * mix) and, once both sides of a name-match have been seen, links them.
	 *
	 * Everything here comes from the live viewer — nothing loads a second PDF.
	 * That's why pairing only completes after both files have been opened once,
	 * which is also the point at which it can be *checked* rather than guessed
	 * from the filename.
	 */
	private captureFingerprint(view: FileView, path: string, state: ViewState): void {
		if (!state.sampler.hasSample) return;
		const pageView = state.pages.values().next().value;
		const doc = getPdfDocument(view);
		if (!pageView?.pdfPage?.view || !doc) return;

		const [x0, y0, x1, y1] = pageView.pdfPage.view;
		const fp: PdfFingerprint = {
			pages: doc.numPages,
			width: Math.round(x1 - x0),
			height: Math.round(y1 - y0),
			cjk: state.sampler.ratio,
		};
		this.store.setFingerprint(path, fp);
		this.tryAutoPair(path, fp);
	}

	/** Links `path` to a same-named counterpart whose fingerprint proves it's a
	 * translation with the same layout. Silent when nothing qualifies. */
	private tryAutoPair(path: string, fp: PdfFingerprint): void {
		if (this.store.isPaired(path)) return;
		for (const candidate of findNameCandidates(this.app, path)) {
			const other = this.store.getFingerprint(candidate);
			if (!other || !fingerprintsPair(fp, other)) continue;
			this.store.pair(path, candidate, canonicalOf(path, fp, candidate, other));
			new Notice(`已关联原文/译文,批注共用:\n${candidate.split("/").pop()}`);
			return;
		}
	}

	/** The paired original/translation of the PDF in focus, if any. */
	counterpartOfActive(): string | null {
		const file = this.currentPdfTarget();
		return file ? this.store.counterpartOf(file.path) : null;
	}

	/** Names the specific check that stopped a pairing, so it can be acted on. */
	private explainNoCounterpart(path: string): string {
		const candidates = findNameCandidates(this.app, path);
		if (candidates.length === 0) {
			return "没有找到名字相近的另一份 PDF。\n可以用「手动关联」命令直接指定。";
		}
		const mine = this.store.getFingerprint(path);
		if (!mine) {
			return "当前 PDF 还没采集到指纹(等文字层渲染完再试一次)。";
		}
		const unopened = candidates.filter((c) => !this.store.getFingerprint(c));
		if (unopened.length > 0) {
			return `找到候选:${unopened[0].split("/").pop()}\n但它还没被打开过——打开一次就会自动关联。`;
		}
		for (const c of candidates) {
			const other = this.store.getFingerprint(c)!;
			if (!sameGeometry(mine, other)) {
				return `候选 ${c.split("/").pop()} 的页数/尺寸和当前文件不一致(${mine.pages}页 ${mine.width}×${mine.height} vs ${other.pages}页 ${other.width}×${other.height}),排版对不上,不能共用坐标。`;
			}
			if (!differentLanguage(mine, other)) {
				return `候选 ${c.split("/").pop()} 看起来和当前文件是同一种语言(中文占比 ${mine.cjk.toFixed(2)} vs ${other.cjk.toFixed(2)}),不像原文/译文。\n确实要共用批注的话用「手动关联」命令。`;
			}
		}
		return "找到候选但未通过校验,可用「手动关联」命令强制指定。";
	}

	/** Pairs the active PDF with an explicitly chosen file, skipping every check —
	 * the escape hatch for when auto-detection is wrong or too conservative. */
	pairManually(otherPath: string): void {
		const file = this.currentPdfTarget();
		if (!file) return;
		const mine = this.store.getFingerprint(file.path);
		const other = this.store.getFingerprint(otherPath);
		// Prefer the source language as the bucket name when we can tell.
		const canonical = mine && other ? canonicalOf(file.path, mine, otherPath, other) : otherPath;
		this.store.pair(file.path, otherPath, canonical);
		new Notice(`已手动关联,批注共用:\n${otherPath.split("/").pop()}`);
	}

	/** Name-similar PDFs, for the manual pairing picker. */
	pairingCandidates(): string[] {
		const file = this.currentPdfTarget();
		if (!file) return [];
		const named = findNameCandidates(this.app, file.path);
		if (named.length > 0) return named;
		// Nothing name-similar: offer every other PDF rather than a dead end.
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension === "pdf" && f.path !== file.path)
			.map((f) => f.path);
	}

	unpairActive(): void {
		const file = this.currentPdfTarget();
		if (!file) return;
		if (!this.store.isPaired(file.path)) {
			new Notice("当前 PDF 没有关联");
			return;
		}
		this.store.unpair(file.path);
		new Notice("已解除关联(批注留在原文那一侧)");
	}

	/**
	 * Flips to the paired translation/original, landing on the same page and the
	 * same fraction down that page — the layouts match closely enough (measured
	 * on this vault: 1pt median vertical drift, 93% of blocks within one line)
	 * that this reads as switching language in place.
	 */
	async switchToCounterpart(): Promise<void> {
		const view = this.targetPdfView();
		const file = this.currentPdfTarget();
		if (!view || !file) return;

		let other = this.store.counterpartOf(file.path);
		if (!other) {
			// Retry the match now (the other side may have been opened since), and
			// if it still won't pair, say exactly which check failed — "not found"
			// gave no way to tell a naming problem from a never-opened counterpart.
			const fp = this.store.getFingerprint(file.path);
			if (fp) this.tryAutoPair(file.path, fp);
			other = this.store.counterpartOf(file.path);
		}
		if (!other) {
			new Notice(this.explainNoCounterpart(file.path), 8000);
			return;
		}

		const state = this.states.get(view);
		const page = this.visiblePage(state) ?? 1;
		const fraction = this.pageScrollFraction(state, page);

		await this.app.workspace.openLinkText(`${other}#page=${page}`, "", false);
		if (fraction === null) return;
		// Re-apply the within-page offset once the target page has rendered.
		window.setTimeout(() => this.applyPageFraction(page, fraction), 400);
	}

	/** Whichever page currently occupies most of the viewport. */
	private visiblePage(state: ViewState | undefined): number | null {
		if (!state) return null;
		let best: { page: number; area: number } | null = null;
		for (const [page, pv] of state.pages) {
			if (!pv.div.isConnected) continue;
			const r = pv.div.getBoundingClientRect();
			const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
			if (!best || visible > best.area) best = { page, area: visible };
		}
		return best?.page ?? null;
	}

	/** How far down the given page the viewport sits, 0–1. */
	private pageScrollFraction(state: ViewState | undefined, page: number): number | null {
		const pv = state?.pages.get(page);
		if (!pv?.div.isConnected) return null;
		const r = pv.div.getBoundingClientRect();
		if (r.height <= 0) return null;
		return Math.max(0, Math.min(1, -r.top / r.height));
	}

	private applyPageFraction(page: number, fraction: number): void {
		const view = this.targetPdfView();
		const pv = view ? this.states.get(view)?.pages.get(page) : null;
		if (!pv?.div.isConnected) return;
		const scroller = findScrollAncestor(pv.div);
		const r = pv.div.getBoundingClientRect();
		scroller.scrollTop += r.top + fraction * r.height - scroller.getBoundingClientRect().top;
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

		const state: ViewState = { pages, layer, currentPath, sampler: new ScriptSampler() };
		this.states.set(view, state);
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
			if (!path) return;
			layer.rebuild(path, pages);

			// The text layer is also a free sample of what script this document is
			// written in — all counterpart detection needs, no extra parsing.
			// Read the rendered spans rather than `textContentItems`: that field is
			// declared in the mirrored pdf.js types but nothing else ever exercises
			// it, so its presence across Obsidian versions is unverified, whereas
			// getTextLayerInfo() has already established that textDivs exists.
			if (!state.sampler.done) {
				const info = getTextLayerInfo(pageView);
				if (info?.textDivs) {
					state.sampler.add(
						pageNumber,
						info.textDivs.map((d) => d.textContent ?? "")
					);
					// Write on every sampled page, not only once the sample is
					// "complete" — see ScriptSampler.done.
					this.captureFingerprint(view, path, state);
				}
			}
		});
	}
}
