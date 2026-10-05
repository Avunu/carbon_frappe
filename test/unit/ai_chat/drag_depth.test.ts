import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDragDepth } from "../../../carbon_frappe/public/js/ai_chat/drag_depth.ts";

describe("createDragDepth", () => {
	it("starts a drag on the first enter only", () => {
		const depth = createDragDepth();
		assert.equal(depth.enter(), true);
		assert.equal(depth.enter(), false);
		assert.equal(depth.depth, 2);
	});

	it("survives the enter-before-leave order of crossing into a child", () => {
		const depth = createDragDepth();
		depth.enter();
		// the child's enter arrives first, then the parent's leave: still inside
		assert.equal(depth.enter(), false);
		assert.equal(depth.leave(), false);
		assert.equal(depth.depth, 1);
		assert.equal(depth.leave(), true);
		assert.equal(depth.depth, 0);
	});

	it("ignores a leave with nothing entered and never goes negative", () => {
		const depth = createDragDepth();
		assert.equal(depth.leave(), false);
		assert.equal(depth.depth, 0);
		assert.equal(depth.enter(), true);
	});

	it("reset reports whether a drag was in progress and starts over", () => {
		const depth = createDragDepth();
		assert.equal(depth.reset(), false);
		depth.enter();
		depth.enter();
		assert.equal(depth.reset(), true);
		assert.equal(depth.depth, 0);
		assert.equal(depth.enter(), true);
	});
});
