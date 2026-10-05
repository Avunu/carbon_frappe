// Tool name and argument labels for the chain-of-thought steps and approval cards.
// A port of flow's frontend/src/lib/toolMeta.js, minus the value-shape helpers
// (argKind, recordLabelKey, ...) that only flow's own Vue views use.
//
// The module stays pure: no `frappe`, no `__` global. Callers pass the real `__`
// (assignable to `Translate`). The parameter is named `__` inside each function
// anyway, because Frappe's string extractor greps for `__("...")` and would miss
// the literals if they were passed to a function called `translate`.

import { isRecord } from "../types.ts";

export type Translate = (source: string, replace?: readonly string[]) => string;

/**
 * Substitutes `{0}`, `{1}`, ... and `{}` (a running index of its own, separate from
 * the numbered ones) the way frappe's `$.format` does. A placeholder with no
 * matching argument is left in place; frappe would print "undefined" there.
 */
export function identityTranslate(source: string, replace?: readonly string[]): string {
	if (!replace) return source;
	let unkeyed = 0;
	return source.replace(/\{(\w*)\}/g, (match, key: string) => {
		let index: number;
		if (key === "") {
			index = unkeyed;
			unkeyed += 1;
		} else if (/^\d+$/.test(key)) {
			index = Number(key);
		} else {
			return match;
		}
		return replace[index] ?? match;
	});
}

/** The arguments of a tool call as an object; the wire sends an object, the session doc a JSON string. */
export function parseArgs(args: unknown): Record<string, unknown> {
	if (isRecord(args)) return args;
	if (typeof args !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(args);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** `snake_case` to `Snake case`. Only the first character is touched, so `DocType` stays as is. */
export function humanize(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

/**
 * Strips leaked model special tokens (`describe<|channel|>commentary`) so labels
 * and approval lookups see the real tool name.
 */
export function normalizeToolName(name: string): string {
	const clean = (name.split("<|")[0] ?? "").trim();
	return clean || name.trim();
}

/** Present-tense label per builtin; a custom tool's name is data, so it is humanized, not translated. */
export function toolLabel(name: string, __: Translate = identityTranslate): string {
	switch (name) {
		case "find_doctypes":
			return __("Finding relevant DocTypes");
		case "describe":
			return __("Reading DocType Meta");
		case "read":
			return __("Reading DocType Records");
		case "search_knowledge":
			return __("Searching Knowledge");
		case "execute":
			return __("Executing");
		case "create":
			return __("Creating Records");
		case "update":
			return __("Updating Records");
		case "delete":
			return __("Deleting Records");
		case "run_action":
			return __("Running Document Actions");
		default:
			return humanize(name);
	}
}

/** The suffix that tells two steps of the same tool apart: which doctype, search or action. */
export function toolContext(args: unknown): string | null {
	const parsed = parseArgs(args);
	for (const key of ["doctype", "search", "action"]) {
		const value = parsed[key];
		if (typeof value === "string" && value !== "") return key === "action" ? humanize(value) : value;
	}
	return null;
}

export function toolStepTitle(name: string, args: unknown, __: Translate = identityTranslate): string {
	const label = toolLabel(normalizeToolName(name), __);
	const context = toolContext(args);
	return context === null ? label : `${label}: ${context}`;
}

function count(value: unknown): number {
	return Array.isArray(value) && value.length > 0 ? value.length : 1;
}

/**
 * What an approval card asks the user to approve, derived from the call's own
 * arguments (flow's `confirmTitle`). `danger` follows the tool alone: a delete
 * with unreadable arguments is still a delete.
 */
export function approvalTitle(
	name: string,
	args: unknown,
	__: Translate = identityTranslate,
): { title: string; danger: boolean } {
	const tool = normalizeToolName(name);
	const parsed = parseArgs(args);
	const doctype = typeof parsed["doctype"] === "string" ? parsed["doctype"] : "";
	const action = parsed["action"];
	const description = parsed["description"];
	// The singular/plural pair is spelled out per tool, with literals at the `__` call,
	// so the extractor sees every catalog string.
	let title = "";
	if (tool === "create" && doctype) {
		const n = count(parsed["records"]);
		title =
			n === 1 ? __("Create 1 {0} record", [doctype]) : __("Create {0} {1} records", [String(n), doctype]);
	} else if (tool === "update" && doctype) {
		const n = count(parsed["names"]);
		title =
			n === 1 ? __("Update 1 {0} record", [doctype]) : __("Update {0} {1} records", [String(n), doctype]);
	} else if (tool === "delete" && doctype) {
		const n = count(parsed["names"]);
		title =
			n === 1 ? __("Delete 1 {0} record", [doctype]) : __("Delete {0} {1} records", [String(n), doctype]);
	} else if (tool === "run_action" && typeof action === "string" && action) {
		const target = doctype ? `${count(parsed["names"])} ${doctype}` : __("records");
		title = __('Run "{0}" on {1}', [humanize(action), target]);
	} else if (tool === "execute") {
		title = (typeof description === "string" && description.trim()) || __("Run Python code");
	}
	return { title: title || toolLabel(tool, __), danger: tool === "delete" };
}
