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
	 * Reference width of the side rail, in PDF points (i.e. px at 100% pdf.js
	 * zoom — the same unit `anchor` rects use). A rail note is attached to the
	 * page like any other note, so its lane has to scale with zoom too, or the
	 * two would visibly drift apart; storing it in points instead of px is what
	 * makes that automatic. Drag a rail note's inner edge to change it.
	 */
	railWidth: number;
	/** Base font size in px at 100% zoom. Every note scales this with the page's zoom. */
	fontSize: number;
}

export const DEFAULT_PDF_ANNOTATION_SETTINGS: PdfAnnotationSettings = {
	dataPath: ".margin-notes-hz",
	freeColor: "#7d94ca",
	railColor: "#eed37c",
	opacity: 92,
	railWidth: 220,
	fontSize: 12,
};

interface StoredShape {
	pdfAnnotationSettings?: Partial<PdfAnnotationSettings> & {
		// pre-0.4 names
		marginWidth?: number;
		marginColor?: string;
		floatingColor?: string;
		marginOpacity?: number;
	};
}

export async function loadPdfAnnotationSettings(plugin: { loadData(): Promise<unknown> }): Promise<PdfAnnotationSettings> {
	const data = (await plugin.loadData()) as StoredShape | null;
	const raw = data?.pdfAnnotationSettings ?? {};
	return {
		...DEFAULT_PDF_ANNOTATION_SETTINGS,
		...raw,
		// Carry pre-0.4 keys over rather than silently resetting the user's choices.
		railWidth: raw.railWidth ?? raw.marginWidth ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railWidth,
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
