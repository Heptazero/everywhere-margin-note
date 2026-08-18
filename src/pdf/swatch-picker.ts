/**
 * A small palette popover, used instead of the OS colour panel.
 *
 * The native `<input type=color>` route had to place an invisible input at the
 * click just to coax the system panel to open nearby, and it still landed in a
 * corner. This is a plain element positioned where it was asked for, so it is
 * simply where the click was — and offering a fixed set of colours keeps a
 * document's annotations looking like one system rather than a free-for-all.
 */
export function openSwatchPicker(opts: {
	at: { x: number; y: number };
	colors: string[];
	current?: string;
	onPick: (color: string | undefined) => void;
}): void {
	const el = document.body.createDiv("margin-notes-pdf-swatches");

	for (const color of opts.colors) {
		const b = el.createDiv("margin-notes-pdf-swatch-dot");
		b.style.background = color;
		b.setAttribute("aria-label", color);
		if (opts.current?.toLowerCase() === color.toLowerCase()) b.addClass("is-current");
		b.addEventListener("click", () => {
			opts.onPick(color);
			close();
		});
	}

	const reset = el.createDiv({ cls: "margin-notes-pdf-swatch-reset", text: "默认颜色" });
	reset.addEventListener("click", () => {
		opts.onPick(undefined);
		close();
	});

	// Positioned after insertion so the measured size can be used to keep it on
	// screen — a popover opened near the right or bottom edge would otherwise
	// hang off it.
	const r = el.getBoundingClientRect();
	el.style.left = `${Math.max(4, Math.min(opts.at.x, window.innerWidth - r.width - 4))}px`;
	el.style.top = `${Math.max(4, Math.min(opts.at.y + 6, window.innerHeight - r.height - 4))}px`;

	const onDown = (e: MouseEvent) => {
		if (!el.contains(e.target as Node)) close();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") close();
	};
	function close(): void {
		document.removeEventListener("mousedown", onDown, true);
		document.removeEventListener("keydown", onKey, true);
		el.remove();
	}
	// Capture phase, and deferred by a frame so the click that opened this popover
	// cannot immediately close it again.
	window.requestAnimationFrame(() => {
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey, true);
	});
}
