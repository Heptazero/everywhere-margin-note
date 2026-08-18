import { TFile } from "obsidian";
import { getPageInfoForNode, type PdfRect } from "./pdf-layer";
import { computeSelectionRects, firstTextNode, getTextLayerInfo, type Selection } from "./selection-geom";
import type { PDFPageView } from "./pdfjs-types";

export interface AnchorResult {
	file: TFile;
	pageNumber: number;
	pageView: PDFPageView;
	rect: PdfRect;
}

function textDivIndexOf(textDivs: HTMLElement[], node: Node): number {
	const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
	if (!el) return -1;
	return textDivs.findIndex((d) => d === el || d.contains(el));
}

/**
 * DOM Range boundaries mean different things depending on the container: a
 * character offset if it's a Text node, but a child-node index if it's an
 * Element. pdf.js text-layer spans have a single text-node child, so an
 * element container's offset only ever means "before it" (0) or "after it"
 * (character length). Mirrors text-select-copy.ts's resolveBoundary.
 */
function resolveBoundary(container: Node, offset: number): { node: Text; offset: number } | null {
	if (container.nodeType === Node.TEXT_NODE) {
		return { node: container as Text, offset };
	}
	const textNode = firstTextNode(container);
	if (!textNode) return null;
	return { node: textNode, offset: offset === 0 ? 0 : textNode.length };
}

/** Also used by quote-anchor.ts to collapse a multi-line text match into one box. */
export function unionRect(rects: PdfRect[]): PdfRect | null {
	if (rects.length === 0) return null;
	let [x0, y0, x1, y1] = rects[0];
	for (const r of rects.slice(1)) {
		x0 = Math.min(x0, r[0]);
		y0 = Math.min(y0, r[1]);
		x1 = Math.max(x1, r[2]);
		y1 = Math.max(y1, r[3]);
	}
	return [x0, y0, x1, y1];
}

/**
 * Reads the current browser text selection, if it sits inside a tracked PDF
 * page's text layer, and reduces it to one bounding PdfRect (union of all its
 * visual-line rects) to anchor an annotation to. Only geometry is needed here
 * (not the selected text itself), so this is a trimmed-down sibling of
 * text-select-copy.ts's readActiveSelection — no formula-gap recovery, no
 * companion-markdown lookups.
 */
export function anchorFromActiveSelection(): AnchorResult | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

	const range = sel.getRangeAt(0);
	const info = getPageInfoForNode(range.startContainer);
	if (!info) return null;

	const file = info.view.file;
	if (!(file instanceof TFile) || file.extension !== "pdf") return null;

	const layerInfo = getTextLayerInfo(info.pageView);
	if (!layerInfo) return null;

	const start = resolveBoundary(range.startContainer, range.startOffset);
	const end = resolveBoundary(range.endContainer, range.endOffset);
	if (!start || !end) return null;

	const beginIndex = textDivIndexOf(layerInfo.textDivs, start.node);
	const endIndex = textDivIndexOf(layerInfo.textDivs, end.node);
	if (beginIndex < 0 || endIndex < 0) return null;

	const selection: Selection = [beginIndex, start.offset, endIndex, end.offset];
	const lines = computeSelectionRects(info.pageView, selection);
	const rect = unionRect(lines.map((l) => l.rect));
	if (!rect) return null;

	return { file, pageNumber: info.pageNumber, pageView: info.pageView, rect };
}
