import { type Editor, Notice, Plugin } from "obsidian";
import { createMarginNotesExtension } from "./margin-view-plugin";
import { scanFootnotes } from "./footnote-scan";

export default class MarginNotesPlugin extends Plugin {
	async onload() {
		this.registerEditorExtension(createMarginNotesExtension(this.app));

		this.addCommand({
			id: "clean-orphan-footnotes",
			name: "清理无引用的脚注定义 (Clean orphan footnote definitions)",
			editorCallback: (editor) => this.cleanOrphans(editor),
		});
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
