import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	bucketOf,
	filterItems,
	groupByDate,
} from "../../../carbon_frappe/public/js/ai_chat/history_groups.ts";
import type { HistoryItem } from "../../../carbon_frappe/public/js/ai_chat/history_model.ts";
import type { Translate } from "../../../carbon_frappe/public/js/ai_chat/i18n.ts";
import { identityTranslate } from "../../../carbon_frappe/public/js/ai_chat/i18n.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";

function item(id: string, modified: number | null, title = id): HistoryItem {
	return { id, title, modified };
}

describe("bucketOf", () => {
	// 2026-10-02 12:00 UTC is 08:00 in New York (EDT) and 17:30 in Kolkata
	const now = Date.UTC(2026, 9, 2, 12, 0, 0);

	it("counts calendar days, not 24 hour spans", () => {
		assert.equal(bucketOf(now, now, "UTC"), "today");
		// 20 hours ago but across midnight in UTC
		assert.equal(bucketOf(Date.UTC(2026, 9, 1, 16, 0, 0), now, "UTC"), "yesterday");
		assert.equal(bucketOf(Date.UTC(2026, 9, 1, 0, 0, 0), now, "UTC"), "yesterday");
		assert.equal(bucketOf(Date.UTC(2026, 8, 30, 23, 59, 59), now, "UTC"), "week");
	});

	it("moves the day boundary at local midnight", () => {
		const midnight = Date.UTC(2026, 9, 2, 0, 0, 0);
		assert.equal(bucketOf(midnight, midnight, "UTC"), "today");
		assert.equal(bucketOf(midnight - 1, midnight, "UTC"), "yesterday");
		assert.equal(bucketOf(midnight + DAY - 1, midnight, "UTC"), "today");
	});

	it("gives one instant different buckets in different zones", () => {
		// 10:30 UTC is 23:30 on Oct 2 in Auckland (UTC+13) and 00:30 in Honolulu (UTC-10); an hour later
		// Auckland is on Oct 3 and Honolulu still on Oct 2
		const instant = Date.UTC(2026, 9, 2, 10, 30, 0);
		const later = instant + HOUR;
		assert.equal(bucketOf(instant, later, "Pacific/Auckland"), "yesterday");
		assert.equal(bucketOf(instant, later, "Pacific/Honolulu"), "today");
	});

	it("takes the 7 and 30 day edges", () => {
		assert.equal(bucketOf(now - 2 * DAY, now, "UTC"), "week");
		assert.equal(bucketOf(now - 7 * DAY, now, "UTC"), "week");
		assert.equal(bucketOf(now - 8 * DAY, now, "UTC"), "month");
		assert.equal(bucketOf(now - 30 * DAY, now, "UTC"), "month");
		assert.equal(bucketOf(now - 31 * DAY, now, "UTC"), "older");
		assert.equal(bucketOf(now - 400 * DAY, now, "UTC"), "older");
	});

	it("counts across a month and a year end", () => {
		const newYear = Date.UTC(2027, 0, 2, 9, 0, 0);
		assert.equal(bucketOf(Date.UTC(2027, 0, 1, 23, 0, 0), newYear, "UTC"), "yesterday");
		assert.equal(bucketOf(Date.UTC(2026, 11, 31, 23, 0, 0), newYear, "UTC"), "week");
		assert.equal(bucketOf(Date.UTC(2026, 11, 3, 9, 0, 0), newYear, "UTC"), "month");
		assert.equal(bucketOf(Date.UTC(2026, 11, 2, 9, 0, 0), newYear, "UTC"), "older");
	});

	it("stays correct on the 23 and 25 hour days of a DST change", () => {
		// New York springs forward on 2026-03-08 (23 hour day): 00:30 EST is 05:30 UTC
		const afterSpring = Date.UTC(2026, 2, 9, 16, 0, 0); // Mar 9 12:00 EDT
		assert.equal(bucketOf(Date.UTC(2026, 2, 8, 5, 30, 0), afterSpring, NY), "yesterday");
		// 23:30 EST on Mar 7 is 04:30 UTC Mar 8: two calendar days back, though only 35.5 hours
		assert.equal(bucketOf(Date.UTC(2026, 2, 8, 4, 30, 0), afterSpring, NY), "week");
		// falls back on 2026-11-01 (25 hour day): 00:30 EDT is 04:30 UTC
		const afterFall = Date.UTC(2026, 10, 2, 17, 0, 0); // Nov 2 12:00 EST
		assert.equal(bucketOf(Date.UTC(2026, 10, 1, 4, 30, 0), afterFall, NY), "yesterday");
		assert.equal(bucketOf(Date.UTC(2026, 10, 1, 6, 30, 0), afterFall, NY), "yesterday");
		assert.equal(bucketOf(Date.UTC(2026, 10, 1, 3, 59, 59), afterFall, NY), "week");
	});

	it("puts a time in the future today", () => {
		assert.equal(bucketOf(now + HOUR, now, "UTC"), "today");
		assert.equal(bucketOf(now + 40 * DAY, now, "UTC"), "today");
	});

	it("puts an unknown time in older", () => {
		assert.equal(bucketOf(null, now, "UTC"), "older");
	});

	it("reads an unknown zone name in the browser's zone instead of throwing", () => {
		assert.equal(bucketOf(now, now, "Not/AZone"), "today");
	});
});

describe("groupByDate", () => {
	const now = Date.UTC(2026, 9, 2, 12, 0, 0);

	it("returns no groups for no items", () => {
		assert.deepEqual(groupByDate([], now, { translate: identityTranslate, timeZone: "UTC" }), []);
	});

	it("groups in listed order, omits empty buckets and keeps each bucket's order", () => {
		const items = [
			item("a", now - HOUR),
			item("b", now - 2 * HOUR),
			item("c", now - DAY),
			item("d", now - 3 * DAY),
			item("e", now - 5 * DAY),
			item("f", now - 20 * DAY),
			item("g", now - 90 * DAY),
			item("h", null),
		];
		const groups = groupByDate(items, now, { translate: identityTranslate, timeZone: "UTC" });
		assert.deepEqual(
			groups.map((group) => [group.bucket, group.label, group.items.map((i) => i.id)]),
			[
				["today", "Today", ["a", "b"]],
				["yesterday", "Yesterday", ["c"]],
				["week", "Previous 7 days", ["d", "e"]],
				["month", "Previous 30 days", ["f"]],
				["older", "Older", ["g", "h"]],
			],
		);
	});

	it("skips a bucket nothing falls in", () => {
		const groups = groupByDate([item("a", now), item("b", now - 60 * DAY)], now, {
			translate: identityTranslate,
			timeZone: "UTC",
		});
		assert.deepEqual(
			groups.map((group) => group.bucket),
			["today", "older"],
		);
	});

	it("keeps an item's identity", () => {
		const first = item("a", now);
		const groups = groupByDate([first], now, { translate: identityTranslate, timeZone: "UTC" });
		assert.equal(groups[0]?.items[0], first);
	});

	it("collects out-of-order input into the right buckets", () => {
		const groups = groupByDate([item("old", now - 90 * DAY), item("new", now)], now, {
			translate: identityTranslate,
			timeZone: "UTC",
		});
		assert.deepEqual(
			groups.map((group) => group.bucket),
			["today", "older"],
		);
	});

	it("translates every label it uses", () => {
		const asked: string[] = [];
		const translate: Translate = (source, replace) => {
			asked.push(source);
			return `[${identityTranslate(source, replace)}]`;
		};
		const groups = groupByDate([item("a", now), item("b", now - DAY)], now, { translate, timeZone: "UTC" });
		assert.deepEqual(
			groups.map((group) => group.label),
			["[Today]", "[Yesterday]"],
		);
		for (const source of ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]) {
			assert.ok(asked.includes(source), source);
		}
	});

	it("counts days in the given zone", () => {
		const at = Date.UTC(2026, 9, 2, 3, 0, 0); // Oct 1 23:00 in New York
		const items = [item("a", at)];
		const clock = Date.UTC(2026, 9, 2, 12, 0, 0); // Oct 2 08:00 in New York
		assert.equal(
			groupByDate(items, clock, { translate: identityTranslate, timeZone: NY })[0]?.bucket,
			"yesterday",
		);
		assert.equal(
			groupByDate(items, clock, { translate: identityTranslate, timeZone: "UTC" })[0]?.bucket,
			"today",
		);
	});
});

describe("filterItems", () => {
	const items = [
		item("1", 1, "Quarterly Report"),
		item("2", 2, "invoice questions"),
		item("3", 3, "ÄPFEL kaufen"),
	];

	it("returns the same array for a blank query", () => {
		assert.equal(filterItems(items, ""), items);
		assert.equal(filterItems(items, "  \t "), items);
	});

	it("matches a substring of the title, ignoring case", () => {
		assert.deepEqual(
			filterItems(items, "REPORT").map((i) => i.id),
			["1"],
		);
		assert.deepEqual(
			filterItems(items, "ques").map((i) => i.id),
			["2"],
		);
	});

	it("lowercases beyond ASCII", () => {
		assert.deepEqual(
			filterItems(items, "äpfel").map((i) => i.id),
			["3"],
		);
	});

	it("ignores whitespace around the query but not inside it", () => {
		assert.deepEqual(
			filterItems(items, "  report ").map((i) => i.id),
			["1"],
		);
		assert.deepEqual(filterItems(items, "quarterly  report"), []);
	});

	it("keeps the original order and returns nothing when nothing matches", () => {
		assert.deepEqual(
			filterItems(items, "e").map((i) => i.id),
			["1", "2", "3"],
		);
		assert.deepEqual(filterItems(items, "zzz"), []);
	});

	it("takes regex characters literally", () => {
		assert.deepEqual(
			filterItems([item("x", 1, "a.c"), item("y", 1, "abc")], "a.c").map((i) => i.id),
			["x"],
		);
	});
});
