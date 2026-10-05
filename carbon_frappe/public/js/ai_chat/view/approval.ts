// The approval card for a paused Flow Run: one block per pending question, each with
// the action in plain words, its arguments, and the answers flow offered.
//
// Markup:
//
//   div.cf-ai-approval[role=group][aria-label][data-run]  .cf-ai-approval--locked once answered
//     div.cf-ai-approval__question[data-key]  .cf-ai-approval__question--answered
//       div.cf-ai-approval__title             icon + approvalTitle(); danger tools get the warning glyph
//       p.cf-ai-approval__prompt              the rest of a free-text question's prompt (not a tool call)
//       cds-aichat-code-snippet               the call's arguments, read-only (omitted when there are none)
//       div.cf-ai-approval__actions
//         cds-aichat-button[data-action=approve]   kind primary
//         cds-aichat-button[data-action=deny]      kind tertiary (danger-tertiary for a danger tool)
//         cds-aichat-button[data-action=option][data-option="<text>"]   any other `options` entry
//         cds-aichat-button[data-action=other]     "Other…": reveals the redirect field
//       div.cf-ai-approval__redirect-row[hidden]
//         label.cf-ai-visually-hidden + textarea.cf-ai-approval__redirect
//         cds-aichat-button[data-action=redirect-send] + cds-aichat-button[data-action=redirect-cancel]
//       div.cf-ai-approval__result            replaces actions once the question has an answer
//
// Answers accumulate in the card. Flow needs all of them together, so nothing is sent
// until every question has one; then `onAnswers(run, answers)` fires once and the
// controller stamps `answers` onto the item, which locks the card (`update` with an item
// whose `user_defined.answers` is set renders it locked and read-only).
import type { ChainOfThoughtStep, FlowApprovalItem } from "../types.ts";
import type { FlowQuestion } from "../flow/events.ts";
import type { Announcer } from "../announce.ts";
import { el } from "../dom.ts";
import type { Translate } from "../i18n.ts";
import type { ChatButtonElement, CodeSnippetElement } from "../elements.ts";
import { createChatButton, createCodeSnippet, localizeCodeSnippet } from "../elements.ts";
import { ICONS, iconSvg } from "../icons.ts";
import { approvalTitle } from "../flow/tool_labels.ts";
import {
	APPROVE,
	DENY,
	allAnswered,
	answerLabel,
	answerable,
	displayArgs,
	splitPrompt,
	stepFor,
} from "./approval_answers.ts";

export interface ApprovalDeps {
	translate: Translate;
	announcer: Announcer;
	onAnswers(run: string, answers: Readonly<Record<string, string>>): void;
	/**
	 * The last answer removed the button that had focus. The panel moves focus to the prompt
	 * line; without it the card takes focus itself, so a keyboard user is never left on <body>.
	 */
	onRequestInputFocus?(): void;
}

export interface ApprovalCard {
	readonly element: HTMLElement;
	/**
	 * Re-render for a new item and the response's current steps (a question's tool call is
	 * the step whose `tool_call_id` equals the question's `key`; its `request.args` are
	 * what the snippet shows). Partial local answers survive an update that keeps the run.
	 */
	update(item: FlowApprovalItem, steps: readonly ChainOfThoughtStep[]): void;
	/** Focus the first unanswered question's primary action. */
	focusFirst(): void;
	dispose(): void;
}

type Question = FlowQuestion & { key: string };

interface QuestionView {
	readonly element: HTMLElement;
	/** `answer` is the recorded answer, or null while the question is open; a locked card passes "" for a missing one. */
	update(
		question: Question,
		step: ChainOfThoughtStep | undefined,
		answer: string | null,
		grouped: boolean,
	): void;
	focusFirst(): void;
}

// Ids tie each label, title and field together; a page can hold several cards.
let sequence = 0;

/**
 * Replace a parent's children only when they differ. Re-inserting the same nodes in the
 * same order still blurs whatever inside them has focus, and an update arrives on every
 * flag change of the row.
 */
function setChildren(parent: HTMLElement, nodes: readonly Node[]): void {
	const current = parent.childNodes;
	if (current.length === nodes.length && nodes.every((node, index) => current[index] === node)) return;
	parent.replaceChildren(...nodes);
}

/** A Lit element has no shadow button until its first render; focusing earlier is a no-op. */
function focusWhenReady(target: HTMLElement): void {
	const ready: unknown = Reflect.get(target, "updateComplete");
	if (ready instanceof Promise) {
		const focus = (): void => target.focus();
		ready.then(focus, focus);
	} else {
		target.focus();
	}
}

function button(action: string, kind: string, text: string, size = "md"): ChatButtonElement {
	const control = createChatButton();
	control.kind = kind;
	control.size = size;
	control.textContent = text;
	control.dataset["action"] = action;
	return control;
}

function createQuestionView(
	key: string,
	translate: Translate,
	choose: (key: string, answer: string) => void,
): QuestionView {
	const __ = translate;
	const id = `cf-ai-approval-${++sequence}`;

	const root = el("div", "cf-ai-approval__question");
	root.dataset["key"] = key;

	const title = el("div", "cf-ai-approval__title");
	title.id = `${id}-title`;
	const titleText = el("span", "cf-ai-approval__title-text");
	title.append(titleText);
	let iconDanger: boolean | null = null;

	const prompt = el("p", "cf-ai-approval__prompt");
	let snippet: CodeSnippetElement | null = null;

	const actions = el("div", "cf-ai-approval__actions");
	let actionsSignature = "";
	// A question with no options can only be answered in words, so its field is always open.
	let freeText = false;
	let redirectOpen = false;

	const redirectRow = el("div", "cf-ai-approval__redirect-row");
	redirectRow.hidden = true;
	const label = el("label", "cf-ai-visually-hidden");
	label.htmlFor = `${id}-redirect`;
	label.textContent = __("Tell the assistant what to do instead");
	const field = el("textarea", "cf-ai-approval__redirect");
	field.id = `${id}-redirect`;
	field.rows = 2;
	field.placeholder = __("Describe what you want instead…");
	const redirectButtons = el("div", "cf-ai-approval__redirect-actions");
	const send = button("redirect-send", "primary", __("Send"), "sm");
	send.disabled = true;
	const cancel = button("redirect-cancel", "ghost", __("Cancel"), "sm");
	redirectButtons.append(send, cancel);
	redirectRow.append(label, field, redirectButtons);

	const result = el("div", "cf-ai-approval__result");

	function openRedirect(): void {
		redirectOpen = true;
		layout();
		field.focus();
	}

	function closeRedirect(): void {
		redirectOpen = false;
		field.value = "";
		send.disabled = true;
		layout();
		const other = actions.querySelector<HTMLElement>('[data-action="other"]');
		if (other) focusWhenReady(other);
	}

	function sendRedirect(): void {
		const text = field.value.trim();
		if (text !== "") choose(key, text);
	}

	send.addEventListener("click", sendRedirect);
	cancel.addEventListener("click", closeRedirect);
	field.addEventListener("input", () => {
		send.disabled = field.value.trim() === "";
	});
	field.addEventListener("keydown", (event) => {
		// Enter sends and Shift+Enter breaks the line, as in the prompt line; a key that
		// composes an IME candidate must not send.
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			sendRedirect();
		} else if (event.key === "Escape" && !freeText) {
			// The panel closes on Escape; here it only backs out of the field. With no buttons
			// to back out to, the key keeps its panel meaning.
			event.preventDefault();
			event.stopPropagation();
			closeRedirect();
		}
	});

	function actionButton(action: string, kind: string, text: string, option?: string): ChatButtonElement {
		const control = button(action, kind, text);
		if (option !== undefined) control.dataset["option"] = option;
		control.addEventListener("click", () => {
			if (action === "other") openRedirect();
			else choose(key, option ?? (action === "approve" ? APPROVE : DENY));
		});
		return control;
	}

	function rebuildActions(question: Question, danger: boolean): void {
		const controls: ChatButtonElement[] = [];
		for (const option of question.options) {
			if (option === APPROVE) controls.push(actionButton("approve", "primary", __("Approve")));
			else if (option === DENY) {
				controls.push(actionButton("deny", danger ? "danger-tertiary" : "tertiary", __("Deny")));
			} else controls.push(actionButton("option", "tertiary", option, option));
		}
		if (question.allow_other && question.options.length > 0) {
			controls.push(actionButton("other", "ghost", __("Other…")));
		}
		actions.replaceChildren(...controls);
	}

	let answered = false;
	let hasPrompt = false;

	function layout(): void {
		const nodes: Node[] = [title];
		if (hasPrompt) nodes.push(prompt);
		if (snippet) nodes.push(snippet);
		if (answered) {
			nodes.push(result);
		} else {
			const fieldOpen = redirectOpen || freeText;
			actions.hidden = fieldOpen;
			redirectRow.hidden = !fieldOpen;
			cancel.hidden = freeText;
			nodes.push(actions, redirectRow);
		}
		setChildren(root, nodes);
		root.classList.toggle("cf-ai-approval__question--answered", answered);
	}

	return {
		element: root,
		update(question, step, answer, grouped) {
			// A confirmation names the action from the call's own arguments; any other
			// question (a tool that asks the user something) is its prompt, whose text is
			// the content and whose tool name would only say "Ask user".
			const tool = step?.tool_name;
			const confirmation = step !== undefined && tool !== undefined && question.options.includes(APPROVE);
			const info = confirmation ? approvalTitle(tool, step.request?.args, __) : null;
			const parts = splitPrompt(question.prompt);
			const heading = info ? info.title : parts.title;
			if (titleText.textContent !== heading) titleText.textContent = heading;

			const danger = info?.danger === true;
			if (danger !== iconDanger) {
				title.querySelector("svg")?.remove();
				title.insertAdjacentHTML(
					"afterbegin",
					iconSvg(danger ? ICONS.warningAlt16 : ICONS.security16, { class: "cf-ai-approval__icon" }),
				);
				iconDanger = danger;
			}

			const body = confirmation ? "" : parts.body;
			if (prompt.textContent !== body) prompt.textContent = body;
			hasPrompt = body !== "";

			const args = confirmation ? displayArgs(step) : null;
			if (args === null) {
				snippet = null;
			} else {
				if (snippet === null) {
					snippet = createCodeSnippet();
					localizeCodeSnippet(snippet, __);
					snippet.highlight = true;
					snippet.language = "json";
					// The card's title already says what the code is; a "json" header would only repeat it.
					snippet.hideHeader = true;
				}
				const code = JSON.stringify(args, null, 2);
				if (snippet.code !== code) snippet.code = code;
			}

			freeText = question.options.length === 0;
			const signature = JSON.stringify([question.options, question.allow_other, danger]);
			if (signature !== actionsSignature) {
				rebuildActions(question, danger);
				actionsSignature = signature;
			}

			answered = answer !== null;
			if (answer !== null) {
				result.textContent = answer === "" ? "" : answerLabel(answer, question.options, __);
			}
			if (grouped) {
				root.setAttribute("role", "group");
				root.setAttribute("aria-labelledby", title.id);
			} else {
				root.removeAttribute("role");
				root.removeAttribute("aria-labelledby");
			}
			layout();
		},
		focusFirst() {
			if (answered) return;
			const target = redirectOpen || freeText ? field : actions.querySelector<HTMLElement>("[data-action]");
			if (target) focusWhenReady(target);
		},
	};
}

export function createApprovalCard(
	item: FlowApprovalItem,
	steps: readonly ChainOfThoughtStep[],
	deps: ApprovalDeps,
): ApprovalCard {
	const __ = deps.translate;
	const root = el("div", "cf-ai-approval");
	root.setAttribute("role", "group");
	root.setAttribute("aria-label", __("Approval required"));

	const views = new Map<string, QuestionView>();
	const local = new Map<string, string>();
	let current = item;
	let currentSteps = steps;
	let questions: Question[] = [];
	let locked = false;
	let submitted = false;
	let disposed = false;

	function render(): void {
		const payload = current.user_defined;
		const recorded = payload.answers;
		locked = recorded !== undefined;
		questions = answerable(payload.questions);
		root.dataset["run"] = payload.run;
		root.classList.toggle("cf-ai-approval--locked", locked);
		// Between the last answer and the controller stamping `answers` onto the item.
		if (submitted && !locked) root.setAttribute("aria-busy", "true");
		else root.removeAttribute("aria-busy");

		const keys = new Set(questions.map((question) => question.key));
		for (const key of views.keys()) if (!keys.has(key)) views.delete(key);
		const ordered: HTMLElement[] = [];
		for (const question of questions) {
			let view = views.get(question.key);
			if (view === undefined) {
				view = createQuestionView(question.key, deps.translate, choose);
				views.set(question.key, view);
			}
			const answer = locked ? (recorded?.[question.key] ?? "") : (local.get(question.key) ?? null);
			view.update(question, stepFor(currentSteps, question.key), answer, questions.length > 1);
			ordered.push(view.element);
		}
		setChildren(root, ordered);
	}

	function focusFirst(): void {
		if (locked || submitted) return;
		for (const question of questions) {
			if (!local.has(question.key)) {
				views.get(question.key)?.focusFirst();
				return;
			}
		}
	}

	function choose(key: string, answer: string): void {
		if (disposed || locked || submitted || local.has(key)) return;
		const question = questions.find((candidate) => candidate.key === key);
		if (question === undefined) return;
		local.set(key, answer);
		deps.announcer.announce(answerLabel(answer, question.options, __));
		const keys = questions.map((candidate) => candidate.key);
		const complete = allAnswered(keys, local);
		if (complete) submitted = true;
		render();
		if (!complete) {
			focusFirst();
			return;
		}
		deps.onAnswers(
			current.user_defined.run,
			Object.fromEntries(keys.map((candidate) => [candidate, local.get(candidate) ?? ""])),
		);
		if (deps.onRequestInputFocus) {
			deps.onRequestInputFocus();
		} else {
			root.tabIndex = -1;
			root.focus();
		}
	}

	render();
	return {
		element: root,
		update(next, nextSteps) {
			if (disposed) return;
			if (next.user_defined.run !== current.user_defined.run) {
				local.clear();
				submitted = false;
			}
			current = next;
			currentSteps = nextSteps;
			render();
		},
		focusFirst,
		dispose() {
			disposed = true;
			views.clear();
			root.replaceChildren();
		},
	};
}
