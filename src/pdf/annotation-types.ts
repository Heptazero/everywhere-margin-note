import type { PdfRect } from "./pdf-layer";

export type MarginSide = "left" | "right";

/**
 * One sticky note anchored to a PDF page.
 *
 * Display form is TWO independent switches rather than a single `kind`:
 *   pinned × collapsed → 4 states, all meaningful
 *     pinned + expanded  = a box in the side rail
 *     pinned + collapsed = a dot in the side rail
 *     free   + expanded  = a sticky note sitting anywhere
 *     free   + collapsed = a dot on the page
 * The earlier `kind: "floating" | "margin"` conflated these two axes, which is
 * why a floating note could never stay expanded and a margin note could never
 * shrink to a dot.
 */
export interface PdfAnnotation {
	id: string;
	page: number;
	/**
	 * Where the note points — from a text selection or dragged box, in PDF
	 * points. `[0,0,0,0]` (the default when omitted) means "unresolved": if
	 * `quote` is set, the renderer looks it up on `page`'s text layer and
	 * writes the real rect back the first time that page is on screen; a note
	 * with neither a real anchor nor a resolvable quote falls back to a fixed
	 * spot near the top of the page rather than being invisible.
	 */
	anchor: PdfRect;
	/**
	 * Text to search for on `page` to resolve `anchor` when it's unresolved —
	 * the field an AI (or anyone without a live PDF viewer) can actually supply,
	 * since it has no way to produce point coordinates from extracted text.
	 * See quote-anchor.ts.
	 */
	quote?: string;

	/** In the side rail (true) or placed freely (false). */
	pinned: boolean;
	/** Shown as a small dot instead of a box. */
	collapsed: boolean;
	/** Which rail, when pinned. */
	side: MarginSide;

	/**
	 * Free placement, as a percentage of the page box. Percentages (not pixels)
	 * so a note keeps its spot and size across zoom — and values outside 0–100
	 * legitimately mean "in the blank space beside the page".
	 */
	freeX?: number;
	freeY?: number;
	freeW?: number;
	/** Omitted = height follows the text. */
	freeH?: number;

	/**
	 * Pinned only: manual vertical nudge, in PDF points (like `anchor`), applied
	 * on top of the anchor position. Was raw px before v0.10.0 — at 100% zoom a
	 * point and a px are the same number, so old values keep rendering
	 * identically there; the fix is only visible at other zoom levels, where the
	 * nudge now scales with the note's own anchor instead of staying frozen.
	 */
	offsetY?: number;
	/** Per-note font multiplier over the global size. */
	fontScale?: number;
	/** Per-note colour override; unset = follow the pinned/free default. */
	color?: string;
	/** "plain" drops the border/background — just coloured text. Default "boxed". */
	style?: "boxed" | "plain";

	/** Markdown source — rendered through Obsidian's own pipeline. */
	text: string;
	createdAt: number;
	updatedAt: number;
}

/** Legacy v0.2–0.3 shape, before pinned/collapsed replaced `kind`. */
interface LegacyAnnotation extends Partial<PdfAnnotation> {
	kind?: "floating" | "margin";
}

/**
 * Fills in defaults and upgrades pre-0.4 records. `kind: "floating"` was always
 * a dot that expanded into a popover, so it maps to free+collapsed; `"margin"`
 * was always an expanded rail box.
 */
export function normalizeAnnotation(raw: LegacyAnnotation): PdfAnnotation {
	const legacyFloating = raw.kind === "floating";
	return {
		id: raw.id ?? makeAnnotationId(),
		page: raw.page ?? 1,
		anchor: raw.anchor ?? [0, 0, 0, 0],
		pinned: raw.pinned ?? !legacyFloating,
		collapsed: raw.collapsed ?? legacyFloating,
		side: raw.side ?? "right",
		freeX: raw.freeX,
		freeY: raw.freeY,
		freeW: raw.freeW,
		freeH: raw.freeH,
		offsetY: raw.offsetY,
		fontScale: raw.fontScale,
		color: raw.color,
		quote: raw.quote,
		style: raw.style,
		text: raw.text ?? "",
		createdAt: raw.createdAt ?? Date.now(),
		updatedAt: raw.updatedAt ?? Date.now(),
	};
}

export function makeAnnotationId(): string {
	return `pa-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

export const DEFAULT_FREE_WIDTH_PCT = 26;
