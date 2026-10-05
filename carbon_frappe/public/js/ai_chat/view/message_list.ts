// The scrolling list of rows, the processing indicator, the bottom spacer and the
// "scroll to bottom" button, driven by the ChatStore. Pin/spacer/jump decisions are
// computed by ../scroll_policy.ts; this module measures the DOM and applies them. The
// look is MessagesComponent.scss's and the scrolling model messagesAutoScrollController.ts's
// (both Apache-2.0, IBM Corp.).
//
// Markup:
//
//   div.cf-ai-messages                        the scroll container (overflow: hidden auto)
//     button.cf-ai-scroll-handle--top         a tab stop, invisible until focused; Enter focuses the first row
//     button.cf-ai-earlier[hidden]            "Show earlier messages" while the window leaves some out
//     div.cf-ai-list[role=list]               the rows (view/message_row.ts)
//     div.cf-ai-processing[aria-hidden=true]  cds-aichat-processing + label; between turns it is [hidden]
//     button.cf-ai-scroll-handle--bottom      like the top one; Enter focuses the last row
//     div.cf-ai-spacer[aria-hidden=true]      blank space that lets the pinned row reach the top
//     div.cf-ai-scroll-bottom[hidden]         sticky; holds cds-aichat-button "Scroll to bottom"
//
// A conversation loaded wholesale (a restore, a switch) builds only its last ~30 messages
// (scroll_policy.ts windowing); "Show earlier messages" prepends a chunk and keeps the reader's place.
// The container is not a live region: a streamed reply would be read delta by delta. What
// a screen reader hears is decided below (`announce`), from TRANSITIONS of store state.
import type { Announcer } from "../announce.ts";
import { announcementText } from "../announce.ts";
import { el, iconElement, syncChildren } from "../dom.ts";
import { createChatButton, createProcessing } from "../elements.ts";
import { ICONS } from "../icons.ts";
import type { Translate } from "../i18n.ts";
import { pendingApproval } from "../pending.ts";
import {
	USER_SCROLL_AWAY_PX,
	atStreamEnd,
	earlierWindowStart,
	growOnlySpacerHeight,
	hasContentBelow,
	initialWindowStart,
	pinScrollTop,
	scrollTopAfterPrepend,
	spacerHeightFor,
	userScrolledAway,
} from "../scroll_policy.ts";
import type { ChatState, GenericItem, Message } from "../types.ts";
import { isFlowApprovalItem, isInlineErrorItem, isRequest, isResponse, isTextItem } from "../types.ts";
import type { ChatStore } from "../store.ts";
import { createMessageRow } from "./message_row.ts";
import type { MessageRow, MessageRowDeps, RowFlags } from "./message_row.ts";

export interface MessageListDeps {
	store: ChatStore;
	translate: Translate;
	announcer: Announcer;
	/** BCP 47 tag, e.g. `frappe.boot.lang`. */
	locale: string;
	/** IANA zone times are shown in (`readTimeZones(frappe.boot).user`); the browser's when absent. */
	timeZone?: string | undefined;
	onApprovalAnswers(run: string, answers: Readonly<Record<string, string>>): void;
	/** A returned promise is awaited by the row: a rejection un-selects the thumb. Reporting it is the caller's job. */
	onFeedback(run: string, rating: "Up" | "Down" | "None", comment?: string): void | Promise<void>;
	/** Escape from a row, or ArrowDown past the last one: the panel focuses the prompt line. */
	onRequestInputFocus(): void;
	/** Send the last user message again; an error row shows a "Try again" button only when this is given. */
	onRetry?(): void;
}

export interface MessageList {
	/** `div.cf-ai-messages`. The panel slots it into `.cf-ai-body` and hides it while the store is empty. */
	readonly element: HTMLElement;
	/**
	 * Scroll to the end of the real content, drop the spacer and stop treating the position
	 * as pinned. The jump button's action.
	 */
	scrollToBottom(): void;
	/** Focus the last row (the entry point of keyboard navigation: ArrowUp in an empty prompt line). */
	focusLast(): void;
	/** Unsubscribe from the store, disconnect observers and drop every row. */
	dispose(): void;
}

interface RowEntry {
	row: MessageRow;
	message: Message;
	flags: RowFlags;
	/** A row that threw while patching is left as it was instead of throwing on every delta. */
	broken: boolean;
}

/** How long after a conversation loads late-rendering markdown may still move the end. */
const FOLLOW_END_MS = 1500;
/** Markdown renders at most every 100 ms, so the final layout of a reply is this much later than its last delta. */
const SETTLE_DELAY_MS = 250;
/** How much of an error's text is read aloud; the rest is on screen. */
const ERROR_ANNOUNCE_CHARS = 160;

function sameFlags(a: RowFlags, b: RowFlags): boolean {
	return a.first === b.first && a.last === b.last && a.streaming === b.streaming;
}

function itemsOf(message: Message | undefined): readonly GenericItem[] {
	return message !== undefined && isResponse(message) ? message.output.generic : [];
}

function itemKey(item: GenericItem, index: number): string {
	return `${item.response_type}:${item.streaming_metadata?.id ?? `#${index}`}`;
}

function lastById(messages: readonly Message[], id: string): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.id === id) return message;
	}
	return undefined;
}

/** Whether the reply is waiting on the model: no text under way and no tool running. */
function awaitsModel(response: Message | undefined): boolean {
	if (response === undefined || !isResponse(response)) return true;
	const generic = response.output.generic;
	if (isTextItem(generic[generic.length - 1])) return false;
	return !(response.message_options?.chain_of_thought ?? []).some((step) => step.status === "processing");
}

export function createMessageList(deps: MessageListDeps): MessageList {
	const __ = deps.translate;
	const { store, announcer } = deps;

	const element = el("div", "cf-ai-messages");
	const listEl = el("div", "cf-ai-list");
	listEl.setAttribute("role", "list");

	const motion = window.matchMedia("(prefers-reduced-motion: no-preference)");
	const motionAllowed = (): boolean => motion.matches;

	const processing = el("div", "cf-ai-processing");
	processing.setAttribute("aria-hidden", "true");
	processing.hidden = true;
	const dots = createProcessing();
	// Carbon orders its reduced-motion override before the looping rule at equal specificity, so
	// the loop wins and the dots never stop; the component's shadow CSS is out of our reach
	dots.loop = motionAllowed();
	const onMotionChange = (): void => {
		dots.loop = motionAllowed();
	};
	motion.addEventListener("change", onMotionChange);
	dots.quickLoad = true;
	const processingLabel = el("span", "cf-ai-processing__label");
	processingLabel.textContent = __("Thinking…");
	processing.append(dots, processingLabel);

	const handle = (end: "top" | "bottom", text: string, label: string, action: string): HTMLButtonElement => {
		const button = el("button", `cf-ai-scroll-handle cf-ai-scroll-handle--${end}`, text);
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.dataset["action"] = action;
		button.hidden = true;
		return button;
	};
	const topHandle = handle(
		"top",
		__("Beginning of the conversation"),
		__(
			"Beginning of the conversation. Press Enter to move to the first message, then use the arrow keys to move between messages. Press Escape to return to the message field.",
		),
		"focus-first",
	);
	const bottomHandle = handle(
		"bottom",
		__("End of the conversation"),
		__(
			"End of the conversation. Press Enter to move to the last message, then use the arrow keys to move between messages. Press Escape to return to the message field.",
		),
		"focus-last",
	);

	const earlierButton = el("button", "cf-ai-earlier cds--btn cds--btn--sm cds--btn--ghost");
	earlierButton.type = "button";
	earlierButton.dataset["action"] = "show-earlier";
	earlierButton.hidden = true;

	const spacer = el("div", "cf-ai-spacer");
	spacer.setAttribute("aria-hidden", "true");

	const jump = el("div", "cf-ai-scroll-bottom");
	jump.hidden = true;
	const jumpButton = createChatButton();
	jumpButton.size = "sm";
	jumpButton.kind = "secondary";
	jumpButton.setAttribute("aria-label", __("Scroll to bottom"));
	// the shadow root's own <button> takes no name from the host's aria-label, so the glyph carries it
	jumpButton.append(iconElement(ICONS.arrowDown16, { slot: "icon", "aria-label": __("Scroll to bottom") }));
	jump.append(jumpButton);

	element.append(topHandle, earlierButton, listEl, processing, bottomHandle, spacer, jump);

	const rowDeps: MessageRowDeps = {
		translate: deps.translate,
		locale: deps.locale,
		timeZone: deps.timeZone,
		announcer,
		onApprovalAnswers: (run, answers) => deps.onApprovalAnswers(run, answers),
		onRequestInputFocus: () => deps.onRequestInputFocus(),
		onFeedback: (run, rating, comment) => deps.onFeedback(run, rating, comment),
		...(deps.onRetry !== undefined && { onRetry: () => deps.onRetry?.() }),
	};

	// -- scroll state -----------------------------------------------------------

	/** The auto behaviours (spacer growth, re-pin at stream end) apply. */
	let pinned = false;
	let pinnedRow: HTMLElement | null = null;
	let pinnedScrollTop = 0;
	let pinnedRowHeight = 0;
	/** A pin was asked for while the container had no height (hidden); the next resize applies it. */
	let pendingPin = false;
	let spacerHeight = 0;
	/** A conversation just loaded: keep the end in view while its markdown renders. */
	let followEnd = false;
	let followTimer: ReturnType<typeof setTimeout> | undefined;
	/** The scrollTop of our own last write, so its scroll event is not mistaken for the reader's. */
	let expectedScrollTop: number | null = null;
	let expectedFrame = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The row that was on screen when earlier messages were prepended, and where in the viewport it
	 * was. Markdown renders after the rows are inserted, above the reader. The browser's own scroll
	 * anchoring is switched off meanwhile: it corrects part of that growth (Chrome ends up ~70px off),
	 * not all of it, and Safari has none, so one mechanism does the job everywhere.
	 */
	let anchorHold: { row: HTMLElement; viewportOffset: number } | null = null;
	let anchorTimer: ReturnType<typeof setTimeout> | undefined;

	/** `target`'s top edge within the scroller's scrolling area (offsetTop is relative to the wrong ancestor). */
	function offsetWithin(target: HTMLElement): number {
		return target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
	}

	function setSpacer(height: number): void {
		if (height === spacerHeight) return;
		spacerHeight = height;
		// the CSSOM, not the style attribute: allowed under a style-src without 'unsafe-inline'
		spacer.style.blockSize = `${height}px`;
	}

	function setScrollTop(top: number): void {
		element.scrollTop = top;
		expectedScrollTop = element.scrollTop;
		if (expectedFrame === 0) {
			// the scroll event of this write fires before the next frame's callbacks
			expectedFrame = requestAnimationFrame(() => {
				expectedFrame = 0;
				expectedScrollTop = null;
			});
		}
	}

	function maxScrollTop(): number {
		return element.scrollHeight - element.clientHeight;
	}

	function updateJump(): void {
		const show = hasContentBelow({
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
			scrollTop: element.scrollTop,
			spacerHeight,
		});
		if (jump.hidden === !show) return;
		// a button that disappears under the keyboard would drop focus to <body>
		if (!show && document.activeElement === jumpButton) deps.onRequestInputFocus();
		jump.hidden = !show;
	}

	function applyPin(): void {
		if (pinnedRow === null) return;
		const viewport = element.clientHeight;
		if (viewport === 0) {
			pendingPin = true;
			return;
		}
		pendingPin = false;
		pinnedRowHeight = pinnedRow.offsetHeight;
		// The chips under a sent question are not part of how long it is: counted, two or three of them
		// make the row "tall" and the pin scrolls the question itself out of sight.
		const filesHeight = pinnedRow.querySelector<HTMLElement>(".cf-ai-message__files")?.offsetHeight ?? 0;
		const top = pinScrollTop(offsetWithin(pinnedRow), pinnedRowHeight - filesHeight, viewport);
		pinnedScrollTop = top;
		// the spacer first: without it the browser caps scrollTop at the end of the content
		setSpacer(spacerHeightFor(offsetWithin(spacer), top, viewport));
		setScrollTop(top);
	}

	function pinTo(row: HTMLElement): void {
		followEnd = false;
		releaseAnchor();
		pinned = true;
		pinnedRow = row;
		applyPin();
	}

	function scrollToEnd(): void {
		setSpacer(0);
		setScrollTop(maxScrollTop());
	}

	function resetScroll(): void {
		releaseAnchor();
		pinned = false;
		pinnedRow = null;
		pendingPin = false;
		followEnd = false;
		setSpacer(0);
		setScrollTop(0);
	}

	function startFollowingEnd(): void {
		releaseAnchor();
		pinned = false;
		pinnedRow = null;
		followEnd = true;
		clearTimeout(followTimer);
		followTimer = setTimeout(() => {
			followEnd = false;
		}, FOLLOW_END_MS);
		scrollToEnd();
	}

	/** The stream is over: put the pin back, or trim the spacer to what the reader's position needs. */
	function settle(): void {
		if (pinned && pinnedRow !== null) {
			const decision = atStreamEnd({
				scrollTop: element.scrollTop,
				pinnedScrollTop,
				maxScrollTop: maxScrollTop(),
			});
			if (decision === "re-pin") {
				applyPin();
				return;
			}
		}
		setSpacer(spacerHeightFor(offsetWithin(spacer), element.scrollTop, element.clientHeight));
	}

	function releaseAnchor(): void {
		anchorHold = null;
		clearTimeout(anchorTimer);
		element.style.overflowAnchor = "";
	}

	function onResize(): void {
		if (anchorHold !== null) {
			const drift = offsetWithin(anchorHold.row) - element.scrollTop - anchorHold.viewportOffset;
			if (Math.abs(drift) >= 1) setScrollTop(element.scrollTop + drift);
		}
		if (pendingPin) {
			applyPin();
		} else if (followEnd) {
			scrollToEnd();
		} else if (pinned && pinnedRow !== null) {
			// The pinned row's markdown renders after it is inserted. Its top is fixed but a tall
			// row changes the pin, so re-pin once it has its final height, unless the reader moved.
			const heightChanged = pinnedRow.offsetHeight !== pinnedRowHeight;
			if (heightChanged && Math.abs(element.scrollTop - pinnedScrollTop) <= USER_SCROLL_AWAY_PX) {
				applyPin();
			} else {
				const needed = growOnlySpacerHeight({
					scrollHeight: element.scrollHeight,
					clientHeight: element.clientHeight,
					spacerHeight,
					pinnedScrollTop,
				});
				if (needed > spacerHeight) setSpacer(needed);
			}
		}
		updateJump();
	}

	function onScroll(): void {
		const top = element.scrollTop;
		if (expectedScrollTop !== null) {
			const expected = expectedScrollTop;
			expectedScrollTop = null;
			if (Math.abs(top - expected) <= 1) {
				updateJump();
				return;
			}
		}
		// the reader moved it: stop chasing the end of a freshly loaded conversation
		followEnd = false;
		releaseAnchor();
		if (pinnedRow !== null) {
			const away = userScrolledAway({ scrollTop: top, pinnedScrollTop, maxScrollTop: maxScrollTop() });
			if (away !== null) pinned = !away;
		}
		updateJump();
	}

	function scrollToBottom(): void {
		followEnd = false;
		releaseAnchor();
		pinned = false;
		setSpacer(0);
		const top = maxScrollTop();
		if (motionAllowed()) element.scrollTo({ top, behavior: "smooth" });
		else setScrollTop(top);
	}

	// -- announcements ----------------------------------------------------------

	/** A response finished streaming; what is said about it waits for the store to reach `ready`. */
	let completing: string | null = null;

	function announceItems(next: Message, previous: Message | undefined): void {
		if (!isResponse(next)) return;
		const before = itemsOf(previous);
		const had = new Set(before.map(itemKey));
		const hadStopped = before.some((item) => item.streaming_metadata?.stream_stopped === true);
		let stopped = false;
		next.output.generic.forEach((item, index) => {
			if (item.streaming_metadata?.stream_stopped === true) stopped = true;
			if (had.has(itemKey(item, index))) return;
			if (isInlineErrorItem(item)) {
				// the server's text can be a provider's whole exception chain: say the start of it
				const detail = announcementText(item.text ?? "", ERROR_ANNOUNCE_CHARS);
				announcer.announce(
					detail === ""
						? __("Something went wrong. Please try again.")
						: __("The assistant ran into a problem: {0}", [detail]),
					"assertive",
				);
			} else if (isFlowApprovalItem(item) && item.user_defined.answers === undefined) {
				announcer.announce(__("The assistant needs your approval to continue."), "assertive");
			}
		});
		if (stopped && !hadStopped) announcer.announce(__("Response stopped"));
	}

	function announceCompletion(state: ChatState, id: string): void {
		const response = lastById(state.messages, id);
		if (response === undefined || !isResponse(response)) return;
		const generic = response.output.generic;
		// stops, failures and pauses have their own announcement
		if (generic.some((item) => item.streaming_metadata?.stream_stopped === true)) return;
		if (generic.some(isInlineErrorItem)) return;
		if (pendingApproval(state.messages) !== undefined) return;
		let text = "";
		for (let i = generic.length - 1; i >= 0 && text === ""; i--) {
			const item = generic[i];
			if (isTextItem(item) && item.text !== undefined) text = announcementText(item.text, 1000);
		}
		announcer.announce(text === "" ? __("Assistant finished.") : __("Assistant said: {0}", [text]));
	}

	function announce(before: ChatState, next: ChatState): void {
		// a conversation being loaded is not news
		if (next.status === "loading") {
			completing = null;
			return;
		}
		if (before.activeResponseId === null && next.activeResponseId !== null) {
			completing = null;
			announcer.announce(__("Assistant is responding…"));
		} else if (before.activeResponseId !== null && next.activeResponseId === null) {
			completing = before.activeResponseId;
		}

		if (next.messages !== before.messages) {
			next.messages.forEach((message, index) => {
				const old = before.messages[index];
				if (message === old) return;
				const earlier =
					old?.id === message.id || message.id === undefined ? old : lastById(before.messages, message.id);
				announceItems(message, earlier);
			});
		}

		if (completing !== null) {
			if (next.status === "ready") {
				announceCompletion(next, completing);
				completing = null;
			} else if (next.status === "error" || next.activeResponseId !== null) {
				completing = null;
			}
		}
	}

	// -- rows -------------------------------------------------------------------

	let frame = 0;
	/** The messages were replaced wholesale by a load: scroll to the end instead of pinning. */
	let hydrating = store.get().messages.length > 0;
	/** A turn ended since the last flush: put the pin back or trim the spacer. */
	let settleDue = false;

	const rows = new Map<string, RowEntry>();
	/** Messages whose row could not be built: retrying on every delta would only repeat the error. */
	const failedIds = new Set<string>();

	function processingVisible(state: ChatState): boolean {
		if (state.status === "submitted") return true;
		if (state.status !== "streaming") return false;
		const id = state.activeResponseId;
		return id === null ? false : awaitsModel(lastById(state.messages, id));
	}

	/** The index in the store's messages of the first one that has a row. */
	let windowStart = 0;

	function isTurnStart(index: number): boolean {
		return isRequest(store.get().messages[index]);
	}

	function updateEarlier(): void {
		const hiddenCount = windowStart;
		earlierButton.hidden = hiddenCount === 0;
		if (hiddenCount === 0) return;
		earlierButton.textContent = __("Show earlier messages ({0})", [String(hiddenCount)]);
	}

	/** `prepending`: rows for earlier messages were added above; the reader's place is restored by the caller. */
	function flush(prepending = false): void {
		frame = 0;
		const state = store.get();
		const messages = state.messages;

		if (hydrating || messages.length === 0) windowStart = initialWindowStart(messages.length, isTurnStart);
		windowStart = Math.min(windowStart, messages.length);

		const ids = new Set<string>();
		for (let index = windowStart; index < messages.length; index++) {
			const id = messages[index]?.id;
			if (id !== undefined) ids.add(id);
		}
		for (const [id, entry] of rows) {
			if (ids.has(id)) continue;
			entry.row.dispose();
			rows.delete(id);
		}

		const ordered: HTMLElement[] = [];
		let newRequest: HTMLElement | null = null;
		for (let index = windowStart; index < messages.length; index++) {
			const message = messages[index];
			const id = message?.id;
			if (message === undefined || id === undefined || failedIds.has(id)) continue;
			const flags: RowFlags = {
				first: index === windowStart,
				last: index === messages.length - 1,
				streaming: id === state.activeResponseId,
			};
			let entry = rows.get(id);
			if (entry === undefined) {
				try {
					entry = { row: createMessageRow(message, flags, rowDeps), message, flags, broken: false };
				} catch (error) {
					console.error(error);
					failedIds.add(id);
					continue;
				}
				rows.set(id, entry);
				if (isRequest(message)) newRequest = entry.row.element;
			} else if (!entry.broken && (entry.message !== message || !sameFlags(entry.flags, flags))) {
				try {
					entry.row.update(message, flags);
				} catch (error) {
					console.error(error);
					entry.broken = true;
				}
				entry.message = message;
				entry.flags = flags;
			}
			ordered.push(entry.row.element);
		}
		syncChildren(listEl, ordered);
		updateEarlier();
		topHandle.hidden = ordered.length === 0;
		bottomHandle.hidden = ordered.length === 0;

		const visible = processingVisible(state);
		if (processing.hidden === visible) processing.hidden = !visible;

		if (messages.length === 0) {
			resetScroll();
		} else if (prepending) {
			// the caller measures and restores the scroll position
		} else if (hydrating) {
			startFollowingEnd();
		} else if (newRequest !== null) {
			pinTo(newRequest);
		}
		hydrating = false;

		if (settleDue) {
			settleDue = false;
			settle();
			clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				const current = store.get();
				if (current.status === "ready" && current.activeResponseId === null) {
					settle();
					updateJump();
				}
			}, SETTLE_DELAY_MS);
		}
		updateJump();
	}

	function schedule(): void {
		if (frame === 0) frame = requestAnimationFrame(() => flush());
	}

	/** "Show earlier messages": build one more chunk above, keep the row the reader was at where it was. */
	function showEarlier(): void {
		if (windowStart === 0) return;
		// anything still pending is applied first, so the measurement below is of what is on screen
		if (frame !== 0) {
			cancelAnimationFrame(frame);
			flush();
		}
		const anchor = listEl.firstElementChild;
		if (!(anchor instanceof HTMLElement)) return;
		const scrollTop = element.scrollTop;
		const offsetBefore = offsetWithin(anchor);
		const viewportOffset = offsetBefore - scrollTop;

		followEnd = false;
		releaseAnchor();
		element.style.overflowAnchor = "none";
		windowStart = earlierWindowStart(windowStart, isTurnStart);
		flush(true);

		const offsetAfter = offsetWithin(anchor);
		setScrollTop(scrollTopAfterPrepend(scrollTop, offsetBefore, offsetAfter));
		// the pin is a scrollTop: it moved down with the row it pins
		pinnedScrollTop += offsetAfter - offsetBefore;
		anchorHold = { row: anchor, viewportOffset };
		anchorTimer = setTimeout(releaseAnchor, FOLLOW_END_MS);
		anchor.focus({ preventScroll: true });
		announcer.announce(__("Earlier messages shown"));
	}

	let previous = store.get();
	const unsubscribe = store.subscribe(() => {
		const next = store.get();
		const before = previous;
		previous = next;

		if (next.messages !== before.messages && next.status === "loading") hydrating = true;
		// a resume continues a reply that is already on screen: it keeps the reader's place
		const resumed = next.activeResponseId;
		if (before.activeResponseId === null && resumed !== null && rows.has(resumed)) pinned = false;
		const turnEnded =
			(before.activeResponseId !== null && next.activeResponseId === null) ||
			((before.status === "submitted" || before.status === "streaming") &&
				(next.status === "ready" || next.status === "error"));
		if (turnEnded) settleDue = true;

		try {
			announce(before, next);
		} catch (error) {
			// announcing is a courtesy; it must never stop the list from drawing
			console.error(error);
		}
		schedule();
	});

	// -- observers and events ---------------------------------------------------

	const resizeObserver = new ResizeObserver(onResize);
	resizeObserver.observe(listEl);
	resizeObserver.observe(processing);
	resizeObserver.observe(element);
	element.addEventListener("scroll", onScroll, { passive: true });
	jumpButton.addEventListener("click", scrollToBottom);

	earlierButton.addEventListener("click", showEarlier);

	function rowElements(): HTMLElement[] {
		return Array.from(listEl.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
	}

	function focusRow(row: HTMLElement | undefined): void {
		row?.focus();
	}

	function focusFirst(): void {
		focusRow(rowElements()[0]);
	}

	function focusLast(): void {
		focusRow(rowElements().pop());
	}

	topHandle.addEventListener("click", focusFirst);
	bottomHandle.addEventListener("click", focusLast);

	function onKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		const target = event.target;
		if (!(target instanceof Element)) return;

		const handleTarget = target === topHandle || target === bottomHandle;
		if (handleTarget || target === earlierButton || target.closest(".cf-ai-scroll-bottom") !== null) {
			if (event.key === "Escape") {
				event.stopPropagation();
				event.preventDefault();
				deps.onRequestInputFocus();
			} else if (handleTarget && (event.key === "Enter" || event.key === " ")) {
				// keydown, not click: Space would scroll the list before the click it ends in
				event.preventDefault();
				if (target === topHandle) focusFirst();
				else focusLast();
			}
			return;
		}

		const row = target.closest(".cf-ai-message");
		if (row === null) return;

		if (event.key === "Escape") {
			// inside a row: back to the prompt line, and the panel stays open
			event.stopPropagation();
			event.preventDefault();
			deps.onRequestInputFocus();
			return;
		}
		if (target !== row || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

		const all = rowElements();
		const index = all.findIndex((candidate) => candidate === row);
		if (index === -1) return;
		switch (event.key) {
			case "ArrowUp":
				// the first built row is not the first message while earlier ones are hidden
				if (index === 0 && !earlierButton.hidden) earlierButton.focus();
				else focusRow(all[Math.max(0, index - 1)]);
				break;
			case "ArrowDown":
				if (index === all.length - 1) deps.onRequestInputFocus();
				else focusRow(all[index + 1]);
				break;
			case "Home":
				focusRow(all[0]);
				break;
			case "End":
				focusRow(all[all.length - 1]);
				break;
			case "Enter":
			case " ":
				// nothing to activate, but Space would scroll the list
				break;
			default:
				return;
		}
		event.preventDefault();
	}
	element.addEventListener("keydown", onKeydown);

	schedule();

	return {
		element,
		scrollToBottom,
		focusLast,
		dispose() {
			unsubscribe();
			motion.removeEventListener("change", onMotionChange);
			resizeObserver.disconnect();
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("keydown", onKeydown);
			jumpButton.removeEventListener("click", scrollToBottom);
			earlierButton.removeEventListener("click", showEarlier);
			topHandle.removeEventListener("click", focusFirst);
			bottomHandle.removeEventListener("click", focusLast);
			cancelAnimationFrame(frame);
			cancelAnimationFrame(expectedFrame);
			clearTimeout(followTimer);
			clearTimeout(settleTimer);
			releaseAnchor();
			for (const entry of rows.values()) entry.row.dispose();
			rows.clear();
			listEl.replaceChildren();
		},
	};
}
