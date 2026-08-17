import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { buildAnnotationBox } from "./annotation-box";
import type { PdfAnnotation } from "./annotation-types";
import type { PdfAnnotationsController } from "./controller";

export const ANNOTATION_LIST_VIEW = "margin-notes-hz-annotation-list";

/**
 * Side panel listing every annotation of the PDF currently in focus, grouped by
 * page (collapsible) and top-to-bottom within a page. Each row IS an annotation
 * box (the same shell used on the page itself) so it can be edited or deleted
 * right here, without needing the PDF open; a dedicated jump button navigates
 * to and highlights the note's source location.
 */
export class AnnotationListView extends ItemView {
	/** Which pages are collapsed — resets when the panel is closed, on purpose:
	 * this is view state, not data worth persisting to disk. */
	private collapsedPages = new Set<number>();

	constructor(
		leaf: WorkspaceLeaf,
		private controller: PdfAnnotationsController
	) {
		super(leaf);
	}

	getViewType(): string {
		return ANNOTATION_LIST_VIEW;
	}

	getDisplayText(): string {
		return "PDF 批注";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.register(this.controller.store.onChange(() => this.render()));
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				// Ignore the panel gaining focus — otherwise clicking into it would
				// re-render against "no active PDF" and wipe the list.
				if (leaf?.view === this) return;
				this.render();
			})
		);
		this.render();
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("margin-notes-pdf-list");

		const target = this.controller.currentPdfTarget();
		if (!target) {
			container.createDiv({ cls: "margin-notes-pdf-list-empty", text: "当前没有打开的 PDF" });
			return;
		}

		container.createDiv({ cls: "margin-notes-pdf-list-title", text: target.basename });

		const anns = this.controller.store.forFile(target.path);
		if (anns.length === 0) {
			container.createDiv({ cls: "margin-notes-pdf-list-empty", text: "这份 PDF 还没有批注" });
			return;
		}

		const byPage = new Map<number, PdfAnnotation[]>();
		for (const ann of anns) {
			(byPage.get(ann.page) ?? byPage.set(ann.page, []).get(ann.page)!).push(ann);
		}
		for (const list of byPage.values()) {
			list.sort((a, b) => Math.max(b.anchor[1], b.anchor[3]) - Math.max(a.anchor[1], a.anchor[3]));
		}

		for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
			this.renderPageGroup(container, target.path, page, byPage.get(page)!);
		}
	}

	private renderPageGroup(parent: HTMLElement, pdfPath: string, page: number, anns: PdfAnnotation[]): void {
		const group = parent.createDiv("margin-notes-pdf-page-group");
		const collapsed = this.collapsedPages.has(page);
		group.toggleClass("is-collapsed", collapsed);

		const header = group.createDiv("margin-notes-pdf-page-header");
		const chevron = header.createSpan({ cls: "margin-notes-pdf-page-chevron" });
		setIcon(chevron, "chevron-down");
		header.createSpan({ cls: "margin-notes-pdf-page-title", text: `第 ${page} 页` });
		header.createSpan({ cls: "margin-notes-pdf-page-count", text: String(anns.length) });
		header.addEventListener("click", () => {
			if (this.collapsedPages.has(page)) this.collapsedPages.delete(page);
			else this.collapsedPages.add(page);
			this.render();
		});

		if (collapsed) return;

		const rows = group.createDiv("margin-notes-pdf-page-rows");
		for (const ann of anns) this.renderRow(rows, pdfPath, ann);
	}

	private renderRow(parent: HTMLElement, pdfPath: string, ann: PdfAnnotation): void {
		const handle = buildAnnotationBox(parent, "margin-notes-pdf-list-row", {
			app: this.app,
			component: this,
			sourcePath: pdfPath,
			initialText: ann.text,
			placeholder: "(空批注,点击写点什么)",
			onCommit: (text) => {
				ann.text = text;
				ann.updatedAt = Date.now();
				this.controller.store.upsert(pdfPath, ann);
			},
			actions: [
				{
					icon: "arrow-up-right",
					title: "跳转到 PDF 里的位置",
					onClick: () => void this.controller.revealAnnotation(pdfPath, ann),
				},
				{
					icon: "x",
					title: "删除批注",
					cls: "margin-notes-pdf-del",
					onClick: () => this.controller.store.remove(pdfPath, ann.id),
				},
			],
		});
		handle.el.dataset.mode = ann.pinned ? "rail" : "free";
		if (ann.color) handle.el.style.setProperty("--margin-notes-pdf-note-color", ann.color);
		void handle.render();
	}
}
