export interface PdfAnnotationSettings {
	/**
	 * Where the annotations JSON lives, vault-relative. A path with no `.json`
	 * suffix is treated as a FOLDER and the file goes inside it — that's what a
	 * bare name like `99_assets/plugin-data/margin-note` obviously means, and
	 * silently writing a file with that exact name instead left annotations
	 * stranded at the old location.
	 *
	 * Inside the vault (not the plugin folder) so it travels with git /
	 * Obsidian Sync / iCloud — this vault's .gitignore excludes
	 * `/.obsidian/plugins/` wholesale.
	 */
	dataPath: string;
	/** Dot + border colour for free notes. */
	freeColor: string;
	/** Dot + border colour for rail notes. */
	railColor: string;
	/** 0-100. */
	opacity: number;
	/**
	 * Reference width of a side rail, in PDF points (i.e. px at 100% pdf.js
	 * zoom — the same unit `anchor` rects use). A rail note is attached to the
	 * page like any other note, so its lane has to scale with zoom too, or the
	 * two would visibly drift apart; storing it in points instead of px is what
	 * makes that automatic. Left and right are independent settings — they used
	 * to be one shared value, which meant resizing the left rail silently moved
	 * the right one too. Drag a rail note's outer edge to change it.
	 */
	railWidthLeft: number;
	railWidthRight: number;
	/**
	 * Distance from the page's edge to a rail's inner edge, in PDF points.
	 * May be negative, which parks the rail over the page instead of beside it.
	 * Independent per side, same reasoning as `railWidthLeft`/`railWidthRight`.
	 * Drag a rail note's page-facing edge to change it.
	 */
	railGapLeft: number;
	railGapRight: number;
	/** Base font size in px at 100% zoom. Every note scales this with the page's zoom. */
	fontSize: number;
	/** How the link between a note and the text it refers to is shown. */
	highlightMode: HighlightMode;
	/** 0-100, applied to the highlight band only (notes have their own `opacity`). */
	highlightOpacity: number;
	/**
	 * Preset colours offered when recolouring a note. Replaces the OS colour
	 * panel: that panel opens next to the invisible input that triggered it,
	 * which never reliably lands near the note, and picking a free-form colour
	 * every time produces a set of highlights that don't read as a system. A
	 * short fixed palette is faster to use and keeps a document's annotations
	 * visually coherent.
	 */
	palette: string[];
}

/**
 * What is drawn without any pointer involved. The REVERSE direction (pointing
 * at the text lights up its note) is not a mode of its own — it is on for
 * everything except `note`, because a highlight you cannot trace back to its
 * note is only half a link: seeing a band on the page and having no idea which
 * note it belongs to is exactly as useless as the note-only direction was.
 */
export type HighlightMode = "note" | "both" | "always" | "line";

export const HIGHLIGHT_MODE_LABELS: Record<HighlightMode, string> = {
	note: "单向 —— 只有悬浮批注时才高亮原文",
	both: "双向 —— 悬浮批注或悬浮原文,两边互相点亮",
	line: "箭头 —— 细线一直指向原文,悬浮仍然互相点亮",
	always: "常亮 —— 所有高亮一直显示,悬浮仍然互相点亮",
};

/**
 * A darker shade of `hex`, used for the emphasis outline on a highlighted note.
 * Derived from the note's OWN colour rather than the theme accent, so the
 * outline says which note lit up instead of looking identical for all of them.
 * Computed here rather than with CSS `color-mix` so it does not depend on the
 * renderer's colour-function support.
 */
export function darken(hex: string, amount = 0.4): string {
	const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const f = Math.max(0, Math.min(1, 1 - amount));
	const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c * f));
	return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Accepts "#abc123, #def456" or whitespace/newline separated; drops junk. */
export function parsePalette(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter((t) => /^#[\da-f]{6}$/i.test(t));
}

/** True for every mode where pointing at the TEXT should light up its note. */
export function highlightsBothWays(mode: HighlightMode): boolean {
	return mode !== "note";
}

export const DEFAULT_PDF_ANNOTATION_SETTINGS: PdfAnnotationSettings = {
	dataPath: ".margin-notes-hz",
	freeColor: "#7d94ca",
	railColor: "#eed37c",
	opacity: 92,
	railWidthLeft: 220,
	railWidthRight: 220,
	railGapLeft: 10,
	railGapRight: 10,
	fontSize: 12,
	highlightMode: "note",
	highlightOpacity: 30,
	palette: ["#eed37c", "#7d94ca", "#8fbf8f", "#d98f8f", "#b998d4", "#7fbfc4", "#c9a37a", "#9aa0a6"],
};

interface StoredShape {
	pdfAnnotationSettings?: Partial<PdfAnnotationSettings> & {
		// pre-0.4 names
		marginWidth?: number;
		marginColor?: string;
		floatingColor?: string;
		marginOpacity?: number;
		// pre-0.10 names: one shared value for both rails
		railWidth?: number;
		railGap?: number;
	};
}

export async function loadPdfAnnotationSettings(plugin: { loadData(): Promise<unknown> }): Promise<PdfAnnotationSettings> {
	const data = (await plugin.loadData()) as StoredShape | null;
	const raw = data?.pdfAnnotationSettings ?? {};
	// A user coming from a single shared railWidth/railGap gets that same value
	// on both sides rather than snapping back to the default — the split itself
	// shouldn't visibly move anything on first load after the upgrade.
	const legacyWidth = raw.railWidth ?? raw.marginWidth;
	const legacyGap = raw.railGap;
	return {
		...DEFAULT_PDF_ANNOTATION_SETTINGS,
		...raw,
		railWidthLeft: raw.railWidthLeft ?? legacyWidth ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railWidthLeft,
		railWidthRight: raw.railWidthRight ?? legacyWidth ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railWidthRight,
		railGapLeft: raw.railGapLeft ?? legacyGap ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railGapLeft,
		railGapRight: raw.railGapRight ?? legacyGap ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railGapRight,
		railColor: raw.railColor ?? raw.marginColor ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railColor,
		freeColor: raw.freeColor ?? raw.floatingColor ?? DEFAULT_PDF_ANNOTATION_SETTINGS.freeColor,
		opacity: raw.opacity ?? raw.marginOpacity ?? DEFAULT_PDF_ANNOTATION_SETTINGS.opacity,
		// An empty palette would leave the picker with nothing to offer.
		palette: raw.palette && raw.palette.length > 0 ? raw.palette : DEFAULT_PDF_ANNOTATION_SETTINGS.palette,
	};
}

/**
 * Pushes settings onto `document.body` as CSS custom properties, which
 * styles.css keys off — a style change repaints instantly without touching any
 * already-rendered annotation DOM.
 */
export function applyPdfAnnotationStyleSettings(settings: PdfAnnotationSettings): void {
	const body = document.body;
	body.style.setProperty("--margin-notes-pdf-free-color", settings.freeColor);
	body.style.setProperty("--margin-notes-pdf-rail-color", settings.railColor);
	body.style.setProperty("--margin-notes-pdf-opacity", String(settings.opacity / 100));
	body.style.setProperty("--margin-notes-pdf-highlight-opacity", String(settings.highlightOpacity / 100));
}

export function clearPdfAnnotationStyleSettings(): void {
	const body = document.body;
	body.style.removeProperty("--margin-notes-pdf-free-color");
	body.style.removeProperty("--margin-notes-pdf-rail-color");
	body.style.removeProperty("--margin-notes-pdf-opacity");
	body.style.removeProperty("--margin-notes-pdf-highlight-opacity");
}
