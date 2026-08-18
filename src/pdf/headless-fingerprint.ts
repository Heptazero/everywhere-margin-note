import type { App, TFile } from "obsidian";
import type { PdfFingerprint } from "./counterpart";

/**
 * Fingerprints a PDF WITHOUT opening it in any view — no tab, no visible
 * flicker, no waiting for the user to click into it. Loads a standalone pdf.js
 * document off `window.pdfjsLib`, the same global everything-bilink's
 * render-image.ts already relies on for headless page rendering (that's a
 * proven pattern in this vault, not a fresh guess).
 *
 * `window.pdfjsLib` is populated lazily — only once Obsidian's own PDF viewer
 * has loaded at least one PDF in the current session. In practice this is a
 * non-issue for what this is used for (auto-pairing): it only runs *after* the
 * user has already opened one PDF, which is exactly what makes the global
 * available. Returns null rather than throwing when it isn't (e.g. called
 * before any PDF has ever been opened this session) — the caller's fallback is
 * "pairing waits until both sides are opened normally," not a crash.
 */
export async function headlessFingerprint(app: App, file: TFile): Promise<PdfFingerprint | null> {
	const pdfjsLib = (window as unknown as { pdfjsLib?: PdfjsLibLike }).pdfjsLib;
	if (!pdfjsLib) return null;

	let doc: PdfjsDocumentLike | null = null;
	try {
		const buffer = await app.vault.readBinary(file);
		doc = await pdfjsLib.getDocument({ data: buffer }).promise;

		const page1 = await doc.getPage(1);
		const [x0, y0, x1, y1] = page1.view;

		// Same 3-page CJK sample as the live-viewer path (ScriptSampler), just
		// pulled from pdf.js's own getTextContent() instead of rendered DOM spans
		// — no text layer needs to exist for this, headless or not.
		let cjk = 0;
		let latin = 0;
		for (let n = 1; n <= Math.min(3, doc.numPages); n++) {
			const page = n === 1 ? page1 : await doc.getPage(n);
			const content = await page.getTextContent();
			for (const item of content.items) {
				const str = "str" in item ? (item.str ?? "") : "";
				for (const ch of str) {
					if (ch >= "一" && ch <= "鿿") cjk++;
					else if (/[a-zA-Z]/.test(ch)) latin++;
				}
			}
		}

		return {
			pages: doc.numPages,
			width: Math.round(x1 - x0),
			height: Math.round(y1 - y0),
			cjk: cjk / Math.max(1, cjk + latin),
		};
	} catch (e) {
		console.warn(`margin-notes-hz: headless fingerprint failed for ${file.path}`, e);
		return null;
	} finally {
		void doc?.destroy();
	}
}

// Minimal shape of the pdf.js API surface actually used above — window.pdfjsLib
// itself is untyped (it's a global Obsidian happens to expose, not a declared
// dependency), so this is deliberately narrow rather than pulling in pdf.js's
// own (much larger) type package for three method calls.
interface PdfjsLibLike {
	getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfjsDocumentLike> };
}
interface PdfjsDocumentLike {
	numPages: number;
	getPage(n: number): Promise<{
		view: [number, number, number, number];
		getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
	}>;
	destroy(): void;
}
