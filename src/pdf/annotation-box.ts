import { MarkdownRenderer, loadMathJax, setIcon, type App, type Component } from "obsidian";

const EDITING_CLASS = "is-editing";

export interface ToolbarAction {
	/** Lucide icon name (preferred). */
	icon?: string;
	/** Fallback glyph when no icon is given. */
	label?: string;
	/** Native tooltip. */
	title: string;
	cls?: string;
	onClick: (ev: MouseEvent) => void;
}

export interface AnnotationBoxOptions {
	app: App;
	/** Owns the child components MarkdownRenderer attaches; unload it to release them. */
	component: Component;
	/** Path used to resolve wikilinks/embeds written inside the annotation. */
	sourcePath: string;
	initialText: string;
	placeholder?: string;
	onCommit: (text: string) => void;
	actions?: ToolbarAction[];
}

export interface AnnotationBoxHandle {
	el: HTMLDivElement;
	bodyEl: HTMLDivElement;
	/** Exposed so callers can prepend their own controls (e.g. a drag grip). */
	toolbarEl: HTMLDivElement;
	enterEdit(): void;
	render(): Promise<void>;
}

/**
 * Builds one annotation box — the shared shell behind BOTH the floating popover
 * and the side-margin box, so the two look and behave identically (same toolbar
 * placement, same edit interaction).
 *
 * Display state renders the annotation's Markdown through Obsidian's own
 * pipeline (LaTeX/MathJax, wikilinks, bold, …), exactly like the footnote
 * sidenote in src/margin-view-plugin.ts. Clicking the body swaps it for the
 * plain source in a contentEditable; blur/Enter commits, Escape reverts.
 * Clicking a link inside the rendered output follows the link instead of
 * entering edit mode.
 */
export function buildAnnotationBox(parent: HTMLElement, extraClass: string, opts: AnnotationBoxOptions): AnnotationBoxHandle {
	const el = parent.createDiv(`margin-notes-pdf-box ${extraClass}`);
	el.dataset.source = opts.initialText;

	// Toolbar sits INSIDE the box's top-right corner (not as a negative-offset
	// badge hanging off the edge, which read as clipped/misplaced) and is
	// revealed on hover.
	const toolbar = el.createDiv("margin-notes-pdf-toolbar");
	for (const action of opts.actions ?? []) {
		const btn = toolbar.createDiv({ cls: `margin-notes-pdf-action ${action.cls ?? ""}` });
		if (action.icon) setIcon(btn, action.icon);
		else btn.setText(action.label ?? "");
		btn.setAttribute("aria-label", action.title);
		btn.addEventListener("mousedown", (e) => e.stopPropagation());
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			action.onClick(e);
		});
	}

	const bodyEl = el.createDiv("margin-notes-pdf-body");
	bodyEl.dataset.placeholder = opts.placeholder ?? "写点什么…";
	bodyEl.spellcheck = false;

	const render = async (): Promise<void> => {
		bodyEl.empty();
		const source = el.dataset.source ?? "";
		if (!source) return; // placeholder shows via :empty::before
		if (source.includes("$")) await loadMathJax();
		await MarkdownRenderer.render(opts.app, source, bodyEl, opts.sourcePath, opts.component);

		// Wikilinks render as <a class="internal-link">; Obsidian only wires its own
		// click handling inside its own views, so resolve them by hand here.
		bodyEl.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			a.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const target = a.dataset.href ?? a.getAttribute("href") ?? "";
				if (target) void opts.app.workspace.openLinkText(target, opts.sourcePath, e.ctrlKey || e.metaKey);
			});
		});
	};

	const enterEdit = (): void => {
		el.addClass(EDITING_CLASS);
		bodyEl.empty();
		bodyEl.contentEditable = "true";
		bodyEl.setText(el.dataset.source ?? "");
		bodyEl.focus();
		const sel = window.getSelection();
		if (sel) {
			sel.selectAllChildren(bodyEl);
			sel.collapseToEnd();
		}
	};

	const commit = (): void => {
		// contentEditable innerText: \n for line breaks, NBSP for some spaces — the
		// NBSP must be an explicit \u00a0 escape, never a literal character (see
		// HANDOFF.md "已经踩过的坑": a literal one silently fails to round-trip).
		const newText = bodyEl.innerText.replace(/\u00a0/g, " ").replace(/\n+$/, "").trimEnd();
		bodyEl.contentEditable = "false";
		el.removeClass(EDITING_CLASS);
		const changed = newText !== el.dataset.source;
		el.dataset.source = newText;
		void render();
		if (changed) opts.onCommit(newText);
	};

	el.addEventListener("mousedown", (e) => e.stopPropagation());
	bodyEl.addEventListener("click", (e) => {
		if (el.hasClass(EDITING_CLASS)) return;
		// A click on rendered link text means "follow it", not "start editing".
		if ((e.target as HTMLElement).closest("a")) return;
		enterEdit();
	});
	bodyEl.addEventListener("blur", () => {
		if (el.hasClass(EDITING_CLASS)) commit();
	});
	bodyEl.addEventListener("keydown", (e) => {
		if (!el.hasClass(EDITING_CLASS)) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			bodyEl.blur(); // triggers commit()
		} else if (e.key === "Escape") {
			e.preventDefault();
			bodyEl.setText(el.dataset.source ?? "");
			bodyEl.blur(); // text now equals source → commit() sees no change
		}
	});

	return { el, bodyEl, toolbarEl: toolbar, enterEdit, render };
}
