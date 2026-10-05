// Every scroll decision of the message list as a function of numbers, so the DOM code
// only measures and applies. A port of the decisions in @carbon/ai-chat's
// messagesAutoScrollController.ts (1.8k lines, not exported, so not vendored); the
// constants and formulas below are its, with the pin/spacer/scroll-away/jump-button
// subset the chat needs.
//
// The model. A sent message is PINNED near the top of the viewport and the reply grows
// into the blank space under it, so the reader never has to chase the bottom while a
// response streams. A spacer element after the last row supplies that blank space; it
// only GROWS while a response streams (shrinking it mid-stream would move the pin) and
// is trimmed back when the stream ends. If the reader scrolls away from the pin by more
// than USER_SCROLL_AWAY_PX the list stops re-pinning, and a "scroll to bottom" button
// appears once more than JUMP_BUTTON_PX of real content sits below the viewport.

/** How far above the pinned row's top edge the viewport starts, leaving the previous turn's tail visible. */
export const PIN_OFFSET_PX = 60;
/** A pinned row taller than this share of the viewport is scrolled past, so the reply stays in view. */
export const TALL_ROW_RATIO = 0.25;
/** How much of the bottom of such a tall row stays visible. */
export const TALL_ROW_VISIBLE_PX = 100;
/** Scrolling this far from the pin counts as the reader leaving it. */
export const USER_SCROLL_AWAY_PX = 50;
/** Content hidden below the viewport beyond this, spacer excluded, shows the jump button. */
export const JUMP_BUTTON_PX = 60;
/** At stream end, a scrollTop within this of the pin is re-pinned; further away is left alone. */
export const STREAM_END_NEAR_PIN_PX = 60;

/**
 * The scrollTop that pins a row: its top edge within the scroller, less PIN_OFFSET_PX,
 * and for a tall row pushed down so only its last TALL_ROW_VISIBLE_PX remain visible.
 * Never negative.
 */
export function pinScrollTop(rowOffsetTop: number, rowHeight: number, viewportHeight: number): number {
	const base = Math.max(0, Math.floor(rowOffsetTop - PIN_OFFSET_PX));
	const tall = rowHeight > viewportHeight * TALL_ROW_RATIO;
	return tall ? base + Math.max(0, rowHeight - TALL_ROW_VISIBLE_PX) : base;
}

/**
 * The spacer height that lets the scroller actually reach `scrollTop`: without blank
 * space below the content the browser caps scrollTop at scrollHeight - clientHeight.
 * `spacerOffsetTop` is the spacer's top edge within the scroller's scrolling area.
 */
export function spacerHeightFor(spacerOffsetTop: number, scrollTop: number, viewportHeight: number): number {
	return Math.max(0, Math.ceil(scrollTop + viewportHeight - spacerOffsetTop));
}

export interface SpacerGeometry {
	scrollHeight: number;
	clientHeight: number;
	spacerHeight: number;
	pinnedScrollTop: number;
}

/**
 * The spacer height while a response streams: never smaller than the current one, and
 * large enough to keep `pinnedScrollTop` reachable if the content above shrank (a
 * collapsing step list) before the next settle point.
 */
export function growOnlySpacerHeight(g: SpacerGeometry): number {
	const contentHeight = g.scrollHeight - g.spacerHeight;
	const needed = Math.max(0, g.pinnedScrollTop + g.clientHeight - contentHeight);
	return Math.max(g.spacerHeight, needed);
}

export interface ScrollAwayGeometry {
	scrollTop: number;
	pinnedScrollTop: number;
	maxScrollTop: number;
}

/**
 * Whether a scroll event means the reader moved away from the pin: `true` when they are
 * more than USER_SCROLL_AWAY_PX above it with room still below, `false` when they are
 * back within the threshold of it (or below), `null` when it is inconclusive (above the
 * pin but at the very bottom: the browser capped it, which is not the reader's doing).
 */
export function userScrolledAway(g: ScrollAwayGeometry): boolean | null {
	const abovePin = g.scrollTop < g.pinnedScrollTop - USER_SCROLL_AWAY_PX;
	const roomBelow = g.scrollTop < g.maxScrollTop - USER_SCROLL_AWAY_PX;
	if (abovePin && roomBelow) return true;
	if (g.scrollTop >= g.pinnedScrollTop - USER_SCROLL_AWAY_PX) return false;
	return null;
}

export interface ViewportGeometry {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
	/** The spacer's current height: blank space is not content the reader is missing. */
	spacerHeight: number;
}

/** Whether the "scroll to bottom" button shows: real content below the viewport beyond JUMP_BUTTON_PX. */
export function hasContentBelow(g: ViewportGeometry): boolean {
	const remaining = g.scrollHeight - g.spacerHeight - g.scrollTop - g.clientHeight;
	return remaining > JUMP_BUTTON_PX;
}

/**
 * What to do with the scroll position when a stream ends: re-pin unless the reader had
 * scrolled away from the pin by more than STREAM_END_NEAR_PIN_PX in either direction.
 * A scrollTop the browser capped below the pin (content shrank) is not the reader's
 * choice, so it is re-pinned too.
 */
export function atStreamEnd(g: ScrollAwayGeometry): "re-pin" | "keep" {
	const cappedBelowPin = g.scrollTop >= g.maxScrollTop - 2 && g.scrollTop < g.pinnedScrollTop;
	const movedAway = Math.abs(g.scrollTop - g.pinnedScrollTop) > STREAM_END_NEAR_PIN_PX;
	return !movedAway || cappedBelowPin ? "re-pin" : "keep";
}

// -- windowing ----------------------------------------------------------------
// A restored conversation of hundreds of messages builds only its tail; "Show earlier
// messages" prepends one chunk at a time. Both bounds snap to the start of a turn (a user
// request), so the window never opens on a reply whose question is hidden.

/** Rows built when a conversation is loaded wholesale. */
export const WINDOW_INITIAL = 30;
/** Rows added by one "Show earlier messages". */
export const WINDOW_CHUNK = 30;

/** Move `index` back to the nearest turn start at or before it (0 when none). */
function snapToTurnStart(index: number, isTurnStart: (index: number) => boolean): number {
	let at = Math.max(0, index);
	while (at > 0 && !isTurnStart(at)) at--;
	return at;
}

/** The index of the first message to build for a conversation of `total` messages. */
export function initialWindowStart(total: number, isTurnStart: (index: number) => boolean): number {
	return snapToTurnStart(total - WINDOW_INITIAL, isTurnStart);
}

/** The first message to build once one more chunk is shown; `start` itself when nothing is hidden. */
export function earlierWindowStart(start: number, isTurnStart: (index: number) => boolean): number {
	if (start <= 0) return 0;
	return snapToTurnStart(start - WINDOW_CHUNK, isTurnStart);
}

/**
 * The scrollTop that keeps the row the reader was looking at where it was after rows are
 * inserted above it: `anchorBefore` and `anchorAfter` are that row's top edge within the
 * scroller's scrolling area before and after the insertion.
 */
export function scrollTopAfterPrepend(scrollTop: number, anchorBefore: number, anchorAfter: number): number {
	return Math.max(0, scrollTop + (anchorAfter - anchorBefore));
}
