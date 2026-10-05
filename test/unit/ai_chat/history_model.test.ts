import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	HISTORY_LIMIT,
	HISTORY_TITLE_MAX,
	createHistoryModel,
	toHistoryItem,
} from "../../../carbon_frappe/public/js/ai_chat/history_model.ts";
import type { HistoryItem } from "../../../carbon_frappe/public/js/ai_chat/history_model.ts";
import { identityTranslate } from "../../../carbon_frappe/public/js/ai_chat/i18n.ts";

const item = (id: string): HistoryItem => ({ id, title: id, modified: 1 });

describe("limits", () => {
	it("matches what flow stores and what the list asks for", () => {
		assert.equal(HISTORY_LIMIT, 100);
		assert.equal(HISTORY_TITLE_MAX, 200);
	});
});

describe("createHistoryModel", () => {
	it("starts idle and empty", () => {
		assert.deepEqual(createHistoryModel().get(), {
			status: "idle",
			items: [],
			error: null,
			truncated: false,
		});
	});

	it("merges a patch and keeps the references it did not touch", () => {
		const model = createHistoryModel();
		const before = model.get();
		model.set({ status: "loading" });
		const after = model.get();
		assert.equal(after.status, "loading");
		assert.equal(after.items, before.items);
	});

	it("notifies nobody when nothing changed", () => {
		const model = createHistoryModel();
		let calls = 0;
		model.subscribe(() => void (calls += 1));
		model.set({});
		model.set({ status: "idle", error: null, truncated: false });
		model.set({ items: model.get().items });
		assert.equal(calls, 0);
		model.set({ items: [] });
		assert.equal(calls, 1, "a new array is a change, even when empty: identity is the test");
	});

	it("select fires only when the selected value changes", () => {
		const model = createHistoryModel();
		const seen: string[] = [];
		model.select(
			(state) => state.status,
			(status) => void seen.push(status),
		);
		model.set({ truncated: true });
		model.set({ status: "loading" });
		model.set({ status: "loading", error: "x" });
		model.set({ status: "ready" });
		assert.deepEqual(seen, ["loading", "ready"]);
	});

	it("select takes an equality function", () => {
		const model = createHistoryModel();
		const seen: number[] = [];
		model.select(
			(state) => state.items.map((entry) => entry.id),
			(ids) => void seen.push(ids.length),
			(a, b) => a.join() === b.join(),
		);
		model.set({ items: [item("a")] });
		model.set({ items: [item("a")] });
		model.set({ items: [item("a"), item("b")] });
		assert.deepEqual(seen, [1, 2]);
	});

	it("unsubscribes", () => {
		const model = createHistoryModel();
		let calls = 0;
		const off = model.subscribe(() => void (calls += 1));
		off();
		model.set({ status: "ready" });
		assert.equal(calls, 0);
	});

	it("logs and skips a listener that throws", () => {
		const model = createHistoryModel();
		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void logged.push(args[0]);
		try {
			let reached = 0;
			model.subscribe(() => {
				throw new Error("boom");
			});
			model.subscribe(() => void (reached += 1));
			model.set({ status: "ready" });
			assert.equal(reached, 1);
			assert.equal(logged.length, 1);
			assert.equal(model.get().status, "ready");
		} finally {
			console.error = original;
		}
	});

	it("lets a listener unsubscribe another during delivery without breaking the pass", () => {
		const model = createHistoryModel();
		let second = 0;
		let off: () => void = () => {};
		model.subscribe(() => off());
		off = model.subscribe(() => void (second += 1));
		model.set({ status: "ready" });
		assert.ok(second <= 1);
		model.set({ status: "loading" });
		assert.ok(second <= 1);
	});
});

describe("toHistoryItem", () => {
	const translate = (source: string): string => `<${source}>`;

	it("maps the row and parses modified in the system zone", () => {
		const result = toHistoryItem(
			{ name: "s1", title: "  Todos  ", modified: "2026-10-02 14:05:09.5" },
			{ translate: identityTranslate, systemTimeZone: "Asia/Kolkata" },
		);
		assert.deepEqual(result, { id: "s1", title: "Todos", modified: Date.UTC(2026, 9, 2, 8, 35, 9, 500) });
	});

	it("names an untitled session through translate", () => {
		for (const title of [null, undefined, "", "   "]) {
			assert.equal(toHistoryItem({ name: "s", title }, { translate }).title, "<Untitled conversation>");
		}
	});

	it("reads an unparseable or missing modified as null", () => {
		assert.equal(toHistoryItem({ name: "s", title: "t", modified: "soon" }, { translate }).modified, null);
		assert.equal(toHistoryItem({ name: "s", title: "t" }, { translate }).modified, null);
		assert.equal(toHistoryItem({ name: "s", title: "t", modified: null }, { translate }).modified, null);
	});
});
