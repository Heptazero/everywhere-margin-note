import { Menu, Notice, type App, type Component } from "obsidian";
import { resolveCollisions } from "../collision-avoidance";
import { buildAnnotationBox, type AnnotationBoxHandle } from "./annotation-box";
import { darken, highlightsBothWays, type PdfAnnotationSettings } from "./annotation-settings";
import { openSwatchPicker } from "./swatch-picker";
import type { PdfAnnotationStore } from "./annotation-store";
import { DEFAULT_FREE_WIDTH_PCT, type MarginSide, type PdfAnnotation } from "./annotation-types";
import type { PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { resolveQuoteAnchor } from "./quote-anchor";
import { findScrollAncestor } from "./scroll-container";

/**
 * Floors an x at the scroll container's origin. Nothing can scroll to a
 * negative offset, so an element placed at x < 0 is not merely off-screen —
 * it is permanently unreachable, no matter how far the user scrolls. The left
 * rail has always been clamped this way; free notes were not, which is how a
 * note dragged into the gutter beside a page could vanish for good once the
 * gutter shrank (a zoom-in, a narrower pane, a wider page).
 *
 * Clamping means such a note can end up overlapping the page's left edge
 * instead of sitting beside it — deliberately preferred over being invisible,
 * since from there it can be seen and dragged somewhere better.
 */
function reachableX(x: number): number {
	return Math.max(0, x);
}

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
/** How far OUTSIDE the highlight the pointer has to stray before it is worth
 * explaining that the arrow cannot leave it. Below this it reads as a slip. */
const REANCHOR_HINT_PX = 24;

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

/** A leader line plus the knob on its text end, kept so both can be repositioned
 * without a full rebuild while the note or the anchor is being dragged. */
interface LeaderParts {
	line: HTMLElement;
	knob: HTMLElement;
	noteEl: HTMLElement;
	pageView: PDFPageView;
	ann: PdfAnnotation;
	/** Anchor box in scroll-container px; mutated live during an anchor drag. */
	a: { x0: number; x1: number; y0: number; y1: number };
}

/** One rendered annotation, kept so geometry can be re-measured after rendering. */
interface Placed {
	ann: PdfAnnotation;
	pageView: PDFPageView;
	el: HTMLElement;
	/**
	 * The anchor actually used for placement. Usually `ann.anchor`, but for a
	 * record still waiting on a quote lookup it's a transient stand-in that is
	 * deliberately NOT written back to `ann` — see `effectiveAnchor()`.
	 */
	rect: PdfRect;
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
	/** Anchor rects in scroll coords, for `both` mode's reverse hover test. */
	private hitAreas: { ann: PdfAnnotation; el: HTMLElement; x0: number; x1: number; y0: number; y1: number }[] = [];
	private hoveredAnchorId: string | null = null;
	/** Permanent bands ("常亮"), by annotation id — hover reuses these instead of
	 * drawing a second one on top (two translucent layers composite to roughly
	 * double the configured opacity, which is why 常亮 looked far darker than the
	 * hover highlight it is supposed to match). */
	private bands = new Map<string, HTMLElement>();
	/** Leader lines ("箭头"), by annotation id, so they can be redrawn live while
	 * either end is being dragged rather than waiting for the debounced rebuild. */
	private leaders = new Map<string, LeaderParts>();

	constructor(
		private app: App,
		private component: Component,
		private store: PdfAnnotationStore,
		private getSettings: () => PdfAnnotationSettings,
		private saveSettings: (patch: Partial<PdfAnnotationSettings>) => void,
		/** Hands "re-pick this note's highlight" back to the controller, which owns
		 * the selection/box-drag machinery. */
		private requestReanchor: (pdfPath: string, ann: PdfAnnotation) => void
	) {}

	private ensureLayer(anyPageDiv: HTMLElement): HTMLDivElement {
		const scroller = findScrollAncestor(anyPageDiv);
		if (this.layer?.isConnected && this.scroller === scroller) return this.layer;

		this.layer?.remove();
		// Hand the previous scroller back the padding we borrowed from it before
		// losing the reference, or the old viewer keeps a gutter for a rail that
		// is no longer there.
		if (this.scroller && this.scroller !== scroller) this.applyLeftGutter(this.scroller, 0);
		// CM6's `.cm-scroller` gets `position: relative` from its own base theme;
		// nothing gives the PDF viewer's scroller that for free.
		if (getComputedStyle(scroller).position === "static") scroller.style.position = "relative";

		this.scroller?.removeEventListener("mousemove", this.onScrollerMove);
		this.scroller?.removeEventListener("contextmenu", this.onScrollerContextMenu);
		const layer = scroller.createDiv(LAYER_CLASS);
		layer.setCssStyles({ position: "absolute", top: "0", left: "0", pointerEvents: "none" });
		this.layer = layer;
		this.scroller = scroller;
		scroller.addEventListener("mousemove", this.onScrollerMove);
		scroller.addEventListener("contextmenu", this.onScrollerContextMenu);
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
		this.hitAreas = [];
		this.hoveredAnchorId = null;
		this.bands.clear();
		this.leaders.clear();

		const built: Placed[] = [];
		const pending: Promise<void>[] = [];

		// Pass 1: create the DOM and kick off Markdown rendering. No geometry is
		// committed here — see the re-measure below for why.
		for (const [pageNumber, pageView] of pages) {
			if (!pageView.pdfPage?.view || !pageView.div.isConnected) continue;
			for (const ann of this.store.forPage(pdfPath, pageNumber)) {
				const rect = this.effectiveAnchor(pdfPath, ann, pageView);
				if (ann.collapsed) {
					built.push({ ann, pageView, rect, el: this.createDot(layer, pdfPath, ann) });
					continue;
				}
				const handle = this.createBox(layer, pdfPath, ann, pageView);
				pending.push(handle.render());
				built.push({ ann, pageView, rect, el: handle.el });
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
	 * a free note, so it scales with zoom in every respect.
	 *
	 * How that scaling is done matters, and it changed in v0.11.0. Sizes used to
	 * be written as already-multiplied px (`width = railWidthPt * zoom`,
	 * `fontSize = fontSize * zoom`), which scaled exactly two properties and left
	 * every other piece of chrome at a fixed px size: the box's own padding, the
	 * toolbar icons, the border, and the ~34px of right padding reserved for the
	 * toolbar. Zoomed out, that fixed chrome ate essentially the whole box — a
	 * 220pt rail at 30% zoom is 66px wide, of which 48px was non-scaling padding,
	 * leaving ~18px of text column. Two or three characters per line, with
	 * automatic height, is what made rail notes grow absurdly tall when zooming
	 * out.
	 *
	 * So: lay the note out at its natural (unscaled, point-valued) size and apply
	 * `transform: scale(zoom)` to the whole element instead. Everything inside
	 * scales in one step and stays in proportion, and — because line-breaking is
	 * now computed at a zoom-independent width — a note's text wraps identically
	 * at every zoom level, so its height no longer changes at all.
	 */
	private layout(built: Placed[], settings: PdfAnnotationSettings): void {
		const scroller = this.scroller;
		if (!scroller) return;

		// Reserve room for the left rail BEFORE measuring anything — it shifts the
		// pages, so every rect read afterwards has to already account for it.
		this.applyLeftGutter(scroller, this.leftGutterFor(built, settings, scroller));

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
			const { ann, el, rect } = item;

			if (ann.pinned) {
				const widthPt = this.railWidthPt(settings, ann.side);
				const left = this.railLeft(ann.side, box, widthPt * box.zoom, this.railGapPt(settings, ann.side) * box.zoom);
				el.style.left = `${left}px`;
				if (!ann.collapsed) {
					this.scaleBox(el, widthPt, undefined, settings, ann, box);
					maxRight = Math.max(maxRight, left + widthPt * box.zoom);
				} else {
					maxRight = Math.max(maxRight, left + DOT_SIZE_PX);
				}
				rails[ann.side].push({ id: ann.id, top: this.anchorTop(rect, ann, box), height: 0, el, zoom: box.zoom });
			} else if (ann.collapsed) {
				const left = reachableX(box.left + (this.freeXPct(rect, ann, box) / 100) * box.width);
				el.style.left = `${left}px`;
				el.style.top = `${box.top + (this.freeYPct(rect, ann, box) / 100) * box.height}px`;
				maxRight = Math.max(maxRight, left + DOT_SIZE_PX);
			} else {
				maxRight = Math.max(maxRight, this.placeFree(el, rect, ann, box, settings));
			}
		}

		for (const side of ["left", "right"] as const) {
			const group = rails[side];
			// offsetHeight is the element's UNSCALED layout height (transforms don't
			// affect it), so it has to be multiplied back up to compare against the
			// scroll-container coordinates the tops are in.
			for (const r of group) r.height = r.el.offsetHeight * r.zoom;
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
		//
		// Measured from the DOM, not from the `maxRight` accumulated above: that
		// running total is what each branch *intended* to place, and a single
		// branch getting it wrong silently truncates the scrollable area, which
		// strands every note past the cut-off with no way to scroll to them. A
		// post-transform getBoundingClientRect cannot disagree with what is on
		// screen, so the reachable area is defined by the genuinely outermost
		// note — whichever kind it happens to be — rather than by the rail.
		// After positioning: leader lines need the notes' final boxes, and the
		// `always` bands must not be counted in the width above (they sit over the
		// page, never past it).
		this.renderModeDecorations(built, settings, scroller);

		const right = Math.max(maxRight, this.measuredRight(built, scroller));
		this.layer!.style.width = right > 0 ? `${right + OUTER_MARGIN_PX}px` : "";
	}

	/**
	 * How much blank space the left rail needs beside the pages, in px.
	 *
	 * The right rail never needed this: notes past the right page edge simply
	 * extend the layer's width and the container scrolls to them. The left has no
	 * such freedom, because scroll offsets cannot go below zero — so `railLeft`
	 * clamps at 0, and once the page's own left gutter is smaller than the rail
	 * needs (which is exactly what zooming in does: the page grows until it fills
	 * the viewport and the gutter reaches zero), EVERY left note clamps to the
	 * same x and stacks up against the page edge, losing its position entirely.
	 * That asymmetry is why the left collapsed on zoom while the right was fine.
	 *
	 * Clamping was treating the symptom. The fix is to make the space exist:
	 * padding on the scroll container pushes the pages right, so there is always
	 * a real gutter to sit in and the clamp never fires. This is deliberately
	 * derived only from the rail's own settings and the zoom — never from a
	 * measured page position — because padding changes page positions, and
	 * feeding those back in would oscillate.
	 */
	private leftGutterFor(built: Placed[], settings: PdfAnnotationSettings, scroller: HTMLElement): number {
		if (!built.some((b) => b.ann.pinned && b.ann.side === "left")) return 0;

		const page = built.find((b) => b.pageView.div.isConnected && b.pageView.pdfPage?.view)?.pageView;
		if (!page) return 0;
		const zoom = this.pageBox(page, scroller, scroller.getBoundingClientRect()).zoom;

		const needed = (this.railWidthPt(settings, "left") + this.railGapPt(settings, "left")) * zoom;
		return Math.max(0, needed + OUTER_MARGIN_PX);
	}

	/** Idempotent so a re-layout with an unchanged gutter doesn't thrash pdf.js. */
	private applyLeftGutter(scroller: HTMLElement, px: number): void {
		const want = px > 0 ? `${Math.ceil(px)}px` : "";
		if (scroller.style.paddingLeft !== want) scroller.style.paddingLeft = want;
	}

	/** Rightmost rendered edge of any placed note, in scroll-container px. */
	private measuredRight(built: Placed[], scroller: HTMLElement): number {
		const scrollerRect = scroller.getBoundingClientRect();
		let right = 0;
		for (const item of built) {
			if (!item.el.isConnected) continue;
			const r = item.el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			right = Math.max(right, r.right - scrollerRect.left + scroller.scrollLeft);
		}
		return right;
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
	private anchorTop(rect: PdfRect, ann: PdfAnnotation, box: PageBox): number {
		const topPt = box.ptY1 - Math.max(rect[1], rect[3]);
		return box.top + (topPt / box.ptHeight) * box.height + (ann.offsetY ?? 0) * box.zoom;
	}

	/**
	 * Sizes a note in unscaled point units and hands the zoom to a transform.
	 * `widthPt`/`heightPt` are the note's natural size; the element is then
	 * scaled as one piece from its top-left, which is the corner its `left`/`top`
	 * are measured from. See layout()'s comment for why this beats multiplying
	 * individual properties by zoom.
	 */
	private scaleBox(
		el: HTMLElement,
		widthPt: number,
		heightPt: number | undefined,
		settings: PdfAnnotationSettings,
		ann: PdfAnnotation,
		box: PageBox
	): void {
		el.style.width = `${widthPt}px`;
		el.style.height = heightPt ? `${heightPt}px` : "";
		el.style.fontSize = `${settings.fontSize * (ann.fontScale ?? 1)}px`;
		el.style.transformOrigin = "top left";
		el.style.transform = `scale(${box.zoom})`;
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
	private freeXPct(rect: PdfRect, ann: PdfAnnotation, box: PageBox): number {
		if (ann.freeX !== undefined) return ann.freeX;
		const right = Math.max(rect[0], rect[2]);
		return ((right - box.ptX0) / box.ptWidth) * 100 + 3;
	}

	/** Free-placement Y, defaulting to the anchor's own height on the page. */
	private freeYPct(rect: PdfRect, ann: PdfAnnotation, box: PageBox): number {
		return ann.freeY ?? ((box.ptY1 - Math.max(rect[1], rect[3])) / box.ptHeight) * 100;
	}

	/** Returns the note's right edge in scroll-container px, for the layer width. */
	private placeFree(
		el: HTMLElement,
		rect: PdfRect,
		ann: PdfAnnotation,
		box: PageBox,
		settings: PdfAnnotationSettings
	): number {
		const left = reachableX(box.left + (this.freeXPct(rect, ann, box) / 100) * box.width);
		el.style.left = `${left}px`;
		el.style.top = `${box.top + (this.freeYPct(rect, ann, box) / 100) * box.height}px`;
		// freeW/freeH are page-percentages; convert to the note's own unscaled
		// units by dividing out the zoom the transform is about to re-apply.
		const widthPx = ((ann.freeW ?? DEFAULT_FREE_WIDTH_PCT) / 100) * box.width;
		const heightPx = ann.freeH ? (ann.freeH / 100) * box.height : undefined;
		this.scaleBox(el, widthPx / box.zoom, heightPx ? heightPx / box.zoom : undefined, settings, ann, box);
		return left + widthPx;
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
	private effectiveAnchor(pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): PdfRect {
		if (!isUnresolvedAnchor(ann.anchor)) return ann.anchor;

		if (ann.quote) {
			const resolved = resolveQuoteAnchor(pageView, ann.quote);
			if (resolved) {
				ann.anchor = resolved;
				ann.updatedAt = Date.now();
				// Not a user edit — keep it out of the undo history.
				this.store.upsert(pdfPath, ann, false);
				return resolved;
			}
		}
		// Failed: return a placeholder spot WITHOUT touching ann.anchor, so the
		// record stays "unresolved" and gets retried on every later rebuild.
		//
		// This used to assign the placeholder to `ann.anchor` directly. That
		// latched permanently — `isUnresolvedAnchor` then said false forever — and
		// any later upsert (a drag, an edit) persisted the placeholder to disk.
		// Which is exactly what happened to the AI-written notes on the
		// original/translation pair: their quotes are in the TRANSLATION's
		// language, so opening the ORIGINAL first failed every lookup and froze
		// six of eight notes at `[20, 732, 220, 772]`. Retrying instead means the
		// lookup succeeds the moment the matching-language side is opened, and —
		// since the translation preserves the layout — the rect it writes back is
		// correct for both members of the pair.
		if (pageView.pdfPage?.view) {
			const [x0, , , y1] = pageView.pdfPage.view;
			return [x0 + 20, y1 - 60, x0 + 220, y1 - 20];
		}
		return ann.anchor;
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
			// The body now starts below the toolbar's row rather than beside it, so
			// icons no longer cost text width and the most-used few can live here
			// again instead of behind the "⋯". Everything is still in the menu too.
			actions: [
				{
					icon: "a-arrow-down",
					title: "字号调小",
					onClick: () => this.scaleFont(pdfPath, ann, -0.15),
				},
				{
					icon: "a-arrow-up",
					title: "字号调大",
					onClick: () => this.scaleFont(pdfPath, ann, 0.15),
				},
				{
					icon: "circle",
					cls: "margin-notes-pdf-swatch",
					title: "更改颜色",
					onClick: (ev) => this.pickColor(pdfPath, ann, { x: ev.clientX, y: ev.clientY }),
				},
				{
					icon: "square",
					title: "切换有无边框",
					onClick: () => this.mutate(pdfPath, ann, (a) => (a.style = a.style === "plain" ? "boxed" : "plain")),
				},
				{
					icon: "more-horizontal",
					title: "更多(固定/收起、移动、重设高亮、删除…)",
					onClick: (ev) => this.openMenu(pdfPath, ann, { x: ev.clientX, y: ev.clientY }),
				},
			],
		});

		handle.el.dataset.annotationId = ann.id;
		handle.el.dataset.mode = ann.pinned ? "rail" : "free";
		handle.el.dataset.side = ann.side;
		handle.el.dataset.style = ann.style ?? "boxed";
		const color = this.colorOf(ann);
		if (ann.color) handle.el.style.setProperty("--margin-notes-pdf-note-color", ann.color);
		handle.el.style.setProperty("--margin-notes-pdf-note-color-deep", darken(color));
		handle.el.querySelector<HTMLElement>(".margin-notes-pdf-swatch")?.style.setProperty("color", color);

		handle.el.addEventListener("contextmenu", (e) => this.showMenu(e, pdfPath, ann));
		// The same `is-linked` state as hovering the TEXT applies, so the two
		// directions of the same relationship look identical rather than one
		// getting an outline and the other only an opacity bump.
		handle.el.addEventListener("mouseenter", () => {
			handle.el.addClass("is-linked");
			this.beginHoverHighlight(pageView, ann);
		});
		handle.el.addEventListener("mouseleave", () => {
			handle.el.removeClass("is-linked");
			this.endHoverHighlight();
		});
		this.attachDrag(handle, pdfPath, ann, pageView);
		this.attachResize(handle, pdfPath, ann, pageView);
		return handle;
	}

	private scaleFont(pdfPath: string, ann: PdfAnnotation, delta: number): void {
		this.mutate(pdfPath, ann, (a) => (a.fontScale = Math.max(0.3, Math.min(4, (a.fontScale ?? 1) + delta))));
	}

	/** Preset swatches rather than the OS colour panel — see swatch-picker.ts. */
	private pickColor(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		openSwatchPicker({
			at,
			colors: this.getSettings().palette,
			current: ann.color,
			onPick: (color) => this.mutate(pdfPath, ann, (a) => (a.color = color)),
		});
	}

	/**
	 * Un-pinning freezes the note exactly where it currently sits — same spot,
	 * same width — by reading its rendered box and writing that back as
	 * freeX/freeY/freeW.
	 *
	 * Leaving those unset (the previous behaviour) meant falling through to
	 * freeXPct/freeYPct's DEFAULTS, which are derived from the anchor. For a note
	 * in a rail that is nowhere near where it was: horizontally it teleports from
	 * the rail lane back beside its source text, and vertically it loses both its
	 * manual `offsetY` nudge and whatever displacement collision avoidance had
	 * given it. "Unpin" should mean "stop being in the lane", not "jump somewhere
	 * else" — from wherever it lands, dragging it is easy.
	 *
	 * `el.style.top` is read after the collision pass has written to it, so it is
	 * the note's true resolved position, not its pre-collision anchor position.
	 */
	private togglePin(pdfPath: string, ann: PdfAnnotation): void {
		if (ann.pinned) {
			const el = this.layer?.querySelector<HTMLElement>(`[data-annotation-id="${ann.id}"]`);
			const pageView = this.last?.pages.get(ann.page);
			const box = pageView ? this.currentPageBox(pageView) : null;
			if (el && box && box.width > 0 && box.height > 0) {
				const left = parseFloat(el.style.left || "0");
				const top = parseFloat(el.style.top || "0");
				// offsetWidth is unscaled (the zoom lives in the transform), so it
				// has to be scaled up before being expressed as a page percentage.
				const widthPx = el.offsetWidth * box.zoom;
				this.mutate(pdfPath, ann, (a) => {
					a.pinned = false;
					a.freeX = ((left - box.left) / box.width) * 100;
					a.freeY = ((top - box.top) / box.height) * 100;
					a.freeW = (widthPx / box.width) * 100;
					// Now baked into freeY; leaving it would re-apply on a later re-pin.
					a.offsetY = 0;
				});
				return;
			}
		}
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
				.setTitle("重新指定高亮位置(选中文字或拖框)")
				.setIcon("highlighter")
				.onClick(() => this.requestReanchor(pdfPath, ann))
		);
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
				.onClick(() => this.pickColor(pdfPath, ann, at))
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
		// Appended, not prepended: the grip belongs in the corner itself, which is
		// the last slot in a right-aligned toolbar, not the first.
		const grip = handle.toolbarEl.createDiv({ cls: "margin-notes-pdf-grip" });
		grip.setAttribute("aria-label", ann.pinned ? "上下拖动" : "拖动摆放");

		grip.addEventListener("pointerdown", (ev) => this.beginNoteDrag(ev, handle.el, pdfPath, ann, pageView));
	}

	/**
	 * Moves a note. Shared by the toolbar grip and — since it visibly ties the
	 * note to its text — the leader line, which can be grabbed anywhere along its
	 * length to drag the note it belongs to.
	 */
	private beginNoteDrag(
		ev: PointerEvent,
		el: HTMLElement,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView
	): void {
		ev.preventDefault();
		ev.stopPropagation();
		const handle = { el };
		const startX = ev.clientX;
		const startY = ev.clientY;
		const startLeft = parseFloat(handle.el.style.left || "0");
		const startTop = parseFloat(handle.el.style.top || "0");
		handle.el.addClass("is-dragging");

		const onMove = (m: PointerEvent) => {
			handle.el.style.top = `${startTop + (m.clientY - startY)}px`;
			if (!ann.pinned) handle.el.style.left = `${startLeft + (m.clientX - startX)}px`;
			this.refreshLeader(ann.id);
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
			// The element is laid out unscaled and scaled by transform, so
			// offsetWidth is already in points — and every quantity below stays in
			// points, cursor deltas included (÷ zoom), so nothing needs converting
			// back on save.
			const startW = handle.el.offsetWidth;
			const startGap = this.railGapPt(this.getSettings(), ann.side);
			const isInner = edge === innerEdge;
			// dx is measured rightwards; a left-hand rail mirrors every effect.
			const sign = ann.side === "right" ? 1 : -1;
			handle.el.addClass("is-dragging");

			const solve = (x: number) => {
				const dx = ((x - startX) * sign) / box.zoom;
				// Inner edge: width grows as the edge moves toward the page, and the
				// gap shrinks by the same amount so the outer edge stays put.
				// Outer edge: width alone, gap untouched.
				const width = Math.max(MIN_RAIL_WIDTH_PT, isInner ? startW - dx : startW + dx);
				const gap = isInner ? startGap + (startW - width) : startGap;
				return { width, gap };
			};

			const onMove = (m: PointerEvent) => {
				const { width, gap } = solve(m.clientX);
				handle.el.style.width = `${width}px`;
				handle.el.style.left = `${this.railLeft(ann.side, box, width * box.zoom, gap * box.zoom)}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const { width, gap } = solve(u.clientX);
				const widthPt = Math.round(width);
				const gapPt = Math.round(gap);
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
			// Unscaled (point) dimensions — the transform supplies the zoom, so
			// cursor deltas are divided by it to stay in the same units.
			const startW = handle.el.offsetWidth;
			const startH = handle.el.offsetHeight;
			const startLeft = parseFloat(handle.el.style.left || "0");
			const zoom = this.currentPageBox(pageView)?.zoom ?? 1;
			const grabsLeft = edge === "left";
			handle.el.addClass("is-dragging");

			const widthAt = (x: number) =>
				Math.max(MIN_FREE_WIDTH_PT, startW + (grabsLeft ? startX - x : x - startX) / zoom);
			const heightAt = (y: number) => Math.max(MIN_HEIGHT_PX, startH + (y - startY) / zoom);

			const onMove = (m: PointerEvent) => {
				const w = widthAt(m.clientX);
				handle.el.style.width = `${w}px`;
				// `left` is a scroll-container coordinate, so the width delta has to
				// be scaled back up before it can move the box's on-screen position.
				if (grabsLeft) handle.el.style.left = `${startLeft + (startW - w) * zoom}px`;
				if (edge === "corner") handle.el.style.height = `${heightAt(m.clientY)}px`;
			};
			const onUp = (u: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const box = this.currentPageBox(pageView);
				if (!box) return;
				const w = widthAt(u.clientX);
				const newLeft = grabsLeft ? startLeft + (startW - w) * zoom : startLeft;
				this.mutate(pdfPath, ann, (a) => {
					a.freeW = ((w * zoom) / box.width) * 100;
					// Growing leftwards moves the note too — keep its right edge put.
					if (grabsLeft) a.freeX = ((newLeft - box.left) / box.width) * 100;
					if (edge === "corner") a.freeH = ((heightAt(u.clientY) * zoom) / box.height) * 100;
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
	private activeBand: HTMLElement | null = null;

	beginHoverHighlight(pageView: PDFPageView, ann: PdfAnnotation): void {
		this.endHoverHighlight();
		// A band already covering this anchor is brightened in place. Drawing a
		// second translucent rect over the first is what made 常亮 look much
		// darker than 悬浮 — the two layers composited instead of matching.
		const band = this.bands.get(ann.id);
		if (band) {
			band.addClass("is-active");
			this.activeBand = band;
			return;
		}
		this.hoverMark = this.drawAnchorMark(pageView, ann, "margin-notes-pdf-anchor-hover");
	}

	endHoverHighlight(): void {
		this.activeBand?.removeClass("is-active");
		this.activeBand = null;
		this.hoverMark?.remove();
		this.hoverMark = null;
	}

	/**
	 * Right-clicking the highlighted TEXT opens that note's menu — the region on
	 * the page is the most obvious thing to aim at when you want to change the
	 * note attached to it, and it is often far easier to hit than a note sitting
	 * off in a rail. Only swallows the event on an actual hit, so right-clicking
	 * anywhere else on the PDF still gets Obsidian's own menu.
	 */
	private onScrollerContextMenu = (ev: MouseEvent): void => {
		const pdfPath = this.last?.pdfPath;
		if (!pdfPath || !this.scroller || this.hitAreas.length === 0) return;
		if ((ev.target as HTMLElement | null)?.closest(".margin-notes-pdf-note")) return;

		const r = this.scroller.getBoundingClientRect();
		const x = ev.clientX - r.left + this.scroller.scrollLeft;
		const y = ev.clientY - r.top + this.scroller.scrollTop;
		const hit = this.hitAreas.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
		if (!hit) return;

		ev.preventDefault();
		ev.stopPropagation();
		this.openMenu(pdfPath, hit.ann, { x: ev.clientX, y: ev.clientY });
	};

	/**
	 * The colour a note and its highlight share. Per-note `color` wins; otherwise
	 * the rail/free default for its kind — so the band over the text is always
	 * the same hue as the note it belongs to, which is what makes several
	 * highlights on one page readable at a glance.
	 */
	private colorOf(ann: PdfAnnotation): string {
		const s = this.getSettings();
		return ann.color ?? (ann.pinned ? s.railColor : s.freeColor);
	}

	private drawAnchorMark(pageView: PDFPageView, ann: PdfAnnotation, cls: string): HTMLElement | null {
		const layer = this.layer;
		const scroller = this.scroller;
		if (!layer || !scroller || !pageView.div.isConnected || !pageView.pdfPage?.view) return null;

		// Highlight the REAL source text or nothing at all. An unresolved record
		// gets one live quote lookup here; if that fails we return null rather
		// than drawing over `layout()`'s placeholder spot, because a highlight
		// pointing confidently at the wrong lines is worse than no highlight —
		// the whole purpose of this is answering "where is this in the original".
		const rect = isUnresolvedAnchor(ann.anchor)
			? ann.quote
				? resolveQuoteAnchor(pageView, ann.quote)
				: null
			: ann.anchor;
		if (!rect) return null;

		const box = this.pageBox(pageView, scroller, scroller.getBoundingClientRect());
		const left = Math.min(rect[0], rect[2]);
		const right = Math.max(rect[0], rect[2]);
		const topPt = box.ptY1 - Math.max(rect[1], rect[3]);
		const bottomPt = box.ptY1 - Math.min(rect[1], rect[3]);

		const mark = layer.createDiv(cls);
		mark.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		mark.setCssStyles({
			left: `${box.left + ((left - box.ptX0) / box.ptWidth) * box.width}px`,
			top: `${box.top + (topPt / box.ptHeight) * box.height}px`,
			width: `${((right - left) / box.ptWidth) * box.width}px`,
			height: `${((bottomPt - topPt) / box.ptHeight) * box.height}px`,
		});
		return mark;
	}

	/**
	 * Draws whatever the current mode wants shown without any pointer involved:
	 * a permanent band per anchor (`always`), or a leader line from each note to
	 * its text (`line`). `note`/`both` draw nothing here — they are purely
	 * hover-driven — but `both` still needs the anchor rects recorded, which is
	 * what `hitAreas` is for.
	 */
	private renderModeDecorations(built: Placed[], settings: PdfAnnotationSettings, scroller: HTMLElement): void {
		this.hitAreas = [];
		this.bands.clear();
		this.leaders.clear();
		const layer = this.layer;
		if (!layer) return;
		const mode = settings.highlightMode;
		const scrollerRect = scroller.getBoundingClientRect();

		for (const item of built) {
			const { ann, el, pageView, rect } = item;
			if (!pageView.div.isConnected || !pageView.pdfPage?.view) continue;
			if (isUnresolvedAnchor(rect)) continue;

			const box = this.pageBox(pageView, scroller, scrollerRect);
			const x0 = box.left + ((Math.min(rect[0], rect[2]) - box.ptX0) / box.ptWidth) * box.width;
			const x1 = box.left + ((Math.max(rect[0], rect[2]) - box.ptX0) / box.ptWidth) * box.width;
			const y0 = box.top + ((box.ptY1 - Math.max(rect[1], rect[3])) / box.ptHeight) * box.height;
			const y1 = box.top + ((box.ptY1 - Math.min(rect[1], rect[3])) / box.ptHeight) * box.height;

			// Recorded in every mode: reverse hover uses them when the mode wants it,
			// and right-clicking the region to edit its note works regardless.
			this.hitAreas.push({ ann, el, x0, x1, y0, y1 });

			if (mode === "always") {
				const band = layer.createDiv("margin-notes-pdf-anchor-band");
				band.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
				band.setCssStyles({ left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
				this.bands.set(ann.id, band);
			} else if (mode === "line") {
				this.drawLeader(layer, ann, el, { x0, x1, y0, y1 }, pageView);
			}
		}
	}

	/**
	 * A thin leader from the note's page-facing edge to the middle of its text.
	 * Drawn as one rotated 1px div rather than an SVG overlay — it needs no
	 * separate coordinate system, and there is exactly one primitive to keep in
	 * sync with the layer's scroll coordinates.
	 */
	private drawLeader(
		layer: HTMLElement,
		ann: PdfAnnotation,
		el: HTMLElement,
		a: { x0: number; x1: number; y0: number; y1: number },
		pageView: PDFPageView
	): void {
		const line = layer.createDiv("margin-notes-pdf-leader");
		const knob = layer.createDiv("margin-notes-pdf-leader-knob");
		for (const n of [line, knob]) n.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		knob.setAttribute("aria-label", "拖动可以改变箭头落在高亮范围内的哪个位置");

		const parts: LeaderParts = { line, knob, noteEl: el, pageView, ann, a: { ...a } };
		this.leaders.set(ann.id, parts);
		this.positionLeader(parts);
		knob.addEventListener("pointerdown", (ev) => this.beginAnchorDrag(ev, parts));
	}

	/**
	 * Places (or replaces) a leader from the note's page-facing edge to the near
	 * edge of its text, with the knob on the text end. Split out from drawLeader
	 * so a drag can call it on every pointermove — the line used to be redrawn
	 * only by the debounced rebuild, which is why it visibly lagged behind a note
	 * being dragged.
	 */
	private positionLeader(p: LeaderParts): void {
		const { line, knob, noteEl, a } = p;
		const noteRect = noteEl.getBoundingClientRect();
		const noteLeft = parseFloat(noteEl.style.left || "0");
		const noteTop = parseFloat(noteEl.style.top || "0");

		const noteCentre = noteLeft + noteRect.width / 2;
		const textCentre = (a.x0 + a.x1) / 2;
		const facingRight = noteCentre > textCentre;
		const sx = facingRight ? noteLeft : noteLeft + noteRect.width;
		const sy = noteTop + noteRect.height / 2;
		// Default attachment: the middle of the region's edge nearest the note.
		const f = p.ann.leaderAt ?? { x: facingRight ? 1 : 0, y: 0.5 };
		const tx = a.x0 + f.x * (a.x1 - a.x0);
		const ty = a.y0 + f.y * (a.y1 - a.y0);

		const dx = tx - sx;
		const dy = ty - sy;
		const len = Math.hypot(dx, dy);
		line.setCssStyles({
			left: `${sx}px`,
			top: `${sy}px`,
			width: `${Math.max(0, len)}px`,
			transform: `rotate(${Math.atan2(dy, dx)}rad)`,
			transformOrigin: "0 50%",
		});
		knob.setCssStyles({ left: `${tx}px`, top: `${ty}px` });
	}

	/** Keeps a note's leader glued to it while the note itself is being dragged. */
	private refreshLeader(annId: string): void {
		const p = this.leaders.get(annId);
		if (p) this.positionLeader(p);
	}

	/**
	 * Moves where the arrow attaches, CLAMPED to the highlighted region.
	 *
	 * Two different things could have been meant by dragging this end, and only
	 * one of them is safe. Moving the attachment point is presentational — the
	 * arrow leaves from a tidier spot — and costs nothing if done by accident.
	 * Moving the REGION would redefine where the note says its subject is, which
	 * is content, and a stray drag must never silently rewrite that. So the point
	 * slides freely inside the region and stops at its edge; pulling well past
	 * the edge says how to actually change the region.
	 */
	private beginAnchorDrag(ev: PointerEvent, p: LeaderParts): void {
		ev.preventDefault();
		ev.stopPropagation();
		const pdfPath = this.last?.pdfPath;
		if (!pdfPath || !this.scroller) return;

		const scroller = this.scroller;
		const a = p.a;
		const w = a.x1 - a.x0;
		const h = a.y1 - a.y0;
		let escaped = 0;
		p.knob.addClass("is-dragging");

		const fractionAt = (m: MouseEvent) => {
			const r = scroller.getBoundingClientRect();
			const x = m.clientX - r.left + scroller.scrollLeft;
			const y = m.clientY - r.top + scroller.scrollTop;
			// How far outside the region the pointer went, for the hint below.
			escaped = Math.max(escaped, a.x0 - x, x - a.x1, a.y0 - y, y - a.y1);
			return {
				x: w > 0 ? Math.max(0, Math.min(1, (x - a.x0) / w)) : 0,
				y: h > 0 ? Math.max(0, Math.min(1, (y - a.y0) / h)) : 0.5,
			};
		};

		const onMove = (m: PointerEvent) => {
			p.ann.leaderAt = fractionAt(m);
			this.positionLeader(p);
		};
		const onUp = (u: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			p.knob.removeClass("is-dragging");
			const at = fractionAt(u);
			this.mutate(pdfPath, p.ann, (ann) => (ann.leaderAt = at));
			if (escaped >= REANCHOR_HINT_PX) {
				new Notice("箭头只能落在高亮范围内。要改高亮范围:选中新的文字,再用批注菜单里的「重新指定高亮位置」");
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	}

	/**
	 * Reverse hover for `both` mode: pointing at the TEXT lights up its note.
	 *
	 * Driven by a mousemove hit-test rather than by real elements over the
	 * anchors, because anything with `pointer-events: auto` sitting on the page
	 * would swallow text selection — and selecting text is how annotations get
	 * made in the first place.
	 */
	private onScrollerMove = (ev: MouseEvent): void => {
		if (this.hitAreas.length === 0 || !this.scroller) return;
		if (!highlightsBothWays(this.getSettings().highlightMode)) return;
		// While the pointer is on a note, that note's own mouseenter owns the
		// highlight. Without this the two fight: the note lights its anchor, then
		// the very next mousemove finds no anchor under the cursor and clears it.
		if ((ev.target as HTMLElement | null)?.closest(".margin-notes-pdf-note")) return;
		const r = this.scroller.getBoundingClientRect();
		const x = ev.clientX - r.left + this.scroller.scrollLeft;
		const y = ev.clientY - r.top + this.scroller.scrollTop;

		const hit = this.hitAreas.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
		if (hit?.ann.id === this.hoveredAnchorId) return;
		this.hoveredAnchorId = hit?.ann.id ?? null;

		for (const h of this.hitAreas) h.el.removeClass("is-linked");
		this.endHoverHighlight();
		if (!hit) return;

		hit.el.addClass("is-linked");
		const pageView = this.last?.pages.get(hit.ann.page);
		if (pageView) this.beginHoverHighlight(pageView, hit.ann);
	};

	destroy(): void {
		window.clearTimeout(this.rebuildTimer);
		this.hoverMark = null;
		// The gutter lives on pdf.js's own element, not ours — it has to be undone
		// explicitly, unlike the layer, which disappears with its own node.
		if (this.scroller) {
			this.applyLeftGutter(this.scroller, 0);
			this.scroller.removeEventListener("mousemove", this.onScrollerMove);
			this.scroller.removeEventListener("contextmenu", this.onScrollerContextMenu);
		}
		this.hitAreas = [];
		this.layer?.remove();
		this.layer = null;
		this.scroller = null;
	}
}
