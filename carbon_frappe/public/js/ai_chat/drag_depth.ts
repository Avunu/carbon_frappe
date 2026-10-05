// The bookkeeping that tells "a file drag is over the panel" from the flicker of enter and leave
// events: crossing from one child element to the next fires `dragenter` on the new one before
// `dragleave` on the old one, so a plain boolean flips off and on again at every boundary. Counting the
// enters that have not been matched by a leave keeps the answer steady. Pure so node:test covers it.

export interface DragDepth {
	/** True when this enter started a drag (the count went from 0 to 1). */
	enter(): boolean;
	/** True when this leave ended it (the count reached 0). A leave with nothing entered does nothing. */
	leave(): boolean;
	/** Forget the drag (a drop, a cancelled drag, teardown). True when one was in progress. */
	reset(): boolean;
	readonly depth: number;
}

export function createDragDepth(): DragDepth {
	let depth = 0;
	return {
		enter() {
			depth += 1;
			return depth === 1;
		},
		leave() {
			if (depth === 0) return false;
			depth -= 1;
			return depth === 0;
		},
		reset() {
			const was = depth > 0;
			depth = 0;
			return was;
		},
		get depth() {
			return depth;
		},
	};
}
