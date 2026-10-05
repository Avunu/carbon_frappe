import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyToolResult, toolError } from "../../../carbon_frappe/public/js/ai_chat/flow/tool_result.ts";

// Shapes from flow's tools/builtins.py: run_action reports successes under `results`
// (create/update/delete use created/updated/deleted) and omits `failures` when empty.
const runAction = (results: unknown[], failures: unknown[]) =>
	JSON.stringify({ action: "submit", results, ...(failures.length ? { failures } : {}) });
const ok = { name: "SO-1", result: { name: "SO-1", docstatus: 1 } };
const failed = { name: "SO-3", error: "Cannot submit" };

describe("run_action bulk results", () => {
	it("a partial success is not a failure", () => {
		const partial = runAction([ok], [failed]);
		assert.equal(toolError(partial), null);
		const outcome = classifyToolResult(partial);
		assert.equal(outcome.status, "success");
		assert.equal(outcome.error, null);
	});
	it("every name failing is a failure carrying the failures' text", () => {
		const outcome = classifyToolResult(runAction([], [failed, { name: "SO-4", error: "Locked" }]));
		assert.equal(outcome.status, "failure");
		assert.equal(outcome.error, "Cannot submit\nLocked");
	});
	it("all names succeeding is a success", () => {
		assert.equal(classifyToolResult(runAction([ok], [])).status, "success");
	});
});
