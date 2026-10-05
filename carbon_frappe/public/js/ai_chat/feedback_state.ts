// The thumbs-up/down footer of a reply as a pure state machine, so every rule about it
// (one rating per reply, a thumbs-down asks for details before it counts, clicking the
// selected thumb withdraws it, a refused call is rolled back) is testable without a DOM.
// view/feedback.ts renders it.
//
// A rating counts once the server has it, so `rating` can run ahead of the server only
// while `busy`; `settle` takes it back if the call failed.
import type { GenericItem, MessageResponse } from "./types.ts";
import { isTextItem } from "./types.ts";

export type Rating = "Up" | "Down" | null;

export interface FeedbackState {
	rating: Rating;
	/** The thumbs-down was submitted. A selected thumbs-down that is not yet sent is only an open question. */
	downSent: boolean;
	/** The comment panel (`cds-aichat-feedback`) is open. */
	detailsOpen: boolean;
	/** A call is in flight: further clicks are ignored. */
	busy: boolean;
}

/** The call a step asks for. `comment` is trimmed and present only when non-empty. */
export interface FeedbackCall {
	rating: "Up" | "Down" | "None";
	comment?: string;
}

export interface FeedbackStep {
	state: FeedbackState;
	/** Null when the step is local only (opening the comment panel, dropping an unsent draft). */
	call: FeedbackCall | null;
}

/** A restored reply starts with its stored rating, already sent. */
export function initialFeedbackState(rating: Rating): FeedbackState {
	return { rating, downSent: rating === "Down", detailsOpen: false, busy: false };
}

/** A step that makes a call: the state it leaves is busy, with the panel closed. */
function calling(rating: Rating, call: FeedbackCall): FeedbackStep {
	return { state: { rating, downSent: rating === "Down", detailsOpen: false, busy: true }, call };
}

/**
 * A thumb was clicked.
 * - busy: nothing.
 * - up, none selected: select Up, call Up. up, Up selected: deselect, call None. up, Down selected: nothing.
 * - down, none selected: select Down and open the comment panel, no call yet. down, Down selected and sent:
 *   deselect, call None. down, Down selected but unsent: deselect and close the panel, no call.
 *   down, Up selected: nothing.
 * A step that calls sets `busy` and closes the panel.
 */
export function onThumb(state: FeedbackState, isPositive: boolean): FeedbackStep {
	if (state.busy) return { state, call: null };
	if (isPositive) {
		if (state.rating === null) return calling("Up", { rating: "Up" });
		if (state.rating === "Up") return calling(null, { rating: "None" });
		return { state, call: null };
	}
	if (state.rating === null) {
		return { state: { ...state, rating: "Down", downSent: false, detailsOpen: true }, call: null };
	}
	if (state.rating === "Down") {
		// a sent rating is withdrawn on the server; an unsent one was only ever a draft
		if (state.downSent) return calling(null, { rating: "None" });
		return { state: { ...state, rating: null, detailsOpen: false }, call: null };
	}
	return { state, call: null };
}

/** The comment panel was submitted: nothing unless Down is selected; otherwise call Down with the trimmed text. */
export function onSubmitDetails(state: FeedbackState, text: string): FeedbackStep {
	if (state.busy || state.rating !== "Down") return { state, call: null };
	const comment = text.trim();
	return calling("Down", { rating: "Down", ...(comment !== "" && { comment }) });
}

/** The comment panel was closed without submitting: an unsent Down is dropped. */
export function onCloseDetails(state: FeedbackState): FeedbackState {
	const dropped = state.rating === "Down" && !state.downSent;
	return { ...state, detailsOpen: false, rating: dropped ? null : state.rating };
}

/**
 * The call finished. `before` is the state from before the step that made the call: a
 * failure returns to it (with `busy` cleared), a success keeps `state` and clears `busy`.
 */
export function settle(state: FeedbackState, before: FeedbackState, succeeded: boolean): FeedbackState {
	return { ...(succeeded ? state : before), busy: false };
}

/** The rating a restored reply was stored with (`history.feedback` is keyed by run name), or null. */
export function restoredRating(message: MessageResponse, run: string): Rating {
	const stored = message.history?.feedback?.[run];
	if (stored === undefined) return null;
	return stored.is_positive ? "Up" : "Down";
}

/**
 * The run to rate: the `message_item_options.feedback.id` of the LAST text item whose `is_on` is true
 * and whose id is non-empty; undefined when there is none (no footer).
 */
export function feedbackRun(generic: readonly GenericItem[]): string | undefined {
	for (let i = generic.length - 1; i >= 0; i--) {
		const item = generic[i];
		if (!isTextItem(item)) continue;
		const feedback = item.message_item_options?.feedback;
		if (feedback?.is_on === true && feedback.id !== undefined && feedback.id !== "") return feedback.id;
	}
	return undefined;
}
