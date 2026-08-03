export interface FootnoteRef {
	id: string;
	/** Position of the `[^id]` marker in the document. */
	pos: number;
}

export interface FootnoteDef {
	id: string;
	/** Start of the `[^id]:` marker (line start). */
	from: number;
	/** Position right after the `:` of the marker. */
	markerEnd: number;
	/** End of the definition block (exclusive, not including trailing newline). */
	to: number;
	/**
	 * Display text: first-line remainder (one leading space stripped) plus
	 * continuation lines dedented, joined with `\n`.
	 */
	content: string;
}

function isLineStart(text: string, idx: number): boolean {
	return idx === 0 || text[idx - 1] === "\n";
}

/**
 * Finds footnote references (`[^id]`, anywhere) and definitions (`[^id]:`,
 * must start a line) in raw document text. A definition's block spans its
 * marker line plus any continuation lines (indented with a tab or 2+ spaces;
 * intervening blank lines are included only when further continuation
 * follows, so trailing blanks stay outside the block).
 */
export function scanFootnotes(text: string): { refs: FootnoteRef[]; defs: FootnoteDef[] } {
	const defs: FootnoteDef[] = [];
	const defRe = /^\[\^([^\]]+)\]:/gm;
	let m: RegExpExecArray | null;
	while ((m = defRe.exec(text))) {
		const id = m[1];
		const from = m.index;
		const markerEnd = m.index + m[0].length;

		let lineEnd = text.indexOf("\n", markerEnd);
		if (lineEnd === -1) lineEnd = text.length;
		const contentLines = [text.slice(markerEnd, lineEnd).replace(/^ /, "")];
		let to = lineEnd;

		let cursor = lineEnd;
		let pendingBlanks = 0;
		while (cursor < text.length) {
			const lineStart = cursor + 1;
			let le = text.indexOf("\n", lineStart);
			if (le === -1) le = text.length;
			const line = text.slice(lineStart, le);

			if (/^\s*$/.test(line)) {
				pendingBlanks++;
				cursor = le;
				continue;
			}
			if (!/^(\t| {2,})/.test(line)) break;

			for (; pendingBlanks > 0; pendingBlanks--) contentLines.push("");
			contentLines.push(line.replace(/^(\t| {1,4})/, ""));
			to = le;
			cursor = le;
		}

		defs.push({ id, from, markerEnd, to, content: contentLines.join("\n").trimEnd() });
	}

	const refs: FootnoteRef[] = [];
	const refRe = /\[\^([^\]]+)\]/g;
	while ((m = refRe.exec(text))) {
		const afterIdx = m.index + m[0].length;
		const isDefMarker = text[afterIdx] === ":" && isLineStart(text, m.index);
		if (isDefMarker) continue;
		refs.push({ id: m[1], pos: m.index });
	}

	return { refs, defs };
}

/**
 * Serializes (possibly multi-line) note text back into footnote-definition
 * syntax: first line goes after the `[^id]: ` marker, subsequent lines are
 * indented with 4 spaces so Obsidian keeps treating them as the same footnote.
 */
export function serializeDefContent(text: string): string {
	return text.split("\n").join("\n    ");
}
