import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyToolResults,
	initialStreamState,
	lockApproval,
	messageStateFor,
	reduceFlowEvent,
	resumeStreamState,
	stopStream,
} from "../../../carbon_frappe/public/js/ai_chat/flow/reduce.ts";
import type { FlowEvent, ToolEndedEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import { isFlowApprovalItem, isTextItem } from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import type {
	ChainOfThoughtStep,
	GenericItem,
	StreamState,
	TextItem,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import {
	ANSWERS_APPROVE_ALL,
	ANSWERS_DENY,
	ANSWERS_REDIRECT,
	CALL_CREATE,
	CALL_CREATE_AGAIN,
	CALL_DELETE,
	CALL_READ,
	CREATE_ARGS,
	CREATE_HIGH_ARGS,
	DELETE_ARGS,
	ERROR_AFTER_DONE,
	ERROR_BEFORE_TEXT,
	ERROR_MESSAGE,
	ERROR_MID_TEXT,
	PAUSED_TWO_QUESTIONS,
	QUESTION_CREATE,
	QUESTION_CREATE_AGAIN,
	QUESTION_DELETE,
	READ_ARGS,
	READ_RESULT,
	REDIRECT_RESULT,
	RESUME_APPROVED,
	RESUME_DENIED,
	RESUME_REDIRECTED_PAUSED_AGAIN,
	RUN,
	SESSION,
	TEXT_ONLY,
	TEXT_TOOL_TEXT,
	TEXT_UNICODE,
	TOOL_ERROR,
	ev,
	pyJson,
} from "./fixtures.ts";
import type { Transcript } from "./fixtures.ts";

const START = initialStreamState({ id: "resp" });

function play(events: readonly FlowEvent[], start: StreamState = START): StreamState {
	return events.reduce((state, event) => reduceFlowEvent(state, event), start);
}

function items(state: StreamState): GenericItem[] {
	return state.response.output.generic;
}

function steps(state: StreamState): ChainOfThoughtStep[] {
	return state.response.message_options?.chain_of_thought ?? [];
}

function step(state: StreamState, id: string): ChainOfThoughtStep {
	const found = steps(state).find((entry) => entry.tool_call_id === id);
	assert.ok(found, `no step ${id}`);
	return found;
}

function texts(state: StreamState): TextItem[] {
	return items(state).filter(isTextItem);
}

/** The streaming ids of every item carrying feedback options. */
function feedbackOn(state: StreamState): string[] {
	return items(state)
		.filter((item) => item.message_item_options?.feedback !== undefined)
		.map((item) => item.streaming_metadata?.id ?? "?");
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

const createdPayload = { doctype: "ToDo", created: ["TD-0003"] };
const deletedPayload = { doctype: "ToDo", deleted: ["TD-0001"] };
const deniedPayload = { status: "denied", message: "User denied this tool call." };

const ALL_TRANSCRIPTS: [string, Transcript][] = [
	["TEXT_ONLY", TEXT_ONLY],
	["TEXT_UNICODE", TEXT_UNICODE],
	["TEXT_TOOL_TEXT", TEXT_TOOL_TEXT],
	["PAUSED_TWO_QUESTIONS", PAUSED_TWO_QUESTIONS],
	["RESUME_APPROVED", RESUME_APPROVED],
	["RESUME_DENIED", RESUME_DENIED],
	["RESUME_REDIRECTED_PAUSED_AGAIN", RESUME_REDIRECTED_PAUSED_AGAIN],
	["TOOL_ERROR", TOOL_ERROR],
	["ERROR_BEFORE_TEXT", ERROR_BEFORE_TEXT],
	["ERROR_MID_TEXT", ERROR_MID_TEXT],
	["ERROR_AFTER_DONE", ERROR_AFTER_DONE],
];

describe("initialStreamState", () => {
	it("starts an empty streaming draft under the given id", () => {
		assert.deepEqual(START, {
			response: { id: "resp", output: { generic: [] } },
			run: null,
			session: null,
			phase: "streaming",
			textCount: 0,
			textOpen: false,
			emptyEnded: [],
			unmatched: [],
		});
	});

	it("has no message_options until a step exists, so a tool-less reply renders no empty toggle", () => {
		assert.equal("message_options" in START.response, false);
		const plain = play(TEXT_ONLY.events);
		assert.equal("message_options" in plain.response, false);
		const withTool = play([ev.toolStarted("c1", "read", {})]);
		assert.equal(steps(withTool).length, 1);
	});

	it("carries request_id and the timestamp only when given", () => {
		const full = initialStreamState({ id: "r", request_id: "q", timestamp: 1234 });
		assert.equal(full.response.request_id, "q");
		assert.deepEqual(full.response.history, { timestamp: 1234 });
		assert.equal("request_id" in START.response, false);
		assert.equal("history" in START.response, false);
	});
});

describe("reduceFlowEvent: whole transcripts", () => {
	it("TEXT_ONLY folds to one text item with feedback", () => {
		const state = play(TEXT_ONLY.events);
		assert.deepEqual(items(state), [
			{
				response_type: "text",
				text: "Hello there! How can I help?",
				streaming_metadata: { id: "text-1" },
				message_item_options: { feedback: { is_on: true, id: RUN } },
			},
		]);
		assert.equal(state.phase, "complete");
		assert.equal(state.run, RUN);
		assert.equal(state.session, SESSION);
		assert.deepEqual(steps(state), []);
		assert.equal(state.textOpen, false);
		assert.equal(state.textCount, 1);
	});

	it("keeps non-ASCII text intact", () => {
		assert.equal(texts(play(TEXT_UNICODE.events))[0]?.text, "Café ☕ — 你好 \u{1F600}");
	});

	it("TEXT_TOOL_TEXT folds the double tool_started into one settled step", () => {
		const state = play(TEXT_TOOL_TEXT.events);
		assert.equal(texts(state).length, 2);
		assert.equal(texts(state)[0]?.text, "Let me check your open ToDos. ");
		assert.equal(texts(state)[0]?.streaming_metadata?.id, "text-1");
		assert.equal(
			texts(state)[1]?.text,
			"You have **2** open ToDos:\n\n- TD-0001: Call Alice\n- TD-0002: Send the Q3 report",
		);
		assert.equal(texts(state)[1]?.streaming_metadata?.id, "text-2");

		assert.deepEqual(steps(state), [
			{
				tool_call_id: CALL_READ,
				tool_name: "read",
				title: "Reading DocType Records: ToDo",
				status: "success",
				request: { args: READ_ARGS },
				response: {
					content: [
						{ name: "TD-0001", description: "Call Alice" },
						{ name: "TD-0002", description: "Send the Q3 report" },
					],
				},
			},
		]);
		assert.equal(
			JSON.stringify(step(state, CALL_READ).response?.content),
			JSON.stringify(JSON.parse(READ_RESULT)),
		);
		assert.deepEqual(feedbackOn(state), ["text-2"]);
		assert.equal(state.phase, "complete");
	});

	it("uses the injected translate for step titles", () => {
		const upper = (source: string): string => source.toUpperCase();
		const state = TEXT_TOOL_TEXT.events.reduce(
			(acc, event) => reduceFlowEvent(acc, event, { translate: upper }),
			START,
		);
		assert.equal(step(state, CALL_READ).title, "READING DOCTYPE RECORDS: ToDo");
	});

	it("PAUSED_TWO_QUESTIONS parks both steps behind one unlocked card", () => {
		const state = play(PAUSED_TWO_QUESTIONS.events);
		assert.equal(state.phase, "paused");
		assert.deepEqual(state.emptyEnded, []);
		assert.deepEqual(
			steps(state).map((entry) => [entry.tool_call_id, entry.status, entry.title]),
			[
				[CALL_CREATE, "processing", "Creating Records: ToDo"],
				[CALL_DELETE, "processing", "Deleting Records: ToDo"],
			],
		);
		assert.deepEqual(step(state, CALL_CREATE).request, { args: CREATE_ARGS });
		assert.deepEqual(step(state, CALL_DELETE).request, { args: DELETE_ARGS });
		assert.equal("response" in step(state, CALL_CREATE), false);

		const card = items(state).at(-1);
		assert.ok(isFlowApprovalItem(card));
		assert.equal(card.streaming_metadata?.id, "approval-1");
		assert.equal(card.user_defined.run, RUN);
		assert.deepEqual(card.user_defined.questions, [QUESTION_CREATE, QUESTION_DELETE]);
		assert.equal("answers" in card.user_defined, false);
		assert.deepEqual(feedbackOn(state), []);
		assert.equal(items(state).length, 2);
	});
});

describe("reduceFlowEvent: tool steps", () => {
	it("creates the step on the first frame without request, then fills it", () => {
		const first = reduceFlowEvent(START, ev.toolStarted(CALL_READ, "read", {}));
		assert.deepEqual(steps(first), [
			{ tool_call_id: CALL_READ, tool_name: "read", title: "Reading DocType Records", status: "processing" },
		]);
		assert.equal("request" in step(first, CALL_READ), false);

		const second = reduceFlowEvent(first, ev.toolStarted(CALL_READ, "read", READ_ARGS));
		assert.equal(steps(second).length, 1);
		assert.deepEqual(step(second, CALL_READ).request, { args: READ_ARGS });
		assert.equal(step(second, CALL_READ).title, "Reading DocType Records: ToDo");
		assert.equal(step(second, CALL_READ).status, "processing");

		const third = reduceFlowEvent(second, ev.toolStarted(CALL_READ, "read", {}));
		assert.deepEqual(step(third, CALL_READ).request, { args: READ_ARGS });
		assert.equal(step(third, CALL_READ).title, "Reading DocType Records: ToDo");
		assert.equal(third, second);
	});

	it("normalizes a model-token-polluted tool name", () => {
		const state = reduceFlowEvent(START, ev.toolStarted("c1", "describe<|channel|>commentary", {}));
		assert.equal(step(state, "c1").tool_name, "describe");
		assert.equal(step(state, "c1").title, "Reading DocType Meta");
	});

	it("keeps the settled status when a late duplicate tool_started arrives", () => {
		const done = play([
			ev.toolStarted(CALL_READ, "read", READ_ARGS),
			ev.toolEnded(CALL_READ, "read", READ_RESULT),
		]);
		const again = reduceFlowEvent(done, ev.toolStarted(CALL_READ, "read", READ_ARGS));
		assert.equal(step(again, CALL_READ).status, "success");
		assert.notEqual(step(again, CALL_READ).response, undefined);
	});

	it("orders steps by first appearance", () => {
		const state = play([
			ev.toolStarted("b", "read", {}),
			ev.toolStarted("a", "describe", {}),
			ev.toolStarted("b", "read", { doctype: "ToDo" }),
		]);
		assert.deepEqual(
			steps(state).map((entry) => entry.tool_call_id),
			["b", "a"],
		);
	});

	it("turns an empty tool_ended into success with empty content when done is Completed", () => {
		const state = play([ev.toolStarted("c1", "read", { doctype: "ToDo" }), ev.toolEnded("c1", "read", "")]);
		assert.equal(step(state, "c1").status, "processing");
		assert.deepEqual(state.emptyEnded, ["c1"]);

		const done = reduceFlowEvent(state, ev.done("Completed", null, 1, {}));
		assert.equal(step(done, "c1").status, "success");
		assert.deepEqual(step(done, "c1").response, { content: "" });
		assert.deepEqual(done.emptyEnded, []);
	});

	it("settles an empty tool_ended on Paused only when its key is not among the questions", () => {
		const before = play([
			ev.toolStarted("c1", "create", { doctype: "ToDo" }),
			ev.toolEnded("c1", "create", ""),
		]);
		const elsewhere = reduceFlowEvent(
			before,
			ev.done("Paused", null, 1, {}, [{ ...QUESTION_CREATE, key: "other" }]),
		);
		assert.equal(step(elsewhere, "c1").status, "success");
		assert.deepEqual(step(elsewhere, "c1").response, { content: "" });

		const awaiting = reduceFlowEvent(
			before,
			ev.done("Paused", null, 1, {}, [{ ...QUESTION_CREATE, key: "c1" }]),
		);
		assert.equal(step(awaiting, "c1").status, "processing");
		assert.equal("response" in step(awaiting, "c1"), false);
		assert.deepEqual(awaiting.emptyEnded, []);
	});

	it("a Completed done settles an empty tool_ended even if a stray question lists its key", () => {
		const before = play([ev.toolStarted("c1", "x", {}), ev.toolEnded("c1", "x", "")]);
		const state = reduceFlowEvent(
			before,
			ev.done("Completed", null, 1, {}, [{ ...QUESTION_CREATE, key: "c1" }]),
		);
		assert.equal(step(state, "c1").status, "success");
	});

	it("leaves a step that never ended untouched on done", () => {
		const state = play([ev.toolStarted("c1", "read", {}), ev.done("Completed", null, 1, {})]);
		assert.equal(step(state, "c1").status, "processing");
	});

	it("drops a stale empty marker when the real result arrives afterwards", () => {
		const state = play([
			ev.toolStarted("c1", "read", {}),
			ev.toolEnded("c1", "read", ""),
			ev.toolEnded("c1", "read", '"ok"'),
		]);
		assert.deepEqual(state.emptyEnded, []);
		assert.equal(step(state, "c1").status, "success");
	});

	describe("result classification", () => {
		function settledStep(result: string): ChainOfThoughtStep {
			return step(play([ev.toolStarted("c1", "x", {}), ev.toolEnded("c1", "x", result)]), "c1");
		}

		it("marks a thrown tool as failure", () => {
			const settled = step(play(TOOL_ERROR.events), CALL_READ);
			assert.equal(settled.status, "failure");
			assert.deepEqual(settled.response, { content: { error: "No permission to read ToDo" } });
			assert.equal(settled.title, "Reading DocType Records: ToDo");
		});

		it("marks a bulk call that created nothing as failure, one that created something as success", () => {
			const allFailed = pyJson({ doctype: "ToDo", created: [], failures: [{ row: 0, error: "Nope" }] });
			assert.equal(settledStep(allFailed).status, "failure");
			const partial = pyJson({
				doctype: "ToDo",
				created: ["TD-9"],
				failures: [{ row: 1, error: "Nope" }],
			});
			assert.equal(settledStep(partial).status, "success");
		});

		it("marks denied and redirected confirmation payloads as failure", () => {
			assert.equal(settledStep(pyJson(deniedPayload)).status, "failure");
			const redirected = settledStep(REDIRECT_RESULT);
			assert.equal(redirected.status, "failure");
			assert.deepEqual(redirected.response, { content: JSON.parse(REDIRECT_RESULT) });
		});

		it("keeps plain text as a string and JSON scalars as their value", () => {
			const text = settledStep("ok");
			assert.equal(text.status, "success");
			assert.deepEqual(text.response, { content: "ok" });
			assert.deepEqual(settledStep("42").response, { content: 42 });
		});
	});
});

describe("reduceFlowEvent: text segmentation", () => {
	it("opens a new segment after a tool call and appends within one", () => {
		const state = play([ev.text("a"), ev.toolStarted("c1", "read", {}), ev.text("b"), ev.text("c")]);
		assert.deepEqual(
			texts(state).map((item) => [item.streaming_metadata?.id, item.text]),
			[
				["text-1", "a"],
				["text-2", "bc"],
			],
		);
		assert.equal(state.textCount, 2);
	});

	it("drops a whitespace-only delta that would open a segment", () => {
		const afterTool = play([ev.text("a"), ev.toolStarted("c1", "read", {})]);
		const padded = reduceFlowEvent(afterTool, ev.text("\n"));
		assert.equal(padded, afterTool);
		assert.equal(texts(padded).length, 1);
		assert.equal(padded.textOpen, false);

		const empty = reduceFlowEvent(START, ev.text("  \n"));
		assert.equal(empty, START);
	});

	it("keeps a whitespace-only delta inside an open segment", () => {
		const state = play([ev.text("a"), ev.text("\n\n"), ev.text("b")]);
		assert.equal(texts(state)[0]?.text, "a\n\nb");
		assert.equal(texts(state).length, 1);
	});

	it("a segment opened by a delta that starts with whitespace keeps it", () => {
		assert.equal(texts(play([ev.text("  hi")]))[0]?.text, "  hi");
	});

	it("the first segment after a leading tool call is text-1", () => {
		const state = play([ev.toolStarted("c1", "read", {}), ev.text("x")]);
		assert.equal(texts(state)[0]?.streaming_metadata?.id, "text-1");
	});
});

describe("reduceFlowEvent: errors", () => {
	it("ERROR_BEFORE_TEXT yields one inline_error item", () => {
		const state = play(ERROR_BEFORE_TEXT.events);
		assert.equal(state.phase, "error");
		assert.deepEqual(items(state), [
			{ response_type: "inline_error", text: ERROR_MESSAGE, streaming_metadata: { id: "error-1" } },
		]);
	});

	it("ERROR_MID_TEXT keeps the partial text before the error item", () => {
		const state = play(ERROR_MID_TEXT.events);
		assert.equal(state.phase, "error");
		assert.equal(state.textOpen, false);
		assert.deepEqual(items(state), [
			{ response_type: "text", text: "Let me ", streaming_metadata: { id: "text-1" } },
			{
				response_type: "inline_error",
				text: "Connection reset by peer",
				streaming_metadata: { id: "error-1" },
			},
		]);
	});

	it("omits text for an empty message", () => {
		const state = play([ev.runStarted(RUN, SESSION), ev.error("")]);
		assert.deepEqual(items(state), [
			{ response_type: "inline_error", streaming_metadata: { id: "error-1" } },
		]);
		assert.equal("text" in (items(state)[0] ?? {}), false);
	});

	it("is idempotent for the same error and numbers distinct ones", () => {
		const once = play([ev.error("boom")]);
		const twice = reduceFlowEvent(once, ev.error("boom"));
		assert.equal(twice, once);
		assert.equal(items(twice).length, 1);

		const other = reduceFlowEvent(once, ev.error("bang"));
		assert.deepEqual(
			items(other).map((item) => item.streaming_metadata?.id),
			["error-1", "error-2"],
		);
	});

	it("fails every step still processing, and nothing else", () => {
		const state = play([
			ev.toolStarted("a", "read", { doctype: "ToDo" }),
			ev.toolStarted("b", "read", {}),
			ev.toolEnded("a", "read", '"fine"'),
			ev.toolStarted("c", "read", {}),
			ev.toolEnded("c", "read", ""),
			ev.error("boom"),
		]);
		assert.deepEqual(
			steps(state).map((entry) => [entry.tool_call_id, entry.status]),
			[
				["a", "success"],
				["b", "failure"],
				["c", "failure"],
			],
		);
		assert.equal("response" in step(state, "b"), false);
		assert.deepEqual(state.emptyEnded, []);
	});

	it("ERROR_AFTER_DONE keeps the text and its feedback, and adds the error", () => {
		const state = play(ERROR_AFTER_DONE.events);
		assert.equal(state.phase, "error");
		assert.deepEqual(items(state), [
			{
				response_type: "text",
				text: "Hi.",
				streaming_metadata: { id: "text-1" },
				message_item_options: { feedback: { is_on: true, id: RUN } },
			},
			{
				response_type: "inline_error",
				text: "Data too long for column 'output' at row 1",
				streaming_metadata: { id: "error-1" },
			},
		]);
	});

	it("drops the open approval card when a persist failure follows a Paused done", () => {
		const paused = play(PAUSED_TWO_QUESTIONS.events);
		assert.equal(items(paused).filter(isFlowApprovalItem).length, 1);
		const state = reduceFlowEvent(paused, ev.error("Data too long"));
		assert.equal(state.phase, "error");
		assert.deepEqual(
			items(state).map((item) => item.response_type),
			["text", "inline_error"],
		);
		assert.ok(steps(state).every((entry) => entry.status !== "processing"));
		assert.equal(reduceFlowEvent(state, ev.error("Data too long")), state);
	});

	it("keeps a locked approval card, which records decisions already sent, on error", () => {
		const resumed = play(
			[ev.error("boom")],
			resumeStreamState(play(PAUSED_TWO_QUESTIONS.events).response, ANSWERS_DENY),
		);
		const cards = items(resumed).filter(isFlowApprovalItem);
		assert.equal(cards.length, 1);
		assert.deepEqual(cards[0]?.user_defined.answers, ANSWERS_DENY);
	});

	it("ignores a done that arrives after an error", () => {
		const errored = play(ERROR_BEFORE_TEXT.events);
		assert.equal(reduceFlowEvent(errored, ev.done("Completed", "late", 1, {})), errored);
		assert.equal(reduceFlowEvent(errored, ev.done("Paused", null, 1, {}, [QUESTION_CREATE])), errored);
	});
});

describe("reduceFlowEvent: done", () => {
	it("appends output as text when no deltas were streamed", () => {
		const state = play([ev.runStarted(RUN, SESSION), ev.done("Completed", "Hi", 1, {})]);
		assert.deepEqual(items(state), [
			{
				response_type: "text",
				text: "Hi",
				streaming_metadata: { id: "text-1" },
				message_item_options: { feedback: { is_on: true, id: RUN } },
			},
		]);
		assert.equal(state.textCount, 1);
	});

	it("adds nothing when text was streamed, or output is blank or null", () => {
		const streamed = play([ev.text("Hi there"), ev.done("Completed", "Hi there, again", 1, {})]);
		assert.equal(texts(streamed).length, 1);
		assert.equal(texts(streamed)[0]?.text, "Hi there");

		assert.equal(items(play([ev.done("Completed", "  \n", 1, {})])).length, 0);
		assert.equal(items(play([ev.done("Completed", null, 1, {})])).length, 0);
	});

	it("adds the fallback when the last item is a card, not text, even if earlier text exists", () => {
		const resumed = resumeStreamState(play(PAUSED_TWO_QUESTIONS.events).response, ANSWERS_APPROVE_ALL);
		const state = play([ev.runStarted(RUN, SESSION), ev.done("Completed", "after", 1, {})], resumed);
		assert.deepEqual(
			texts(state).map((item) => item.text),
			["I'll create that ToDo and remove the old one.", "after"],
		);
		assert.deepEqual(feedbackOn(state), ["text-2"]);
	});

	it("a step after the text does not trigger the fallback: only generic items count", () => {
		const state = play([
			ev.text("before"),
			ev.toolStarted("c", "read", {}),
			ev.done("Completed", "after", 1, {}),
		]);
		assert.deepEqual(
			texts(state).map((item) => item.text),
			["before"],
		);
	});

	it("attaches no feedback without a run, or without any text", () => {
		assert.deepEqual(feedbackOn(play([ev.text("Hi"), ev.done("Completed", "Hi", 1, {})])), []);
		assert.deepEqual(feedbackOn(play([ev.runStarted(RUN, SESSION), ev.done("Completed", null, 0, {})])), []);
	});

	it("a Paused done with no questions pauses without a card", () => {
		const state = play([ev.runStarted(RUN, SESSION), ev.text("x"), ev.done("Paused", null, 1, {})]);
		assert.equal(state.phase, "paused");
		assert.equal(items(state).length, 1);
		assert.deepEqual(feedbackOn(state), []);
	});

	it("a duplicate Paused done refreshes the open card in place", () => {
		const first = play(PAUSED_TWO_QUESTIONS.events);
		const second = reduceFlowEvent(first, ev.done("Paused", null, 1, {}, [QUESTION_CREATE, QUESTION_DELETE]));
		assert.deepEqual(items(second), items(first));
		assert.equal(items(second).filter(isFlowApprovalItem).length, 1);
	});

	it("a duplicate Completed done is idempotent", () => {
		const first = play(TEXT_TOOL_TEXT.events);
		const second = reduceFlowEvent(first, ev.done("Completed", null, 2, {}));
		assert.deepEqual(second, first);
		assert.equal(second.response, first.response);
	});

	it("never throws or corrupts the phase on a Completed done after a pause", () => {
		const state = reduceFlowEvent(play(PAUSED_TWO_QUESTIONS.events), ev.done("Completed", null, 1, {}));
		assert.equal(state.phase, "complete");
		assert.equal(step(state, CALL_CREATE).status, "processing");
	});
});

describe("resume into the same response", () => {
	const paused = play(PAUSED_TWO_QUESTIONS.events);

	it("builds a streaming state with the card locked", () => {
		const resumed = resumeStreamState(paused.response, ANSWERS_APPROVE_ALL);
		assert.equal(resumed.phase, "streaming");
		assert.equal(resumed.run, RUN);
		assert.equal(resumed.session, null);
		assert.equal(resumed.textCount, 1);
		assert.equal(resumed.textOpen, false);
		assert.deepEqual(resumed.emptyEnded, []);
		assert.deepEqual(resumed.unmatched, []);
		const card = items(resumed).at(-1);
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, ANSWERS_APPROVE_ALL);
		assert.equal(resumed.response.id, "resp");
	});

	it("has run null and textCount 0 for a response with neither card nor text", () => {
		const bare = resumeStreamState(START.response, {});
		assert.equal(bare.run, null);
		assert.equal(bare.textCount, 0);
	});

	it("approved: settles both steps, continues with text-2, feedback on the last text only", () => {
		const resumed = resumeStreamState(paused.response, ANSWERS_APPROVE_ALL);
		const state = play(RESUME_APPROVED.events, resumed);
		assert.equal(state.response.id, "resp");
		assert.equal(state.phase, "complete");
		assert.equal(state.session, SESSION);
		assert.deepEqual(state.unmatched, []);
		assert.equal(step(state, CALL_CREATE).status, "success");
		assert.deepEqual(step(state, CALL_CREATE).response, { content: createdPayload });
		assert.equal(step(state, CALL_DELETE).status, "success");
		assert.deepEqual(step(state, CALL_DELETE).response, { content: deletedPayload });
		assert.deepEqual(step(state, CALL_CREATE).request, { args: CREATE_ARGS });

		assert.deepEqual(
			items(state).map((item) => item.streaming_metadata?.id),
			["text-1", "approval-1", "text-2"],
		);
		assert.equal(texts(state)[1]?.text, "Done. I created TD-0003 and deleted TD-0001.");
		const card = items(state)[1];
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, ANSWERS_APPROVE_ALL);
		assert.deepEqual(feedbackOn(state), ["text-2"]);
	});

	it("denied: the denied call fails, the approved one ran, no new text, feedback on text-1", () => {
		const state = play(RESUME_DENIED.events, resumeStreamState(paused.response, ANSWERS_DENY));
		assert.equal(state.phase, "complete");
		assert.equal(step(state, CALL_CREATE).status, "failure");
		assert.deepEqual(step(state, CALL_CREATE).response, { content: deniedPayload });
		assert.equal(step(state, CALL_DELETE).status, "success");
		assert.deepEqual(
			items(state).map((item) => item.streaming_metadata?.id),
			["text-1", "approval-1"],
		);
		assert.deepEqual(feedbackOn(state), ["text-1"]);
		const card = items(state)[1];
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, ANSWERS_DENY);
	});

	it("redirected and paused again: a second card, the first locked", () => {
		const state = play(
			RESUME_REDIRECTED_PAUSED_AGAIN.events,
			resumeStreamState(paused.response, ANSWERS_REDIRECT),
		);
		assert.equal(state.phase, "paused");
		assert.equal(step(state, CALL_CREATE).status, "failure");
		assert.equal(step(state, CALL_DELETE).status, "success");
		assert.equal(step(state, CALL_CREATE_AGAIN).status, "processing");
		assert.deepEqual(step(state, CALL_CREATE_AGAIN).request, { args: CREATE_HIGH_ARGS });
		assert.deepEqual(
			steps(state).map((entry) => entry.tool_call_id),
			[CALL_CREATE, CALL_DELETE, CALL_CREATE_AGAIN],
		);
		assert.deepEqual(
			items(state).map((item) => item.streaming_metadata?.id),
			["text-1", "approval-1", "text-2", "approval-2"],
		);
		const [, first, , second] = items(state);
		assert.ok(isFlowApprovalItem(first));
		assert.ok(isFlowApprovalItem(second));
		assert.deepEqual(first.user_defined.answers, ANSWERS_REDIRECT);
		assert.equal("answers" in second.user_defined, false);
		assert.deepEqual(second.user_defined.questions, [QUESTION_CREATE_AGAIN]);
		assert.deepEqual(feedbackOn(state), []);
	});
});

describe("resume into a new response", () => {
	const paused = play(PAUSED_TWO_QUESTIONS.events);
	const fresh = play(RESUME_APPROVED.events, initialStreamState({ id: "new" }));

	it("collects the replayed results without inventing steps", () => {
		assert.deepEqual(steps(fresh), []);
		assert.deepEqual(
			fresh.unmatched.map((entry) => entry.id),
			[CALL_CREATE, CALL_DELETE],
		);
		assert.deepEqual(
			texts(fresh).map((item) => [item.streaming_metadata?.id, item.text]),
			[["text-1", "Done. I created TD-0003 and deleted TD-0001."]],
		);
		assert.equal(fresh.phase, "complete");
	});

	it("applyToolResults and lockApproval bring the old response up to date", () => {
		const updated = lockApproval(applyToolResults(paused.response, fresh.unmatched), ANSWERS_APPROVE_ALL);
		const state: StreamState = { ...paused, response: updated };
		assert.equal(step(state, CALL_CREATE).status, "success");
		assert.deepEqual(step(state, CALL_CREATE).response, { content: createdPayload });
		assert.equal(step(state, CALL_DELETE).status, "success");
		const card = items(state).at(-1);
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, ANSWERS_APPROVE_ALL);
	});

	it("ignores unknown ids and empty results, returning the same response", () => {
		const stray: ToolEndedEvent[] = [
			ev.toolEnded("call_nobody", "read", '{"a":1}'),
			ev.toolEnded(CALL_CREATE, "create", ""),
		];
		assert.equal(applyToolResults(paused.response, stray), paused.response);
		assert.equal(applyToolResults(paused.response, []), paused.response);
		const mixed = applyToolResults(paused.response, [
			...stray,
			ev.toolEnded(CALL_DELETE, "delete", pyJson(deletedPayload)),
		]);
		assert.notEqual(mixed, paused.response);
		const state: StreamState = { ...paused, response: mixed };
		assert.equal(step(state, CALL_DELETE).status, "success");
		assert.equal(step(state, CALL_CREATE).status, "processing");
	});

	it("applies a denied result as failure", () => {
		const settled = applyToolResults(paused.response, [
			ev.toolEnded(CALL_CREATE, "create", pyJson(deniedPayload)),
		]);
		assert.equal(step({ ...paused, response: settled }, CALL_CREATE).status, "failure");
	});
});

describe("lockApproval", () => {
	const paused = play(PAUSED_TWO_QUESTIONS.events);

	it("copies the answers", () => {
		const answers: Record<string, string> = { [CALL_CREATE]: "Approve" };
		const locked = lockApproval(paused.response, answers);
		answers[CALL_CREATE] = "Deny";
		answers["extra"] = "x";
		const card = locked.output.generic.at(-1);
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, { [CALL_CREATE]: "Approve" });
	});

	it("returns the same response when no card is unlocked", () => {
		assert.equal(lockApproval(START.response, ANSWERS_DENY), START.response);
		const locked = lockApproval(paused.response, ANSWERS_DENY);
		assert.equal(lockApproval(locked, ANSWERS_APPROVE_ALL), locked);
	});

	it("never overwrites an already locked card", () => {
		const locked = lockApproval(paused.response, ANSWERS_DENY);
		const again = lockApproval(locked, ANSWERS_APPROVE_ALL);
		const card = again.output.generic.at(-1);
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.answers, ANSWERS_DENY);
	});

	it("a later duplicate Paused done adds approval-2 instead of replacing a locked card", () => {
		const locked = resumeStreamState(paused.response, ANSWERS_APPROVE_ALL);
		const state = reduceFlowEvent(locked, ev.done("Paused", null, 1, {}, [QUESTION_CREATE_AGAIN]));
		assert.deepEqual(
			items(state).map((item) => item.streaming_metadata?.id),
			["text-1", "approval-1", "approval-2"],
		);
		const [, first, second] = items(state);
		assert.ok(isFlowApprovalItem(first));
		assert.ok(isFlowApprovalItem(second));
		assert.deepEqual(first.user_defined.questions, [QUESTION_CREATE, QUESTION_DELETE]);
		assert.deepEqual(first.user_defined.answers, ANSWERS_APPROVE_ALL);
		assert.deepEqual(second.user_defined.questions, [QUESTION_CREATE_AGAIN]);
	});
});

describe("stopStream", () => {
	it("flags the open text item, fails running steps and adds no feedback", () => {
		const state = stopStream(
			play([ev.runStarted(RUN, SESSION), ev.toolStarted("c1", "read", {}), ev.text("partial")]),
		);
		assert.equal(state.phase, "complete");
		assert.equal(state.textOpen, false);
		assert.deepEqual(items(state), [
			{ response_type: "text", text: "partial", streaming_metadata: { id: "text-1", stream_stopped: true } },
		]);
		assert.equal(step(state, "c1").status, "failure");
		assert.deepEqual(feedbackOn(state), []);
	});

	it("flags the last text item even when a tool step came after it", () => {
		const state = stopStream(play([ev.text("a"), ev.toolStarted("c1", "read", {})]));
		assert.equal(texts(state)[0]?.streaming_metadata?.stream_stopped, true);
		assert.equal(step(state, "c1").status, "failure");
	});

	it("flags only the last item when several carry streaming_metadata", () => {
		const state = stopStream(
			play([
				ev.text("a"),
				ev.toolStarted("c1", "read", {}),
				ev.toolEnded("c1", "read", '"ok"'),
				ev.text("b"),
			]),
		);
		assert.deepEqual(
			texts(state).map((item) => item.streaming_metadata),
			[{ id: "text-1" }, { id: "text-2", stream_stopped: true }],
		);
	});

	it("leaves settled steps alone and handles an empty draft", () => {
		const state = stopStream(
			play([
				ev.toolStarted("c1", "read", {}),
				ev.toolEnded("c1", "read", '"ok"'),
				ev.toolStarted("c2", "read", {}),
			]),
		);
		assert.equal(step(state, "c1").status, "success");
		assert.equal(step(state, "c2").status, "failure");
		const empty = stopStream(START);
		assert.equal(empty.phase, "complete");
		assert.deepEqual(items(empty), []);
	});

	it("returns the same state unless streaming", () => {
		for (const events of [TEXT_ONLY.events, PAUSED_TWO_QUESTIONS.events, ERROR_BEFORE_TEXT.events]) {
			const state = play(events);
			assert.equal(stopStream(state), state);
		}
	});
});

describe("messageStateFor", () => {
	it("maps the phase to a message state", () => {
		assert.equal(messageStateFor("streaming"), "streaming");
		assert.equal(messageStateFor("complete"), "complete");
		assert.equal(messageStateFor("paused"), "complete");
		assert.equal(messageStateFor("error"), "error");
	});
});

describe("immutability", () => {
	it("never mutates a deep-frozen state or event", () => {
		for (const [name, transcript] of ALL_TRANSCRIPTS) {
			let state = deepFreeze(structuredClone(START));
			for (const event of structuredClone(transcript.events)) {
				deepFreeze(event);
				const before = state;
				const snapshot = structuredClone(before);
				assert.doesNotThrow(() => {
					state = deepFreeze(reduceFlowEvent(before, event));
				}, name);
				assert.deepEqual(before, snapshot, name);
			}
		}
	});

	it("keeps a previous state equal to its snapshot after reducing further", () => {
		for (const [name, transcript] of ALL_TRANSCRIPTS) {
			const states: StreamState[] = [START];
			const snapshots = [structuredClone(START)];
			for (const event of transcript.events) {
				const next = reduceFlowEvent(states[states.length - 1] ?? START, event);
				states.push(next);
				snapshots.push(structuredClone(next));
			}
			states.forEach((state, index) => assert.deepEqual(state, snapshots[index], `${name} #${index}`));
		}
	});

	it("freezes through resume, stop, lock and apply too", () => {
		const paused = deepFreeze(play(PAUSED_TWO_QUESTIONS.events));
		const resumed = deepFreeze(resumeStreamState(paused.response, ANSWERS_APPROVE_ALL));
		assert.doesNotThrow(() => play(RESUME_APPROVED.events, resumed));
		assert.doesNotThrow(() => stopStream(resumed));
		assert.doesNotThrow(() =>
			applyToolResults(
				paused.response,
				RESUME_APPROVED.events.filter((e) => e.type === "tool_ended"),
			),
		);
		assert.doesNotThrow(() => lockApproval(paused.response, ANSWERS_DENY));
	});
});

describe("structural sharing", () => {
	it("appending to the open segment shares everything but the edited item", () => {
		const prev = play([ev.text("a"), ev.toolStarted("c1", "read", {}), ev.text("b")]);
		const next = reduceFlowEvent(prev, ev.text("c"));
		assert.equal(items(next).length, items(prev).length);
		assert.equal(items(next)[0], items(prev)[0]);
		assert.notEqual(items(next)[1], items(prev)[1]);
		assert.equal(texts(prev)[1]?.text, "b");
		assert.equal(texts(next)[1]?.text, "bc");
		assert.notEqual(items(next), items(prev));
		assert.equal(next.response.message_options, prev.response.message_options);
	});

	it("opening a segment shares earlier items and the step list", () => {
		const prev = play([ev.text("a"), ev.toolStarted("c1", "read", {})]);
		const next = reduceFlowEvent(prev, ev.text("b"));
		assert.equal(items(next)[0], items(prev)[0]);
		assert.equal(items(prev).length, 1);
		assert.equal(items(next).length, 2);
		assert.equal(next.response.message_options, prev.response.message_options);
	});

	it("updating one step keeps the other steps and the output by identity", () => {
		const prev = play([ev.text("a"), ev.toolStarted("c1", "read", {}), ev.toolStarted("c2", "describe", {})]);
		const next = reduceFlowEvent(prev, ev.toolEnded("c2", "describe", '{"fields": []}'));
		assert.equal(steps(next)[0], steps(prev)[0]);
		assert.notEqual(steps(next)[1], steps(prev)[1]);
		assert.equal(step(prev, "c2").status, "processing");
		assert.equal(next.response.output, prev.response.output);
		assert.equal(items(next)[0], items(prev)[0]);
	});

	it("an error shares unaffected steps and earlier items", () => {
		const prev = play([
			ev.text("a"),
			ev.toolStarted("c1", "read", {}),
			ev.toolEnded("c1", "read", '"x"'),
			ev.toolStarted("c2", "read", {}),
		]);
		const next = reduceFlowEvent(prev, ev.error("boom"));
		assert.equal(steps(next)[0], steps(prev)[0]);
		assert.equal(items(next)[0], items(prev)[0]);
	});
});

describe("totality", () => {
	it("survives events out of order, duplicated, and for unknown ids", () => {
		const sequences: FlowEvent[][] = [
			[
				ev.toolEnded("ghost", "read", '"x"'),
				ev.toolStarted("ghost", "read", {}),
				ev.done("Completed", null, 0, {}),
			],
			[ev.done("Completed", "x", 1, {}), ev.done("Completed", "x", 1, {}), ev.text("late")],
			[
				ev.toolStarted("c", "read", {}),
				ev.done("Paused", null, 1, {}, [QUESTION_CREATE]),
				ev.toolStarted("c", "read", {}),
			],
			[ev.runStarted("a", "s1"), ev.runStarted("b", "s2"), ev.error(""), ev.text("x"), ev.error("")],
			[ev.text(""), ev.text(""), ev.toolEnded("c", "read", ""), ev.toolEnded("c", "read", "")],
			[
				ev.done("Paused", null, 1, {}, [{ ...QUESTION_CREATE, key: null }]),
				ev.error("x"),
				ev.done("Paused", null, 1, {}),
			],
		];
		for (const events of sequences) assert.doesNotThrow(() => play(events));
	});

	it("later run_started overrides run and session; the same pair is a no-op", () => {
		const first = reduceFlowEvent(START, ev.runStarted("a", "s1"));
		assert.equal(first.run, "a");
		assert.equal(first.session, "s1");
		assert.equal(reduceFlowEvent(first, ev.runStarted("a", "s1")), first);
		const second = reduceFlowEvent(first, ev.runStarted("b", "s2"));
		assert.equal(second.run, "b");
		assert.equal(second.session, "s2");
	});

	it("returns the identical state for no-op events", () => {
		const open = play([ev.runStarted(RUN, SESSION), ev.text("a")]);
		assert.equal(reduceFlowEvent(open, ev.text("")), open);
		assert.equal(reduceFlowEvent(open, ev.runStarted(RUN, SESSION)), open);

		const withTool = play([ev.toolStarted("c1", "read", { doctype: "ToDo" })]);
		assert.equal(reduceFlowEvent(withTool, ev.toolStarted("c1", "read", {})), withTool);

		const emptied = play([ev.toolStarted("c1", "read", {}), ev.toolEnded("c1", "read", "")]);
		assert.equal(reduceFlowEvent(emptied, ev.toolEnded("c1", "read", "")), emptied);

		const strayed = reduceFlowEvent(START, ev.toolEnded("ghost", "read", '"x"'));
		assert.equal(reduceFlowEvent(strayed, ev.toolEnded("ghost", "read", '"x"')), strayed);
		assert.equal(strayed.unmatched.length, 1);
		assert.equal(strayed.response, START.response);
	});

	it("replaces an unmatched entry with the same id", () => {
		const state = play([ev.toolEnded("ghost", "read", '"x"'), ev.toolEnded("ghost", "read", '"y"')]);
		assert.deepEqual(state.unmatched, [ev.toolEnded("ghost", "read", '"y"')]);
	});

	it("keeps invariants under shuffled, duplicated and dropped events", () => {
		const pool = ALL_TRANSCRIPTS.flatMap(([, transcript]) => transcript.events);
		let seed = 0x2f6e2b1;
		const random = (): number => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		for (let round = 0; round < 300; round++) {
			const events: FlowEvent[] = [];
			const length = 1 + Math.floor(random() * 40);
			for (let i = 0; i < length; i++) {
				const event = pool[Math.floor(random() * pool.length)];
				if (event === undefined || random() < 0.15) continue;
				events.push(event);
				if (random() < 0.2) events.push(event);
			}
			let state = START;
			for (const event of events) {
				state = reduceFlowEvent(state, event);
				if (random() < 0.05) state = stopStream(state);
			}
			const ids = items(state).map((item) => item.streaming_metadata?.id);
			assert.equal(new Set(ids).size, ids.length, `round ${round}: duplicate item ids ${ids.join(",")}`);
			const stepIds = steps(state).map((entry) => entry.tool_call_id);
			assert.equal(new Set(stepIds).size, stepIds.length, `round ${round}: duplicate step ids`);
			assert.ok(
				state.textCount >= texts(state).length,
				`round ${round}: textCount ${state.textCount} < ${texts(state).length}`,
			);
		}
	});
});
