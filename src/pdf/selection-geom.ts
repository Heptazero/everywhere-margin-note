// Mirrored (with the parts this plugin doesn't need trimmed) from
// everything-bilink/src/selection-geom.ts — text-quote-selection → PDF-rect geometry.
// Credit for the line-merging edge cases (superscript overlap, sub-pixel span gaps,
// median-not-max bottom) lives in that file's comments; keep both copies in sync if
// the underlying pdf.js text-layer behavior ever needs another correction.

import { screenToPdfPoint, type PdfRect } from "./pdf-layer";
import type { PDFPageView, TextLayerInfo } from "./pdfjs-types";

/** Obsidian's native text-selection subpath: 4 integers. */
export type Selection = [number, number, number, number];

// Obsidian's TextLayerBuilder shape differs by version: v1.8.0+ nests the data
// under `.textLayer`, older versions expose textDivs/textContentItems directly.
export function getTextLayerInfo(pageView: PDFPageView): TextLayerInfo | null {
	const tl = pageView.textLayer as { textLayer?: TextLayerInfo; textDivs?: HTMLElement[] } | undefined;
	if (!tl) return null;
	if (tl.textLayer?.textDivs) return tl.textLayer;
	if (tl.textDivs) return tl as unknown as TextLayerInfo;
	return null;
}

export function firstTextNode(node: Node): Text | null {
	const iter = document.createNodeIterator(node, NodeFilter.SHOW_TEXT);
	return iter.nextNode() as Text | null;
}

export interface SelectionLineRect {
	rect: PdfRect;
	heightRatio: number;
	hasGap: boolean;
}

/**
 * Resolves a `selection=beginIndex,beginOffset,endIndex,endOffset` into on-page
 * rectangles (one per visual line) in PDF-point coordinates, by building a DOM
 * Range across the rendered text-layer spans and reading its client rects. Returns
 * [] if the text layer isn't rendered yet (caller retries on textlayerrendered).
 */
export function computeSelectionRects(pageView: PDFPageView, sel: Selection): SelectionLineRect[] {
	const info = getTextLayerInfo(pageView);
	if (!info) return [];

	const [beginIndex, beginOffset, endIndex, endOffset] = sel;
	const startDiv = info.textDivs[beginIndex];
	const endDiv = info.textDivs[endIndex];
	if (!startDiv || !endDiv) return [];

	const startNode = firstTextNode(startDiv);
	const endNode = firstTextNode(endDiv);
	if (!startNode || !endNode) return [];

	const range = document.createRange();
	try {
		range.setStart(startNode, Math.min(beginOffset, startNode.length));
		range.setEnd(endNode, Math.min(endOffset, endNode.length));
	} catch {
		return [];
	}

	const clientRects = Array.from(range.getClientRects()).filter((cr) => cr.width >= 1 && cr.height >= 1);
	const merged = mergeIntoLines(clientRects);

	const rects: SelectionLineRect[] = [];
	for (const line of merged) {
		const [x0, y0] = screenToPdfPoint(pageView, line.left, line.bottom);
		const [x1, y1] = screenToPdfPoint(pageView, line.right, line.top);
		rects.push({ rect: [x0, y0, x1, y1], heightRatio: line.heightRatio, hasGap: line.hasGap });
	}
	return rects;
}

interface LineBox {
	left: number;
	right: number;
	top: number;
	bottom: number;
	heightRatio: number;
	hasGap: boolean;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Collapses the per-span client rects of a selection into one box per visual line. See
 * everything-bilink/src/selection-geom.ts's mergeIntoLines for the full rationale. */
function mergeIntoLines(rects: DOMRect[]): LineBox[] {
	const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
	const lines: {
		left: number;
		right: number;
		top: number;
		maxBottom: number;
		bottoms: number[];
		heights: number[];
		spans: DOMRect[];
	}[] = [];

	for (const cr of sorted) {
		const prev = lines[lines.length - 1];
		const overlap = prev ? Math.min(prev.maxBottom, cr.bottom) - Math.max(prev.top, cr.top) : 0;
		const sameLine = prev && overlap > Math.min(prev.maxBottom - prev.top, cr.height) * 0.3;

		if (sameLine) {
			prev.left = Math.min(prev.left, cr.left);
			prev.right = Math.max(prev.right, cr.right);
			prev.top = Math.min(prev.top, cr.top);
			prev.maxBottom = Math.max(prev.maxBottom, cr.bottom);
			prev.bottoms.push(cr.bottom);
			prev.heights.push(cr.height);
			prev.spans.push(cr);
		} else {
			lines.push({ left: cr.left, right: cr.right, top: cr.top, maxBottom: cr.bottom, bottoms: [cr.bottom], heights: [cr.height], spans: [cr] });
		}
	}

	return lines.map((l) => {
		const bottom = Math.max(median(l.bottoms), l.top + 1);
		const boxHeight = bottom - l.top;
		const refHeight = median(l.heights);
		return {
			left: l.left,
			right: l.right,
			top: l.top,
			bottom,
			heightRatio: Math.min(1, refHeight / boxHeight),
			hasGap: hasInternalGap(l.spans),
		};
	});
}

function hasInternalGap(spans: DOMRect[]): boolean {
	const sorted = [...spans].sort((a, b) => a.left - b.left);
	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i].left - sorted[i - 1].right;
		if (gap > Math.max(sorted[i].height, sorted[i - 1].height) * 1.5) return true;
	}
	return false;
}
