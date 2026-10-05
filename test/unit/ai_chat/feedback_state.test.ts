import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	feedbackRun,
	initialFeedbackState,
	onCloseDetails,
	onSubmitDetails,
	onThumb,
	restoredRating,
	settle,
} from "../../../carbon_frappe/public/js/ai_chat/feedback_state.ts";
import type { FeedbackState } from "../../../carbon_frappe/public/js/ai_chat/feedback_state.ts";
import type {
	GenericItem,
	GenericItemMessageOptions,
	MessageResponse,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";

const none = initialFeedbackState(null);
const up = initialFeedbackState("Up");
const downSent = initialFeedbackState("Down");
const downDraft: FeedbackState = { rating: "Down", downSent: false, detailsOpen: true, busy: false };

describe("initialFeedbackState", () => {
	it("starts a restored Down as already sent and nothing open", () => {
		assert.deepEqual(none, { rating: null, downSent: false, detailsOpen: false, busy: false });
		assert.deepEqual(up, { rating: "Up", downSent: false, detailsOpen: false, busy: false });
		assert.deepEqual(downSent, { rating: "Down", downSent: true, detailsOpen: false, busy: false });
	});
});

describe("onThumb", () => {
	it("ignores every click while a call is in flight", () => {
		const busy: FeedbackState = { ...up, busy: true };
		for (const isPositive of [true, false]) {
			const step = onThumb(busy, isPositive);
			assert.equal(step.state, busy);
			assert.equal(step.call, null);
		}
	});

	it("selects Up and calls Up", () => {
		const step = onThumb(none, true);
		assert.deepEqual(step.state, { rating: "Up", downSent: false, detailsOpen: false, busy: true });
		assert.deepEqual(step.call, { rating: "Up" });
	});

	it("withdraws a selected Up with None", () => {
		const step = onThumb(up, true);
		assert.deepEqual(step.state, { rating: null, downSent: false, detailsOpen: false, busy: true });
		assert.deepEqual(step.call, { rating: "None" });
	});

	it("does nothing for Up while Down is selected", () => {
		for (const state of [downSent, downDraft]) {
			const step = onThumb(state, true);
			assert.equal(step.state, state);
			assert.equal(step.call, null);
		}
	});

	it("opens the comment panel for Down without calling", () => {
		const step = onThumb(none, false);
		assert.deepEqual(step.state, { rating: "Down", downSent: false, detailsOpen: true, busy: false });
		assert.equal(step.call, null);
	});

	it("withdraws a sent Down with None", () => {
		const step = onThumb(downSent, false);
		assert.deepEqual(step.state, { rating: null, downSent: false, detailsOpen: false, busy: true });
		assert.deepEqual(step.call, { rating: "None" });
	});

	it("drops an unsent Down and closes the panel, with no call", () => {
		const step = onThumb(downDraft, false);
		assert.deepEqual(step.state, { rating: null, downSent: false, detailsOpen: false, busy: false });
		assert.equal(step.call, null);
	});

	it("does nothing for Down while Up is selected", () => {
		const step = onThumb(up, false);
		assert.equal(step.state, up);
		assert.equal(step.call, null);
	});

	it("does not mutate the state it was given", () => {
		const before = { ...none };
		onThumb(none, true);
		onThumb(none, false);
		assert.deepEqual(none, before);
	});
});

describe("onSubmitDetails", () => {
	it("sends Down with the trimmed comment", () => {
		const step = onSubmitDetails(downDraft, "  too long \n");
		assert.deepEqual(step.state, { rating: "Down", downSent: true, detailsOpen: false, busy: true });
		assert.deepEqual(step.call, { rating: "Down", comment: "too long" });
	});

	it("leaves the comment key out when the text is blank", () => {
		const step = onSubmitDetails(downDraft, "   ");
		assert.deepEqual(step.call, { rating: "Down" });
		assert.equal(step.call !== null && "comment" in step.call, false);
	});

	it("is a no-op unless Down is selected", () => {
		for (const state of [none, up]) {
			const step = onSubmitDetails(state, "text");
			assert.equal(step.state, state);
			assert.equal(step.call, null);
		}
	});

	it("is a no-op while busy", () => {
		const busy: FeedbackState = { ...downDraft, busy: true };
		const step = onSubmitDetails(busy, "text");
		assert.equal(step.state, busy);
		assert.equal(step.call, null);
	});
});

describe("onCloseDetails", () => {
	it("drops an unsent Down", () => {
		assert.deepEqual(onCloseDetails(downDraft), {
			rating: null,
			downSent: false,
			detailsOpen: false,
			busy: false,
		});
	});

	it("keeps a sent Down and an Up", () => {
		assert.equal(onCloseDetails(downSent).rating, "Down");
		assert.equal(onCloseDetails(up).rating, "Up");
	});

	it("closes the panel", () => {
		assert.equal(onCloseDetails({ ...downSent, detailsOpen: true }).detailsOpen, false);
	});
});

describe("settle", () => {
	it("returns to the state before the step when the call failed", () => {
		const step = onThumb(none, true);
		assert.deepEqual(settle(step.state, none, false), none);
	});

	it("restores the open comment panel when a Down submission failed", () => {
		const step = onSubmitDetails(downDraft, "slow");
		assert.deepEqual(settle(step.state, downDraft, false), downDraft);
	});

	it("keeps the new state when the call succeeded, and clears busy", () => {
		const step = onThumb(none, true);
		assert.deepEqual(settle(step.state, none, true), { ...step.state, busy: false });
	});

	it("clears busy even when the state before was busy", () => {
		const busy: FeedbackState = { ...none, busy: true };
		assert.equal(settle(none, busy, false).busy, false);
	});
});

function response(history?: MessageResponse["history"]): MessageResponse {
	return { output: { generic: [] }, ...(history !== undefined && { history }) };
}

describe("restoredRating", () => {
	it("maps the stored polarity for the run", () => {
		assert.equal(restoredRating(response({ feedback: { r1: { is_positive: true } } }), "r1"), "Up");
		assert.equal(restoredRating(response({ feedback: { r1: { is_positive: false } } }), "r1"), "Down");
	});

	it("is null with no history, no feedback, or a different run", () => {
		assert.equal(restoredRating(response(), "r1"), null);
		assert.equal(restoredRating(response({ timestamp: 1 }), "r1"), null);
		assert.equal(restoredRating(response({ feedback: { r2: { is_positive: true } } }), "r1"), null);
	});
});

const on = (id: string): GenericItemMessageOptions => ({ feedback: { is_on: true, id } });

describe("feedbackRun", () => {
	it("takes the last text item that turns feedback on", () => {
		const generic: GenericItem[] = [
			{ response_type: "text", text: "a", message_item_options: on("r1") },
			{ response_type: "text", text: "b", message_item_options: on("r2") },
		];
		assert.equal(feedbackRun(generic), "r2");
	});

	it("skips items with is_on false, an empty id, or no feedback", () => {
		const generic: GenericItem[] = [
			{ response_type: "text", text: "a", message_item_options: on("r1") },
			{ response_type: "text", text: "b", message_item_options: { feedback: { is_on: false, id: "r2" } } },
			{ response_type: "text", text: "c", message_item_options: on("") },
			{ response_type: "text", text: "d", message_item_options: { feedback: { is_on: true } } },
			{ response_type: "text", text: "e" },
		];
		assert.equal(feedbackRun(generic), "r1");
	});

	it("ignores items that are not text", () => {
		const generic: GenericItem[] = [
			{ response_type: "inline_error", text: "x", message_item_options: on("r9") },
			{ response_type: "user_defined", message_item_options: on("r8") },
		];
		assert.equal(feedbackRun(generic), undefined);
		assert.equal(feedbackRun([]), undefined);
	});
});
