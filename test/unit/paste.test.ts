import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./globals.ts";
import {
	coerceForPaste,
	parseClipboard,
	planFill,
} from "../../carbon_frappe/public/js/tables/datatable/paste.ts";
import type { DocField } from "frappe-types";

const df = (fieldtype: DocField["fieldtype"], options?: string): DocField =>
	options === undefined ? { fieldname: "f", fieldtype } : { fieldname: "f", fieldtype, options };

describe("parseClipboard", () => {
	it("splits rows on any newline and cells on tabs", () => {
		assert.deepEqual(parseClipboard("a\tb\r\nc\td"), [
			["a", "b"],
			["c", "d"],
		]);
	});
	it("drops the one trailing newline Excel appends, and only that one", () => {
		assert.deepEqual(parseClipboard("a\n"), [["a"]]);
		assert.deepEqual(parseClipboard("a\n\n"), [["a"], [""]]);
	});
	it("keeps a single value as a 1x1 block", () => {
		assert.deepEqual(parseClipboard("x"), [["x"]]);
	});
});

describe("coerceForPaste", () => {
	it("reads Check words and refuses the rest", () => {
		for (const w of ["1", "true", "YES", "y", "✓", "x"]) assert.equal(coerceForPaste(df("Check"), w), 1);
		for (const w of ["0", "false", "No", "n", ""]) assert.equal(coerceForPaste(df("Check"), w), 0);
		assert.equal(coerceForPaste(df("Check"), "maybe"), undefined);
	});
	it("parses numbers in the user's number format and refuses garbage", () => {
		assert.equal(coerceForPaste(df("Float"), "1,234.50"), 1234.5);
		assert.equal(coerceForPaste(df("Currency"), "$ 1,234.50"), 1234.5);
		assert.equal(coerceForPaste(df("Percent"), "12.5%"), 12.5);
		assert.equal(coerceForPaste(df("Int"), "3.0"), 3);
		assert.equal(coerceForPaste(df("Int"), "3.5"), undefined);
		assert.equal(coerceForPaste(df("Float"), "twelve"), undefined);
		assert.equal(coerceForPaste(df("Float"), ""), 0);
		assert.equal(coerceForPaste(df("Duration"), "-5"), undefined);
		assert.equal(coerceForPaste(df("Rating"), "1.5"), undefined);
	});
	it("accepts dates in the system format and in the user's, refusing the rest", () => {
		assert.equal(coerceForPaste(df("Date"), "2026-09-16"), "2026-09-16");
		assert.equal(coerceForPaste(df("Date"), "16-09-2026"), "2026-09-16");
		assert.equal(coerceForPaste(df("Date"), "yesterday"), undefined);
		assert.equal(coerceForPaste(df("Datetime"), "2026-09-16"), "2026-09-16 00:00:00");
		assert.equal(coerceForPaste(df("Datetime"), "16-09-2026 10:00:00"), "2026-09-16 10:00:00");
		assert.equal(coerceForPaste(df("Time"), "9:05"), "09:05:00");
		assert.equal(coerceForPaste(df("Date"), ""), "");
	});
	it("matches a Select option exactly, then case-insensitively to the canonical spelling", () => {
		const select = df("Select", "Light\nDark\nAutomatic");
		assert.equal(coerceForPaste(select, "Dark"), "Dark");
		assert.equal(coerceForPaste(select, "dark"), "Dark");
		assert.equal(coerceForPaste(select, "Nope"), undefined);
		assert.equal(coerceForPaste(select, ""), "");
	});
	it("passes text through for Data/Link/Text and refuses the dialog and upload types", () => {
		assert.equal(coerceForPaste(df("Data"), " x "), "x");
		assert.equal(coerceForPaste(df("Link"), "Does Not Exist"), "Does Not Exist");
		assert.equal(coerceForPaste(df("Small Text"), "two\nlines"), "two\nlines");
		for (const t of ["Table", "Attach", "Text Editor", "Password", "Section Break"] as const) {
			assert.equal(coerceForPaste(df(t), "x"), undefined, t);
		}
	});
	it("validates a Color", () => {
		assert.equal(coerceForPaste(df("Color"), "#0f62fe"), "#0f62fe");
		assert.equal(coerceForPaste(df("Color"), "blue"), undefined);
	});
});

describe("planFill", () => {
	// three data rows shown in reverse order; columns 0-1 are the injected
	// checkbox/index gutters, 2-4 focusable
	const view = { viewOrder: [2, 1, 0], focusableColumns: [2, 3, 4] };

	it("fills a range with a single value", () => {
		const { targets, rect } = planFill(view, [["v"]], { c1: 3, c2: 4, p1: 0, p2: 1 });
		assert.deepEqual(
			targets.map((t) => [t.colIndex, t.rowIndex, t.text]),
			[
				[3, 2, "v"],
				[4, 2, "v"],
				[3, 1, "v"],
				[4, 1, "v"],
			],
		);
		assert.deepEqual(rect, { c1: 3, c2: 4, p1: 0, p2: 1 });
	});
	it("lays a block from the anchor, past the selection, clipped to the grid", () => {
		const block = [
			["a", "b", "c"],
			["d", "e", "f"],
			["g", "h", "i"],
			["j", "k", "l"],
		];
		const { targets, rect } = planFill(view, block, { c1: 3, c2: 3, p1: 1, p2: 1 });
		// columns 3,4 only (5 does not exist); rows at positions 1,2 only (3 does not)
		assert.deepEqual(
			targets.map((t) => [t.colIndex, t.rowIndex, t.text]),
			[
				[3, 1, "a"],
				[4, 1, "b"],
				[3, 0, "d"],
				[4, 0, "e"],
			],
		);
		assert.deepEqual(rect, { c1: 3, c2: 4, p1: 1, p2: 2 });
	});
	it("maps columns 1:1 across focusable columns from the anchor", () => {
		const { targets } = planFill(view, [["a", "b"]], { c1: 2, c2: 2, p1: 0, p2: 0 });
		assert.deepEqual(
			targets.map((t) => t.colIndex),
			[2, 3],
		);
	});
	it("plans nothing when the anchor is not a focusable column", () => {
		assert.deepEqual(planFill(view, [["a"]], { c1: 0, c2: 0, p1: 0, p2: 0 }).targets, []);
	});
});
