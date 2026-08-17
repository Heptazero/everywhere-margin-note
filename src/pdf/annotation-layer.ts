import { Menu, type App, type Component } from "obsidian";
import { resolveCollisions } from "../collision-avoidance";
import { buildAnnotationBox, type AnnotationBoxHandle } from "./annotation-box";
import type { PdfAnnotationSettings } from "./annotation-settings";
import type { PdfAnnotationStore } from "./annotation-store";
import { DEFAULT_FREE_WIDTH_PCT, type MarginSide, type PdfAnnotation } from "./annotation-types";
import type { PDFPageView } from "./pdfjs-types";
import { findScrollAncestor } from "./scroll-container";

const LAYER_CLASS = "margin-notes-pdf-layer";
const MIN_GAP = 8;
const RAIL_GAP = 8;
const MIN_RAIL_WIDTH_PT = 130;
const REBUILD_DEBOUNCE_MS = 60;

/** Page geometry in scroll-container coordinates, plus the pt→px zoom factor. */
interface PageBox {
	left: number;
	top: number;
	width: number;
	height: number;
	/** PDF-point box of the page. */
	ptX0: number;
	ptX1: number;
	ptWidth: number;
	ptY0: number;
	ptY1: number;
	ptHeight: number;
	/** Rendered px per PDF point — everything scales by this so notes stay
	 * attached to the page (size included) as pdf.js zooms in/out. */
	zoom: number;
}

interface Rail {
	id: string;
	top: number;
	height: number;
	el: HTMLElement;
}

/** One rendered annotation, kept so geometry can be re-measured after rendering. */
interface Placed {
	ann: PdfAnnotation;
	pageView: PDFPageView;
	el: HTMLElement;
}

/**
 * Renders every annotation of one PDF view into a single layer that is a direct
 * child of the viewer's scroll container — the same trick as the CM6 footnote
 * sidenote layer: once it shares the scrolling element, absolutely-positioned
 * children scroll for free, so positions only need recomputing on page render,
 * zoom, or edit, never on scroll.
 *
 * Both display forms live here. Earlier there were two layers (a per-page
 * overlay for floating markers, this one for margin boxes); that split forced
 * free notes to be clipped by the page overlay's `overflow: hidden`, which is
 * exactly what prevented a note from sitting in the blank space beside a page.
 */
export class AnnotationLayer {
	private layer: HTMLDivElement | null = null;
	private scroller: HTMLElement | null = null;
	/** Bumped per rebuild so a superseded async render pass bails out. */
	private gen = 0;
	private last: { pdfPath: string; pages: Map<number, PDFPageView> } | null = null;
	private rebuildTimer = 0;

	constructor(
		private app: App,
		private component: Component,
		private store: PdfAnnotationStore,
		private getSettings: () => PdfAnnotationSettings,
		private saveSettings: (patch: Partial<PdfAnnotationSettings>) => void
	) {}

	private ensureLayer(anyPageDiv: HTMLElement): HTMLDivElement {
		const scroller = findScrollAncestor(anyPageDiv);
		if (this.layer?.isConnected && this.scroller === scroller) return this.layer;

		this.layer?.remove();
		// CM6's `.cm-scroller` gets `position: relative` from its own base theme;
		// nothing gives the PDF viewer's scroller that for free.
		if (getComputedStyle(scroller).position === "static") scroller.style.position = "relative";

		const layer = scroller.createDiv(LAYER_CLASS);
		layer.setCssStyles({ position: "absolute", top: "0", left: "0", pointerEvents: "none" });
		this.layer = layer;
		this.scroller = scroller;
		return layer;
	}

	/** True while a box is mid-edit — rebuilding would destroy the contentEditable. */
	private isBusy(): boolean {
		return !!this.layer?.querySelector(".is-editing, .is-dragging");
	}

	/**
	 * Coalesced on purpose: a zoom makes pdf.js fire `pagerendered` once per
	 * visible page in a burst, and rebuilding on each of them measured pages that
	 * hadn't finished relaying out yet — which showed up as annotations drifting
	 * off their anchors after zooming.
	 */
	rebuild(pdfPath: string, pages: Map<number, PDFPageView>): void {
		this.last = { pdfPath, pages };
		if (this.isBusy()) return;
		window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => void this.doRebuild(pdfPath, pages), REBUILD_DEBOUNCE_MS);
	}

	refresh(): void {
		if (this.last) this.rebuild(this.last.pdfPath, this.last.pages);
	}

	private pageBox(pageView: PDFPageView, scroller: HTMLElement, scrollerRect: DOMRect): PageBox {
		const r = pageView.div.getBoundingClientRect();
		const [ptX0, ptY0, ptX1, ptY1] = pageView.pdfPage.view;
		const ptHeight = ptY1 - ptY0;
		return {
			left: r.left - scrollerRect.left + scroller.scrollLeft,
			top: r.top - scrollerRect.top + scroller.scrollTop,
			width: r.width,
			height: r.height,
			ptX0,
			ptX1,
			ptWidth: ptX1 - ptX0,
			ptY0,
			ptY1,
			ptHeight,
			zoom: ptHeight > 0 ? r.height / ptHeight : 1,
		};
	}

	private async doRebuild(pdfPath: string, pages: Map<number, PDFPageView>): Promise<void> {
		// `rebuild()` only checks isBusy() at the moment it SCHEDULES this call —
		// if a drag/resize/edit starts during the debounce window (very possible:
		// e.g. onTextLayerReady firing from the scroll a drag itself causes), that
		// check is already stale by the time this actually runs. Re-check here:
		// otherwise this wipes the layer (`layer.empty()` below) mid-drag, and the
		// pointermove handler goes on updating an element that's no longer in the
		// document — this is what "resize stops responding after moving a little"
		// actually was: the element under the cursor got silently swapped out.
		if (this.isBusy()) return;
		const gen = ++this.gen;
		const settings = this.getSettings();

		const anyPage = [...pages.values()].find((p) => p.div?.isConnected && p.pdfPage?.view);
		if (!anyPage) return;

		const layer = this.ensureLayer(anyPage.div);
		layer.empty();

		const railWidthPt = Math.max(MIN_RAIL_WIDTH_PT, settings.railWidth);
		const built: Placed[] = [];
		const pending: Promise<void>[] = [];

		// Pass 1: create the DOM and kick off Markdown rendering. No geometry is
		// committed here — see the re-measure below for why.
		for (const [pageNumber, pageView] of pages) {
			if (!pageView.pdfPage?.view || !pageView.div.isConnected) continue;
			for (const ann of this.store.forPage(pdfPath, pageNumber)) {
				if (ann.collapsed) {
					built.push({ ann, pageView, el: this.createDot(layer, pdfPath, ann) });
					continue;
				}
				const handle = this.createBox(layer, pdfPath, ann, pageView, railWidthPt);
				pending.push(handle.render());
				built.push({ ann, pageView, el: handle.el });
			}
		}
		if (built.length === 0) return;

		// Position once with the geometry as it stands, so nothing flashes at 0,0…
		this.layout(built, railWidthPt, settings);

		// …then again after Markdown/MathJax resolves. Two reasons: box heights
		// aren't final until then (collision avoidance needs real heights), and
		// during a zoom the page rects measured a moment ago are already stale —
		// re-measuring here is what stops annotations drifting off their anchors
		// when the zoom level changes.
		await Promise.all(pending);
		// `gen` catches a NEWER rebuild superseding this one; `isBusy()` catches
		// the user starting to drag one of the boxes THIS pass just built, during
		// the render wait — the second `layout()` call below would otherwise still
		// go and reposition (fight) whatever they're mid-drag on.
		if (gen !== this.gen || this.isBusy()) return;
		this.layout(built, railWidthPt, settings);
	}

	/**
	 * Measures the current page geometry and (re)places every built element.
	 *
	 * A pinned note is NOT screen-fixed chrome — it's attached to the page like
	 * a free note (position AND size scale with zoom), the only difference being
	 * its X is clamped into a lane instead of freely chosen. `railWidthPt` is
	 * therefore a page-point width, turned into px here via each note's own
	 * `box.zoom`, exactly like `settings.fontSize` already was for free notes.
	 */
	private layout(built: Placed[], railWidthPt: number, settings: PdfAnnotationSettings): void {
		const scroller = this.scroller;
		if (!scroller) return;

		const scrollerRect = scroller.getBoundingClientRect();
		// The rail must stay on screen. Anchoring purely to the page edge put it
		// outside the viewport whenever the page was zoomed in far enough to fill
		// the pane, so it could only be seen by zooming way back out.
		const visibleLeft = scroller.scrollLeft;
		const visibleRight = scroller.scrollLeft + scroller.clientWidth;

		const boxes = new Map<PDFPageView, PageBox>();
		const rails: Record<MarginSide, Rail[]> = { left: [], right: [] };

		for (const item of built) {
			if (!item.pageView.div.isConnected) continue;
			let box = boxes.get(item.pageView);
			if (!box) {
				box = this.pageBox(item.pageView, scroller, scrollerRect);
				boxes.set(item.pageView, box);
			}
			const { ann, el } = item;
			const fontPx = settings.fontSize * box.zoom * (ann.fontScale ?? 1);

			if (ann.pinned) {
				const railWidthPx = railWidthPt * box.zoom;
				el.style.left = `${this.railLeft(ann.side, box, railWidthPx, visibleLeft, visibleRight)}px`;
				if (!ann.collapsed) {
					el.style.width = `${railWidthPx}px`;
					el.style.fontSize = `${fontPx}px`;
				}
				rails[ann.side].push({ id: ann.id, top: this.anchorTop(ann, box), height: 0, el });
			} else if (ann.collapsed) {
				el.style.left = `${box.left + (this.freeXPct(ann, box) / 100) * box.width}px`;
				el.style.top = `${box.top + (this.freeYPct(ann, box) / 100) * box.height}px`;
			} else {
				this.placeFree(el, ann, box);
				el.style.fontSize = `${fontPx}px`;
			}
		}

		for (const side of ["left", "right"] as const) {
			const group = rails[side];
			for (const r of group) r.height = r.el.offsetHeight;
			for (const r of resolveCollisions(group, MIN_GAP)) r.el.style.top = `${r.top}px`;
		}
	}

	/** Rail x (px): hug the page when there's gutter, slide onto the page rather than off screen. */
	private railLeft(side: MarginSide, box: PageBox, railWidthPx: number, visibleLeft: number, visibleRight: number): number {
		return side === "right"
			? Math.min(box.left + box.width + RAIL_GAP, visibleRight - railWidthPx - RAIL_GAP)
			: Math.max(box.left - railWidthPx - RAIL_GAP, visibleLeft + RAIL_GAP);
	}

	/** Vertical position derived from the anchor (plus any manual nudge). */
	private anchorTop(ann: PdfAnnotation, box: PageBox): number {
		const topPt = box.ptY1 - Math.max(ann.anchor[1], ann.anchor[3]);
		return box.top + (topPt / box.ptHeight) * box.height + (ann.offsetY ?? 0);
	}

	/**
	 * Free-placement X, defaulting to just right of the anchor. Used to default
	 * to "just past the page's right edge" — a fixed 102%, ignoring where the
	 * selection actually was — which could easily land outside the visible
	 * viewport on a page with little to no gutter. Anchoring the default to the
	 * selection itself instead means a brand-new note always spawns next to
	 * what it's about; since this is only the DEFAULT (an explicit `freeX` from
	 * a drag always wins), it's recomputed fresh from the anchor on every
	 * render rather than stored, so it can never end up stale either.
	 */
	private freeXPct(ann: PdfAnnotation, box: PageBox): number {
		if (ann.freeX !== undefined) return ann.freeX;
		const right = Math.max(ann.anchor[0], ann.anchor[2]);
		return ((right - box.ptX0) / box.ptWidth) * 100 + 3;
	}

	/** Free-placement Y, defaulting to the anchor's own height on the page. */
	private freeYPct(ann: PdfAnnotation, box: PageBox): number {
		return ann.freeY ?? ((box.ptY1 - Math.max(ann.anchor[1], ann.anchor[3])) / box.ptHeight) * 100;
	}

	private placeFree(el: HTMLElement, ann: PdfAnnotation, box: PageBox): void {
		const wPct = ann.freeW ?? DEFAULT_FREE_WIDTH_PCT;
		el.style.left = `${box.left + (this.freeXPct(ann, box) / 100) * box.width}px`;
		el.style.top = `${box.top + (this.freeYPct(ann, box) / 100) * box.height}px`;
		el.style.width = `${(wPct / 100) * box.width}px`;
		el.style.height = ann.freeH ? `${(ann.freeH / 100) * box.height}px` : "";
	}

	private createDot(layer: HTMLElement, pdfPath: string, ann: PdfAnnotation): HTMLElement {
		const dot = layer.createDiv("margin-notes-pdf-dot");
		dot.dataset.annotationId = ann.id;
		dot.dataset.mode = ann.pinned ? "rail" : "free";
		if (ann.color) dot.style.setProperty("--margin-notes-pdf-note-color", ann.color);
		if (ann.text) dot.setAttribute("aria-label", ann.text.slice(0, 80));

		dot.addEventListener("mousedown", (e) => e.stopPropagation());
		dot.addEventListener("click", (e) => {
			e.stopPropagation();
			this.mutate(pdfPath, ann, (a) => (a.collapsed = false));
		});
		dot.addEventListener("contextmenu", (e) => this.showMenu(e, pdfPath, ann));
		return dot;
	}

	private mutate(pdfPath: string, ann: PdfAnnotation, fn: (a: PdfAnnotation) => void): void {
		fn(ann);
		ann.updatedAt = Date.now();
		this.store.upsert(pdfPath, ann);
		this.refresh();
	}

	private createBox(
		layer: HTMLElement,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView,
		railWidthPt: number
	): AnnotationBoxHandle {
		const handle = buildAnnotationBox(layer, "margin-notes-pdf-note", {
			app: this.app,
			component: this.component,
			sourcePath: pdfPath,
			initialText: ann.text,
			onCommit: (text) => this.mutate(pdfPath, ann, (a) => (a.text = text)),
			// A single "⋯" trigger, not one icon per action — six buttons crammed into
			// the top-right corner covered short notes' text entirely.
			actions: [
				{
					icon: "more-horizontal",
					title: "批注菜单(字号、颜色、固定/收起…)",
					onClick: (ev) => this.openMenu(pdfPath, ann, { x: ev.clientX, y: ev.clientY }),
				},
			],
		});

		handle.el.dataset.annotationId = ann.id;
		handle.el.dataset.mode = ann.pinned ? "rail" : "free";
		handle.el.dataset.side = ann.side;
		handle.el.dataset.style = ann.style ?? "boxed";
		if (ann.color) handle.el.style.setProperty("--margin-notes-pdf-note-color", ann.color);

		handle.el.addEventListener("contextmenu", (e) => this.showMenu(e, pdfPath, ann));
		this.attachDrag(handle, pdfPath, ann, pageView);
		this.attachResize(handle, pdfPath, ann, pageView, railWidthPt);
		return handle;
	}

	private scaleFont(pdfPath: string, ann: PdfAnnotation, delta: number): void {
		this.mutate(pdfPath, ann, (a) => (a.fontScale = Math.max(0.5, Math.min(3, (a.fontScale ?? 1) + delta))));
	}

	/** Opens the OS colour picker via a throwaway `<input type=color>` — the same
	 * mechanism `addColorPicker` uses in the settings tab, just triggered by hand
	 * since a context menu can't host a native colour swatch itself. */
	private pickColor(pdfPath: string, ann: PdfAnnotation, defaultColor: string): void {
		const input = document.createElement("input");
		input.type = "color";
		input.value = ann.color ?? defaultColor;
		input.style.cssText = "position:fixed;opacity:0;width:0;height:0;pointer-events:none;";
		document.body.appendChild(input);
		input.addEventListener("input", () => this.mutate(pdfPath, ann, (a) => (a.color = input.value)));
		input.addEventListener("change", () => input.remove());
		// Some Electron builds never fire `change` if the picker is dismissed
		// without a click-away; don't leak the node either way.
		window.setTimeout(() => input.remove(), 30_000);
		input.click();
	}

	/**
	 * Un-pinning leaves freeX/freeY unset (unless already dragged somewhere)
	 * rather than jumping to a hardcoded corner — freeXPct/freeYPct's default
	 * already places an unset note right next to its anchor, which is exactly
	 * where a note that just left the rail should start.
	 */
	private togglePin(pdfPath: string, ann: PdfAnnotation): void {
		this.mutate(pdfPath, ann, (a) => {
			if (a.pinned) {
				a.pinned = false;
			} else {
				a.pinned = true;
				a.offsetY = 0;
			}
		});
	}

	private showMenu(ev: MouseEvent, pdfPath: string, ann: PdfAnnotation): void {
		ev.preventDefault();
		ev.stopPropagation();
		this.openMenu(pdfPath, ann, { x: ev.clientX, y: ev.clientY });
	}

	private openMenu(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle(ann.pinned ? "解除固定(随意摆放)" : "固定到侧边轨道")
				.setIcon(ann.pinned ? "pin-off" : "pin")
				.onClick(() => this.togglePin(pdfPath, ann))
		);
		menu.addItem((i) =>
			i
				.setTitle(ann.collapsed ? "展开" : "收起成点")
				.setIcon(ann.collapsed ? "maximize-2" : "minus")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.collapsed = !a.collapsed)))
		);
		if (ann.pinned) {
			menu.addItem((i) =>
				i
					.setTitle(ann.side === "right" ? "移到左侧" : "移到右侧")
					.setIcon("arrow-left-right")
					.onClick(() => this.mutate(pdfPath, ann, (a) => (a.side = a.side === "right" ? "left" : "right")))
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("字号调大")
				.setIcon("a-arrow-up")
				.onClick(() => this.scaleFont(pdfPath, ann, 0.15))
		);
		menu.addItem((i) =>
			i
				.setTitle("字号调小")
				.setIcon("a-arrow-down")
				.onClick(() => this.scaleFont(pdfPath, ann, -0.15))
		);
		menu.addItem((i) =>
			i
				.setTitle("恢复默认字号")
				.setIcon("rotate-ccw")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.fontScale = undefined)))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle(ann.style === "plain" ? "改成带边框样式" : "改成纯文字样式(去掉边框和背景)")
				.setIcon(ann.style === "plain" ? "square" : "type")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.style = a.style === "plain" ? "boxed" : "plain")))
		);
		menu.addItem((i) =>
			i
				.setTitle("更改颜色…")
				.setIcon("palette")
				.onClick(() => {
					const defaultColor = ann.pinned ? this.getSettings().railColor : this.getSettings().freeColor;
					this.pickColor(pdfPath, ann, defaultColor);
				})
		);
		if (ann.color) {
			menu.addItem((i) =>
				i
					.setTitle("恢复默认颜色")
					.setIcon("rotate-ccw")
					.onClick(() => this.mutate(pdfPath, ann, (a) => (a.color = undefined)))
			);
		}
		if (!ann.pinned) {
			menu.addItem((i) =>
				i
					.setTitle("恢复自动高度")
					.setIcon("unfold-vertical")
					.onClick(() => this.mutate(pdfPath, ann, (a) => (a.freeH = undefined)))
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("删除批注")
				.setIcon("trash")
				.onClick(() => {
					this.store.remove(pdfPath, ann.id);
					this.refresh();
				})
		);
		menu.showAtPosition(at);
	}

	/**
	 * Drag from the grip. A pinned note only moves vertically (it lives in a
	 * rail) and stores the delta as `offsetY`; a free note moves in both axes and
	 * stores page-relative percentages, so it keeps its spot across zoom.
	 */
	private attachDrag(handle: AnnotationBoxHandle, pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): void {
		const grip = handle.toolbarEl.createDiv({ cls: "margin-notes-pdf-grip" });
		grip.setAttribute("aria-label", ann.pinned ? "上下拖动" : "拖动摆放");
		handle.toolbarEl.prepend(grip);

		grip.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const startLeft = parseFloat(handle.el.style.left || "0");
			const startTop = parseFloat(handle.el.style.top || "0");
			handle.el.addClass("is-dragging");

			const onMove = (m: PointerEvent) => {
				handle.el.style.top = `${startTop + (m.clientY - startY)}px`;
				if (!ann.pinned) handle.el.style.left = `${startLeft + (m.clientX - startX)}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const dx = u.clientX - startX;
				const dy = u.clientY - startY;
				// Measured now, not at build time: a zoom may have happened since.
				const box = this.currentPageBox(pageView);
				this.mutate(pdfPath, ann, (a) => {
					if (a.pinned || !box) {
						a.offsetY = (a.offsetY ?? 0) + dy;
					} else {
						a.freeX = ((startLeft + dx - box.left) / box.width) * 100;
						a.freeY = ((startTop + dy - box.top) / box.height) * 100;
					}
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		});
	}

	private currentPageBox(pageView: PDFPageView): PageBox | null {
		const scroller = this.scroller;
		if (!scroller || !pageView.div.isConnected || !pageView.pdfPage?.view) return null;
		return this.pageBox(pageView, scroller, scroller.getBoundingClientRect());
	}

	/**
	 * Resize handle on the box's inner edge. For a free note it sets that note's
	 * own width/height (in page-percent, so it keeps its size across zoom); for
	 * a pinned note it sets the shared RAIL width, since every note in a rail
	 * has to agree on one — that is the "adjust the track's width" affordance.
	 * The dragged px width is converted back to page points (÷ current zoom)
	 * before saving, so the rail keeps looking the size the user chose as the
	 * PDF is zoomed afterward, instead of reverting to a stale reference size.
	 */
	private attachResize(
		handle: AnnotationBoxHandle,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView,
		railWidthPt: number
	): void {
		const grip = handle.el.createDiv(`margin-notes-pdf-resize is-${ann.pinned ? "rail" : "free"}`);
		grip.setAttribute("aria-label", ann.pinned ? "拖动调整轨道宽度" : "拖动调整大小");

		grip.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const startW = handle.el.offsetWidth;
			const startH = handle.el.offsetHeight;
			const startLeft = parseFloat(handle.el.style.left || "0");
			const zoom = this.currentPageBox(pageView)?.zoom ?? 1;
			const minWidthPx = ann.pinned ? MIN_RAIL_WIDTH_PT * zoom : 60;
			handle.el.addClass("is-dragging");

			// The grip sits on the edge facing the page: the LEFT edge for a
			// right-hand rail, the RIGHT edge for a left-hand one. That edge has to
			// track the cursor — only growing `width` (with `left` pinned) made a
			// right-hand rail appear to resize from its far side instead.
			const grabsLeftEdge = ann.pinned && ann.side === "right";
			const widthAt = (x: number) => Math.max(minWidthPx, startW + (grabsLeftEdge ? startX - x : x - startX));

			const onMove = (m: PointerEvent) => {
				const w = widthAt(m.clientX);
				handle.el.style.width = `${w}px`;
				if (grabsLeftEdge) handle.el.style.left = `${startLeft + (startW - w)}px`;
				if (!ann.pinned) handle.el.style.height = `${Math.max(28, startH + (m.clientY - startY))}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const w = widthAt(u.clientX);
				if (ann.pinned) {
					const widthPt = Math.round(w / zoom);
					if (widthPt !== Math.round(railWidthPt)) this.saveSettings({ railWidth: widthPt });
					else this.refresh();
					return;
				}
				const box = this.currentPageBox(pageView);
				if (!box) return;
				this.mutate(pdfPath, ann, (a) => {
					a.freeW = (w / box.width) * 100;
					a.freeH = (Math.max(28, startH + (u.clientY - startY)) / box.height) * 100;
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		});
	}

	/**
	 * Jump feedback for a list-panel click: flashes the note itself if it's
	 * currently rendered, and — this is the part that actually answers "where
	 * in the PDF does this point at" — draws a temporary highlight box over the
	 * ORIGINAL anchored text/region and scrolls it into view. The note's own
	 * on-screen spot (rail lane, or a dragged-away sticky note) is often not
	 * where the source text is, so flashing the note alone doesn't show that.
	 */
	reveal(pages: Map<number, PDFPageView>, ann: PdfAnnotation): void {
		const el = this.layer?.querySelector<HTMLElement>(`[data-annotation-id="${ann.id}"]`);
		if (el) {
			el.addClass("is-flashing");
			window.setTimeout(() => el.removeClass("is-flashing"), 1200);
		}

		const layer = this.layer;
		const scroller = this.scroller;
		const pageView = pages.get(ann.page);
		if (!layer || !scroller || !pageView?.div.isConnected || !pageView.pdfPage?.view) return;

		const box = this.pageBox(pageView, scroller, scroller.getBoundingClientRect());
		const left = Math.min(ann.anchor[0], ann.anchor[2]);
		const right = Math.max(ann.anchor[0], ann.anchor[2]);
		const topPt = box.ptY1 - Math.max(ann.anchor[1], ann.anchor[3]);
		const bottomPt = box.ptY1 - Math.min(ann.anchor[1], ann.anchor[3]);

		const mark = layer.createDiv("margin-notes-pdf-anchor-flash");
		mark.setCssStyles({
			left: `${box.left + ((left - box.ptX0) / box.ptWidth) * box.width}px`,
			top: `${box.top + (topPt / box.ptHeight) * box.height}px`,
			width: `${((right - left) / box.ptWidth) * box.width}px`,
			height: `${((bottomPt - topPt) / box.ptHeight) * box.height}px`,
		});
		mark.scrollIntoView({ block: "center", behavior: "smooth" });
		window.setTimeout(() => mark.remove(), 1600);
	}

	destroy(): void {
		window.clearTimeout(this.rebuildTimer);
		this.layer?.remove();
		this.layer = null;
	}
}
