import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	approvalTitle,
	humanize,
	identityTranslate,
	normalizeToolName,
	parseArgs,
	toolContext,
	toolLabel,
	toolStepTitle,
} from "../../../carbon_frappe/public/js/ai_chat/flow/tool_labels.ts";
import type { Translate } from "../../../carbon_frappe/public/js/ai_chat/flow/tool_labels.ts";

const upper: Translate = (source, replace) => identityTranslate(source, replace).toUpperCase();

describe("parseArgs", () => {
	it("returns a plain object as is", () => {
		const args = { doctype: "ToDo" };
		assert.equal(parseArgs(args), args);
	});
	it("parses a JSON object string", () => {
		assert.deepEqual(parseArgs('{"doctype": "ToDo", "limit": 5}'), { doctype: "ToDo", limit: 5 });
	});
	it("yields {} for malformed or truncated JSON", () => {
		assert.deepEqual(parseArgs('{"doctype": "To'), {});
		assert.deepEqual(parseArgs("not json"), {});
		assert.deepEqual(parseArgs(""), {});
	});
	it("yields {} for JSON that is not an object", () => {
		assert.deepEqual(parseArgs("[1, 2]"), {});
		assert.deepEqual(parseArgs("42"), {});
		assert.deepEqual(parseArgs('"text"'), {});
		assert.deepEqual(parseArgs("null"), {});
	});
	it("yields {} for arrays, null, undefined and numbers", () => {
		assert.deepEqual(parseArgs([1]), {});
		assert.deepEqual(parseArgs(null), {});
		assert.deepEqual(parseArgs(undefined), {});
		assert.deepEqual(parseArgs(7), {});
	});
});

describe("humanize", () => {
	it("turns underscores into spaces and upper-cases only the first character", () => {
		assert.equal(humanize("snake_case"), "Snake case");
		assert.equal(humanize("get_all_docs"), "Get all docs");
		assert.equal(humanize("DocType"), "DocType");
		assert.equal(humanize("a"), "A");
	});
	it("yields an empty string for empty and non-string input", () => {
		assert.equal(humanize(""), "");
		assert.equal(humanize(null), "");
		assert.equal(humanize(undefined), "");
		assert.equal(humanize(5), "");
	});
});

describe("normalizeToolName", () => {
	it("strips a leaked model special token", () => {
		assert.equal(normalizeToolName("describe<|channel|>commentary"), "describe");
		assert.equal(normalizeToolName("read<|"), "read");
	});
	it("trims whitespace", () => {
		assert.equal(normalizeToolName("  read  "), "read");
		assert.equal(normalizeToolName("read <|channel|>"), "read");
	});
	it("falls back to the trimmed input when nothing precedes the token", () => {
		assert.equal(normalizeToolName("<|channel|>commentary"), "<|channel|>commentary");
		assert.equal(normalizeToolName("  <|x|> "), "<|x|>");
		assert.equal(normalizeToolName(""), "");
	});
});

describe("toolLabel", () => {
	const labels: [string, string][] = [
		["find_doctypes", "Finding relevant DocTypes"],
		["describe", "Reading DocType Meta"],
		["read", "Reading DocType Records"],
		["search_knowledge", "Searching Knowledge"],
		["execute", "Executing"],
		["create", "Creating Records"],
		["update", "Updating Records"],
		["delete", "Deleting Records"],
		["run_action", "Running Document Actions"],
	];
	for (const [name, label] of labels) {
		it(`labels ${name}`, () => {
			assert.equal(toolLabel(name), label);
		});
	}
	it("humanizes an unknown tool name", () => {
		assert.equal(toolLabel("send_email"), "Send email");
		assert.equal(toolLabel("custom"), "Custom");
	});
	it("does not mistake an Object.prototype key for a builtin", () => {
		assert.equal(toolLabel("constructor"), "Constructor");
		assert.equal(toolLabel("toString"), "ToString");
	});
	it("applies the injected translate to builtins but not to the humanized fallback", () => {
		assert.equal(toolLabel("read", upper), "READING DOCTYPE RECORDS");
		assert.equal(toolLabel("run_action", upper), "RUNNING DOCUMENT ACTIONS");
		assert.equal(toolLabel("send_email", upper), "Send email");
	});
	it("does not normalize the name itself", () => {
		assert.equal(toolLabel("describe<|channel|>commentary"), "Describe<|channel|>commentary");
	});
});

describe("identityTranslate", () => {
	it("returns the source untouched without replacements", () => {
		assert.equal(identityTranslate("Create {0} records"), "Create {0} records");
	});
	it("substitutes numbered placeholders, repeats and out-of-order use", () => {
		assert.equal(identityTranslate("{1} then {0}", ["a", "b"]), "b then a");
		assert.equal(identityTranslate("{0}{0}", ["x"]), "xx");
	});
	it("substitutes {} in order, on an index of its own", () => {
		assert.equal(identityTranslate("{} and {}", ["a", "b"]), "a and b");
		assert.equal(identityTranslate("{1} {} {}", ["a", "b"]), "b a b");
	});
	it("ignores extra arguments and leaves a placeholder with no argument in place", () => {
		assert.equal(identityTranslate("Hi {0}", ["a", "b", "c"]), "Hi a");
		assert.equal(identityTranslate("Hi {0} {1}", ["a"]), "Hi a {1}");
		assert.equal(identityTranslate("Hi {name}", ["a"]), "Hi {name}");
	});
	it("does not re-scan substituted text", () => {
		assert.equal(identityTranslate("{0} {1}", ["{1}", "b"]), "{1} b");
	});
});

describe("toolContext", () => {
	it("prefers doctype over search over action", () => {
		assert.equal(toolContext({ doctype: "ToDo", search: "x", action: "submit" }), "ToDo");
		assert.equal(toolContext({ search: "invoices", action: "submit" }), "invoices");
		assert.equal(toolContext({ action: "submit" }), "Submit");
	});
	it("humanizes only the action", () => {
		assert.equal(toolContext({ action: "mark_as_paid" }), "Mark as paid");
		assert.equal(toolContext({ doctype: "Sales_Order" }), "Sales_Order");
	});
	it("skips empty and non-string values", () => {
		assert.equal(toolContext({ doctype: "", search: "found" }), "found");
		assert.equal(toolContext({ doctype: 5, search: ["x"], action: "go" }), "Go");
		assert.equal(toolContext({ doctype: "", search: "", action: "" }), null);
	});
	it("reads JSON strings and tolerates garbage", () => {
		assert.equal(toolContext('{"doctype":"ToDo"}'), "ToDo");
		assert.equal(toolContext("{oops"), null);
		assert.equal(toolContext(null), null);
		assert.equal(toolContext({}), null);
	});
});

describe("toolStepTitle", () => {
	it("appends the context to the label", () => {
		assert.equal(toolStepTitle("read", { doctype: "ToDo" }), "Reading DocType Records: ToDo");
		assert.equal(toolStepTitle("run_action", { action: "submit" }), "Running Document Actions: Submit");
		assert.equal(
			toolStepTitle("search_knowledge", { search: "returns policy" }),
			"Searching Knowledge: returns policy",
		);
	});
	it("is the bare label when there is no context", () => {
		assert.equal(toolStepTitle("read", {}), "Reading DocType Records");
		assert.equal(toolStepTitle("read", undefined), "Reading DocType Records");
	});
	it("accepts arguments as a JSON string", () => {
		assert.equal(toolStepTitle("describe", '{"doctype": "Customer"}'), "Reading DocType Meta: Customer");
	});
	it("normalizes a token-polluted name before labelling", () => {
		assert.equal(
			toolStepTitle("describe<|channel|>commentary", { doctype: "ToDo" }),
			"Reading DocType Meta: ToDo",
		);
	});
	it("humanizes an unknown tool and still adds the context", () => {
		assert.equal(toolStepTitle("send_email", {}), "Send email");
		assert.equal(toolStepTitle("send_email", { doctype: "Email" }), "Send email: Email");
	});
	it("translates the label but not the context", () => {
		assert.equal(toolStepTitle("read", { doctype: "ToDo" }, upper), "READING DOCTYPE RECORDS: ToDo");
	});
});

describe("approvalTitle", () => {
	it("create: singular for one or no records", () => {
		assert.deepEqual(approvalTitle("create", { doctype: "ToDo", records: [{ a: 1 }] }), {
			title: "Create 1 ToDo record",
			danger: false,
		});
		assert.deepEqual(approvalTitle("create", { doctype: "ToDo", records: [] }), {
			title: "Create 1 ToDo record",
			danger: false,
		});
	});
	it("create: plural counts the records, count first and doctype second", () => {
		assert.deepEqual(approvalTitle("create", { doctype: "ToDo", records: [{}, {}, {}] }), {
			title: "Create 3 ToDo records",
			danger: false,
		});
	});
	it("create without records is a single record", () => {
		assert.equal(approvalTitle("create", { doctype: "Note" }).title, "Create 1 Note record");
	});
	it("update counts names", () => {
		assert.deepEqual(approvalTitle("update", { doctype: "ToDo", names: ["A", "B"] }), {
			title: "Update 2 ToDo records",
			danger: false,
		});
		assert.equal(approvalTitle("update", { doctype: "ToDo", names: ["A"] }).title, "Update 1 ToDo record");
	});
	it("delete is dangerous and counts names", () => {
		assert.deepEqual(approvalTitle("delete", { doctype: "ToDo", names: ["A", "B", "C"] }), {
			title: "Delete 3 ToDo records",
			danger: true,
		});
		assert.deepEqual(approvalTitle("delete", { doctype: "ToDo", names: ["A"] }), {
			title: "Delete 1 ToDo record",
			danger: true,
		});
	});
	it("delete without a doctype falls back to the label but stays dangerous", () => {
		assert.deepEqual(approvalTitle("delete", {}), { title: "Deleting Records", danger: true });
		assert.deepEqual(approvalTitle("delete", "garbage"), { title: "Deleting Records", danger: true });
	});
	it("run_action names the action and the target count", () => {
		assert.deepEqual(
			approvalTitle("run_action", { action: "submit", doctype: "Sales Order", names: ["A", "B"] }),
			{
				title: 'Run "Submit" on 2 Sales Order',
				danger: false,
			},
		);
		assert.equal(
			approvalTitle("run_action", { action: "mark_as_paid", doctype: "Invoice" }).title,
			'Run "Mark as paid" on 1 Invoice',
		);
	});
	it("run_action without a doctype says records", () => {
		assert.equal(approvalTitle("run_action", { action: "cancel" }).title, 'Run "Cancel" on records');
	});
	it("run_action without an action falls back to the label", () => {
		assert.equal(approvalTitle("run_action", { doctype: "ToDo" }).title, "Running Document Actions");
		assert.equal(approvalTitle("run_action", { action: "" }).title, "Running Document Actions");
	});
	it("execute shows its trimmed description", () => {
		assert.equal(
			approvalTitle("execute", { description: "  Recalculate totals  " }).title,
			"Recalculate totals",
		);
	});
	it("execute falls back to a generic line without a usable description", () => {
		assert.equal(approvalTitle("execute", { description: "   " }).title, "Run Python code");
		assert.equal(approvalTitle("execute", { description: 5 }).title, "Run Python code");
		assert.equal(approvalTitle("execute", {}).title, "Run Python code");
		assert.equal(approvalTitle("execute", undefined).title, "Run Python code");
	});
	it("an unknown tool gets its humanized name", () => {
		assert.deepEqual(approvalTitle("send_email", { doctype: "Email" }), {
			title: "Send email",
			danger: false,
		});
	});
	it("create or update without a doctype falls back to the label", () => {
		assert.equal(approvalTitle("create", { records: [{}] }).title, "Creating Records");
		assert.equal(approvalTitle("create", { doctype: 5 }).title, "Creating Records");
		assert.equal(approvalTitle("update", {}).title, "Updating Records");
	});
	it("normalizes a token-polluted name, including for danger", () => {
		assert.deepEqual(approvalTitle("delete<|channel|>commentary", { doctype: "ToDo", names: ["A", "B"] }), {
			title: "Delete 2 ToDo records",
			danger: true,
		});
	});
	it("reads arguments from a JSON string", () => {
		assert.equal(
			approvalTitle("create", '{"doctype": "ToDo", "records": [{}, {}]}').title,
			"Create 2 ToDo records",
		);
	});
	it("translates the templates and fallbacks with the injected function", () => {
		assert.equal(
			approvalTitle("create", { doctype: "ToDo", records: [{}, {}] }, upper).title,
			"CREATE 2 TODO RECORDS",
		);
		assert.equal(approvalTitle("create", { doctype: "ToDo" }, upper).title, "CREATE 1 TODO RECORD");
		assert.equal(approvalTitle("run_action", { action: "submit" }, upper).title, 'RUN "SUBMIT" ON RECORDS');
		assert.equal(approvalTitle("execute", {}, upper).title, "RUN PYTHON CODE");
		assert.equal(approvalTitle("update", {}, upper).title, "UPDATING RECORDS");
	});
});
