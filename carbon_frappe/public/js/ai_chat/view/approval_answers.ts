// The DOM-free half of the approval card: what an answer is called, when the set of
// answers is complete, and how a question's text and arguments are split for display.
// Kept apart from approval.ts so the unit tests need no browser.
import type { ChainOfThoughtStep } from "../types.ts";
import type { FlowQuestion } from "../flow/events.ts";
import type { Translate } from "../i18n.ts";
import { normalizeToolName, parseArgs } from "../flow/tool_labels.ts";

/**
 * The wire tokens of a confirmation question's options (flow's `_confirmation_question`).
 * Only their labels are translated; what flow receives, and what its `_has_denial`
 * compares against, is always the English token.
 */
export const APPROVE = "Approve";
export const DENY = "Deny";

/** The questions that can be answered: flow routes an answer by `key`, so a question without one cannot be. */
export function answerable(questions: readonly FlowQuestion[]): (FlowQuestion & { key: string })[] {
	const keyed: (FlowQuestion & { key: string })[] = [];
	for (const question of questions) {
		if (question.key !== null) keyed.push({ ...question, key: question.key });
	}
	return keyed;
}

/** Flow resumes a run only when every pending question is answered in one request. */
export function allAnswered(keys: readonly string[], answers: ReadonlyMap<string, string>): boolean {
	return keys.length > 0 && keys.every((key) => answers.has(key));
}

/**
 * How a recorded answer reads in the card. The two tokens are translated, an option the
 * model authored is shown as it was offered, and anything else was typed by the user.
 */
export function answerLabel(answer: string, options: readonly string[], translate: Translate): string {
	const __ = translate;
	if (answer === APPROVE) return __("Approved");
	if (answer === DENY) return __("Denied");
	if (options.includes(answer)) return answer;
	return __("Redirected: {0}", [answer]);
}

/** A tool confirmation's prompt is "Approve `x`?" then a blank line then the body; the title is the first paragraph. */
export function splitPrompt(prompt: string): { title: string; body: string } {
	const [title = "", ...rest] = prompt.split("\n\n");
	return { title: title.trim(), body: rest.join("\n\n").trim() };
}

/**
 * The arguments to show for a call: `execute` already puts its description in the card's
 * title, so repeating it in the snippet would only make the card taller. `null` when
 * nothing is left to show, so the card omits the snippet.
 */
export function displayArgs(step: ChainOfThoughtStep | undefined): Record<string, unknown> | null {
	if (step === undefined) return null;
	// parseArgs hands back the step's own object, which belongs to the store.
	const args = { ...parseArgs(step.request?.args) };
	if (normalizeToolName(step.tool_name ?? "") === "execute") delete args["description"];
	return Object.keys(args).length === 0 ? null : args;
}

/** The step a question belongs to: its `key` is the tool call id. */
export function stepFor(steps: readonly ChainOfThoughtStep[], key: string): ChainOfThoughtStep | undefined {
	return steps.find((step) => step.tool_call_id === key);
}
