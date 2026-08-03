export interface MarginBox {
	id: string;
	/** Natural (unresolved) vertical position, aligned to the source line. */
	top: number;
	/** Measured rendered height — content varies, so no shared constant. */
	height: number;
}

/**
 * Pushes boxes down so none overlap: sort by natural top, then each box sits
 * at its natural position unless the previous box's bottom (+ minGap) forces
 * it lower. Returns copies with resolved tops; extra fields on T pass through.
 */
export function resolveCollisions<T extends MarginBox>(boxes: T[], minGap: number): T[] {
	const sorted = [...boxes].sort((a, b) => a.top - b.top);
	let prevBottom = -Infinity;

	return sorted.map((box) => {
		const top = Math.max(box.top, prevBottom + minGap);
		prevBottom = top + box.height;
		return { ...box, top };
	});
}
