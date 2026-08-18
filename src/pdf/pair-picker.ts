import { FuzzySuggestModal, type App } from "obsidian";

/**
 * Picker for "link this PDF with that one". Offered pre-filtered to
 * name-similar files when there are any, so the intended counterpart is
 * normally the first row.
 */
export class PairPickerModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private candidates: string[],
		private onPick: (path: string) => void
	) {
		super(app);
		this.setPlaceholder("选择要共用批注的另一份 PDF(原文 ↔ 译文)");
	}

	getItems(): string[] {
		return this.candidates;
	}

	getItemText(path: string): string {
		return path;
	}

	onChooseItem(path: string): void {
		this.onPick(path);
	}
}
