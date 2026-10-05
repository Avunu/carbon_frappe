import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
	FlowRunDoc,
	FlowSessionAttachmentRow,
	FlowSessionDoc,
	FlowSessionMessageRow,
} from "../../../carbon_frappe/public/js/ai_chat/flow/docs.ts";
import { pausedRun, sessionToMessages } from "../../../carbon_frappe/public/js/ai_chat/flow/history.ts";
import { initialStreamState, reduceFlowEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/reduce.ts";
import type { FlowEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import { attachmentChipsOf, fileFieldFor } from "../../../carbon_frappe/public/js/ai_chat/uploads.ts";
import {
	isFlowApprovalItem,
	isInlineErrorItem,
	isRequest,
	isResponse,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import type {
	GenericItem,
	Message,
	MessageRequest,
	MessageResponse,
	TextItem,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import {
	CALL_CREATE,
	CALL_DELETE,
	CALL_READ,
	CREATE_ARGS,
	DELETE_ARGS,
	PAUSED_TWO_QUESTIONS,
	QUESTION_CREATE,
	QUESTION_DELETE,
	READ_ARGS,
	READ_RESULT,
	RUN,
	RUN_1,
	RUN_2,
	RUN_3,
	RUN_4,
	SESSION,
	SESSION_COMPLETED,
	SESSION_DENIED,
	SESSION_EMPTY,
	SESSION_INTERRUPTED_NO_ERROR,
	SESSION_MALFORMED,
	SESSION_PAUSED,
	TEXT_TOOL_TEXT,
	pyJson,
} from "./fixtures.ts";

// -- helpers ------------------------------------------------------------------

function at<T>(list: readonly T[], index: number): T {
	const value = list[index];
	if (value === undefined) throw new Error(`no element at ${index} (length ${list.length})`);
	return value;
}

function requestsOf(messages: Message[]): MessageRequest[] {
	return messages.filter(isRequest);
}

function responsesOf(messages: Message[]): MessageResponse[] {
	return messages.filter(isResponse);
}

function kinds(messages: Message[]): string[] {
	return messages.map((message) => (isRequest(message) ? "request" : "response"));
}

function ids(messages: Message[]): (string | undefined)[] {
	return messages.map((message) => message.id);
}

function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const entry of Object.values(value)) deepFreeze(entry);
}

function frozen<T>(value: T): T {
	const copy = structuredClone(value);
	deepFreeze(copy);
	return copy;
}

function textItem(n: number, text: string, feedbackRun?: string): TextItem {
	return {
		response_type: "text",
		text,
		streaming_metadata: { id: `text-${n}` },
		...(feedbackRun !== undefined && {
			message_item_options: { feedback: { is_on: true, id: feedbackRun } },
		}),
	};
}

function doc(messages: FlowSessionMessageRow[]): FlowSessionDoc {
	return { name: SESSION, messages, attachments: [] };
}

function runDoc(name: string, status: FlowRunDoc["status"], extra: Partial<FlowRunDoc> = {}): FlowRunDoc {
	return { name, session: SESSION, status, ...extra };
}

function callsJson(calls: readonly { id: string; name: string; args: Record<string, unknown> }[]): string {
	return JSON.stringify(
		calls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args) },
		})),
	);
}

function lastItem(response: MessageResponse): GenericItem | undefined {
	return response.output.generic.at(-1);
}

const TODO_ROWS = JSON.parse(READ_RESULT);

const CALL_READ_STEP = {
	tool_call_id: CALL_READ,
	tool_name: "read",
	title: "Reading DocType Records: ToDo",
	status: "success",
	request: { args: READ_ARGS },
	response: { content: TODO_ROWS },
};

const FINAL_TEXT = "You have **2** open ToDos:\n\n- TD-0001: Call Alice\n- TD-0002: Send the Q3 report";

// -- pausedRun ----------------------------------------------------------------

describe("pausedRun", () => {
	it("returns the Paused run that has questions", () => {
		const [run] = SESSION_PAUSED.runs;
		assert.equal(pausedRun(SESSION_PAUSED.runs), run);
	});

	it("is undefined for no runs, non-paused runs, and unparseable or empty questions", () => {
		assert.equal(pausedRun([]), undefined);
		assert.equal(pausedRun(SESSION_COMPLETED.runs), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Paused", { questions: "not json" })]), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Paused", { questions: "[]" })]), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Paused", { questions: '{"prompt": "x"}' })]), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Paused", { questions: null })]), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Paused")]), undefined);
		assert.equal(pausedRun([runDoc(RUN, "Running", { questions: pyJson([QUESTION_CREATE]) })]), undefined);
	});

	it("accepts already-parsed questions", () => {
		const run = runDoc(RUN, "Paused", { questions: [QUESTION_CREATE] });
		assert.equal(pausedRun([run]), run);
	});

	it("prefers the later of two Paused runs, but skips a later one without questions", () => {
		const early = runDoc(RUN_1, "Paused", { questions: pyJson([QUESTION_CREATE]) });
		const late = runDoc(RUN_2, "Paused", { questions: pyJson([QUESTION_DELETE]) });
		assert.equal(pausedRun([early, late]), late);
		const broken = runDoc(RUN_3, "Paused", { questions: "garbage" });
		assert.equal(pausedRun([early, broken]), early);
	});
});

// -- sessionToMessages --------------------------------------------------------

describe("sessionToMessages: completed conversation", () => {
	const messages = sessionToMessages(SESSION_COMPLETED.session, SESSION_COMPLETED.runs);

	it("yields request, response, request, response with deterministic linked ids", () => {
		assert.deepEqual(kinds(messages), ["request", "response", "request", "response"]);
		assert.deepEqual(ids(messages), [
			`request-${RUN_1}`,
			`response-${RUN_1}`,
			`request-${RUN_2}`,
			`response-${RUN_2}`,
		]);
		const [first, second] = responsesOf(messages);
		assert.equal(first?.request_id, `request-${RUN_1}`);
		assert.equal(second?.request_id, `request-${RUN_2}`);
	});

	it("builds the requests as text input", () => {
		assert.deepEqual(requestsOf(messages), [
			{ id: `request-${RUN_1}`, input: { message_type: "text", text: "What are my open todos?" } },
			{ id: `request-${RUN_2}`, input: { message_type: "text", text: "Thanks!" } },
		]);
	});

	it("merges assistant, tool, assistant rows into one response; the system row adds nothing", () => {
		assert.deepEqual(at(responsesOf(messages), 0), {
			id: `response-${RUN_1}`,
			request_id: `request-${RUN_1}`,
			output: {
				generic: [textItem(1, "Let me check your open ToDos. "), textItem(2, FINAL_TEXT, RUN_1)],
			},
			message_options: { chain_of_thought: [CALL_READ_STEP] },
			history: { feedback: { [RUN_1]: { is_positive: true } } },
		});
	});

	it("attaches a thumbs-down with its comment to the second response", () => {
		assert.deepEqual(at(responsesOf(messages), 1), {
			id: `response-${RUN_2}`,
			request_id: `request-${RUN_2}`,
			output: { generic: [textItem(1, "Anytime.", RUN_2)] },
			message_options: { chain_of_thought: [] },
			history: { feedback: { [RUN_2]: { is_positive: false, text: "Too curt" } } },
		});
	});

	it("has no feedback options and no history when the runs are unknown", () => {
		const bare = sessionToMessages(SESSION_COMPLETED.session, []);
		assert.deepEqual(kinds(bare), ["request", "response", "request", "response"]);
		for (const response of responsesOf(bare)) {
			assert.equal(response.history, undefined);
			assert.equal("history" in response, false);
			for (const item of response.output.generic) assert.equal("message_item_options" in item, false);
		}
		assert.deepEqual(at(responsesOf(bare), 0).output.generic, [
			textItem(1, "Let me check your open ToDos. "),
			textItem(2, FINAL_TEXT),
		]);
	});

	it("omits a rating of '' and a rating without a Completed or Failed run", () => {
		const runs = [
			runDoc(RUN_1, "Completed", { feedback_rating: "" }),
			runDoc(RUN_2, "Running", { feedback_rating: "Up" }),
		];
		const [first, second] = responsesOf(sessionToMessages(SESSION_COMPLETED.session, runs));
		assert.equal(first?.history, undefined);
		assert.deepEqual(first?.output.generic.at(-1), textItem(2, FINAL_TEXT, RUN_1));
		assert.equal(second?.history, undefined);
		assert.deepEqual(second?.output.generic, [textItem(1, "Anytime.")]);
	});
});

describe("sessionToMessages: paused run", () => {
	it("keeps both calls processing and ends with an unlocked approval card", () => {
		const messages = sessionToMessages(SESSION_PAUSED.session, SESSION_PAUSED.runs);
		assert.deepEqual(kinds(messages), ["request", "response"]);
		const response = at(responsesOf(messages), 0);
		assert.deepEqual(response.output.generic, [
			textItem(1, "I'll create that ToDo and remove the old one."),
			{
				response_type: "user_defined",
				streaming_metadata: { id: "approval-1" },
				user_defined: {
					user_defined_type: "flow_approval",
					run: RUN,
					questions: [QUESTION_CREATE, QUESTION_DELETE],
				},
			},
		]);
		const card = lastItem(response);
		assert.ok(isFlowApprovalItem(card));
		assert.equal("answers" in card.user_defined, false);
		assert.deepEqual(response.message_options?.chain_of_thought, [
			{
				tool_call_id: CALL_CREATE,
				tool_name: "create",
				title: "Creating Records: ToDo",
				status: "processing",
				request: { args: CREATE_ARGS },
			},
			{
				tool_call_id: CALL_DELETE,
				tool_name: "delete",
				title: "Deleting Records: ToDo",
				status: "processing",
				request: { args: DELETE_ARGS },
			},
		]);
		assert.equal(response.history, undefined);
		for (const item of response.output.generic) assert.equal("message_item_options" in item, false);
	});

	it("fails the calls and shows no card when the run list is missing", () => {
		const response = at(responsesOf(sessionToMessages(SESSION_PAUSED.session, [])), 0);
		assert.deepEqual(response.output.generic, [textItem(1, "I'll create that ToDo and remove the old one.")]);
		assert.deepEqual(
			response.message_options?.chain_of_thought?.map((step) => step.status),
			["failure", "failure"],
		);
	});

	it("keeps only the calls named by a question key processing", () => {
		const runs = [runDoc(RUN, "Paused", { questions: pyJson([QUESTION_DELETE]) })];
		const response = at(responsesOf(sessionToMessages(SESSION_PAUSED.session, runs)), 0);
		assert.deepEqual(
			response.message_options?.chain_of_thought?.map((step) => [step.tool_call_id, step.status]),
			[
				[CALL_CREATE, "failure"],
				[CALL_DELETE, "processing"],
			],
		);
		const card = lastItem(response);
		assert.ok(isFlowApprovalItem(card));
		assert.deepEqual(card.user_defined.questions, [QUESTION_DELETE]);
	});

	it("does not attach the card or keep calls processing for a response of another run", () => {
		const runs = [
			runDoc(RUN, "Completed"),
			runDoc(RUN_4, "Paused", { questions: pyJson([QUESTION_CREATE]) }),
		];
		const response = at(responsesOf(sessionToMessages(SESSION_PAUSED.session, runs)), 0);
		assert.equal(response.output.generic.some(isFlowApprovalItem), false);
		assert.deepEqual(
			response.message_options?.chain_of_thought?.map((step) => step.status),
			["failure", "failure"],
		);
	});
});

describe("sessionToMessages: denied resume", () => {
	it("settles the denied call as failure and the executed one as success, with no card", () => {
		const messages = sessionToMessages(SESSION_DENIED.session, SESSION_DENIED.runs);
		const response = at(responsesOf(messages), 0);
		assert.deepEqual(response.output.generic, [
			textItem(1, "I'll create that ToDo and remove the old one.", RUN),
		]);
		assert.deepEqual(response.message_options?.chain_of_thought, [
			{
				tool_call_id: CALL_CREATE,
				tool_name: "create",
				title: "Creating Records: ToDo",
				status: "failure",
				request: { args: CREATE_ARGS },
				response: { content: { status: "denied", message: "User denied this tool call." } },
			},
			{
				tool_call_id: CALL_DELETE,
				tool_name: "delete",
				title: "Deleting Records: ToDo",
				status: "success",
				request: { args: DELETE_ARGS },
				response: { content: { doctype: "ToDo", deleted: ["TD-0001"] } },
			},
		]);
	});
});

describe("sessionToMessages: malformed rows", () => {
	const messages = sessionToMessages(SESSION_MALFORMED.session, SESSION_MALFORMED.runs);
	const responses = responsesOf(messages);

	it("produces request/response pairs in order with unique ids", () => {
		assert.deepEqual(kinds(messages), ["request", "response", "request", "response", "request", "response"]);
		assert.deepEqual(ids(messages), [
			`request-${RUN_3}`,
			`response-${RUN_3}`,
			`request-${RUN_4}`,
			`response-${RUN_4}`,
			`request-${RUN_1}`,
			`response-${RUN_1}`,
		]);
		assert.equal(new Set(ids(messages)).size, messages.length);
	});

	it("skips the orphan leading tool row and the unmatched tool row", () => {
		const first = at(responses, 0);
		assert.deepEqual(
			first.message_options?.chain_of_thought?.map((step) => step.tool_call_id),
			["call_ok", "call_trunc"],
		);
		assert.equal(JSON.stringify(first).includes("orphan"), false);
		assert.equal(JSON.stringify(first).includes("plain text, not JSON"), false);
	});

	it("builds the steps from the intact calls only and classifies their results", () => {
		const first = at(responses, 0);
		assert.deepEqual(first.message_options?.chain_of_thought, [
			{
				tool_call_id: "call_ok",
				tool_name: "read",
				title: "Reading DocType Records: ToDo",
				status: "failure",
				request: { args: { doctype: "ToDo" } },
				response: { content: { error: "No permission to read ToDo" } },
			},
			{
				tool_call_id: "call_trunc",
				tool_name: "read",
				title: "Reading DocType Records",
				status: "failure",
				response: {
					content: {
						doctype: "ToDo",
						created: [],
						failures: [{ row: 0, error: "Description is required" }],
					},
				},
			},
		]);
		assert.equal("request" in at(first.message_options?.chain_of_thought ?? [], 1), false);
	});

	it("keeps both texts of the turn although the second row's tool_calls is not JSON", () => {
		assert.deepEqual(at(responses, 0).output.generic, [
			textItem(1, "Trying."),
			textItem(2, "That did not go well.", RUN_3),
		]);
	});

	it("answers a request the user stopped with a stopped marker, before the next request", () => {
		assert.deepEqual(at(responses, 1), {
			id: `response-${RUN_4}`,
			request_id: `request-${RUN_4}`,
			output: {
				generic: [
					{
						response_type: "text",
						text: "",
						streaming_metadata: { id: "stopped-1", stream_stopped: true },
					},
				],
			},
			message_options: { chain_of_thought: [] },
		});
		assert.deepEqual(at(requestsOf(messages), 2).input, { message_type: "text", text: "Try again please" });
	});

	it("still rebuilds the turn after the interrupted one", () => {
		assert.deepEqual(at(responses, 2).output.generic, [textItem(1, "Back now.", RUN_1)]);
	});
});

describe("sessionToMessages: turns without a reply", () => {
	it("adds an inline error carrying the failed run's error text", () => {
		const { session, runs } = SESSION_INTERRUPTED_NO_ERROR;
		const messages = sessionToMessages(session, runs);
		assert.deepEqual(kinds(messages), ["request", "response"]);
		const item = lastItem(at(responsesOf(messages), 0));
		assert.ok(isInlineErrorItem(item));
		assert.equal(item.text, "Run abandoned: stream ended without completing.");
		assert.equal(at(responsesOf(messages), 0).request_id, `request-${RUN_4}`);
	});

	it("shows a stopped marker, not an error, for either error string the server stores on Stop", () => {
		for (const error of ["Stopped by user.", "Stream interrupted", " Stream interrupted\n"]) {
			const session = doc([{ role: "user", content: "Hi", run: RUN_4 }]);
			const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_4, "Failed", { error })])), 0);
			assert.deepEqual(response.output.generic, [
				{
					response_type: "text",
					text: "",
					streaming_metadata: { id: "stopped-1", stream_stopped: true },
				},
			]);
		}
	});

	it("keeps the stopped marker after the text of a stopped turn that did persist rows", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "Partial", run: RUN_1 },
		]);
		const runs = [runDoc(RUN_1, "Failed", { error: "Stopped by user." })];
		const response = at(responsesOf(sessionToMessages(session, runs)), 0);
		assert.equal(response.output.generic.length, 2);
		assert.equal(at(response.output.generic, 0).response_type, "text");
		assert.equal(at(response.output.generic, 1).streaming_metadata?.stream_stopped, true);
		assert.equal(response.output.generic.some(isInlineErrorItem), false);
	});

	it("still shows other failures, such as a model error, as an inline error", () => {
		const session = doc([{ role: "user", content: "Hi", run: RUN_4 }]);
		const runs = [runDoc(RUN_4, "Failed", { error: "Rate limit exceeded" })];
		const item = lastItem(at(responsesOf(sessionToMessages(session, runs)), 0));
		assert.ok(isInlineErrorItem(item));
		assert.equal(item.text, "Rate limit exceeded");
	});

	it("adds an inline error without text for an unknown run", () => {
		const session = doc([{ role: "user", content: "Hi", run: "rzzzzzzzzz" }]);
		const messages = sessionToMessages(session, []);
		assert.deepEqual(kinds(messages), ["request", "response"]);
		const item = lastItem(at(responsesOf(messages), 0));
		assert.ok(isInlineErrorItem(item));
		assert.equal("text" in item, false);
		assert.equal(item.streaming_metadata?.id, "error-1");
	});

	it("adds an inline error without text for a Failed run with a blank error, and for a Completed run", () => {
		for (const run of [
			runDoc(RUN_4, "Failed", { error: "" }),
			runDoc(RUN_4, "Failed", { error: null }),
			runDoc(RUN_4, "Completed"),
		]) {
			const session = doc([{ role: "user", content: "Hi", run: RUN_4 }]);
			const item = lastItem(at(responsesOf(sessionToMessages(session, [run])), 0));
			assert.ok(isInlineErrorItem(item));
			assert.equal("text" in item, false);
		}
	});

	it("adds nothing while the run is Running or Paused", () => {
		const session = doc([{ role: "user", content: "Hi", run: RUN_4 }]);
		const live: FlowRunDoc["status"][] = ["Running", "Paused"];
		for (const status of live) {
			const messages = sessionToMessages(session, [runDoc(RUN_4, status)]);
			assert.deepEqual(kinds(messages), ["request"]);
		}
	});

	it("does not treat assistant rows that render nothing as a missing reply", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "", run: RUN_1 },
		]);
		const messages = sessionToMessages(session, [runDoc(RUN_1, "Completed")]);
		assert.deepEqual(kinds(messages), ["request"]);
	});

	it("falls back to ordinal ids for rows without a run", () => {
		const session = doc([
			{ role: "user", content: "One" },
			{ role: "user", content: "Two" },
			{ role: "assistant", content: "Reply" },
		]);
		const messages = sessionToMessages(session, []);
		assert.deepEqual(ids(messages), ["request-n1", "response-n1", "request-n2", "response-n2"]);
		assert.deepEqual(kinds(messages), ["request", "response", "request", "response"]);
		assert.equal(at(responsesOf(messages), 1).request_id, "request-n2");
	});
});

describe("sessionToMessages: empty input", () => {
	it("returns [] for a session with only a system row and for no rows", () => {
		assert.deepEqual(sessionToMessages(SESSION_EMPTY.session, SESSION_EMPTY.runs), []);
		assert.deepEqual(sessionToMessages(doc([]), []), []);
	});
});

describe("sessionToMessages: determinism and purity", () => {
	const fixtures = [
		SESSION_COMPLETED,
		SESSION_PAUSED,
		SESSION_DENIED,
		SESSION_MALFORMED,
		SESSION_INTERRUPTED_NO_ERROR,
		SESSION_EMPTY,
	];

	it("gives deep-equal output for equal input, without mutating deep-frozen input", () => {
		for (const { session, runs } of fixtures) {
			const a = sessionToMessages(frozen(session), frozen(runs));
			const b = sessionToMessages(structuredClone(session), structuredClone(runs));
			assert.deepEqual(a, b);
			const snapshot = structuredClone(session);
			sessionToMessages(session, runs);
			assert.deepEqual(session, snapshot);
		}
	});

	it("gives every message in a conversation a unique id", () => {
		for (const { session, runs } of fixtures) {
			const all = ids(sessionToMessages(session, runs));
			assert.equal(new Set(all).size, all.length);
			assert.ok(all.every((id) => typeof id === "string" && id !== ""));
		}
	});

	it("suffixes the ids of a second turn that reuses a run", () => {
		const session = doc([
			{ role: "user", content: "A", run: RUN_1 },
			{ role: "assistant", content: "a", run: RUN_1 },
			{ role: "user", content: "B", run: RUN_1 },
			{ role: "assistant", content: "b", run: RUN_1 },
			{ role: "user", content: "C", run: RUN_1 },
			{ role: "assistant", content: "c", run: RUN_1 },
		]);
		const messages = sessionToMessages(session, []);
		assert.deepEqual(ids(messages), [
			`request-${RUN_1}`,
			`response-${RUN_1}`,
			`request-${RUN_1}-2`,
			`response-${RUN_1}-2`,
			`request-${RUN_1}-3`,
			`response-${RUN_1}-3`,
		]);
		const [first, second] = responsesOf(messages);
		assert.equal(first?.request_id, `request-${RUN_1}`);
		assert.equal(second?.request_id, `request-${RUN_1}-2`);
	});

	it("does not collide a run named like an ordinal fallback", () => {
		const session = doc([
			{ role: "user", content: "A", run: "n2" },
			{ role: "user", content: "B" },
		]);
		const all = ids(sessionToMessages(session, [runDoc("n2", "Running")]));
		assert.equal(new Set(all).size, all.length);
	});
});

describe("sessionToMessages: live/history parity", () => {
	function play(events: readonly FlowEvent[]): MessageResponse {
		let state = initialStreamState({ id: "live" });
		for (const event of events) state = reduceFlowEvent(state, event);
		return state.response;
	}

	it("rebuilds the response the reducer produced for a text, tool, text turn", () => {
		const live = play(TEXT_TOOL_TEXT.events);
		const session = doc([
			{ role: "user", content: "What are my open todos?", run: RUN },
			{
				role: "assistant",
				content: "Let me check your open ToDos. ",
				tool_calls: callsJson([{ id: CALL_READ, name: "read", args: READ_ARGS }]),
				run: RUN,
			},
			{ role: "tool", content: READ_RESULT, tool_call_id: CALL_READ, run: RUN },
			{ role: "assistant", content: FINAL_TEXT, run: RUN },
		]);
		const rebuilt = at(responsesOf(sessionToMessages(session, [runDoc(RUN, "Completed")])), 0);
		assert.deepEqual(rebuilt.output.generic, live.output.generic);
		assert.deepEqual(rebuilt.message_options?.chain_of_thought, live.message_options?.chain_of_thought);
		assert.equal(rebuilt.output.generic.length, 2);
	});

	it("rebuilds a paused turn the way the reducer leaves it", () => {
		const live = play(PAUSED_TWO_QUESTIONS.events);
		const rebuilt = at(responsesOf(sessionToMessages(SESSION_PAUSED.session, SESSION_PAUSED.runs)), 0);
		assert.deepEqual(rebuilt.output.generic, live.output.generic);
		assert.deepEqual(rebuilt.message_options?.chain_of_thought, live.message_options?.chain_of_thought);
		assert.equal(rebuilt.output.generic.length, 2);
	});
});

describe("sessionToMessages: row handling", () => {
	it("gives a user row with null content empty text", () => {
		const session = doc([{ role: "user", content: null, run: RUN_1 }]);
		assert.deepEqual(requestsOf(sessionToMessages(session, [runDoc(RUN_1, "Running")])), [
			{ id: `request-${RUN_1}`, input: { message_type: "text", text: "" } },
		]);
	});

	it("keeps user text and assistant text untrimmed but drops whitespace-only assistant content", () => {
		const session = doc([
			{ role: "user", content: "  padded  ", run: RUN_1 },
			{ role: "assistant", content: "  \n ", run: RUN_1 },
			{ role: "assistant", content: " spaced out ", run: RUN_1 },
		]);
		const messages = sessionToMessages(session, [runDoc(RUN_1, "Completed")]);
		assert.equal(at(requestsOf(messages), 0).input.text, "  padded  ");
		assert.deepEqual(at(responsesOf(messages), 0).output.generic, [textItem(1, " spaced out ", RUN_1)]);
	});

	it("skips unknown and system roles without breaking the merge", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "first", run: RUN_1 },
			{ role: "system", content: "note", run: RUN_1 },
			{ role: "function", content: "legacy", run: RUN_1 },
			{ role: "", content: "blank role", run: RUN_1 },
			{ role: "assistant", content: "second", run: RUN_1 },
		]);
		const messages = sessionToMessages(session, []);
		assert.deepEqual(kinds(messages), ["request", "response"]);
		assert.deepEqual(at(responsesOf(messages), 0).output.generic, [
			textItem(1, "first"),
			textItem(2, "second"),
		]);
	});

	it("starts a response without request_id for an assistant row before any user row", () => {
		const session = doc([{ role: "assistant", content: "Welcome", run: RUN_1 }]);
		const messages = sessionToMessages(session, []);
		assert.deepEqual(messages, [
			{
				id: `response-${RUN_1}`,
				output: { generic: [textItem(1, "Welcome")] },
				message_options: { chain_of_thought: [] },
			},
		]);
	});

	it("treats a tool row whose content is null (an empty Text) as a success with empty content", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "",
				tool_calls: callsJson([{ id: "c1", name: "describe", args: { doctype: "ToDo" } }]),
				run: RUN_1,
			},
			{ role: "tool", content: null, tool_call_id: "c1", run: RUN_1 },
		]);
		const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_1, "Completed")])), 0);
		const step = at(response.message_options?.chain_of_thought ?? [], 0);
		assert.equal(step.status, "success");
		assert.deepEqual(step.response, { content: "" });
	});

	it("keeps a response made only of tool calls, with no text item and no feedback options", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "",
				tool_calls: callsJson([{ id: "c1", name: "describe", args: { doctype: "ToDo" } }]),
				run: RUN_1,
			},
			{ role: "tool", content: "", tool_call_id: "c1", run: RUN_1 },
		]);
		const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_1, "Completed")])), 0);
		assert.deepEqual(response.output.generic, []);
		assert.deepEqual(response.message_options?.chain_of_thought, [
			{
				tool_call_id: "c1",
				tool_name: "describe",
				title: "Reading DocType Meta: ToDo",
				status: "success",
				request: { args: { doctype: "ToDo" } },
				response: { content: "" },
			},
		]);
	});

	it("drops a response that has neither items nor steps", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: null, tool_calls: "[]", run: RUN_1 },
		]);
		assert.deepEqual(kinds(sessionToMessages(session, [runDoc(RUN_1, "Completed")])), ["request"]);
	});

	it("fails a call that never got a tool row when the run is not paused", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "Working",
				tool_calls: callsJson([{ id: "c1", name: "read", args: {} }]),
				run: RUN_1,
			},
		]);
		const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_1, "Running")])), 0);
		assert.deepEqual(response.message_options?.chain_of_thought, [
			{ tool_call_id: "c1", tool_name: "read", title: "Reading DocType Records", status: "failure" },
		]);
	});

	it("keeps one step for a repeated call id and refreshes its arguments", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "",
				tool_calls: callsJson([
					{ id: "c1", name: "read", args: {} },
					{ id: "c1", name: "read", args: { doctype: "Note" } },
					{ id: "c1", name: "read", args: {} },
				]),
				run: RUN_1,
			},
		]);
		const response = at(responsesOf(sessionToMessages(session, [])), 0);
		assert.deepEqual(response.message_options?.chain_of_thought, [
			{
				tool_call_id: "c1",
				tool_name: "read",
				title: "Reading DocType Records: Note",
				status: "failure",
				request: { args: { doctype: "Note" } },
			},
		]);
	});

	it("normalizes leaked special tokens in a tool name", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "",
				tool_calls: callsJson([
					{ id: "c1", name: "describe<|channel|>commentary", args: { doctype: "ToDo" } },
				]),
				run: RUN_1,
			},
		]);
		const [step] = at(responsesOf(sessionToMessages(session, [])), 0).message_options?.chain_of_thought ?? [];
		assert.equal(step?.tool_name, "describe");
		assert.equal(step?.title, "Reading DocType Meta: ToDo");
	});

	it("accepts tool_calls that arrived already parsed", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "read", arguments: { doctype: "ToDo" } } },
				],
				run: RUN_1,
			},
		]);
		const [step] = at(responsesOf(sessionToMessages(session, [])), 0).message_options?.chain_of_thought ?? [];
		assert.deepEqual(step?.request, { args: { doctype: "ToDo" } });
	});

	it("passes the translate option to step titles but not to the data in them", () => {
		const upper = (source: string): string => source.toUpperCase();
		const messages = sessionToMessages(SESSION_COMPLETED.session, SESSION_COMPLETED.runs, {
			translate: upper,
		});
		const [step] = at(responsesOf(messages), 0).message_options?.chain_of_thought ?? [];
		assert.equal(step?.title, "READING DOCTYPE RECORDS: ToDo");
	});
});

describe("sessionToMessages: failed and feedback", () => {
	it("appends the run's error after the text and still allows feedback on the text", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "Partial answer", run: RUN_1 },
		]);
		const runs = [
			runDoc(RUN_1, "Failed", { error: "Connection reset", feedback_rating: "Down", feedback_comment: "" }),
		];
		const response = at(responsesOf(sessionToMessages(session, runs)), 0);
		assert.deepEqual(response.output.generic, [
			textItem(1, "Partial answer", RUN_1),
			{ response_type: "inline_error", streaming_metadata: { id: "error-1" }, text: "Connection reset" },
		]);
		assert.deepEqual(response.history, { feedback: { [RUN_1]: { is_positive: false } } });
	});

	it("shows an error item without text for a Failed run with an empty error", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "Partial", run: RUN_1 },
		]);
		const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_1, "Failed", { error: "" })])), 0);
		const item = lastItem(response);
		assert.ok(isInlineErrorItem(item));
		assert.equal("text" in item, false);
	});

	it("puts the feedback options on the last non-blank text item only", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{ role: "assistant", content: "one", run: RUN_1 },
			{ role: "assistant", content: "two", run: RUN_1 },
		]);
		const response = at(responsesOf(sessionToMessages(session, [runDoc(RUN_1, "Completed")])), 0);
		assert.deepEqual(response.output.generic, [textItem(1, "one"), textItem(2, "two", RUN_1)]);
	});

	it("records a rating even when the response has no text to attach feedback to", () => {
		const session = doc([
			{ role: "user", content: "Hi", run: RUN_1 },
			{
				role: "assistant",
				content: null,
				tool_calls: callsJson([{ id: "c1", name: "read", args: {} }]),
				run: RUN_1,
			},
			{ role: "tool", content: "ok", tool_call_id: "c1", run: RUN_1 },
		]);
		const runs = [runDoc(RUN_1, "Completed", { feedback_rating: "Up", feedback_comment: "Nice" })];
		const response = at(responsesOf(sessionToMessages(session, runs)), 0);
		assert.deepEqual(response.output.generic, []);
		assert.deepEqual(response.history, { feedback: { [RUN_1]: { is_positive: true, text: "Nice" } } });
	});

	it("takes the response's run from the first assistant row that has one", () => {
		const session = doc([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "a", run: null },
			{ role: "assistant", content: "b", run: RUN_2 },
			{ role: "assistant", content: "c", run: RUN_3 },
		]);
		const response = at(
			responsesOf(sessionToMessages(session, [runDoc(RUN_2, "Completed"), runDoc(RUN_3, "Failed")])),
			0,
		);
		assert.equal(response.id, `response-${RUN_2}`);
		assert.deepEqual(response.output.generic.at(-1), textItem(3, "c", RUN_2));
		assert.equal(response.output.generic.some(isInlineErrorItem), false);
	});
});

describe("sessionToMessages: timestamps", () => {
	// Kolkata is UTC+5:30 all year, far from both UTC and the machine the tests run on
	const options = { systemTimeZone: "Asia/Kolkata" };
	const at1 = Date.UTC(2026, 9, 1, 3, 30, 0, 123); // 2026-10-01 09:00:00.123456 in Kolkata
	const at2 = Date.UTC(2026, 9, 2, 8, 35, 9);

	function turns(): { session: FlowSessionDoc; runs: FlowRunDoc[] } {
		return {
			session: doc([
				{ role: "user", content: "one", run: RUN_1 },
				{ role: "assistant", content: "uno", run: RUN_1 },
				{ role: "user", content: "two", run: RUN_2 },
				{ role: "assistant", content: "dos", run: RUN_2 },
			]),
			runs: [
				runDoc(RUN_1, "Completed", { creation: "2026-10-01 09:00:00.123456" }),
				runDoc(RUN_2, "Completed", { creation: "2026-10-02 14:05:09" }),
			],
		};
	}

	it("dates the question and the answer of a turn by the creation of its run, in the system zone", () => {
		const { session, runs } = turns();
		const [q1, a1, q2, a2] = sessionToMessages(session, runs, options);
		assert.deepEqual(q1?.history, { timestamp: at1 });
		assert.deepEqual(a1?.history, { timestamp: at1 });
		assert.deepEqual(q2?.history, { timestamp: at2 });
		assert.deepEqual(a2?.history, { timestamp: at2 });
	});

	it("is not shifted by the zone of the machine it runs on", () => {
		const { session, runs } = turns();
		const before = process.env["TZ"];
		try {
			const seen = new Set<number | undefined>();
			for (const zone of ["America/Los_Angeles", "UTC", "Pacific/Auckland"]) {
				process.env["TZ"] = zone;
				seen.add(sessionToMessages(session, runs, options)[0]?.history?.timestamp);
			}
			assert.deepEqual([...seen], [at1]);
		} finally {
			if (before === undefined) delete process.env["TZ"];
			else process.env["TZ"] = before;
		}
	});

	it("keeps a response's feedback beside its timestamp", () => {
		const { session, runs } = turns();
		runs[0] = runDoc(RUN_1, "Completed", {
			creation: "2026-10-01 09:00:00.123456",
			feedback_rating: "Down",
			feedback_comment: "Too long",
		});
		const answer = sessionToMessages(session, runs, options)[1];
		assert.deepEqual(answer?.history, {
			feedback: { [RUN_1]: { is_positive: false, text: "Too long" } },
			timestamp: at1,
		});
	});

	it("dates the synthetic failure of an unanswered request by that request's run", () => {
		const session = doc([{ role: "user", content: "Anyone?", run: RUN_1 }]);
		const runs = [runDoc(RUN_1, "Failed", { error: "boom", creation: "2026-10-02 14:05:09" })];
		const [question, failure] = sessionToMessages(session, runs, options);
		assert.deepEqual(question?.history, { timestamp: at2 });
		assert.deepEqual(failure?.history, { timestamp: at2 });
	});

	it("leaves out the history key altogether when no time can be named", () => {
		const session = doc([
			{ role: "user", content: "no run" },
			{ role: "assistant", content: "answer without a run" },
			{ role: "user", content: "run missing from the list", run: RUN_2 },
			{ role: "assistant", content: "reply", run: RUN_2 },
			{ role: "user", content: "garbled creation", run: RUN_3 },
			{ role: "assistant", content: "reply", run: RUN_3 },
			{ role: "user", content: "no creation field", run: RUN_4 },
			{ role: "assistant", content: "reply", run: RUN_4 },
		]);
		const runs = [
			runDoc(RUN_3, "Completed", { creation: "yesterday" }),
			runDoc(RUN_4, "Completed", { creation: null }),
		];
		const messages = sessionToMessages(session, runs, options);
		assert.equal(messages.length, 8);
		for (const message of messages) {
			assert.equal("history" in message, false, JSON.stringify(message));
		}
	});

	it("reads the string in the browser's zone when no system zone is given", () => {
		const { session, runs } = turns();
		const before = process.env["TZ"];
		try {
			process.env["TZ"] = "UTC";
			assert.equal(sessionToMessages(session, runs)[2]?.history?.timestamp, Date.UTC(2026, 9, 2, 14, 5, 9));
		} finally {
			if (before === undefined) delete process.env["TZ"];
			else process.env["TZ"] = before;
		}
	});

	it("stamps a paused run's request and its approval response", () => {
		const { session, runs } = SESSION_PAUSED;
		const stamped = runs.map((run) => Object.assign({}, run, { creation: "2026-10-02 14:05:09" }));
		const messages = sessionToMessages(session, stamped, options);
		assert.ok(messages.length >= 2);
		for (const message of messages) assert.deepEqual(message.history, { timestamp: at2 });
	});
});

describe("sessionToMessages: attachments", () => {
	const user = (content: string, run: string | null): FlowSessionMessageRow =>
		run === null ? { role: "user", content } : { role: "user", content, run };
	const reply = (content: string, run: string): FlowSessionMessageRow => ({
		role: "assistant",
		content,
		run,
	});
	const attachment = (
		file: string,
		run: string | null,
		extra: Partial<FlowSessionAttachmentRow> = {},
	): FlowSessionAttachmentRow => (run === null ? { file, ...extra } : { file, run, ...extra });

	function withAttachments(
		messages: FlowSessionMessageRow[],
		attachments: FlowSessionAttachmentRow[],
	): FlowSessionDoc {
		return { name: SESSION, messages, attachments };
	}

	it("puts each turn's files on its own request, in row order", () => {
		const messages = sessionToMessages(
			withAttachments(
				[user("one", RUN_1), reply("a", RUN_1), user("two", RUN_2), reply("b", RUN_2)],
				[
					attachment("f1", RUN_1, { file_name: "notes.txt", file_size: 12, mode: "Inline" }),
					attachment("f2", RUN_2, { file_name: "data.csv", file_size: 99 }),
					attachment("f3", RUN_1, { file_name: "more.md", file_size: 3 }),
				],
			),
			[],
		);
		const [first, second] = requestsOf(messages);
		assert.deepEqual(first?.input.structured_data, {
			fields: [
				fileFieldFor({ type: "reference", id: "f1", name: "notes.txt", size: 12 }),
				fileFieldFor({ type: "reference", id: "f3", name: "more.md", size: 3 }),
			],
		});
		assert.deepEqual(second?.input.structured_data, {
			fields: [fileFieldFor({ type: "reference", id: "f2", name: "data.csv", size: 99 })],
		});
		assert.equal(first?.input.text, "one");
		assert.equal(first?.input.message_type, "text");
	});

	it("leaves a request with no files without a structured_data key", () => {
		const messages = sessionToMessages(
			withAttachments([user("one", RUN_1), reply("a", RUN_1), user("two", RUN_2)], [attachment("f1", RUN_1)]),
			[],
		);
		const [, second] = requestsOf(messages);
		assert.equal("structured_data" in (second?.input ?? {}), false);
	});

	it("drops a row whose run matches no user row, and gives a user row with no run nothing", () => {
		const messages = sessionToMessages(
			withAttachments(
				[user("orphan-less", null), reply("a", RUN_1), user("two", RUN_2)],
				[attachment("f1", RUN_3), attachment("f2", null), attachment("f3", RUN_2)],
			),
			[],
		);
		const [first, second] = requestsOf(messages);
		assert.equal("structured_data" in (first?.input ?? {}), false);
		assert.deepEqual(
			second?.input.structured_data?.fields.map((field) => field.id),
			["file-f3"],
		);
		assert.equal(JSON.stringify(messages).includes("file-f1"), false);
		assert.equal(JSON.stringify(messages).includes("file-f2"), false);
	});

	it("restores a row with no file name as a bare reference", () => {
		const messages = sessionToMessages(
			withAttachments([user("one", RUN_1)], [attachment("f1", RUN_1, { file_name: null, file_size: null })]),
			[],
		);
		const field = requestsOf(messages)[0]?.input.structured_data?.fields[0];
		assert.deepEqual(field, { id: "file-f1", type: "file", value: { type: "reference", id: "f1" } });
		assert.deepEqual(attachmentChipsOf(requestsOf(messages)[0]?.input), [{ id: "f1" }]);
	});

	it("restores chips that carry the name and no url or mime type", () => {
		const messages = sessionToMessages(
			withAttachments(
				[user("one", RUN_1)],
				[attachment("f1", RUN_1, { file_name: "notes.txt", file_size: 12 })],
			),
			[],
		);
		assert.deepEqual(attachmentChipsOf(requestsOf(messages)[0]?.input), [{ id: "f1", name: "notes.txt" }]);
	});

	it("does not change the other messages, ids or order", () => {
		const rows = [user("one", RUN_1), reply("a", RUN_1), user("two", RUN_2), reply("b", RUN_2)];
		const plain = sessionToMessages(withAttachments(rows, []), []);
		const filed = sessionToMessages(
			withAttachments(rows, [attachment("f1", RUN_2, { file_name: "x.txt" })]),
			[],
		);
		assert.deepEqual(ids(filed), ids(plain));
		assert.deepEqual(kinds(filed), kinds(plain));
		assert.deepEqual(responsesOf(filed), responsesOf(plain));
	});

	it("does not mutate the session it reads", () => {
		const session = frozen(
			withAttachments([user("one", RUN_1)], [attachment("f1", RUN_1, { file_name: "x.txt", file_size: 1 })]),
		);
		assert.doesNotThrow(() => sessionToMessages(session, []));
	});
});
