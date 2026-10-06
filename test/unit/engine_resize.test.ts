import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isColumnResize } from "../../carbon_frappe/public/js/tables/engine/table.ts";

// `onColumnResize` is emitted through the engine's open `emit(name, ...args)`, so
// a handler receives `unknown`. This guard is how the Grid and the List view
// prove the payload instead of casting it; the browser suites cover the drag that
// produces it.
describe("isColumnResize", () => {
	it("accepts the payload the engine emits", () => {
		assert.equal(isColumnResize({ columnId: "qty", width: 150 }), true);
	});
	it("accepts a payload that carries more than it needs", () => {
		assert.equal(isColumnResize({ columnId: "qty", width: 150, extra: true }), true);
	});
	it("refuses a missing or mistyped member", () => {
		assert.equal(isColumnResize({ columnId: "qty" }), false);
		assert.equal(isColumnResize({ width: 150 }), false);
		assert.equal(isColumnResize({ columnId: 3, width: 150 }), false);
		assert.equal(isColumnResize({ columnId: "qty", width: "150" }), false);
	});
	it("refuses a value that is not an object", () => {
		assert.equal(isColumnResize(null), false);
		assert.equal(isColumnResize(undefined), false);
		assert.equal(isColumnResize("qty"), false);
		assert.equal(isColumnResize(150), false);
	});
});
