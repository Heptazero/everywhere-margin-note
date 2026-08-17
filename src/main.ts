import { type Editor, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { createMarginNotesExtension } from "./margin-view-plugin";
import { scanFootnotes } from "./footnote-scan";
import { ANNOTATION_LIST_VIEW, AnnotationListView } from "./pdf/annotation-list-view";
import { PdfAnnotationSettingTab } from "./pdf/annotation-settings-tab";
import { PdfAnnotationsController, type NewNoteForm } from "./pdf/controller";

export default class MarginNotesPlugin extends Plugin {
	private pdfAnnotations!: PdfAnnotationsController;

	async onload() {
		this.registerEditorExtension(createMarginNotesExtension(this.app));

		this.addCommand({
			id: "clean-orphan-footnotes",
			name: "清理无引用的脚注定义 (Clean orphan footnote definitions)",
			editorCallback: (editor) => this.cleanOrphans(editor),
		});

		this.pdfAnnotations = new PdfAnnotationsController(this, this.app);
		await this.pdfAnnotations.onload();
		this.addSettingTab(new PdfAnnotationSettingTab(this.app, this, this.pdfAnnotations));

		// One note type, three entry points that differ only in its initial form —
		// every one of these can be switched to any other afterwards, from the
		// note's own toolbar or right-click menu.
		this.addPdfNoteCommand("pdf-add-note-right", "[PDF] 加批注:右侧轨道", { pinned: true, side: "right", collapsed: false });
		this.addPdfNoteCommand("pdf-add-note-left", "[PDF] 加批注:左侧轨道", { pinned: true, side: "left", collapsed: false });
		this.addPdfNoteCommand("pdf-add-note-free", "[PDF] 加批注:自由摆放(便利贴)", { pinned: false, side: "right", collapsed: false });

		this.registerView(ANNOTATION_LIST_VIEW, (leaf) => new AnnotationListView(leaf, this.pdfAnnotations));
		this.addCommand({
			id: "pdf-open-annotation-list",
			name: "[PDF] 打开批注列表面板",
			callback: () => void this.openAnnotationList(),
		});
		this.addRibbonIcon("message-square", "PDF 批注列表", () => void this.openAnnotationList());
	}

	private addPdfNoteCommand(id: string, name: string, form: NewNoteForm): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasActivePDFView();
				if (!checking && active) this.pdfAnnotations.addNote(form);
				return active;
			},
		});
	}

	/** Reveals the list panel in the right sidebar, reusing an existing one if open. */
	private async openAnnotationList(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(ANNOTATION_LIST_VIEW);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: ANNOTATION_LIST_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Deletes every `[^id]: ...` definition block whose id no longer has any
	 * `[^id]` reference in the body text.
	 */
	private cleanOrphans(editor: Editor): void {
		const text = editor.getValue();
		const { refs, defs } = scanFootnotes(text);
		const referenced = new Set(refs.map((r) => r.id));
		const orphans = defs.filter((d) => !referenced.has(d.id));

		if (orphans.length === 0) {
			new Notice("没有无引用的脚注定义");
			return;
		}

		// Delete bottom-up so earlier offsets stay valid across replacements.
		for (const def of [...orphans].reverse()) {
			let from = def.from;
			let to = def.to;
			if (text[to] === "\n") to++; // swallow the block's trailing newline
			else if (from > 0 && text[from - 1] === "\n") from--; // block at EOF: swallow leading one
			editor.replaceRange("", editor.offsetToPos(from), editor.offsetToPos(to));
		}

		new Notice(`已清理 ${orphans.length} 条无引用的脚注定义`);
	}
}
