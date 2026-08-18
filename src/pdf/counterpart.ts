import { TFile, type App } from "obsidian";

/**
 * Pairing a paper with its layout-preserving translation, so both share one set
 * of annotations and you can flip between them at the same spot.
 *
 * Measured on this vault's own corpus (86 PDFs) before settling on these rules:
 * name matching alone produced 24 candidate pairs of which only 2 were real —
 * the rest were same-named figure PDFs in sibling folders (`hopfield_pooling.pdf`
 * ×3), `foo` vs `foo_adapted` variants, and two English copies of one paper.
 * Adding the geometry and script checks rejected all 22 and kept both real ones.
 */

/** Everything about a PDF needed to judge a pairing. All of it is available for
 * free from an open viewer — nothing here requires loading a second document. */
export interface PdfFingerprint {
	pages: number;
	/** Page-box width/height in PDF points, rounded. */
	width: number;
	height: number;
	/** Share of CJK among letter-ish characters, 0–1, sampled from a few pages. */
	cjk: number;
}

/**
 * Language test, expressed as a GAP between the two sides rather than an
 * absolute threshold — because the number measured from a live pdf.js text
 * layer is not trustworthy in absolute terms. Observed in this vault: a paper
 * that PyMuPDF reports as 0.000 CJK measured 0.20 through the text layer
 * (LaTeX math fonts with broken ToUnicode maps emit glyphs that land in the
 * CJK block). An absolute 0.25 cutoff was therefore nearly tripping on pure
 * English. A real translation sits around 0.9, so requiring a wide separation
 * survives that noise while still rejecting two copies of the same-language
 * document, which score near-identically whatever the absolute value is.
 */
const CJK_MIN_GAP = 0.4;
const CJK_TRANSLATED_MIN = 0.5;
/** Below this the two names are too short/too dissimilar to trust. */
const MIN_CORE_LEN = 12;
const MIN_NAME_RATIO = 0.6;

/**
 * Strips everything that decorates a filename — `cn-` prefixes, `-onlyTrans`
 * suffixes, separators, case — leaving a comparable core. Deliberately does NOT
 * work from a list of known affixes: the user's affixes vary, but the paper's
 * name itself is always present, so containment of the cores is the real test.
 */
export function normalizeName(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
	return base.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

/** True when one core name contains the other and they're close enough in length. */
export function namesLookRelated(a: string, b: string): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	if (!na || !nb || na === nb) return na === nb && na.length >= MIN_CORE_LEN;
	const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
	return short.length >= MIN_CORE_LEN && long.includes(short) && short.length / long.length >= MIN_NAME_RATIO;
}

/**
 * The decisive test, applied once both sides' fingerprints are known: identical
 * page geometry (so annotation coordinates carry over at all) plus exactly one
 * side written in CJK (so it's a translation, not a duplicate or a variant).
 */
export function fingerprintsPair(a: PdfFingerprint, b: PdfFingerprint): boolean {
	return sameGeometry(a, b) && differentLanguage(a, b);
}

export function sameGeometry(a: PdfFingerprint, b: PdfFingerprint): boolean {
	return a.pages === b.pages && a.width === b.width && a.height === b.height;
}

export function differentLanguage(a: PdfFingerprint, b: PdfFingerprint): boolean {
	return Math.abs(a.cjk - b.cjk) >= CJK_MIN_GAP && Math.max(a.cjk, b.cjk) >= CJK_TRANSLATED_MIN;
}

/** Vault PDFs whose name looks related to `path` (excluding itself). */
export function findNameCandidates(app: App, path: string): string[] {
	return app.vault
		.getFiles()
		.filter((f) => f.extension === "pdf" && f.path !== path && namesLookRelated(path, f.path))
		.map((f) => f.path);
}

/** Of a confirmed pair, the source (non-CJK) side — used as the shared bucket key
 * so the group name stays meaningful no matter which side you annotate from. */
export function canonicalOf(a: string, aFp: PdfFingerprint, b: string, bFp: PdfFingerprint): string {
	return aFp.cjk > bFp.cjk ? b : a;
}

/** Accumulates the CJK ratio across sampled pages of a live document. */
export class ScriptSampler {
	private cjk = 0;
	private latin = 0;
	private pagesSeen = new Set<number>();

	/**
	 * More pages would be a better sample, but pdf.js only renders what's in the
	 * viewport — waiting for three meant a document you opened and didn't scroll
	 * was never fingerprinted at all, which is why nothing ever paired. The
	 * fingerprint is therefore written from the first page and refined as more
	 * arrive; `done` only stops the sampling, it doesn't gate the write.
	 */
	get done(): boolean {
		return this.pagesSeen.size >= 3;
	}

	add(pageNumber: number, strings: string[]): void {
		if (this.pagesSeen.has(pageNumber) || this.done) return;
		this.pagesSeen.add(pageNumber);
		for (const s of strings) {
			for (const ch of s) {
				if (ch >= "一" && ch <= "鿿") this.cjk++;
				else if (/[a-zA-Z]/.test(ch)) this.latin++;
			}
		}
	}

	get ratio(): number {
		return this.cjk / Math.max(1, this.cjk + this.latin);
	}

	get hasSample(): boolean {
		return this.pagesSeen.size > 0 && this.cjk + this.latin > 0;
	}
}

export function isPdf(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "pdf";
}
