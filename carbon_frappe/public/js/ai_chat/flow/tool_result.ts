// How a tool's serialized result maps onto a chain-of-thought step. Shared by the
// live reducer (reduce.ts) and the history rebuild (history.ts): both must call
// the same classifier, or a conversation would look different the moment it is
// reloaded. Port of `toolError` / `approvalFromResult` in flow's frontend
// lib/toolMeta.js and store.js.

import { isRecord } from "../types.ts";

export interface ToolOutcome {
	status: "success" | "failure";
	/** The result parsed as JSON when it is JSON, else the text. This is `step.response.content`. */
	content: unknown;
	/** The failure message, when `status` is "failure" because the tool errored. */
	error: string | null;
	/** Set when the result is a confirmation tool's denial or redirect payload. */
	approval: "denied" | "redirected" | null;
}

/** JSON.parse a tool result; the text itself when it is not JSON (a plain-text result is normal). */
export function parseToolContent(result: string): unknown {
	try {
		return JSON.parse(result);
	} catch {
		return result;
	}
}

/**
 * The message when a tool call wholly failed, else null. Two failure shapes:
 * a thrown tool, `{error: "..."}` (agent.py `_run_tool`), and a bulk create /
 * update / delete / run_action in which every record failed,
 * `{created|updated|deleted|results: [], failures: [{error}, ...]}` (tools/builtins.py;
 * run_action reports its successes under `results`). A bulk call with at least one
 * success is not a failure.
 */
export function toolError(result: string): string | null {
	return errorOf(parseToolContent(result));
}

function errorOf(parsed: unknown): string | null {
	if (!isRecord(parsed)) return null;
	const error = parsed["error"];
	if (typeof error === "string") return error;

	const failures = parsed["failures"];
	if (!Array.isArray(failures) || failures.length === 0) return null;
	const succeeded = [parsed["created"], parsed["updated"], parsed["deleted"], parsed["results"]].some(
		(list) => Array.isArray(list) && list.length > 0,
	);
	if (succeeded) return null;
	const message = failures
		.map((failure) => (isRecord(failure) ? failure["error"] : undefined))
		.filter((text): text is string => typeof text === "string")
		.join("\n");
	return message || null;
}

/**
 * Failure is an error payload, or a confirmation tool that did not run:
 * `{status: "denied"}` (the user said Deny) or `{status: "redirect"}` (the user
 * typed instructions instead; the tool was not executed either). The status
 * check cannot know the tool needed confirmation, so a regular tool that happens
 * to return `{status: "denied"}` is classified the same way. Flow's panel guards
 * against that with the agent's tool map; this adapter accepts it.
 */
export function classifyToolResult(result: string): ToolOutcome {
	const content = parseToolContent(result);
	const error = errorOf(content);
	const status = isRecord(content) ? content["status"] : undefined;
	const approval = status === "denied" ? "denied" : status === "redirect" ? "redirected" : null;
	return {
		status: error !== null || approval !== null ? "failure" : "success",
		content,
		error,
		approval,
	};
}
