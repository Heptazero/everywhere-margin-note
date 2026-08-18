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
}

export function clearPdfAnnotationStyleSettings(): void {
	const body = document.body;
	body.style.removeProperty("--margin-notes-pdf-free-color");
	body.style.removeProperty("--margin-notes-pdf-rail-color");
	body.style.removeProperty("--margin-notes-pdf-opacity");
}
