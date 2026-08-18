import { FuzzySuggestModal, type App } from "obsidian";
import { HIGHLIGHT_MODE_LABELS, type HighlightMode } from "./annotation-settings";

/**
 * Mode picker in Obsidian's own suggester style — the same list-with-search
 * shape as the command palette, rather than a bare Menu floating at the edge of
 * the pane. Matches what every other "pick one of these" surface in the app
 * looks like, and is reachable from the keyboard.
 */
export class HighlightModePicker extends FuzzySuggestModal<HighlightMode> {
	constructor(
		app: App,
		private current: HighlightMode,
		private onPick: (mode: HighlightMode) => void
	) {
		super(app);
		this.setPlaceholder("选择高亮显示方式");
	}

	getItems(): HighlightMode[] {
		return Object.keys(HIGHLIGHT_MODE_LABELS) as HighlightMode[];
	}

	getItemText(mode: HighlightMode): string {
		// The tick is part of the searchable text on purpose: it costs nothing and
		// the current mode stays obvious even after the list is filtered.
		return `${mode === this.current ? "✓ " : ""}${HIGHLIGHT_MODE_LABELS[mode]}`;
	}

	onChooseItem(mode: HighlightMode): void {
		this.onPick(mode);
	}
}
