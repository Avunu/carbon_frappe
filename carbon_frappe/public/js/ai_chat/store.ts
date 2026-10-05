// The chat state container. Shaped like ADR-0002's ChatSDKStateAccess so that
// swapping in `@carbon/ai-chat/sdk` later is a type-only change for its consumers.
// `upsert` takes (id, state, updater) like the SDK's `messaging.upsertMessage`, but is
// synchronous and also accepts a plain Message where the SDK takes an updater function.
//
// State is replaced, never mutated: a snapshot handed out by `get()` stays valid
// forever, fields a change did not touch keep their reference, and `Object.is` on
// those references is the only change detection (the same contract
// `useSyncExternalStore`-style consumers and `select()` rely on).

import type { ChatError, ChatState, ChatStatus, Message, MessageState, PendingUpload } from "./types.ts";

export interface SelectOptions<T> {
	isEqual?: (a: T, b: T) => boolean;
}

export interface ChatStore {
	get(): ChatState;
	subscribe(listener: () => void): () => void;
	select<T>(
		selector: (state: ChatState) => T,
		listener: (value: T) => void,
		options?: SelectOptions<T>,
	): () => void;
	upsert(
		id: string,
		state: MessageState,
		updater: Message | ((previous: Message | undefined) => Message),
	): void;
	getMessageState(id: string): MessageState | undefined;
	remove(ids: readonly string[]): void;
	replace(messages: readonly Message[]): void;
	setStatus(status: ChatStatus, error?: ChatError): void;
	setSession(session: string | null): void;
	/** Appends to `pendingUploads`. An id that is already there is left alone. */
	addPendingUpload(upload: PendingUpload): void;
	/**
	 * Replaces one pending upload with what `updater` returns; the id and file must not change.
	 * An unknown id does nothing, so a late callback for a removed upload is harmless.
	 */
	updatePendingUpload(id: string, updater: (previous: PendingUpload) => PendingUpload): void;
	/** An unknown id does nothing. */
	removePendingUpload(id: string): void;
	clearPendingUploads(): void;
	/** Clears `pendingUploads` along with everything else, unless `initial` says otherwise. */
	reset(initial?: Partial<ChatState>): void;
}

// A listener that mutates the store on every pass would otherwise spin the tab
// forever; one extra pass is the designed case, so this is far beyond any real use.
const MAX_DELIVERY_PASSES = 100;

interface Subscription {
	notify: () => void;
}

function anyUploading(uploads: readonly PendingUpload[]): boolean {
	return uploads.some((upload) => upload.status === "uploading");
}

export function createChatStore(initial?: Partial<ChatState>): ChatStore {
	let state: ChatState = {
		messages: [],
		status: "loading",
		error: null,
		activeResponseId: null,
		session: null,
		pendingUploads: [],
		hasInFlightUploads: false,
		...initial,
	};
	// The flag is derived, so a caller's `initial` can never contradict the list.
	state = { ...state, hasInFlightUploads: anyUploading(state.pendingUploads) };
	// Not part of ChatState: a message-state change alone notifies nobody.
	let messageStates = new Map<string, MessageState>();
	for (const message of state.messages) {
		if (message.id !== undefined) messageStates.set(message.id, "complete");
	}

	const subscriptions = new Set<Subscription>();
	let delivering = false;
	let redeliver = false;

	function deliverPass(): void {
		// A snapshot, so a listener subscribing during the pass is not called in it, while
		// the `has` check lets one that was unsubscribed by an earlier listener be skipped.
		for (const subscription of Array.from(subscriptions)) {
			if (!subscriptions.has(subscription)) continue;
			try {
				subscription.notify();
			} catch (error) {
				console.error(error);
			}
		}
	}

	function deliver(): void {
		// A mutation made by a listener has already been applied; flag one more pass
		// instead of recursing so every listener ends up seeing the final state.
		if (delivering) {
			redeliver = true;
			return;
		}
		delivering = true;
		try {
			let passes = 0;
			do {
				redeliver = false;
				if (++passes > MAX_DELIVERY_PASSES) {
					console.error(new Error("ChatStore: listeners keep mutating the store; giving up on delivery."));
					break;
				}
				deliverPass();
			} while (redeliver);
		} finally {
			delivering = false;
			redeliver = false;
		}
	}

	function commit(next: ChatState): void {
		if (
			Object.is(next.messages, state.messages) &&
			Object.is(next.status, state.status) &&
			Object.is(next.error, state.error) &&
			Object.is(next.activeResponseId, state.activeResponseId) &&
			Object.is(next.session, state.session) &&
			Object.is(next.pendingUploads, state.pendingUploads) &&
			Object.is(next.hasInFlightUploads, state.hasInFlightUploads)
		) {
			return;
		}
		state = next;
		deliver();
	}

	function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
		return a.length === b.length && a.every((message, index) => message === b[index]);
	}

	function subscribeInternal(notify: () => void): () => void {
		const subscription: Subscription = { notify };
		subscriptions.add(subscription);
		return () => {
			subscriptions.delete(subscription);
		};
	}

	return {
		get: () => state,

		subscribe: (listener) => subscribeInternal(() => listener()),

		select(selector, listener, options) {
			const isEqual = options?.isEqual ?? Object.is;
			let previous = selector(state);
			return subscribeInternal(() => {
				const next = selector(state);
				if (isEqual(previous, next)) return;
				previous = next;
				listener(next);
			});
		},

		upsert(id, messageState, updater) {
			const index = state.messages.findIndex((message) => message.id === id);
			const previous = index === -1 ? undefined : state.messages[index];
			// Resolve the updater before touching anything: a throw must leave no trace.
			const resolved = typeof updater === "function" ? updater(previous) : updater;
			const next: Message = resolved.id === id ? resolved : { ...resolved, id };

			let messages = state.messages;
			if (index === -1) {
				messages = [...state.messages, next];
			} else if (previous !== next) {
				messages = state.messages.map((message, at) => (at === index ? next : message));
			}
			messageStates.set(id, messageState);

			let activeResponseId = state.activeResponseId;
			if (messageState === "streaming") activeResponseId = id;
			else if (activeResponseId === id) activeResponseId = null;

			commit({ ...state, messages, activeResponseId });
		},

		getMessageState: (id) => messageStates.get(id),

		remove(ids) {
			const doomed = new Set(ids);
			for (const id of doomed) messageStates.delete(id);
			const kept = state.messages.filter((message) => message.id === undefined || !doomed.has(message.id));
			const activeResponseId =
				state.activeResponseId !== null && doomed.has(state.activeResponseId) ? null : state.activeResponseId;
			commit({
				...state,
				messages: kept.length === state.messages.length ? state.messages : kept,
				activeResponseId,
			});
		},

		replace(messages) {
			const next = messages.map((message, index) =>
				message.id === undefined ? { ...message, id: `message-${index}` } : message,
			);
			messageStates = new Map();
			for (const message of next) {
				if (message.id !== undefined) messageStates.set(message.id, "complete");
			}
			commit({
				...state,
				messages: sameMessages(state.messages, next) ? state.messages : next,
				activeResponseId: null,
			});
		},

		setStatus(status, error) {
			const clearsActive = status === "ready" || status === "error" || status === "loading";
			commit({
				...state,
				status,
				error: status === "error" ? (error ?? null) : null,
				activeResponseId: clearsActive ? null : state.activeResponseId,
			});
		},

		setSession(session) {
			commit({ ...state, session });
		},

		addPendingUpload(upload) {
			if (state.pendingUploads.some((existing) => existing.id === upload.id)) return;
			const pendingUploads = [...state.pendingUploads, upload];
			commit({ ...state, pendingUploads, hasInFlightUploads: anyUploading(pendingUploads) });
		},

		updatePendingUpload(id, updater) {
			const index = state.pendingUploads.findIndex((upload) => upload.id === id);
			const previous = state.pendingUploads[index];
			if (previous === undefined) return;
			const next = updater(previous);
			if (next === previous) return;
			const pendingUploads = state.pendingUploads.map((upload, at) => (at === index ? next : upload));
			commit({ ...state, pendingUploads, hasInFlightUploads: anyUploading(pendingUploads) });
		},

		removePendingUpload(id) {
			if (!state.pendingUploads.some((upload) => upload.id === id)) return;
			const pendingUploads = state.pendingUploads.filter((upload) => upload.id !== id);
			commit({ ...state, pendingUploads, hasInFlightUploads: anyUploading(pendingUploads) });
		},

		clearPendingUploads() {
			if (state.pendingUploads.length === 0) return;
			commit({ ...state, pendingUploads: [], hasInFlightUploads: false });
		},

		reset(overrides) {
			const next: ChatState = {
				messages: [],
				status: "ready",
				error: null,
				activeResponseId: null,
				session: null,
				pendingUploads: [],
				hasInFlightUploads: false,
				...overrides,
			};
			next.hasInFlightUploads = anyUploading(next.pendingUploads);
			// An empty list is an empty list: keep the reference so a reset of an idle store notifies nobody.
			if (next.pendingUploads.length === 0 && state.pendingUploads.length === 0) {
				next.pendingUploads = state.pendingUploads;
			}
			messageStates = new Map();
			for (const message of next.messages) {
				if (message.id !== undefined) messageStates.set(message.id, "complete");
			}
			commit(
				next.messages.length === 0 && state.messages.length === 0
					? { ...next, messages: state.messages }
					: next,
			);
		},
	};
}
