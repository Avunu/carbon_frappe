// The state behind the conversation list: what the controller loads and the history view
// draws. Separate from ChatStore because it is not part of the conversation (ADR-0002's
// ChatSDKState has no list of past sessions) and changes on a different rhythm: it is
// refetched whenever the list opens, while the messages stream.
//
// State is replaced, never mutated, as in store.ts: `Object.is` on `items` is the change
// test, and a field a `set` did not touch keeps its reference.
import type { FlowSessionSummary } from "./flow/docs.ts";
import type { Translate } from "./i18n.ts";
import { serverDatetimeToEpoch } from "./timestamps.ts";

/** How many conversations one load asks for. A list that fills it is flagged `truncated`. */
export const HISTORY_LIMIT = 100;
/** Flow Session.title is a Data field of this length. */
export const HISTORY_TITLE_MAX = 200;

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

export interface HistoryItem {
	/** The Flow Session name. */
	readonly id: string;
	/** Never empty: a session with no title yet reads as "Untitled conversation". */
	readonly title: string;
	/** Last activity (`Flow Session.modified`) in epoch ms, or null when the server's string did not parse. */
	readonly modified: number | null;
}

export interface HistoryState {
	/**
	 * `idle`: never loaded. `loading`: a fetch is in flight (the items of an earlier load, if any, stay
	 * in `items` so the list does not flash empty). `ready`: `items` is current. `error`: the last
	 * fetch failed; `items` still holds whatever the last good load returned.
	 */
	readonly status: HistoryStatus;
	/** Newest first (the server's order). */
	readonly items: readonly HistoryItem[];
	/** The server's reason for the last failed load, or "" when it gave none; null unless `status` is `error`. */
	readonly error: string | null;
	/** The server had at least HISTORY_LIMIT conversations: older ones exist that are not listed. */
	readonly truncated: boolean;
}

/** What the view reads. The controller owns the writes. */
export interface HistoryModel {
	get(): HistoryState;
	subscribe(listener: () => void): () => void;
	select<T>(
		selector: (state: HistoryState) => T,
		listener: (value: T) => void,
		isEqual?: (a: T, b: T) => boolean,
	): () => void;
}

/** The writable face, held by the controller. */
export interface HistoryModelWriter extends HistoryModel {
	set(patch: Partial<HistoryState>): void;
}

export function createHistoryModel(): HistoryModelWriter {
	let state: HistoryState = { status: "idle", items: [], error: null, truncated: false };
	const listeners = new Set<() => void>();

	function subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	return {
		get: () => state,
		subscribe,
		select(selector, listener, isEqual = Object.is) {
			let previous = selector(state);
			return subscribe(() => {
				const next = selector(state);
				if (isEqual(previous, next)) return;
				previous = next;
				listener(next);
			});
		},
		set(patch) {
			const next: HistoryState = { ...state, ...patch };
			if (
				Object.is(next.status, state.status) &&
				Object.is(next.items, state.items) &&
				Object.is(next.error, state.error) &&
				Object.is(next.truncated, state.truncated)
			) {
				return;
			}
			state = next;
			for (const listener of Array.from(listeners)) {
				try {
					listener();
				} catch (error) {
					console.error(error);
				}
			}
		},
	};
}

/** A `get_list` row as a list item. `translate` supplies the title of a session that has none yet. */
export function toHistoryItem(
	summary: FlowSessionSummary,
	options: { translate: Translate; systemTimeZone?: string },
): HistoryItem {
	const __ = options.translate;
	const title = (summary.title ?? "").trim();
	return {
		id: summary.name,
		title: title === "" ? __("Untitled conversation") : title,
		modified: serverDatetimeToEpoch(summary.modified, options.systemTimeZone) ?? null,
	};
}
