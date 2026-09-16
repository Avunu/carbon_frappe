import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./globals.ts";
import { guessFilter } from "../../carbon_frappe/public/js/tables/engine/features.ts";

describe("guessFilter (frappe-datatable's inline-filter grammar)", () => {
	it("reads the comparison prefixes", () => {
		assert.deepEqual(guessFilter(">5"), { type: "greaterThan", text: "5" });
		assert.deepEqual(guessFilter("< 5"), { type: "lessThan", text: "5" });
		assert.deepEqual(guessFilter("=5"), { type: "equals", text: 5 });
	});
	it("reads a numeric range", () => {
		assert.deepEqual(guessFilter("5:10"), { type: "range", text: ["5", "10"] });
	});
	it("treats a bare number as containsNumber and text as a lower-cased substring", () => {
		assert.deepEqual(guessFilter("42"), { type: "containsNumber", text: "42" });
		assert.deepEqual(guessFilter("Foo"), { type: "contains", text: "foo" });
	});
	it("keeps upstream's quirk: `!=5` is containsNumber, never notEquals", () => {
		assert.deepEqual(guessFilter("!=5"), { type: "containsNumber", text: "5" });
	});
	it("returns null for nothing", () => {
		assert.equal(guessFilter(""), null);
		assert.equal(guessFilter(), null);
	});
});
