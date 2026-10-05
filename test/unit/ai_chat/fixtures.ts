// Recorded-shape flow transcripts shared by every ai_chat test. Nothing here is
// invented: the event order, the double `tool_started`, the "" `tool_ended` of a
// paused call, the replayed `tool_ended` of a resume, and the question prompts all
// follow flow/lib/agent.py `_loop_stream` / `_resume_stream` and the builtin tools'
// `confirm_prompt` in flow/tools/builtins.py. The wire text is produced by `pyJson`,
// which reproduces Python's `json.dumps` defaults (", " and ": " separators, every
// non-ASCII code unit escaped) so a parser is tested against the bytes flow sends,
// not against what JSON.stringify would have sent.

import type {
	DoneEvent,
	ErrorEvent,
	FlowEvent,
	FlowQuestion,
	RunStartedEvent,
	TextEvent,
	ToolEndedEvent,
	ToolStartedEvent,
} from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import type {
	FlowRunDoc,
	FlowSessionDoc,
	FlowSessionMessageRow,
} from "../../../carbon_frappe/public/js/ai_chat/flow/docs.ts";

// -- Python-compatible JSON ---------------------------------------------------

function pyString(text: string): string {
	let out = '"';
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		const ch = text.charAt(i);
		if (ch === '"') out += '\\"';
		else if (ch === "\\") out += "\\\\";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\b") out += "\\b";
		else if (ch === "\f") out += "\\f";
		else if (unit < 0x20 || unit > 0x7e) out += `\\u${unit.toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return `${out}"`;
}

/** `json.dumps(value)`: default separators, `ensure_ascii=True`. Integers only. */
export function pyJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return pyString(value);
	if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value).map(([key, entry]) => `${pyString(key)}: ${pyJson(entry)}`);
		return `{${entries.join(", ")}}`;
	}
	throw new TypeError(`pyJson: unsupported ${typeof value}`);
}

/** One SSE frame exactly as `_format_sse` writes it. */
export function frame(event: FlowEvent): string {
	return `event: ${event.type}\ndata: ${pyJson(toWire(event))}\n\n`;
}

/** `_event_to_dict`: a Completed `done` has no `questions` key; every other event is its own payload. */
function toWire(event: FlowEvent): unknown {
	if (event.type !== "done" || event.status === "Paused") return event;
	const { questions: _questions, ...rest } = event;
	return rest;
}

export function wireOf(events: readonly FlowEvent[]): string {
	return events.map(frame).join("");
}

// -- event builders -----------------------------------------------------------

export const ev = {
	runStarted: (name: string, session: string): RunStartedEvent => ({ type: "run_started", name, session }),
	text: (delta: string): TextEvent => ({ type: "text", delta }),
	toolStarted: (id: string, name: string, args: Record<string, unknown> = {}): ToolStartedEvent => ({
		type: "tool_started",
		id,
		name,
		arguments: args,
	}),
	toolEnded: (id: string, name: string, result: string): ToolEndedEvent => ({
		type: "tool_ended",
		id,
		name,
		result,
	}),
	done: (
		status: "Completed" | "Paused",
		output: string | null,
		iterations: number,
		usage: Record<string, number>,
		questions: FlowQuestion[] = [],
	): DoneEvent => ({ type: "done", status, iterations, output, usage, questions }),
	error: (message: string): ErrorEvent => ({ type: "error", message }),
};

export interface Transcript {
	/** What `readFlowEvents` must yield, in order. */
	events: FlowEvent[];
	/** The bytes on the wire, as text. */
	wire: string;
}

function transcript(events: FlowEvent[]): Transcript {
	return { events, wire: wireOf(events) };
}

// -- identifiers --------------------------------------------------------------

export const RUN = "k3j9x8h2ab";
export const SESSION = "t5r2m7q1cd";
export const CALL_READ = "call_8fQx2LmN";
export const CALL_CREATE = "call_Cr4tE1xY";
export const CALL_DELETE = "call_De1eT2zW";
export const CALL_CREATE_AGAIN = "call_Cr4tE3vU";

const USAGE_A = { prompt_tokens: 142, completion_tokens: 11, total_tokens: 153 };
const USAGE_B = { prompt_tokens: 233, completion_tokens: 41, total_tokens: 274 };

// -- stream transcripts -------------------------------------------------------

/** One iteration, no tools. */
export const TEXT_ONLY: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("Hello"),
	ev.text(" there"),
	ev.text("! How can I help?"),
	ev.done("Completed", "Hello there! How can I help?", 1, USAGE_A),
]);

/**
 * Non-ASCII text. On the wire flow escapes it (`é`, surrogate pairs for the
 * emoji), so the real bytes are ASCII; `TEXT_UNICODE_RAW` is the same stream with
 * the characters sent as UTF-8, which is legal SSE and what exercises the decoder
 * when a chunk boundary lands inside a character.
 */
export const TEXT_UNICODE: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("Café "),
	ev.text("☕ — 你好 "),
	ev.text("\u{1F600}"),
	ev.done("Completed", "Café ☕ — 你好 \u{1F600}", 1, USAGE_A),
]);

export const TEXT_UNICODE_RAW: string = TEXT_UNICODE.events
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(toWire(event))}\n\n`)
	.join("");

const TODO_ROWS = [
	{ name: "TD-0001", description: "Call Alice" },
	{ name: "TD-0002", description: "Send the Q3 report" },
];

export const READ_ARGS = { doctype: "ToDo", filters: { status: "Open" }, fields: ["name", "description"] };
export const READ_RESULT = pyJson(TODO_ROWS);

/**
 * text -> tool -> text. `tool_started` appears twice for the one call: empty
 * arguments while the model is still streaming the call, then the full arguments
 * right before the tool runs.
 */
export const TEXT_TOOL_TEXT: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("Let me check "),
	ev.text("your open ToDos. "),
	ev.toolStarted(CALL_READ, "read", {}),
	ev.toolStarted(CALL_READ, "read", READ_ARGS),
	ev.toolEnded(CALL_READ, "read", READ_RESULT),
	ev.text("You have **2** open ToDos:\n\n"),
	ev.text("- TD-0001: Call Alice\n- TD-0002: Send the Q3 report"),
	ev.done(
		"Completed",
		"You have **2** open ToDos:\n\n- TD-0001: Call Alice\n- TD-0002: Send the Q3 report",
		2,
		USAGE_B,
	),
]);

export const CREATE_ARGS = { doctype: "ToDo", records: [{ description: "Call Bob" }] };
export const DELETE_ARGS = { doctype: "ToDo", names: ["TD-0001"] };

export const QUESTION_CREATE: FlowQuestion = {
	prompt: 'Approve `create`?\n\nCreate 1 ToDo record(s):\n\n{\n  "description": "Call Bob"\n}',
	options: ["Approve", "Deny"],
	multi_select: false,
	allow_other: true,
	key: CALL_CREATE,
};
export const QUESTION_DELETE: FlowQuestion = {
	prompt: "Approve `delete`?\n\nDelete 1 ToDo: TD-0001",
	options: ["Approve", "Deny"],
	multi_select: false,
	allow_other: true,
	key: CALL_DELETE,
};

/**
 * The model calls `create` and `delete` in one iteration; both need approval. Both
 * calls are announced first (empty arguments), then each is re-announced with its
 * arguments and ended with "" because it is parked, then `done` lists the questions.
 */
export const PAUSED_TWO_QUESTIONS: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("I'll create that ToDo"),
	ev.text(" and remove the old one."),
	ev.toolStarted(CALL_CREATE, "create", {}),
	ev.toolStarted(CALL_DELETE, "delete", {}),
	ev.toolStarted(CALL_CREATE, "create", CREATE_ARGS),
	ev.toolEnded(CALL_CREATE, "create", ""),
	ev.toolStarted(CALL_DELETE, "delete", DELETE_ARGS),
	ev.toolEnded(CALL_DELETE, "delete", ""),
	ev.done("Paused", "I'll create that ToDo and remove the old one.", 1, USAGE_B, [
		QUESTION_CREATE,
		QUESTION_DELETE,
	]),
]);

const CREATED_RESULT = pyJson({ doctype: "ToDo", created: ["TD-0003"] });
const DELETED_RESULT = pyJson({ doctype: "ToDo", deleted: ["TD-0001"] });
const DENIED_RESULT = pyJson({ status: "denied", message: "User denied this tool call." });

/** The `answers` that produce each resume transcript below, as `resume_run` receives them. */
export const ANSWERS_APPROVE_ALL = { [CALL_CREATE]: "Approve", [CALL_DELETE]: "Approve" };
export const ANSWERS_DENY = { [CALL_CREATE]: "Deny", [CALL_DELETE]: "Approve" };
export const ANSWERS_REDIRECT = { [CALL_CREATE]: "Make it high priority", [CALL_DELETE]: "Approve" };

/**
 * Resume after approving both. Same run name as the paused stream. The resolved
 * calls' results are replayed FIRST, with no `tool_started` before them; then the
 * loop continues and streams the closing text.
 */
export const RESUME_APPROVED: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.toolEnded(CALL_CREATE, "create", CREATED_RESULT),
	ev.toolEnded(CALL_DELETE, "delete", DELETED_RESULT),
	ev.text("Done. "),
	ev.text("I created TD-0003 and deleted TD-0001."),
	ev.done("Completed", "Done. I created TD-0003 and deleted TD-0001.", 1, USAGE_A),
]);

/**
 * Any Deny halts the run with no further model call: replayed results, then a
 * Completed `done` with `output: null`, zero iterations and empty usage
 * (`_stopped_result`). The Approve answer for the other call still ran its tool.
 */
export const RESUME_DENIED: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.toolEnded(CALL_CREATE, "create", DENIED_RESULT),
	ev.toolEnded(CALL_DELETE, "delete", DELETED_RESULT),
	ev.done("Completed", null, 0, {}),
]);

/**
 * Free text on a call is a redirect: the tool is not run and the model gets the
 * feedback. Here it answers by calling `create` again, which pauses the run a
 * second time with a new tool call id.
 */
export const REDIRECT_RESULT = pyJson({
	status: "redirect",
	message: "Tool not executed.",
	user_feedback: "Make it high priority",
	instruction:
		"The user wants changes before this proceeds. Read their feedback carefully, adjust your approach, and try again.",
});

export const CREATE_HIGH_ARGS = { doctype: "ToDo", records: [{ description: "Call Bob", priority: "High" }] };

export const QUESTION_CREATE_AGAIN: FlowQuestion = {
	prompt:
		'Approve `create`?\n\nCreate 1 ToDo record(s):\n\n{\n  "description": "Call Bob",\n  "priority": "High"\n}',
	options: ["Approve", "Deny"],
	multi_select: false,
	allow_other: true,
	key: CALL_CREATE_AGAIN,
};

export const RESUME_REDIRECTED_PAUSED_AGAIN: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.toolEnded(CALL_CREATE, "create", REDIRECT_RESULT),
	ev.toolEnded(CALL_DELETE, "delete", DELETED_RESULT),
	ev.text("Understood, "),
	ev.text("creating it with high priority."),
	ev.toolStarted(CALL_CREATE_AGAIN, "create", {}),
	ev.toolStarted(CALL_CREATE_AGAIN, "create", CREATE_HIGH_ARGS),
	ev.toolEnded(CALL_CREATE_AGAIN, "create", ""),
	ev.done("Paused", "Understood, creating it with high priority.", 1, USAGE_B, [QUESTION_CREATE_AGAIN]),
]);

/** A tool that threw: the result is an `{error}` payload and the run carries on. */
export const TOOL_ERROR_RESULT = pyJson({ error: "No permission to read ToDo" });

export const TOOL_ERROR: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.toolStarted(CALL_READ, "read", {}),
	ev.toolStarted(CALL_READ, "read", { doctype: "ToDo" }),
	ev.toolEnded(CALL_READ, "read", TOOL_ERROR_RESULT),
	ev.text("I don't have permission to read ToDos."),
	ev.done("Completed", "I don't have permission to read ToDos.", 2, USAGE_B),
]);

export const ERROR_MESSAGE =
	"litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided";

/** The model call raised before any token: `run_started` is always first, then `error`. */
export const ERROR_BEFORE_TEXT: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.error(ERROR_MESSAGE),
]);

export const ERROR_MID_TEXT: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("Let me "),
	ev.error("Connection reset by peer"),
]);

/**
 * `stream_with_persistence` yields `Done` and only then persists it; if persisting
 * raises, `Error` follows a `done`. A consumer must not treat `done` as the last frame.
 */
export const ERROR_AFTER_DONE: Transcript = transcript([
	ev.runStarted(RUN, SESSION),
	ev.text("Hi."),
	ev.done("Completed", "Hi.", 1, USAGE_A),
	ev.error("Data too long for column 'output' at row 1"),
]);

// -- non-2xx response ---------------------------------------------------------

/**
 * `start_run` on a session whose last run is Paused: `frappe.throw` becomes HTTP 417
 * with `_server_messages` (a JSON array of JSON-encoded message objects) and no SSE.
 */
export const HTTP_ERROR_PAUSED = {
	status: 417,
	message: "This session has a paused run. Resume it before starting a new turn.",
	body: {
		exc_type: "ValidationError",
		exception:
			"frappe.exceptions.ValidationError: This session has a paused run. Resume it before starting a new turn.",
		_server_messages: JSON.stringify([
			JSON.stringify({
				message: "This session has a paused run. Resume it before starting a new turn.",
				title: "Run Paused",
				indicator: "red",
				raise_exception: 1,
			}),
		]),
	},
};

/** A 403 carries `_error_message` instead of `_server_messages`. */
export const HTTP_ERROR_FORBIDDEN = {
	status: 403,
	message: "Not permitted to use this session.",
	body: { exc_type: "PermissionError", _error_message: "Not permitted to use this session." },
};

// -- byte-level helpers -------------------------------------------------------

const encoder = new TextEncoder();

export function encode(text: string): Uint8Array {
	return encoder.encode(text);
}

/** UTF-8 bytes of `text` cut every `size` bytes, so a multi-byte character can straddle two chunks. */
export function chunkBytes(text: string, size: number): Uint8Array[] {
	const bytes = encode(text);
	const chunks: Uint8Array[] = [];
	for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.slice(start, start + size));
	return chunks;
}

/** `text` cut every `size` UTF-16 code units. Never splits a character that fits in the BMP. */
export function chunkText(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += size) chunks.push(text.slice(start, start + size));
	return chunks;
}

export interface TestBody {
	stream: ReadableStream<Uint8Array>;
	/** True once the consumer cancelled the stream (or its reader). */
	cancelled: () => boolean;
}

/**
 * A body that delivers one chunk per read. With `hold`, it then stays open instead
 * of closing, as a server mid-turn would, until the consumer cancels it. With
 * `failAfter`, the read after that many chunks rejects (a dropped connection).
 */
export function bodyFrom(
	chunks: readonly (string | Uint8Array)[],
	options: { hold?: boolean; failAfter?: number } = {},
): TestBody {
	let index = 0;
	let wasCancelled = false;
	let release: () => void = () => {};
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (options.failAfter !== undefined && index >= options.failAfter) {
					controller.error(new TypeError("network error"));
					return;
				}
				const chunk = chunks[index++];
				if (chunk !== undefined) {
					controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
				} else if (options.hold) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				} else {
					controller.close();
				}
			},
			cancel() {
				wasCancelled = true;
				release();
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, cancelled: () => wasCancelled };
}

// -- Flow Session / Flow Run docs ---------------------------------------------

export const SYSTEM_PROMPT = "You are Flow, an assistant for this ERP site.";

function toolCallsJson(
	calls: readonly { id: string; name: string; args: Record<string, unknown> }[],
): string {
	return pyJson(
		calls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: pyJson(call.args) },
		})),
	);
}

function row(fields: Partial<FlowSessionMessageRow> & { role: string }): FlowSessionMessageRow {
	return { content: null, tool_call_id: null, tool_calls: null, run: null, ...fields };
}

function run(name: string, fields: Partial<FlowRunDoc> & Pick<FlowRunDoc, "status">): FlowRunDoc {
	return {
		name,
		session: SESSION,
		input: null,
		output: null,
		error: null,
		questions: null,
		feedback_rating: "",
		feedback_comment: null,
		...fields,
	};
}

function sessionDoc(messages: FlowSessionMessageRow[], name = SESSION): FlowSessionDoc {
	return {
		name,
		title: "What are my open todos?",
		agent: "Flow",
		model: null,
		source: "Manual",
		owner: "kevin@avu.nu",
		creation: "2026-10-01 09:00:00.123456",
		modified: "2026-10-01 09:05:00.654321",
		messages,
		attachments: [],
	};
}

export const RUN_1 = "r1aaaaaaaa";
export const RUN_2 = "r2bbbbbbbb";
export const RUN_3 = "r3cccccccc";
export const RUN_4 = "r4dddddddd";

/**
 * Two completed turns. Turn 1 has a tool call (assistant row with `tool_calls`,
 * a `tool` row, a closing assistant row: one iteration each, to be merged into ONE
 * response); turn 2 is plain text. Run 1 has a thumbs-up, run 2 a thumbs-down with
 * a comment. The leading `system` row is persisted too.
 */
export const SESSION_COMPLETED: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([
		row({ role: "system", content: SYSTEM_PROMPT, run: RUN_1 }),
		row({ role: "user", content: "What are my open todos?", run: RUN_1 }),
		row({
			role: "assistant",
			content: "Let me check your open ToDos. ",
			tool_calls: toolCallsJson([{ id: CALL_READ, name: "read", args: READ_ARGS }]),
			run: RUN_1,
		}),
		row({ role: "tool", content: READ_RESULT, tool_call_id: CALL_READ, run: RUN_1 }),
		row({
			role: "assistant",
			content: "You have **2** open ToDos:\n\n- TD-0001: Call Alice\n- TD-0002: Send the Q3 report",
			run: RUN_1,
		}),
		row({ role: "user", content: "Thanks!", run: RUN_2 }),
		row({ role: "assistant", content: "Anytime.", run: RUN_2 }),
	]),
	runs: [
		run(RUN_1, { status: "Completed", feedback_rating: "Up" }),
		run(RUN_2, { status: "Completed", feedback_rating: "Down", feedback_comment: "Too curt" }),
	],
};

/**
 * Paused on two approvals: the assistant row carries both calls and there is NO
 * `tool` row for either yet. The Flow Run is Paused with `questions` JSON.
 */
export const SESSION_PAUSED: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([
		row({ role: "system", content: SYSTEM_PROMPT, run: RUN }),
		row({ role: "user", content: "Create a ToDo to call Bob and delete the old one", run: RUN }),
		row({
			role: "assistant",
			content: "I'll create that ToDo and remove the old one.",
			tool_calls: toolCallsJson([
				{ id: CALL_CREATE, name: "create", args: CREATE_ARGS },
				{ id: CALL_DELETE, name: "delete", args: DELETE_ARGS },
			]),
			run: RUN,
		}),
	]),
	runs: [run(RUN, { status: "Paused", questions: pyJson([QUESTION_CREATE, QUESTION_DELETE]) })],
};

/**
 * The paused session after a Deny: both calls resolved (one denied, one executed),
 * and the run ends there with no closing assistant row (`_stopped_result`).
 */
export const SESSION_DENIED: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([
		...SESSION_PAUSED.session.messages,
		row({ role: "tool", content: DENIED_RESULT, tool_call_id: CALL_CREATE, run: RUN }),
		row({ role: "tool", content: DELETED_RESULT, tool_call_id: CALL_DELETE, run: RUN }),
	]),
	runs: [run(RUN, { status: "Completed" })],
};

/**
 * Hostile input: a tool call whose JSON is truncated, an entry without a function,
 * a tool row for an id nobody called, a tool row before any assistant row, an
 * errored tool, and a bulk create where every record failed.
 */
export const SESSION_MALFORMED: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([
		row({
			role: "tool",
			content: '{"orphan": true}',
			tool_call_id: "call_nobody",
			run: RUN_3,
		}),
		row({ role: "user", content: "Try the broken things", run: RUN_3 }),
		row({
			role: "assistant",
			content: "Trying.",
			tool_calls:
				'[{"id": "call_ok", "type": "function", "function": {"name": "read", "arguments": "{\\"doctype\\": \\"ToDo\\"}"}}, {"id": "call_trunc", "type": "function", "function": {"name": "read", "arguments": "{\\"doctype\\": "}}, {"id": "call_nofn", "type": "function"}, {"type": "function", "function": {"name": "read", "arguments": "{}"}}]',
			run: RUN_3,
		}),
		row({ role: "tool", content: TOOL_ERROR_RESULT, tool_call_id: "call_ok", run: RUN_3 }),
		row({
			role: "tool",
			content: pyJson({
				doctype: "ToDo",
				created: [],
				failures: [{ row: 0, error: "Description is required" }],
			}),
			tool_call_id: "call_trunc",
			run: RUN_3,
		}),
		row({ role: "tool", content: "plain text, not JSON", tool_call_id: "call_nobody", run: RUN_3 }),
		row({ role: "assistant", content: "That did not go well.", tool_calls: "not json at all", run: RUN_3 }),
		// A turn whose stream died before a reply was persisted, then the next turn.
		row({ role: "user", content: "Hello? Anyone there?", run: RUN_4 }),
		row({ role: "user", content: "Try again please", run: RUN_1 }),
		row({ role: "assistant", content: "Back now.", run: RUN_1 }),
	]),
	runs: [
		run(RUN_3, { status: "Completed" }),
		run(RUN_4, { status: "Failed", error: "Stopped by user." }),
		run(RUN_1, { status: "Completed" }),
	],
};

/** A Failed run with no rows besides the user's, carrying no error text of its own. */
export const SESSION_INTERRUPTED_NO_ERROR: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([row({ role: "user", content: "Anyone?", run: RUN_4 })]),
	runs: [run(RUN_4, { status: "Failed", error: "Run abandoned: stream ended without completing." })],
};

/** A conversation with nothing in it but its system prompt. */
export const SESSION_EMPTY: { session: FlowSessionDoc; runs: FlowRunDoc[] } = {
	session: sessionDoc([row({ role: "system", content: SYSTEM_PROMPT, run: RUN_1 })]),
	runs: [],
};
