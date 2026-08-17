/**
 * Walks up from `el` to the nearest scrolling ancestor (computed
 * `overflow-y: auto|scroll`) — Obsidian doesn't expose a stable class name for
 * the PDF viewer's scroll container across versions, so this finds it
 * structurally instead of hardcoding one. Falls back to the document root.
 */
export function findScrollAncestor(el: HTMLElement): HTMLElement {
	let node: HTMLElement | null = el.parentElement;
	while (node) {
		const style = getComputedStyle(node);
		if (/(auto|scroll)/.test(style.overflowY)) return node;
		node = node.parentElement;
	}
	return document.documentElement;
}
