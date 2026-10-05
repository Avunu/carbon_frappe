import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { STREAM_KEY, createController } from "../../../carbon_frappe/public/js/ai_chat/controller.ts";
import type {
	Controller,
	ControllerDeps,
	ControllerStorage,
	FlowClient,
} from "../../../carbon_frappe/public/js/ai_chat/controller.ts";
import { FlowHttpError } from "../../../carbon_frappe/public/js/ai_chat/flow/client.ts";
import type {
	AttachedFile,
	StartRunParams,
	UploadOptions,
	UploadedFile,
} from "../../../carbon_frappe/public/js/ai_chat/flow/client.ts";
import type { FlowEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import type {
	FlowRunDoc,
	FlowSessionDoc,
	FlowSessionSummary,
} from "../../../carbon_frappe/public/js/ai_chat/flow/docs.ts";
import { sessionToMessages } from "../../../carbon_frappe/public/js/ai_chat/flow/history.ts";
import { fileFieldFor } from "../../../carbon_frappe/public/js/ai_chat/uploads.ts";
import type { UploadLimits } from "../../../carbon_frappe/public/js/ai_chat/uploads.ts";
import { pendingApproval } from "../../../carbon_frappe/public/js/ai_chat/pending.ts";
import { createChatStore } from "../../../carbon_frappe/public/js/ai_chat/store.ts";
import type { ChatStore } from "../../../carbon_frappe/public/js/ai_chat/store.ts";
import type {
	ChatStatus,
	FlowApprovalItem,
	MessageResponse,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import {
	isFlowApprovalItem,
	isInlineErrorItem,
	isRequest,
	isResponse,
	isTextItem,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import {
	ANSWERS_APPROVE_ALL,
	ANSWERS_DENY,
	CALL_CREATE,
	CALL_CREATE_AGAIN,
	CALL_DELETE,
	CALL_READ,
	ERROR_AFTER_DONE,
	ERROR_BEFORE_TEXT,
	ERROR_MESSAGE,
	ERROR_MID_TEXT,
	PAUSED_TWO_QUESTIONS,
	RESUME_APPROVED,
	RESUME_DENIED,
	RESUME_REDIRECTED_PAUSED_AGAIN,
	RUN,
	SESSION,
	SESSION_COMPLETED,
	SESSION_PAUSED,
	TEXT_ONLY,
	TEXT_TOOL_TEXT,
	ev,
} from "./fixtures.ts";

const SESSION_KEY = "cf-ai-session";
const AGENT_KEY = "cf-ai-agent";
const NOW = 1_790_000_000_000;

// -- fakes --------------------------------------------------------------------

type Script = (signal: AbortSignal | undefined) => AsyncGenerator<FlowEvent>;

async function* playback(events: readonly FlowEvent[], signal?: AbortSignal): AsyncGenerator<FlowEvent> {
	for (const event of events) {
		signal?.throwIfAborted();
		yield event;
	}
}

/** A stream that yields `events` and then throws `error` (the connection died). */
function playbackThenThrow(events: readonly FlowEvent[], error: unknown): Script {
	return async function* (signal) {
		yield* playback(events, signal);
		throw error;
	};
}

function replay(events: readonly FlowEvent[]): Script {
	return (signal) => playback(events, signal);
}

/** A request that rejects before any frame, as `postMethod` does for a non-2xx. */
function rejectWith(error: unknown): Script {
	// oxlint-disable-next-line require-yield -- the point is a generator that fails on its first read
	return async function* () {
		throw error;
	};
}

interface Gate {
	script: Script;
	push(event: FlowEvent): Promise<void>;
	pushAll(events: readonly FlowEvent[]): Promise<void>;
	end(): void;
	signal(): AbortSignal | undefined;
}

/**
 * A stream the test feeds frame by frame. Aborting rejects the pending read like a
 * cancelled fetch body does, so the controller's abort path is the real one.
 */
function gate(): Gate {
	const queue: FlowEvent[] = [];
	let wake: (() => void) | null = null;
	let ended = false;
	let seen: AbortSignal | undefined;
	const script: Script = async function* (signal) {
		seen = signal;
		for (;;) {
			signal?.throwIfAborted();
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (ended) return;
			// oxlint-disable-next-line no-await-in-loop -- the stream is sequential: one read at a time
			await new Promise<void>((resolve, reject) => {
				wake = resolve;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
	};
	return {
		script,
		push: async (event) => {
			queue.push(event);
			wake?.();
			wake = null;
			await tick();
		},
		pushAll: async (events) => {
			queue.push(...events);
			wake?.();
			wake = null;
			await tick();
		},
		end: () => {
			ended = true;
			wake?.();
		},
		signal: () => seen,
	};
}

/** Lets pending microtasks (the controller's `for await`) run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface Held<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function held<T>(): Held<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** One `uploadFile` call, held until the test settles it. */
interface UploadCall extends Held<UploadedFile> {
	file: File;
	options: UploadOptions;
}

/** One `attachFile` call, held until the test settles it. */
interface AttachCall extends Held<AttachedFile> {
	doc: string;
	signal: AbortSignal | undefined;
}

function abortError(): DOMException {
	return new DOMException("The upload was aborted.", "AbortError");
}

interface FakeClient extends FlowClient {
	uploadCalls: UploadCall[];
	attachCalls: AttachCall[];
	/** The File docs `deleteFile` was asked to remove, in order. */
	fileDeletes: string[];
	/** The `keepalive` flag of each of those, in the same order. */
	fileDeleteKeepalive: boolean[];
	fileDeleteFails: Error | null;
	/** An aborted signal rejects the held upload or attach call, as a real request does. False: the abort loses the race. */
	abortRejects: boolean;
	starts: StartRunParams[];
	resumes: { run: string; answers: Readonly<Record<string, string>> }[];
	stops: string[];
	recovers: string[];
	feedback: { run: string; rating: string; comment?: string | undefined }[];
	/** Queue the script the next startRun / resumeRun call plays. */
	nextStart(script: Script): void;
	nextResume(script: Script): void;
	session: { session: FlowSessionDoc; runs: FlowRunDoc[] } | Error | null;
	/** Per-name answers for getSession/listRuns, ahead of `session`. */
	sessions: Map<string, { session: FlowSessionDoc; runs: FlowRunDoc[] } | Error>;
	/** Resolved promises a getSession for that name waits on first. */
	holds: Map<string, Promise<void>>;
	gets: string[];
	runLists: string[];
	stopFails: boolean;
	/** What listSessions answers; `listHold` delays it. */
	list: FlowSessionSummary[] | Error;
	listHold: Promise<void> | null;
	listCalls: { user: string; limit: number | undefined }[];
	renames: { name: string; title: string }[];
	renameHold: Promise<void> | null;
	renameFails: Error | null;
	deletes: string[];
	deleteHold: Promise<void> | null;
	deleteFails: Error | null;
	recoverFails: Error | null;
	recoverHold: Promise<void> | null;
	/** How many Running runs `recoverSession` reports it failed. */
	recovered: number;
}

function fakeClient(): FakeClient {
	const startScripts: Script[] = [];
	const resumeScripts: Script[] = [];
	const client: FakeClient = {
		starts: [],
		resumes: [],
		stops: [],
		recovers: [],
		feedback: [],
		session: null,
		sessions: new Map(),
		holds: new Map(),
		gets: [],
		runLists: [],
		stopFails: false,
		list: [],
		listHold: null,
		listCalls: [],
		renames: [],
		renameHold: null,
		renameFails: null,
		deletes: [],
		deleteHold: null,
		deleteFails: null,
		recoverFails: null,
		recoverHold: null,
		recovered: 0,
		nextStart: (script) => void startScripts.push(script),
		nextResume: (script) => void resumeScripts.push(script),
		startRun(params, signal) {
			client.starts.push(params);
			const script = startScripts.shift();
			if (!script) throw new Error("no start script queued");
			return script(signal);
		},
		resumeRun(run, answers, signal) {
			client.resumes.push({ run, answers });
			const script = resumeScripts.shift();
			if (!script) throw new Error("no resume script queued");
			return script(signal);
		},
		async stopRun(run) {
			client.stops.push(run);
			if (client.stopFails) throw new Error("stop failed");
		},
		async recoverSession(session) {
			client.recovers.push(session);
			await client.recoverHold;
			if (client.recoverFails) throw client.recoverFails;
			return client.recovered;
		},
		async submitFeedback(run, rating, comment) {
			client.feedback.push({ run, rating, comment });
		},
		async getSession(name) {
			client.gets.push(name);
			await client.holds.get(name);
			const entry = client.sessions.get(name) ?? client.session;
			if (entry === null) throw new Error("no session queued");
			if (entry instanceof Error) throw entry;
			return entry.session;
		},
		async listRuns(session) {
			client.runLists.push(session);
			const entry = client.sessions.get(session) ?? client.session;
			if (entry === null || entry instanceof Error) return [];
			return entry.runs;
		},
		async listSessions(user, options) {
			client.listCalls.push({ user, limit: options?.limit });
			await client.listHold;
			if (client.list instanceof Error) throw client.list;
			return client.list;
		},
		async renameSession(name, title) {
			client.renames.push({ name, title });
			// read at call time: a test changes both for the next call while this one is still waiting
			const { renameHold, renameFails } = client;
			await renameHold;
			if (renameFails) throw renameFails;
		},
		async deleteSession(name) {
			client.deletes.push(name);
			await client.deleteHold;
			if (client.deleteFails) throw client.deleteFails;
		},
		uploadFile(file, options = {}) {
			const call: UploadCall = { ...held<UploadedFile>(), file, options };
			client.uploadCalls.push(call);
			options.signal?.addEventListener("abort", () => {
				if (client.abortRejects) call.reject(abortError());
			});
			return call.promise;
		},
		attachFile(doc, signal) {
			const call: AttachCall = { ...held<AttachedFile>(), doc, signal };
			client.attachCalls.push(call);
			signal?.addEventListener("abort", () => {
				if (client.abortRejects) call.reject(abortError());
			});
			return call.promise;
		},
		async deleteFile(name, options) {
			client.fileDeletes.push(name);
			client.fileDeleteKeepalive.push(options?.keepalive === true);
			if (client.fileDeleteFails) throw client.fileDeleteFails;
		},
		uploadCalls: [],
		attachCalls: [],
		fileDeletes: [],
		fileDeleteKeepalive: [],
		fileDeleteFails: null,
		abortRejects: true,
	};
	return client;
}

function memoryStorage(
	initial: Record<string, string> = {},
): ControllerStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
}

/** A heartbeat the controller scheduled; `stopped` once it asked for it to be cancelled. */
interface FakeTimer {
	readonly callback: () => void;
	readonly ms: number;
	stopped: boolean;
}

interface Harness {
	controller: Controller;
	store: ChatStore;
	client: FakeClient;
	storage: ReturnType<typeof memoryStorage>;
	statuses: ChatStatus[];
	timers: FakeTimer[];
	/** The controller's clock, in epoch milliseconds. */
	clock: { now: number };
}

function harness(
	storageInit: Record<string, string> = {},
	storeInit?: Parameters<typeof createChatStore>[0],
	extra: Partial<ControllerDeps> = {},
): Harness {
	const store = createChatStore({ status: "ready", ...storeInit });
	const client = fakeClient();
	const storage = memoryStorage(storageInit);
	const statuses: ChatStatus[] = [];
	store.select(
		(state) => state.status,
		(status) => void statuses.push(status),
	);
	const timers: FakeTimer[] = [];
	const clock = { now: NOW };
	const controller = createController({
		store,
		client,
		storage,
		now: () => clock.now,
		...extra,
		every: (callback, ms) => {
			const timer: FakeTimer = { callback, ms, stopped: false };
			timers.push(timer);
			return () => {
				timer.stopped = true;
			};
		},
	});
	return { controller, store, client, storage, statuses, timers, clock };
}

function responsesOf(store: ChatStore): MessageResponse[] {
	return store.get().messages.filter(isResponse);
}

function lastResponse(store: ChatStore): MessageResponse {
	const found = responsesOf(store).at(-1);
	assert.ok(found, "expected a response in the store");
	return found;
}

function textOf(response: MessageResponse): string {
	return response.output.generic
		.filter(isTextItem)
		.map((item) => item.text ?? "")
		.join("");
}

function cardOf(response: MessageResponse): FlowApprovalItem {
	const card = response.output.generic.find(isFlowApprovalItem);
	assert.ok(card, "expected an approval card");
	return card;
}

function stepStatuses(response: MessageResponse): (string | undefined)[] {
	return (response.message_options?.chain_of_thought ?? []).map((step) => step.status);
}

afterEach(() => {
	mock.restoreAll();
});

// -- send ---------------------------------------------------------------------

describe("send: a plain turn", () => {
	it("stores the request, streams the response under one id and ends ready", async () => {
		const h = harness();
		h.client.nextStart(replay(TEXT_ONLY.events));
		const seen = new Set<string | undefined>();
		h.store.subscribe(() => {
			for (const message of h.store.get().messages) seen.add(message.id);
		});

		await h.controller.send("  hi there  ");

		const [request, response] = h.store.get().messages;
		assert.ok(request && isRequest(request) && response && isResponse(response));
		assert.deepEqual(request.input, { message_type: "text", text: "hi there" });
		assert.equal(request.history?.timestamp, NOW);
		assert.match(request.id ?? "", /^req-\d+$/);
		assert.match(response.id ?? "", /^res-\d+$/);
		assert.equal(response.request_id, request.id);
		assert.equal(textOf(response), "Hello there! How can I help?");
		assert.equal(seen.size, 2, "no id other than the request and the response ever appeared");

		const state = h.store.get();
		assert.equal(state.status, "ready");
		assert.equal(state.activeResponseId, null);
		assert.equal(state.session, SESSION);
		assert.equal(h.store.getMessageState(response.id ?? ""), "complete");
		assert.equal(h.storage.data.get(SESSION_KEY), SESSION);
		assert.deepEqual(h.statuses, ["submitted", "streaming", "ready"]);
	});

	it("marks the final text item for feedback with the run", async () => {
		const h = harness();
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("hi");
		const item = lastResponse(h.store).output.generic.find(isTextItem);
		assert.deepEqual(item?.message_item_options?.feedback, { is_on: true, id: RUN });
	});

	it("sets the active response while frames arrive", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("hi");
		assert.equal(h.store.get().status, "submitted");
		assert.equal(h.store.get().activeResponseId, null);

		await g.push(ev.runStarted(RUN, SESSION));
		assert.equal(h.store.get().status, "streaming");
		assert.equal(responsesOf(h.store).length, 0, "run_started alone adds no empty response row");
		await g.push(ev.text("Hel"));
		const id = h.store.get().activeResponseId;
		assert.match(id ?? "", /^res-\d+$/);
		assert.equal(h.store.getMessageState(id ?? ""), "streaming");
		await g.push(ev.text("lo"));
		assert.equal(h.store.get().activeResponseId, id);
		assert.equal(textOf(lastResponse(h.store)), "Hello");

		await g.push(ev.done("Completed", "Hello", 1, {}));
		g.end();
		await turn;
		assert.equal(h.store.get().activeResponseId, null);
	});

	it("ignores blank text", async () => {
		const h = harness();
		await h.controller.send("   ");
		assert.equal(h.store.get().messages.length, 0);
		assert.equal(h.client.starts.length, 0);
	});

	it("continues the stored session and sends the agent only for a new one", async () => {
		const h = harness({ [AGENT_KEY]: "CF AI Test Agent" });
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("first");
		assert.deepEqual(h.client.starts[0], { input: "first", agent: "CF AI Test Agent" });

		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("second");
		assert.deepEqual(h.client.starts[1], { input: "second", session: SESSION });
	});

	it("leaves both out when there is no agent override", async () => {
		const h = harness();
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("first");
		assert.deepEqual(h.client.starts[0], { input: "first" });
	});

	it("survives a storage that throws", async () => {
		const store = createChatStore({ status: "ready" });
		const client = fakeClient();
		const broken: ControllerStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const controller = createController({ store, client, storage: broken, now: () => NOW });
		client.nextStart(replay(TEXT_ONLY.events));
		await controller.send("hi");
		assert.equal(store.get().status, "ready");
		assert.equal(textOf(lastResponse(store)), "Hello there! How can I help?");
	});
});

describe("send: a tool call", () => {
	it("keeps the text around the call and settles the step", async () => {
		const h = harness();
		h.client.nextStart(replay(TEXT_TOOL_TEXT.events));
		await h.controller.send("open todos?");

		const response = lastResponse(h.store);
		assert.deepEqual(stepStatuses(response), ["success"]);
		const [step] = response.message_options?.chain_of_thought ?? [];
		assert.equal(step?.tool_call_id, CALL_READ);
		assert.equal(step?.tool_name, "read");
		assert.equal(response.output.generic.filter(isTextItem).length, 2);
		assert.equal(h.store.get().status, "ready");
	});
});

describe("double send", () => {
	it("is ignored while a stream is live", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const first = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("partial"));

		await h.controller.send("two");
		assert.equal(h.client.starts.length, 1);
		assert.equal(h.store.get().messages.filter((m) => !isResponse(m)).length, 1);

		await g.push(ev.done("Completed", "partial", 1, {}));
		g.end();
		await first;
	});

	it("is ignored while the first frame is still pending", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const first = h.controller.send("one");
		await h.controller.send("two");
		assert.equal(h.client.starts.length, 1);
		g.end();
		await first;
	});
});

// -- approvals ----------------------------------------------------------------

async function pausedHarness(): Promise<Harness> {
	const h = harness();
	h.client.nextStart(replay(PAUSED_TWO_QUESTIONS.events));
	await h.controller.send("Create a ToDo to call Bob and delete the old one");
	return h;
}

describe("paused runs", () => {
	it("ends ready with an unanswered card the user can redirect by typing", async () => {
		const h = await pausedHarness();
		const state = h.store.get();
		assert.equal(state.status, "ready");
		assert.equal(state.activeResponseId, null);
		const card = pendingApproval(state.messages);
		assert.ok(card);
		assert.equal(card.user_defined.run, RUN);
		assert.deepEqual(
			card.user_defined.questions.map((q) => q.key),
			[CALL_CREATE, CALL_DELETE],
		);
		assert.deepEqual(stepStatuses(lastResponse(h.store)), ["processing", "processing"]);
		assert.equal(h.store.getMessageState(lastResponse(h.store).id ?? ""), "complete");
	});

	it("approve: locks the card at once and continues the SAME response", async () => {
		const h = await pausedHarness();
		const pausedId = lastResponse(h.store).id;
		const count = h.store.get().messages.length;
		const g = gate();
		h.client.nextResume(g.script);

		const turn = h.controller.answer(RUN, ANSWERS_APPROVE_ALL);
		// Synchronous part of answer(): before any frame the card already shows the decisions.
		assert.equal(h.store.get().status, "submitted");
		assert.deepEqual(cardOf(lastResponse(h.store)).user_defined.answers, ANSWERS_APPROVE_ALL);
		assert.equal(pendingApproval(h.store.get().messages), undefined);
		assert.equal(h.store.get().activeResponseId, pausedId ?? null);

		await g.pushAll(RESUME_APPROVED.events);
		g.end();
		await turn;

		assert.deepEqual(h.client.resumes, [{ run: RUN, answers: ANSWERS_APPROVE_ALL }]);
		assert.equal(h.store.get().messages.length, count, "no new message");
		const response = lastResponse(h.store);
		assert.equal(response.id, pausedId);
		assert.deepEqual(stepStatuses(response), ["success", "success"]);
		assert.match(textOf(response), /I created TD-0003 and deleted TD-0001\.$/);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().activeResponseId, null);
		assert.equal(h.store.getMessageState(pausedId ?? ""), "complete");
	});

	it("deny: the run ends with the decisions shown and no further text", async () => {
		const h = await pausedHarness();
		const count = h.store.get().messages.length;
		h.client.nextResume(replay(RESUME_DENIED.events));

		await h.controller.answer(RUN, ANSWERS_DENY);

		assert.deepEqual(h.client.resumes[0]?.answers, ANSWERS_DENY);
		assert.equal(h.store.get().messages.length, count);
		const response = lastResponse(h.store);
		assert.deepEqual(cardOf(response).user_defined.answers, ANSWERS_DENY);
		assert.ok(!stepStatuses(response).includes("processing"));
		assert.equal(h.store.get().status, "ready");
		assert.equal(pendingApproval(h.store.get().messages), undefined);
	});

	it("typed redirect: the text answers every pending question, and a second pause gets a new card", async () => {
		const h = await pausedHarness();
		const count = h.store.get().messages.length;
		const text = "Make it high priority";
		h.client.nextResume(replay(RESUME_REDIRECTED_PAUSED_AGAIN.events));

		await h.controller.send(text);

		assert.equal(h.client.starts.length, 1, "a redirect never starts a run");
		assert.deepEqual(h.client.resumes, [{ run: RUN, answers: { [CALL_CREATE]: text, [CALL_DELETE]: text } }]);
		assert.equal(h.store.get().messages.length, count, "the redirect adds no request row");
		const response = lastResponse(h.store);
		const cards = response.output.generic.filter(isFlowApprovalItem);
		assert.equal(cards.length, 2);
		assert.deepEqual(cards[0]?.user_defined.answers, { [CALL_CREATE]: text, [CALL_DELETE]: text });
		assert.equal(cards[1]?.user_defined.answers, undefined);
		assert.deepEqual(
			cards[1]?.user_defined.questions.map((q) => q.key),
			[CALL_CREATE_AGAIN],
		);
		assert.equal(pendingApproval(h.store.get().messages), cards[1]);
		assert.equal(h.store.get().status, "ready");
	});

	it("skips questions without a key when redirecting", async () => {
		const h = await pausedHarness();
		const card = pendingApproval(h.store.get().messages);
		assert.ok(card);
		const [first, ...rest] = card.user_defined.questions;
		assert.ok(first);
		h.store.upsert(lastResponse(h.store).id ?? "", "complete", {
			...lastResponse(h.store),
			output: {
				generic: [
					{
						...card,
						user_defined: { ...card.user_defined, questions: [{ ...first, key: null }, ...rest] },
					},
				],
			},
		});
		h.client.nextResume(replay(RESUME_DENIED.events));
		await h.controller.send("no thanks");
		assert.deepEqual(h.client.resumes[0]?.answers, { [CALL_DELETE]: "no thanks" });
	});

	it("answer for a run with no open card does nothing", async () => {
		const h = await pausedHarness();
		await h.controller.answer("some-other-run", { x: "Approve" });
		assert.equal(h.client.resumes.length, 0);
		assert.equal(h.store.get().status, "ready");
	});

	it("a second answer while the resume streams is ignored", async () => {
		const h = await pausedHarness();
		const g = gate();
		h.client.nextResume(g.script);
		const turn = h.controller.answer(RUN, ANSWERS_APPROVE_ALL);
		await h.controller.answer(RUN, ANSWERS_DENY);
		await h.controller.send("and also this");
		assert.equal(h.client.resumes.length, 1);
		g.end();
		await turn;
	});
});

// -- stop ---------------------------------------------------------------------

describe("stop", () => {
	it("mid-stream: aborts, marks the response stopped, then stops the run", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("write a long answer");
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("Let me"));
		await g.push(ev.toolStarted(CALL_READ, "read", {}));

		await h.controller.stop();

		assert.equal(g.signal()?.aborted, true);
		assert.deepEqual(h.client.stops, [RUN]);
		assert.deepEqual(h.client.recovers, []);
		const response = lastResponse(h.store);
		assert.equal(h.store.getMessageState(response.id ?? ""), "complete");
		assert.equal(response.output.generic.find(isTextItem)?.streaming_metadata?.stream_stopped, true);
		assert.deepEqual(stepStatuses(response), ["failure"]);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().activeResponseId, null);

		// a frame that was already in flight must not revive the response
		await g.push(ev.text(" more"));
		await turn;
		assert.equal(textOf(lastResponse(h.store)), "Let me");
		assert.equal(h.store.get().status, "ready");
		assert.ok(!responsesOf(h.store).some((r) => r.output.generic.some(isInlineErrorItem)));
	});

	it("before run_started on a fresh chat: no row, no server call", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("hello");

		await h.controller.stop();
		await turn;

		assert.equal(responsesOf(h.store).length, 0);
		assert.equal(h.store.get().status, "ready");
		assert.deepEqual(h.client.stops, []);
		assert.deepEqual(h.client.recovers, []);
	});

	it("before run_started on an existing session: recovers the session", async () => {
		const h = harness({}, { session: SESSION });
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("hello");

		await h.controller.stop();
		await turn;

		assert.deepEqual(h.client.recovers, [SESSION]);
		assert.deepEqual(h.client.stops, []);
		assert.equal(h.store.get().status, "ready");
	});

	it("swallows a server failure", async () => {
		const h = harness();
		const g = gate();
		h.client.stopFails = true;
		h.client.nextStart(g.script);
		const errors = mock.method(console, "error", () => {});
		const turn = h.controller.send("hello");
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("x"));

		await h.controller.stop();
		await turn;

		assert.equal(errors.mock.callCount(), 1);
		assert.equal(h.store.get().status, "ready");
	});

	it("is a no-op when nothing is streaming", async () => {
		const h = harness();
		await h.controller.stop();
		assert.deepEqual(h.client.stops, []);
		assert.equal(h.store.get().status, "ready");
	});

	it("during a resume: stops the known run even before run_started", async () => {
		const h = await pausedHarness();
		const g = gate();
		h.client.nextResume(g.script);
		const turn = h.controller.answer(RUN, ANSWERS_APPROVE_ALL);

		await h.controller.stop();
		await turn;

		assert.deepEqual(h.client.stops, [RUN]);
		assert.equal(h.store.get().status, "ready");
		assert.ok(!stepStatuses(lastResponse(h.store)).includes("processing"));
	});

	it("lets the next turn wait for the server half of the stop", async () => {
		const h = harness();
		const order: string[] = [];
		const first = gate();
		h.client.nextStart(first.script);
		const stopRun = h.client.stopRun;
		h.client.stopRun = async (run) => {
			order.push("stop:start");
			await tick();
			await stopRun(run);
			order.push("stop:end");
		};
		const turn = h.controller.send("one");
		await first.push(ev.runStarted(RUN, SESSION));
		await first.push(ev.text("x"));
		const stopped = h.controller.stop();

		h.client.nextStart((signal) => {
			order.push("start");
			return playback(TEXT_ONLY.events, signal);
		});
		const second = h.controller.send("two");
		await Promise.all([stopped, second, turn]);

		assert.deepEqual(order, ["stop:start", "stop:end", "start"]);
		assert.equal(h.store.get().status, "ready");
	});
});

// -- errors -------------------------------------------------------------------

describe("errors", () => {
	it("before the first frame: an inline error with the server's reason, then ready", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new FlowHttpError("No model is enabled", 417)));

		await h.controller.send("hi");

		const response = lastResponse(h.store);
		const [error] = response.output.generic;
		assert.ok(error && isInlineErrorItem(error));
		assert.equal(error.text, "No model is enabled");
		assert.equal(h.store.getMessageState(response.id ?? ""), "error");
		assert.equal(response.request_id, h.store.get().messages[0]?.id);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().activeResponseId, null);
	});

	it("a network failure leaves the text to the row's own generic message", async () => {
		const h = harness();
		const errors = mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new TypeError("Failed to fetch")));

		await h.controller.send("hi");

		const [error] = lastResponse(h.store).output.generic;
		assert.ok(error && isInlineErrorItem(error));
		assert.equal(error.text, undefined);
		assert.equal(errors.mock.callCount(), 1);
		assert.equal(h.store.get().status, "ready");
	});

	it("an error frame before any text", async () => {
		const h = harness();
		h.client.nextStart(replay(ERROR_BEFORE_TEXT.events));
		await h.controller.send("hi");
		const [error] = lastResponse(h.store).output.generic;
		assert.ok(error && isInlineErrorItem(error));
		assert.equal(error.text, ERROR_MESSAGE);
		assert.equal(h.store.get().status, "ready");
	});

	it("mid-stream: keeps the text and appends the error", async () => {
		const h = harness();
		h.client.nextStart(replay(ERROR_MID_TEXT.events));
		await h.controller.send("hi");

		const response = lastResponse(h.store);
		assert.equal(textOf(response), "Let me ");
		const last = response.output.generic.at(-1);
		assert.ok(last && isInlineErrorItem(last));
		assert.equal(h.store.getMessageState(response.id ?? ""), "error");
		assert.equal(h.store.get().status, "ready");
	});

	it("a connection that dies mid-stream becomes one error and a failed step", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.nextStart(
			playbackThenThrow(
				[ev.runStarted(RUN, SESSION), ev.text("Let me "), ev.toolStarted(CALL_READ, "read", {})],
				new TypeError("network error"),
			),
		);

		await h.controller.send("hi");

		const response = lastResponse(h.store);
		assert.equal(response.output.generic.filter(isInlineErrorItem).length, 1);
		assert.deepEqual(stepStatuses(response), ["failure"]);
		assert.equal(h.store.get().status, "ready");
	});

	it("a body that ends without done or error is reported as interrupted", async () => {
		const h = harness();
		h.client.nextStart(replay([ev.runStarted(RUN, SESSION), ev.text("Half an answ")]));

		await h.controller.send("hi");

		const response = lastResponse(h.store);
		const last = response.output.generic.at(-1);
		assert.ok(last && isInlineErrorItem(last));
		assert.equal(last.text, "The connection to the assistant was interrupted.");
		assert.equal(h.store.getMessageState(response.id ?? ""), "error");
		assert.equal(h.store.get().status, "ready");
	});

	it("an error frame after done (a failed persist) still marks the response failed", async () => {
		const h = harness();
		h.client.nextStart(replay(ERROR_AFTER_DONE.events));
		await h.controller.send("hi");
		const response = lastResponse(h.store);
		assert.equal(textOf(response), "Hi.");
		assert.equal(response.output.generic.filter(isInlineErrorItem).length, 1);
		assert.equal(h.store.getMessageState(response.id ?? ""), "error");
		assert.equal(h.store.get().status, "ready");
	});

	it("the next turn after a failure works and keeps the session", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.nextStart(replay(ERROR_MID_TEXT.events));
		await h.controller.send("one");
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("two");

		assert.equal(responsesOf(h.store).length, 2);
		assert.equal(textOf(lastResponse(h.store)), "Hello there! How can I help?");
		assert.equal(h.client.starts[1]?.session, SESSION);
	});
});

// -- start / session ----------------------------------------------------------

describe("start", () => {
	it("with no saved session: ready and empty, no server call", async () => {
		const h = harness({}, { status: "loading" });
		await h.controller.start();
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().messages.length, 0);
		assert.deepEqual(h.client.recovers, []);
	});

	it("with an empty saved session (a deliberate new chat): ready, no server call", async () => {
		const h = harness({ [SESSION_KEY]: "" }, { status: "loading" });
		await h.controller.start();
		assert.equal(h.store.get().status, "ready");
		assert.deepEqual(h.client.recovers, []);
	});

	it("restores the saved conversation and continues its session", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		h.client.session = SESSION_COMPLETED;

		await h.controller.start();

		const expected = sessionToMessages(SESSION_COMPLETED.session, SESSION_COMPLETED.runs);
		assert.equal(h.store.get().messages.length, expected.length);
		assert.deepEqual(
			h.store.get().messages.map((m) => m.id),
			expected.map((m) => m.id),
		);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().session, SESSION);
		assert.deepEqual(h.client.recovers, []);
		assert.equal(h.store.get().activeResponseId, null);

		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("more");
		assert.equal(h.client.starts[0]?.session, SESSION);
	});

	it("a paused conversation comes back as an unlocked card that a typed reply resumes", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		h.client.session = SESSION_PAUSED;
		await h.controller.start();

		const card = pendingApproval(h.store.get().messages);
		assert.ok(card);
		assert.equal(card.user_defined.run, RUN);

		h.client.nextResume(replay(RESUME_DENIED.events));
		await h.controller.send("not now");
		assert.deepEqual(h.client.resumes[0]?.answers, { [CALL_CREATE]: "not now", [CALL_DELETE]: "not now" });
		assert.equal(pendingApproval(h.store.get().messages), undefined);
		assert.equal(h.store.get().status, "ready");
	});

	it("a session the server no longer has becomes a HYDRATION error and is forgotten", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		mock.method(console, "error", () => {});
		h.client.session = new FlowHttpError("Flow Session t5r2m7q1cd not found", 404);

		await h.controller.start();

		const state = h.store.get();
		assert.equal(state.status, "error");
		assert.equal(state.error?.errorType, "HYDRATION");
		assert.equal(state.error?.message, "Flow Session t5r2m7q1cd not found");
		assert.equal(h.storage.data.get(SESSION_KEY), "");

		await h.controller.start();
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().error, null);
		assert.equal(h.store.get().messages.length, 0);
	});

	it("a session the user may not open is forgotten too", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		mock.method(console, "error", () => {});
		h.client.session = new FlowHttpError("Not permitted to use this session", 403);
		await h.controller.start();
		assert.equal(h.store.get().status, "error");
		assert.equal(h.storage.data.get(SESSION_KEY), "");
	});

	for (const failure of [new TypeError("Failed to fetch"), new FlowHttpError("Request failed (502)", 502)]) {
		it(`${failure.message} keeps the session, and starting again retries it`, async () => {
			const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
			mock.method(console, "error", () => {});
			h.client.session = failure;

			await h.controller.start();
			assert.equal(h.store.get().status, "error");
			assert.equal(h.storage.data.get(SESSION_KEY), SESSION);

			h.client.session = SESSION_COMPLETED;
			await h.controller.start();

			assert.equal(h.store.get().status, "ready");
			assert.equal(h.store.get().error, null);
			assert.equal(h.store.get().session, SESSION);
			assert.ok(h.store.get().messages.length > 0);
		});
	}

	it("a conversation can start from the error state", async () => {
		const h = harness({}, { status: "error", error: { errorType: "HYDRATION", message: "x" } });
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("hi");
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().error, null);
	});

	it("drops a hydration that finishes after newChat", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		h.client.session = SESSION_COMPLETED;
		const loading = h.controller.start();
		h.controller.newChat();
		await loading;
		assert.equal(h.store.get().messages.length, 0);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.storage.data.get(SESSION_KEY), "");
	});

	it("ignores send while hydrating", async () => {
		const h = harness({ [SESSION_KEY]: SESSION }, { status: "loading" });
		h.client.session = SESSION_COMPLETED;
		const loading = h.controller.start();
		await h.controller.send("too early");
		await loading;
		assert.equal(h.client.starts.length, 0);
	});
});

describe("newChat", () => {
	it("empties the store, clears the saved session and starts the next turn fresh", async () => {
		const h = harness();
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("one");
		assert.equal(h.storage.data.get(SESSION_KEY), SESSION);

		h.controller.newChat();

		assert.equal(h.store.get().messages.length, 0);
		assert.equal(h.store.get().session, null);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.storage.data.get(SESSION_KEY), "");

		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("two");
		assert.equal(h.client.starts[1]?.session, undefined);
	});

	it("is ignored while a stream is live", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("partial"));

		h.controller.newChat();

		assert.equal(h.store.get().messages.length, 2);
		assert.equal(h.storage.data.get(SESSION_KEY), SESSION);
		await g.push(ev.done("Completed", "partial", 1, {}));
		g.end();
		await turn;
	});
});

describe("stream lease", () => {
	const OTHER = "other-tab";

	it("is held for the length of a turn and released when it ends", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));

		assert.match(h.storage.data.get(STREAM_KEY) ?? "", new RegExp(`@${NOW}@${SESSION}$`));
		assert.equal(h.timers.length, 1);
		assert.equal(h.timers[0]?.stopped, false);

		h.clock.now = NOW + 5_000;
		h.timers[0]?.callback();
		assert.match(h.storage.data.get(STREAM_KEY) ?? "", new RegExp(`@${NOW + 5_000}@${SESSION}$`));

		await g.push(ev.done("Completed", "ok", 1, {}));
		g.end();
		await turn;
		assert.equal(h.timers[0]?.stopped, true);
		assert.equal(h.storage.data.has(STREAM_KEY), false);
	});

	for (const end of ["stop", "dispose"] as const) {
		it(`is released by ${end}`, async () => {
			const h = harness();
			const g = gate();
			h.client.nextStart(g.script);
			const turn = h.controller.send("one");
			await g.push(ev.runStarted(RUN, SESSION));
			assert.equal(h.storage.data.has(STREAM_KEY), true);

			if (end === "stop") await h.controller.stop();
			else h.controller.dispose();
			await turn;

			assert.equal(h.timers[0]?.stopped, true);
			assert.equal(h.storage.data.has(STREAM_KEY), false);
		});
	}

	it("leaves a lease another tab took over alone", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		h.storage.data.set(STREAM_KEY, `${OTHER}@${NOW}`);

		await g.push(ev.done("Completed", "ok", 1, {}));
		g.end();
		await turn;
		assert.equal(h.storage.data.get(STREAM_KEY), `${OTHER}@${NOW}`);
	});

	it("start() never recovers the session, with or without a lease", async () => {
		// a run another browser streams cannot be told apart from one a closed tab left behind
		for (const lease of [`${OTHER}@${NOW - 4_000}@${SESSION}`, `${OTHER}@${NOW - 60_000}@${SESSION}`, ""]) {
			const h = harness(
				{ [SESSION_KEY]: SESSION, ...(lease === "" ? {} : { [STREAM_KEY]: lease }) },
				{ status: "loading" },
			);
			h.client.session = SESSION_COMPLETED;
			// oxlint-disable-next-line no-await-in-loop -- one harness per lease
			await h.controller.start();
			assert.deepEqual(h.client.recovers, []);
			assert.equal(h.store.get().status, "ready");
		}
	});

	it("names the streaming session in the lease once run_started has announced it", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await tick();
		assert.equal(
			h.storage.data.get(STREAM_KEY)?.endsWith(`@${NOW}@`),
			true,
			"a first turn has no session yet",
		);
		await g.push(ev.runStarted(RUN, SESSION));
		assert.equal(h.storage.data.get(STREAM_KEY)?.endsWith(`@${NOW}@${SESSION}`), true);
		h.clock.now = NOW + 5_000;
		h.timers[0]?.callback();
		assert.equal(h.storage.data.get(STREAM_KEY)?.endsWith(`@${NOW + 5_000}@${SESSION}`), true);
		g.end();
		await turn;
	});
});

describe("dispose", () => {
	it("aborts the stream without telling the server or touching the store again", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("partial"));
		const before = h.store.get();

		h.controller.dispose();
		await turn;

		assert.equal(g.signal()?.aborted, true);
		assert.deepEqual(h.client.stops, []);
		assert.deepEqual(h.client.recovers, []);
		assert.equal(h.store.get(), before);

		await h.controller.send("after");
		assert.equal(h.client.starts.length, 1);
	});
});

describe("submitFeedback", () => {
	it("passes the rating through and rejects with the server's reason", async () => {
		const h = harness();
		await h.controller.submitFeedback(RUN, "Down", "too short");
		assert.deepEqual(h.client.feedback, [{ run: RUN, rating: "Down", comment: "too short" }]);

		h.client.submitFeedback = async () => {
			throw new Error("Not permitted");
		};
		await assert.rejects(h.controller.submitFeedback(RUN, "Up"), /Not permitted/);
	});
});

// -- conversation list --------------------------------------------------------

const USER = "kevin@avu.nu";
const OTHER_TAB = "other-tab";
const KOLKATA = "Asia/Kolkata";

function deferred(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function summary(name: string, title: string | null, modified: string | null = null): FlowSessionSummary {
	return { name, title, modified };
}

/** One completed turn in its own session, with texts that name the session so a mix-up shows. */
function convo(
	name: string,
	creation = "2026-10-02 14:05:09",
): { session: FlowSessionDoc; runs: FlowRunDoc[] } {
	const run = `run-${name}`;
	return {
		session: {
			name,
			title: `Title ${name}`,
			messages: [
				{ role: "user", content: `question ${name}`, run },
				{ role: "assistant", content: `answer ${name}`, run },
			],
			attachments: [],
		},
		runs: [{ name: run, session: name, status: "Completed", creation }],
	};
}

function transcriptText(store: ChatStore): string {
	return store
		.get()
		.messages.map((message) => (isResponse(message) ? textOf(message) : (message.input.text ?? "")))
		.join(" | ");
}

/** Every distinct transcript text the store ever showed, so a stale reply cannot hide between assertions. */
function recordTranscripts(store: ChatStore): Set<string> {
	const seen = new Set<string>([transcriptText(store)]);
	store.subscribe(() => void seen.add(transcriptText(store)));
	return seen;
}

describe("loadHistory", () => {
	it("asks for the user's own conversations and maps them to items", async () => {
		const h = harness({}, undefined, { user: USER, systemTimeZone: KOLKATA });
		h.client.list = [
			summary("s1", "  First  ", "2026-10-02 14:05:09"),
			summary("s2", null, "garbage"),
			summary("s3", "", null),
		];
		const states: string[] = [];
		h.controller.history.subscribe(() => void states.push(h.controller.history.get().status));

		await h.controller.loadHistory();

		assert.deepEqual(h.client.listCalls, [{ user: USER, limit: 100 }]);
		assert.deepEqual(states, ["loading", "ready"]);
		const state = h.controller.history.get();
		assert.equal(state.status, "ready");
		assert.equal(state.error, null);
		assert.equal(state.truncated, false);
		assert.deepEqual(state.items, [
			{ id: "s1", title: "First", modified: Date.UTC(2026, 9, 2, 8, 35, 9) },
			{ id: "s2", title: "Untitled conversation", modified: null },
			{ id: "s3", title: "Untitled conversation", modified: null },
		]);
	});

	it("keeps the earlier items on screen while it loads", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s1", "First")];
		await h.controller.loadHistory();
		const hold = deferred();
		h.client.listHold = hold.promise;
		h.client.list = [summary("s2", "Second")];

		const pending = h.controller.loadHistory();
		assert.equal(h.controller.history.get().status, "loading");
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s1"],
		);
		hold.release();
		await pending;
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s2"],
		);
	});

	it("keeps the items array when nothing in it changed, and replaces it when something did", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s1", "First", "2026-10-02 14:05:09"), summary("s2", "Second")];
		await h.controller.loadHistory();
		const first = h.controller.history.get().items;

		h.client.list = [summary("s1", "First", "2026-10-02 14:05:09"), summary("s2", "Second")];
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().items, first);

		for (const changed of [
			[summary("s1", "First", "2026-10-02 14:05:10"), summary("s2", "Second")],
			[summary("s1", "Renamed", "2026-10-02 14:05:09"), summary("s2", "Second")],
			[summary("s2", "Second"), summary("s1", "First", "2026-10-02 14:05:09")],
			[summary("s1", "First", "2026-10-02 14:05:09")],
		]) {
			h.client.list = changed;
			// oxlint-disable-next-line no-await-in-loop -- each case reads the state the previous one left
			await h.controller.loadHistory();
			assert.notEqual(h.controller.history.get().items, first);
			h.client.list = [summary("s1", "First", "2026-10-02 14:05:09"), summary("s2", "Second")];
			// oxlint-disable-next-line no-await-in-loop -- puts the baseline back for the next case
			await h.controller.loadHistory();
		}
	});

	it("flags a list that filled the limit as truncated", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = Array.from({ length: 100 }, (_, i) => summary(`s${i}`, `T${i}`));
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().truncated, true);
		h.client.list = Array.from({ length: 99 }, (_, i) => summary(`s${i}`, `T${i}`));
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().truncated, false);
	});

	it("drops a call that a later one superseded, whole", async () => {
		const h = harness({}, undefined, { user: USER });
		const slow = deferred();
		h.client.list = [summary("old", "Old")];
		h.client.listHold = slow.promise;
		const first = h.controller.loadHistory();

		h.client.listHold = null;
		h.client.list = [summary("new", "New")];
		await h.controller.loadHistory();
		const settled = h.controller.history.get();
		assert.deepEqual(
			settled.items.map((item) => item.id),
			["new"],
		);

		let notified = 0;
		h.controller.history.subscribe(() => void (notified += 1));
		slow.release();
		await first;
		assert.equal(h.controller.history.get(), settled);
		assert.equal(notified, 0);
	});

	it("drops a superseded failure too, and leaves the loading state to the call that won", async () => {
		const h = harness({}, undefined, { user: USER });
		mock.method(console, "error", () => {});
		const slow = deferred();
		h.client.list = new Error("late failure");
		h.client.listHold = slow.promise;
		const first = h.controller.loadHistory();
		h.client.listHold = null;
		h.client.list = [summary("new", "New")];
		const second = h.controller.loadHistory();
		slow.release();
		await Promise.all([first, second]);
		assert.equal(h.controller.history.get().status, "ready");
		assert.equal(h.controller.history.get().error, null);
	});

	it("reports a failure with the server's reason and keeps the last good list", async () => {
		const h = harness({}, undefined, { user: USER });
		const errors = mock.method(console, "error", () => {});
		h.client.list = [summary("s1", "First")];
		await h.controller.loadHistory();
		const items = h.controller.history.get().items;

		h.client.list = new FlowHttpError("No permission", 403);
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().status, "error");
		assert.equal(h.controller.history.get().error, "No permission");
		assert.equal(h.controller.history.get().items, items);
		assert.equal(errors.mock.callCount(), 1);

		h.client.list = new Error("");
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().error, "");
	});

	it("does not reject, and recovers on the next call", async () => {
		const h = harness({}, undefined, { user: USER });
		mock.method(console, "error", () => {});
		h.client.list = new TypeError("Failed to fetch");
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().status, "error");
		assert.equal(h.controller.history.get().error, "Failed to fetch");
		h.client.list = [summary("s1", "First")];
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().status, "ready");
		assert.equal(h.controller.history.get().error, null);
	});

	it("makes no request without a user and reports an empty ready list", async () => {
		for (const user of [undefined, ""]) {
			const h = harness({}, undefined, user === undefined ? {} : { user });
			// oxlint-disable-next-line no-await-in-loop -- one harness per case
			await h.controller.loadHistory();
			assert.deepEqual(h.client.listCalls, []);
			assert.equal(h.controller.history.get().status, "ready");
			assert.deepEqual(h.controller.history.get().items, []);
		}
	});

	it("drops its result once disposed", async () => {
		const h = harness({}, undefined, { user: USER });
		const hold = deferred();
		h.client.listHold = hold.promise;
		h.client.list = [summary("s1", "First")];
		const pending = h.controller.loadHistory();
		h.controller.dispose();
		hold.release();
		await pending;
		assert.equal(h.controller.history.get().status, "loading");
		assert.deepEqual(h.controller.history.get().items, []);
		await h.controller.loadHistory();
		assert.equal(h.client.listCalls.length, 1);
	});

	it("does not bring back a row deleted while the list was being fetched", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s1", "First"), summary("s2", "Second")];
		await h.controller.loadHistory();

		const hold = deferred();
		h.client.listHold = hold.promise;
		const reload = h.controller.loadHistory();
		await h.controller.deleteSession("s1");
		hold.release();
		await reload;
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s2"],
		);

		// a load that started after the delete is the server's word
		h.client.listHold = null;
		h.client.list = [summary("s1", "First"), summary("s2", "Second")];
		await h.controller.loadHistory();
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s1", "s2"],
		);
	});

	it("does not put an old title back while a rename is still on the wire", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s1", "First")];
		await h.controller.loadHistory();
		const hold = deferred();
		h.client.renameHold = hold.promise;
		const renaming = h.controller.renameSession("s1", "Renamed");

		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().items[0]?.title, "Renamed");

		hold.release();
		await renaming;
		h.client.list = [summary("s1", "Renamed")];
		await h.controller.loadHistory();
		assert.equal(h.controller.history.get().items[0]?.title, "Renamed");
	});
});

describe("selectSession", () => {
	it("replaces the conversation, remembers it and ends ready", async () => {
		const h = harness({ [SESSION_KEY]: "s-old" }, undefined, { systemTimeZone: KOLKATA });
		h.client.sessions.set("s-a", convo("s-a"));
		const seen = recordTranscripts(h.store);

		const result = await h.controller.selectSession("s-a");

		assert.equal(result, true);
		assert.deepEqual(h.client.recovers, []);
		assert.deepEqual(h.client.gets, ["s-a"]);
		assert.deepEqual(h.client.runLists, ["s-a"]);
		assert.equal(transcriptText(h.store), "question s-a | answer s-a");
		assert.equal(h.store.get().session, "s-a");
		assert.equal(h.storage.data.get(SESSION_KEY), "s-a");
		assert.deepEqual(h.statuses, ["loading", "ready"]);
		assert.equal(h.store.get().error, null);
		assert.deepEqual([...seen], ["", "question s-a | answer s-a"]);
		// timestamps arrive through the controller's zone
		assert.equal(h.store.get().messages[0]?.history?.timestamp, Date.UTC(2026, 9, 2, 8, 35, 9));
	});

	it("keeps the old messages on screen and the store loading while it fetches", async () => {
		const h = harness();
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		await h.controller.selectSession("s-a");
		const hold = deferred();
		h.client.holds.set("s-b", hold.promise);

		const pending = h.controller.selectSession("s-b");
		assert.equal(h.store.get().status, "loading");
		assert.equal(transcriptText(h.store), "question s-a | answer s-a");
		assert.equal(h.store.get().session, "s-a");
		hold.release();
		assert.equal(await pending, true);
	});

	it("brings a paused conversation back with an unlocked approval card", async () => {
		const h = harness();
		h.client.sessions.set("s-p", {
			session: { ...SESSION_PAUSED.session, name: "s-p" },
			runs: SESSION_PAUSED.runs.map((run) => Object.assign({}, run, { session: "s-p" })),
		});
		assert.equal(await h.controller.selectSession("s-p"), true);
		const card = cardOf(lastResponse(h.store));
		assert.equal(card.user_defined.answers, undefined);
		assert.ok(pendingApproval(h.store.get().messages));
		// and a typed reply answers it
		h.client.nextResume(replay(RESUME_DENIED.events));
		await h.controller.send("no");
		assert.equal(h.client.resumes.length, 1);
	});

	it("does nothing while a turn is live", async () => {
		const h = harness();
		const g = gate();
		h.client.nextStart(g.script);
		h.client.sessions.set("s-a", convo("s-a"));
		const turn = h.controller.send("hello");
		assert.equal(h.store.get().status, "submitted");
		assert.equal(await h.controller.selectSession("s-a"), false);
		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("partial"));
		assert.equal(h.store.get().status, "streaming");
		assert.equal(await h.controller.selectSession("s-a"), false);
		assert.deepEqual(h.client.gets, []);
		assert.deepEqual(h.client.recovers, []);
		g.end();
		await turn;
	});

	it("does nothing for the conversation that is already showing", async () => {
		const h = harness();
		h.client.sessions.set("s-a", convo("s-a"));
		await h.controller.selectSession("s-a");
		const before = h.store.get();
		assert.equal(await h.controller.selectSession("s-a"), false);
		assert.equal(h.client.gets.length, 1);
		assert.equal(h.store.get(), before);
	});

	it("opens the saved conversation again from the hydration error state", async () => {
		const h = harness({ [SESSION_KEY]: "s-a" }, { status: "loading" });
		mock.method(console, "error", () => {});
		h.client.sessions.set("s-a", new TypeError("Failed to fetch"));
		await h.controller.start();
		assert.equal(h.store.get().status, "error");

		h.client.sessions.set("s-a", convo("s-a"));
		assert.equal(await h.controller.selectSession("s-a"), true);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().error, null);
		assert.equal(transcriptText(h.store), "question s-a | answer s-a");
	});

	it("lets the latest of two quick switches win and never shows the first one's messages", async () => {
		const h = harness();
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		const holdA = deferred();
		h.client.holds.set("s-a", holdA.promise);
		const seen = recordTranscripts(h.store);

		const first = h.controller.selectSession("s-a");
		const second = h.controller.selectSession("s-b");
		assert.equal(await second, true);
		holdA.release();
		assert.equal(await first, false);

		assert.equal(transcriptText(h.store), "question s-b | answer s-b");
		assert.equal(h.store.get().session, "s-b");
		assert.equal(h.storage.data.get(SESSION_KEY), "s-b");
		assert.equal(h.store.get().status, "ready");
		assert.deepEqual([...seen], ["", "question s-b | answer s-b"]);
	});

	it("also drops the first when the first answers last or first, in either order", async () => {
		const h = harness();
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		const holdB = deferred();
		h.client.holds.set("s-b", holdB.promise);
		const first = h.controller.selectSession("s-a");
		const second = h.controller.selectSession("s-b");
		assert.equal(await first, false, "the superseded call settles without waiting for the winner");
		assert.equal(transcriptText(h.store), "");
		holdB.release();
		assert.equal(await second, true);
		assert.equal(transcriptText(h.store), "question s-b | answer s-b");
	});

	it("is superseded by newChat", async () => {
		const h = harness({ [SESSION_KEY]: "s-old" });
		h.client.sessions.set("s-a", convo("s-a"));
		const hold = deferred();
		h.client.holds.set("s-a", hold.promise);
		const pending = h.controller.selectSession("s-a");
		h.controller.newChat();
		hold.release();
		assert.equal(await pending, false);
		assert.equal(transcriptText(h.store), "");
		assert.equal(h.store.get().session, null);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.storage.data.get(SESSION_KEY), "");
	});

	it("is superseded by start()", async () => {
		const h = harness({ [SESSION_KEY]: "s-b" });
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		const hold = deferred();
		h.client.holds.set("s-a", hold.promise);
		const pending = h.controller.selectSession("s-a");
		await h.controller.start();
		hold.release();
		assert.equal(await pending, false);
		assert.equal(transcriptText(h.store), "question s-b | answer s-b");
	});

	it("ignores a result that arrives after dispose", async () => {
		const h = harness();
		h.client.sessions.set("s-a", convo("s-a"));
		const hold = deferred();
		h.client.holds.set("s-a", hold.promise);
		const pending = h.controller.selectSession("s-a");
		h.controller.dispose();
		hold.release();
		assert.equal(await pending, false);
		assert.equal(transcriptText(h.store), "");
		assert.equal(await h.controller.selectSession("s-a"), false);
	});

	it("never recovers the session, so a run another browser is streaming is left alone", async () => {
		for (const lease of [`${OTHER_TAB}@${NOW - 2_000}@s-a`, `${OTHER_TAB}@${NOW - 60_000}@s-a`, ""]) {
			const h = harness(lease === "" ? {} : { [STREAM_KEY]: lease });
			h.client.sessions.set("s-a", convo("s-a"));
			// oxlint-disable-next-line no-await-in-loop -- one harness per lease
			assert.equal(await h.controller.selectSession("s-a"), true);
			assert.deepEqual(h.client.recovers, []);
		}
	});

	it("fails with the server's reason and leaves the conversation, session and pointer alone", async () => {
		const h = harness({ [SESSION_KEY]: "s-a" });
		const errors = mock.method(console, "error", () => {});
		h.client.sessions.set("s-a", convo("s-a"));
		await h.controller.selectSession("s-a");
		h.storage.data.set(SESSION_KEY, "s-a");
		const before = h.store.get().messages;

		h.client.sessions.set("s-b", new FlowHttpError("Database is busy", 500));
		await assert.rejects(h.controller.selectSession("s-b"), /Database is busy/);
		assert.equal(h.store.get().messages, before);
		assert.equal(h.store.get().session, "s-a");
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.store.get().error, null);
		assert.equal(h.storage.data.get(SESSION_KEY), "s-a");
		assert.equal(errors.mock.callCount(), 1);

		h.client.sessions.set("s-b", new TypeError("Failed to fetch"));
		await assert.rejects(h.controller.selectSession("s-b"), /^Error: Could not open this conversation\.$/);
		assert.equal(h.store.get().status, "ready");
	});

	it("puts a hydration error back when the switch away from it fails", async () => {
		const h = harness({}, { status: "error", error: { errorType: "HYDRATION", message: "Could not load." } });
		mock.method(console, "error", () => {});
		h.client.sessions.set("s-b", new TypeError("Failed to fetch"));
		await assert.rejects(h.controller.selectSession("s-b"));
		assert.equal(h.store.get().status, "error");
		assert.deepEqual(h.store.get().error, { errorType: "HYDRATION", message: "Could not load." });
	});

	it("goes back to the state before a chain of switches when the last one fails", async () => {
		const h = harness({}, { status: "error", error: { errorType: "HYDRATION", message: "Could not load." } });
		mock.method(console, "error", () => {});
		const hold = deferred();
		h.client.holds.set("s-a", hold.promise);
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", new TypeError("Failed to fetch"));
		const first = h.controller.selectSession("s-a");
		await assert.rejects(h.controller.selectSession("s-b"));
		hold.release();
		assert.equal(await first, false);
		assert.equal(h.store.get().status, "error");
		assert.equal(h.store.get().error?.message, "Could not load.");
	});

	it("becomes ready again when the switch it superseded came from start()", async () => {
		const h = harness({ [SESSION_KEY]: "s-a" }, { status: "loading" });
		mock.method(console, "error", () => {});
		const hold = deferred();
		h.client.holds.set("s-a", hold.promise);
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", new TypeError("Failed to fetch"));
		const started = h.controller.start();
		await assert.rejects(h.controller.selectSession("s-b"));
		assert.equal(h.store.get().status, "ready");
		hold.release();
		await started;
		assert.equal(transcriptText(h.store), "", "start()'s late result stays dropped");
	});

	for (const status of [404, 403]) {
		it(`removes a conversation the server says is gone (${status}) from the list`, async () => {
			const h = harness({}, undefined, { user: USER });
			mock.method(console, "error", () => {});
			h.client.list = [summary("s-a", "A"), summary("s-b", "B")];
			await h.controller.loadHistory();
			h.client.sessions.set("s-a", new FlowHttpError("Not found", status));

			await assert.rejects(
				h.controller.selectSession("s-a"),
				/^Error: This conversation is no longer available\.$/,
			);
			assert.deepEqual(
				h.controller.history.get().items.map((item) => item.id),
				["s-b"],
			);
			assert.equal(h.store.get().status, "ready");
			assert.equal(h.storage.data.get(SESSION_KEY) ?? "", "");
		});
	}
});

describe("renameSession", () => {
	async function listed(): Promise<Harness> {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s1", "First"), summary("s2", "Second"), summary("s3", "Third")];
		await h.controller.loadHistory();
		return h;
	}

	it("trims, sends and retitles the row in place without reordering", async () => {
		const h = await listed();
		await h.controller.renameSession("s2", "  Better title  ");
		assert.deepEqual(h.client.renames, [{ name: "s2", title: "Better title" }]);
		assert.deepEqual(
			h.controller.history.get().items.map((item) => `${item.id}:${item.title}`),
			["s1:First", "s2:Better title", "s3:Third"],
		);
	});

	it("shows the new title before the server answers", async () => {
		const h = await listed();
		const hold = deferred();
		h.client.renameHold = hold.promise;
		const pending = h.controller.renameSession("s1", "Now");
		assert.equal(h.controller.history.get().items[0]?.title, "Now");
		hold.release();
		await pending;
		assert.equal(h.controller.history.get().items[0]?.title, "Now");
	});

	it("rejects a blank title before any request", async () => {
		const h = await listed();
		for (const title of ["", "   ", "\n\t"]) {
			// oxlint-disable-next-line no-await-in-loop -- sequential: nothing may have been sent after any of them
			await assert.rejects(h.controller.renameSession("s1", title), /^Error: A title is required\.$/);
		}
		assert.deepEqual(h.client.renames, []);
		assert.equal(h.controller.history.get().items[0]?.title, "First");
	});

	it("rejects a title over 200 characters, and accepts exactly 200", async () => {
		const h = await listed();
		await assert.rejects(
			h.controller.renameSession("s1", "x".repeat(201)),
			/^Error: Title cannot exceed 200 characters\.$/,
		);
		assert.deepEqual(h.client.renames, []);
		await h.controller.renameSession("s1", "x".repeat(200));
		assert.equal(h.client.renames.length, 1);
		// the limit applies to the trimmed value
		await h.controller.renameSession("s1", `  ${"y".repeat(200)}  `);
		assert.equal(h.client.renames.length, 2);
	});

	it("puts the old title back and rejects with the server's reason when the server refuses", async () => {
		const h = await listed();
		const errors = mock.method(console, "error", () => {});
		h.client.renameFails = new FlowHttpError("Not permitted", 403);
		await assert.rejects(h.controller.renameSession("s1", "Nope"), /^Error: Not permitted$/);
		assert.equal(h.controller.history.get().items[0]?.title, "First");
		assert.equal(errors.mock.callCount(), 1);

		h.client.renameFails = new TypeError("Failed to fetch");
		await assert.rejects(
			h.controller.renameSession("s1", "Nope"),
			/^Error: Could not rename this conversation\.$/,
		);
		assert.equal(h.controller.history.get().items[0]?.title, "First");
	});

	it("does not roll back over a later rename that has already landed", async () => {
		const h = await listed();
		mock.method(console, "error", () => {});
		const hold = deferred();
		h.client.renameHold = hold.promise;
		h.client.renameFails = new FlowHttpError("Late failure", 500);
		const first = h.controller.renameSession("s1", "One");
		h.client.renameHold = null;
		h.client.renameFails = null;
		await h.controller.renameSession("s1", "Two");
		assert.equal(h.controller.history.get().items[0]?.title, "Two");

		hold.release();
		await assert.rejects(first, /Late failure/);
		assert.equal(h.controller.history.get().items[0]?.title, "Two");
	});

	it("does not roll back over a title a list reload has since put there", async () => {
		const h = await listed();
		mock.method(console, "error", () => {});
		const hold = deferred();
		h.client.renameHold = hold.promise;
		h.client.renameFails = new FlowHttpError("Late failure", 500);
		const pending = h.controller.renameSession("s1", "Mine");
		// the list is reloaded after the rename's overlay is gone (another tab renamed it)
		h.client.renameHold = null;
		h.client.renameFails = null;
		await h.controller.renameSession("s1", "Other call");
		h.client.list = [summary("s1", "Theirs"), summary("s2", "Second")];
		await h.controller.loadHistory();
		hold.release();
		await assert.rejects(pending);
		assert.equal(h.controller.history.get().items[0]?.title, "Theirs");
	});

	it("renames a conversation that is not listed without touching the list", async () => {
		const h = await listed();
		const before = h.controller.history.get().items;
		await h.controller.renameSession("not-listed", "Title");
		assert.deepEqual(h.client.renames, [{ name: "not-listed", title: "Title" }]);
		assert.equal(h.controller.history.get().items, before);
	});
});

describe("deleteSession", () => {
	async function showing(): Promise<Harness> {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary("s-a", "A"), summary("s-b", "B"), summary("s-c", "C")];
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		await h.controller.loadHistory();
		await h.controller.selectSession("s-a");
		return h;
	}

	it("resets to a new chat when the conversation on screen is deleted", async () => {
		const h = await showing();
		await h.controller.deleteSession("s-a");

		assert.deepEqual(h.client.deletes, ["s-a"]);
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s-b", "s-c"],
		);
		assert.deepEqual(h.store.get().messages, []);
		assert.equal(h.store.get().session, null);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.storage.data.get(SESSION_KEY), "");
		// the next message starts a conversation of its own
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("fresh");
		assert.equal(h.client.starts.at(-1)?.session, undefined);
	});

	it("leaves the conversation on screen alone when another one is deleted", async () => {
		const h = await showing();
		const before = h.store.get();
		await h.controller.deleteSession("s-b");
		assert.equal(h.store.get(), before);
		assert.equal(h.storage.data.get(SESSION_KEY), "s-a");
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s-a", "s-c"],
		);
	});

	it("clears a saved pointer to the deleted conversation when it is not the one on screen", async () => {
		const h = await showing();
		h.storage.data.set(SESSION_KEY, "s-b");
		await h.controller.deleteSession("s-b");
		assert.equal(h.storage.data.get(SESSION_KEY), "");
		assert.equal(h.store.get().session, "s-a");
	});

	it("resets the conversation on screen even while a switch to another one is loading", async () => {
		const h = await showing();
		const hold = deferred();
		h.client.holds.set("s-b", hold.promise);
		const switching = h.controller.selectSession("s-b");
		assert.equal(h.store.get().status, "loading");

		await h.controller.deleteSession("s-a");
		assert.equal(h.store.get().status, "ready");
		assert.deepEqual(h.store.get().messages, []);
		hold.release();
		assert.equal(await switching, false);
		assert.deepEqual(h.store.get().messages, []);
	});

	it("cancels a switch to the conversation while it is loading, and gives the status back", async () => {
		const h = await showing();
		const hold = deferred();
		h.client.holds.set("s-b", hold.promise);
		const opening = h.controller.selectSession("s-b");
		assert.equal(h.store.get().status, "loading");

		await h.controller.deleteSession("s-b");
		assert.equal(h.store.get().status, "ready");
		hold.release();

		assert.equal(await opening, false);
		assert.equal(h.store.get().session, "s-a");
		assert.equal(transcriptText(h.store), "question s-a | answer s-a");
		assert.equal(h.storage.data.get(SESSION_KEY), "s-a");
		assert.equal(h.store.get().status, "ready");
	});

	it("cancels a switch made from the hydration error, and puts the error back", async () => {
		const h = harness(
			{},
			{ status: "error", error: { errorType: "HYDRATION", message: "Could not load." } },
			{ user: USER },
		);
		const hold = deferred();
		h.client.holds.set("s-b", hold.promise);
		h.client.sessions.set("s-b", convo("s-b"));
		const opening = h.controller.selectSession("s-b");

		await h.controller.deleteSession("s-b");
		hold.release();

		assert.equal(await opening, false);
		assert.equal(h.store.get().status, "error");
		assert.equal(h.store.get().error?.message, "Could not load.");
		assert.equal(h.store.get().session, null);
		assert.equal(h.storage.data.get(SESSION_KEY) ?? "", "");
	});

	it("leaves a switch to another conversation alone", async () => {
		const h = await showing();
		const hold = deferred();
		h.client.holds.set("s-b", hold.promise);
		const opening = h.controller.selectSession("s-b");

		await h.controller.deleteSession("s-c");
		hold.release();

		assert.equal(await opening, true);
		assert.equal(h.store.get().session, "s-b");
	});

	it("is refused, changing nothing, while another tab streams that conversation", async () => {
		const h = await showing();
		h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 1_000}@s-b`);
		h.storage.data.set(SESSION_KEY, "s-b");
		await assert.rejects(
			h.controller.deleteSession("s-b"),
			/^Error: This conversation is replying in another tab\. Try again when it has finished\.$/,
		);
		assert.deepEqual(h.client.deletes, []);
		assert.equal(h.controller.history.get().items.length, 3);
		assert.equal(h.storage.data.get(SESSION_KEY), "s-b");
	});

	it("is still refused after the other tab moved the shared pointer to a different conversation", async () => {
		const h = await showing();
		h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 1_000}@s-b`);
		h.storage.data.set(SESSION_KEY, "s-c");
		await assert.rejects(h.controller.deleteSession("s-b"), /replying in another tab/);
		assert.deepEqual(h.client.deletes, []);
	});

	it("does not mistake the pointer for the streaming conversation", async () => {
		const h = await showing();
		// the pointer names s-b, but the lease holder streams s-c
		h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 1_000}@s-c`);
		h.storage.data.set(SESSION_KEY, "s-b");
		await h.controller.deleteSession("s-b");
		assert.deepEqual(h.client.deletes, ["s-b"]);
	});

	it("deletes any other conversation while another tab streams, and when its lease is stale", async () => {
		const h = await showing();
		h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 1_000}@s-b`);
		h.storage.data.set(SESSION_KEY, "s-b");
		await h.controller.deleteSession("s-c");
		assert.deepEqual(h.client.deletes, ["s-c"]);

		h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 60_000}@s-b`);
		await h.controller.deleteSession("s-b");
		assert.deepEqual(h.client.deletes, ["s-c", "s-b"]);
	});

	it("is refused for the conversation this tab is streaming", async () => {
		const h = harness({}, undefined, { user: USER });
		h.client.list = [summary(SESSION, "Live")];
		await h.controller.loadHistory();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("hello");
		await g.push(ev.runStarted(RUN, SESSION));

		await assert.rejects(h.controller.deleteSession(SESSION), /replying/);
		assert.deepEqual(h.client.deletes, []);
		assert.equal(h.controller.history.get().items.length, 1);
		g.end();
		await turn;
	});

	it("counts a 404 as deleted", async () => {
		const h = await showing();
		h.client.deleteFails = new FlowHttpError("Not found", 404);
		await h.controller.deleteSession("s-b");
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s-a", "s-c"],
		);
	});

	it("keeps the row and the conversation when the server refuses", async () => {
		const h = await showing();
		const errors = mock.method(console, "error", () => {});
		const before = h.store.get();
		h.client.deleteFails = new FlowHttpError("Only the owner can delete this", 403);
		await assert.rejects(h.controller.deleteSession("s-a"), /^Error: Only the owner can delete this$/);
		assert.equal(h.store.get(), before);
		assert.equal(h.controller.history.get().items.length, 3);
		assert.equal(h.storage.data.get(SESSION_KEY), "s-a");
		assert.equal(errors.mock.callCount(), 1);

		h.client.deleteFails = new TypeError("Failed to fetch");
		await assert.rejects(h.controller.deleteSession("s-a"), /^Error: Could not delete this conversation\.$/);
	});

	it("stops a turn that began in the deleted conversation while the request was out", async () => {
		const h = await showing();
		const hold = deferred();
		h.client.deleteHold = hold.promise;
		const deleting = h.controller.deleteSession("s-a");
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("late");
		await g.push(ev.runStarted(RUN, "s-a"));
		hold.release();
		await deleting;
		await turn;

		assert.equal(g.signal()?.aborted, true);
		assert.deepEqual(h.store.get().messages, []);
		assert.equal(h.store.get().status, "ready");
		assert.equal(h.storage.data.get(STREAM_KEY), undefined);
	});

	it("does not touch the store once disposed", async () => {
		const h = await showing();
		const hold = deferred();
		h.client.deleteHold = hold.promise;
		const deleting = h.controller.deleteSession("s-a");
		h.controller.dispose();
		const before = h.store.get();
		hold.release();
		await deleting;
		assert.equal(h.store.get(), before);
	});
});

describe("a conversation deleted in another tab", () => {
	it("is forgotten by the failed send, so the retry starts a new one", async () => {
		const h = harness({ [AGENT_KEY]: "Flow Agent" }, undefined, { user: USER });
		mock.method(console, "error", () => {});
		h.client.list = [summary(SESSION, "Gone"), summary("s-b", "Other")];
		await h.controller.loadHistory();
		h.client.sessions.set(SESSION, convo(SESSION));
		await h.controller.selectSession(SESSION);
		h.client.nextStart(rejectWith(new FlowHttpError("Flow Session t5r2m7q1cd not found", 404)));

		await h.controller.send("hello");

		const [error] = lastResponse(h.store).output.generic;
		assert.ok(error && isInlineErrorItem(error));
		assert.equal(error.text, "Flow Session t5r2m7q1cd not found");
		assert.equal(h.client.starts[0]?.session, SESSION);
		assert.equal(h.store.get().session, null);
		assert.equal(h.storage.data.get(SESSION_KEY), "");
		assert.equal(h.store.get().status, "ready");
		assert.deepEqual(
			h.controller.history.get().items.map((item) => item.id),
			["s-b"],
		);

		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("hello");
		assert.equal(h.client.starts[1]?.session, undefined);
		assert.equal(h.client.starts[1]?.agent, "Flow Agent");
	});

	it("keeps the session for any other HTTP failure", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.sessions.set(SESSION, convo(SESSION));
		await h.controller.selectSession(SESSION);
		h.client.nextStart(rejectWith(new FlowHttpError("Boom", 500)));
		await h.controller.send("hello");
		assert.equal(h.store.get().session, SESSION);
		assert.equal(h.storage.data.get(SESSION_KEY), SESSION);
	});

	it("leaves the pointer alone when a new chat's first send gets a 404", async () => {
		const h = harness({ [SESSION_KEY]: "kept" });
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new FlowHttpError("Agent not found", 404)));
		await h.controller.send("hello");
		assert.equal(h.storage.data.get(SESSION_KEY), "kept");
	});
});

describe("a session still holding a Running run", () => {
	const REFUSED = "This session already has a run in progress.";

	async function conversation(extra: Record<string, string> = {}): Promise<Harness> {
		const h = harness(extra);
		h.client.sessions.set(SESSION, convo(SESSION));
		await h.controller.selectSession(SESSION);
		return h;
	}

	it("is recovered when flow refuses the turn, and the turn is asked once more", async () => {
		const h = await conversation();
		h.client.recovered = 1;
		h.client.nextStart(rejectWith(new FlowHttpError(REFUSED, 417)));
		h.client.nextStart(replay(TEXT_ONLY.events));

		await h.controller.send("again");

		assert.deepEqual(h.client.recovers, [SESSION]);
		assert.equal(h.client.starts.length, 2);
		assert.deepEqual(h.client.starts[1], h.client.starts[0]);
		assert.equal(textOf(lastResponse(h.store)), "Hello there! How can I help?");
		assert.equal(h.store.get().status, "ready");
	});

	it("shows flow's reason when there was no run to recover", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new FlowHttpError("No model is enabled", 417)));

		await h.controller.send("again");

		assert.deepEqual(h.client.recovers, [SESSION]);
		assert.equal(h.client.starts.length, 1);
		assert.equal(h.store.get().status, "ready");
	});

	it("shows flow's reason when recovery itself fails", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.recoverFails = new FlowHttpError("nope", 500);
		h.client.nextStart(rejectWith(new FlowHttpError(REFUSED, 417)));

		await h.controller.send("again");

		assert.equal(h.client.starts.length, 1);
		assert.equal(h.store.get().status, "ready");
	});

	it("leaves a run another tab is streaming alone", async () => {
		const h = await conversation({ [STREAM_KEY]: `${OTHER_TAB}@${NOW - 1_000}@${SESSION}` });
		mock.method(console, "error", () => {});
		h.client.recovered = 1;
		h.client.nextStart(rejectWith(new FlowHttpError(REFUSED, 417)));

		await h.controller.send("again");

		assert.deepEqual(h.client.recovers, []);
		assert.equal(h.client.starts.length, 1);
	});

	it("does not ask again for a refusal that is not a validation error", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.recovered = 1;
		h.client.nextStart(rejectWith(new FlowHttpError("Request failed (502)", 502)));

		await h.controller.send("again");

		assert.equal(h.client.starts.length, 1);
		assert.deepEqual(h.client.recovers, [], "a dropped request is recovered by the interruption path only");
	});

	it("does not start a second run once the first has produced a frame", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.recovered = 1;
		h.client.nextStart(playbackThenThrow([ev.runStarted(RUN, SESSION)], new FlowHttpError(REFUSED, 417)));

		await h.controller.send("again");

		assert.equal(h.client.starts.length, 1);
		assert.equal(h.store.get().status, "ready");
	});

	it("does not look for one on a new chat", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.recovered = 1;
		h.client.nextStart(rejectWith(new FlowHttpError("No model is enabled", 417)));

		await h.controller.send("hello");

		assert.deepEqual(h.client.recovers, []);
		assert.equal(h.client.starts.length, 1);
	});
});

describe("an interrupted stream", () => {
	async function conversation(extra: Record<string, string> = {}): Promise<Harness> {
		const h = harness(extra);
		h.client.sessions.set(SESSION, convo(SESSION));
		await h.controller.selectSession(SESSION);
		h.client.recovers.length = 0;
		return h;
	}

	it("is recovered when the body ends without done, so the retry is not refused", async () => {
		const h = await conversation();
		const hold = deferred();
		h.client.recoverHold = hold.promise;
		h.client.nextStart(replay([ev.runStarted(RUN, SESSION), ev.text("Half")]));
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, [SESSION]);
		assert.equal(h.store.get().status, "ready", "the UI does not wait for the server half");

		// the next turn waits for the recovery before it posts
		h.client.nextStart(replay(TEXT_ONLY.events));
		const retry = h.controller.send("one");
		await tick();
		assert.equal(h.client.starts.length, 1);
		hold.release();
		await retry;
		assert.equal(h.client.starts.length, 2);
	});

	it("is recovered when the connection throws mid-stream", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.nextStart(playbackThenThrow([ev.runStarted(RUN, SESSION)], new TypeError("network error")));
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, [SESSION]);
	});

	it("is recovered when the request never connected", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new TypeError("Failed to fetch")));
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, [SESSION]);
	});

	it("uses the session the stream announced for a first turn", async () => {
		const h = harness();
		h.client.nextStart(replay([ev.runStarted(RUN, "s-new"), ev.text("Half")]));
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, ["s-new"]);
	});

	it("is not recovered when a turn ends the way flow ends it itself", async () => {
		const h = await conversation();
		mock.method(console, "error", () => {});
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("done");
		h.client.nextStart(replay(ERROR_MID_TEXT.events));
		await h.controller.send("error frame");
		h.client.nextStart(replay(PAUSED_TWO_QUESTIONS.events));
		await h.controller.send("paused");
		assert.deepEqual(h.client.recovers, []);
	});

	it("is not recovered when no session is known yet", async () => {
		const h = harness();
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new TypeError("Failed to fetch")));
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, []);
	});

	it("is not recovered while another tab streams", async () => {
		const h = await conversation();
		// both tabs stream: the shared lease key belongs to the other one when this stream breaks
		h.client.nextStart(async function* () {
			yield ev.runStarted(RUN, SESSION);
			yield ev.text("Half");
			h.storage.data.set(STREAM_KEY, `${OTHER_TAB}@${NOW - 1_000}@${SESSION}`);
		});
		await h.controller.send("one");
		assert.deepEqual(h.client.recovers, []);
		assert.equal(h.storage.data.get(STREAM_KEY), `${OTHER_TAB}@${NOW - 1_000}@${SESSION}`);
	});

	it("survives a failing recovery", async () => {
		const h = await conversation();
		const errors = mock.method(console, "error", () => {});
		h.client.recoverFails = new FlowHttpError("nope", 500);
		h.client.nextStart(replay([ev.runStarted(RUN, SESSION), ev.text("Half")]));
		await h.controller.send("one");
		h.client.recoverFails = null;
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("one");
		assert.equal(h.store.get().status, "ready");
		assert.equal(textOf(lastResponse(h.store)), "Hello there! How can I help?");
		assert.ok(errors.mock.callCount() >= 1);
	});

	it("is not recovered after Stop, which tells the server itself", async () => {
		const h = await conversation();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		await h.controller.stop();
		await turn;
		assert.deepEqual(h.client.recovers, []);
		assert.deepEqual(h.client.stops, [RUN]);
	});
});

// -- attachments --------------------------------------------------------------

const LIMITS: UploadLimits = { extensions: ["csv", "pdf", "txt"], maxFileBytes: 1000, maxFiles: 5 };

function nth<T>(list: readonly T[], index: number): T {
	const found = list[index];
	if (found === undefined) throw new Error(`no element at ${index} (length ${list.length})`);
	return found;
}

function attachHarness(
	extra: Partial<ControllerDeps> = {},
	storeInit?: Parameters<typeof harness>[1],
): Harness {
	return harness({}, storeInit, { uploadLimits: LIMITS, ...extra });
}

function txt(name: string, size = 10, lastModified = 1, type = ""): File {
	return new File(["x".repeat(size)], name, { lastModified, type });
}

function uploadedDoc(name: string, fileName = "a.txt"): UploadedFile {
	return { name, fileName, fileUrl: `/private/files/${fileName}`, fileSize: 10 };
}

function attachedDoc(name: string, fileName = "a.txt", fileSize = 10): AttachedFile {
	return { file: name, fileName, fileSize };
}

/** Stages one file and returns its upload id. */
function stage(h: Harness, name = "a.txt", file: File = txt(name)): string {
	const result = h.controller.addFiles([file]);
	return nth(result.added, 0);
}

/** Drives staged upload `index` through both steps; resolves once the store has seen the result. */
async function finish(h: Harness, index: number, doc: string, fileName = "a.txt"): Promise<void> {
	nth(h.client.uploadCalls, index).resolve(uploadedDoc(doc, fileName));
	await tick();
	nth(h.client.attachCalls, h.client.attachCalls.length - 1).resolve(attachedDoc(doc, fileName));
	await tick();
}

function pendingOf(h: Harness): readonly { id: string; status: string }[] {
	return h.store.get().pendingUploads;
}

function statusesOf(h: Harness): string[] {
	return pendingOf(h).map((upload) => upload.status);
}

function expectedField(doc: string, name: string, size = 10): ReturnType<typeof fileFieldFor> {
	return fileFieldFor({ type: "reference", id: doc, name, size });
}

describe("addFiles", () => {
	it("exposes the limits it was given, or null", () => {
		assert.equal(attachHarness().controller.uploadLimits, LIMITS);
		assert.equal(harness().controller.uploadLimits, null);
	});

	it("stages an accepted file as uploading at progress 0 and starts its upload", () => {
		const h = attachHarness();
		const file = txt("a.txt");
		const result = h.controller.addFiles([file]);

		assert.equal(result.added.length, 1);
		assert.match(nth(result.added, 0), /^upload-\d+$/);
		assert.deepEqual(result.rejections, []);
		assert.deepEqual(h.store.get().pendingUploads, [
			{ id: nth(result.added, 0), file, status: "uploading", progress: 0 },
		]);
		assert.equal(h.store.get().hasInFlightUploads, true);
		assert.equal(h.client.uploadCalls.length, 1);
		assert.equal(nth(h.client.uploadCalls, 0).file, file);
		assert.equal(nth(h.client.uploadCalls, 0).options.signal?.aborted, false);
	});

	it("mints ids that never repeat, across calls and after removals", () => {
		const h = attachHarness();
		const ids = new Set<string>();
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			const id = stage(h, name);
			assert.equal(ids.has(id), false);
			ids.add(id);
			h.controller.removeFile(id);
		}
		const again = stage(h, "d.txt");
		assert.equal(ids.has(again), false);
	});

	it("stages several files in selection order and returns the refused ones with their sentences", () => {
		const h = attachHarness();
		const a = txt("a.txt");
		const b = txt("b.csv");
		const result = h.controller.addFiles([a, txt("bad.exe"), b, txt("empty.txt", 0), txt("big.txt", 1001)]);

		assert.deepEqual(
			pendingOf(h).map((upload) => upload.id),
			result.added,
		);
		assert.deepEqual(
			h.client.uploadCalls.map((call) => call.file),
			[a, b],
		);
		assert.deepEqual(
			result.rejections.map((rejection) => [rejection.reason, rejection.fileName, rejection.message]),
			[
				["type", "bad.exe", "bad.exe is not a supported file type."],
				["empty", "empty.txt", "empty.txt is empty."],
				["size", "big.txt", "big.txt is larger than the 1,000 B limit."],
			],
		);
	});

	it("checks against the files already staged, failed ones included", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		const same = txt("a.txt", 10, 5);
		stage(h, "a.txt", same);
		nth(h.client.uploadCalls, 0).reject(new FlowHttpError("nope", 417));
		await tick();
		assert.deepEqual(statusesOf(h), ["error"]);

		const result = h.controller.addFiles([txt("a.txt", 10, 5)]);
		assert.deepEqual(result.added, []);
		assert.equal(nth(result.rejections, 0).reason, "duplicate");
	});

	it("stops at the limit and says so once", () => {
		const h = attachHarness({ uploadLimits: { ...LIMITS, maxFiles: 2 } });
		const result = h.controller.addFiles([txt("a.txt"), txt("b.txt"), txt("c.txt"), txt("d.txt")]);
		assert.equal(result.added.length, 2);
		assert.deepEqual(
			result.rejections.map((rejection) => [rejection.reason, rejection.fileName]),
			[["count", null]],
		);
		assert.equal(pendingOf(h).length, 2);
	});

	it("words size messages for the locale it was given", () => {
		const h = attachHarness({ uploadLimits: { ...LIMITS, maxFileBytes: 1536 }, locale: "de" });
		const result = h.controller.addFiles([txt("big.txt", 2000)]);
		assert.equal(nth(result.rejections, 0).message, "big.txt is larger than the 1,5 KB limit.");
	});

	it("does nothing, and says nothing, for an empty selection", () => {
		const h = harness();
		assert.deepEqual(h.controller.addFiles([]), { added: [], rejections: [] });
	});

	it("is refused as unavailable with no limits, creating no upload", () => {
		const h = harness();
		const result = h.controller.addFiles([txt("a.txt"), txt("b.txt")]);
		assert.deepEqual(result.added, []);
		assert.deepEqual(result.rejections, [
			{ reason: "unavailable", fileName: null, message: "Attaching files is not available right now." },
		]);
		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.client.uploadCalls.length, 0);
	});

	it("is refused as unavailable while the conversation is loading", () => {
		const h = attachHarness();
		h.store.setStatus("loading");
		const result = h.controller.addFiles([txt("a.txt")]);
		assert.equal(nth(result.rejections, 0).reason, "unavailable");
		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.client.uploadCalls.length, 0);
	});

	it("is refused while an approval card waits, as one rejection", async () => {
		const h = attachHarness();
		h.client.nextStart(replay(PAUSED_TWO_QUESTIONS.events));
		await h.controller.send("Create a ToDo to call Bob and delete the old one");
		assert.ok(pendingApproval(h.store.get().messages));

		const result = h.controller.addFiles([txt("a.txt"), txt("b.txt")]);

		assert.deepEqual(result.added, []);
		assert.deepEqual(result.rejections, [
			{
				reason: "approval",
				fileName: null,
				message: "Answer the assistant's question before attaching files.",
			},
		]);
		assert.deepEqual(pendingOf(h), []);
	});

	it("is allowed while a reply is submitted or streaming", async () => {
		const h = attachHarness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		assert.equal(h.store.get().status, "submitted");
		assert.equal(h.controller.addFiles([txt("a.txt")]).added.length, 1);

		await g.push(ev.runStarted(RUN, SESSION));
		await g.push(ev.text("partial"));
		assert.equal(h.store.get().status, "streaming");
		assert.equal(h.controller.addFiles([txt("b.txt")]).added.length, 1);

		await g.push(ev.done("Completed", "partial", 1, {}));
		g.end();
		await turn;
		assert.equal(pendingOf(h).length, 2);
	});

	it("is ignored after dispose", () => {
		const h = attachHarness();
		h.controller.dispose();
		assert.deepEqual(h.controller.addFiles([txt("a.txt")]), { added: [], rejections: [] });
		assert.equal(h.client.uploadCalls.length, 0);
	});
});

describe("the upload pipeline", () => {
	it("moves uploading to progress 1 once the file is on the server, then to complete once flow has read it", async () => {
		const h = attachHarness();
		const id = stage(h, "a.txt", txt("a.txt", 10, 1, "text/plain"));
		const upload = nth(h.client.uploadCalls, 0);

		upload.resolve(uploadedDoc("D1"));
		await tick();
		const reading = nth(pendingOf(h), 0);
		assert.equal(reading.status, "uploading");
		assert.equal(h.store.get().pendingUploads[0]?.progress, 1);
		assert.equal(h.store.get().hasInFlightUploads, true);
		assert.equal(nth(h.client.attachCalls, 0).doc, "D1");
		assert.equal(nth(h.client.attachCalls, 0).signal, upload.options.signal);

		nth(h.client.attachCalls, 0).resolve(attachedDoc("D1", "a.txt", 10));
		await tick();
		const [done] = h.store.get().pendingUploads;
		assert.ok(done);
		assert.equal(done.id, id);
		assert.equal(done.status, "complete");
		assert.equal("progress" in done, false);
		assert.equal("errorMessage" in done, false);
		assert.deepEqual(done.contributedData, {
			fields: [
				fileFieldFor({ type: "reference", id: "D1", name: "a.txt", size: 10, mime_type: "text/plain" }),
			],
		});
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.deepEqual(h.client.fileDeletes, []);
	});

	it("names the file as flow did, and falls back to the file's size when flow sent none", async () => {
		const h = attachHarness();
		stage(h, "a.txt", txt("a.txt", 7));
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		nth(h.client.attachCalls, 0).resolve({ file: "D1", fileName: "Renamed.txt", fileSize: 0 });
		await tick();
		assert.deepEqual(nth(pendingOf(h), 0), {
			...nth(h.store.get().pendingUploads, 0),
			contributedData: { fields: [expectedField("D1", "Renamed.txt", 7)] },
		});
	});

	it("runs files side by side", async () => {
		const h = attachHarness();
		stage(h, "a.txt");
		stage(h, "b.txt");
		assert.equal(h.client.uploadCalls.length, 2);
		await finish(h, 1, "D2", "b.txt");
		assert.deepEqual(statusesOf(h), ["uploading", "complete"]);
		await finish(h, 0, "D1", "a.txt");
		assert.deepEqual(statusesOf(h), ["complete", "complete"]);
	});

	it("an upload that fails shows the server's reason and leaves no File doc to delete", async () => {
		const h = attachHarness();
		const errors = mock.method(console, "error", () => {});
		stage(h);
		const failure = new FlowHttpError("File type not allowed", 417);
		nth(h.client.uploadCalls, 0).reject(failure);
		await tick();

		const [upload] = h.store.get().pendingUploads;
		assert.ok(upload);
		assert.equal(upload.status, "error");
		assert.equal(upload.errorMessage, "File type not allowed");
		assert.equal("progress" in upload, false);
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.deepEqual(h.client.fileDeletes, []);
		assert.equal(h.client.attachCalls.length, 0);
		assert.deepEqual(
			errors.mock.calls.map((call) => call.arguments[0]),
			[failure],
		);
	});

	it("says it plainly when the failure has no reason a user could act on", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h);
		nth(h.client.uploadCalls, 0).reject(new TypeError("Failed to fetch"));
		await tick();
		assert.equal(nth(h.store.get().pendingUploads, 0).errorMessage, "The file could not be uploaded.");

		stage(h, "b.txt");
		nth(h.client.uploadCalls, 1).reject(new FlowHttpError("", 500));
		await tick();
		assert.equal(nth(h.store.get().pendingUploads, 1).errorMessage, "The file could not be uploaded.");
	});

	it("an upload flow refuses is marked failed and its File doc is deleted once", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		const id = stage(h, "blank.txt");
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1", "blank.txt"));
		await tick();
		nth(h.client.attachCalls, 0).reject(new FlowHttpError("No readable text found in this file.", 417));
		await tick();

		const [upload] = h.store.get().pendingUploads;
		assert.ok(upload);
		assert.equal(upload.status, "error");
		assert.equal(upload.errorMessage, "No readable text found in this file.");
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);

		h.controller.removeFile(id);
		assert.deepEqual(h.client.fileDeletes, ["D1"], "nobody deletes it a second time");
		assert.deepEqual(pendingOf(h), []);
	});

	it("an upload whose attach fails without a reason gets the plain sentence", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		nth(h.client.attachCalls, 0).reject(new Error("Unexpected response from the server."));
		await tick();
		assert.equal(nth(h.store.get().pendingUploads, 0).errorMessage, "The file could not be uploaded.");
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("an AbortError nobody asked for is a failure, not a hang", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h);
		nth(h.client.uploadCalls, 0).reject(abortError());
		await tick();
		assert.deepEqual(statusesOf(h), ["error"]);
		assert.equal(h.store.get().hasInFlightUploads, false);
	});

	it("reports a failed deletion without throwing", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		const warnings = mock.method(console, "warn", () => {});
		h.client.fileDeleteFails = new Error("locked");
		stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		nth(h.client.attachCalls, 0).reject(new FlowHttpError("Unsupported file type: .x", 417));
		await tick();
		assert.equal(warnings.mock.callCount(), 1);
		assert.equal(nth(warnings.mock.calls, 0).arguments[0], h.client.fileDeleteFails);
		assert.deepEqual(statusesOf(h), ["error"]);
	});
});

describe("upload progress", () => {
	function started(): {
		h: Harness;
		report: (loaded: number, total: number) => void;
		progress: () => number | undefined;
	} {
		const h = attachHarness();
		stage(h);
		const { onProgress } = nth(h.client.uploadCalls, 0).options;
		assert.ok(onProgress);
		return {
			h,
			report: (loaded, total) => onProgress({ loaded, total }),
			progress: () => h.store.get().pendingUploads[0]?.progress,
		};
	}

	it("writes the first report at once as a fraction of the total", () => {
		const { report, progress } = started();
		report(25, 100);
		assert.equal(progress(), 0.25);
	});

	it("writes at most once per 100 ms by the controller's clock", () => {
		const { h, report, progress } = started();
		report(10, 100);
		h.clock.now += 99;
		report(20, 100);
		assert.equal(progress(), 0.1);
		h.clock.now += 1;
		report(30, 100);
		assert.equal(progress(), 0.3);
		report(40, 100);
		assert.equal(progress(), 0.3, "the throttle window restarts at each write");
	});

	it("does not write an unchanged value, and does not start a window for it", () => {
		const { h, report, progress } = started();
		const seen: number[] = [];
		h.store.select(
			(state) => state.pendingUploads,
			() => void seen.push(1),
		);
		report(10, 100);
		h.clock.now += 500;
		report(10, 100);
		assert.equal(seen.length, 1);
		h.clock.now += 1;
		report(11, 100);
		assert.equal(progress(), 0.11, "the skipped report did not use up the window");
	});

	it("ignores a report with no total, and never writes 1 itself", () => {
		const { h, report, progress } = started();
		report(50, 0);
		assert.equal(progress(), 0);
		report(100, 100);
		assert.equal(progress(), 0.99);
		h.clock.now += 200;
		report(500, 100);
		assert.equal(progress(), 0.99);
	});

	it("never moves backwards", () => {
		const { h, report, progress } = started();
		report(60, 100);
		h.clock.now += 200;
		report(30, 100);
		assert.equal(progress(), 0.6);
	});

	it("ignores nonsense numbers", () => {
		const { h, report, progress } = started();
		report(Number.NaN, 100);
		h.clock.now += 200;
		report(-5, 100);
		h.clock.now += 200;
		report(5, Number.NaN);
		assert.equal(progress(), 0);
	});

	it("always writes the move to 1, even inside the throttle window", async () => {
		const { h, report, progress } = started();
		report(90, 100);
		assert.equal(progress(), 0.9);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		assert.equal(progress(), 1);
	});

	it("a late report cannot undo the move to 1", async () => {
		const { h, report, progress } = started();
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		h.clock.now += 500;
		report(10, 100);
		assert.equal(progress(), 1);
	});

	it("a late report for a removed upload does not bring it back", () => {
		const { h, report } = started();
		h.controller.removeFile(nth(h.store.get().pendingUploads, 0).id);
		h.clock.now += 500;
		report(50, 100);
		assert.deepEqual(pendingOf(h), []);
	});

	it("a late report for a finished upload changes nothing", async () => {
		const { h, report } = started();
		await finish(h, 0, "D1");
		const before = h.store.get();
		h.clock.now += 500;
		report(50, 100);
		assert.equal(h.store.get(), before);
	});
});

describe("removeFile", () => {
	it("during the upload: the chip goes at once, the request is aborted, nothing is deleted or attached", async () => {
		const h = attachHarness();
		const errors = mock.method(console, "error", () => {});
		const id = stage(h);
		const { signal } = nth(h.client.uploadCalls, 0).options;

		h.controller.removeFile(id);

		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.equal(signal?.aborted, true);
		await tick();
		assert.deepEqual(h.client.fileDeletes, []);
		assert.equal(h.client.attachCalls.length, 0);
		assert.equal(errors.mock.callCount(), 0);
		assert.deepEqual(pendingOf(h), []);
	});

	it("when the last byte had already landed: the File doc is deleted and flow is never asked", async () => {
		const h = attachHarness();
		const id = stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		// The abort arrives after the transfer finished but before the pipeline noticed.
		h.controller.removeFile(id);
		await tick();

		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		assert.equal(h.client.attachCalls.length, 0);
		assert.deepEqual(pendingOf(h), []);
	});

	it("during attach: aborts flow's request and deletes the File doc once", async () => {
		const h = attachHarness();
		const errors = mock.method(console, "error", () => {});
		const id = stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		const attach = nth(h.client.attachCalls, 0);

		h.controller.removeFile(id);

		assert.deepEqual(pendingOf(h), []);
		assert.equal(attach.signal?.aborted, true);
		assert.deepEqual(h.client.fileDeletes, ["D1"], "deleted without waiting for the aborted request");
		await tick();
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		assert.equal(errors.mock.callCount(), 0);
		assert.deepEqual(pendingOf(h), []);
	});

	it("during attach, when flow answers anyway: the chip stays gone and nothing is deleted twice", async () => {
		const h = attachHarness();
		h.client.abortRejects = false;
		const id = stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();

		h.controller.removeFile(id);
		nth(h.client.attachCalls, 0).resolve(attachedDoc("D1"));
		await tick();

		assert.deepEqual(pendingOf(h), []);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("during attach, when flow fails after the abort: no error appears and nothing is deleted twice", async () => {
		const h = attachHarness();
		h.client.abortRejects = false;
		const errors = mock.method(console, "error", () => {});
		const id = stage(h);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();

		h.controller.removeFile(id);
		nth(h.client.attachCalls, 0).reject(new FlowHttpError("late failure", 417));
		await tick();

		assert.deepEqual(pendingOf(h), []);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		assert.equal(errors.mock.callCount(), 0);
	});

	it("after the upload completed: deletes the File doc", async () => {
		const h = attachHarness();
		const id = stage(h);
		await finish(h, 0, "D1");
		h.controller.removeFile(id);
		assert.deepEqual(pendingOf(h), []);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("after the upload failed: only clears the chip", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		const id = stage(h);
		nth(h.client.uploadCalls, 0).reject(new FlowHttpError("no", 417));
		await tick();
		h.controller.removeFile(id);
		assert.deepEqual(pendingOf(h), []);
		assert.deepEqual(h.client.fileDeletes, []);
	});

	it("twice, or for an unknown id: does nothing the second time", async () => {
		const h = attachHarness();
		const id = stage(h);
		await finish(h, 0, "D1");
		h.controller.removeFile(id);
		h.controller.removeFile(id);
		h.controller.removeFile("upload-nope");
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("removing one file leaves the others and their requests alone", async () => {
		const h = attachHarness();
		const a = stage(h, "a.txt");
		stage(h, "b.txt");
		h.controller.removeFile(a);
		assert.equal(nth(h.client.uploadCalls, 0).options.signal?.aborted, true);
		assert.equal(nth(h.client.uploadCalls, 1).options.signal?.aborted, false);
		await finish(h, 1, "D2", "b.txt");
		assert.deepEqual(statusesOf(h), ["complete"]);
	});

	it("a failed deletion is reported and changes nothing else", async () => {
		const h = attachHarness();
		const warnings = mock.method(console, "warn", () => {});
		const id = stage(h);
		await finish(h, 0, "D1");
		h.client.fileDeleteFails = new Error("locked");
		h.controller.removeFile(id);
		await tick();
		assert.equal(warnings.mock.callCount(), 1);
		assert.deepEqual(pendingOf(h), []);
	});

	it("is ignored after dispose", async () => {
		const h = attachHarness();
		const id = stage(h);
		await finish(h, 0, "D1");
		h.controller.dispose();
		h.controller.removeFile(id);
		assert.deepEqual(h.client.fileDeletes, ["D1"], "dispose deleted it once; removeFile adds nothing");
		assert.equal(pendingOf(h).length, 1);
	});

	describe("once the last byte is sent", () => {
		/** Reports the whole body as sent, as the browser does before frappe has answered. */
		function sendAll(h: Harness, index = 0): void {
			nth(h.client.uploadCalls, index).options.onProgress?.({ loaded: 100, total: 100 });
		}

		it("does not abort: frappe creates the File anyway, so it is deleted when the reply arrives", async () => {
			const h = attachHarness();
			const id = stage(h);
			sendAll(h);
			const call = nth(h.client.uploadCalls, 0);

			h.controller.removeFile(id);

			assert.deepEqual(pendingOf(h), [], "the chip goes at once");
			assert.equal(call.options.signal?.aborted, false);
			assert.deepEqual(h.client.fileDeletes, []);

			call.resolve(uploadedDoc("D1"));
			await tick();
			assert.deepEqual(h.client.fileDeletes, ["D1"]);
			assert.equal(h.client.attachCalls.length, 0, "flow is never asked");
		});

		it("deletes nothing when the request then fails, and reports nothing", async () => {
			const h = attachHarness();
			const errors = mock.method(console, "error", () => {});
			const id = stage(h);
			sendAll(h);
			h.controller.removeFile(id);
			nth(h.client.uploadCalls, 0).reject(new FlowHttpError("Too big", 413));
			await tick();
			assert.deepEqual(h.client.fileDeletes, []);
			assert.equal(errors.mock.callCount(), 0);
			assert.deepEqual(pendingOf(h), []);
		});

		it("still aborts a transfer that is not finished", () => {
			const h = attachHarness();
			const id = stage(h);
			nth(h.client.uploadCalls, 0).options.onProgress?.({ loaded: 40, total: 100 });
			h.controller.removeFile(id);
			assert.equal(nth(h.client.uploadCalls, 0).options.signal?.aborted, true);
		});

		it("a size the browser does not know never counts as sent", () => {
			const h = attachHarness();
			const id = stage(h);
			nth(h.client.uploadCalls, 0).options.onProgress?.({ loaded: 100, total: 0 });
			h.controller.removeFile(id);
			assert.equal(nth(h.client.uploadCalls, 0).options.signal?.aborted, true);
		});

		it("New chat leaves the request running and deletes the File when it lands", async () => {
			const h = attachHarness();
			stage(h);
			sendAll(h);
			h.controller.newChat();
			assert.equal(nth(h.client.uploadCalls, 0).options.signal?.aborted, false);
			nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
			await tick();
			assert.deepEqual(h.client.fileDeletes, ["D1"]);
		});
	});

	it("deletes the File doc of an abort that lost the race, once, unless the controller is gone", async () => {
		const h = attachHarness();
		h.client.abortRejects = false;
		const id = stage(h);
		h.controller.removeFile(id);
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		assert.equal(h.client.attachCalls.length, 0);
	});
});

describe("send with files", () => {
	async function twoFiles(h: Harness): Promise<void> {
		stage(h, "a.txt");
		stage(h, "b.csv", txt("b.csv", 20));
		await finish(h, 0, "D1", "a.txt");
		nth(h.client.uploadCalls, 1).resolve(uploadedDoc("D2", "b.csv"));
		await tick();
		nth(h.client.attachCalls, 1).resolve(attachedDoc("D2", "b.csv", 20));
		await tick();
	}

	it("carries both files on the request and in attachments, and empties the composer", async () => {
		const h = attachHarness();
		await twoFiles(h);
		h.client.nextStart(replay(TEXT_ONLY.events));

		await h.controller.send("compare these");

		const [request] = h.store.get().messages;
		assert.ok(request && isRequest(request));
		assert.deepEqual(request.input, {
			message_type: "text",
			text: "compare these",
			structured_data: { fields: [expectedField("D1", "a.txt"), expectedField("D2", "b.csv", 20)] },
		});
		assert.equal(JSON.stringify(request.input).includes('"url"'), false);
		assert.deepEqual(nth(h.client.starts, 0).attachments, ["D1", "D2"]);
		assert.equal(nth(h.client.starts, 0).input, "compare these");
		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.deepEqual(h.client.fileDeletes, []);

		h.controller.newChat();
		assert.deepEqual(h.client.fileDeletes, [], "a sent file belongs to the conversation");
	});

	it("moves the chips in the same step as the request appears", async () => {
		const h = attachHarness();
		stage(h);
		await finish(h, 0, "D1");
		h.client.nextStart(replay(TEXT_ONLY.events));

		const turn = h.controller.send("hi");

		// Synchronously, before the first await of the stream:
		assert.equal(h.store.get().messages.length, 1);
		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.store.get().status, "submitted");
		await turn;
	});

	it("a request without files has neither structured_data nor attachments", async () => {
		const h = attachHarness();
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("hi");
		const [request] = h.store.get().messages;
		assert.ok(request && isRequest(request));
		assert.equal("structured_data" in request.input, false);
		assert.equal("attachments" in nth(h.client.starts, 0), false);
	});

	it("does nothing while an upload is in flight, keeping every staged file", async () => {
		const h = attachHarness();
		stage(h, "a.txt");
		await finish(h, 0, "D1");
		stage(h, "b.txt");
		const before = h.store.get();

		await h.controller.send("hi");

		assert.equal(h.store.get(), before);
		assert.equal(h.client.starts.length, 0);
		assert.deepEqual(statusesOf(h), ["complete", "uploading"]);
	});

	it("does nothing while an upload has failed, keeping every staged file", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h, "a.txt");
		await finish(h, 0, "D1");
		stage(h, "b.txt");
		nth(h.client.uploadCalls, 1).reject(new FlowHttpError("no", 417));
		await tick();
		const before = h.store.get();

		await h.controller.send("hi");

		assert.equal(h.store.get(), before);
		assert.equal(h.client.starts.length, 0);
		assert.deepEqual(statusesOf(h), ["complete", "error"]);
	});

	it("sends once the failed file is removed", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h, "a.txt");
		await finish(h, 0, "D1");
		const bad = stage(h, "b.txt");
		nth(h.client.uploadCalls, 1).reject(new FlowHttpError("no", 417));
		await tick();
		h.controller.removeFile(bad);
		h.client.nextStart(replay(TEXT_ONLY.events));

		await h.controller.send("hi");

		assert.deepEqual(nth(h.client.starts, 0).attachments, ["D1"]);
	});

	it("sends an upload that finishes after a send was refused", async () => {
		const h = attachHarness();
		stage(h);
		await h.controller.send("hi");
		assert.equal(h.client.starts.length, 0);
		await finish(h, 0, "D1");
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("hi");
		assert.deepEqual(nth(h.client.starts, 0).attachments, ["D1"]);
	});

	it("a redirect answer carries no files and leaves them staged", async () => {
		const h = attachHarness();
		h.client.nextStart(replay(PAUSED_TWO_QUESTIONS.events));
		await h.controller.send("Create a ToDo to call Bob and delete the old one");
		// Staged before the card appeared would be refused now, so stage through the store.
		const file = txt("a.txt");
		h.store.addPendingUpload({
			id: "upload-x",
			file,
			status: "complete",
			contributedData: { fields: [expectedField("D1", "a.txt")] },
		});
		h.client.nextResume(replay(RESUME_REDIRECTED_PAUSED_AGAIN.events));

		await h.controller.send("do something else");

		assert.equal(h.client.resumes.length, 1);
		assert.equal(h.client.starts.length, 1);
		assert.deepEqual(statusesOf(h), ["complete"]);
		assert.deepEqual(h.client.fileDeletes, []);
	});

	it("keeps the files on the retry inside the recovery path", async () => {
		const h = attachHarness({}, { session: "S1" });
		stage(h);
		await finish(h, 0, "D1");
		h.client.recovered = 1;
		h.client.nextStart(rejectWith(new FlowHttpError("A run is still going", 417)));
		h.client.nextStart(replay(TEXT_ONLY.events));

		await h.controller.send("hi");

		assert.equal(h.client.starts.length, 2);
		assert.deepEqual(
			h.client.starts.map((params) => params.attachments),
			[["D1"], ["D1"]],
		);
		assert.deepEqual(h.client.fileDeletes, []);
	});

	it("never deletes the files of a turn that failed", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h);
		await finish(h, 0, "D1");
		h.client.nextStart(rejectWith(new FlowHttpError("No model is enabled", 417)));

		await h.controller.send("hi");

		assert.deepEqual(h.client.fileDeletes, []);
		assert.deepEqual(pendingOf(h), []);
		h.controller.newChat();
		h.controller.dispose();
		assert.deepEqual(h.client.fileDeletes, []);
	});
});

describe("retryLast", () => {
	it("sends the last request again with its files and leaves staged files staged", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h, "a.txt");
		await finish(h, 0, "D1");
		h.client.nextStart(rejectWith(new FlowHttpError("No model is enabled", 417)));
		await h.controller.send("summarise");

		stage(h, "b.txt");
		await finish(h, 1, "D2", "b.txt");
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.retryLast();

		assert.equal(h.client.starts.length, 2);
		assert.deepEqual(
			h.client.starts.map((params) => params.attachments),
			[["D1"], ["D1"]],
		);
		assert.equal(nth(h.client.starts, 1).input, "summarise");
		assert.deepEqual(statusesOf(h), ["complete"], "the staged file is not consumed");
		const requests = h.store.get().messages.filter(isRequest);
		assert.equal(requests.length, 2);
		assert.deepEqual(nth(requests, 1).input.structured_data, nth(requests, 0).input.structured_data);
		assert.deepEqual(h.client.fileDeletes, []);

		// The staged file goes with the next typed message.
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.send("and this");
		assert.deepEqual(nth(h.client.starts, 2).attachments, ["D2"]);
	});

	it("sends a request that had no files without attachments", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		h.client.nextStart(rejectWith(new FlowHttpError("bad", 417)));
		await h.controller.send("hi");
		h.client.nextStart(replay(TEXT_ONLY.events));
		await h.controller.retryLast();
		assert.equal("attachments" in nth(h.client.starts, 1), false);
		const requests = h.store.get().messages.filter(isRequest);
		assert.equal("structured_data" in nth(requests, 1).input, false);
	});

	it("resends the files of a restored conversation", async () => {
		const h = attachHarness();
		const session = {
			name: "s-r",
			messages: [
				{ role: "user", content: "what is in it", run: "run-r" },
				{ role: "assistant", content: "A file.", run: "run-r" },
			],
			attachments: [{ file: "F9", file_name: "old.txt", file_size: 4, run: "run-r" }],
		};
		h.client.sessions.set("s-r", { session, runs: [{ name: "run-r", session: "s-r", status: "Completed" }] });
		await h.controller.selectSession("s-r");
		h.client.nextStart(replay(TEXT_ONLY.events));

		await h.controller.retryLast();

		assert.deepEqual(nth(h.client.starts, 0).attachments, ["F9"]);
		assert.equal(nth(h.client.starts, 0).session, "s-r");
		assert.equal(nth(h.client.starts, 0).input, "what is in it");
	});

	it("does nothing without a request, while a turn is live, or after dispose", async () => {
		const h = attachHarness();
		await h.controller.retryLast();
		assert.equal(h.client.starts.length, 0);

		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await h.controller.retryLast();
		assert.equal(h.client.starts.length, 1);
		await g.push(ev.done("Completed", "x", 1, {}));
		g.end();
		await turn;

		h.controller.dispose();
		await h.controller.retryLast();
		assert.equal(h.client.starts.length, 1);
	});

	it("answers a waiting approval card, as send does", async () => {
		const h = attachHarness();
		h.client.nextStart(replay(PAUSED_TWO_QUESTIONS.events));
		await h.controller.send("Create a ToDo to call Bob and delete the old one");
		h.client.nextResume(replay(RESUME_REDIRECTED_PAUSED_AGAIN.events));
		await h.controller.retryLast();
		assert.equal(h.client.resumes.length, 1);
		assert.equal(h.client.starts.length, 1);
	});
});

describe("newChat with files", () => {
	it("aborts what is uploading, deletes what finished, and clears a failure", async () => {
		const h = attachHarness();
		mock.method(console, "error", () => {});
		stage(h, "done.txt");
		await finish(h, 0, "D1", "done.txt");
		stage(h, "bad.txt");
		nth(h.client.uploadCalls, 1).reject(new FlowHttpError("no", 417));
		await tick();
		stage(h, "live.txt");
		const live = nth(h.client.uploadCalls, 2);
		assert.deepEqual(statusesOf(h), ["complete", "error", "uploading"]);

		h.controller.newChat();

		assert.deepEqual(pendingOf(h), []);
		assert.equal(h.store.get().hasInFlightUploads, false);
		assert.equal(live.options.signal?.aborted, true);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		await tick();
		assert.equal(h.client.attachCalls.length, 1, "the aborted upload never reached flow");
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("is ignored while a stream is live, files included", async () => {
		const h = attachHarness();
		const g = gate();
		h.client.nextStart(g.script);
		const turn = h.controller.send("one");
		await g.push(ev.runStarted(RUN, SESSION));
		stage(h);
		await finish(h, 0, "D1");

		h.controller.newChat();

		assert.deepEqual(statusesOf(h), ["complete"]);
		assert.deepEqual(h.client.fileDeletes, []);
		await g.push(ev.done("Completed", "x", 1, {}));
		g.end();
		await turn;
	});

	it("is not what switching conversations does: staged files follow the user", async () => {
		const h = attachHarness({ user: "me@example.com" }, undefined);
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.sessions.set("s-b", convo("s-b"));
		await h.controller.selectSession("s-a");
		stage(h);
		await finish(h, 0, "D1");

		await h.controller.selectSession("s-b");

		assert.deepEqual(statusesOf(h), ["complete"]);
		assert.deepEqual(h.client.fileDeletes, []);
	});

	it("a file added while a conversation loads is refused", async () => {
		const h = attachHarness();
		const hold = deferred();
		h.client.sessions.set("s-a", convo("s-a"));
		h.client.holds.set("s-a", hold.promise);
		const switching = h.controller.selectSession("s-a");
		assert.equal(h.store.get().status, "loading");
		assert.equal(nth(h.controller.addFiles([txt("a.txt")]).rejections, 0).reason, "unavailable");
		hold.release();
		await switching;
	});

	it("deleting the conversation on screen discards the staged files like New chat", async () => {
		const h = attachHarness({ user: "me@example.com" });
		h.client.sessions.set("s-a", convo("s-a"));
		await h.controller.selectSession("s-a");
		stage(h, "done.txt");
		await finish(h, 0, "D1", "done.txt");
		stage(h, "live.txt");
		const live = nth(h.client.uploadCalls, 1);

		await h.controller.deleteSession("s-a");

		assert.deepEqual(pendingOf(h), []);
		assert.equal(live.options.signal?.aborted, true);
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("deleting another conversation leaves the staged files", async () => {
		const h = attachHarness({ user: "me@example.com" });
		h.client.sessions.set("s-a", convo("s-a"));
		await h.controller.selectSession("s-a");
		stage(h);
		await finish(h, 0, "D1");

		await h.controller.deleteSession("s-other");

		assert.deepEqual(statusesOf(h), ["complete"]);
		assert.deepEqual(h.client.fileDeletes, []);
	});
});

describe("pagehide with files", () => {
	function withWindow(run: (page: EventTarget) => Promise<void>): Promise<void> {
		const page = new EventTarget();
		Reflect.defineProperty(globalThis, "window", { value: page, configurable: true, writable: true });
		return run(page).finally(() => void Reflect.deleteProperty(globalThis, "window"));
	}
	const hide = (persisted: boolean): Event => Object.assign(new Event("pagehide"), { persisted });

	it("deletes the finished uploads that were never sent, with a request that outlives the page", () =>
		withWindow(async (page) => {
			const h = attachHarness();
			stage(h, "a.txt");
			stage(h, "b.txt");
			await finish(h, 0, "D1", "a.txt");

			page.dispatchEvent(hide(false));

			assert.deepEqual(h.client.fileDeletes, ["D1"]);
			assert.deepEqual(h.client.fileDeleteKeepalive, [true]);
			page.dispatchEvent(hide(false));
			assert.deepEqual(h.client.fileDeletes, ["D1"], "once");
		}));

	it("leaves the files alone when the page is only entering the back-forward cache", () =>
		withWindow(async (page) => {
			const h = attachHarness();
			stage(h);
			await finish(h, 0, "D1");
			page.dispatchEvent(hide(true));
			assert.deepEqual(h.client.fileDeletes, []);
		}));

	it("does not touch the files a sent message took over", () =>
		withWindow(async (page) => {
			const h = attachHarness();
			stage(h);
			await finish(h, 0, "D1");
			h.client.nextStart(replay(TEXT_ONLY.events));
			await h.controller.send("hello");
			page.dispatchEvent(hide(false));
			assert.deepEqual(h.client.fileDeletes, []);
		}));

	it("stops listening once disposed", () =>
		withWindow(async (page) => {
			const h = attachHarness();
			stage(h);
			await finish(h, 0, "D1");
			h.controller.dispose();
			page.dispatchEvent(hide(false));
			assert.deepEqual(h.client.fileDeletes, ["D1"], "dispose already deleted it; the page adds nothing");
		}));
});

describe("dispose with files", () => {
	it("aborts every request and deletes the finished File docs with a request that outlives the page", async () => {
		const h = attachHarness();
		stage(h, "a.txt");
		stage(h, "b.txt");
		stage(h, "c.txt");
		nth(h.client.uploadCalls, 2).resolve(uploadedDoc("D3", "c.txt"));
		await tick();
		await finish(h, 0, "D1", "a.txt");
		const signals = h.client.uploadCalls.map((call) => call.options.signal);
		const attach = nth(h.client.attachCalls, 1);
		const before = h.store.get();

		h.controller.dispose();
		await tick();

		assert.deepEqual(
			signals.map((signal) => signal?.aborted),
			[true, true, true],
		);
		assert.equal(attach.signal?.aborted, true);
		assert.deepEqual([...h.client.fileDeletes].sort(), ["D1", "D3"]);
		assert.deepEqual(h.client.fileDeleteKeepalive, [true, true]);
		assert.equal(h.store.get(), before, "the store is not touched again");
	});

	it("deletes the File of an abort that loses the race, and never asks flow about it", async () => {
		const h = attachHarness();
		h.client.abortRejects = false;
		stage(h);
		h.controller.dispose();
		nth(h.client.uploadCalls, 0).resolve(uploadedDoc("D1"));
		await tick();
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
		assert.deepEqual(h.client.fileDeleteKeepalive, [true]);
		assert.equal(h.client.attachCalls.length, 0);
	});

	it("lets a fully sent request finish rather than orphan its File", async () => {
		const h = attachHarness();
		stage(h);
		const call = nth(h.client.uploadCalls, 0);
		call.options.onProgress?.({ loaded: 5, total: 5 });
		h.controller.dispose();
		assert.equal(call.options.signal?.aborted, false);
		call.resolve(uploadedDoc("D1"));
		await tick();
		assert.deepEqual(h.client.fileDeletes, ["D1"]);
	});

	it("does not report a failure that follows the abort", async () => {
		const h = attachHarness();
		h.client.abortRejects = false;
		const errors = mock.method(console, "error", () => {});
		stage(h);
		h.controller.dispose();
		nth(h.client.uploadCalls, 0).reject(new FlowHttpError("late", 500));
		await tick();
		assert.equal(errors.mock.callCount(), 0);
		assert.deepEqual(statusesOf(h), ["uploading"]);
	});
});
