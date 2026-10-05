// The footer under a finished reply: thumbs up and down (cds-aichat-feedback-buttons) and the
// comment panel a thumbs-down opens (cds-aichat-feedback). The rules are feedback_state.ts's;
// this module renders them and makes the call.
//
// Markup, inside the reply's `div.cf-ai-message__footer[data-run]`:
//
//   cds-aichat-feedback-buttons       isPositiveSelected / isNegativeSelected / isNegativeOpen /
//                                     is*Disabled follow the state; labels "Good response" / "Bad response"
//   cds-aichat-feedback               title "Tell us more", placeholder "What went wrong?", maxLength 500,
//                                     a disclaimer that the comment may be shared
//
// The structure follows @carbon/ai-chat's MessageTypeComponent feedback handling.
import type { Announcer } from "../announce.ts";
import { el } from "../dom.ts";
import {
	EVENTS,
	createFeedback,
	createFeedbackButtons,
	isFeedbackButtonsClickDetail,
	isFeedbackSubmitDetail,
	listenDetail,
} from "../elements.ts";
import { initialFeedbackState, onCloseDetails, onSubmitDetails, onThumb, settle } from "../feedback_state.ts";
import type { FeedbackCall, FeedbackState, FeedbackStep, Rating } from "../feedback_state.ts";
import type { Translate } from "../i18n.ts";

/** Flow refuses a longer comment (FEEDBACK_COMMENT_LIMIT in flow.api.api), after the user has typed it. */
const COMMENT_LIMIT = 500;

/** The text box inside cds-aichat-feedback, which gives it no label of its own. */
interface LabelledTextarea extends HTMLElement {
	label: string;
	hideLabel: boolean;
}

function isLabelledTextarea(element: Element | null): element is LabelledTextarea {
	return element instanceof HTMLElement && "label" in element && "hideLabel" in element;
}

export interface FeedbackFooterDeps {
	translate: Translate;
	/** Receives "Feedback sent" and "Feedback removed" (polite) after the server accepted the call. */
	announcer: Announcer;
	/**
	 * Make the call. A returned promise is awaited: a rejection rolls the footer back to the state before
	 * the click. Telling the user why is the caller's job (the panel shows an alert); the footer only
	 * restores itself.
	 */
	onFeedback(run: string, rating: "Up" | "Down" | "None", comment?: string): void | Promise<void>;
}

export interface FeedbackFooter {
	/** The run this footer rates; a reply whose rated run changes gets a new footer. */
	readonly run: string;
	/** `div.cf-ai-message__footer[data-run]`. */
	readonly element: HTMLElement;
	dispose(): void;
}

/** `messageId` namespaces the panel id the buttons point `aria-controls` at. */
export function createFeedbackFooter(
	run: string,
	messageId: string,
	initial: Rating,
	deps: FeedbackFooterDeps,
): FeedbackFooter {
	const __ = deps.translate;
	const element = el("div", "cf-ai-message__footer");
	element.setAttribute("data-run", run);
	const buttons = createFeedbackButtons();
	const details = createFeedback();

	const panelId = `cf-ai-feedback-${messageId}`;
	buttons.panelID = panelId;
	buttons.positiveLabel = __("Good response");
	buttons.negativeLabel = __("Bad response");
	// only the thumbs-down asks for more; a thumbs-up is complete when clicked
	buttons.hasPositiveDetails = false;
	buttons.hasNegativeDetails = true;
	details.id = `${panelId}-feedback-negative`;
	details.title = __("Tell us more");
	details.placeholder = __("What went wrong?");
	details.showTextArea = true;
	details.maxLength = COMMENT_LIMIT;
	// A thumbs-down comment is saved as memory every user of the agent gets (flow.memory), and a
	// deleted conversation does not take it along. The element has no typed `disclaimer` property.
	details.setAttribute(
		"disclaimer",
		__("Your comment may be saved and used by this assistant in other people's conversations."),
	);
	element.append(buttons, details);

	let state: FeedbackState = initialFeedbackState(initial);
	let disposed = false;
	// The thumb that started the call in flight, or null. It stays enabled: a disabled button
	// takes the focus with it (to <body>) and nothing gives it back.
	let activated: "positive" | "negative" | null = null;

	/** The panel gives its text box no label, so a screen reader would read an unnamed edit field. */
	async function nameTextarea(): Promise<void> {
		if ("updateComplete" in details && details.updateComplete instanceof Promise)
			await details.updateComplete;
		const field = details.shadowRoot?.querySelector("cds-textarea") ?? null;
		if (disposed || !isLabelledTextarea(field)) return;
		field.label = details.title;
		field.hideLabel = true;
	}

	function render(): void {
		buttons.isPositiveSelected = state.rating === "Up";
		buttons.isNegativeSelected = state.rating === "Down";
		buttons.isNegativeOpen = state.detailsOpen;
		// one rating per reply, as upstream: withdraw the selected thumb before choosing the other
		buttons.isPositiveDisabled = state.rating === "Down" || (state.busy && activated !== "positive");
		buttons.isNegativeDisabled = state.rating === "Up" || (state.busy && activated !== "negative");
		const opening = state.detailsOpen && !details.isOpen;
		details.isOpen = state.detailsOpen;
		if (opening) {
			// focus stays on the thumb, so nothing else says that a form appeared
			deps.announcer.announce(details.title);
			// the panel opens below the fold when the reply is the last thing on screen
			requestAnimationFrame(() => {
				if (!disposed) details.scrollIntoView({ block: "nearest" });
			});
		}
	}

	function announceSent(call: FeedbackCall): void {
		deps.announcer.announce(call.rating === "None" ? __("Feedback removed") : __("Feedback sent"));
	}

	/** Show the step at once, make its call, and take it back if the server refuses. */
	function apply(step: FeedbackStep): void {
		const before = state;
		state = step.state;
		render();
		const call = step.call;
		if (call === null) return;
		const finish = (succeeded: boolean): void => {
			if (disposed) return;
			state = settle(state, before, succeeded);
			render();
			if (succeeded) announceSent(call);
		};
		let pending: void | Promise<void>;
		try {
			pending = deps.onFeedback(run, call.rating, call.comment);
		} catch (error) {
			console.error(error);
			finish(false);
			return;
		}
		// the caller tells the user about a refusal; the footer only takes the selection back
		Promise.resolve(pending).then(
			() => finish(true),
			() => finish(false),
		);
	}

	/** The thumbs-down lives in the buttons' shadow root; it is where the comment panel was opened from. */
	function focusNegativeThumb(): void {
		const thumb = buttons.shadowRoot?.querySelector(".cds-aichat--feedback-buttons-negative");
		if (thumb instanceof HTMLElement) thumb.focus();
	}

	function closeDetails(): void {
		state = onCloseDetails(state);
		render();
		focusNegativeThumb();
	}

	const unsubscribers = [
		listenDetail(buttons, EVENTS.feedbackButtonsClick, isFeedbackButtonsClickDetail, ({ isPositive }) => {
			activated = isPositive ? "positive" : "negative";
			apply(onThumb(state, isPositive));
		}),
		listenDetail(details, EVENTS.feedbackSubmit, isFeedbackSubmitDetail, ({ text }) => {
			activated = "negative";
			apply(onSubmitDetails(state, text));
			// the panel closes under the focus
			if (!state.detailsOpen) focusNegativeThumb();
		}),
	];
	// the close button carries no detail, so there is nothing for listenDetail to check
	const onClose = (): void => closeDetails();
	details.addEventListener(EVENTS.feedbackClose, onClose);
	unsubscribers.push(() => details.removeEventListener(EVENTS.feedbackClose, onClose));
	// Escape would otherwise reach the message list (back to the prompt line) and the panel (close the chat)
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || !state.detailsOpen) return;
		event.stopPropagation();
		event.preventDefault();
		closeDetails();
	};
	details.addEventListener("keydown", onKeydown);
	unsubscribers.push(() => details.removeEventListener("keydown", onKeydown));
	render();
	void nameTextarea();

	return {
		run,
		element,
		dispose() {
			disposed = true;
			for (const stop of unsubscribers) stop();
		},
	};
}
