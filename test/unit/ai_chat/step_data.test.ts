import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fenced, stepDataMarkdown } from "../../../carbon_frappe/public/js/ai_chat/step_data.ts";

describe("fenced", () => {
	it("wraps code in a three-backtick fence with the language", () => {
		assert.equal(fenced("{}", "json"), "```json\n{}\n```");
	});

	it("lengthens the fence past the longest backtick run inside", () => {
		assert.equal(fenced("a ``` b", "json"), "````json\na ``` b\n````");
		assert.equal(fenced("`` and ````` here", "text"), "``````text\n`` and ````` here\n``````");
	});

	it("keeps three backticks when the code holds only shorter runs", () => {
		assert.equal(fenced("`a` ``b``", "json"), "```json\n`a` ``b``\n```");
	});
});

describe("stepDataMarkdown", () => {
	it("is undefined for nothing to show", () => {
		assert.equal(stepDataMarkdown(undefined), undefined);
		assert.equal(stepDataMarkdown(null), undefined);
		assert.equal(stepDataMarkdown(""), undefined);
	});

	it("pretty-prints an object in a json fence", () => {
		assert.equal(
			stepDataMarkdown({ doctype: "ToDo", limit: 3 }),
			'```json\n{\n  "doctype": "ToDo",\n  "limit": 3\n}\n```',
		);
	});

	it("pretty-prints an array, including an empty one", () => {
		assert.equal(stepDataMarkdown([]), "```json\n[]\n```");
	});

	it("re-formats a string that holds a JSON object or array", () => {
		assert.equal(stepDataMarkdown('{"a":1}'), '```json\n{\n  "a": 1\n}\n```');
		assert.equal(stepDataMarkdown('  ["x"] '), '```json\n[\n  "x"\n]\n```');
	});

	it("shows a string that is not JSON as it is", () => {
		assert.equal(stepDataMarkdown("Permission denied for ToDo"), "Permission denied for ToDo");
		assert.equal(stepDataMarkdown("{not json"), "{not json");
	});

	it("shows a primitive-looking string as text, not as a payload", () => {
		assert.equal(stepDataMarkdown("42"), "42");
		assert.equal(stepDataMarkdown("true"), "true");
	});

	it("stringifies other primitives", () => {
		assert.equal(stepDataMarkdown(0), "0");
		assert.equal(stepDataMarkdown(false), "false");
	});

	it("survives a value JSON cannot print", () => {
		const cycle: Record<string, unknown> = {};
		cycle["self"] = cycle;
		assert.equal(stepDataMarkdown(cycle), "[object Object]");
	});

	it("fences a payload whose strings contain backticks without breaking out", () => {
		const text = stepDataMarkdown({ code: "```py\nx\n```" });
		assert.ok(text?.startsWith("````json\n"));
		assert.ok(text?.endsWith("\n````"));
	});
});
