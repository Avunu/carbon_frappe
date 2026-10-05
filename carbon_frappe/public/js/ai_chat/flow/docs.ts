// The slice of Flow's DocTypes this adapter reads through `frappe.client.get` /
// `get_list`. Every field below exists in the DocType JSON
// (flow/flow/doctype/{flow_session,flow_session_message,flow_session_attachment,
// flow_run}/*.json) and is written by flow_run.py / flow_session.py; nothing is
// here because the UI might want it.
//
// Frappe returns a missing value as null and omits fields a `get_list` did not
// ask for, so every optional field is `Maybe`. JSON fields (`tool_calls`,
// `questions`, `usage`) come back as the stored TEXT: flow's own client calls
// JSON.parse on them. The types also admit an already-parsed array so a framework
// that starts decoding JSON columns does not silently empty the history.

import { isRecord } from "../types.ts";

type Maybe<T> = T | null | undefined;

export type FlowRole = "system" | "user" | "assistant" | "tool";
export type FlowRunStatus = "Running" | "Paused" | "Completed" | "Failed";
export type FlowSource = "Manual" | "Trigger";
/** The stored values of `feedback_rating`. The API's "None" clears it to "", it is never stored. */
export type FlowFeedbackRating = "Up" | "Down";

/** A row of Flow Session's `messages` table: the transcript in OpenAI message shape. */
export interface FlowSessionMessageRow {
	/** A Data field: any string. Use `isFlowRole` before trusting it. */
	role: string;
	content?: Maybe<string>;
	/** Set on `role: "tool"` rows: the call this row answers. */
	tool_call_id?: Maybe<string>;
	/** Set on `role: "assistant"` rows that called tools: OpenAI `tool_calls`, JSON text. */
	tool_calls?: Maybe<string | unknown[]>;
	/** The Flow Run that produced the row. */
	run?: Maybe<string>;
}

/**
 * A row of Flow Session's `attachments` table: one file of one turn, tied to its user row by `run`. Only
 * the name and size are read back (history.ts); the extracted text stays on the server.
 */
export interface FlowSessionAttachmentRow {
	file: string;
	file_name?: Maybe<string>;
	file_size?: Maybe<number>;
	run?: Maybe<string>;
	mode?: Maybe<"Inline" | "Retrieval">;
}

/** `frappe.client.get("Flow Session", name)`. */
export interface FlowSessionDoc {
	name: string;
	title?: Maybe<string>;
	agent?: Maybe<string>;
	model?: Maybe<string>;
	source?: Maybe<FlowSource>;
	owner?: Maybe<string>;
	creation?: Maybe<string>;
	modified?: Maybe<string>;
	messages: FlowSessionMessageRow[];
	attachments: FlowSessionAttachmentRow[];
}

/** One row of the conversation list: `get_list("Flow Session", {fields: ["name", "title", "modified"]})`. */
export interface FlowSessionSummary {
	name: string;
	title?: Maybe<string>;
	modified?: Maybe<string>;
}

/** `frappe.client.get_list("Flow Run", ...)` rows. Which fields are present depends on the query's `fields`. */
export interface FlowRunDoc {
	name: string;
	session: string;
	status: FlowRunStatus;
	source?: Maybe<FlowSource>;
	iterations?: Maybe<number>;
	input?: Maybe<string>;
	output?: Maybe<string>;
	/** Set when `status` is "Failed" (flow_run.py rejects a Failed run without one). */
	error?: Maybe<string>;
	/** JSON: the pending `Question[]` of a Paused run (flow_run.py rejects a Paused run without one). */
	questions?: Maybe<string | unknown[]>;
	tool_calls?: Maybe<string | unknown[]>;
	usage?: Maybe<string | Record<string, unknown>>;
	/** "" and null both mean "no feedback". */
	feedback_rating?: Maybe<FlowFeedbackRating | "">;
	feedback_comment?: Maybe<string>;
	creation?: Maybe<string>;
	modified?: Maybe<string>;
}

/** One entry of an assistant row's OpenAI `tool_calls`, with `function.arguments` already decoded. */
export interface FlowToolCall {
	id: string;
	name: string;
	/** `{}` when the stored arguments were malformed or not an object (the run then recorded an error result). */
	arguments: Record<string, unknown>;
}

// -- guards -------------------------------------------------------------------

function isMaybeString(value: unknown): value is Maybe<string> {
	return value === undefined || value === null || typeof value === "string";
}

function isMaybeJson(value: unknown): value is Maybe<string | unknown[]> {
	return isMaybeString(value) || Array.isArray(value);
}

export function isFlowRole(value: unknown): value is FlowRole {
	return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function isFlowRunStatus(value: unknown): value is FlowRunStatus {
	return value === "Running" || value === "Paused" || value === "Completed" || value === "Failed";
}

export function isFlowSessionMessageRow(value: unknown): value is FlowSessionMessageRow {
	return (
		isRecord(value) &&
		typeof value["role"] === "string" &&
		isMaybeString(value["content"]) &&
		isMaybeString(value["tool_call_id"]) &&
		isMaybeJson(value["tool_calls"]) &&
		isMaybeString(value["run"])
	);
}

export function isFlowSessionAttachmentRow(value: unknown): value is FlowSessionAttachmentRow {
	return isRecord(value) && typeof value["file"] === "string" && isMaybeString(value["run"]);
}

export function isFlowSessionSummary(value: unknown): value is FlowSessionSummary {
	return (
		isRecord(value) &&
		typeof value["name"] === "string" &&
		isMaybeString(value["title"]) &&
		isMaybeString(value["modified"])
	);
}

export function isFlowRunDoc(value: unknown): value is FlowRunDoc {
	if (!isRecord(value)) return false;
	const rating = value["feedback_rating"];
	return (
		typeof value["name"] === "string" &&
		typeof value["session"] === "string" &&
		isFlowRunStatus(value["status"]) &&
		isMaybeString(value["error"]) &&
		isMaybeJson(value["questions"]) &&
		isMaybeString(value["feedback_comment"]) &&
		(rating === undefined || rating === null || rating === "" || rating === "Up" || rating === "Down")
	);
}

// -- parsers ------------------------------------------------------------------

/**
 * Validate a `frappe.client.get("Flow Session")` response. A row that fails
 * `isFlowSessionMessageRow` is dropped rather than failing the whole session: one
 * odd row should not make a conversation unreadable. Null only when there is no
 * usable session at all.
 */
export function parseFlowSessionDoc(value: unknown): FlowSessionDoc | null {
	if (!isRecord(value) || typeof value["name"] !== "string") return null;
	const rows = value["messages"];
	const attachments = value["attachments"];
	const doc: FlowSessionDoc = {
		name: value["name"],
		messages: Array.isArray(rows) ? rows.filter(isFlowSessionMessageRow) : [],
		attachments: Array.isArray(attachments) ? attachments.filter(isFlowSessionAttachmentRow) : [],
	};
	const textFields: ("title" | "agent" | "model" | "owner" | "creation" | "modified")[] = [
		"title",
		"agent",
		"model",
		"owner",
		"creation",
		"modified",
	];
	for (const field of textFields) {
		const entry = value[field];
		if (typeof entry === "string") doc[field] = entry;
	}
	const source = value["source"];
	if (source === "Manual" || source === "Trigger") doc.source = source;
	return doc;
}

export function parseFlowSessionSummaries(value: unknown): FlowSessionSummary[] {
	return Array.isArray(value) ? value.filter(isFlowSessionSummary) : [];
}

export function parseFlowRunDocs(value: unknown): FlowRunDoc[] {
	return Array.isArray(value) ? value.filter(isFlowRunDoc) : [];
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * OpenAI `tool_calls` (a JSON string, or the array) to `FlowToolCall[]`. Total:
 * malformed JSON, a non-array, and entries without an `id` or `function.name`
 * produce fewer calls, never an exception.
 */
export function parseToolCalls(raw: unknown): FlowToolCall[] {
	const list = typeof raw === "string" ? parseJson(raw) : raw;
	if (!Array.isArray(list)) return [];
	const calls: FlowToolCall[] = [];
	for (const entry of list) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const fn = entry["function"];
		if (!isRecord(fn) || typeof fn["name"] !== "string") continue;
		const args = typeof fn["arguments"] === "string" ? parseJson(fn["arguments"]) : fn["arguments"];
		calls.push({ id: entry["id"], name: fn["name"], arguments: isRecord(args) ? args : {} });
	}
	return calls;
}
