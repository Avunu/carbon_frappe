import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	APPROVE,
	DENY,
	allAnswered,
	answerLabel,
	answerable,
	displayArgs,
	splitPrompt,
	stepFor,
} from "../../../carbon_frappe/public/js/ai_chat/view/approval_answers.ts";
import { identityTranslate } from "../../../carbon_frappe/public/js/ai_chat/flow/tool_labels.ts";
import type { Translate } from "../../../carbon_frappe/public/js/ai_chat/flow/tool_labels.ts";
import type { FlowQuestion } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import type { ChainOfThoughtStep } from "../../../carbon_frappe/public/js/ai_chat/types.ts";

const upper: Translate = (source, replace) => identityTranslate(source, replace).toUpperCase();

function question(key: string | null, options: string[] = [APPROVE, DENY]): FlowQuestion {
	return { prompt: "Approve `create`?", options, multi_select: false, allow_other: true, key };
}

describe("answerable", () => {
	it("keeps the questions flow can route and drops those without a key", () => {
		const kept = answerable([question("a"), question(null), question("b")]);
		assert.deepEqual(
			kept.map((entry) => entry.key),
			["a", "b"],
		);
	});
});

describe("allAnswered", () => {
	it("needs every key answered, in any order", () => {
		const answers = new Map([["b", DENY]]);
		assert.equal(allAnswered(["a", "b"], answers), false);
		answers.set("a", APPROVE);
		assert.equal(allAnswered(["a", "b"], answers), true);
	});
	it("is false for no questions, so an empty card never submits", () => {
		assert.equal(allAnswered([], new Map()), false);
	});
});

describe("answerLabel", () => {
	it("translates the two wire tokens", () => {
		assert.equal(answerLabel(APPROVE, [APPROVE, DENY], upper), "APPROVED");
		assert.equal(answerLabel(DENY, [APPROVE, DENY], upper), "DENIED");
	});
	it("shows an option the model offered as written", () => {
		assert.equal(answerLabel("Blue team", ["Blue team", "Red team"], upper), "Blue team");
	});
	it("labels anything else as the user's redirect", () => {
		assert.equal(
			answerLabel("use a note instead", [APPROVE, DENY], identityTranslate),
			"Redirected: use a note instead",
		);
	});
	it("does not run placeholders inside the typed text", () => {
		assert.equal(answerLabel("{0}", [APPROVE], identityTranslate), "Redirected: {0}");
	});
});

describe("splitPrompt", () => {
	it("takes the first paragraph as the title and keeps the rest", () => {
		assert.deepEqual(splitPrompt("Approve `execute`?\n\nprint(1)\n\nmore"), {
			title: "Approve `execute`?",
			body: "print(1)\n\nmore",
		});
	});
	it("has no body for a single paragraph", () => {
		assert.deepEqual(splitPrompt("Which team?"), { title: "Which team?", body: "" });
	});
});

describe("displayArgs", () => {
	const step = (tool_name: string, args: unknown): ChainOfThoughtStep => ({
		tool_name,
		tool_call_id: "c1",
		request: { args },
	});

	it("is null with no step or no arguments", () => {
		assert.equal(displayArgs(undefined), null);
		assert.equal(displayArgs(step("create", {})), null);
		assert.equal(displayArgs(step("create", "garbage")), null);
	});
	it("parses a JSON string the session doc stores", () => {
		assert.deepEqual(displayArgs(step("create", '{"doctype":"ToDo"}')), { doctype: "ToDo" });
	});
	it("drops execute's description, which the title already shows, without touching the step", () => {
		const original = { description: "Count todos", code: "print(1)" };
		assert.deepEqual(displayArgs(step("execute", original)), { code: "print(1)" });
		assert.deepEqual(original, { description: "Count todos", code: "print(1)" });
	});
	it("keeps a description argument of other tools", () => {
		assert.deepEqual(displayArgs(step("create", { description: "x" })), { description: "x" });
	});
	it("is null when the description was all there was", () => {
		assert.equal(displayArgs(step("execute", { description: "Count" })), null);
	});
});

describe("stepFor", () => {
	it("matches the step whose tool call id is the question key", () => {
		const steps: ChainOfThoughtStep[] = [{ tool_call_id: "a" }, { tool_call_id: "b", tool_name: "create" }];
		assert.equal(stepFor(steps, "b")?.tool_name, "create");
		assert.equal(stepFor(steps, "z"), undefined);
	});
});
