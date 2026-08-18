import { debounce, normalizePath, type App, type Plugin } from "obsidian";
import { normalizeAnnotation, type PdfAnnotation } from "./annotation-types";
import type { PdfFingerprint } from "./counterpart";

interface FileShape {
	version: 3;
	/**
	 * Annotations, keyed by GROUP rather than by path — a paper and its
	 * layout-preserving translation resolve to the same key, so annotating
	 * either side is literally the same data rather than two copies kept in
	 * sync. See `pairs`.
	 */
	pdfAnnotations: Record<string, PdfAnnotation[]>;
	/** member path → group key (the source-language side of the pair). */
	pairs: Record<string, string>;
	/** Cached per-file geometry/script, gathered from viewers as files are opened. */
	fingerprints: Record<string, PdfFingerprint>;
}

const FILE_NAME = "annotations.json";

/**
 * Resolves the user's configured path to an actual file path. A value ending in
 * `.json` is used as-is; anything else is treated as a folder to put the file
 * in — writing a literal extension-less file is never what someone typing
 * `99_assets/plugin-data/margin-note` means.
 */
export function resolveDataFilePath(configured: string): string {
	const p = normalizePath(configured.trim().replace(/\/+$/, ""));
	return p.toLowerCase().endsWith(".json") ? p : `${p}/${FILE_NAME}`;
}

export type StoreListener = () => void;

/**
 * Owns the persisted PDF annotations, stored as one plain JSON file inside the
 * vault so it travels with whatever already syncs the notes.
 *
 * Written through `vault.adapter` rather than the `TFile` API because a
 * dot-prefixed folder isn't part of Obsidian's indexed file tree.
 */
/** Enough to cover a working session's worth of edits without holding a vault's
 * annotation history in memory forever. */
const MAX_HISTORY = 100;

export class PdfAnnotationStore {
	private data: Record<string, PdfAnnotation[]> = {};
	private pairs: Record<string, string> = {};
	private fingerprints: Record<string, PdfFingerprint> = {};
	private path = "";
	private listeners = new Set<StoreListener>();
	private save = debounce(() => void this.flush(), 500, true);
	/**
	 * Undo history of whole-annotation-map snapshots.
	 *
	 * Snapshots rather than inverse operations: the mutations here are few and
	 * the data is small (a vault's worth of annotations is kilobytes), so the
	 * simplest thing that cannot get out of step with the live data is to keep
	 * copies. An operation log would need an exact inverse for every future
	 * mutation, and one missing inverse corrupts everything after it.
	 *
	 * `pairs`/`fingerprints` are deliberately NOT covered: they describe which
	 * files belong together, not the user's writing, and silently un-pairing two
	 * documents because someone pressed Cmd+Z after deleting a note would be a
	 * surprise rather than an undo.
	 */
	private undoStack: Record<string, PdfAnnotation[]>[] = [];
	private redoStack: Record<string, PdfAnnotation[]>[] = [];

	constructor(
		private app: App,
		private plugin: Plugin
	) {}

	get filePath(): string {
		return this.path;
	}

	onChange(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const l of this.listeners) l();
	}

	private snapshot(): Record<string, PdfAnnotation[]> {
		const copy: Record<string, PdfAnnotation[]> = {};
		for (const [k, list] of Object.entries(this.data)) copy[k] = list.map((a) => ({ ...a }));
		return copy;
	}

	/** Call immediately BEFORE mutating `data`. Any new edit invalidates redo. */
	private pushHistory(): void {
		this.undoStack.push(this.snapshot());
		if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
		this.redoStack.length = 0;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): boolean {
		const prev = this.undoStack.pop();
		if (!prev) return false;
		this.redoStack.push(this.snapshot());
		this.data = prev;
		this.save();
		this.notify();
		return true;
	}

	redo(): boolean {
		const next = this.redoStack.pop();
		if (!next) return false;
		this.undoStack.push(this.snapshot());
		this.data = next;
		this.save();
		this.notify();
		return true;
	}

	private adopt(parsed: Partial<FileShape>): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.data = {};
		for (const [key, list] of Object.entries(parsed?.pdfAnnotations ?? {})) {
			this.data[key] = ((list ?? []) as unknown[]).map((a) => normalizeAnnotation(a as never));
		}
		// Absent in v1/v2 files — an unpaired library is just an empty map.
		this.pairs = parsed?.pairs ?? {};
		this.fingerprints = parsed?.fingerprints ?? {};
	}

	/** Loads from `configuredPath`, migrating anything left at older locations. */
	async load(configuredPath: string): Promise<void> {
		this.path = resolveDataFilePath(configuredPath);
		const adapter = this.app.vault.adapter;

		if (await adapter.exists(this.path)) {
			let parsed: Partial<FileShape>;
			try {
				parsed = JSON.parse(await adapter.read(this.path)) as Partial<FileShape>;
			} catch {
				// A corrupt/hand-edited file must not silently wipe itself on the next
				// save — refuse to load rather than starting from an empty object.
				throw new Error(`margin-notes-hz: 批注文件解析失败,请检查 ${this.path}`);
			}
			this.adopt(parsed);
			return;
		}

		// Older locations, newest first: the default folder used before the path
		// became configurable, then the plugin's own data.json (v0.2.0).
		const legacyFile = ".margin-notes-hz/annotations.json";
		if (legacyFile !== this.path && (await adapter.exists(legacyFile))) {
			try {
				const parsed = JSON.parse(await adapter.read(legacyFile)) as Partial<FileShape>;
				this.adopt(parsed);
				await this.flush();
				return;
			} catch {
				/* fall through to the plugin-data check */
			}
		}

		const legacy = (await this.plugin.loadData()) as { pdfAnnotations?: Record<string, unknown[]> } | null;
		if (legacy?.pdfAnnotations && Object.keys(legacy.pdfAnnotations).length > 0) {
			this.adopt(legacy as Partial<FileShape>);
			await this.flush();
		} else {
			this.adopt({});
		}
	}

	/** Moves the backing file when the configured path changes. */
	async relocate(configuredPath: string): Promise<void> {
		const next = resolveDataFilePath(configuredPath);
		if (next === this.path) return;
		const oldPath = this.path;
		this.path = next;
		await this.flush();
		const adapter = this.app.vault.adapter;
		if (oldPath && (await adapter.exists(oldPath))) await adapter.remove(oldPath);
	}

	private async flush(): Promise<void> {
		if (!this.path) return;
		const adapter = this.app.vault.adapter;
		const dir = this.path.includes("/") ? this.path.slice(0, this.path.lastIndexOf("/")) : "";
		if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
		const payload: FileShape = {
			version: 3,
			pdfAnnotations: this.data,
			pairs: this.pairs,
			fingerprints: this.fingerprints,
		};
		await adapter.write(this.path, JSON.stringify(payload, null, 2));
	}

	/** Resolves a path to the bucket it shares with its counterpart, if paired. */
	private key(pdfPath: string): string {
		const p = normalizePath(pdfPath);
		return this.pairs[p] ?? p;
	}

	getFingerprint(pdfPath: string): PdfFingerprint | undefined {
		return this.fingerprints[normalizePath(pdfPath)];
	}

	setFingerprint(pdfPath: string, fp: PdfFingerprint): void {
		const p = normalizePath(pdfPath);
		const prev = this.fingerprints[p];
		// Compare every field, `cjk` included: it is refined as further pages are
		// sampled, and skipping the write on unchanged geometry alone would pin
		// the ratio to whatever the first page happened to show.
		if (prev && prev.pages === fp.pages && prev.width === fp.width && prev.height === fp.height && prev.cjk === fp.cjk) {
			return;
		}
		this.fingerprints[p] = fp;
		this.save();
	}

	/** The other member of `pdfPath`'s pair, if one has been established. */
	counterpartOf(pdfPath: string): string | null {
		const p = normalizePath(pdfPath);
		const group = this.pairs[p];
		if (!group) return null;
		const other = Object.keys(this.pairs).find((k) => this.pairs[k] === group && k !== p);
		return other ?? (group === p ? null : group);
	}

	isPaired(pdfPath: string): boolean {
		return normalizePath(pdfPath) in this.pairs;
	}

	/**
	 * Links two files onto one bucket, merging whatever either already had.
	 * `canonical` must be one of the two; it names the shared bucket.
	 */
	pair(a: string, b: string, canonical: string): void {
		const pa = normalizePath(a);
		const pb = normalizePath(b);
		const key = normalizePath(canonical);
		if (this.pairs[pa] === key && this.pairs[pb] === key) return;

		const merged = [...(this.data[pa] ?? []), ...(this.data[pb] ?? []), ...(this.data[key] ?? [])];
		const seen = new Set<string>();
		const deduped = merged.filter((ann) => !seen.has(ann.id) && seen.add(ann.id));

		if (pa !== key) delete this.data[pa];
		if (pb !== key) delete this.data[pb];
		if (deduped.length > 0) this.data[key] = deduped;

		this.pairs[pa] = key;
		this.pairs[pb] = key;
		this.save();
		this.notify();
	}

	unpair(pdfPath: string): void {
		const p = normalizePath(pdfPath);
		const group = this.pairs[p];
		if (!group) return;
		for (const k of Object.keys(this.pairs)) if (this.pairs[k] === group) delete this.pairs[k];
		this.save();
		this.notify();
	}

	/**
	 * Readers get COPIES, never the stored objects.
	 *
	 * Callers edit an annotation in place and then hand it back to `upsert`
	 * (see the layer's `mutate`). If that were the same object the store holds,
	 * the edit would already be applied to the store's own state by the time
	 * `upsert` ran — so the "before" snapshot taken there would capture the
	 * edited value, and undoing a text/colour/position change would silently do
	 * nothing (only add and delete would ever work). Copying on the way out is
	 * what makes the stored state genuinely the previous one.
	 */
	forPage(pdfPath: string, page: number): PdfAnnotation[] {
		return (this.data[this.key(pdfPath)] ?? []).filter((a) => a.page === page).map((a) => ({ ...a }));
	}

	forFile(pdfPath: string): PdfAnnotation[] {
		return (this.data[this.key(pdfPath)] ?? []).map((a) => ({ ...a }));
	}

	/**
	 * `recordHistory: false` for writes the user did not perform — currently the
	 * automatic quote→anchor resolution, which would otherwise fill the undo
	 * stack with entries that undo something nobody did.
	 */
	upsert(pdfPath: string, ann: PdfAnnotation, recordHistory = true): void {
		if (recordHistory) this.pushHistory();
		const key = this.key(pdfPath);
		const list = (this.data[key] ??= []);
		const stored = { ...ann };
		const idx = list.findIndex((a) => a.id === ann.id);
		if (idx >= 0) list[idx] = stored;
		else list.push(stored);
		this.save();
		this.notify();
	}

	remove(pdfPath: string, id: string): void {
		const key = this.key(pdfPath);
		const list = this.data[key];
		if (!list) return;
		this.pushHistory();
		this.data[key] = list.filter((a) => a.id !== id);
		this.save();
		this.notify();
	}

	/**
	 * Keeps annotations attached to their file when it's renamed/moved — plain
	 * path-string keys would otherwise orphan them silently.
	 */
	renameFile(oldPath: string, newPath: string): void {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (from === to) return;
		let touched = false;

		if (this.fingerprints[from]) {
			this.fingerprints[to] = this.fingerprints[from];
			delete this.fingerprints[from];
			touched = true;
		}

		// Pairing survives a rename on either side: re-key the membership, and if
		// the renamed file was the group's canonical name, re-point every member.
		if (this.pairs[from]) {
			const group = this.pairs[from];
			this.pairs[to] = group === from ? to : group;
			delete this.pairs[from];
			touched = true;
		}
		for (const k of Object.keys(this.pairs)) {
			if (this.pairs[k] === from) {
				this.pairs[k] = to;
				touched = true;
			}
		}

		if (this.data[from]) {
			this.data[to] = [...(this.data[to] ?? []), ...this.data[from]];
			delete this.data[from];
			touched = true;
		}

		if (!touched) return;
		this.save();
		this.notify();
	}
}
