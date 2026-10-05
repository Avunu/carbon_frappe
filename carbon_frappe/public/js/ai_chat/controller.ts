// Turns user intent into Flow calls and Flow events into store updates. The only
// module that calls the network (through the injected FlowClient) and the only writer
// of the ChatStore. Views read the store and call these methods; they never touch the
// client.
//
// The state machine the store carries (types.ts `ChatStatus`):
//   loading   start() or selectSession() is replacing the conversation; a switch keeps the
//             old messages on screen until the new ones arrive
//   ready     idle; a new turn may start
//   submitted send() posted; no frame has arrived yet
//   streaming frames are arriving
//   error     hydration failed (`error.errorType === "HYDRATION"`); a turn that fails
//             stays in `ready` and shows an inline_error item instead. A switch that
//             fails goes back to whatever it left: `ready`, or this error again.
import { AGENT_KEY, SESSION_KEY } from "./storage_keys.ts";
import type { FlowEvent, FlowQuestion, ToolEndedEvent } from "./flow/events.ts";
import type { FlowRunDoc, FlowSessionDoc, FlowSessionSummary } from "./flow/docs.ts";
import type {
	AttachedFile,
	CallOptions,
	FlowEnv,
	StartRunParams,
	UploadEnv,
	UploadOptions,
	UploadedFile,
} from "./flow/client.ts";
import {
	FlowHttpError,
	attachFile,
	defaultUploadEnv,
	deleteFile,
	deleteSession,
	getSession,
	listRuns,
	listSessions,
	recoverSession,
	renameSession,
	resumeRun,
	startRun,
	stopRun,
	submitFeedback,
	uploadFile,
} from "./flow/client.ts";
import { sessionToMessages } from "./flow/history.ts";
import { HISTORY_LIMIT, HISTORY_TITLE_MAX, createHistoryModel, toHistoryItem } from "./history_model.ts";
import type { HistoryItem, HistoryModel } from "./history_model.ts";
import {
	applyToolResults,
	initialStreamState,
	messageStateFor,
	reduceFlowEvent,
	resumeStreamState,
	stopStream,
} from "./flow/reduce.ts";
import { pendingApproval } from "./pending.ts";
import type { ChatStore } from "./store.ts";
import { attachmentIdsOf, fileFieldFor, fileFieldsOf, referenceFor, validateFiles } from "./uploads.ts";
import type { FileRejection, UploadLimits } from "./uploads.ts";
import type {
	ChatError,
	ChatStatus,
	Message,
	MessageRequest,
	MessageResponse,
	StreamState,
	StructuredField,
} from "./types.ts";
import { isExternalFileReference, isFlowApprovalItem, isRequest, isResponse } from "./types.ts";
import { globalTranslate } from "./i18n.ts";
import type { Translate } from "./i18n.ts";

/** The calls the controller makes, bound to one FlowEnv. Injected so tests script the server. */
export interface FlowClient {
	startRun(params: StartRunParams, signal?: AbortSignal): AsyncGenerator<FlowEvent>;
	resumeRun(
		runName: string,
		answers: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): AsyncGenerator<FlowEvent>;
	stopRun(runName: string): Promise<void>;
	/** Fails any Running run on the session; resolves with how many it failed. */
	recoverSession(session: string): Promise<number>;
	submitFeedback(runName: string, rating: "Up" | "Down" | "None", comment?: string): Promise<void>;
	getSession(name: string): Promise<FlowSessionDoc>;
	listRuns(session: string): Promise<FlowRunDoc[]>;
	/** The user's own non-trigger sessions, newest `modified` first. */
	listSessions(user: string, options?: { limit?: number }): Promise<FlowSessionSummary[]>;
	/** Sets `Flow Session.title`. Rejects with the server's reason; an empty title rejects before any request. */
	renameSession(name: string, title: string): Promise<void>;
	/** Deletes the session and (server-side, `on_trash`) its runs. Owner-only; the server enforces it. */
	deleteSession(name: string): Promise<void>;
	/** Uploads a private File with progress; see `flow/client.ts` `uploadFile` for the rejections. */
	uploadFile(file: File, options?: UploadOptions): Promise<UploadedFile>;
	/** Has flow validate the upload and extract its text; see `attachFile`. Rejects with `AbortError` on `signal`. */
	attachFile(fileDoc: string, signal?: AbortSignal): Promise<AttachedFile>;
	/** Best-effort removal of an unsent upload. A 404 resolves; other failures reject. `keepalive`: survives the page. */
	deleteFile(name: string, options?: CallOptions): Promise<void>;
}

/** `flow/client.ts` bound to `env` (frappe's globals when omitted). Glue only. */
export function createFlowClient(env?: FlowEnv, uploadEnv?: UploadEnv): FlowClient {
	// The default is built per call so a missing XMLHttpRequest (Node) is only an error for an upload.
	const uploads = (): UploadEnv => uploadEnv ?? defaultUploadEnv();
	return {
		startRun: (params, signal) => startRun(params, signal, env),
		resumeRun: (runName, answers, signal) => resumeRun(runName, answers, signal, env),
		stopRun: (runName) => stopRun(runName, env),
		recoverSession: (session) => recoverSession(session, env),
		submitFeedback: (runName, rating, comment) => submitFeedback(runName, rating, comment, env),
		getSession: (name) => getSession(name, env),
		listRuns: (session) => listRuns(session, env),
		listSessions: (user, options) => listSessions(user, options, env),
		renameSession: (name, title) => renameSession(name, title, env),
		deleteSession: (name) => deleteSession(name, env),
		uploadFile: (file, options) => uploadFile(file, options, uploads()),
		attachFile: (fileDoc, signal) => attachFile(fileDoc, signal, env),
		deleteFile: (name, options) => deleteFile(name, env, options),
	};
}

/** The slice of localStorage the controller uses. Every call may throw; the default swallows. */
export interface ControllerStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** `window.localStorage` with every access wrapped: private windows and blocked storage read as empty. */
export function browserStorage(): ControllerStorage {
	return {
		getItem: (key) => {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		setItem: (key, value) => {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				// storage is best-effort
			}
		},
		removeItem: (key) => {
			try {
				window.localStorage.removeItem(key);
			} catch {
				// storage is best-effort
			}
		},
	};
}

/**
 * localStorage, shared by every desk tab: `<owner>@<epoch ms>@<session>`, rewritten while that
 * tab is reading a run's stream (the session is empty until `run_started` names it). Another
 * tab skips `recoverSession` when it is fresh, because recovery fails EVERY Running run of
 * the session and cannot tell a run whose tab is gone from one that is still streaming, and
 * refuses to delete the session named in it. It reaches this browser's tabs only: a run
 * streaming in another browser or device is invisible here, so nothing recovers on open.
 */
export const STREAM_KEY = "cf-ai-stream";
const HEARTBEAT_MS = 3_000;
// Longer than a hidden tab's throttled timers need (frames refresh the lease too), shorter
// than the 5 minutes flow waits before it fails a Running run itself.
const LEASE_STALE_MS = 20_000;

/** Calls `callback` every `ms` until the returned function is called. */
function intervalTimer(callback: () => void, ms: number): () => void {
	const id = setInterval(callback, ms);
	return () => clearInterval(id);
}

export interface ControllerDeps {
	store: ChatStore;
	/** Defaults to `createFlowClient()`. */
	client?: FlowClient;
	/** Defaults to `browserStorage()`. Keys: SESSION_KEY, AGENT_KEY (storage_keys.ts), STREAM_KEY. */
	storage?: ControllerStorage;
	/** Epoch milliseconds, for message timestamps and the stream lease. Defaults to `Date.now`. */
	now?: () => number;
	/** Repeats `callback` every `ms` until the returned function is called. Defaults to `setInterval`. */
	every?: (callback: () => void, ms: number) => () => void;
	/** Defaults to `globalTranslate()`. */
	translate?: Translate;
	/** The signed-in Frappe user (`frappe.session.user`): the owner filter of the conversation list. */
	user?: string;
	/** The zone server datetimes are stored in (`readTimeZones(frappe.boot).system`); the browser's when absent. */
	systemTimeZone?: string;
	/** `readUploadLimits(frappe.boot)`. Null or absent: attaching is unavailable and `addFiles` refuses everything. */
	uploadLimits?: UploadLimits | null;
	/** BCP 47 tag for the file sizes in refusal messages (`frappe.boot.lang`); English when absent. */
	locale?: string;
}

/** What `addFiles` did. Uploads continue in the background; their progress and outcome are in the store. */
export interface AddFilesResult {
	/** The ids (`upload-<n>`) of the files that were accepted and whose upload started, in selection order. */
	readonly added: readonly string[];
	/** Everything that was refused, each with its translated sentence; empty when all were accepted. */
	readonly rejections: readonly FileRejection[];
}

export interface Controller {
	/**
	 * Hydrate the saved conversation: read SESSION_KEY; none (or "") leaves an empty
	 * store at status `ready`. Otherwise `getSession` + `listRuns`, `sessionToMessages`,
	 * `store.replace`, then `ready`. It never recovers the session: that fails every Running
	 * run, including one another browser is streaming (see `send`). A failure sets status `error` with `errorType: "HYDRATION"`. The saved session
	 * is forgotten only when the server says it is gone or off limits (404, 403); for any
	 * other failure it stays, so calling `start()` again retries the same conversation.
	 */
	start(): Promise<void>;
	/**
	 * Send text. If the last response holds an unanswered approval card, the text is the
	 * redirect answer for EVERY pending question (flow needs all answers together) and
	 * this is `answer`. Otherwise it upserts the request, sets status `submitted`, and
	 * streams a new response. A session that flow refuses because a Running run is left on it
	 * is recovered and asked once more, unless another tab held the stream lease when the turn began. Resolves when the stream has ended in any way; it never
	 * rejects: a failure becomes an `inline_error` item on the response.
	 */
	send(text: string): Promise<void>;
	/**
	 * Resume the paused run `run` with one answer per question key ("Approve", "Deny" or
	 * free text). The card locks at once and the stream continues the SAME response
	 * (reduce.ts `resumeStreamState`).
	 */
	answer(run: string, answers: Readonly<Record<string, string>>): Promise<void>;
	/**
	 * Abort the stream, mark the response stopped (`stopStream`), then tell the server:
	 * `stopRun(run)`, or `recoverSession(session)` when `run_started` never arrived.
	 * A no-op unless a stream is live. Resolves after the server call settles.
	 */
	stop(): Promise<void>;
	/**
	 * Empty the store, write "" to SESSION_KEY, status `ready`. Ignored while a stream is live. Pending
	 * uploads are discarded: in-flight ones are aborted and the File docs of finished ones are deleted (best
	 * effort). `selectSession` does not discard them: a staged file is a draft and follows the user.
	 */
	newChat(): void;
	/** Rate a finished response's run. Rejects with the server's reason; the caller shows it. */
	submitFeedback(run: string, rating: "Up" | "Down" | "None", comment?: string): Promise<void>;
	/** The conversation list the history view draws. The controller is its only writer. */
	readonly history: HistoryModel;
	/**
	 * Fetch the list (`listSessions(user, {limit: HISTORY_LIMIT})`) into `history`. The items of an earlier
	 * load stay visible while it runs. A call superseded by a later one is dropped whole (items, status
	 * and error), so the last call always wins. Never rejects: a failure sets status `error`.
	 */
	loadHistory(): Promise<void>;
	/**
	 * Switch the conversation to `name`: `getSession` + `listRuns`, `sessionToMessages`, `store.replace`,
	 * `setSession`, write SESSION_KEY. Opening never recovers the session (see `start`).
	 * Resolves `true` when the store now shows `name`; `false` when nothing changed (a turn is live,
	 * `name` is already showing and idle, the call was superseded by a later
	 * `selectSession`/`newChat`/`start`, `name` or the showing session was deleted meanwhile, or the
	 * controller is disposed). Rejects when the load failed: the previous conversation, session and
	 * status are untouched. A 404 or 403 also removes `name` from `history`.
	 */
	selectSession(name: string): Promise<boolean>;
	/**
	 * Set `Flow Session.title`. Validates first (trimmed, non-empty, at most HISTORY_TITLE_MAX characters;
	 * rejects with a translated reason), updates `history` at once and puts the old title back if the
	 * server refuses, then rethrows. Does not reorder the list.
	 */
	renameSession(name: string, title: string): Promise<void>;
	/**
	 * Delete the session. Rejects (and changes nothing) when the server refuses, or when `name` is the
	 * session another tab is streaming (the lease held elsewhere names it). A 404 counts
	 * as deleted. On success `name` leaves `history`; when it was the showing session the conversation
	 * resets exactly as `newChat()` does (and also while the status is `loading`).
	 */
	deleteSession(name: string): Promise<void>;
	/** The limits files are checked against; null when attaching is unavailable (no flow support in the boot data). */
	readonly uploadLimits: UploadLimits | null;
	/**
	 * Stage files for the next message. Synchronous: validates (`validateFiles`), puts each accepted file in
	 * `store.pendingUploads` as `uploading` with progress 0 and starts its upload, then returns without
	 * waiting. Per file, in the background: `uploadFile` (progress into the store, at most one write per
	 * 100 ms, always the last), then `attachFile`; success sets `complete` with `contributedData` (one `file`
	 * field, `referenceFor`); a failure sets `error` with the server's reason (`The file could not be
	 * uploaded.` when it gave none) and deletes the File doc if the upload had created one. The whole batch is
	 * refused, with one `unavailable` rejection per call, while `uploadLimits` is null or the store's status
	 * is `loading`, and with one `approval` rejection while an approval card is waiting (a redirect cannot
	 * carry files). An empty list is a no-op, so a cancelled picker says nothing. Staging is allowed while a
	 * reply streams. Never throws.
	 */
	addFiles(files: readonly File[]): AddFilesResult;
	/**
	 * Drop a pending upload. `uploading`: abort its request (an upload cancelled mid-flight is gone from the
	 * store at once). If the upload had already created a File doc (the abort landed during `attachFile`)
	 * it is deleted too. `complete`: delete the File doc. `error`: the doc was already deleted. Deletion is
	 * best effort (`console.warn` on failure) and never delays the store update. An unknown id does nothing.
	 */
	removeFile(id: string): void;
	/**
	 * Send the last request again, with the files it carried (its `structured_data` file fields become
	 * `attachments`), as the Try again button of a failed turn does. Staged uploads are left staged. Does
	 * nothing when there is no request or a turn is live. Same failure policy as `send`.
	 */
	retryLast(): Promise<void>;
	/** Abort any stream without telling the server, and ignore every later call. Aborts every upload, also silently. */
	dispose(): void;
}

/** What a failed `selectSession` puts back: idle, or the hydration error that was showing. */
type Resting = { status: "ready" } | { status: "error"; error: ChatError };

/** One live stream: the new turn or the resume the controller is reading. */
interface Turn {
	/** The response the draft is stored under. */
	readonly id: string;
	readonly abort: AbortController;
	state: StreamState;
	/** The first frame has arrived and the status moved from `submitted` to `streaming`. */
	begun: boolean;
}

function isBusy(status: ChatStatus): boolean {
	return status === "loading" || status === "submitted" || status === "streaming";
}

/** Free text answers every pending question: flow resumes only when all of them have one. */
function redirectAnswers(questions: readonly FlowQuestion[], text: string): Record<string, string> {
	const answers: Record<string, string> = {};
	for (const question of questions) {
		if (question.key !== null) answers[question.key] = text;
	}
	return answers;
}

/** The server's reason when it gave one; otherwise `fallback`, because a dropped connection says nothing a user can act on. */
function reasonOf(error: unknown, fallback: string): string {
	return error instanceof FlowHttpError && error.message !== "" ? error.message : fallback;
}

/** One staged file's request, owned by the controller; the store only holds what the views draw. */
interface UploadEntry {
	readonly abort: AbortController;
	/** The File doc once `uploadFile` resolved; null before, and again once something took it to delete it. */
	doc: string | null;
	/** The browser has sent the whole body, so frappe creates the File even if the request is aborted now. */
	sent: boolean;
	/** The chip is gone; whatever `uploadFile` still resolves with is deleted instead of staged. */
	discarded: boolean;
}

// Between two progress writes. A store write redraws the chips and the strip, and the browser reports
// upload progress far more often than that is useful.
const PROGRESS_INTERVAL_MS = 100;
// Progress below this is "still sending"; 1 is reserved for "the last byte left" so the strip can tell
// the transfer from the server's reading of the file.
const PROGRESS_CEILING = 0.99;

function isGone(error: unknown): boolean {
	return error instanceof FlowHttpError && (error.status === 404 || error.status === 403);
}

function titled(item: HistoryItem, title: string): HistoryItem {
	return { id: item.id, title, modified: item.modified };
}

function sameItems(a: readonly HistoryItem[], b: readonly HistoryItem[]): boolean {
	return (
		a.length === b.length &&
		a.every((item, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				item.id === other.id &&
				item.title === other.title &&
				item.modified === other.modified
			);
		})
	);
}

function lastRequest(messages: readonly Message[]): MessageRequest | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRequest(message)) return message;
	}
	return undefined;
}

/** The response holding the unanswered card of `run`, which a resume continues in place. */
function pausedResponse(
	messages: readonly Message[],
	run: string,
): (MessageResponse & { id: string }) | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isResponse(message) || message.id === undefined) continue;
		const holdsCard = message.output.generic.some(
			(item) =>
				isFlowApprovalItem(item) && item.user_defined.run === run && item.user_defined.answers === undefined,
		);
		if (holdsCard) return { ...message, id: message.id };
	}
	return null;
}

export function createController(deps: ControllerDeps): Controller {
	const { store } = deps;
	const client = deps.client ?? createFlowClient();
	const storage = deps.storage ?? browserStorage();
	const now = deps.now ?? Date.now;
	const every = deps.every ?? intervalTimer;
	const __ = deps.translate ?? globalTranslate();

	// Per-controller so two mounted chats never mint the same id; seeded from the clock so
	// a hydrated `message-<n>` or a previous page's ids cannot collide.
	let counter = now();
	let current: Turn | null = null;
	// The server half of the last Stop. A new turn waits for it, or its start_run could
	// reach a session whose run is still Running.
	let stopping: Promise<void> | null = null;
	// Bumped by newChat and dispose so a hydration that finishes late drops its result.
	let epoch = 0;
	let disposed = false;
	const history = createHistoryModel();
	// The status a failed switch goes back to. Kept across a chain of switches that supersede each
	// other, so a failure of the last one does not turn a hydration error into a clean "ready".
	let resting: Resting | null = null;
	// The conversation a selectSession is loading. Deleting it meanwhile must cancel the switch, or the
	// load that was already in flight would open a conversation that no longer exists.
	let switching: string | null = null;
	let historyToken = 0;
	// Seeded from the clock like the message ids, so a second controller never mints an id the first used.
	let uploadCounter = now();
	const uploads = new Map<string, UploadEntry>();
	// Renames still on the wire: a list fetched before one lands must not put the old title back.
	const renaming = new Map<string, string>();
	// Sessions deleted, with the `historyToken` at that moment: a list fetched before it still has them.
	const deleted = new Map<string, number>();

	function read(key: string): string | null {
		try {
			return storage.getItem(key);
		} catch {
			return null;
		}
	}

	function write(key: string, value: string): void {
		try {
			storage.setItem(key, value);
		} catch {
			// storage is best-effort
		}
	}

	function remove(key: string): void {
		try {
			storage.removeItem(key);
		} catch {
			// storage is best-effort
		}
	}

	/** Drop every unfinished hydration or switch; returns the epoch that now counts. */
	function supersede(): number {
		resting = null;
		switching = null;
		epoch += 1;
		return epoch;
	}

	function systemZone(): { systemTimeZone?: string } {
		return deps.systemTimeZone === undefined ? {} : { systemTimeZone: deps.systemTimeZone };
	}

	function historyOptions(): { translate: Translate; systemTimeZone?: string } {
		return { translate: __, ...systemZone() };
	}

	// -- stream lease ---------------------------------------------------------

	const owner = `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	let stopBeating: (() => void) | null = null;
	let lastBeat = 0;

	function beat(): void {
		lastBeat = now();
		const session = current?.state.session ?? store.get().session ?? "";
		write(STREAM_KEY, `${owner}@${lastBeat}@${session}`);
	}

	function leaseOwner(raw: string | null): string {
		return raw === null ? "" : (raw.split("@")[0] ?? "");
	}

	/** The session another tab is streaming, or null when no other tab holds a fresh lease. */
	function elsewhere(): { session: string } | null {
		const raw = read(STREAM_KEY);
		const holder = leaseOwner(raw);
		if (raw === null || holder === "" || holder === owner) return null;
		const [, stamp = "", ...rest] = raw.split("@");
		const at = Number(stamp);
		if (stamp === "" || !Number.isFinite(at) || Math.abs(now() - at) >= LEASE_STALE_MS) return null;
		return { session: rest.join("@") };
	}

	/** Another tab has a stream open. */
	function streamingElsewhere(): boolean {
		return elsewhere() !== null;
	}

	function holdLease(): void {
		if (stopBeating !== null) return;
		beat();
		stopBeating = every(beat, HEARTBEAT_MS);
		// A reload ends the stream with the page; leaving the lease behind would keep the next
		// load from recovering the run it abandoned until the lease went stale.
		if (typeof window !== "undefined") window.addEventListener("pagehide", releaseLease);
	}

	function releaseLease(): void {
		if (stopBeating === null) return;
		stopBeating();
		stopBeating = null;
		if (typeof window !== "undefined") window.removeEventListener("pagehide", releaseLease);
		// Only our own entry: another tab's stream may have taken the key over.
		if (leaseOwner(read(STREAM_KEY)) === owner) remove(STREAM_KEY);
	}

	const isLive = (turn: Turn): boolean => !disposed && current === turn;

	function begin(id: string, state: StreamState): Turn {
		const turn: Turn = { id, abort: new AbortController(), state, begun: false };
		current = turn;
		holdLease();
		return turn;
	}

	/**
	 * Settle the steps an earlier response still shows as running, from `tool_ended`
	 * frames this stream replayed for them (a resume answers calls of the paused turn).
	 */
	function settleEarlier(turn: Turn, results: readonly ToolEndedEvent[]): void {
		for (const message of store.get().messages) {
			if (message.id === undefined || message.id === turn.id || !isResponse(message)) continue;
			const settled = applyToolResults(message, results);
			if (settled !== message)
				store.upsert(message.id, store.getMessageState(message.id) ?? "complete", settled);
		}
	}

	function apply(turn: Turn, event: FlowEvent): void {
		const before = turn.state;
		const after = reduceFlowEvent(before, event, { translate: __ });
		turn.state = after;
		// Timers of a hidden tab are throttled; frames keep the lease fresh meanwhile.
		if (now() - lastBeat >= 1_000) beat();
		if (!turn.begun) {
			turn.begun = true;
			store.setStatus("streaming");
		}
		if (event.type === "run_started") {
			store.setSession(event.session);
			write(SESSION_KEY, event.session);
			// A first turn only now has a session for the other tabs' delete guard to compare.
			if (stopBeating !== null) beat();
		}
		const messageState = messageStateFor(after.phase);
		// A response nobody has seen yet is stored only once it has content, so `run_started`
		// alone never adds an empty assistant row.
		const stored = store.getMessageState(turn.id);
		if (after.response !== before.response || (stored !== undefined && stored !== messageState)) {
			store.upsert(turn.id, messageState, after.response);
		}
		if (after.unmatched !== before.unmatched) settleEarlier(turn, after.unmatched);
	}

	/** The failure as the reducer's `error` branch renders it. Empty text lets the row supply its own. */
	function fail(turn: Turn, message: string): void {
		if (turn.state.phase !== "streaming") return;
		turn.state = reduceFlowEvent(turn.state, { type: "error", message }, { translate: __ });
		store.upsert(turn.id, messageStateFor(turn.state.phase), turn.state.response);
	}

	/** Fail whatever Running run the session has, like Stop does, so the next turn is not refused. */
	function recoverAfterInterruption(turn: Turn): void {
		if (turn.state.phase !== "streaming") return;
		const session = turn.state.session ?? store.get().session;
		if (!session || streamingElsewhere()) return;
		stopping = (async () => {
			try {
				await client.recoverSession(session);
			} catch (error) {
				console.error(error);
			}
		})();
	}

	function dropFromHistory(name: string): void {
		const { items } = history.get();
		if (items.some((item) => item.id === name)) {
			history.set({ items: items.filter((item) => item.id !== name) });
		}
	}

	async function consume(
		turn: Turn,
		open: (signal: AbortSignal) => AsyncGenerator<FlowEvent>,
		usedSession?: string,
	): Promise<void> {
		try {
			if (stopping) await stopping;
			if (!isLive(turn)) return;
			for await (const event of open(turn.abort.signal)) {
				// A frame that was already in flight when Stop was pressed must not undo it.
				if (!isLive(turn)) return;
				apply(turn, event);
			}
			if (isLive(turn)) {
				recoverAfterInterruption(turn);
				fail(turn, __("The connection to the assistant was interrupted."));
			}
		} catch (error) {
			// Stop and dispose abort the request on purpose; the UI has already moved on.
			if (!isLive(turn)) return;
			console.error(error);
			if (error instanceof FlowHttpError) {
				fail(turn, error.message);
				// Deleted in another tab: forget it, or every retry would fail the same way.
				if (error.status === 404 && usedSession !== undefined) {
					store.setSession(null);
					write(SESSION_KEY, "");
					dropFromHistory(usedSession);
				}
			} else {
				recoverAfterInterruption(turn);
				fail(turn, "");
			}
		}
		if (!isLive(turn)) return;
		current = null;
		releaseLease();
		store.setStatus("ready");
	}

	async function answer(run: string, answers: Readonly<Record<string, string>>): Promise<void> {
		if (disposed || isBusy(store.get().status)) return;
		const paused = pausedResponse(store.get().messages, run);
		if (paused === null) return;
		// Locks the card at once, so it shows the decisions while the stream replays them.
		const state = resumeStreamState(paused, answers);
		store.upsert(paused.id, "streaming", state.response);
		store.setStatus("submitted");
		const turn = begin(paused.id, state);
		await consume(turn, (signal) => client.resumeRun(run, answers, signal));
	}

	/** Upload entries are the controller's; exactly one party deletes a File doc, whoever takes it first. */
	function takeDoc(entry: UploadEntry): string | null {
		const { doc } = entry;
		entry.doc = null;
		return doc;
	}

	function deleteBestEffort(doc: string, keepalive = false): void {
		(keepalive ? client.deleteFile(doc, { keepalive }) : client.deleteFile(doc)).catch((error: unknown) =>
			console.warn(error),
		);
	}

	async function send(text: string): Promise<void> {
		const content = text.trim();
		const snapshot = store.get();
		if (disposed || content === "" || isBusy(snapshot.status)) return;

		const pending = pendingApproval(snapshot.messages);
		if (pending !== undefined) {
			// A redirect answer carries no files: they stay staged for the next message.
			await answer(pending.user_defined.run, redirectAnswers(pending.user_defined.questions, content));
			return;
		}
		// The views say why; sending half of what the user attached would be worse than saying nothing.
		if (snapshot.hasInFlightUploads || snapshot.pendingUploads.some((upload) => upload.status === "error")) {
			return;
		}
		await startTurn(content, fileFieldsOf(snapshot.pendingUploads), snapshot.pendingUploads);
	}

	async function retryLast(): Promise<void> {
		const snapshot = store.get();
		if (disposed || isBusy(snapshot.status)) return;
		const request = lastRequest(snapshot.messages);
		const content = request?.input.text?.trim() ?? "";
		if (request === undefined || content === "") return;
		const pending = pendingApproval(snapshot.messages);
		if (pending !== undefined) {
			await answer(pending.user_defined.run, redirectAnswers(pending.user_defined.questions, content));
			return;
		}
		const sent = request.input.structured_data?.fields ?? [];
		const fields = sent.filter((field) => field.type === "file" && isExternalFileReference(field.value));
		await startTurn(content, fields, null);
	}

	/**
	 * Posts a new request carrying `fields` and streams its reply. `consumed` are the staged uploads this
	 * turn takes with it; null for a retry, which re-sends the files of an earlier message and leaves the
	 * staged ones alone. From a send on, the File docs belong to the session: nothing in this controller
	 * deletes them again, not on a failure, a retry, `newChat` or `dispose`.
	 */
	async function startTurn(
		content: string,
		fields: readonly StructuredField[],
		consumed: readonly { id: string }[] | null,
	): Promise<void> {
		counter += 1;
		const requestId = `req-${counter}`;
		const responseId = `res-${counter}`;
		const params: StartRunParams = { input: content };
		const snapshot = store.get();
		if (snapshot.session) {
			params.session = snapshot.session;
		} else {
			const agent = read(AGENT_KEY);
			if (agent) params.agent = agent;
		}
		const attachments = attachmentIdsOf(fields);
		if (attachments.length > 0) params.attachments = attachments;
		store.upsert(requestId, "complete", {
			id: requestId,
			input: {
				message_type: "text",
				text: content,
				...(fields.length > 0 && { structured_data: { fields: [...fields] } }),
			},
			history: { timestamp: now() },
		});
		if (consumed !== null) {
			// The chips move from the composer to the message in one step.
			store.clearPendingUploads();
			for (const { id } of consumed) uploads.delete(id);
		}
		store.setStatus("submitted");
		// Read before begin() takes the lease key over.
		const foreign = streamingElsewhere();
		const turn = begin(
			responseId,
			initialStreamState({ id: responseId, request_id: requestId, timestamp: now() }),
		);
		await consume(turn, (signal) => startWithRecovery(params, signal, foreign), params.session);
	}

	/**
	 * `startRun`, and when flow refuses a turn on a session still holding a Running run (HTTP 417, the
	 * status of every validation error), fails that run and asks once more. A run left behind by a
	 * closed tab would otherwise block the session for flow's five-minute timeout. Done on demand, not
	 * when a conversation is opened: recovery fails EVERY Running run, including one another browser or
	 * device is streaming, which no lease in this browser's localStorage can reveal.
	 */
	async function* startWithRecovery(
		params: StartRunParams,
		signal: AbortSignal,
		foreign: boolean,
	): AsyncGenerator<FlowEvent> {
		const { session } = params;
		try {
			yield* client.startRun(params, signal);
			return;
		} catch (error) {
			// Past the first frame the run exists; asking again would start a second one.
			if (
				session === undefined ||
				store.get().status !== "submitted" ||
				!(error instanceof FlowHttpError && error.status === 417) ||
				foreign
			) {
				throw error;
			}
			const recovered = await client.recoverSession(session).catch(() => 0);
			if (recovered === 0) throw error;
		}
		yield* client.startRun(params, signal);
	}

	async function stop(): Promise<void> {
		const turn = current;
		if (disposed || turn === null) return;
		turn.abort.abort();
		current = null;
		releaseLease();
		const live = turn.state.phase === "streaming";
		turn.state = stopStream(turn.state);
		// Nothing to mark when no frame has produced content yet: the row would be empty.
		if (store.getMessageState(turn.id) !== undefined) store.upsert(turn.id, "complete", turn.state.response);
		store.setStatus("ready");
		// A `done` that already arrived ended the run server-side; there is nothing to stop.
		if (!live) return;

		const { run } = turn.state;
		const session = turn.state.session ?? store.get().session;
		stopping = (async () => {
			try {
				if (run !== null) await client.stopRun(run);
				else if (session) await client.recoverSession(session);
			} catch (error) {
				console.error(error);
			}
		})();
		await stopping;
	}

	async function start(): Promise<void> {
		if (disposed || (isBusy(store.get().status) && store.get().status !== "loading")) return;
		const mine = supersede();
		store.setStatus("loading");
		const saved = read(SESSION_KEY);
		if (!saved) {
			store.setStatus("ready");
			return;
		}
		try {
			const [doc, runs] = await Promise.all([client.getSession(saved), client.listRuns(saved)]);
			if (epoch !== mine) return;
			store.replace(sessionToMessages(doc, runs, historyOptions()));
			store.setSession(saved);
			store.setStatus("ready");
		} catch (error) {
			if (epoch !== mine) return;
			console.error(error);
			const message = error instanceof Error && error.message !== "" ? error.message : "";
			store.setStatus("error", {
				errorType: "HYDRATION",
				message: message || __("Could not load the conversation."),
			});
			// A dropped connection or a 5xx must not cost the user the pointer to a conversation that is
			// still there: "Try again" calls start(), which re-reads this key.
			if (isGone(error)) write(SESSION_KEY, "");
		}
	}

	// -- attachments ------------------------------------------------------------

	function refusal(reason: "approval" | "unavailable", message: string): AddFilesResult {
		return { added: [], rejections: [{ reason, fileName: null, message }] };
	}

	function addFiles(files: readonly File[]): AddFilesResult {
		// Nothing to refuse and nothing to say: a picker that was cancelled still fires `change`.
		if (disposed || files.length === 0) return { added: [], rejections: [] };
		const limits = deps.uploadLimits ?? null;
		const snapshot = store.get();
		if (limits === null || snapshot.status === "loading") {
			return refusal("unavailable", __("Attaching files is not available right now."));
		}
		if (pendingApproval(snapshot.messages) !== undefined) {
			return refusal("approval", __("Answer the assistant's question before attaching files."));
		}
		const { accepted, rejections } = validateFiles(
			files,
			snapshot.pendingUploads.map((upload) => upload.file),
			limits,
			__,
			deps.locale ?? "en",
		);
		const added: string[] = [];
		for (const file of accepted) {
			uploadCounter += 1;
			const id = `upload-${uploadCounter}`;
			const entry: UploadEntry = { abort: new AbortController(), doc: null, sent: false, discarded: false };
			uploads.set(id, entry);
			hookPageHide();
			store.addPendingUpload({ id, file, status: "uploading", progress: 0 });
			added.push(id);
			void runUpload(id, file, entry);
		}
		return { added, rejections };
	}

	/** Never rejects: every outcome lands in the store. */
	async function runUpload(id: string, file: File, entry: UploadEntry): Promise<void> {
		const { signal } = entry.abort;
		let lastWrite = Number.NEGATIVE_INFINITY;
		const onProgress = ({ loaded, total }: { loaded: number; total: number }): void => {
			if (signal.aborted || !(total > 0)) return;
			if (loaded >= total) entry.sent = true;
			const at = now();
			if (at - lastWrite < PROGRESS_INTERVAL_MS) return;
			const value = Math.min(Math.max(loaded / total, 0), PROGRESS_CEILING);
			// An unchanged value writes nothing and so starts no window; progress never goes back.
			const shown = store.get().pendingUploads.find((upload) => upload.id === id);
			if (shown === undefined || shown.status !== "uploading" || !(value > (shown.progress ?? 0))) return;
			lastWrite = at;
			store.updatePendingUpload(id, (previous) => ({ ...previous, progress: value }));
		};
		try {
			const uploaded = await client.uploadFile(file, { signal, onProgress });
			entry.doc = uploaded.name;
			if (signal.aborted || entry.discarded) {
				// Removed after the last byte (see `release`), or the abort lost the race with it.
				const doc = takeDoc(entry);
				if (doc !== null) deleteBestEffort(doc, disposed);
				return;
			}
			store.updatePendingUpload(id, (previous) =>
				previous.status === "uploading" ? { ...previous, progress: 1 } : previous,
			);
			const attached = await client.attachFile(uploaded.name, signal);
			if (signal.aborted) return;
			store.updatePendingUpload(id, (previous) => ({
				id: previous.id,
				file: previous.file,
				status: "complete",
				contributedData: { fields: [fileFieldFor(referenceFor(attached, uploaded, file))] },
			}));
		} catch (error) {
			// The remover (removeFile, newChat, dispose) has already done the store work and the deletion.
			if (signal.aborted || entry.discarded) return;
			store.updatePendingUpload(id, (previous) => ({
				id: previous.id,
				file: previous.file,
				status: "error",
				errorMessage: reasonOf(error, __("The file could not be uploaded.")),
			}));
			// An unusable file must not linger on the server.
			const doc = takeDoc(entry);
			if (doc !== null) deleteBestEffort(doc);
			console.error(error);
		}
	}

	/**
	 * Ends an upload nobody will use. Aborting mid-transfer is free: frappe gets a truncated body and
	 * creates nothing. Once the last byte is out frappe still hashes, writes and inserts the File and only
	 * the response is lost, which would leave a private file nothing ever sweeps; so that request runs to
	 * its end and `runUpload` deletes what it returns.
	 */
	function release(entry: UploadEntry, keepalive = false): void {
		entry.discarded = true;
		if (entry.doc === null && entry.sent) return;
		entry.abort.abort();
		const doc = takeDoc(entry);
		if (doc !== null) deleteBestEffort(doc, keepalive);
	}

	/** The store update comes first, so the chip is gone before any network call is made. */
	function discardUpload(id: string): void {
		store.removePendingUpload(id);
		const entry = uploads.get(id);
		if (entry === undefined) return;
		uploads.delete(id);
		release(entry);
	}

	// A reload or a closed tab ends the page with finished uploads still staged. Their File docs are
	// deleted by a request that outlives it. Entering the back-forward cache keeps the page, chips included.
	function onPageHide(event: PageTransitionEvent): void {
		if (event.persisted) return;
		for (const entry of uploads.values()) {
			const doc = takeDoc(entry);
			if (doc !== null) deleteBestEffort(doc, true);
		}
	}

	let hookedPageHide = false;
	function hookPageHide(): void {
		if (hookedPageHide || typeof window === "undefined") return;
		hookedPageHide = true;
		window.addEventListener("pagehide", onPageHide);
	}

	function removeFile(id: string): void {
		if (disposed || !store.get().pendingUploads.some((upload) => upload.id === id)) return;
		discardUpload(id);
	}

	function discardUploads(): void {
		for (const upload of store.get().pendingUploads) discardUpload(upload.id);
	}

	function newChat(): void {
		const status = store.get().status;
		if (disposed || status === "submitted" || status === "streaming") return;
		supersede();
		discardUploads();
		store.reset({ status: "ready" });
		write(SESSION_KEY, "");
	}

	// -- conversation list ------------------------------------------------------

	async function loadHistory(): Promise<void> {
		if (disposed) return;
		const token = ++historyToken;
		const user = deps.user ?? "";
		const before = history.get().items;
		if (user === "") {
			history.set({
				status: "ready",
				items: before.length === 0 ? before : [],
				error: null,
				truncated: false,
			});
			return;
		}
		history.set({ status: "loading", error: null });
		try {
			const rows = await client.listSessions(user, { limit: HISTORY_LIMIT });
			if (token !== historyToken || disposed) return;
			const options = historyOptions();
			const items = rows
				// a list fetched before a delete landed still has the row
				.filter((row) => (deleted.get(row.name) ?? -1) < token)
				.map((row) => {
					const item = toHistoryItem(row, options);
					const title = renaming.get(row.name);
					return title === undefined ? item : titled(item, title);
				});
			for (const [name, at] of deleted) {
				if (at < token) deleted.delete(name);
			}
			const settled = history.get().items;
			history.set({
				status: "ready",
				items: sameItems(settled, items) ? settled : items,
				error: null,
				truncated: rows.length >= HISTORY_LIMIT,
			});
		} catch (error) {
			if (token !== historyToken || disposed) return;
			console.error(error);
			history.set({ status: "error", error: error instanceof Error ? error.message : "" });
		}
	}

	async function selectSession(name: string): Promise<boolean> {
		const found = store.get();
		if (disposed || found.status === "submitted" || found.status === "streaming") return false;
		if (name === found.session && found.status === "ready") return false;
		const back: Resting =
			found.status === "loading"
				? (resting ?? { status: "ready" })
				: found.status === "error" && found.error !== null
					? { status: "error", error: found.error }
					: { status: "ready" };
		epoch += 1;
		const mine = epoch;
		resting = back;
		switching = name;
		store.setStatus("loading");
		try {
			const [doc, runs] = await Promise.all([client.getSession(name), client.listRuns(name)]);
			if (epoch !== mine) return false;
			// Still `loading` here: that is what lets the list scroll to the end without announcing a hydration.
			store.replace(sessionToMessages(doc, runs, historyOptions()));
			store.setSession(name);
			write(SESSION_KEY, name);
			resting = null;
			switching = null;
			store.setStatus("ready");
			return true;
		} catch (error) {
			if (epoch !== mine) return false;
			console.error(error);
			resting = null;
			switching = null;
			if (back.status === "error") store.setStatus("error", back.error);
			else store.setStatus("ready");
			if (isGone(error)) {
				dropFromHistory(name);
				throw new Error(__("This conversation is no longer available."), { cause: error });
			}
			throw new Error(reasonOf(error, __("Could not open this conversation.")), { cause: error });
		}
	}

	async function retitleSession(name: string, title: string): Promise<void> {
		const value = title.trim();
		if (value === "") throw new Error(__("A title is required."));
		if (value.length > HISTORY_TITLE_MAX) {
			throw new Error(__("Title cannot exceed {0} characters.", [String(HISTORY_TITLE_MAX)]));
		}
		const retitle = (items: readonly HistoryItem[], from: string | null, to: string): HistoryItem[] =>
			items.map((item) =>
				item.id === name && (from === null || item.title === from) ? titled(item, to) : item,
			);
		const shown = history.get().items.find((item) => item.id === name);
		const previous = shown?.title;
		renaming.set(name, value);
		if (shown !== undefined && previous !== value)
			history.set({ items: retitle(history.get().items, null, value) });
		try {
			await client.renameSession(name, value);
		} catch (error) {
			console.error(error);
			// Only while the row still shows ours: a list loaded since, or a later rename, has the say.
			if (previous !== undefined) history.set({ items: retitle(history.get().items, value, previous) });
			throw new Error(reasonOf(error, __("Could not rename this conversation.")), { cause: error });
		} finally {
			if (renaming.get(name) === value) renaming.delete(name);
		}
	}

	async function removeSession(name: string): Promise<void> {
		if (elsewhere()?.session === name) {
			throw new Error(__("This conversation is replying in another tab. Try again when it has finished."));
		}
		if (current !== null && (current.state.session ?? store.get().session) === name) {
			throw new Error(__("This conversation is replying. Try again when it has finished."));
		}
		try {
			await client.deleteSession(name);
		} catch (error) {
			// Already gone (deleted in another tab) is what the user asked for.
			if (!(error instanceof FlowHttpError && error.status === 404)) {
				console.error(error);
				throw new Error(reasonOf(error, __("Could not delete this conversation.")), { cause: error });
			}
		}
		deleted.set(name, historyToken);
		dropFromHistory(name);
		if (disposed) return;
		if (switching === name) {
			// The load in flight would still pass its epoch check; give the status back as a failed switch does.
			const back: Resting = resting ?? { status: "ready" };
			supersede();
			if (back.status === "error") store.setStatus("error", back.error);
			else store.setStatus("ready");
		}
		if (name === store.get().session) {
			// A turn that began while the request was out would stream into a conversation that no longer exists.
			if (current !== null) {
				current.abort.abort();
				current = null;
				releaseLease();
			}
			supersede();
			discardUploads();
			store.reset({ status: "ready" });
			write(SESSION_KEY, "");
		} else if (read(SESSION_KEY) === name) {
			write(SESSION_KEY, "");
		}
	}

	return {
		start,
		send,
		answer,
		stop,
		newChat,
		submitFeedback: (run, rating, comment) => client.submitFeedback(run, rating, comment),
		history,
		loadHistory,
		selectSession,
		renameSession: retitleSession,
		deleteSession: removeSession,
		uploadLimits: deps.uploadLimits ?? null,
		addFiles,
		removeFile,
		retryLast,
		dispose() {
			disposed = true;
			supersede();
			if (hookedPageHide) window.removeEventListener("pagehide", onPageHide);
			for (const entry of uploads.values()) release(entry, true);
			uploads.clear();
			current?.abort.abort();
			current = null;
			releaseLease();
		},
	};
}
