// Local, SDK-shaped chat types. Every field name and nesting here is copied from
// @carbon/ai-chat's wire types (Messages.ts, MessagingConfig.ts) and ADR-0002's
// ChatSDKState, so that the structure matches upstream's when `@carbon/ai-chat/sdk`
// replaces store.ts. Nothing imports @carbon/ai-chat: the package drags React in
// at runtime (see the README's "why not web components" note), and its enums
// cannot be written under erasableSyntaxOnly.
//
// Where upstream has an enum, this file has the string-literal union of its
// values (`response_type: "text"`, status "processing"). A string literal is not
// assignable to a string enum, so a value built from these is assignable to the
// upstream type only up to those fields: `response_type` on every item,
// `ChainOfThoughtStep.status`, `MessageRequest.input.message_type`,
// `ChatError.errorType` and `MessageState`. That reaches `Message`,
// `MessageResponse` and `ChatState` too. The swap therefore needs a typed
// rebuild of each of them, switching over the values and returning the real
// enum members; `as` is banned here and would hide a value upstream lacks.

import type { FlowQuestion, ToolEndedEvent } from "./flow/events.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -- requests -----------------------------------------------------------------

export type MessageInputType = "text" | "event";

export interface MessageInput {
	message_type?: MessageInputType;
	text?: string;
	/** What travels with the text. This adapter only puts `file` fields here. */
	structured_data?: StructuredData;
}

// -- structured data (the request side of an attachment) -----------------------

/**
 * A file that already lives on the server, named by its File doc. The `reference` arm of upstream's
 * `FileFieldValue`: it renders from its metadata alone, which is why it survives a reload.
 */
export interface ExternalFileReference {
	type: "reference";
	/** The `File` doc name; what `start_run`'s `attachments` takes. */
	id: string;
	/** Used as an image source by the chip and for nothing else. Absent on a restored message. */
	url?: string;
	name?: string;
	mime_type?: string;
	/** Bytes. */
	size?: number;
}

export interface StructuredField {
	id: string;
	label?: string;
	/** `"file"` is the one value this adapter writes; others are carried untouched. */
	type?: string;
	/** For a `"file"` field, an `ExternalFileReference`. Narrow it with `isExternalFileReference`. */
	value: unknown;
}

export interface StructuredData {
	fields: StructuredField[];
	user_defined?: Record<string, unknown>;
}

export interface MessageRequestHistory {
	timestamp?: number;
	label?: string;
	silent?: boolean;
}

export interface MessageRequest {
	id?: string;
	history?: MessageRequestHistory;
	input: MessageInput;
	thread_id?: string;
}

// -- response items -----------------------------------------------------------

export interface ItemStreamingMetadata {
	/** Unique within one response; correlates chunks of the same item. */
	id: string;
	cancellable?: boolean;
	/** Set when the user stopped the stream while this item was the open one. */
	stream_stopped?: boolean;
}

export interface GenericItemMessageFeedbackOptions {
	is_on?: boolean;
	/** The key of `history.feedback`. This adapter uses the Flow Run name. */
	id?: string;
}

export interface GenericItemMessageOptions {
	feedback?: GenericItemMessageFeedbackOptions;
}

interface BaseGenericItem {
	streaming_metadata?: ItemStreamingMetadata;
	message_item_options?: GenericItemMessageOptions;
}

export interface TextItem extends BaseGenericItem {
	response_type: "text";
	text?: string;
}

export interface InlineErrorItem extends BaseGenericItem {
	response_type: "inline_error";
	/** Absent means "the client shows its own generic error text". */
	text?: string;
	debug?: {
		statusCode?: number;
		text?: string;
		info?: Record<string, unknown>;
	};
}

export interface UserDefinedItem extends BaseGenericItem {
	response_type: "user_defined";
	user_defined?: Record<string, unknown>;
	full_width?: boolean;
}

/**
 * The approval card for a paused Flow Run. `user_defined_type` sits inside
 * `user_defined`, where upstream hosts dispatch on it
 * (`item.user_defined?.user_defined_type`).
 *
 * A type alias, not an interface: only an alias is assignable to the index
 * signature of `UserDefinedItem.user_defined`.
 */
export type FlowApprovalPayload = {
	user_defined_type: "flow_approval";
	run: string;
	questions: FlowQuestion[];
	/**
	 * Present once the user has answered: question key to the answer sent
	 * ("Approve", "Deny" or free text). Its presence is what locks the card.
	 */
	answers?: Record<string, string>;
};

export interface FlowApprovalItem extends UserDefinedItem {
	user_defined: FlowApprovalPayload;
}

export type GenericItem = TextItem | InlineErrorItem | FlowApprovalItem | UserDefinedItem;

// -- chain of thought ---------------------------------------------------------

export type ChainOfThoughtStepStatus = "processing" | "failure" | "success";

export interface ChainOfThoughtStep {
	title?: string;
	description?: string;
	tool_name?: string;
	request?: { args?: unknown };
	response?: { content: unknown };
	status?: ChainOfThoughtStepStatus;
	/**
	 * Local extension, not in upstream: the Flow tool call id that keys the step
	 * across the double `tool_started` and the later `tool_ended`. Upstream
	 * ignores an unknown property on a value that is not a fresh literal.
	 */
	tool_call_id?: string;
}

// -- responses ----------------------------------------------------------------

export interface MessageHistoryFeedback {
	is_positive: boolean;
	text?: string;
}

export interface MessageResponseHistory {
	timestamp?: number;
	silent?: boolean;
	/** Keyed by `message_item_options.feedback.id`. */
	feedback?: Record<string, MessageHistoryFeedback>;
}

export interface MessageResponseOptions {
	chain_of_thought?: ChainOfThoughtStep[];
}

export interface MessageOutput {
	generic: GenericItem[];
}

export interface MessageResponse {
	id?: string;
	request_id?: string;
	output: MessageOutput;
	history?: MessageResponseHistory;
	message_options?: MessageResponseOptions;
}

export type Message = MessageRequest | MessageResponse;

// -- store state --------------------------------------------------------------

export type ChatStatus = "loading" | "ready" | "submitted" | "streaming" | "error";

// -- pending uploads ----------------------------------------------------------

/** ADR-0002's `ChatSDKPendingUpload["status"]`. */
export type PendingUploadStatus = "uploading" | "complete" | "error";

/**
 * One file on its way into the next message: ADR-0002's `ChatSDKPendingUpload`, plus `progress`.
 * It stays in `ChatState.pendingUploads` until the user removes it or a send consumes it.
 */
export interface PendingUpload {
	/** `upload-<n>`, minted by the controller. */
	id: string;
	file: File;
	status: PendingUploadStatus;
	/**
	 * Local extension. Fraction of the bytes the browser has sent, 0 to 1, while `status` is
	 * `uploading`. It is 1 from the moment the last byte left until flow has read the file
	 * (`attach_file`, which extracts text and can take seconds for an image or a large PDF).
	 * Absent once `status` is `complete` or `error`.
	 */
	progress?: number;
	/**
	 * Once `complete`: the fragment this file adds to the next request, a single `file` field whose
	 * value is an `ExternalFileReference`. A send merges every upload's fields into
	 * `input.structured_data`, which is also how the SDK's `onFileUpload` result travels.
	 */
	contributedData?: StructuredData;
	/** When `status` is `error`: the server's reason, already translated where this code wrote it. */
	errorMessage?: string;
}

/** The `MessageState` of MessagingConfig.ts, as the values it enumerates. */
export type MessageState = "streaming" | "complete" | "error";

/** ChatSDKErrorData, narrowed to the two `OnErrorType` values this adapter raises. */
export interface ChatError {
	errorType: "MESSAGE_COMMUNICATION" | "HYDRATION";
	message: string;
	otherData?: unknown;
	/** The message whose turn failed, when the error belongs to one. */
	messageID?: string;
}

export interface ChatState {
	messages: readonly Message[];
	status: ChatStatus;
	error: Readonly<ChatError> | null;
	/** The response a turn is currently filling, or null between turns. */
	activeResponseId: string | null;
	/** The Flow Session name; null for a conversation not yet created server-side. */
	session: string | null;
	/** Files attached to the next message, in the order they were added. */
	pendingUploads: readonly PendingUpload[];
	/** True while any pending upload is `uploading`; maintained by the store, never set by a caller. */
	hasInFlightUploads: boolean;
}

// -- reducer state ------------------------------------------------------------

export type StreamPhase = "streaming" | "complete" | "paused" | "error";

/** What the controller knows before the first frame; see `initialStreamState`. */
export interface StreamInit {
	/** The response id the store keys the draft under. Must stay stable for the whole stream. */
	id: string;
	request_id?: string;
	timestamp?: number;
}

export interface StreamState {
	/** The draft response. Always has `output.generic` and `message_options.chain_of_thought` arrays. */
	readonly response: MessageResponse;
	/** From `run_started`. */
	readonly run: string | null;
	readonly session: string | null;
	readonly phase: StreamPhase;
	/** How many text items have been created; the next is `text-<textCount + 1>`. */
	readonly textCount: number;
	/** True while the last generic item is a text item that still takes deltas. */
	readonly textOpen: boolean;
	/** Tool call ids whose `tool_ended` carried "": paused for approval, or a tool that returned None. */
	readonly emptyEnded: readonly string[];
	/** `tool_ended` frames whose id matched no step (a replayed resume result in a fresh draft). */
	readonly unmatched: readonly ToolEndedEvent[];
}

// -- guards -------------------------------------------------------------------

export function isRequest(message: unknown): message is MessageRequest {
	return isRecord(message) && isRecord(message["input"]);
}

export function isResponse(message: unknown): message is MessageResponse {
	return isRecord(message) && isRecord(message["output"]) && Array.isArray(message["output"]["generic"]);
}

export function isTextItem(item: unknown): item is TextItem {
	return isRecord(item) && item["response_type"] === "text";
}

export function isInlineErrorItem(item: unknown): item is InlineErrorItem {
	return isRecord(item) && item["response_type"] === "inline_error";
}

export function isUserDefinedItem(item: unknown): item is UserDefinedItem {
	return isRecord(item) && item["response_type"] === "user_defined";
}

export function isFlowApprovalItem(item: unknown): item is FlowApprovalItem {
	if (!isUserDefinedItem(item)) return false;
	const payload = item.user_defined;
	return (
		isRecord(payload) &&
		payload["user_defined_type"] === "flow_approval" &&
		typeof payload["run"] === "string" &&
		Array.isArray(payload["questions"])
	);
}

export function isExternalFileReference(value: unknown): value is ExternalFileReference {
	return (
		isRecord(value) &&
		value["type"] === "reference" &&
		typeof value["id"] === "string" &&
		value["id"] !== "" &&
		(value["name"] === undefined || typeof value["name"] === "string") &&
		(value["mime_type"] === undefined || typeof value["mime_type"] === "string") &&
		(value["url"] === undefined || typeof value["url"] === "string") &&
		(value["size"] === undefined || typeof value["size"] === "number")
	);
}
