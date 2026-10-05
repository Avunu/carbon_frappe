// Rebuild SDK-shaped messages from a stored Flow Session. Port of `switchSession` in
// flow's frontend store.js, with the server-side facts it leans on:
//
// - The doc keeps one `assistant` row per model iteration (plus a `tool` row per
//   call), while a live stream is ONE response. Consecutive assistant/tool rows
//   therefore merge, or a reloaded conversation would look different from the one
//   the user watched.
// - Run state (Failed, Paused, feedback) is not on the rows; it comes from the
//   Flow Run list, which is why `runs` is a parameter.
// - A turn's files are `Flow Session Attachment` rows matched to the user row by `run`; a row whose run
//   has no user row (or a user row with no run) has nowhere to be drawn and is dropped.

import type {
	ChainOfThoughtStep,
	FlowApprovalItem,
	GenericItem,
	InlineErrorItem,
	Message,
	MessageRequest,
	MessageResponse,
	MessageResponseHistory,
	TextItem,
} from "../types.ts";
import { isTextItem } from "../types.ts";
import { parseFlowQuestions } from "./events.ts";
import type { FlowQuestion } from "./events.ts";
import { parseToolCalls } from "./docs.ts";
import type { FlowRunDoc, FlowSessionDoc, FlowSessionMessageRow, FlowToolCall } from "./docs.ts";
import { classifyToolResult } from "./tool_result.ts";
import { serverDatetimeToEpoch } from "../timestamps.ts";
import { fileFieldsFromRows } from "../uploads.ts";
import { normalizeToolName, toolStepTitle } from "./tool_labels.ts";
import type { Translate } from "./tool_labels.ts";

export interface HistoryOptions {
	translate?: Translate;
	/**
	 * The zone `Flow Run.creation` is stored in (`readTimeZones(frappe.boot).system`). Each request and
	 * response gets `history.timestamp` from the creation of its run; absent, the browser's zone.
	 */
	systemTimeZone?: string;
}

/**
 * The run the user still has to answer: the last Paused run that actually has
 * questions. A Paused run without parseable questions cannot be shown as a card,
 * and the server refuses to save one, so it is treated as not paused.
 */
export function pausedRun(runs: readonly FlowRunDoc[]): FlowRunDoc | undefined {
	for (let i = runs.length - 1; i >= 0; i--) {
		const run = runs[i];
		if (run !== undefined && run.status === "Paused" && parseFlowQuestions(run.questions).length > 0) {
			return run;
		}
	}
	return undefined;
}

/** The response being assembled from consecutive assistant/tool rows. */
interface Draft {
	requestId: string | undefined;
	/** The first non-empty `run` among its rows; later rows of the same turn carry the same one. */
	run: string | null;
	items: GenericItem[];
	steps: ChainOfThoughtStep[];
	textCount: number;
}

/** The request most recently pushed, tracked to detect a turn that never got a reply. */
interface PendingRequest {
	id: string;
	run: string | null;
	replied: boolean;
}

function runOf(row: FlowSessionMessageRow): string | null {
	return typeof row.run === "string" && row.run !== "" ? row.run : null;
}

function isBlank(text: string | null | undefined): boolean {
	return text === null || text === undefined || text.trim() === "";
}

function hasKeys(args: Record<string, unknown>): boolean {
	return Object.keys(args).length > 0;
}

function lastTextIndex(items: readonly GenericItem[]): number {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (isTextItem(item) && !isBlank(item.text)) return i;
	}
	return -1;
}

function errorItem(text: string | undefined): InlineErrorItem {
	const item: InlineErrorItem = { response_type: "inline_error", streaming_metadata: { id: "error-1" } };
	if (text !== undefined) item.text = text;
	return item;
}

// Flow marks a run the user stopped as Failed, and two writers race to set its
// error (api.stop_run and the generator's finally), so either string can be stored.
// Neither is a fault, so neither is shown as one.
const STOP_ERRORS: ReadonlySet<string> = new Set(["Stopped by user.", "Stream interrupted"]);

function wasStopped(run: FlowRunDoc | undefined): boolean {
	const error = failureText(run);
	return error !== undefined && STOP_ERRORS.has(error.trim());
}

// What the live view ends with after Stop: Carbon renders "Response stopped" for any
// item carrying `stream_stopped`, so the text is empty.
function stoppedItem(): TextItem {
	return { response_type: "text", text: "", streaming_metadata: { id: "stopped-1", stream_stopped: true } };
}

function failureItem(run: FlowRunDoc | undefined): GenericItem {
	return wasStopped(run) ? stoppedItem() : errorItem(failureText(run));
}

function failureText(run: FlowRunDoc | undefined): string | undefined {
	if (run === undefined || run.status !== "Failed") return undefined;
	const error = run.error;
	return typeof error === "string" && !isBlank(error) ? error : undefined;
}

export function sessionToMessages(
	session: FlowSessionDoc,
	runs: readonly FlowRunDoc[],
	options: HistoryOptions = {},
): Message[] {
	const { translate, systemTimeZone } = options;
	const runByName = new Map<string, FlowRunDoc>();
	for (const run of runs) runByName.set(run.name, run);
	const paused = pausedRun(runs);
	const pausedQuestions: FlowQuestion[] = paused ? parseFlowQuestions(paused.questions) : [];
	const pausedKeys = new Set<string>();
	for (const question of pausedQuestions) {
		if (question.key !== null) pausedKeys.add(question.key);
	}

	const out: Message[] = [];
	const usedIds = new Set<string>();
	let requestCount = 0;
	let responseCount = 0;
	let draft: Draft | null = null;
	let pending: PendingRequest | null = null;

	function uniqueId(base: string): string {
		let id = base;
		for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
		usedIds.add(id);
		return id;
	}

	function responseId(run: string | null): string {
		responseCount += 1;
		return uniqueId(run !== null ? `response-${run}` : `response-n${responseCount}`);
	}

	// The run is the only per-turn clock: every row of a session carries the SESSION's creation (frappe copies
	// the parent's onto child rows), so a turn is dated by when its run started, question and answer alike.
	function stampOf(runName: string | null): number | undefined {
		const run = runName !== null ? runByName.get(runName) : undefined;
		return serverDatetimeToEpoch(run?.creation, systemTimeZone);
	}

	function newStep(call: FlowToolCall): ChainOfThoughtStep {
		const step: ChainOfThoughtStep = {
			tool_call_id: call.id,
			tool_name: normalizeToolName(call.name),
			title: toolStepTitle(call.name, call.arguments, translate),
			status: "processing",
		};
		if (hasKeys(call.arguments)) step.request = { args: call.arguments };
		return step;
	}

	function addCall(current: Draft, call: FlowToolCall): void {
		const index = current.steps.findIndex((step) => step.tool_call_id === call.id);
		const existing = current.steps[index];
		if (existing === undefined) {
			current.steps.push(newStep(call));
		} else if (hasKeys(call.arguments)) {
			current.steps[index] = {
				...existing,
				title: toolStepTitle(call.name, call.arguments, translate),
				request: { args: call.arguments },
			};
		}
	}

	function settleCall(current: Draft, row: FlowSessionMessageRow): void {
		const index = current.steps.findIndex((step) => step.tool_call_id === row.tool_call_id);
		const step = current.steps[index];
		if (step === undefined) return;
		// A tool row proves the call ran, so "" is a result here (a tool that returned
		// None), unlike the live "" frame that may mean "parked for approval".
		const outcome = classifyToolResult(row.content ?? "");
		current.steps[index] = { ...step, status: outcome.status, response: { content: outcome.content } };
	}

	function finish(current: Draft): void {
		const run = current.run !== null ? runByName.get(current.run) : undefined;
		const isPaused = paused !== undefined && current.run === paused.name;

		// A call with no result is either awaiting approval (its run is the paused one)
		// or was cut off.
		const steps = current.steps.map((step): ChainOfThoughtStep => {
			if (step.status !== "processing") return step;
			if (isPaused && step.tool_call_id !== undefined && pausedKeys.has(step.tool_call_id)) return step;
			return { ...step, status: "failure" };
		});

		const items = [...current.items];
		if (run?.status === "Failed") items.push(failureItem(run));
		if (isPaused && paused !== undefined) {
			const approval: FlowApprovalItem = {
				response_type: "user_defined",
				streaming_metadata: { id: "approval-1" },
				user_defined: {
					user_defined_type: "flow_approval",
					run: paused.name,
					questions: pausedQuestions,
				},
			};
			items.push(approval);
		}

		let history: MessageResponseHistory | undefined;
		if (run !== undefined && (run.status === "Completed" || run.status === "Failed")) {
			const index = lastTextIndex(items);
			const target = items[index];
			if (isTextItem(target)) {
				const marked: TextItem = {
					...target,
					message_item_options: { feedback: { is_on: true, id: run.name } },
				};
				items[index] = marked;
			}
			const rating = run.feedback_rating;
			if (rating === "Up" || rating === "Down") {
				const comment = run.feedback_comment;
				history = {
					feedback: {
						[run.name]: {
							is_positive: rating === "Up",
							...(typeof comment === "string" && comment !== "" && { text: comment }),
						},
					},
				};
			}
		}

		const timestamp = stampOf(current.run);
		if (timestamp !== undefined) history = { ...history, timestamp };

		if (items.length === 0 && steps.length === 0) return;
		const response: MessageResponse = {
			id: responseId(current.run),
			output: { generic: items },
			message_options: { chain_of_thought: steps },
		};
		if (current.requestId !== undefined) response.request_id = current.requestId;
		if (history !== undefined) response.history = history;
		out.push(response);
	}

	// A user row with no assistant row after it: the stream died before the reply was
	// persisted. Running and Paused runs are legitimately mid-flight, so no error.
	function closeRequest(request: PendingRequest | null): void {
		if (request === null || request.replied) return;
		const run = request.run !== null ? runByName.get(request.run) : undefined;
		if (run?.status === "Running" || run?.status === "Paused") return;
		const timestamp = stampOf(request.run);
		out.push({
			id: responseId(request.run),
			request_id: request.id,
			output: { generic: [failureItem(run)] },
			message_options: { chain_of_thought: [] },
			...(timestamp !== undefined && { history: { timestamp } }),
		});
	}

	for (const row of session.messages) {
		if (row.role === "user") {
			if (draft !== null) finish(draft);
			closeRequest(pending);
			draft = null;
			requestCount += 1;
			const run = runOf(row);
			const id = uniqueId(run !== null ? `request-${run}` : `request-n${requestCount}`);
			const request: MessageRequest = { id, input: { message_type: "text", text: row.content ?? "" } };
			const timestamp = stampOf(run);
			if (timestamp !== undefined) request.history = { timestamp };
			// Attachment rows hang off the session, not the message; the run is what ties one to its turn.
			const files = fileFieldsFromRows(session.attachments, run);
			if (files.length > 0) request.input.structured_data = { fields: files };
			out.push(request);
			pending = { id, run, replied: false };
		} else if (row.role === "assistant") {
			if (draft === null) {
				draft = { requestId: pending?.id, run: null, items: [], steps: [], textCount: 0 };
			}
			if (pending !== null) pending.replied = true;
			draft.run ??= runOf(row);
			if (!isBlank(row.content)) {
				draft.textCount += 1;
				draft.items.push({
					response_type: "text",
					text: row.content ?? "",
					streaming_metadata: { id: `text-${draft.textCount}` },
				});
			}
			for (const call of parseToolCalls(row.tool_calls)) addCall(draft, call);
		} else if (row.role === "tool" && draft !== null) {
			settleCall(draft, row);
		}
	}
	if (draft !== null) finish(draft);
	closeRequest(pending);
	return out;
}
