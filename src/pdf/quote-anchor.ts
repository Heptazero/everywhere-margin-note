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

/**
 * Matching key: lowercased with ALL whitespace removed.
 *
 * Removing whitespace entirely (rather than collapsing it to single spaces) is
 * what makes this work for Chinese. pdf.js splits a line into many text-layer
 * spans, and this used to join them with a space — correct for English, where
 * spans break at word boundaries and the space belongs there, but corrupting
 * for CJK, which has no inter-word spaces: a quote like
 * `皮层和海马回路中的神经群体活动` could never match a flattened
 * `皮层和海马回路中的 神经群体活动` and every Chinese annotation silently
 * failed to anchor. Since the same transform is applied to both sides, dropping
 * whitespace is harmless for English too ("the quick" and "thequick" both
 * squash to the same key), which is why this is one code path and not two.
 */
function squash(s: string): string {
	return s.toLowerCase().replace(/\s+/g, "");
}

/** Finds which text-div index a position in the concatenated string falls in. */
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
 * Works in two coordinate spaces: `raw` is the plain concatenation of the text
 * divs (so an index into it maps straight back to a div + offset, which is what
 * `computeSelectionRects` needs), and the squashed key is what the search runs
 * on. `keep` maps squashed positions back to raw ones.
 */
export function resolveQuoteAnchor(pageView: PDFPageView, quote: string): PdfRect | null {
	const target = squash(quote);
	if (target.length < MIN_QUOTE_LEN) return null;

	const info = getTextLayerInfo(pageView);
	if (!info) return null;

	// Concatenated with NO separator — any separator would itself have to be
	// squashed away, and omitting it keeps raw indices exactly aligned with the
	// divs' own character offsets.
	let raw = "";
	const divStart: number[] = [];
	for (const div of info.textDivs) {
		divStart.push(raw.length);
		raw += div.textContent ?? "";
	}
	if (divStart.length === 0) return null;

	let squashed = "";
	const keep: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (/\s/.test(ch)) continue;
		squashed += ch.toLowerCase();
		keep.push(i);
	}

	const hit = squashed.indexOf(target);
	if (hit < 0) return null;

	const rawStart = keep[hit];
	const rawEnd = keep[hit + target.length - 1] + 1;

	const startDiv = divIndexAt(divStart, rawStart);
	const endDiv = divIndexAt(divStart, rawEnd - 1);
	const selection: Selection = [
		startDiv,
		rawStart - divStart[startDiv],
		endDiv,
		rawEnd - divStart[endDiv],
	];

	const lines = computeSelectionRects(pageView, selection);
	return unionRect(lines.map((l) => l.rect));
}
