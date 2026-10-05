// The frames flow.api.start_run / resume_run send with `stream=1`, as typed values.
// Source of truth is `_event_to_dict` in flow/api/api.py; each variant below is one
// branch of it. The frame is `event: <type>\ndata: <json>\n\n` and the JSON repeats
// the type, so either can name the event.
//
// Two wire facts that bite the consumers of this union:
//
// 1. `tool_started` is sent TWICE per call. The first frame is emitted the moment
//    the model begins streaming the call and carries `arguments: {}`
//    (agent.py `_loop_stream`, `ToolCallBegin`); the second is emitted once the
//    arguments have finished streaming, just before the tool runs, and carries the
//    full arguments. The two frames share `id`. A consumer must key on `id`, create
//    the step on the first frame and fill the arguments on the second; it must
//    never render one card per frame.
//
// 2. `tool_ended.result` is "" when the call is paused awaiting approval
//    (`yield ToolEnded(result="")` in the `Question` branch). It is also "" when a
//    tool simply returned None (`_serialize_tool_result(None)`), so "" alone does
//    not say which; only the `done` frame that follows does (Paused lists the
//    awaiting calls as `questions[].key`). A resume stream replays `tool_ended` for
//    every call it resolves BEFORE continuing the loop, with no `tool_started` in
//    front of them.

import { isRecord } from "../types.ts";

export interface FlowQuestion {
	prompt: string;
	options: string[];
	multi_select: boolean;
	allow_other: boolean;
	/** The tool call id the answer routes back to. Typed nullable because the server's `Question.key` is. */
	key: string | null;
}

export interface RunStartedEvent {
	type: "run_started";
	name: string;
	session: string;
}

export interface TextEvent {
	type: "text";
	delta: string;
}

export interface ToolStartedEvent {
	type: "tool_started";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolEndedEvent {
	type: "tool_ended";
	id: string;
	name: string;
	/** The tool's JSON-serialized return value; "" while paused for approval. */
	result: string;
}

export interface DoneEvent {
	type: "done";
	status: "Completed" | "Paused";
	iterations: number;
	/** The final assistant message; null for a denied resume. */
	output: string | null;
	usage: Record<string, number>;
	/** Wire: present only when Paused. Normalized to [] when absent so consumers need no check. */
	questions: FlowQuestion[];
}

export interface ErrorEvent {
	type: "error";
	/** Empty when the frame carried none; the view then shows its own generic text. */
	message: string;
}

export type FlowEvent =
	| RunStartedEvent
	| TextEvent
	| ToolStartedEvent
	| ToolEndedEvent
	| DoneEvent
	| ErrorEvent;

export const FLOW_EVENT_NAMES: readonly FlowEvent["type"][] = [
	"run_started",
	"text",
	"tool_started",
	"tool_ended",
	"done",
	"error",
];

function isEventName(name: string): name is FlowEvent["type"] {
	return FLOW_EVENT_NAMES.some((known) => known === name);
}

export function parseFlowQuestion(value: unknown): FlowQuestion | null {
	if (!isRecord(value)) return null;
	const prompt = value["prompt"];
	if (typeof prompt !== "string") return null;
	const options = value["options"];
	const key = value["key"];
	return {
		prompt,
		options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [],
		multi_select: value["multi_select"] === true,
		allow_other: value["allow_other"] !== false,
		key: typeof key === "string" ? key : null,
	};
}

/**
 * Questions from a `done` frame or a Flow Run's `questions` JSON field. Takes an
 * array or the JSON text of one; anything else, and entries without a prompt,
 * yield nothing rather than throwing.
 */
export function parseFlowQuestions(value: unknown): FlowQuestion[] {
	let list = value;
	if (typeof list === "string") {
		try {
			list = JSON.parse(list);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(list)) return [];
	const questions: FlowQuestion[] = [];
	for (const entry of list) {
		const question = parseFlowQuestion(entry);
		if (question) questions.push(question);
	}
	return questions;
}

function numberRecord(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isRecord(value)) return out;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
	}
	return out;
}

/**
 * Turn one decoded frame into a `FlowEvent`.
 *
 * `eventName` is the frame's `event:` field. When it is empty or the SSE default
 * "message" (a proxy that dropped the field), the payload's own `type` names the
 * event, which is what flow's Vue client reads. `null` means "ignore this frame":
 * an unknown event name, or a known one whose payload lacks a required field. It
 * is lenient about optional fields (see each variant) so a server that adds one
 * keeps working.
 */
export function parseFlowEvent(eventName: string, data: unknown): FlowEvent | null {
	if (!isRecord(data)) return null;
	const payloadType = data["type"];
	const name =
		(eventName === "" || eventName === "message") && typeof payloadType === "string"
			? payloadType
			: eventName;
	if (!isEventName(name)) return null;

	switch (name) {
		case "run_started": {
			const runName = data["name"];
			const session = data["session"];
			if (typeof runName !== "string" || typeof session !== "string") return null;
			return { type: "run_started", name: runName, session };
		}
		case "text": {
			const delta = data["delta"];
			return typeof delta === "string" ? { type: "text", delta } : null;
		}
		case "tool_started": {
			const id = data["id"];
			const toolName = data["name"];
			if (typeof id !== "string" || typeof toolName !== "string") return null;
			const args = data["arguments"];
			return { type: "tool_started", id, name: toolName, arguments: isRecord(args) ? args : {} };
		}
		case "tool_ended": {
			const id = data["id"];
			const toolName = data["name"];
			const result = data["result"];
			if (typeof id !== "string" || typeof toolName !== "string" || typeof result !== "string") {
				return null;
			}
			return { type: "tool_ended", id, name: toolName, result };
		}
		case "done": {
			const iterations = data["iterations"];
			const output = data["output"];
			return {
				type: "done",
				status: data["status"] === "Paused" ? "Paused" : "Completed",
				iterations: typeof iterations === "number" && Number.isFinite(iterations) ? iterations : 0,
				output: typeof output === "string" ? output : null,
				usage: numberRecord(data["usage"]),
				questions: parseFlowQuestions(data["questions"]),
			};
		}
		case "error": {
			const message = data["message"];
			return { type: "error", message: typeof message === "string" ? message : "" };
		}
	}
}
