import { Menu, type App, type Component } from "obsidian";
import { resolveCollisions } from "../collision-avoidance";
import { buildAnnotationBox, type AnnotationBoxHandle } from "./annotation-box";
import type { PdfAnnotationSettings } from "./annotation-settings";
import type { PdfAnnotationStore } from "./annotation-store";
import { DEFAULT_FREE_WIDTH_PCT, type MarginSide, type PdfAnnotation } from "./annotation-types";
import type { PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { resolveQuoteAnchor } from "./quote-anchor";
import { findScrollAncestor } from "./scroll-container";

/** `[0,0,0,0]` marks a record whose anchor still needs to be looked up from `quote`. */
function isUnresolvedAnchor(anchor: PdfRect): boolean {
	return anchor[0] === 0 && anchor[1] === 0 && anchor[2] === 0 && anchor[3] === 0;
}

const LAYER_CLASS = "margin-notes-pdf-layer";
/** Minimum vertical gap between two rail notes, in PDF points (scaled by zoom
 * where it's used) — not raw px, or it would look cramped zoomed in and
 * oversized zoomed out relative to the (zoom-scaled) text around it. */
const MIN_GAP = 8;
/** Blank space kept past the outermost note, so it never sits under the viewer's scrollbar. */
const OUTER_MARGIN_PX = 28;
/** Keep in sync with `.margin-notes-pdf-dot`'s size in styles.css. */
const DOT_SIZE_PX = 12;
/** Floors, in PDF points. Kept genuinely small — these are a "don't collapse to
 * nothing" guard, not a taste judgement about how narrow a note may be. They
 * must stay <= the settings sliders' minimums, or the bottom of a slider
 * silently does nothing (which is exactly what a 130 floor under a 110 slider
 * used to do). */
const MIN_RAIL_WIDTH_PT = 50;
const MIN_FREE_WIDTH_PT = 40;
const MIN_HEIGHT_PX = 20;
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
	/** The page's zoom at push time, so the minimum gap between notes (below)
	 * can scale with it instead of staying a fixed px amount at every zoom. */
	zoom: number;
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
		this.hoverMark = null;

		const built: Placed[] = [];
		const pending: Promise<void>[] = [];

		// Pass 1: create the DOM and kick off Markdown rendering. No geometry is
		// committed here — see the re-measure below for why.
		for (const [pageNumber, pageView] of pages) {
			if (!pageView.pdfPage?.view || !pageView.div.isConnected) continue;
			for (const ann of this.store.forPage(pdfPath, pageNumber)) {
				this.resolveAnchorIfNeeded(pdfPath, ann, pageView);
				if (ann.collapsed) {
					built.push({ ann, pageView, el: this.createDot(layer, pdfPath, ann) });
					continue;
				}
				const handle = this.createBox(layer, pdfPath, ann, pageView);
				pending.push(handle.render());
				built.push({ ann, pageView, el: handle.el });
			}
		}
		if (built.length === 0) return;

		// Position once with the geometry as it stands, so nothing flashes at 0,0…
		this.layout(built, settings);

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
		this.layout(built, settings);
	}

	/** Rail width/gap in PDF points for one side — left and right are independent
	 * settings (they used to be one shared value, which is why resizing the left
	 * rail used to silently move the right one too). */
	private railWidthPt(settings: PdfAnnotationSettings, side: MarginSide): number {
		return Math.max(MIN_RAIL_WIDTH_PT, side === "right" ? settings.railWidthRight : settings.railWidthLeft);
	}
	private railGapPt(settings: PdfAnnotationSettings, side: MarginSide): number {
		return side === "right" ? settings.railGapRight : settings.railGapLeft;
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
	private layout(built: Placed[], settings: PdfAnnotationSettings): void {
		const scroller = this.scroller;
		if (!scroller) return;

		const scrollerRect = scroller.getBoundingClientRect();
		const boxes = new Map<PDFPageView, PageBox>();
		const rails: Record<MarginSide, Rail[]> = { left: [], right: [] };
		let maxRight = 0;

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
				const railWidthPx = this.railWidthPt(settings, ann.side) * box.zoom;
				const left = this.railLeft(ann.side, box, railWidthPx, this.railGapPt(settings, ann.side) * box.zoom);
				el.style.left = `${left}px`;
				if (!ann.collapsed) {
					el.style.width = `${railWidthPx}px`;
					el.style.fontSize = `${fontPx}px`;
					maxRight = Math.max(maxRight, left + railWidthPx);
				} else {
					maxRight = Math.max(maxRight, left + DOT_SIZE_PX);
				}
				rails[ann.side].push({ id: ann.id, top: this.anchorTop(ann, box), height: 0, el, zoom: box.zoom });
			} else if (ann.collapsed) {
				const left = box.left + (this.freeXPct(ann, box) / 100) * box.width;
				el.style.left = `${left}px`;
				el.style.top = `${box.top + (this.freeYPct(ann, box) / 100) * box.height}px`;
				maxRight = Math.max(maxRight, left + DOT_SIZE_PX);
			} else {
				this.placeFree(el, ann, box);
				el.style.fontSize = `${fontPx}px`;
				maxRight = Math.max(maxRight, parseFloat(el.style.left) + parseFloat(el.style.width));
			}
		}

		for (const side of ["left", "right"] as const) {
			const group = rails[side];
			for (const r of group) r.height = r.el.offsetHeight;
			// MIN_GAP is a page-point constant like everything else here — a fixed
			// px value would look cramped zoomed in and oversized zoomed out. All
			// notes in one rail share the document's zoom in practice, so the
			// first entry's is representative.
			const gapPx = MIN_GAP * (group[0]?.zoom ?? 1);
			for (const r of resolveCollisions(group, gapPx)) r.el.style.top = `${r.top}px`;
		}

		// Give the layer a real width so the scroll container can actually reach
		// the notes sitting past the page's right edge, with a margin of blank
		// space beyond the outermost one — otherwise the rightmost note ends up
		// flush against (and fighting with) the viewer's own scrollbar.
		this.layer!.style.width = maxRight > 0 ? `${maxRight + OUTER_MARGIN_PX}px` : "";
	}

	/**
	 * Rail x, in scroll-container px.
	 *
	 * Purely page-relative — deliberately NOT clamped to the viewport. An earlier
	 * version clamped against `scrollLeft + clientWidth` to keep the rail always
	 * on screen, which broke three things at once: the rail drifted on zoom
	 * (its position depended on scroll state, unlike free notes, which is exactly
	 * why only the rail drifted); it could never sit out in the blank area past
	 * the page; and it fed back on itself — a wider rail extends the scrollable
	 * width, which moves `scrollLeft + clientWidth` further right, which moves
	 * the rail further right, dragging the viewport along with it.
	 *
	 * The only clamp left is at the content origin: a left rail may not go
	 * negative, since nothing can scroll left of 0 and it would be unreachable.
	 */
	private railLeft(side: MarginSide, box: PageBox, railWidthPx: number, railGapPx: number): number {
		return side === "right"
			? box.left + box.width + railGapPx
			: Math.max(0, box.left - railWidthPx - railGapPx);
	}

	/**
	 * Vertical position derived from the anchor (plus any manual nudge).
	 * `offsetY` is stored in PDF points, like `anchor` itself — converting it to
	 * px here (× `box.zoom`) rather than storing raw px is what keeps a manually
	 * reordered rail note's position relative to its neighbours stable across
	 * zoom. It used to be stored as raw px: fine at the zoom it was dragged at,
	 * but frozen afterwards while every neighbour's own position kept scaling —
	 * that mismatch is what could reorder or bunch up notes after zooming.
	 */
	private anchorTop(ann: PdfAnnotation, box: PageBox): number {
		const topPt = box.ptY1 - Math.max(ann.anchor[1], ann.anchor[3]);
		return box.top + (topPt / box.ptHeight) * box.height + (ann.offsetY ?? 0) * box.zoom;
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

	/**
	 * A record with no real `anchor` (an AI-authored one, typically — see
	 * quote-anchor.ts) gets resolved here, the first time its page is on
	 * screen: search the text layer for `quote`, write the real rect back so
	 * every later render is instant and ordinary.
	 *
	 * A failed match (page's text layer not ready yet, or the quote genuinely
	 * isn't found — a paraphrase rather than a verbatim copy, say) falls back to
	 * a fixed spot near the top of the page instead of being invisible. That
	 * fallback is NOT written to disk, but it does overwrite `ann.anchor` on the
	 * live object the store holds — since `isUnresolvedAnchor` is what this
	 * function gates on, that means a fallback used once stops future retries
	 * for the rest of the session. In practice this is fine for the case that
	 * matters (a quote that truly doesn't match will never resolve however many
	 * times it's retried) and only a narrow race for "text layer wasn't ready
	 * yet" (self-resolves within the ~60ms rebuild debounce almost always) — but
	 * it's a real edge, not a guarantee, and worth knowing if a note ever seems
	 * stuck at the top of a page it shouldn't be on.
	 */
	private resolveAnchorIfNeeded(pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): void {
		if (!isUnresolvedAnchor(ann.anchor)) return;

		if (ann.quote) {
			const resolved = resolveQuoteAnchor(pageView, ann.quote);
			if (resolved) {
				ann.anchor = resolved;
				ann.updatedAt = Date.now();
				this.store.upsert(pdfPath, ann);
				return;
			}
		}
		if (pageView.pdfPage?.view) {
			const [x0, , , y1] = pageView.pdfPage.view;
			ann.anchor = [x0 + 20, y1 - 60, x0 + 220, y1 - 20];
		}
	}

	private mutate(pdfPath: string, ann: PdfAnnotation, fn: (a: PdfAnnotation) => void): void {
		fn(ann);
		ann.updatedAt = Date.now();
		this.store.upsert(pdfPath, ann);
		this.refresh();
	}

	private createBox(layer: HTMLElement, pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): AnnotationBoxHandle {
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
		handle.el.addEventListener("mouseenter", () => this.beginHoverHighlight(pageView, ann));
		handle.el.addEventListener("mouseleave", () => this.endHoverHighlight());
		this.attachDrag(handle, pdfPath, ann, pageView);
		this.attachResize(handle, pdfPath, ann, pageView);
		return handle;
	}

	private scaleFont(pdfPath: string, ann: PdfAnnotation, delta: number): void {
		this.mutate(pdfPath, ann, (a) => (a.fontScale = Math.max(0.3, Math.min(4, (a.fontScale ?? 1) + delta))));
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
					if (a.pinned) {
						// Stored in PDF points, like everything else here — a raw-px
						// offset would stay fixed size on screen while the note's own
						// anchor position (and its neighbours') keeps scaling with
						// zoom, which is what could reorder/bunch up a rail after
						// zooming. See anchorTop(). Falls back to raw px only in the
						// edge case where the page isn't measurable right now.
						a.offsetY = (a.offsetY ?? 0) + (box ? dy / box.zoom : dy);
					} else if (box) {
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
	 * Resize handles on BOTH vertical edges (plus a bottom-right corner for free
	 * notes) — a normal resizable box, rather than the single page-facing edge
	 * this used to have. Whichever edge is grabbed follows the cursor; for the
	 * left edge that means moving `left` as the width changes, or the box
	 * appears to resize from its opposite side.
	 *
	 * A free note stores its own width/height as page-percent; a pinned note
	 * writes the shared RAIL width instead, since every note in a rail has to
	 * agree on one. The dragged px width is converted back to page points
	 * (÷ current zoom) before saving, so the rail keeps the size the user chose
	 * as the PDF is zoomed afterwards.
	 */
	private attachResize(handle: AnnotationBoxHandle, pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): void {
		if (ann.pinned) this.attachRailResize(handle, ann, pageView);
		else this.attachFreeResize(handle, pdfPath, ann, pageView);
	}

	/**
	 * A rail note's position is DERIVED (`railLeft()` = page edge + gap), not
	 * stored — so its page-facing edge is pinned by the layout and simply
	 * cannot be moved by changing the width. Dragging it used to look broken
	 * for exactly that reason: the edge snapped back on release and the
	 * opposite side grew instead.
	 *
	 * What makes both edges behave like a normal box is recognising that a rail
	 * has TWO degrees of freedom, and each edge owns one:
	 *   - outer edge (away from the page) → the rail's WIDTH
	 *   - inner edge (facing the page)    → the rail's GAP from the page,
	 *     with width compensating so the outer edge stays put
	 * Both are shared settings, so dragging either on any one note re-flows
	 * every note in that rail — which is the point of a rail.
	 */
	private attachRailResize(handle: AnnotationBoxHandle, ann: PdfAnnotation, pageView: PDFPageView): void {
		// Which DOM edge faces the page depends on the side the rail is on.
		const innerEdge = ann.side === "right" ? "left" : "right";
		const widthKey = ann.side === "right" ? "railWidthRight" : "railWidthLeft";
		const gapKey = ann.side === "right" ? "railGapRight" : "railGapLeft";

		const begin = (edge: "left" | "right") => (ev: PointerEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
			const box = this.currentPageBox(pageView);
			if (!box) return;

			const startX = ev.clientX;
			const startW = handle.el.offsetWidth;
			const startGapPx = this.railGapPt(this.getSettings(), ann.side) * box.zoom;
			const minWidthPx = MIN_RAIL_WIDTH_PT * box.zoom;
			const isInner = edge === innerEdge;
			// dx is measured rightwards; a left-hand rail mirrors every effect.
			const sign = ann.side === "right" ? 1 : -1;
			handle.el.addClass("is-dragging");

			const solve = (x: number) => {
				const dx = (x - startX) * sign;
				// Inner edge: width grows as the edge moves toward the page, and the
				// gap shrinks by the same amount so the outer edge stays put.
				// Outer edge: width alone, gap untouched.
				const width = Math.max(minWidthPx, isInner ? startW - dx : startW + dx);
				const gap = isInner ? startGapPx + (startW - width) : startGapPx;
				return { width, gap };
			};

			const onMove = (m: PointerEvent) => {
				const { width, gap } = solve(m.clientX);
				handle.el.style.width = `${width}px`;
				handle.el.style.left = `${this.railLeft(ann.side, box, width, gap)}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const { width, gap } = solve(u.clientX);
				const widthPt = Math.round(width / box.zoom);
				const gapPt = Math.round(gap / box.zoom);
				const settings = this.getSettings();
				if (widthPt !== Math.round(settings[widthKey]) || gapPt !== Math.round(settings[gapKey])) {
					this.saveSettings({ [widthKey]: widthPt, [gapKey]: gapPt });
				} else {
					this.refresh();
				}
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		};

		for (const edge of ["left", "right"] as const) {
			const grip = handle.el.createDiv(`margin-notes-pdf-resize is-edge is-${edge}`);
			grip.setAttribute(
				"aria-label",
				edge === innerEdge ? "拖动调整轨道离页面的距离" : "拖动调整轨道宽度"
			);
			grip.addEventListener("pointerdown", begin(edge));
		}
	}

	/** A free note stores its own box, so both edges and the corner move it directly. */
	private attachFreeResize(
		handle: AnnotationBoxHandle,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView
	): void {
		const begin = (edge: "left" | "right" | "corner") => (ev: PointerEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const startW = handle.el.offsetWidth;
			const startH = handle.el.offsetHeight;
			const startLeft = parseFloat(handle.el.style.left || "0");
			const zoom = this.currentPageBox(pageView)?.zoom ?? 1;
			const minWidthPx = MIN_FREE_WIDTH_PT * zoom;
			const grabsLeft = edge === "left";
			handle.el.addClass("is-dragging");

			const widthAt = (x: number) => Math.max(minWidthPx, startW + (grabsLeft ? startX - x : x - startX));
			const heightAt = (y: number) => Math.max(MIN_HEIGHT_PX, startH + (y - startY));

			const onMove = (m: PointerEvent) => {
				const w = widthAt(m.clientX);
				handle.el.style.width = `${w}px`;
				if (grabsLeft) handle.el.style.left = `${startLeft + (startW - w)}px`;
				if (edge === "corner") handle.el.style.height = `${heightAt(m.clientY)}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const box = this.currentPageBox(pageView);
				if (!box) return;
				const w = widthAt(u.clientX);
				const newLeft = grabsLeft ? startLeft + (startW - w) : startLeft;
				this.mutate(pdfPath, ann, (a) => {
					a.freeW = (w / box.width) * 100;
					// Growing leftwards moves the note too — keep its right edge put.
					if (grabsLeft) a.freeX = ((newLeft - box.left) / box.width) * 100;
					if (edge === "corner") a.freeH = (heightAt(u.clientY) / box.height) * 100;
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		};

		for (const edge of ["left", "right"] as const) {
			const grip = handle.el.createDiv(`margin-notes-pdf-resize is-edge is-${edge}`);
			grip.setAttribute("aria-label", "拖动调整宽度");
			grip.addEventListener("pointerdown", begin(edge));
		}
		const corner = handle.el.createDiv("margin-notes-pdf-resize is-corner");
		corner.setAttribute("aria-label", "拖动调整大小");
		corner.addEventListener("pointerdown", begin("corner"));
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

		const pageView = pages.get(ann.page);
		if (!pageView) return;
		const mark = this.drawAnchorMark(pageView, ann, "margin-notes-pdf-anchor-flash");
		if (!mark) return;
		mark.scrollIntoView({ block: "center", behavior: "smooth" });
		window.setTimeout(() => mark.remove(), 1600);
	}

	/**
	 * Hover feedback: unlike `reveal()` (a click, timed flash + scroll), this
	 * stays on screen for exactly as long as the pointer is over the note/row
	 * and never scrolls anything — a rail note or a list-panel row can be far
	 * from its source text, and jumping the view on mere hover would be far more
	 * disorienting than the "where does this even point at" problem it's meant
	 * to solve. Silently does nothing if the anchor's page isn't currently
	 * rendered (e.g. hovering a list row for a page that's scrolled out of view).
	 */
	private hoverMark: HTMLElement | null = null;

	beginHoverHighlight(pageView: PDFPageView, ann: PdfAnnotation): void {
		this.endHoverHighlight();
		this.hoverMark = this.drawAnchorMark(pageView, ann, "margin-notes-pdf-anchor-hover");
	}

	endHoverHighlight(): void {
		this.hoverMark?.remove();
		this.hoverMark = null;
	}

	private drawAnchorMark(pageView: PDFPageView, ann: PdfAnnotation, cls: string): HTMLElement | null {
		const layer = this.layer;
		const scroller = this.scroller;
		if (!layer || !scroller || !pageView.div.isConnected || !pageView.pdfPage?.view) return null;

		const box = this.pageBox(pageView, scroller, scroller.getBoundingClientRect());
		const left = Math.min(ann.anchor[0], ann.anchor[2]);
		const right = Math.max(ann.anchor[0], ann.anchor[2]);
		const topPt = box.ptY1 - Math.max(ann.anchor[1], ann.anchor[3]);
		const bottomPt = box.ptY1 - Math.min(ann.anchor[1], ann.anchor[3]);

		const mark = layer.createDiv(cls);
		mark.setCssStyles({
			left: `${box.left + ((left - box.ptX0) / box.ptWidth) * box.width}px`,
			top: `${box.top + (topPt / box.ptHeight) * box.height}px`,
			width: `${((right - left) / box.ptWidth) * box.width}px`,
			height: `${((bottomPt - topPt) / box.ptHeight) * box.height}px`,
		});
		return mark;
	}

	destroy(): void {
		window.clearTimeout(this.rebuildTimer);
		this.hoverMark = null;
		this.layer?.remove();
		this.layer = null;
	}
}
