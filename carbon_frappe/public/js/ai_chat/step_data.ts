// How a tool call's arguments and result are shown inside a collapsed step: as markdown,
// because the step body renders them with <cds-aichat-markdown> like everything else.
// Pure, so the unit tests cover the fencing rules without a DOM.

/**
 * `code` in a fenced block whose fence is longer than any backtick run inside it. A
 * fixed three-backtick fence would be closed early by a JSON string holding "```", and
 * the rest of the payload would render as markdown.
 */
export function fenced(code: string, language: string): string {
	let longest = 0;
	for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * The markdown for one side of a step, or undefined when there is nothing to show.
 * Objects and JSON-looking strings are pretty-printed in a `json` fence; any other
 * string is passed through as the text it is (a tool's error message, for one).
 */
export function stepDataMarkdown(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		// only structured JSON gets a fence: "42" or "true" is a sentence, not a payload
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return fenced(JSON.stringify(JSON.parse(trimmed), null, 2), "json");
			} catch {
				// not JSON after all: it is text
			}
		}
		return value;
	}
	if (typeof value === "object") {
		try {
			return fenced(JSON.stringify(value, null, 2), "json");
		} catch {
			// a cycle or a BigInt: nothing sensible to print
			return String(value);
		}
	}
	return String(value);
}
