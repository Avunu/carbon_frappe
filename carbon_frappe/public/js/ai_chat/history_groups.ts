// How the conversation list is organised, as pure functions: calendar-day buckets and the
// client-side search. The view (view/history.ts) draws what these return.
import type { HistoryItem } from "./history_model.ts";
import type { Translate } from "./i18n.ts";
import { daysBetween } from "./timestamps.ts";

/**
 * The calendar-day buckets, in the order they are listed. Days are counted in the user's zone:
 * `today` is the current day, `yesterday` the day before, `week` the 2 to 7 days before today,
 * `month` the 8 to 30, `older` anything further back and any item whose `modified` is null.
 */
export type HistoryBucket = "today" | "yesterday" | "week" | "month" | "older";

const BUCKET_ORDER: readonly HistoryBucket[] = ["today", "yesterday", "week", "month", "older"];

export interface HistoryGroup {
	readonly bucket: HistoryBucket;
	/** Translated: "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older". */
	readonly label: string;
	readonly items: readonly HistoryItem[];
}

export interface GroupOptions {
	/** IANA zone the days are counted in; the browser's when absent. */
	timeZone?: string | undefined;
	translate: Translate;
}

export function bucketOf(modified: number | null, now: number, timeZone?: string): HistoryBucket {
	if (modified === null) return "older";
	// a negative count is a timestamp ahead of this browser's clock
	const days = daysBetween(modified, now, timeZone);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days <= 7) return "week";
	if (days <= 30) return "month";
	return "older";
}

/**
 * Split `items` (already newest first) into buckets, keeping each item's relative order and
 * omitting empty buckets. An item dated after `now` (a clock skewed between server and browser)
 * counts as today.
 */
export function groupByDate(
	items: readonly HistoryItem[],
	now: number,
	options: GroupOptions,
): HistoryGroup[] {
	const __ = options.translate;
	const labels: Record<HistoryBucket, string> = {
		today: __("Today"),
		yesterday: __("Yesterday"),
		week: __("Previous 7 days"),
		month: __("Previous 30 days"),
		older: __("Older"),
	};
	const buckets = new Map<HistoryBucket, HistoryItem[]>();
	for (const item of items) {
		const bucket = bucketOf(item.modified, now, options.timeZone);
		const members = buckets.get(bucket);
		if (members === undefined) buckets.set(bucket, [item]);
		else members.push(item);
	}
	const groups: HistoryGroup[] = [];
	for (const bucket of BUCKET_ORDER) {
		const members = buckets.get(bucket);
		if (members !== undefined) groups.push({ bucket, label: labels[bucket], items: members });
	}
	return groups;
}

/**
 * The items whose title contains `query`, ignoring case and surrounding whitespace, in their
 * original order. A blank query returns `items` itself (same array), so a caller can skip work
 * with an identity check.
 */
export function filterItems(items: readonly HistoryItem[], query: string): readonly HistoryItem[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle === "") return items;
	return items.filter((item) => item.title.toLocaleLowerCase().includes(needle));
}
