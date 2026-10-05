// The only module of the adapter that talks to the network. Every call, streaming or
// not, is a `fetch` POST to /api/method with the CSRF header, except uploads: those
// use XMLHttpRequest (injected as an `UploadTransport`) because `fetch` reports no
// upload progress. Plain calls do not go
// through `frappe.xcall`: it rejects with `r?.message`, which is `undefined` for
// nearly every failure (frappe.request hands its error callback no argument, or a
// body with no `message`), so callers would get a non-Error and lose the server's
// reason. It would also pop frappe's own error dialog on top of the caller's UI.
// The network is reached through an injected `FlowEnv` so the module is testable
// without a server and nothing is read at import time.
//
// Ground truth: apps/flow/frontend/src/api/{client,stream}.js and flow/api/api.py.

import type { FlowEvent } from "./events.ts";
import {
	parseFlowRunDocs,
	parseFlowSessionDoc,
	parseFlowSessionSummaries,
	type FlowRunDoc,
	type FlowSessionDoc,
	type FlowSessionSummary,
} from "./docs.ts";
import { readFlowEvents } from "./sse.ts";
import type { Translate } from "./tool_labels.ts";
import { isRecord } from "../types.ts";

export interface CallOptions {
	/** The request outlives the page, for a call made while it unloads. */
	keepalive?: boolean;
}

export interface FlowEnv {
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	/** POST /api/method/<method>. Resolves with `message`; rejects with a `FlowHttpError` on non-2xx. */
	call: (method: string, args?: Record<string, unknown>, options?: CallOptions) => Promise<unknown>;
	csrfToken: () => string;
	translate: Translate;
}

/**
 * Reads the globals lazily, at call time, so constructing it is safe before the
 * desk has booted (and in Node, where none of them exist).
 */
export function defaultFlowEnv(): FlowEnv {
	const env: FlowEnv = {
		fetch: (input, init) => globalThis.fetch(input, init),
		call: (method, args, options) => callMethod(method, args ?? {}, env, options),
		csrfToken: () => {
			if (typeof frappe === "undefined") throw new Error("frappe is not available");
			return frappe.csrf_token;
		},
		translate: (source, replace) => {
			if (typeof __ === "undefined") throw new Error("__ is not available");
			return replace === undefined ? __(source) : __(source, replace);
		},
	};
	return env;
}

export class FlowHttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "FlowHttpError";
		this.status = status;
	}
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function cleanMessage(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The first non-empty `message` of frappe's `_server_messages` (a JSON array of JSON strings). */
function firstServerMessage(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const list = parseJson(raw);
	if (!Array.isArray(list)) return null;
	for (const entry of list) {
		const parsed = typeof entry === "string" ? parseJson(entry) : entry;
		if (!isRecord(parsed) || typeof parsed["message"] !== "string") continue;
		const message = cleanMessage(parsed["message"]);
		if (message !== "") return message;
	}
	return null;
}

/**
 * A readable string from a frappe error body, or null. Flow's client returns
 * `exception` raw ("frappe.exceptions.ValidationError: ..."); the module prefix is
 * noise to a user, so it is dropped here, and so is markup. A bare class name
 * ("frappe.exceptions.PermissionError", all a guest's 403 carries) says nothing, so it is null.
 */
export function serverMessage(body: unknown): string | null {
	if (!isRecord(body)) return null;
	const fromMessages = firstServerMessage(body["_server_messages"]);
	if (fromMessages !== null) return fromMessages;
	const exception = body["exception"];
	if (typeof exception === "string") {
		const stripped = cleanMessage(exception.replace(/^[\w.]+:\s+/, ""));
		if (stripped !== "" && !/^\w+(\.\w+)+$/.test(stripped)) return stripped;
	}
	const fallback = body["_error_message"];
	return typeof fallback === "string" && fallback !== "" ? fallback : null;
}

// -- streaming ----------------------------------------------------------------

export interface StartRunParams {
	input: string;
	session?: string;
	agent?: string;
	model?: string;
	attachments?: readonly string[];
}

/** The text for a non-2xx reply: `serverMessage` unless the caller knows better. */
type FailureText = (status: number, body: unknown) => string;

/**
 * What a user may read of a failed upload or attach. Only `_server_messages` (the text of a
 * `frappe.throw`) is written for people; `exception` is the last line of a traceback, which for a corrupt
 * file is a parser's internals. An expired session reaches frappe as Guest and comes back 401 or 403 with
 * nothing readable.
 */
function uploadFailure(fallback: string, __: Translate): FailureText {
	return (status, body) => {
		const written = isRecord(body) ? firstServerMessage(body["_server_messages"]) : null;
		if (written !== null) return written;
		if (status === 401 || status === 403) {
			return __("Your session may have expired. Reload the page and try again.");
		}
		return fallback;
	};
}

/** POSTs JSON to a whitelisted method; throws a `FlowHttpError` carrying the server's reason on non-2xx. */
async function postMethod(
	method: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	env: FlowEnv,
	options: { keepalive?: boolean; failure?: FailureText } = {},
): Promise<Response> {
	// Frappe's string extractor greps for `__("...")`, so the literals below keep that spelling.
	const __ = env.translate;
	signal?.throwIfAborted();
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": env.csrfToken() },
		body: JSON.stringify(body),
	};
	if (signal) init.signal = signal;
	if (options.keepalive) init.keepalive = true;
	const response = await env.fetch(`/api/method/${method}`, init);
	if (!response.ok) {
		const errorBody: unknown = await response.json().catch(() => ({}));
		throw new FlowHttpError(
			options.failure?.(response.status, errorBody) ??
				serverMessage(errorBody) ??
				__("Request failed ({0})", [String(response.status)]),
			response.status,
		);
	}
	return response;
}

async function callMethod(
	method: string,
	args: Record<string, unknown>,
	env: FlowEnv,
	options?: CallOptions,
): Promise<unknown> {
	const response = await postMethod(method, args, undefined, env, options);
	const reply: unknown = await response.json().catch(() => undefined);
	return isRecord(reply) ? reply["message"] : undefined;
}

async function* streamMethod(
	method: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	env: FlowEnv,
): AsyncGenerator<FlowEvent> {
	const __ = env.translate;
	const response = await postMethod(method, body, signal, env);
	if (!response.body) {
		throw new FlowHttpError(__("Request failed ({0})", [String(response.status)]), response.status);
	}
	yield* readFlowEvents(response.body, signal);
}

export function startRun(
	params: StartRunParams,
	signal?: AbortSignal,
	env: FlowEnv = defaultFlowEnv(),
): AsyncGenerator<FlowEvent> {
	const body: Record<string, unknown> = { input: params.input, stream: true };
	if (params.session) body["session"] = params.session;
	// The server throws when an existing session is sent a different agent.
	if (params.agent && !params.session) body["agent"] = params.agent;
	if (params.model) body["model"] = params.model;
	if (params.attachments && params.attachments.length > 0) body["attachments"] = [...params.attachments];
	return streamMethod("flow.api.start_run", body, signal, env);
}

export function resumeRun(
	runName: string,
	answers: Readonly<Record<string, string>>,
	signal?: AbortSignal,
	env: FlowEnv = defaultFlowEnv(),
): AsyncGenerator<FlowEvent> {
	return streamMethod("flow.api.resume_run", { run_name: runName, answers, stream: true }, signal, env);
}

// -- plain calls --------------------------------------------------------------

export async function stopRun(runName: string, env: FlowEnv = defaultFlowEnv()): Promise<void> {
	await env.call("flow.api.stop_run", { run_name: runName });
}

export async function recoverSession(session: string, env: FlowEnv = defaultFlowEnv()): Promise<number> {
	const reply = await env.call("flow.api.recover_session", { session });
	return isRecord(reply) && typeof reply["recovered"] === "number" ? reply["recovered"] : 0;
}

export async function submitFeedback(
	runName: string,
	rating: "Up" | "Down" | "None",
	comment?: string,
	env: FlowEnv = defaultFlowEnv(),
): Promise<void> {
	await env.call("flow.api.submit_feedback", {
		run_name: runName,
		rating,
		comment: comment || null,
	});
}

export async function listSessions(
	user: string,
	options: { limit?: number } = {},
	env: FlowEnv = defaultFlowEnv(),
): Promise<FlowSessionSummary[]> {
	const filters = { owner: user, source: ["!=", "Trigger"] };
	// `limit_page_length`, not `limit`: flow's own client sends `limit`, which
	// frappe.client.get_list silently ignores (its default of 20 applies).
	const reply = await env.call("frappe.client.get_list", {
		doctype: "Flow Session",
		filters,
		fields: ["name", "title", "modified"],
		order_by: "modified desc",
		limit_page_length: options.limit ?? 50,
	});
	return parseFlowSessionSummaries(reply);
}

export async function getSession(name: string, env: FlowEnv = defaultFlowEnv()): Promise<FlowSessionDoc> {
	const __ = env.translate;
	const doc = parseFlowSessionDoc(await env.call("frappe.client.get", { doctype: "Flow Session", name }));
	if (!doc) throw new Error(__("Unexpected response from the server."));
	return doc;
}

export async function listRuns(session: string, env: FlowEnv = defaultFlowEnv()): Promise<FlowRunDoc[]> {
	const reply = await env.call("frappe.client.get_list", {
		doctype: "Flow Run",
		filters: { session },
		fields: [
			"name",
			"session",
			"status",
			"questions",
			"error",
			"feedback_rating",
			"feedback_comment",
			"creation",
		],
		order_by: "creation asc",
		// 0 means no limit; the default page of 20 would drop runs from a long conversation.
		limit_page_length: 0,
	});
	return parseFlowRunDocs(reply);
}

export async function renameSession(
	name: string,
	title: string,
	env: FlowEnv = defaultFlowEnv(),
): Promise<void> {
	const __ = env.translate;
	const value = title.trim();
	if (value === "") throw new Error(__("A title is required."));
	await env.call("frappe.client.set_value", {
		doctype: "Flow Session",
		name,
		fieldname: "title",
		value,
	});
}

export async function deleteSession(name: string, env: FlowEnv = defaultFlowEnv()): Promise<void> {
	// Owner-scoped by Flow Session's `if_owner` permission rows; the server enforces it.
	await env.call("frappe.client.delete", { doctype: "Flow Session", name });
}

// -- uploads ------------------------------------------------------------------

/** Bytes the browser has sent so far. `total` is 0 when the size is not known. */
export interface UploadProgress {
	loaded: number;
	total: number;
}

export interface UploadPost {
	headers: Record<string, string>;
	/** Aborting rejects `post` with an `AbortError` and cancels the request. */
	signal?: AbortSignal;
	onProgress?: (progress: UploadProgress) => void;
}

export interface UploadReply {
	status: number;
	/** The response text; "" when there is none. */
	body: string;
}

/**
 * POSTs a form and reports the bytes sent, which `fetch` cannot do. It resolves for ANY HTTP status
 * (the caller reads `status`) and rejects only when no response arrived: an `AbortError` when `signal`
 * fired, any other Error for a network failure.
 */
export interface UploadTransport {
	post(url: string, body: FormData, options: UploadPost): Promise<UploadReply>;
}

export interface UploadEnv extends Pick<FlowEnv, "csrfToken" | "translate"> {
	transport: UploadTransport;
}

/**
 * The XMLHttpRequest members `xhrTransport` uses, as methods, so a unit test's fake needs no DOM and the
 * browser's own object is wrapped (`browserXhr`) rather than cast. Every `on*` registers one listener.
 */
export interface XhrLike {
	open(method: "POST", url: string): void;
	setRequestHeader(name: string, value: string): void;
	send(body: FormData): void;
	abort(): void;
	status(): number;
	responseText(): string;
	/** `xhr.upload` "progress". */
	onProgress(listener: (progress: UploadProgress) => void): void;
	/** "load": a response arrived, whatever its status. */
	onLoad(listener: () => void): void;
	/** "error" and "timeout": no response arrived. */
	onError(listener: () => void): void;
	/** "abort": `abort()` was called. */
	onAbort(listener: () => void): void;
}

/** Wraps a real XMLHttpRequest. Browser only; the e2e suite covers it. */
export function browserXhr(xhr: XMLHttpRequest): XhrLike {
	return {
		open: (method, url) => xhr.open(method, url),
		setRequestHeader: (name, value) => xhr.setRequestHeader(name, value),
		send: (body) => xhr.send(body),
		abort: () => xhr.abort(),
		status: () => xhr.status,
		responseText: () => xhr.responseText,
		onProgress: (listener) =>
			xhr.upload.addEventListener("progress", (event) => {
				listener({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 });
			}),
		onLoad: (listener) => xhr.addEventListener("load", () => listener()),
		onError: (listener) => {
			xhr.addEventListener("error", () => listener());
			xhr.addEventListener("timeout", () => listener());
		},
		onAbort: (listener) => xhr.addEventListener("abort", () => listener()),
	};
}

/**
 * The transport over an XHR factory. One request per `post`: `open` + headers, listeners, `send`; a
 * `signal` already aborted rejects before `open`; aborting later calls `xhr.abort()` and rejects with an
 * `AbortError` (a `DOMException`). It settles exactly once, and removes its abort listener when it does.
 */
export function xhrTransport(create: () => XhrLike): UploadTransport {
	return {
		post(url, body, options) {
			const { signal } = options;
			if (signal?.aborted) return Promise.reject(abortError());
			return new Promise<UploadReply>((resolve, reject) => {
				let settled = false;
				let xhr: XhrLike | null = null;
				const cancel = (): void => {
					// A real XHR fires "abort" only once it is in flight, so the rejection must not wait for it.
					xhr?.abort();
					settle(() => reject(abortError()));
				};
				function settle(finish: () => void): void {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", cancel);
					finish();
				}
				try {
					const request = create();
					xhr = request;
					request.open("POST", url);
					for (const [name, value] of Object.entries(options.headers)) request.setRequestHeader(name, value);
					request.onProgress((progress) => {
						if (!settled) options.onProgress?.(progress);
					});
					request.onLoad(() =>
						settle(() => {
							try {
								resolve({ status: request.status(), body: request.responseText() });
							} catch (error) {
								reject(error);
							}
						}),
					);
					request.onError(() => settle(() => reject(new Error("The upload request failed."))));
					request.onAbort(() => settle(() => reject(abortError())));
					signal?.addEventListener("abort", cancel, { once: true });
					request.send(body);
				} catch (error) {
					settle(() => reject(error));
				}
			});
		},
	};
}

export function defaultUploadEnv(): UploadEnv {
	const env = defaultFlowEnv();
	return {
		csrfToken: env.csrfToken,
		translate: env.translate,
		transport: xhrTransport(() => browserXhr(new XMLHttpRequest())),
	};
}

/** `POST /api/method/upload_file` returns the new `File` doc as `message`; these are the fields read from it. */
export interface UploadedFile {
	/** The File doc name: what `attach_file` and `start_run`'s `attachments` take. */
	name: string;
	fileName: string;
	/** `/private/files/<name>` for a private upload; null when frappe sent none. */
	fileUrl: string | null;
	fileSize: number | null;
}

export interface UploadOptions {
	signal?: AbortSignal;
	onProgress?: (progress: UploadProgress) => void;
}

function abortError(): Error {
	return new DOMException("The upload was aborted.", "AbortError");
}

/**
 * Uploads `file` as a PRIVATE File (`is_private=1`, no `doctype`, `docname` or `folder`, so it belongs to
 * nobody until flow attaches it) with the CSRF header. Rejects with:
 * - an `AbortError` when `options.signal` fires, before or during the transfer;
 * - a `FlowHttpError` carrying the server's reason (the `_server_messages` text) for a non-2xx status;
 *   HTTP 413 with no readable body says `The file is larger than the server accepts.`, 401 and 403 say the
 *   session may have expired, other failures say `Upload failed ({status})`;
 * - a `FlowHttpError` with status 0 and `The upload failed. Check your connection and try again.` when no
 *   response arrived;
 * - a plain Error `Unexpected response from the server.` for a 2xx whose JSON lacks `message.name`.
 */
export async function uploadFile(
	file: File,
	options: UploadOptions = {},
	env: UploadEnv = defaultUploadEnv(),
): Promise<UploadedFile> {
	const __ = env.translate;
	const { signal } = options;
	if (signal?.aborted) throw abortError();
	const form = new FormData();
	form.append("file", file, file.name);
	form.append("is_private", "1");
	const post: UploadPost = { headers: { "X-Frappe-CSRF-Token": env.csrfToken() } };
	if (signal) post.signal = signal;
	if (options.onProgress) post.onProgress = options.onProgress;

	let reply: UploadReply;
	try {
		reply = await env.transport.post("/api/method/upload_file", form, post);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new FlowHttpError(__("The upload failed. Check your connection and try again."), 0);
	}

	const body: unknown = parseJson(reply.body);
	if (reply.status < 200 || reply.status >= 300) {
		const fallback =
			reply.status === 413
				? __("The file is larger than the server accepts.")
				: __("Upload failed ({0})", [String(reply.status)]);
		throw new FlowHttpError(uploadFailure(fallback, __)(reply.status, body), reply.status);
	}
	const message = isRecord(body) ? body["message"] : undefined;
	if (!isRecord(message) || typeof message["name"] !== "string" || message["name"] === "") {
		throw new Error(__("Unexpected response from the server."));
	}
	const fileName = message["file_name"];
	const fileUrl = message["file_url"];
	const fileSize = message["file_size"];
	return {
		name: message["name"],
		fileName: typeof fileName === "string" && fileName !== "" ? fileName : file.name,
		fileUrl: typeof fileUrl === "string" && fileUrl !== "" ? fileUrl : null,
		fileSize: typeof fileSize === "number" ? fileSize : null,
	};
}

/** What `flow.api.attach_file` returns: `{file, file_name, file_size}`. */
export interface AttachedFile {
	/** The File doc name, the same as the upload's `name`. */
	file: string;
	fileName: string;
	/** Bytes; 0 when flow sent none. */
	fileSize: number;
}

/**
 * Asks flow to validate the upload and extract its text (cached for an hour; `start_run` re-extracts on a
 * miss). Rejects with a `FlowHttpError` carrying flow's reason: an unsupported extension
 * (`Unsupported file type: .x`), a file with no readable text (`No readable text found in this file.`), a
 * file the user may not read. A file flow cannot parse is a 500 whose only text is a traceback line, so it
 * says `The file could not be read.`; a 401 or 403 with no message says the session may have expired. An
 * `AbortError` when `signal` fires. The call blocks until extraction is done,
 * which for an image (OCR) or a large PDF can take seconds.
 */
export async function attachFile(
	fileDoc: string,
	signal?: AbortSignal,
	env: FlowEnv = defaultFlowEnv(),
): Promise<AttachedFile> {
	const __ = env.translate;
	const response = await postMethod("flow.api.attach_file", { file: fileDoc }, signal, env, {
		failure: uploadFailure(__("The file could not be read."), __),
	});
	const reply: unknown = await response.json().catch(() => undefined);
	const message = isRecord(reply) ? reply["message"] : undefined;
	if (!isRecord(message) || typeof message["file"] !== "string" || message["file"] === "") {
		throw new Error(__("Unexpected response from the server."));
	}
	const fileName = message["file_name"];
	const fileSize = message["file_size"];
	return {
		file: message["file"],
		fileName: typeof fileName === "string" && fileName !== "" ? fileName : message["file"],
		fileSize: typeof fileSize === "number" ? fileSize : 0,
	};
}

/**
 * Deletes a File doc (`frappe.client.delete`; the owner may). A 404 counts as deleted. Any other failure
 * rejects, and every caller treats the call as best effort: an orphaned private file is not worth a dialog.
 * `keepalive` lets the request finish while the page unloads.
 */
export async function deleteFile(
	name: string,
	env: FlowEnv = defaultFlowEnv(),
	options?: CallOptions,
): Promise<void> {
	try {
		await env.call("frappe.client.delete", { doctype: "File", name }, options);
	} catch (error) {
		if (error instanceof FlowHttpError && error.status === 404) return;
		throw error;
	}
}
