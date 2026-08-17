import { debounce, normalizePath, type App, type Plugin } from "obsidian";
import { normalizeAnnotation, type PdfAnnotation } from "./annotation-types";

interface FileShape {
	version: 2;
	pdfAnnotations: Record<string, PdfAnnotation[]>;
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
export class PdfAnnotationStore {
	private data: Record<string, PdfAnnotation[]> = {};
	private path = "";
	private listeners = new Set<StoreListener>();
	private save = debounce(() => void this.flush(), 500, true);

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

	private adopt(raw: Record<string, unknown[]>): void {
		this.data = {};
		for (const [key, list] of Object.entries(raw ?? {})) {
			this.data[key] = (list ?? []).map((a) => normalizeAnnotation(a as never));
		}
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
			this.adopt((parsed?.pdfAnnotations ?? {}) as Record<string, unknown[]>);
			return;
		}

		// Older locations, newest first: the default folder used before the path
		// became configurable, then the plugin's own data.json (v0.2.0).
		const legacyFile = ".margin-notes-hz/annotations.json";
		if (legacyFile !== this.path && (await adapter.exists(legacyFile))) {
			try {
				const parsed = JSON.parse(await adapter.read(legacyFile)) as Partial<FileShape>;
				this.adopt((parsed?.pdfAnnotations ?? {}) as Record<string, unknown[]>);
				await this.flush();
				return;
			} catch {
				/* fall through to the plugin-data check */
			}
		}

		const legacy = (await this.plugin.loadData()) as { pdfAnnotations?: Record<string, unknown[]> } | null;
		if (legacy?.pdfAnnotations && Object.keys(legacy.pdfAnnotations).length > 0) {
			this.adopt(legacy.pdfAnnotations);
			await this.flush();
		} else {
			this.data = {};
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
		const payload: FileShape = { version: 2, pdfAnnotations: this.data };
		await adapter.write(this.path, JSON.stringify(payload, null, 2));
	}

	private key(pdfPath: string): string {
		return normalizePath(pdfPath);
	}

	forPage(pdfPath: string, page: number): PdfAnnotation[] {
		return (this.data[this.key(pdfPath)] ?? []).filter((a) => a.page === page);
	}

	forFile(pdfPath: string): PdfAnnotation[] {
		return this.data[this.key(pdfPath)] ?? [];
	}

	upsert(pdfPath: string, ann: PdfAnnotation): void {
		const key = this.key(pdfPath);
		const list = (this.data[key] ??= []);
		const idx = list.findIndex((a) => a.id === ann.id);
		if (idx >= 0) list[idx] = ann;
		else list.push(ann);
		this.save();
		this.notify();
	}

	remove(pdfPath: string, id: string): void {
		const key = this.key(pdfPath);
		const list = this.data[key];
		if (!list) return;
		this.data[key] = list.filter((a) => a.id !== id);
		this.save();
		this.notify();
	}

	/**
	 * Keeps annotations attached to their file when it's renamed/moved — plain
	 * path-string keys would otherwise orphan them silently.
	 */
	renameFile(oldPath: string, newPath: string): void {
		const oldKey = this.key(oldPath);
		const newKey = this.key(newPath);
		if (oldKey === newKey || !(oldKey in this.data)) return;
		this.data[newKey] = [...(this.data[newKey] ?? []), ...this.data[oldKey]];
		delete this.data[oldKey];
		this.save();
		this.notify();
	}
}
