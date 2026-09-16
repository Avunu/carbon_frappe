import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./globals.ts";
import { isCurrentHref } from "../../carbon_frappe/public/js/anatomy/shell/model.ts";

function at(pathname: string): void {
	location.pathname = pathname;
}

describe("isCurrentHref (sidebar.js:424-433)", () => {
	it("matches the exact path and a slash-terminated prefix, ignoring query and hash", () => {
		at("/desk/projects/task");
		assert.equal(isCurrentHref("/desk/projects/task"), true);
		assert.equal(isCurrentHref("/desk/projects/task?x=1#top"), true);
		assert.equal(isCurrentHref("/desk/projects/"), true);
		assert.equal(isCurrentHref("/desk/projects"), true);
	});
	it("does not match a sibling that merely shares a prefix string", () => {
		at("/desk/projects-x");
		assert.equal(isCurrentHref("/desk/projects"), false);
	});
	it("never matches an empty or fragment-only href", () => {
		at("/desk");
		assert.equal(isCurrentHref(""), false);
		assert.equal(isCurrentHref("#"), false);
	});
	it("decodes percent-encoded paths before comparing", () => {
		at("/app/sales-order/SO%2F001");
		assert.equal(isCurrentHref("/app/sales-order/SO/001"), true);
	});
});
