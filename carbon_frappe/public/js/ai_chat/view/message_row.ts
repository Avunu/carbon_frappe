// One row of the message list, created once per message id and patched in place for
// the life of the conversation. Rows are never rebuilt: replacing a <cds-aichat-markdown>
// or a step list mid-stream would restart its parse and drop its open/expanded state.
//
// Markup (class names and attributes are a contract with scss/ai_chat/_messages.scss and
// scripts/shell/assistant.ts):
//
//   div.cf-ai-message[role=listitem][tabindex=-1][data-message-id]
//       .cf-ai-message--user | .cf-ai-message--assistant
//       .cf-ai-message--first  .cf-ai-message--last  .cf-ai-message--streaming
//     div.cf-ai-message__avatar-line
//       div.cf-ai-message__avatar            assistant only; svg chat-bot, 28px circle
//       span.cf-ai-message__label            "You" | "Assistant", then
//         time.cf-ai-message__time[datetime]  the message timestamp when it has one; title and aria-label
//                                             carry the full date
//     div.cf-ai-message__body
//       user:      div.cf-ai-message__bubble > div[role=heading][aria-level=2] > cds-aichat-markdown[remove-html]
//                  ul.cf-ai-message__files[role=list]   the files sent with it, as read-only chips (view/attachments.ts)
//       assistant: one block per generic item, in order:
//         text     div.cf-ai-item.cf-ai-item--text[data-item-id] > cds-aichat-markdown[remove-html][sanitize-html]
//         stopped  div.cf-ai-stopped         when the item's streaming_metadata.stream_stopped
//         error    div.cf-ai-item.cf-ai-error (Carbon inline notification markup: a fixed title, the
//                  server's text as the clipped subtitle, and a Try again button on the last row. No
//                  role: the list announces it, and an alert here would be read a second time)
//         approval div.cf-ai-approval        (view/approval.ts)
//     div.cf-ai-message__steps               assistant, when chain_of_thought is non-empty
//       cds-aichat-chain-of-thought-toggle + cds-aichat-chain-of-thought > step > tool-call-data
//     div.cf-ai-message__footer              assistant, when a text item has feedback.is_on (view/feedback.ts)
//       cds-aichat-feedback-buttons + cds-aichat-feedback
//
// The look is MessageComponent.scss's (Apache-2.0, IBM Corp.); the structure follows
// @carbon/ai-chat's MessageTypeComponent.tsx, minus React: state that React held in hooks
// lives in the closures below, and every element is created once and then mutated.
import type { Announcer } from "../announce.ts";
import { createErrorNotification, el, iconElement, syncChildren } from "../dom.ts";
import {
	EVENTS,
	createChainOfThought,
	createChainOfThoughtStep,
	createChainOfThoughtToggle,
	createCodeBlockRenderer,
	createMarkdown,
	createToolCallData,
	isToggleDetail,
	listenDetail,
	localizeMarkdown,
} from "../elements.ts";
import type {
	ChainOfThoughtElement,
	CodeBlockArgs,
	ChainOfThoughtStepElement,
	ChainOfThoughtToggleElement,
	MarkdownElement,
	ToolCallDataElement,
} from "../elements.ts";
import { ICONS } from "../icons.ts";
import { feedbackRun, restoredRating } from "../feedback_state.ts";
import type { Translate } from "../i18n.ts";
import { stepDataMarkdown } from "../step_data.ts";
import { formatMessageDateTime, formatMessageTime } from "../timestamps.ts";
import type { ChainOfThoughtStep, GenericItem, Message, StructuredData } from "../types.ts";
import { isFlowApprovalItem, isInlineErrorItem, isRequest, isResponse, isTextItem } from "../types.ts";
import { attachmentChipsOf } from "../uploads.ts";
import { createApprovalCard } from "./approval.ts";
import { createMessageFiles } from "./attachments.ts";
import { createFeedbackFooter } from "./feedback.ts";
import type { FeedbackFooter } from "./feedback.ts";

/** Position and stream state of a row, which the list computes and passes on every update. */
export interface RowFlags {
	/** The first row of the list: extra top padding. */
	first: boolean;
	/** The last row of the list: extra bottom padding. */
	last: boolean;
	/** This row's response is the store's `activeResponseId`: passes `streaming` to its markdown. */
	streaming: boolean;
}

export interface MessageRowDeps {
	translate: Translate;
	/** BCP 47 tag for time formatting and markdown tables, e.g. `frappe.boot.lang`. */
	locale: string;
	/** IANA zone times are shown in (`readTimeZones(frappe.boot).user`); the browser's when absent. */
	timeZone?: string | undefined;
	/** Handed to the approval cards, which write to the same live regions as the list. */
	announcer: Announcer;
	/** An approval card was answered: every question's answer at once. */
	onApprovalAnswers(run: string, answers: Readonly<Record<string, string>>): void;
	/** The last approval answer removed the button that had focus; the prompt line should take it. */
	onRequestInputFocus(): void;
	/** Send the last user message again. Without it an error shows no "Try again" button. */
	onRetry?(): void;
	/**
	 * A thumb was clicked and, for a thumbs-down, its details submitted. A returned promise
	 * is awaited: a rejection un-selects the thumb. Telling the user why is the caller's job.
	 */
	onFeedback(run: string, rating: "Up" | "Down" | "None", comment?: string): void | Promise<void>;
}

export interface MessageRow {
	/** The message id the row was created for; never changes. */
	readonly id: string;
	readonly element: HTMLElement;
	/** Patch the DOM to match `message`. Called with the same message object when only flags changed. */
	update(message: Message, flags: RowFlags): void;
	/** Move focus to the row itself (a roving tabindex target); announces nothing. */
	focus(): void;
	dispose(): void;
}

// -- small DOM helpers --------------------------------------------------------

function applyFlags(root: HTMLElement, flags: RowFlags): void {
	root.classList.toggle("cf-ai-message--first", flags.first);
	root.classList.toggle("cf-ai-message--last", flags.last);
	root.classList.toggle("cf-ai-message--streaming", flags.streaming);
}

function createRoot(id: string, role: "user" | "assistant"): HTMLElement {
	const root = el("div", `cf-ai-message cf-ai-message--${role}`);
	root.setAttribute("role", "listitem");
	root.setAttribute("tabindex", "-1");
	root.setAttribute("data-message-id", id);
	return root;
}

interface AvatarLine {
	readonly element: HTMLElement;
	setTimestamp(timestamp: number | undefined): void;
}

function createAvatarLine(role: "user" | "assistant", labelText: string, deps: MessageRowDeps): AvatarLine {
	const element = el("div", "cf-ai-message__avatar-line");
	if (role === "assistant") {
		const avatar = el("div", "cf-ai-message__avatar");
		avatar.append(iconElement(ICONS.chatBot16));
		element.append(avatar);
	}
	const label = el("span", "cf-ai-message__label");
	label.append(document.createTextNode(labelText));
	element.append(label);

	let time: HTMLElement | null = null;
	let shown: number | undefined;
	return {
		element,
		setTimestamp(timestamp) {
			if (timestamp === shown) return;
			shown = timestamp;
			// a finite number can still be outside the range a Date holds
			if (timestamp === undefined || Number.isNaN(new Date(timestamp).getTime())) {
				time?.remove();
				time = null;
				return;
			}
			if (time === null) {
				time = el("time", "cf-ai-message__time");
				label.append(document.createTextNode(" "), time);
			}
			const format = { locale: deps.locale, timeZone: deps.timeZone };
			// the visible text omits the date for today's messages, so the full one is the accessible name
			const full = formatMessageDateTime(timestamp, format);
			time.setAttribute("datetime", new Date(timestamp).toISOString());
			time.title = full;
			time.setAttribute("aria-label", full);
			time.textContent = formatMessageTime(timestamp, Date.now(), format);
		},
	};
}

type MarkdownMode = "user" | "assistant";

/** What a markdown image may load: this site's uploaded files and nothing else. */
const FILE_PATHS = ["/files/", "/private/files/"];

/**
 * An `<img>` fetches its `src` the moment it renders, so a model reply (steered by anything
 * the agent read) could send the conversation to a third party in the URL's query string.
 * Same-origin uploads are the only images a reply has a reason to show.
 */
function imageSrc(src: string): string {
	try {
		const url = new URL(src, window.location.origin);
		if (url.origin === window.location.origin && FILE_PATHS.some((path) => url.pathname.startsWith(path))) {
			return src;
		}
	} catch {
		// not a URL at all: nothing to load
	}
	return "";
}

function configureMarkdown(markdown: MarkdownElement, deps: MessageRowDeps, mode: MarkdownMode): void {
	localizeMarkdown(markdown, deps.translate, deps.locale);
	// sanitizeHTML alone is not enough: its DOMPurify config lets every attribute through on any
	// hyphenated tag, so `<x-a onmouseenter=...>` in a reply runs script. Models have no need for raw HTML.
	markdown.removeHTML = true;
	const image = (args: { src: string }): { src: string } => ({ src: imageSrc(args.src) });
	if (mode === "user") {
		markdown.customRenderers = { image };
		return;
	}
	markdown.sanitizeHTML = true;
	// one renderer per markdown element: it caches a snippet per slot name, and two elements
	// share slot names, so a shared cache would hand one element's snippet to the other
	const renderCode = createCodeBlockRenderer(deps.translate);
	markdown.customRenderers = {
		// markdown-it keeps the newline that ends a fence's last line, which the snippet
		// would show as an empty numbered line
		codeBlock: (args: CodeBlockArgs) => renderCode({ ...args, code: args.code.replace(/\n$/, "") }),
		image,
	};
}

// -- user row -----------------------------------------------------------------

function createUserRow(id: string, deps: MessageRowDeps): MessageRow {
	const __ = deps.translate;
	const root = createRoot(id, "user");
	const line = createAvatarLine("user", __("You"), deps);

	const body = el("div", "cf-ai-message__body");
	const bubble = el("div", "cf-ai-message__bubble");
	const heading = el("div", "cf-ai-message__text");
	heading.setAttribute("role", "heading");
	heading.setAttribute("aria-level", "2");
	const markdown = createMarkdown();
	configureMarkdown(markdown, deps, "user");
	heading.append(markdown);
	bubble.append(heading);
	const files = createMessageFiles({ translate: __ });
	body.append(bubble, files.element);
	root.append(line.element, body);

	// The chips depend on `structured_data` alone, and a streaming update hands the row the same object.
	let shownData: StructuredData | undefined;
	return {
		id,
		element: root,
		update(message, flags) {
			applyFlags(root, flags);
			if (!isRequest(message)) return;
			const text = message.input.text ?? "";
			if (markdown.markdown !== text) markdown.markdown = text;
			line.setTimestamp(message.history?.timestamp);
			if (message.input.structured_data !== shownData) {
				shownData = message.input.structured_data;
				files.update(attachmentChipsOf(message.input));
			}
		},
		focus: () => root.focus(),
		dispose() {
			files.dispose();
			root.remove();
		},
	};
}

// -- assistant blocks ---------------------------------------------------------

interface BlockContext {
	/** This text item is the last one of a response that is still streaming. */
	streaming: boolean;
	steps: readonly ChainOfThoughtStep[];
	/** The reply is the last row and has stopped streaming: the only place a retry makes sense. */
	retryable: boolean;
}

/** One generic item of a response, as the DOM that shows it. */
interface Block {
	readonly element: HTMLElement;
	update(item: GenericItem, context: BlockContext): void;
	dispose(): void;
}

function createTextBlock(item: GenericItem, deps: MessageRowDeps): Block {
	const root = el("div", "cf-ai-item cf-ai-item--text");
	const itemId = item.streaming_metadata?.id;
	if (itemId !== undefined) root.setAttribute("data-item-id", itemId);
	const markdown = createMarkdown();
	configureMarkdown(markdown, deps, "assistant");
	root.append(markdown);
	return {
		element: root,
		update(next, context) {
			if (!isTextItem(next)) return;
			// set on every delta: the element throttles to 100 ms and diffs the token tree itself
			const text = next.text ?? "";
			if (markdown.markdown !== text) markdown.markdown = text;
			if (markdown.streaming !== context.streaming) markdown.streaming = context.streaming;
		},
		dispose() {},
	};
}

function createStoppedBlock(deps: MessageRowDeps): Block {
	const __ = deps.translate;
	const root = el("div", "cf-ai-stopped");
	root.textContent = __("Response stopped");
	return { element: root, update() {}, dispose() {} };
}

function createErrorBlock(deps: MessageRowDeps): Block {
	const __ = deps.translate;
	// No role="alert": the list announces a new error item itself, and a live region here
	// would say it twice. The server's text is a litellm or HTTP failure string, so the title
	// says what happened in the user's terms and the raw text sits below it.
	const notification = createErrorNotification({
		title: __("The assistant could not finish this reply"),
		hideClose: true,
	});
	const root = notification.element;
	root.classList.add("cf-ai-item", "cf-ai-error");

	let retry: HTMLButtonElement | null = null;
	const onRetry = (): void => deps.onRetry?.();
	return {
		element: root,
		update(item, context) {
			if (!isInlineErrorItem(item)) return;
			notification.setSubtitle(item.text ?? "");

			const wantRetry = context.retryable && deps.onRetry !== undefined;
			if (wantRetry && retry === null) {
				retry = el(
					"button",
					"cds--inline-notification__action-button cds--btn cds--btn--sm cds--btn--ghost",
					__("Try again"),
				);
				retry.type = "button";
				retry.setAttribute("data-action", "retry-reply");
				retry.addEventListener("click", onRetry);
				root.append(retry);
			} else if (!wantRetry && retry !== null) {
				retry.removeEventListener("click", onRetry);
				retry.remove();
				retry = null;
			}
		},
		dispose() {
			retry?.removeEventListener("click", onRetry);
		},
	};
}

function createApprovalBlock(item: GenericItem, context: BlockContext, deps: MessageRowDeps): Block | null {
	if (!isFlowApprovalItem(item)) return null;
	const card = createApprovalCard(item, context.steps, {
		translate: deps.translate,
		announcer: deps.announcer,
		onAnswers: deps.onApprovalAnswers,
		onRequestInputFocus: deps.onRequestInputFocus,
	});
	return {
		element: card.element,
		update(next, nextContext) {
			if (isFlowApprovalItem(next)) card.update(next, nextContext.steps);
		},
		dispose: () => card.dispose(),
	};
}

type BlockKind = "text" | "stopped" | "error" | "approval";

function blockKindOf(item: GenericItem): BlockKind | null {
	if (isTextItem(item)) return "text";
	if (isInlineErrorItem(item)) return "error";
	if (isFlowApprovalItem(item)) return "approval";
	return null;
}

interface BlockEntry {
	key: string;
	kind: BlockKind;
	item: GenericItem;
	streaming: boolean;
}

/** Items in document order, each followed by its "Response stopped" marker when it was cut off. */
function blockEntries(generic: readonly GenericItem[], streaming: boolean): BlockEntry[] {
	let lastText = -1;
	generic.forEach((item, index) => {
		if (isTextItem(item)) lastText = index;
	});

	const entries: BlockEntry[] = [];
	const seen = new Set<string>();
	generic.forEach((item, index) => {
		const kind = blockKindOf(item);
		if (kind === null) return;
		// the reducer ids an item "<type>-<n>"; a missing id falls back to the position
		let key = `${item.response_type}:${item.streaming_metadata?.id ?? `#${index}`}`;
		if (seen.has(key)) key = `${key}~${index}`;
		seen.add(key);
		entries.push({ key, kind, item, streaming: streaming && index === lastText });
		if (item.streaming_metadata?.stream_stopped === true) {
			entries.push({ key: `stopped:${key}`, kind: "stopped", item, streaming: false });
		}
	});
	return entries;
}

// -- chain of thought ---------------------------------------------------------

interface StepView {
	readonly element: ChainOfThoughtStepElement;
	update(step: ChainOfThoughtStep, index: number, withBody: boolean): void;
}

function createStepView(deps: MessageRowDeps): StepView {
	const __ = deps.translate;
	const element = createChainOfThoughtStep();
	element.statusSucceededLabelText = __("Succeeded");
	element.statusFailedLabelText = __("Failed");
	element.statusProcessingLabelText = __("Processing");
	const data: ToolCallDataElement = createToolCallData();
	data.inputLabelText = __("Input");
	data.outputLabelText = __("Output");
	data.toolLabelText = __("Tool");
	element.append(data);

	// each slot is a div around a markdown element, as upstream does it; the slot stays out of
	// the DOM until the step has something to show, so a step with no payload has no body
	const slots = new Map<string, { slot: HTMLElement; markdown: MarkdownElement }>();
	function setSlot(name: string, text: string | undefined): void {
		let entry = slots.get(name);
		if (text === undefined) {
			if (entry !== undefined) {
				entry.slot.remove();
				slots.delete(name);
			}
			return;
		}
		if (entry === undefined) {
			const slot = el("div", "cf-ai-message__step-data");
			slot.setAttribute("slot", name);
			const markdown = createMarkdown();
			configureMarkdown(markdown, deps, "assistant");
			slot.append(markdown);
			data.append(slot);
			entry = { slot, markdown };
			slots.set(name, entry);
		}
		if (entry.markdown.markdown !== text) entry.markdown.markdown = text;
	}

	// Payloads can be large JSON and the step objects are shared between updates, so the
	// markdown is rebuilt only for a value that is a different object from the last one shown
	let shown: { description: unknown; args: unknown; content: unknown } | null = null;
	return {
		element,
		update(step, index, withBody) {
			const title = step.title || step.tool_name || "";
			element.title = title;
			element.stepNumber = index + 1;
			element.labelText = `${index + 1}: ${title}`;
			element.status = step.status ?? "success";
			data.toolName = step.tool_name ?? "";
			// a step nobody opened never builds its markdown
			if (!withBody) return;
			const args = step.request?.args;
			const content = step.response?.content;
			if (
				shown !== null &&
				shown.description === step.description &&
				shown.args === args &&
				shown.content === content
			) {
				return;
			}
			shown = { description: step.description, args, content };
			setSlot("description", step.description || undefined);
			setSlot("input", stepDataMarkdown(args));
			setSlot("output", stepDataMarkdown(content));
		},
	};
}

interface StepsBlock {
	readonly element: HTMLElement;
	update(steps: readonly ChainOfThoughtStep[]): void;
	dispose(): void;
}

function createStepsBlock(deps: MessageRowDeps): StepsBlock {
	const __ = deps.translate;
	const element = el("div", "cf-ai-message__steps");
	const toggle: ChainOfThoughtToggleElement = createChainOfThoughtToggle();
	const chain: ChainOfThoughtElement = createChainOfThought();
	toggle.openLabelText = __("Hide steps");
	toggle.closedLabelText = __("Show steps");
	toggle.panelId = chain.panelId;
	element.append(toggle, chain);

	let open = false;
	let latest: readonly ChainOfThoughtStep[] = [];
	const views = new Map<string, StepView>();

	function render(): void {
		const live = new Set<string>();
		const ordered: Element[] = [];
		latest.forEach((step, index) => {
			let key = step.tool_call_id ?? `#${index}`;
			if (live.has(key)) key = `${key}~${index}`;
			live.add(key);
			let view = views.get(key);
			if (view === undefined) {
				view = createStepView(deps);
				views.set(key, view);
			}
			view.update(step, index, open);
			ordered.push(view.element);
		});
		for (const key of views.keys()) {
			if (!live.has(key)) views.delete(key);
		}
		syncChildren(chain, ordered);

		// A collapsed list shows nothing of its progress: the running step's title is the label
		let running: string | undefined;
		for (const step of latest) {
			if (step.status === "processing") running = step.title || step.tool_name || undefined;
		}
		const closedLabel = running ?? __("Show steps");
		if (toggle.closedLabelText !== closedLabel) toggle.closedLabelText = closedLabel;
	}

	// The toggle flips its own `open`; the list follows by hand (the pair is two elements, not
	// a component, in the pinned release)
	const stopListening = listenDetail(toggle, EVENTS.chainOfThoughtToggle, isToggleDetail, (detail) => {
		open = detail.open;
		chain.open = open;
		render();
	});

	return {
		element,
		update(steps) {
			latest = steps;
			render();
		},
		dispose() {
			stopListening();
			views.clear();
		},
	};
}

// -- assistant row ------------------------------------------------------------

const NO_STEPS: readonly ChainOfThoughtStep[] = [];

function createAssistantRow(id: string, deps: MessageRowDeps): MessageRow {
	const __ = deps.translate;
	const root = createRoot(id, "assistant");
	const line = createAvatarLine("assistant", __("Assistant"), deps);
	const body = el("div", "cf-ai-message__body");
	root.append(line.element, body);

	const blocks = new Map<string, Block>();
	// keys of blocks that could not be built; retrying on every delta would only repeat the error
	const broken = new Set<string>();
	let steps: StepsBlock | null = null;
	let footer: FeedbackFooter | null = null;
	let lastMessage: Message | undefined;
	let lastStreaming: boolean | undefined;
	let lastRetryable: boolean | undefined;

	function buildBlock(entry: BlockEntry, context: BlockContext): Block | null {
		switch (entry.kind) {
			case "text":
				return createTextBlock(entry.item, deps);
			case "stopped":
				return createStoppedBlock(deps);
			case "error":
				return createErrorBlock(deps);
			case "approval":
				try {
					return createApprovalBlock(entry.item, context, deps);
				} catch (error) {
					// an approval card that cannot render must not take the whole reply with it
					console.error(error);
					return null;
				}
		}
	}

	function patchBody(
		generic: readonly GenericItem[],
		chain: readonly ChainOfThoughtStep[],
		streaming: boolean,
		retryable: boolean,
	) {
		const live = new Set<string>();
		const ordered: HTMLElement[] = [];
		for (const entry of blockEntries(generic, streaming)) {
			if (broken.has(entry.key)) continue;
			const context: BlockContext = { streaming: entry.streaming, steps: chain, retryable };
			let block = blocks.get(entry.key);
			if (block === undefined) {
				const built = buildBlock(entry, context);
				if (built === null) {
					broken.add(entry.key);
					continue;
				}
				block = built;
				blocks.set(entry.key, block);
			}
			block.update(entry.item, context);
			live.add(entry.key);
			ordered.push(block.element);
		}
		for (const [key, block] of blocks) {
			if (live.has(key)) continue;
			block.dispose();
			blocks.delete(key);
		}
		syncChildren(body, ordered);
	}

	return {
		id,
		element: root,
		update(message, flags) {
			applyFlags(root, flags);
			if (!isResponse(message)) return;
			// a retry is offered on the last row only, so `last` can change what the row shows
			const retryable = flags.last && !flags.streaming;
			if (message === lastMessage && flags.streaming === lastStreaming && retryable === lastRetryable) {
				return;
			}
			lastMessage = message;
			lastStreaming = flags.streaming;
			lastRetryable = retryable;

			line.setTimestamp(message.history?.timestamp);
			const chain = message.message_options?.chain_of_thought ?? NO_STEPS;
			patchBody(message.output.generic, chain, flags.streaming, retryable);

			if (chain.length > 0) {
				steps ??= createStepsBlock(deps);
				steps.update(chain);
			} else if (steps !== null) {
				steps.dispose();
				steps = null;
			}

			const run = flags.streaming ? undefined : feedbackRun(message.output.generic);
			if (footer !== null && footer.run !== run) {
				footer.dispose();
				footer = null;
			}
			if (footer === null && run !== undefined) {
				footer = createFeedbackFooter(run, id, restoredRating(message, run), deps);
			}
			syncChildren(root, [
				line.element,
				body,
				...(steps ? [steps.element] : []),
				...(footer ? [footer.element] : []),
			]);
		},
		focus: () => root.focus(),
		dispose() {
			for (const block of blocks.values()) block.dispose();
			blocks.clear();
			steps?.dispose();
			footer?.dispose();
			root.remove();
		},
	};
}

/** Throws when `message` has no id (the store always assigns one) or is neither a request nor a response. */
export function createMessageRow(message: Message, flags: RowFlags, deps: MessageRowDeps): MessageRow {
	const id = message.id;
	if (id === undefined) throw new Error("carbon_frappe: a chat message has no id");
	let row: MessageRow;
	if (isRequest(message)) row = createUserRow(id, deps);
	else if (isResponse(message)) row = createAssistantRow(id, deps);
	else throw new Error(`carbon_frappe: chat message ${id} is neither a request nor a response`);
	row.update(message, flags);
	return row;
}
