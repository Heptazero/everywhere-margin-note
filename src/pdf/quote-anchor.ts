import { unionRect } from "./annotation-anchor";
import type { PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { computeSelectionRects, getTextLayerInfo, type Selection } from "./selection-geom";

/**
 * Resolves a text quote (no coordinates) to an on-page rect — what makes an
 * AI-authored annotation possible: a model reading extracted PDF text can
 * supply `{page, quote}`, but has no way to produce PDF-point coordinates.
 * `annotation-anchor.ts`'s `anchorFromActiveSelection` solves the same
 * geometry problem for a live DOM Selection; this is the same idea driven by
 * a plain string search instead.
 */

/** Below this, a match is too likely to be coincidental to trust. */
const MIN_QUOTE_LEN = 4;

function normalizeForSearch(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Finds which text-div index a position in the flattened string falls in. */
function divIndexAt(divStart: number[], flatIndex: number): number {
	let lo = 0;
	let hi = divStart.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (divStart[mid] <= flatIndex) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/**
 * Searches `pageView`'s rendered text layer for `quote` and returns its
 * bounding PdfRect, or null if the text layer isn't ready or nothing matches.
 *
 * The search is case-insensitive with whitespace collapsed on both sides —
 * pdf.js text-layer spans essentially never contain internal multi-space runs,
 * so this rarely shifts offsets enough to matter; when it does, the match
 * still lands within a line or two of the right spot, which the caller's
 * fallback-on-failure path treats as an acceptable degrade, not a bug to chase.
 */
export function resolveQuoteAnchor(pageView: PDFPageView, quote: string): PdfRect | null {
	const target = normalizeForSearch(quote);
	if (target.length < MIN_QUOTE_LEN) return null;

	const info = getTextLayerInfo(pageView);
	if (!info) return null;

	let flat = "";
	const divStart: number[] = [];
	info.textDivs.forEach((div, i) => {
		divStart.push(flat.length);
		flat += div.textContent ?? "";
		if (i < info.textDivs.length - 1) flat += " ";
	});
	if (divStart.length === 0) return null;

	const idx = normalizeForSearch(flat).indexOf(target);
	if (idx < 0) return null;

	const startDiv = divIndexAt(divStart, idx);
	const endDiv = divIndexAt(divStart, idx + target.length);
	const startOffset = Math.max(0, idx - divStart[startDiv]);
	const endOffset = Math.max(0, idx + target.length - divStart[endDiv]);

	const selection: Selection = [startDiv, startOffset, endDiv, endOffset];
	const lines = computeSelectionRects(pageView, selection);
	return unionRect(lines.map((l) => l.rect));
}
