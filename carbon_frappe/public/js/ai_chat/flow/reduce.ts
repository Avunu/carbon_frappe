// Folds the events of one Flow stream into the draft response the chat shows.
// Pure and immutable: every function returns a new object where something
// changed and the SAME object where nothing did, because the store diffs by
// identity and a repaint per no-op frame would be wasted work. Unchanged
// sub-objects are shared by reference for the same reason.
//
// `history.ts` rebuilds the same shapes from a reloaded session, so both call
// `classifyToolResult` / `toolStepTitle`: a conversation must not look different
// after a refresh.

import type {
	ChainOfThoughtStep,
	FlowApprovalItem,
	GenericItem,
	MessageResponse,
	MessageState,
	StreamInit,
	StreamPhase,
	StreamState,
} from "../types.ts";
import { isFlowApprovalItem, isInlineErrorItem, isTextItem } from "../types.ts";
import type {
	DoneEvent,
	ErrorEvent,
	FlowEvent,
	FlowQuestion,
	ToolEndedEvent,
	ToolStartedEvent,
} from "./events.ts";
import { classifyToolResult } from "./tool_result.ts";
import type { ToolOutcome } from "./tool_result.ts";
import { identityTranslate, normalizeToolName, toolStepTitle } from "./tool_labels.ts";
import type { Translate } from "./tool_labels.ts";

export interface ReduceOptions {
	translate?: Translate;
}

const TEXT_ID = /^text-(\d+)$/;

// -- small helpers ------------------------------------------------------------

function hasKeys(value: Record<string, unknown>): boolean {
	return Object.keys(value).length > 0;
}

function stepsOf(response: MessageResponse): ChainOfThoughtStep[] {
	return response.message_options?.chain_of_thought ?? [];
}

// An empty `chain_of_thought` is omitted, never stored as `[]`: the upstream
// component only bails on a missing value, so an empty array would render an
// "Explainability" toggle with zero steps under every tool-less reply.
function withSteps(response: MessageResponse, steps: ChainOfThoughtStep[]): MessageResponse {
	if (steps.length > 0) {
		return { ...response, message_options: { ...response.message_options, chain_of_thought: steps } };
	}
	const { message_options: options, ...rest } = response;
	if (options === undefined) return response;
	const { chain_of_thought: _dropped, ...otherOptions } = options;
	return hasKeys(otherOptions) ? { ...rest, message_options: otherOptions } : rest;
}

function withGeneric(response: MessageResponse, generic: GenericItem[]): MessageResponse {
	return { ...response, output: { ...response.output, generic } };
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
	return list.map((entry, i) => (i === index ? value : entry));
}

function settled(
	step: ChainOfThoughtStep,
	outcome: Pick<ToolOutcome, "status" | "content">,
): ChainOfThoughtStep {
	return { ...step, status: outcome.status, response: { content: outcome.content } };
}

function hasText(item: GenericItem): boolean {
	return isTextItem(item) && (item.text ?? "").trim() !== "";
}

function lastIndexWhere<T>(list: readonly T[], test: (entry: T) => boolean): number {
	for (let i = list.length - 1; i >= 0; i--) {
		const entry = list[i];
		if (entry !== undefined && test(entry)) return i;
	}
	return -1;
}

/** Every `processing` step to `failure`; the same array when none was processing. */
function failProcessing(steps: ChainOfThoughtStep[]): ChainOfThoughtStep[] {
	if (!steps.some((step) => step.status === "processing")) return steps;
	return steps.map((step) => (step.status === "processing" ? { ...step, status: "failure" } : step));
}

function withFailedSteps(response: MessageResponse): MessageResponse {
	const steps = stepsOf(response);
	const failed = failProcessing(steps);
	return failed === steps ? response : withSteps(response, failed);
}

// -- construction -------------------------------------------------------------

export function initialStreamState(init: StreamInit): StreamState {
	const response: MessageResponse = {
		id: init.id,
		output: { generic: [] },
	};
	if (init.request_id !== undefined) response.request_id = init.request_id;
	if (init.timestamp !== undefined) response.history = { timestamp: init.timestamp };
	return {
		response,
		run: null,
		session: null,
		phase: "streaming",
		textCount: 0,
		textOpen: false,
		emptyEnded: [],
		unmatched: [],
	};
}

/**
 * State for a resume stream that continues the paused response in place. The
 * card is locked at once so it shows the decisions while the stream replays them.
 */
export function resumeStreamState(
	paused: MessageResponse,
	answers: Readonly<Record<string, string>>,
): StreamState {
	const approvals = paused.output.generic.filter(isFlowApprovalItem);
	const card = approvals[approvals.length - 1];
	let textCount = 0;
	for (const item of paused.output.generic) {
		const match = TEXT_ID.exec(item.streaming_metadata?.id ?? "");
		if (isTextItem(item) && match?.[1] !== undefined) textCount = Math.max(textCount, Number(match[1]));
	}
	return {
		response: lockApproval(paused, answers),
		run: card?.user_defined.run ?? null,
		session: null,
		phase: "streaming",
		textCount,
		textOpen: false,
		emptyEnded: [],
		unmatched: [],
	};
}

export function messageStateFor(phase: StreamPhase): MessageState {
	switch (phase) {
		case "streaming":
			return "streaming";
		case "error":
			return "error";
		case "complete":
		case "paused":
			return "complete";
	}
}

// -- events -------------------------------------------------------------------

export function reduceFlowEvent(state: StreamState, event: FlowEvent, options?: ReduceOptions): StreamState {
	switch (event.type) {
		case "run_started":
			return state.run === event.name && state.session === event.session
				? state
				: { ...state, run: event.name, session: event.session };
		case "text":
			return reduceText(state, event.delta);
		case "tool_started":
			return reduceToolStarted(state, event, options?.translate ?? identityTranslate);
		case "tool_ended":
			return reduceToolEnded(state, event);
		case "done":
			return reduceDone(state, event);
		case "error":
			return reduceError(state, event);
		default:
			return state;
	}
}

function reduceText(state: StreamState, delta: string): StreamState {
	if (delta === "") return state;
	const generic = state.response.output.generic;
	const last = generic[generic.length - 1];
	if (state.textOpen && last !== undefined && isTextItem(last)) {
		const grown = { ...last, text: (last.text ?? "") + delta };
		return {
			...state,
			response: withGeneric(state.response, replaceAt(generic, generic.length - 1, grown)),
		};
	}
	// A whitespace-only delta between tool calls (models pad with "\n") must not
	// open a segment: it would render as an empty bubble.
	if (delta.trim() === "") return state;
	const textCount = state.textCount + 1;
	return {
		...state,
		response: withGeneric(state.response, [
			...generic,
			{ response_type: "text", text: delta, streaming_metadata: { id: `text-${textCount}` } },
		]),
		textCount,
		textOpen: true,
	};
}

function reduceToolStarted(state: StreamState, event: ToolStartedEvent, translate: Translate): StreamState {
	const steps = stepsOf(state.response);
	const index = steps.findIndex((step) => step.tool_call_id === event.id);
	const existing = steps[index];
	const filled = hasKeys(event.arguments);

	if (existing === undefined) {
		const step: ChainOfThoughtStep = {
			tool_call_id: event.id,
			tool_name: normalizeToolName(event.name),
			title: toolStepTitle(event.name, event.arguments, translate),
			status: "processing",
		};
		if (filled) step.request = { args: event.arguments };
		return { ...state, response: withSteps(state.response, [...steps, step]), textOpen: false };
	}

	// The first frame of a call has empty arguments and the second has the full
	// set; a stray empty frame arriving later must not erase what the second set.
	// Status is left alone so a duplicate after `tool_ended` keeps its outcome.
	if (!filled) return state.textOpen ? { ...state, textOpen: false } : state;
	const updated: ChainOfThoughtStep = {
		...existing,
		request: { args: event.arguments },
		title: toolStepTitle(event.name, event.arguments, translate),
	};
	return { ...state, response: withSteps(state.response, replaceAt(steps, index, updated)), textOpen: false };
}

function reduceToolEnded(state: StreamState, event: ToolEndedEvent): StreamState {
	const steps = stepsOf(state.response);
	const index = steps.findIndex((step) => step.tool_call_id === event.id);
	const step = steps[index];

	if (step === undefined) return recordUnmatched(state, event);

	if (event.result === "") {
		// Paused for approval, or a tool that returned None: only the `done` that
		// follows says which, so the step stays `processing` until then.
		return state.emptyEnded.includes(event.id)
			? state
			: { ...state, emptyEnded: [...state.emptyEnded, event.id] };
	}

	return {
		...state,
		response: withSteps(
			state.response,
			replaceAt(steps, index, settled(step, classifyToolResult(event.result))),
		),
		emptyEnded: state.emptyEnded.filter((id) => id !== event.id),
	};
}

function recordUnmatched(state: StreamState, event: ToolEndedEvent): StreamState {
	const previous = state.unmatched.find((entry) => entry.id === event.id);
	if (previous !== undefined && previous.name === event.name && previous.result === event.result) {
		return state;
	}
	return {
		...state,
		unmatched: [...state.unmatched.filter((entry) => entry.id !== event.id), event],
	};
}

/**
 * Settle the steps whose `tool_ended` carried "": a tool that returned None is a
 * success, a call listed in the pause's questions keeps waiting for its answer.
 */
function settleEmptyEnded(
	response: MessageResponse,
	emptyEnded: readonly string[],
	event: DoneEvent,
): MessageResponse {
	if (emptyEnded.length === 0) return response;
	const awaiting = new Set(event.questions.map((question) => question.key));
	const steps = stepsOf(response);
	let changed = false;
	const next = steps.map((step) => {
		const id = step.tool_call_id;
		if (id === undefined || step.status !== "processing" || !emptyEnded.includes(id)) return step;
		if (event.status === "Paused" && awaiting.has(id)) return step;
		changed = true;
		return settled(step, { status: "success", content: "" });
	});
	return changed ? withSteps(response, next) : response;
}

function withFeedback(response: MessageResponse, run: string | null): MessageResponse {
	if (run === null) return response;
	const generic = response.output.generic;
	const index = lastIndexWhere(generic, hasText);
	const item = generic[index];
	if (item === undefined || !isTextItem(item)) return response;
	const current = item.message_item_options?.feedback;
	if (current?.is_on === true && current.id === run) return response;
	const marked = { ...item, message_item_options: { feedback: { is_on: true, id: run } } };
	return withGeneric(response, replaceAt(generic, index, marked));
}

function withApproval(
	response: MessageResponse,
	run: string | null,
	questions: FlowQuestion[],
): MessageResponse {
	const generic = response.output.generic;
	const payload = { user_defined_type: "flow_approval", run: run ?? "", questions } as const;
	const open = lastIndexWhere(
		generic,
		(item) => isFlowApprovalItem(item) && item.user_defined.answers === undefined,
	);
	const existing = generic[open];
	// A duplicate `done` re-sends the same pause: refresh the open card rather than stack a second.
	if (existing !== undefined && isFlowApprovalItem(existing)) {
		return withGeneric(response, replaceAt(generic, open, { ...existing, user_defined: payload }));
	}
	const card: FlowApprovalItem = {
		response_type: "user_defined",
		streaming_metadata: { id: `approval-${generic.filter(isFlowApprovalItem).length + 1}` },
		user_defined: payload,
	};
	return withGeneric(response, [...generic, card]);
}

function reduceDone(state: StreamState, event: DoneEvent): StreamState {
	// A persist failure after `done` sends `error`; a replayed `done` must not
	// resurrect a run the user is already looking at as failed.
	if (state.phase === "error") return state;

	let response = settleEmptyEnded(state.response, state.emptyEnded, event);
	let textCount = state.textCount;
	let phase: StreamPhase = "paused";

	if (event.status === "Completed") {
		phase = "complete";
		const generic = response.output.generic;
		const last = generic[generic.length - 1];
		// A model can answer without streaming deltas; `output` is then the only copy.
		if ((last === undefined || !hasText(last)) && event.output !== null && event.output.trim() !== "") {
			textCount += 1;
			response = withGeneric(response, [
				...generic,
				{ response_type: "text", text: event.output, streaming_metadata: { id: `text-${textCount}` } },
			]);
		}
		response = withFeedback(response, state.run);
	} else if (event.questions.length > 0) {
		response = withApproval(response, state.run, event.questions);
	}

	return { ...state, response, phase, textCount, textOpen: false, emptyEnded: [] };
}

/**
 * Drop the cards still waiting for a decision. A persist failure after a
 * Paused `done` leaves a run that `resume_run` refuses, and a reload shows no
 * card for it, so the live view must not offer Approve/Deny either. Locked
 * cards record decisions already sent and stay.
 */
function withoutOpenApprovals(response: MessageResponse): MessageResponse {
	const generic = response.output.generic;
	const kept = generic.filter(
		(item) => !(isFlowApprovalItem(item) && item.user_defined.answers === undefined),
	);
	return kept.length === generic.length ? response : withGeneric(response, kept);
}

function reduceError(state: StreamState, event: ErrorEvent): StreamState {
	// The run is dead, so nothing still in flight will ever finish.
	let response = withoutOpenApprovals(withFailedSteps(state.response));
	const generic = response.output.generic;
	const last = generic[generic.length - 1];
	// "" means the frame carried no message: omit `text` so the view supplies its own.
	const text = event.message === "" ? undefined : event.message;

	if (last === undefined || !isInlineErrorItem(last) || last.text !== text) {
		const item: GenericItem = {
			response_type: "inline_error",
			streaming_metadata: { id: `error-${generic.filter(isInlineErrorItem).length + 1}` },
		};
		if (item.response_type === "inline_error" && text !== undefined) item.text = text;
		response = withGeneric(response, [...generic, item]);
	}

	if (
		response === state.response &&
		state.phase === "error" &&
		!state.textOpen &&
		state.emptyEnded.length === 0
	) {
		return state;
	}
	return { ...state, response, phase: "error", textOpen: false, emptyEnded: [] };
}

// -- outside the event stream -------------------------------------------------

/** The user pressed Stop. Not a server event, so it is not in `FlowEvent`. */
export function stopStream(state: StreamState): StreamState {
	if (state.phase !== "streaming") return state;
	let response = withFailedSteps(state.response);
	const generic = response.output.generic;
	const index = lastIndexWhere(generic, (item) => item.streaming_metadata !== undefined);
	const item = generic[index];
	if (item !== undefined && item.streaming_metadata !== undefined) {
		const stopped: GenericItem = {
			...item,
			streaming_metadata: { ...item.streaming_metadata, stream_stopped: true },
		};
		response = withGeneric(response, replaceAt(generic, index, stopped));
	}
	return { ...state, response, phase: "complete", textOpen: false };
}

/** Freeze the unanswered cards with the decisions sent; the presence of `answers` is the lock. */
export function lockApproval(
	response: MessageResponse,
	answers: Readonly<Record<string, string>>,
): MessageResponse {
	const next: GenericItem[] = [];
	let changed = false;
	for (const item of response.output.generic) {
		if (!isFlowApprovalItem(item) || item.user_defined.answers !== undefined) {
			next.push(item);
			continue;
		}
		changed = true;
		const copy: Record<string, string> = {};
		for (const [key, value] of Object.entries(answers)) {
			if (typeof value === "string") copy[key] = value;
		}
		next.push({ ...item, user_defined: { ...item.user_defined, answers: copy } });
	}
	return changed ? withGeneric(response, next) : response;
}

/**
 * Settle the steps of an earlier response with `tool_ended` frames that a fresh
 * draft could not match (the "resume into a new response" mode).
 */
export function applyToolResults(
	response: MessageResponse,
	results: readonly ToolEndedEvent[],
): MessageResponse {
	let steps = stepsOf(response);
	let changed = false;
	for (const result of results) {
		if (result.result === "") continue;
		const index = steps.findIndex((step) => step.tool_call_id === result.id);
		const step = steps[index];
		if (step === undefined) continue;
		steps = replaceAt(steps, index, settled(step, classifyToolResult(result.result)));
		changed = true;
	}
	return changed ? withSteps(response, steps) : response;
}
