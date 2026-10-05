import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	FLOW_EVENT_NAMES,
	parseFlowEvent,
	parseFlowQuestion,
	parseFlowQuestions,
} from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import {
	isFlowRole,
	isFlowRunDoc,
	isFlowRunStatus,
	isFlowSessionAttachmentRow,
	isFlowSessionMessageRow,
	isFlowSessionSummary,
	parseFlowRunDocs,
	parseFlowSessionDoc,
	parseFlowSessionSummaries,
	parseToolCalls,
} from "../../../carbon_frappe/public/js/ai_chat/flow/docs.ts";
import {
	classifyToolResult,
	parseToolContent,
	toolError,
} from "../../../carbon_frappe/public/js/ai_chat/flow/tool_result.ts";
import {
	CALL_CREATE,
	CALL_DELETE,
	CREATE_ARGS,
	DELETE_ARGS,
	ERROR_AFTER_DONE,
	ERROR_BEFORE_TEXT,
	ERROR_MID_TEXT,
	PAUSED_TWO_QUESTIONS,
	QUESTION_CREATE,
	QUESTION_DELETE,
	REDIRECT_RESULT,
	RESUME_APPROVED,
	RESUME_DENIED,
	RESUME_REDIRECTED_PAUSED_AGAIN,
	RUN,
	SESSION,
	SESSION_COMPLETED,
	SESSION_DENIED,
	SESSION_EMPTY,
	SESSION_INTERRUPTED_NO_ERROR,
	SESSION_MALFORMED,
	SESSION_PAUSED,
	TEXT_ONLY,
	TEXT_TOOL_TEXT,
	TEXT_UNICODE,
	TOOL_ERROR,
	TOOL_ERROR_RESULT,
	ev,
	pyJson,
} from "./fixtures.ts";
import type { Transcript } from "./fixtures.ts";

function framesOf(wire: string): { event: string; data: unknown }[] {
	return wire
		.split("\n\n")
		.filter((block) => block !== "")
		.map((block) => {
			const [eventLine = "", dataLine = ""] = block.split("\n");
			return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
		});
}

const TRANSCRIPTS: [string, Transcript][] = [
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

describe("events.ts: parseFlowEvent", () => {
	it("parses every recorded wire frame to the exact fixture event", () => {
		for (const [name, transcript] of TRANSCRIPTS) {
			const parsed = framesOf(transcript.wire).map((frame) => parseFlowEvent(frame.event, frame.data));
			assert.deepEqual(parsed, transcript.events, name);
		}
	});

	it("parses each variant from an explicit payload", () => {
		assert.deepEqual(
			parseFlowEvent("run_started", { type: "run_started", name: RUN, session: SESSION }),
			ev.runStarted(RUN, SESSION),
		);
		assert.deepEqual(parseFlowEvent("text", { type: "text", delta: "hi" }), ev.text("hi"));
		assert.deepEqual(
			parseFlowEvent("tool_started", { type: "tool_started", id: "c", name: "read", arguments: { a: 1 } }),
			ev.toolStarted("c", "read", { a: 1 }),
		);
		assert.deepEqual(
			parseFlowEvent("tool_ended", { type: "tool_ended", id: "c", name: "read", result: "" }),
			ev.toolEnded("c", "read", ""),
		);
		assert.deepEqual(
			parseFlowEvent("done", {
				type: "done",
				status: "Paused",
				iterations: 2,
				output: "o",
				usage: { total_tokens: 5 },
				questions: [QUESTION_CREATE],
			}),
			ev.done("Paused", "o", 2, { total_tokens: 5 }, [QUESTION_CREATE]),
		);
		assert.deepEqual(parseFlowEvent("error", { type: "error", message: "bad" }), ev.error("bad"));
	});

	it("names the event by the frame name, falling back to the payload type", () => {
		assert.deepEqual(parseFlowEvent("text", { type: "done", delta: "x" }), ev.text("x"));
		assert.deepEqual(parseFlowEvent("message", { type: "text", delta: "x" }), ev.text("x"));
		assert.deepEqual(parseFlowEvent("", { type: "text", delta: "x" }), ev.text("x"));
		assert.equal(parseFlowEvent("message", { delta: "x" }), null);
		assert.equal(parseFlowEvent("message", { type: 5, delta: "x" }), null);
		assert.equal(parseFlowEvent("message", { type: "ping" }), null);
	});

	it("returns null for an unknown event name, even if the payload type is known", () => {
		assert.equal(parseFlowEvent("ping", {}), null);
		assert.equal(parseFlowEvent("ping", { type: "text", delta: "x" }), null);
		assert.equal(parseFlowEvent("TEXT", { type: "text", delta: "x" }), null);
	});

	it("returns null when the payload is not a record", () => {
		for (const payload of [null, undefined, [], ["text"], "text", 5, true]) {
			assert.equal(parseFlowEvent("text", payload), null);
		}
	});

	it("returns null when a required field is missing or mistyped", () => {
		assert.equal(parseFlowEvent("run_started", { name: RUN }), null);
		assert.equal(parseFlowEvent("run_started", { session: SESSION }), null);
		assert.equal(parseFlowEvent("run_started", { name: 1, session: SESSION }), null);
		assert.equal(parseFlowEvent("text", { delta: 5 }), null);
		assert.equal(parseFlowEvent("text", {}), null);
		assert.equal(parseFlowEvent("tool_started", { name: "read", arguments: {} }), null);
		assert.equal(parseFlowEvent("tool_started", { id: "c", arguments: {} }), null);
		assert.equal(parseFlowEvent("tool_ended", { id: "c", name: "read", result: 5 }), null);
		assert.equal(parseFlowEvent("tool_ended", { id: "c", name: "read", result: null }), null);
		assert.equal(parseFlowEvent("tool_ended", { id: "c", name: "read" }), null);
		assert.equal(parseFlowEvent("tool_ended", { name: "read", result: "" }), null);
	});

	it("takes tool_started arguments only from a record, else {}", () => {
		for (const args of [undefined, null, [], [1], "x", 5]) {
			assert.deepEqual(parseFlowEvent("tool_started", { id: "c", name: "read", arguments: args }), {
				type: "tool_started",
				id: "c",
				name: "read",
				arguments: {},
			});
		}
		assert.deepEqual(
			parseFlowEvent("tool_started", { id: "c", name: "read" }),
			ev.toolStarted("c", "read", {}),
		);
	});

	describe("done", () => {
		it("reads any status but Paused as Completed, and omits questions from a Completed frame", () => {
			const completed = parseFlowEvent("done", {
				status: "Completed",
				iterations: 1,
				output: "x",
				usage: {},
			});
			assert.deepEqual(completed, ev.done("Completed", "x", 1, {}));
			assert.deepEqual(completed && completed.type === "done" ? completed.questions : null, []);
			for (const status of [undefined, null, "paused", "Failed", 1]) {
				const parsed = parseFlowEvent("done", { status });
				assert.equal(parsed?.type === "done" ? parsed.status : null, "Completed");
			}
		});

		it("keeps the questions of a Paused frame, parsed", () => {
			const parsed = parseFlowEvent("done", {
				status: "Paused",
				questions: [QUESTION_CREATE, { prompt: "bare" }, { nope: true }],
			});
			assert.deepEqual(parsed?.type === "done" ? parsed.questions : null, [
				QUESTION_CREATE,
				{ prompt: "bare", options: [], multi_select: false, allow_other: true, key: null },
			]);
		});

		it("zeroes a non-finite or non-numeric iterations", () => {
			for (const iterations of [undefined, null, "3", Infinity, -Infinity, NaN]) {
				const parsed = parseFlowEvent("done", { iterations });
				assert.equal(parsed?.type === "done" ? parsed.iterations : null, 0);
			}
			const parsed = parseFlowEvent("done", { iterations: 4 });
			assert.equal(parsed?.type === "done" ? parsed.iterations : null, 4);
		});

		it("keeps only the finite numbers of usage", () => {
			const parsed = parseFlowEvent("done", {
				usage: { a: 1, b: "2", c: Infinity, d: null, e: 0, f: -3.5, g: {} },
			});
			assert.deepEqual(parsed?.type === "done" ? parsed.usage : null, { a: 1, e: 0, f: -3.5 });
			for (const usage of [undefined, null, [1, 2], "x", 5]) {
				const bad = parseFlowEvent("done", { usage });
				assert.deepEqual(bad?.type === "done" ? bad.usage : null, {});
			}
		});

		it("reads a non-string output as null and keeps the empty string", () => {
			for (const output of [undefined, null, 5, {}, ["x"]]) {
				const parsed = parseFlowEvent("done", { output });
				assert.equal(parsed?.type === "done" ? parsed.output : "unset", null);
			}
			const empty = parseFlowEvent("done", { output: "" });
			assert.equal(empty?.type === "done" ? empty.output : "unset", "");
		});

		it("accepts a bare done frame", () => {
			assert.deepEqual(parseFlowEvent("done", {}), ev.done("Completed", null, 0, {}));
		});
	});

	describe("error", () => {
		it("reads a missing or non-string message as the empty string", () => {
			for (const message of [undefined, null, 5, {}, ["x"]]) {
				assert.deepEqual(parseFlowEvent("error", { message }), ev.error(""));
			}
			assert.deepEqual(parseFlowEvent("error", {}), ev.error(""));
			assert.deepEqual(parseFlowEvent("error", { message: "x" }), ev.error("x"));
		});
	});
});

describe("events.ts: questions", () => {
	it("fills the defaults of a bare question", () => {
		assert.deepEqual(parseFlowQuestion({ prompt: "p" }), {
			prompt: "p",
			options: [],
			multi_select: false,
			allow_other: true,
			key: null,
		});
	});

	it("reads each flag strictly", () => {
		const question = parseFlowQuestion({
			prompt: "p",
			options: ["a", 2, null, "b", ["c"]],
			multi_select: true,
			allow_other: false,
			key: "k1",
		});
		assert.deepEqual(question, {
			prompt: "p",
			options: ["a", "b"],
			multi_select: true,
			allow_other: false,
			key: "k1",
		});
		const loose = parseFlowQuestion({
			prompt: "p",
			multi_select: "yes",
			allow_other: null,
			key: 5,
			options: "x",
		});
		assert.deepEqual(loose, { prompt: "p", options: [], multi_select: false, allow_other: true, key: null });
	});

	it("drops an entry without a string prompt", () => {
		assert.equal(parseFlowQuestion({ options: ["a"] }), null);
		assert.equal(parseFlowQuestion({ prompt: 5 }), null);
		assert.equal(parseFlowQuestion(null), null);
		assert.equal(parseFlowQuestion("p"), null);
		assert.equal(parseFlowQuestion(["p"]), null);
	});

	it("parseFlowQuestions accepts an array", () => {
		assert.deepEqual(parseFlowQuestions([QUESTION_CREATE, QUESTION_DELETE]), [
			QUESTION_CREATE,
			QUESTION_DELETE,
		]);
		assert.deepEqual(parseFlowQuestions([{ nope: 1 }, QUESTION_DELETE, 5]), [QUESTION_DELETE]);
	});

	it("parseFlowQuestions accepts the JSON text of an array", () => {
		const text = SESSION_PAUSED.runs[0]?.questions;
		assert.equal(typeof text, "string");
		assert.deepEqual(parseFlowQuestions(text), [QUESTION_CREATE, QUESTION_DELETE]);
	});

	it("parseFlowQuestions yields nothing for malformed JSON or a non-array", () => {
		for (const value of [
			'[{"prompt": ',
			"not json",
			"",
			'{"prompt": "p"}',
			"null",
			null,
			undefined,
			{},
			5,
			true,
		]) {
			assert.deepEqual(parseFlowQuestions(value), [], String(value));
		}
	});
});

describe("events.ts: FLOW_EVENT_NAMES", () => {
	it("lists exactly the six wire event names", () => {
		assert.deepEqual([...FLOW_EVENT_NAMES].sort(), [
			"done",
			"error",
			"run_started",
			"text",
			"tool_ended",
			"tool_started",
		]);
	});
});

describe("docs.ts: parseFlowSessionDoc", () => {
	const SESSIONS = {
		SESSION_COMPLETED,
		SESSION_PAUSED,
		SESSION_DENIED,
		SESSION_MALFORMED,
		SESSION_INTERRUPTED_NO_ERROR,
		SESSION_EMPTY,
	};

	it("keeps the name, every row and every field of each fixture session", () => {
		for (const [label, { session }] of Object.entries(SESSIONS)) {
			const parsed = parseFlowSessionDoc(structuredClone(session));
			assert.ok(parsed, label);
			assert.equal(parsed.name, session.name, label);
			assert.equal(parsed.messages.length, session.messages.length, label);
			assert.deepEqual(parsed.messages, session.messages, label);
			assert.equal(parsed.title, session.title, label);
			assert.equal(parsed.agent, session.agent, label);
			assert.equal(parsed.owner, session.owner, label);
			assert.equal(parsed.source, "Manual", label);
			assert.equal(parsed.creation, session.creation, label);
			assert.equal(parsed.modified, session.modified, label);
			assert.deepEqual(parsed.attachments, [], label);
		}
	});

	it("omits fields that are null or mistyped rather than copying them", () => {
		const parsed = parseFlowSessionDoc({ name: "s", title: null, agent: 5, model: "m", source: "Other" });
		assert.deepEqual(parsed, { name: "s", model: "m", messages: [], attachments: [] });
	});

	it("drops an invalid row and keeps the rest in order", () => {
		const good = { role: "user", content: "hi" };
		const parsed = parseFlowSessionDoc({
			name: "s",
			messages: [
				good,
				{ role: 5 },
				"row",
				null,
				{ role: "tool", content: 5 },
				{ role: "assistant", run: "r" },
			],
		});
		assert.deepEqual(parsed?.messages, [good, { role: "assistant", run: "r" }]);
	});

	it("drops invalid attachment rows", () => {
		const parsed = parseFlowSessionDoc({
			name: "s",
			attachments: [{ file: "/f.pdf", run: "r" }, { file_name: "x" }, { file: 5 }],
		});
		assert.deepEqual(parsed?.attachments, [{ file: "/f.pdf", run: "r" }]);
	});

	it("reads non-array messages and attachments as empty", () => {
		assert.deepEqual(parseFlowSessionDoc({ name: "s", messages: "x", attachments: {} }), {
			name: "s",
			messages: [],
			attachments: [],
		});
	});

	it("returns null without a usable session", () => {
		for (const value of [null, undefined, {}, { name: 5 }, { name: null }, [], "s", 5]) {
			assert.equal(parseFlowSessionDoc(value), null);
		}
	});
});

describe("docs.ts: parseFlowRunDocs and parseFlowSessionSummaries", () => {
	const base = { name: "r", session: "s", status: "Completed" };

	it("drops invalid entries and keeps the order of the valid ones", () => {
		const runs = parseFlowRunDocs([
			{ ...base, name: "a" },
			{ ...base, name: "b", status: "Weird" },
			null,
			{ ...base, name: "c", session: 5 },
			{ ...base, name: "d", status: "Failed", error: "boom" },
		]);
		assert.deepEqual(
			runs.map((run) => run.name),
			["a", "d"],
		);
	});

	it("keeps an empty or null feedback_rating and rejects an API-only None", () => {
		const runs = parseFlowRunDocs([
			{ ...base, name: "a", feedback_rating: "" },
			{ ...base, name: "b", feedback_rating: null },
			{ ...base, name: "c", feedback_rating: "Up" },
			{ ...base, name: "d", feedback_rating: "Down" },
			{ ...base, name: "e", feedback_rating: "None" },
			{ ...base, name: "f", feedback_rating: 1 },
		]);
		assert.deepEqual(
			runs.map((run) => [run.name, run.feedback_rating]),
			[
				["a", ""],
				["b", null],
				["c", "Up"],
				["d", "Down"],
			],
		);
	});

	it("reads a non-array as no runs", () => {
		for (const value of [null, undefined, {}, "x", 5]) {
			assert.deepEqual(parseFlowRunDocs(value), []);
			assert.deepEqual(parseFlowSessionSummaries(value), []);
		}
	});

	it("parseFlowSessionSummaries keeps entries with a name and valid optional strings", () => {
		const summaries = parseFlowSessionSummaries([
			{ name: "a", title: "A", modified: "2026-10-01 10:00:00" },
			{ name: "b", title: null },
			{ title: "no name" },
			{ name: "c", title: 5 },
			"x",
			{ name: "d", modified: 5 },
		]);
		assert.deepEqual(summaries, [
			{ name: "a", title: "A", modified: "2026-10-01 10:00:00" },
			{ name: "b", title: null },
		]);
	});
});

describe("docs.ts: guards", () => {
	it("isFlowRole and isFlowRunStatus accept exactly their literals", () => {
		for (const role of ["system", "user", "assistant", "tool"]) assert.equal(isFlowRole(role), true);
		for (const role of ["User", "admin", "", null, undefined, 3]) assert.equal(isFlowRole(role), false);
		for (const status of ["Running", "Paused", "Completed", "Failed"]) {
			assert.equal(isFlowRunStatus(status), true);
		}
		for (const status of ["running", "Stopped", "", null, 1]) assert.equal(isFlowRunStatus(status), false);
	});

	it("isFlowSessionMessageRow rejects near misses", () => {
		assert.equal(isFlowSessionMessageRow({ role: "user" }), true);
		assert.equal(isFlowSessionMessageRow({ role: "user", content: null, tool_calls: [], run: "r" }), true);
		assert.equal(isFlowSessionMessageRow({ role: "anything-goes", content: "x" }), true);
		assert.equal(isFlowSessionMessageRow({}), false);
		assert.equal(isFlowSessionMessageRow({ role: 1 }), false);
		assert.equal(isFlowSessionMessageRow({ role: "user", content: 5 }), false);
		assert.equal(isFlowSessionMessageRow({ role: "tool", tool_call_id: 5 }), false);
		assert.equal(isFlowSessionMessageRow({ role: "assistant", tool_calls: 5 }), false);
		assert.equal(isFlowSessionMessageRow({ role: "assistant", tool_calls: {} }), false);
		assert.equal(isFlowSessionMessageRow({ role: "user", run: 5 }), false);
		assert.equal(isFlowSessionMessageRow([]), false);
		assert.equal(isFlowSessionMessageRow(null), false);
	});

	it("isFlowSessionAttachmentRow and isFlowSessionSummary reject near misses", () => {
		assert.equal(isFlowSessionAttachmentRow({ file: "/f" }), true);
		assert.equal(isFlowSessionAttachmentRow({ file: "/f", run: null }), true);
		assert.equal(isFlowSessionAttachmentRow({}), false);
		assert.equal(isFlowSessionAttachmentRow({ file: "/f", run: 5 }), false);
		assert.equal(isFlowSessionSummary({ name: "a" }), true);
		assert.equal(isFlowSessionSummary({ name: "a", title: 5 }), false);
		assert.equal(isFlowSessionSummary({ title: "a" }), false);
	});

	it("isFlowRunDoc rejects near misses", () => {
		const ok = { name: "r", session: "s", status: "Running" };
		assert.equal(isFlowRunDoc(ok), true);
		assert.equal(isFlowRunDoc({ ...ok, questions: [], error: null, feedback_comment: "c" }), true);
		assert.equal(isFlowRunDoc({ ...ok, questions: "[]" }), true);
		assert.equal(isFlowRunDoc({ name: "r", session: "s" }), false);
		assert.equal(isFlowRunDoc({ ...ok, name: 1 }), false);
		assert.equal(isFlowRunDoc({ ...ok, session: undefined }), false);
		assert.equal(isFlowRunDoc({ ...ok, status: "Done" }), false);
		assert.equal(isFlowRunDoc({ ...ok, error: 5 }), false);
		assert.equal(isFlowRunDoc({ ...ok, questions: 5 }), false);
		assert.equal(isFlowRunDoc({ ...ok, feedback_comment: 5 }), false);
		assert.equal(isFlowRunDoc({ ...ok, feedback_rating: "None" }), false);
		assert.equal(isFlowRunDoc("r"), false);
	});
});

describe("docs.ts: parseToolCalls", () => {
	const call = (id: string, name: string, args: unknown) => ({
		id,
		type: "function",
		function: { name, arguments: args },
	});

	it("reads the fixture rows", () => {
		const paused = SESSION_PAUSED.session.messages.find((row) => row.role === "assistant");
		assert.deepEqual(parseToolCalls(paused?.tool_calls), [
			{ id: CALL_CREATE, name: "create", arguments: CREATE_ARGS },
			{ id: CALL_DELETE, name: "delete", arguments: DELETE_ARGS },
		]);
		const malformed = SESSION_MALFORMED.session.messages.find(
			(row) => typeof row.tool_calls === "string" && row.tool_calls.startsWith("[{"),
		);
		assert.deepEqual(parseToolCalls(malformed?.tool_calls), [
			{ id: "call_ok", name: "read", arguments: { doctype: "ToDo" } },
			{ id: "call_trunc", name: "read", arguments: {} },
		]);
	});

	it("reads a JSON string and an already-parsed array alike", () => {
		const list = [call("a", "read", '{"x": 1}'), call("b", "describe", "{}")];
		const expected = [
			{ id: "a", name: "read", arguments: { x: 1 } },
			{ id: "b", name: "describe", arguments: {} },
		];
		assert.deepEqual(parseToolCalls(JSON.stringify(list)), expected);
		assert.deepEqual(parseToolCalls(list), expected);
	});

	it("returns nothing for malformed JSON or a non-array", () => {
		for (const raw of ["not json at all", "", '{"id": "a"}', "null", "5", null, undefined, {}, 5, true]) {
			assert.deepEqual(parseToolCalls(raw), [], String(raw));
		}
	});

	it("skips entries missing an id, a function or a function name", () => {
		const list = [
			{ type: "function", function: { name: "read", arguments: "{}" } },
			{ id: "nofn", type: "function" },
			{ id: "badfn", function: "read" },
			{ id: "noname", function: { arguments: "{}" } },
			{ id: 5, function: { name: "read", arguments: "{}" } },
			null,
			"x",
			call("good", "read", "{}"),
		];
		assert.deepEqual(parseToolCalls(list), [{ id: "good", name: "read", arguments: {} }]);
	});

	it("reads arguments that are malformed, truncated or not an object as {}", () => {
		for (const args of [
			'{"doctype": ',
			"not json",
			"[1, 2]",
			'"str"',
			"5",
			"null",
			"",
			undefined,
			null,
			5,
			[1],
		]) {
			assert.deepEqual(
				parseToolCalls([call("a", "read", args)]),
				[{ id: "a", name: "read", arguments: {} }],
				String(args),
			);
		}
	});

	it("keeps arguments that are already an object", () => {
		assert.deepEqual(parseToolCalls([call("a", "read", { doctype: "ToDo" })]), [
			{ id: "a", name: "read", arguments: { doctype: "ToDo" } },
		]);
	});
});

describe("tool_result.ts", () => {
	it("parseToolContent parses JSON and falls back to the text", () => {
		assert.deepEqual(parseToolContent('{"a": [1, 2]}'), { a: [1, 2] });
		assert.equal(parseToolContent("42"), 42);
		assert.equal(parseToolContent("true"), true);
		assert.equal(parseToolContent("null"), null);
		assert.equal(parseToolContent('"quoted"'), "quoted");
		assert.equal(parseToolContent("plain text, not JSON"), "plain text, not JSON");
		assert.equal(parseToolContent("{oops"), "{oops");
		assert.equal(parseToolContent(""), "");
	});

	describe("toolError", () => {
		it("returns the message of an {error} payload", () => {
			assert.equal(toolError(TOOL_ERROR_RESULT), "No permission to read ToDo");
			assert.equal(toolError(pyJson({ error: "" })), "");
		});

		it("returns the joined failure messages when a bulk call produced nothing", () => {
			const allFailed = pyJson({
				doctype: "ToDo",
				created: [],
				failures: [{ row: 0, error: "A" }, { row: 1, error: "B" }, { row: 2 }],
			});
			assert.equal(toolError(allFailed), "A\nB");
			assert.equal(toolError(pyJson({ updated: [], failures: [{ error: "U" }] })), "U");
			assert.equal(toolError(pyJson({ deleted: [], failures: [{ error: "D" }] })), "D");
			assert.equal(toolError(pyJson({ failures: [{ error: "bare" }] })), "bare");
		});

		it("returns null for a partial success", () => {
			for (const key of ["created", "updated", "deleted"]) {
				assert.equal(toolError(pyJson({ [key]: ["x"], failures: [{ error: "B" }] })), null, key);
			}
		});

		it("returns null for payloads that are not failures", () => {
			assert.equal(toolError(pyJson({ failures: [] })), null);
			assert.equal(toolError(pyJson({ created: [], failures: [{ row: 0 }] })), null);
			assert.equal(toolError(pyJson({ created: [], failures: [{ error: 5 }] })), null);
			assert.equal(toolError(pyJson({ created: [], failures: "x" })), null);
			assert.equal(toolError(pyJson({ error: 5 })), null);
			assert.equal(toolError(pyJson([{ error: "in a list" }])), null);
			assert.equal(toolError("plain text"), null);
			assert.equal(toolError(""), null);
			assert.equal(toolError("42"), null);
		});

		it("prefers the error key over failures", () => {
			assert.equal(toolError(pyJson({ error: "top", created: [], failures: [{ error: "row" }] })), "top");
		});
	});

	describe("classifyToolResult", () => {
		it("classifies an error payload as a failure carrying its message", () => {
			assert.deepEqual(classifyToolResult(TOOL_ERROR_RESULT), {
				status: "failure",
				content: { error: "No permission to read ToDo" },
				error: "No permission to read ToDo",
				approval: null,
			});
		});

		it("classifies a bulk call by whether anything succeeded", () => {
			const failed = classifyToolResult(pyJson({ created: [], failures: [{ error: "Nope" }] }));
			assert.equal(failed.status, "failure");
			assert.equal(failed.error, "Nope");
			const partial = classifyToolResult(pyJson({ created: ["X"], failures: [{ error: "Nope" }] }));
			assert.equal(partial.status, "success");
			assert.equal(partial.error, null);
		});

		it("classifies denied and redirected payloads as failures with no error text", () => {
			const denied = pyJson({ status: "denied", message: "User denied this tool call." });
			assert.deepEqual(classifyToolResult(denied), {
				status: "failure",
				content: { status: "denied", message: "User denied this tool call." },
				error: null,
				approval: "denied",
			});
			const redirected = classifyToolResult(REDIRECT_RESULT);
			assert.equal(redirected.status, "failure");
			assert.equal(redirected.approval, "redirected");
			assert.equal(redirected.error, null);
			assert.deepEqual(redirected.content, JSON.parse(REDIRECT_RESULT));
		});

		it("keeps a payload with another status a success", () => {
			const outcome = classifyToolResult(pyJson({ status: "ok", rows: 3 }));
			assert.deepEqual(outcome, {
				status: "success",
				content: { status: "ok", rows: 3 },
				error: null,
				approval: null,
			});
		});

		it("classifies plain text, JSON scalars and the empty string as successes", () => {
			assert.deepEqual(classifyToolResult("ok"), {
				status: "success",
				content: "ok",
				error: null,
				approval: null,
			});
			assert.deepEqual(classifyToolResult("42"), {
				status: "success",
				content: 42,
				error: null,
				approval: null,
			});
			assert.deepEqual(classifyToolResult(""), {
				status: "success",
				content: "",
				error: null,
				approval: null,
			});
			assert.deepEqual(classifyToolResult("null"), {
				status: "success",
				content: null,
				error: null,
				approval: null,
			});
		});
	});
});
