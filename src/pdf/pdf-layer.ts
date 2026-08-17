// Mirrored from everything-bilink/src/pdf-layer.ts (~150 lines, deliberately not
// shared as a package — see this plugin's HANDOFF.md for why). These are
// undocumented Obsidian/pdf.js internals (same chain PDF++ relies on); if a future
// Obsidian upgrade breaks this, fix both copies.

import { App, Component, FileView } from "obsidian";
import type { ObsidianViewer, PDFPageView, PDFViewerComponent } from "./pdfjs-types";

const OVERLAY_CLASS = "margin-notes-pdf-overlay";

/** A rect in PDF point space: [x0, y0, x1, y1], origin bottom-left, x0<x1, y0<y1. */
export type PdfRect = [number, number, number, number];

export function getActivePDFView(app: App): FileView | null {
	const view = app.workspace.getActiveViewOfType(FileView);
	if (view && view.getViewType() === "pdf") return view;
	return null;
}

function getViewerComponent(view: FileView): PDFViewerComponent | null {
	// Obsidian's PDF FileView exposes `.viewer` (a PDFViewerComponent); undocumented
	// but stable across recent Obsidian versions (same chain PDF++ relies on).
	return (view as unknown as { viewer?: PDFViewerComponent }).viewer ?? null;
}

interface PageInfo {
	pageNumber: number;
	pageView: PDFPageView;
	view: FileView;
}

// Populated by onPageReady below; lets any code (e.g. "what page is this DOM
// selection on?") map a page's DOM node back to its page number/view without every
// caller needing its own bookkeeping.
const pageInfoByDiv = new WeakMap<HTMLDivElement, PageInfo>();

/** Walks up from any DOM node to find which tracked PDF page (if any) contains it. */
export function getPageInfoForNode(node: Node | null): PageInfo | null {
	let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
	while (el) {
		const info = pageInfoByDiv.get(el as HTMLDivElement);
		if (info) return info;
		el = el.parentElement;
	}
	return null;
}

/**
 * Runs `cb` for every page already rendered, then again every time pdf.js (re)renders
 * a page (it recycles page DOM on zoom/scroll, so this can fire more than once per page).
 * Stops when `owner` unloads.
 */
export function onPageReady(
	view: FileView,
	owner: Component,
	cb: (pageNumber: number, pageView: PDFPageView) => void
): void {
	const track = (pageNumber: number, pageView: PDFPageView) => {
		pageInfoByDiv.set(pageView.div, { pageNumber, pageView, view });
		cb(pageNumber, pageView);
	};

	const attach = (obsidianViewer: ObsidianViewer) => {
		const pdfViewer = obsidianViewer.pdfViewer;
		if (!pdfViewer) return;

		pdfViewer._pages?.forEach((pageView, i) => track(i + 1, pageView));

		const handler = (data: { source: PDFPageView; pageNumber: number }) => {
			track(data.pageNumber, data.source);
		};
		obsidianViewer.eventBus?.on("pagerendered", handler);
		owner.register(() => obsidianViewer.eventBus?.off("pagerendered", handler));
	};

	const component = getViewerComponent(view);
	if (!component) return;
	if (component.child?.pdfViewer) {
		attach(component.child.pdfViewer);
	} else {
		component.then((child) => attach(child.pdfViewer));
	}
}

/**
 * Like onPageReady, but fires when a page's *text layer* finishes rendering — needed
 * before text-selection geometry (DOM ranges over text spans) can be computed.
 */
export function onTextLayerReady(
	view: FileView,
	owner: Component,
	cb: (pageNumber: number, pageView: PDFPageView) => void
): void {
	const attach = (obsidianViewer: ObsidianViewer) => {
		const pdfViewer = obsidianViewer.pdfViewer;
		if (!pdfViewer) return;
		const handler = (data: { pageNumber: number }) => {
			const pageView = pdfViewer._pages?.[data.pageNumber - 1];
			if (pageView) cb(data.pageNumber, pageView);
		};
		obsidianViewer.eventBus?.on("textlayerrendered", handler);
		owner.register(() => obsidianViewer.eventBus?.off("textlayerrendered", handler));
	};

	const component = getViewerComponent(view);
	if (!component) return;
	if (component.child?.pdfViewer) {
		attach(component.child.pdfViewer);
	} else {
		component.then((child) => attach(child.pdfViewer));
	}
}

/** Gets (creating if needed) this plugin's overlay layer for a page, filling `pageView.div`. */
export function getOverlayLayer(pageView: PDFPageView): HTMLDivElement {
	let layer = pageView.div.querySelector<HTMLDivElement>(`:scope > .${OVERLAY_CLASS}`);
	if (!layer) {
		layer = pageView.div.createDiv(OVERLAY_CLASS);
		layer.setCssStyles({
			position: "absolute",
			inset: "0",
			pointerEvents: "none",
			overflow: "hidden",
		});
	}
	return layer;
}

/**
 * Positions `el` inside `layer` as a percentage of the page's own PDF-point box, so it
 * stays aligned across zoom/scroll without recomputing on scale change (percentages of
 * an element pdf.js itself already resizes). Technique adapted from PDF++
 * (RyotaUshio/obsidian-pdf-plus, MIT), src/lib/highlights/viewer.ts.
 */
export function placeRect(pageView: PDFPageView, layer: HTMLElement, rect: PdfRect, el: HTMLElement): void {
	const [pageX0, pageY0, pageX1, pageY1] = pageView.pdfPage.view;
	const pageWidth = pageX1 - pageX0;
	const pageHeight = pageY1 - pageY0;

	// Flip Y: PDF origin is bottom-left, CSS origin is top-left.
	const left = Math.min(rect[0], rect[2]);
	const right = Math.max(rect[0], rect[2]);
	const top = pageY1 - Math.max(rect[1], rect[3]);
	const bottom = pageY1 - Math.min(rect[1], rect[3]);

	el.setCssStyles({
		position: "absolute",
		left: `${(100 * (left - pageX0)) / pageWidth}%`,
		top: `${(100 * (top - (pageY1 - pageHeight))) / pageHeight}%`,
		width: `${(100 * (right - left)) / pageWidth}%`,
		height: `${(100 * (bottom - top)) / pageHeight}%`,
	});
	layer.appendChild(el);
}

/** Converts a client-space (viewport pixel) point to PDF point space for `pageView`. */
export function screenToPdfPoint(pageView: PDFPageView, clientX: number, clientY: number): [number, number] {
	const box = pageView.div.getBoundingClientRect();
	return pageView.getPagePoint(clientX - box.left, clientY - box.top);
}
