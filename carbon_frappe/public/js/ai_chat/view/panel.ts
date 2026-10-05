// The chat shell: Carbon's <cds-aichat-shell> with our header, our message area and the
// prompt line, wired to the controller and the store. The only view that knows the
// others exist.
//
// Markup (all children are LIGHT DOM of the shell, slotted, so the lazy stylesheet reaches them):
//
//   cds-aichat-shell.cf-ai-shell[ai-enabled][corner-all=square][messages-aria-label]
//     cds-aichat-chat-header[slot=header].cf-ai-header     actions: Conversation history, New chat,
//                                                           Expand/Collapse, Close
//     div.cf-ai-body[slot=messages]                        flex column, fills the messages slot
//       div.cf-ai-home                                      view/home.ts, shown while the store is empty
//       div.cf-ai-messages                                  view/message_list.ts, shown otherwise
//       div.cf-ai-status                                    shown when restoring the saved conversation failed:
//                                                           an inline notification and a "Try again" button
//                                                           (the class is the host's, desk/_ai-chat.scss)
//       div.cf-ai-history[hidden]                           view/history.ts, laid over the three above
//                                                           (they are `inert` while it is open)
//       div.cf-ai-announcer.cf-ai-visually-hidden           the live regions (announce.ts)
//       div.cf-ai-drop[hidden]                              while a file drag is over the shell
//     cds-aichat-prompt-line-shell[slot=input].cf-ai-input
//       cds-aichat-prompt-line[slot=editor]
//       cds-aichat-input-send-control[slot=send-control]
//       the attach button, chips, progress strip and error line (view/attachments.ts), only when
//       flow listed the file types it reads
//
// The announcer sits in the messages slot, not directly under the shell: the shell renders
// only named slots, and a child assigned to none is not in the flat tree, so a live region
// there would never reach assistive technology.
import { createAnnouncer } from "../announce.ts";
import type { Controller } from "../controller.ts";
import { createErrorNotification, el } from "../dom.ts";
import {
	EVENTS,
	createChatHeader,
	createPromptLine,
	createPromptLineShell,
	createSendControl,
	createShell,
	isPromptChangeDetail,
	isPromptKeydownDetail,
	listenDetail,
} from "../elements.ts";
import type { HeaderAction } from "../elements.ts";
import { ICONS } from "../icons.ts";
import type { Translate } from "../i18n.ts";
import { pendingApproval } from "../pending.ts";
import type { ChatStore } from "../store.ts";
import type { ChatState, ChatStatus } from "../types.ts";
import type { UploadLimits } from "../uploads.ts";
import { createAttachments } from "./attachments.ts";
import { createHistoryView } from "./history.ts";
import { createHome } from "./home.ts";
import { createMessageList } from "./message_list.ts";

export interface PanelDeps {
	controller: Controller;
	store: ChatStore;
	translate: Translate;
	/** BCP 47 tag, e.g. `frappe.boot.lang`. */
	locale: string;
	/** IANA zone times are shown in (`readTimeZones(frappe.boot).user`); the browser's when absent. */
	timeZone?: string | undefined;
	firstName: string;
	canConfigure: boolean;
	/** `controller.uploadLimits`. Null: no attach button, no drop target, no paste handling. */
	uploadLimits: UploadLimits | null;
	/** The saved expanded state. */
	expanded: boolean;
	/** Resolves with the number of enabled Flow Agents; rejects are treated as "unknown" (ready mode). */
	countAgents(): Promise<number>;
	/** Tell the user about a failure that has no place in the conversation (a rejected thumbs call). */
	notify(message: string): void;
	onRequestClose(): void;
	/** After the header button flipped the state and its own icon. */
	onExpandedChange(expanded: boolean): void;
}

export interface Panel {
	/** The `cds-aichat-shell`. The caller appends it to the host. */
	readonly element: HTMLElement;
	focusInput(): void;
	dispose(): void;
}

type View = "loading" | "home" | "list" | "error";

/** Where focus goes when the conversation list closes; "none" when something else is about to take it. */
type FocusAfterClose = "toggle" | "input" | "none";

/** What fills the messages slot. A restored conversation outranks the loading and error states. */
function viewOf(state: ChatState): View {
	if (state.messages.length > 0) return "list";
	if (state.status === "loading") return "loading";
	if (state.status === "error") return "error";
	return "home";
}

const isTurnLive = (status: ChatStatus): boolean => status === "submitted" || status === "streaming";

/** A rejection's own message (the controller's are already translated), else `fallback`. */
function reasonOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** Frames to keep trying to focus the prompt line: the textarea is created on its first render, a tick after upgrade. */
const FOCUS_ATTEMPTS = 20;

export function createPanel(deps: PanelDeps): Panel {
	const __ = deps.translate;
	const { controller, store } = deps;
	let expanded = deps.expanded;
	let historyOpen = false;
	let disposed = false;
	const cleanups: (() => void)[] = [];

	const shell = createShell();
	shell.className = "cf-ai-shell";
	shell.aiEnabled = true;
	shell.cornerAll = "square";
	shell.messagesAriaLabel = __("Chat messages");
	shell.contentMaxWidth = expanded;

	// -- header -----------------------------------------------------------------

	const header = createChatHeader();
	header.slot = "header";
	header.className = "cf-ai-header";
	header.headerTitle = __("AI assistant");
	header.overflow = false;

	const HISTORY = "cf-ai-history";
	const NEW_CHAT = "cf-ai-new-chat";
	const EXPAND = "cf-ai-expand";
	const CLOSE = "cf-ai-close";

	function headerActions(): HeaderAction[] {
		const toggle: HeaderAction = expanded
			? { text: __("Collapse"), icon: ICONS.minimize16, onClick: toggleExpanded, fixed: true, testId: EXPAND }
			: { text: __("Expand"), icon: ICONS.maximize16, onClick: toggleExpanded, fixed: true, testId: EXPAND };
		return [
			{
				text: __("Conversation history"),
				icon: ICONS.history16,
				onClick: toggleHistory,
				fixed: true,
				isSelected: historyOpen,
				// A switch needs a settled conversation; the list also closes when a turn goes live.
				disabled: isTurnLive(store.get().status),
				testId: HISTORY,
			},
			{ text: __("New chat"), icon: ICONS.add16, onClick: newChat, fixed: true, testId: NEW_CHAT },
			toggle,
			{
				text: __("Close"),
				icon: ICONS.close16,
				onClick: () => deps.onRequestClose(),
				fixed: true,
				testId: CLOSE,
			},
		];
	}

	/** The rendered icon button of a header action; the toolbar sits in the header's shadow root. */
	function headerButton(testId: string): Element | null | undefined {
		const toolbar = header.shadowRoot?.querySelector("cds-aichat-toolbar");
		return toolbar?.shadowRoot?.querySelector(`[data-testid="${testId}"]`);
	}

	/**
	 * The toolbar keys its buttons by label, so renaming Expand to Collapse replaces the
	 * button that has focus. Put focus back on its successor once the toolbar rendered it:
	 * Lit renders in a microtask, so by the next frame the old button is gone.
	 */
	function refocusHeaderAction(testId: string, attempt = 0): void {
		requestAnimationFrame(() => {
			if (disposed) return;
			const button = headerButton(testId);
			if (button instanceof HTMLElement) button.focus();
			else if (attempt < FOCUS_ATTEMPTS) refocusHeaderAction(testId, attempt + 1);
		});
	}

	/**
	 * The toolbar of @carbon/ai-chat-components 1.11.0 ignores `isSelected` (1.12 renders it), and
	 * cds-button would write a bare `aria-pressed=""` from it, which assistive technology does not
	 * read as a state. So the state is set on the rendered button here; Lit leaves it alone because
	 * cds-button's own binding of that attribute stays `undefined`. Drop this once the toolbar
	 * renders a real `aria-pressed`.
	 */
	let pressedFrame = 0;
	function syncHistoryPressed(attempt = 0): void {
		cancelAnimationFrame(pressedFrame);
		pressedFrame = requestAnimationFrame(() => {
			if (disposed) return;
			const host = headerButton(HISTORY);
			const button = host?.shadowRoot?.querySelector("button");
			if (host === null || host === undefined || button === null || button === undefined) {
				if (attempt < FOCUS_ATTEMPTS) syncHistoryPressed(attempt + 1);
				return;
			}
			host.setAttribute("data-pressed", String(historyOpen));
			button.setAttribute("aria-pressed", String(historyOpen));
			button.classList.toggle("cds--btn--selected", historyOpen);
		});
	}

	function applyHeader(): void {
		header.actions = headerActions();
		syncHistoryPressed();
	}

	function applyExpanded(): void {
		shell.contentMaxWidth = expanded;
		applyHeader();
	}

	function toggleExpanded(): void {
		expanded = !expanded;
		applyExpanded();
		deps.onExpandedChange(expanded);
		refocusHeaderAction(EXPAND);
	}

	// -- body -------------------------------------------------------------------

	const body = el("div", "cf-ai-body");
	body.slot = "messages";

	const announcerHost = el("div", "cf-ai-announcer cf-ai-visually-hidden");

	const promptLineShell = createPromptLineShell();
	promptLineShell.slot = "input";
	promptLineShell.className = "cf-ai-input";
	const promptLine = createPromptLine();
	promptLine.slot = "editor";
	promptLine.ariaLabel = __("Message the assistant");
	promptLine.placeholder = __("Ask the assistant…");
	const sendControl = createSendControl();
	sendControl.slot = "send-control";
	sendControl.buttonLabel = __("Send");
	sendControl.stopResponseLabel = __("Stop response");

	let focusFrame = 0;
	// Element that held focus when a focus request met the prompt while it was off for the first
	// hydration; undefined when nothing waits.
	let deferredFocusFrom: Element | null | undefined;
	function focusInput(attempt = 0): void {
		cancelAnimationFrame(focusFrame);
		if (disposed) return;
		// Hydration can outlast the frame budget below, so wait for the prompt instead of racing it.
		if (store.get().status === "loading" && attempt === 0) {
			deferredFocusFrom = document.activeElement;
			return;
		}
		promptLine.focus();
		if (promptLine.hasFocus() || attempt >= FOCUS_ATTEMPTS) return;
		// Someone else took focus meanwhile (a click elsewhere): do not fight them for it.
		const active = document.activeElement;
		if (active !== null && active !== document.body && !shell.contains(active)) return;
		focusFrame = requestAnimationFrame(() => focusInput(attempt + 1));
	}

	body.append(announcerHost);
	shell.append(header, body, promptLineShell);
	promptLineShell.append(promptLine, sendControl);
	const announcer = createAnnouncer(announcerHost);

	const attachments =
		deps.uploadLimits === null
			? null
			: createAttachments({
					translate: __,
					locale: deps.locale,
					limits: deps.uploadLimits,
					store,
					controller,
					announcer,
					shell,
					promptLineShell,
					promptLine,
					focusInput: () => focusInput(),
				});
	if (attachments !== null) {
		promptLineShell.append(...attachments.composerChildren);
		body.append(attachments.dropOverlay);
	}

	const home = createHome({
		translate: __,
		firstName: deps.firstName,
		canConfigure: deps.canConfigure,
		onStarter: (text) => {
			if (uploadsBlockSend()) return;
			attachments?.clearRefusal();
			closeHistory("none");
			void controller.send(text);
			focusInput();
		},
	});
	const list = createMessageList({
		store,
		translate: __,
		announcer,
		locale: deps.locale,
		timeZone: deps.timeZone,
		onApprovalAnswers: (run, answers) => {
			void controller.answer(run, answers);
		},
		// Rethrown after notifying: the row un-selects the thumb only when the promise rejects.
		onFeedback: (run, rating, comment) =>
			controller.submitFeedback(run, rating, comment).catch((error: unknown) => {
				console.error(error);
				deps.notify(error instanceof Error ? error.message : __("Something went wrong. Please try again."));
				throw error;
			}),
		onRequestInputFocus: () => focusInput(),
		onRetry: () => {
			void controller.retryLast();
			// The Try again button that held focus is gone once the failed turn is replaced.
			focusInput();
		},
	});

	// -- conversation list --------------------------------------------------------

	const history = createHistoryView({
		model: controller.history,
		store,
		translate: __,
		locale: deps.locale,
		timeZone: deps.timeZone,
		announcer,
		onSelect: async (id) => {
			try {
				if (!(await controller.selectSession(id))) return false;
			} catch (error) {
				console.error(error);
				const message = reasonOf(error, __("Could not open this conversation."));
				deps.notify(message);
				announcer.announce(message, "assertive");
				return false;
			}
			const title = controller.history.get().items.find((item) => item.id === id)?.title;
			closeHistory("input");
			announcer.announce(__("Conversation opened: {0}", [title ?? __("Untitled conversation")]));
			return true;
		},
		onNewChat: () => newChat(),
		onRename: async (id, title) => {
			try {
				await controller.renameSession(id, title);
			} catch (error) {
				deps.notify(reasonOf(error, __("Could not rename this conversation.")));
				throw error;
			}
			announcer.announce(__("Conversation renamed"));
		},
		onDelete: async (id) => {
			try {
				await controller.deleteSession(id);
			} catch (error) {
				deps.notify(reasonOf(error, __("Could not delete this conversation.")));
				throw error;
			}
			announcer.announce(__("Conversation deleted"));
		},
		onRetry: () => void controller.loadHistory(),
		onClose: () => closeHistory("toggle"),
	});
	history.element.hidden = true;
	body.append(history.element);

	/** The overlay covers these; without `inert` Tab and screen-reader browsing would still reach them. */
	function coverBehindHistory(covered: boolean): void {
		for (const element of [home.element, list.element, loadError]) element.inert = covered;
	}

	function openHistory(): void {
		if (historyOpen || isTurnLive(store.get().status)) return;
		historyOpen = true;
		history.element.hidden = false;
		coverBehindHistory(true);
		applyHeader();
		void controller.loadHistory();
		history.focusEntry();
		announcer.announce(__("Conversation history opened"));
	}

	function closeHistory(focus: FocusAfterClose): void {
		if (!historyOpen) return;
		historyOpen = false;
		history.element.hidden = true;
		coverBehindHistory(false);
		applyHeader();
		if (focus === "toggle") {
			refocusHeaderAction(HISTORY);
			announcer.announce(__("Conversation history closed"));
		} else if (focus === "input") {
			focusInput();
		}
	}

	function toggleHistory(): void {
		if (historyOpen) closeHistory("toggle");
		else openHistory();
	}

	// -- hydration failure ------------------------------------------------------

	const loadError = el("div", "cf-ai-status");
	loadError.hidden = true;
	const loadErrorTitle = __("Could not load the conversation.");
	const notification = createErrorNotification({ title: loadErrorTitle });
	notification.element.setAttribute("role", "alert");
	const retry = el("button", "cds--btn cds--btn--sm cds--btn--ghost", __("Try again"));
	retry.type = "button";
	retry.dataset["action"] = "retry-hydration";
	const retryActions = el("div", "cf-ai-status__actions");
	retryActions.append(retry);
	loadError.append(notification.element, retryActions);
	body.prepend(home.element, list.element, loadError);

	const onRetry = (): void => void controller.start();
	retry.addEventListener("click", onRetry);
	cleanups.push(() => retry.removeEventListener("click", onRetry));

	// -- home -------------------------------------------------------------------

	// No Flow Agent exists: a send that starts a session would only fail server-side, so the prompt
	// stays off until one does. A restored session carries its own agent and keeps working.
	let setup = false;
	let probeToken = 0;
	function probeAgents(): void {
		probeToken += 1;
		const mine = probeToken;
		Promise.resolve()
			.then(() => deps.countAgents())
			.then(
				(count) => (count === 0 ? "setup" : "ready"),
				// A failed probe must not block chat: the first send reports whatever is wrong.
				() => "ready",
			)
			.then((mode) => {
				if (disposed || mine !== probeToken) return;
				setup = mode === "setup";
				home.setMode(setup ? "setup" : "ready");
				applyInput();
			});
	}
	home.setMode("loading");
	probeAgents();

	// -- store -> DOM -----------------------------------------------------------

	function applyView(view: View): void {
		home.element.hidden = view !== "home";
		list.element.hidden = view !== "list";
		loadError.hidden = view !== "error";
	}

	let approvalPending = false;
	const setupBlocks = (): boolean => setup && store.get().session === null;
	const promptOff = (): boolean => store.get().status === "loading" || setupBlocks();

	function applyInput(): void {
		// Readonly while the saved conversation loads or there is no agent. Never during a turn:
		// focus would leave the field and the Enter that sent the message would lose its target.
		const off = promptOff();
		sendControl.disabled = off;
		promptLine.disabled = off;
		promptLineShell.disabled = off;
		if (!off && deferredFocusFrom !== undefined) {
			const from = deferredFocusFrom;
			deferredFocusFrom = undefined;
			// Only if the user has not moved focus meanwhile.
			const active = document.activeElement;
			if (active === from || active === null || active === document.body) focusInput();
		}
		const { pendingUploads, hasInFlightUploads } = store.get();
		// A redirect answer to an approval card ignores staged files, so a running or failed upload must not hold it back.
		sendControl.disableSend =
			!approvalPending && (hasInFlightUploads || pendingUploads.some((upload) => upload.status === "error"));
		attachments?.setBlocked(approvalPending ? "approval" : off ? "unavailable" : null);
		// the setup, approval and staged-file states all write the placeholder, so it is derived here
		promptLine.placeholder = setupBlocks()
			? __("Finish setup to start chatting")
			: approvalPending
				? __("Or tell the assistant what to do instead…")
				: pendingUploads.length > 0
					? __("Add a message to send with your files…")
					: __("Ask the assistant…");
	}

	function applyStatus(status: ChatStatus): void {
		sendControl.isStopStreamingButtonVisible = isTurnLive(status);
		applyInput();
	}

	function applyLive(live: boolean): void {
		if (live) closeHistory("none");
		applyHeader();
	}

	// A conversation switch keeps the old rows until the new ones arrive; dim them so a slow
	// request does not look frozen. The first hydration has no rows to dim.
	function applyBusy(busy: boolean): void {
		body.classList.toggle("cf-ai-body--loading", busy);
		if (busy) body.setAttribute("aria-busy", "true");
		else body.removeAttribute("aria-busy");
	}

	function applyError(error: ChatState["error"]): void {
		const message = error?.message ?? "";
		notification.setSubtitle(message === loadErrorTitle ? "" : message);
	}

	applyExpanded();
	applyView(viewOf(store.get()));
	applyStatus(store.get().status);
	applyError(store.get().error);
	applyBusy(store.get().status === "loading" && store.get().messages.length > 0);
	cleanups.push(
		store.select(viewOf, applyView),
		store.select((state) => state.status, applyStatus),
		store.select((state) => isTurnLive(state.status), applyLive),
		store.select((state) => state.error, applyError),
		store.select((state) => state.status === "loading" && state.messages.length > 0, applyBusy),
		store.select((state) => state.session, applyInput),
		store.select((state) => state.pendingUploads, applyInput),
		store.select(
			(state) => pendingApproval(state.messages) !== undefined,
			(pending) => {
				approvalPending = pending;
				applyInput();
			},
		),
		store.select(
			(state) => state.status === "error",
			(failed) => {
				if (failed) announcer.announce(__("Could not load the conversation."), "assertive");
			},
		),
	);

	// -- input ------------------------------------------------------------------

	/** Says why the files stop a send, and whether they do; `controller.send` declines silently. */
	function uploadsBlockSend(): boolean {
		const { pendingUploads, hasInFlightUploads } = store.get();
		if (hasInFlightUploads) {
			announcer.announce(__("Wait for the files to finish uploading."));
			return true;
		}
		if (pendingUploads.some((upload) => upload.status === "error")) {
			announcer.announce(__("Remove the files that failed to upload, then send."), "assertive");
			return true;
		}
		return false;
	}

	function trySend(fromButton: boolean): void {
		const status = store.get().status;
		// Enter during a turn does nothing and the draft stays, so it is ready for the next turn.
		if (isTurnLive(status) || promptOff()) return;
		// The field is read here because neither send event carries the text.
		const text = promptLine.getValue().trim();
		// With an approval card open the text is the card's redirect answer, which takes no files.
		if (!approvalPending && store.get().pendingUploads.length > 0) {
			if (text === "") {
				announcer.announce(__("Type a message to send with your files."));
				return;
			}
			if (uploadsBlockSend()) return;
		}
		if (text === "") return;
		attachments?.clearRefusal();
		promptLine.clearContent();
		sendControl.hasValidInput = false;
		closeHistory("none");
		void controller.send(text);
		// A mouse press moved focus to the send button, which the Stop button replaces.
		if (fromButton) focusInput();
	}

	function newChat(): void {
		if (isTurnLive(store.get().status)) return;
		controller.newChat();
		attachments?.clearRefusal();
		closeHistory("none");
		announcer.announce(__("New conversation started"));
		probeAgents();
		focusInput();
	}

	cleanups.push(
		listenDetail(promptLine, EVENTS.promptChange, isPromptChangeDetail, (detail) => {
			sendControl.hasValidInput = detail.rawValue.trim() !== "";
		}),
		listenDetail(promptLine, EVENTS.promptKeydown, isPromptKeydownDetail, (detail) => {
			const event = detail.originalEvent;
			const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
			if (event.key !== "ArrowUp" || !plain || event.isComposing) return;
			if (promptLine.getValue() !== "" || store.get().messages.length === 0) return;
			event.preventDefault();
			list.focusLast();
		}),
	);

	const onSendIntent = (): void => trySend(false);
	const onSend = (): void => trySend(true);
	const onStop = (): void => {
		void controller.stop();
		focusInput();
	};
	promptLine.addEventListener(EVENTS.promptSendIntent, onSendIntent);
	sendControl.addEventListener(EVENTS.inputSend, onSend);
	sendControl.addEventListener(EVENTS.inputStop, onStop);
	cleanups.push(
		() => promptLine.removeEventListener(EVENTS.promptSendIntent, onSendIntent),
		() => sendControl.removeEventListener(EVENTS.inputSend, onSend),
		() => sendControl.removeEventListener(EVENTS.inputStop, onStop),
	);

	// Escape from anywhere not claimed by a row, card or toggle (those stop it) closes the
	// panel. The textarea prevents default on its own Escape (it blurs itself), which is
	// not a claim, so a prevented event counts here only when it came from the prompt line.
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.isComposing) return;
		if (event.defaultPrevented && !event.composedPath().includes(promptLine)) return;
		// Not on to frappe's document handler, which would close a dialog behind the panel too.
		event.stopPropagation();
		deps.onRequestClose();
	};
	shell.addEventListener("keydown", onKeydown);
	cleanups.push(() => shell.removeEventListener("keydown", onKeydown));

	return {
		element: shell,
		focusInput: () => focusInput(),
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(focusFrame);
			cancelAnimationFrame(pressedFrame);
			for (const cleanup of cleanups) cleanup();
			attachments?.dispose();
			history.dispose();
			list.dispose();
			home.dispose();
			announcer.dispose();
		},
	};
}
