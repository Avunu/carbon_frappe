// The conversation list: Carbon's cds-aichat-history-* components, laid over the message area
// of the chat. It does not use the shell's own `history` slot: the shell renders that slot
// beside the messages and only when it is at least 640px wide (messages-min-width +
// history-width), and the panel is 360px.
//
// Markup (DOM contract: the e2e suite and scss/ai_chat/_history.scss rely on every name):
//
//   div.cf-ai-history[role=region][aria-label="Conversation history"][hidden]
//     cds-aichat-history-shell.cf-ai-history__shell
//       cds-aichat-history-header      header-title "Conversations", show-close-action (back to the chat)
//       cds-aichat-history-toolbar     search field + new chat button
//       cds-aichat-history-content     [slot=content]; results-count while a search is active
//         div.cf-ai-history__error     the last load failed but an older list is still shown
//         cds-aichat-history-panel[show-actions]
//           cds-aichat-history-panel-items
//             cds-aichat-history-panel-menu[expanded][title=<group label>]    one per date group,
//                                                                              or one "Search results"
//               cds-aichat-history-panel-item#cf-ai-session-<name>[data-session=<name>]
//         div.cf-ai-history__empty     no search match (instead of the panel)
//         p.cf-ai-history__note        the list was cut at HISTORY_LIMIT
//       cds-aichat-history-loading     [slot=content]  instead of the content while the first load runs
//       div.cf-ai-history__empty       [slot=content]  no conversations at all
//       div.cf-ai-history__error       [slot=content]  Carbon inline error notification + Retry button
//       cds-aichat-history-delete-panel[item-id]       while a delete is awaiting confirmation;
//                                                      role=alertdialog, named by its title and
//                                                      described by the conversation and the warning
//
// The elements are registered by register.ts (they are part of the first-open closure).
//
// Keys: the side-nav base has no arrow-key model, so the rows get one here (Up/Down/Home/End
// between rows; each row is also a Tab stop with its overflow button). Escape goes back one
// step: it ends a rename or a delete confirmation, clears a search, closes an open overflow
// menu, and only then closes the list. It never reaches the panel's own handler. Tab stays
// between the two buttons of a delete confirmation.
import trashCan16 from "@carbon/icons/es/trash-can/16.js";
import { iconLoader } from "@carbon/web-components/es/globals/internal/icon-loader.js";
import type { Announcer } from "../announce.ts";
import { createErrorNotification, el, syncChildren } from "../dom.ts";
import {
	EVENTS,
	createHistoryContent,
	createHistoryDeletePanel,
	createHistoryHeader,
	createHistoryLoading,
	createHistoryPanel,
	createHistoryPanelItem,
	createHistoryPanelItems,
	createHistoryPanelMenu,
	createHistoryShell,
	createHistoryToolbar,
	isHistoryItemDetail,
	isHistoryMenuActionDetail,
	isHistoryRenameChangeDetail,
	isHistoryRenameSaveDetail,
	isSearchInputDetail,
	listenDetail,
} from "../elements.ts";
import type {
	HistoryDeletePanelElement,
	HistoryItemAction,
	HistoryPanelItemElement,
	HistoryPanelMenuElement,
} from "../elements.ts";
import { filterItems, groupByDate } from "../history_groups.ts";
import { HISTORY_TITLE_MAX } from "../history_model.ts";
import type { HistoryItem, HistoryModel } from "../history_model.ts";
import type { Translate } from "../i18n.ts";
import type { ChatStore } from "../store.ts";
import { isRecord } from "../types.ts";

export interface HistoryViewDeps {
	model: HistoryModel;
	/** Read-only here: `state.session` marks the open conversation `selected`; a live turn makes the list inert. */
	store: ChatStore;
	translate: Translate;
	/** BCP 47 tag. */
	locale: string;
	/** IANA zone the date buckets are counted in; the browser's when absent. */
	timeZone?: string | undefined;
	announcer: Announcer;
	/** A row was chosen. Resolves `true` when the conversation switched; the panel then closes the list. A rejection is reported by the caller. */
	onSelect(id: string): Promise<boolean>;
	/** The toolbar's new chat button. */
	onNewChat(): void;
	/** A rename was saved. A rejection (reported by the caller) makes the view write the model's title back. */
	onRename(id: string, title: string): Promise<void>;
	/** Delete was confirmed. A rejection is reported by the caller; the row stays. */
	onDelete(id: string): Promise<void>;
	/** The error block's Retry. */
	onRetry(): void;
	/** The header's back button, or Escape with nothing inside the list claiming it. */
	onClose(): void;
}

export interface HistoryView {
	/** `div.cf-ai-history`. Starts `hidden`; the panel toggles `hidden`. */
	readonly element: HTMLElement;
	/** The list was just opened: clear the search, close any rename or delete in progress, focus the search field. */
	focusEntry(): void;
	dispose(): void;
}

/** Item ids are namespaced in the DOM so a session name can never collide with an id elsewhere on the page. */
const ID_PREFIX = "cf-ai-session-";
/** Frames to keep trying to focus the search field: the toolbar renders it a tick after upgrade. */
const FOCUS_ATTEMPTS = 20;
const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
/** Ids inside the rename field's shadow root and in the light DOM of the (single) delete confirmation. */
const RENAME_ERROR_ID = "cf-ai-rename-error";
const DELETE_TITLE_ID = "cf-ai-delete-title";
const DELETE_TEXT_ID = "cf-ai-delete-text";
/** The back chevron is a left-pointing glyph in the header's shadow DOM, out of reach of the page stylesheet. */
const MIRROR_BACK_ICON = ":host(:dir(rtl)) cds-icon-button > svg { transform: scaleX(-1); }";

const domId = (session: string): string => `${ID_PREFIX}${session}`;
const sessionOf = (id: string): string | undefined =>
	id.startsWith(ID_PREFIX) && id.length > ID_PREFIX.length ? id.slice(ID_PREFIX.length) : undefined;

const isElementNamed =
	(name: string) =>
	(target: EventTarget): target is Element =>
		target instanceof Element && target.localName === name;
const isSearchHost = isElementNamed("cds-search");
const isOverflowMenu = isElementNamed("cds-overflow-menu");
const isRenameInput = isElementNamed("cds-aichat-history-panel-item-input");

/** The body of a row's overflow menu; `flipped` opens it towards the left of its kebab. */
function isMenuBody(element: Element): element is HTMLElement & { flipped: boolean } {
	return (
		element instanceof HTMLElement &&
		element.localName === "cds-overflow-menu-body" &&
		"flipped" in element &&
		typeof element.flipped === "boolean"
	);
}

/** The text field Carbon renders inside a row while it is renamed; its `labelText` becomes the <input>'s aria-label. */
function isRenameField(element: Element | null): element is HTMLElement & { labelText: string } {
	return element instanceof HTMLElement && isRenameInput(element) && "labelText" in element;
}

/** Carbon's floating menu records its trigger in `parent` (protected in its typings) when it portals the body. */
function menuOwner(body: Element): Node | null {
	const owner: unknown = Reflect.get(body, "parent");
	return owner instanceof Node ? owner : null;
}

function isSearchField(element: Element | null): element is HTMLElement & { value: string } {
	return element instanceof HTMLElement && "value" in element && typeof element.value === "string";
}

/** Resolves once a Lit element has rendered; at once for anything else. */
async function rendered(element: HTMLElement): Promise<void> {
	if ("updateComplete" in element && element.updateComplete instanceof Promise) await element.updateComplete;
}

interface PendingDelete {
	readonly id: string;
	readonly panel: HistoryDeletePanelElement;
	confirming: boolean;
}

export function createHistoryView(deps: HistoryViewDeps): HistoryView {
	const __ = deps.translate;
	const cleanups: (() => void)[] = [];
	let disposed = false;
	let query = "";
	/** The item whose title is being edited. */
	let renaming: string | null = null;
	/** The message currently shown under a rename field, to announce a change of it only once. */
	let invalidShown = "";
	let pendingDelete: PendingDelete | null = null;
	let pendingSelects = 0;
	/** The row of the latest pick still loading; it shows as selected before the switch lands. */
	let pendingTarget: string | null = null;
	let suppressSelect = false;
	let suppressTimer: number | undefined;
	let focusToken = 0;

	const root = el("div", "cf-ai-history");
	root.setAttribute("role", "region");
	root.setAttribute("aria-label", __("Conversation history"));
	root.hidden = true;

	const shell = createHistoryShell();
	shell.className = "cf-ai-history__shell";

	const header = createHistoryHeader();
	header.headerTitle = __("Conversations");
	header.closeButtonLabel = __("Back to chat");
	header.showCloseAction = true;

	const toolbar = createHistoryToolbar();
	toolbar.newChatLabel = __("New chat");
	toolbar.searchAttributes = {
		"label-text": __("Search conversations"),
		placeholder: __("Search conversations"),
		"close-button-label-text": __("Clear search"),
	};

	const content = createHistoryContent();
	content.resultsLabel = __("Results");
	const panel = createHistoryPanel();
	panel.showActions = true;
	panel.setAttribute("aria-label", __("Conversation history"));
	const menuHost = createHistoryPanelItems();
	panel.append(menuHost);

	const loading = createHistoryLoading();

	const emptyTitle = el("p", "cf-ai-history__empty-title");
	const emptyText = el("p", "cf-ai-history__empty-text");
	const empty = el("div", "cf-ai-history__empty");
	empty.append(emptyTitle, emptyText);

	const failure = createErrorNotification({
		title: __("Could not load your conversations"),
		hideClose: true,
	});
	failure.element.setAttribute("role", "alert");
	const retry = el("button", "cds--btn cds--btn--sm cds--btn--ghost", __("Try again"));
	retry.type = "button";
	retry.dataset["action"] = "retry-history";
	const error = el("div", "cf-ai-history__error");
	error.append(failure.element, retry);

	const note = el("p", "cf-ai-history__note");

	/** What fills the content slot right now: the content, the skeleton, or one of the two blocks. */
	let current: HTMLElement = loading;
	syncChildren(shell, [header, toolbar, current]);
	root.append(shell);

	// -- actions of an item's overflow menu -------------------------------------------------

	const RENAME = __("Rename");
	const DELETE = __("Delete");
	const noop = (): void => {};
	// the element does not call onClick; it fires history-item-menu-action with the text, matched below
	const actions: HistoryItemAction[] = [
		{ text: RENAME, onClick: noop },
		{
			text: DELETE,
			delete: true,
			divider: true,
			icon: iconLoader(trashCan16, { slot: "icon" }),
			onClick: noop,
		},
	];

	// -- items and groups ---------------------------------------------------------------------

	const itemEls = new Map<string, HistoryPanelItemElement>();
	const menuEls = new Map<string, HistoryPanelMenuElement>();

	function itemFor(item: HistoryItem, selected: string | null): HistoryPanelItemElement {
		let element = itemEls.get(item.id);
		if (element === undefined) {
			element = createHistoryPanelItem();
			element.id = domId(item.id);
			element.dataset["session"] = item.id;
			element.overflowMenuLabel = __("Conversation actions");
			element.actions = actions;
			itemEls.set(item.id, element);
		}
		// compared with the element, not the previous model: the element sets its own name when a rename is
		// saved, and this is what puts the old title back when the server refuses it
		if (element.name !== item.title) element.name = item.title;
		element.selected = item.id === selected;
		if (item.id === pendingTarget) element.setAttribute("aria-busy", "true");
		else element.removeAttribute("aria-busy");
		return element;
	}

	function menuFor(key: string, label: string): HistoryPanelMenuElement {
		let menu = menuEls.get(key);
		if (menu === undefined) {
			menu = createHistoryPanelMenu();
			menu.expanded = true;
			menuEls.set(key, menu);
		}
		if (menu.title !== label) menu.title = label;
		return menu;
	}

	function syncList(matches: readonly HistoryItem[], searching: boolean): void {
		const selected = pendingTarget ?? deps.store.get().session;
		const groups = searching
			? [{ key: "search", label: __("Search results"), items: matches }]
			: groupByDate(matches, Date.now(), { timeZone: deps.timeZone, translate: __ }).map((group) => ({
					key: group.bucket,
					label: group.label,
					items: group.items,
				}));
		const wanted = new Set(matches.map((item) => item.id));
		for (const [id, element] of itemEls) {
			if (wanted.has(id)) continue;
			element.remove();
			itemEls.delete(id);
			if (renaming === id) renaming = null;
		}
		const menus: HistoryPanelMenuElement[] = [];
		const keys = new Set<string>();
		for (const group of groups) {
			const menu = menuFor(group.key, group.label);
			syncChildren(
				menu,
				group.items.map((item) => itemFor(item, selected)),
			);
			menus.push(menu);
			keys.add(group.key);
		}
		for (const [key, menu] of menuEls) {
			if (keys.has(key)) continue;
			menu.remove();
			menuEls.delete(key);
		}
		syncChildren(menuHost, menus, false);
		void settleRows();
	}

	let settleToken = 0;
	/**
	 * Once the rows have rendered: mark the open conversation for assistive technology (Carbon only adds a
	 * class) and drop the overflow bodies of rows that are gone. Carbon moves a body into the panel-items
	 * container on its first open and never takes it back out, and `syncChildren` leaves unknown children there.
	 */
	async function settleRows(): Promise<void> {
		const token = ++settleToken;
		const rows = [...itemEls.values()];
		await Promise.all(rows.map((row) => rendered(row)));
		if (disposed || token !== settleToken) return;
		for (const row of rows) {
			const link = row.shadowRoot?.querySelector("button.cds--side-nav__link");
			if (link === null || link === undefined) continue;
			if (row.dataset["session"] === deps.store.get().session) link.setAttribute("aria-current", "true");
			else link.removeAttribute("aria-current");
		}
		// a static list: the bodies are removed while it is walked
		for (const body of menuHost.querySelectorAll(":scope > cds-overflow-menu-body")) {
			const owner = menuOwner(body);
			if (owner !== null && !owner.isConnected) body.remove();
		}
	}

	// -- the content slot ------------------------------------------------------------------------

	function setInert(): void {
		const inert = pendingDelete !== null;
		header.inert = inert;
		toolbar.inert = inert;
		current.inert = inert;
	}

	/** A block sitting directly in the shell must name the slot; inside the content it must not. */
	function place(block: HTMLElement, directly: boolean): void {
		if (directly) block.slot = "content";
		else block.removeAttribute("slot");
	}

	function render(): void {
		if (disposed) return;
		const state = deps.model.get();
		const searching = query.trim() !== "";
		const matches = filterItems(state.items, query);
		let next: HTMLElement;

		if (state.items.length === 0) {
			if (state.status === "error") {
				failure.setSubtitle(state.error ?? "");
				place(error, true);
				next = error;
			} else if (state.status === "ready") {
				emptyTitle.textContent = __("No conversations yet");
				emptyText.textContent = __("Conversations you start with the assistant appear here.");
				emptyText.hidden = false;
				place(empty, true);
				next = empty;
			} else {
				// idle is the moment before the first load starts: no list to show and nothing to claim yet
				next = loading;
			}
		} else {
			syncList(matches, searching);
			const children: HTMLElement[] = [];
			if (state.status === "error") {
				failure.setSubtitle(state.error ?? "");
				place(error, false);
				children.push(error);
			}
			if (matches.length > 0) {
				children.push(panel);
			} else {
				emptyTitle.textContent = __("No matching conversations");
				emptyText.textContent = "";
				emptyText.hidden = true;
				place(empty, false);
				children.push(empty);
			}
			if (state.truncated) {
				note.textContent = __("Showing your {0} most recent conversations.", [String(state.items.length)]);
				children.push(note);
			}
			syncChildren(content, children);
			content.resultsCount = searching ? matches.length : "";
			next = content;
		}

		if (next !== current) {
			current.inert = false;
			current = next;
		}
		syncChildren(
			shell,
			pendingDelete === null ? [header, toolbar, current] : [header, toolbar, current, pendingDelete.panel],
		);
		setInert();
		root.setAttribute("aria-busy", String(pendingSelects > 0 || state.status === "loading"));
		root.classList.toggle("cf-ai-history--switching", pendingSelects > 0);
	}

	// -- focus ---------------------------------------------------------------------------------------

	function searchField(): (HTMLElement & { value: string }) | null {
		const field = toolbar.shadowRoot?.querySelector("cds-search") ?? null;
		return isSearchField(field) ? field : null;
	}

	function focusSearch(): void {
		const token = ++focusToken;
		let attempts = 0;
		const attempt = (): void => {
			if (disposed || token !== focusToken || root.hidden) return;
			const field = searchField();
			if (field !== null) {
				field.focus();
				if (toolbar.shadowRoot?.activeElement === field) return;
			}
			attempts += 1;
			if (attempts < FOCUS_ATTEMPTS) requestAnimationFrame(attempt);
		};
		attempt();
	}

	async function focusItem(id: string): Promise<boolean> {
		const element = itemEls.get(id);
		if (element === undefined) return false;
		await rendered(element);
		if (disposed || !element.isConnected) return false;
		element.focus();
		return true;
	}

	/** After a rename field went away: put focus back unless the user already moved it somewhere. */
	async function refocusIfLost(id: string): Promise<void> {
		const element = itemEls.get(id);
		if (element === undefined) {
			// a rename can take the row out of the active search; its focus went to <body> with it
			if (document.activeElement === null || document.activeElement === document.body) focusSearch();
			return;
		}
		await rendered(element);
		const active = document.activeElement;
		if (active === null || active === document.body || active === element) await focusItem(id);
	}

	// -- search ---------------------------------------------------------------------------------------

	cleanups.push(
		listenDetail(root, EVENTS.searchInput, isSearchInputDetail, (detail) => {
			query = detail.value;
			render();
		}),
	);

	// -- select ----------------------------------------------------------------------------------------

	/** The rename field's own buttons and Enter key also bubble a click or key to the item, which selects it. */
	function suppressSelectBriefly(): void {
		suppressSelect = true;
		window.clearTimeout(suppressTimer);
		suppressTimer = window.setTimeout(() => {
			suppressSelect = false;
		}, 0);
	}

	async function select(id: string): Promise<void> {
		pendingSelects += 1;
		pendingTarget = id;
		render();
		try {
			await deps.onSelect(id);
		} catch {
			// reported by the caller; the list stays open
		} finally {
			pendingSelects -= 1;
			if (pendingSelects === 0) pendingTarget = null;
			render();
		}
	}

	cleanups.push(
		listenDetail(root, EVENTS.historyItemSelected, isHistoryItemDetail, (detail) => {
			if (suppressSelect || pendingDelete !== null) return;
			const id = sessionOf(detail.itemId);
			if (id === undefined) return;
			const element = itemEls.get(id);
			if (element === undefined || element.rename) return;
			// the conversation on screen is not reloaded: choosing it just goes back to it
			if (id === deps.store.get().session) deps.onClose();
			else void select(id);
		}),
	);

	// -- rename ----------------------------------------------------------------------------------------

	function invalidReason(value: string): string {
		const title = value.trim();
		if (title === "") return __("A title is required.");
		if (title.length > HISTORY_TITLE_MAX) {
			return __("Title cannot exceed {0} characters.", [String(HISTORY_TITLE_MAX)]);
		}
		return "";
	}

	function endRename(id: string): void {
		if (renaming === id) renaming = null;
		invalidShown = "";
		suppressSelectBriefly();
	}

	async function saveRename(id: string, value: string): Promise<void> {
		endRename(id);
		const title = value.trim();
		const item = deps.model.get().items.find((candidate) => candidate.id === id);
		if (item === undefined || title === item.title || invalidReason(value) !== "") {
			// the element already took the typed text as its name; the model's title replaces it
			render();
			void refocusIfLost(id);
			return;
		}
		try {
			const saved = deps.onRename(id, title);
			// the optimistic title is in the model by now; show it trimmed
			render();
			void refocusIfLost(id);
			await saved;
		} catch {
			// reported by the caller; the render below puts the previous title back
		} finally {
			render();
		}
	}

	cleanups.push(
		listenDetail(root, EVENTS.historyRenameChange, isHistoryRenameChangeDetail, (detail) => {
			const id = sessionOf(detail.itemId);
			const element = id === undefined ? undefined : itemEls.get(id);
			if (element === undefined) return;
			const reason = invalidReason(detail.value);
			element.renameInvalid = reason !== "";
			element.renameInvalidMessage = reason;
			if (reason !== invalidShown) {
				if (reason !== "") deps.announcer.announce(reason, "assertive");
				invalidShown = reason;
				void describeRename(element);
			}
		}),
		listenDetail(root, EVENTS.historyRenameSave, isHistoryRenameSaveDetail, (detail) => {
			const id = sessionOf(detail.itemId);
			if (id !== undefined) void saveRename(id, detail.newName);
		}),
	);
	const onRenameCancel = (): void => {
		const id = renaming;
		if (id === null) return;
		endRename(id);
		const element = itemEls.get(id);
		if (element !== undefined) {
			element.renameInvalid = false;
			element.renameInvalidMessage = "";
		}
		render();
		void refocusIfLost(id);
	};
	root.addEventListener(EVENTS.historyRenameCancel, onRenameCancel);
	cleanups.push(() => root.removeEventListener(EVENTS.historyRenameCancel, onRenameCancel));

	/** Carbon renders the rename <input> without a name and without its invalid state; both are set on it here. */
	async function describeRename(row: HistoryPanelItemElement): Promise<void> {
		await rendered(row);
		const field = row.shadowRoot?.querySelector("cds-aichat-history-panel-item-input") ?? null;
		if (!isRenameField(field)) return;
		field.labelText = __("Conversation title");
		await rendered(field);
		const input = field.shadowRoot?.querySelector("input");
		if (input === null || input === undefined) return;
		const message = field.shadowRoot?.querySelector('[class*="invalid-message-text"]') ?? null;
		input.setAttribute("aria-invalid", String(message !== null));
		if (message === null) {
			input.removeAttribute("aria-describedby");
			return;
		}
		message.id = RENAME_ERROR_ID;
		input.setAttribute("aria-describedby", RENAME_ERROR_ID);
	}

	function startRename(id: string): void {
		const element = itemEls.get(id);
		if (element === undefined) return;
		renaming = id;
		invalidShown = "";
		element.renameInvalid = false;
		element.renameInvalidMessage = "";
		element.rename = true;
		void describeRename(element);
	}

	function stopRename(): void {
		for (const element of itemEls.values()) {
			if (!element.rename) continue;
			element.rename = false;
			element.renameInvalid = false;
			element.renameInvalidMessage = "";
		}
		renaming = null;
		invalidShown = "";
	}

	// -- delete ----------------------------------------------------------------------------------------

	function closeDelete(): void {
		if (pendingDelete === null) return;
		pendingDelete.panel.remove();
		pendingDelete = null;
		setInert();
	}

	function startDelete(id: string): void {
		if (pendingDelete !== null) return;
		const confirmPanel = createHistoryDeletePanel();
		confirmPanel.itemId = domId(id);
		confirmPanel.cancelText = __("Cancel");
		confirmPanel.deleteText = __("Delete");
		const question = __("Delete this conversation?");
		const warning = __("This conversation and its history will be permanently deleted.");
		const item = deps.model.get().items.find((candidate) => candidate.id === id);
		const title = el("div", "cf-ai-history__delete-title", question);
		title.slot = "title";
		title.id = DELETE_TITLE_ID;
		const description = el("div", "cf-ai-history__delete-description");
		description.slot = "description";
		description.id = DELETE_TEXT_ID;
		if (item !== undefined) description.append(el("span", "cf-ai-history__delete-name", item.title));
		description.append(el("span", "cf-ai-history__delete-warning", warning));
		confirmPanel.append(title, description);
		// the Carbon panel has no role of its own; its title and description are light DOM children of the host,
		// so these ids resolve
		confirmPanel.setAttribute("role", "alertdialog");
		confirmPanel.setAttribute("aria-modal", "true");
		confirmPanel.setAttribute("aria-labelledby", DELETE_TITLE_ID);
		confirmPanel.setAttribute("aria-describedby", DELETE_TEXT_ID);
		const state: PendingDelete = { id, panel: confirmPanel, confirming: false };
		pendingDelete = state;
		// the shell also listens for this event and, when the deleted row was the open one, selects the next row,
		// which would open another conversation instead of leaving a new chat
		confirmPanel.addEventListener(EVENTS.historyDeleteConfirm, (event) => {
			event.stopPropagation();
			const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
			const next = isRecord(detail) ? detail["nextItemId"] : undefined;
			void confirmDelete(state, typeof next === "string" ? next : undefined);
		});
		render();
		const subject = item === undefined ? "" : ` ${item.title}.`;
		deps.announcer.announce(`${question}${subject} ${warning}`, "assertive");
	}

	/** Tab stays between the two buttons: the rest of the list is inert, so it would fall out of the chat's list. */
	function trapDeleteTab(event: KeyboardEvent): void {
		if (pendingDelete === null || event.altKey || event.ctrlKey || event.metaKey) return;
		const path = event.composedPath();
		if (!path.includes(pendingDelete.panel)) return;
		const buttons = pendingDelete.panel.shadowRoot?.querySelectorAll("cds-aichat-button") ?? [];
		const first = buttons[0];
		const last = buttons[buttons.length - 1];
		if (first === undefined || last === undefined) return;
		const edge = event.shiftKey ? first : last;
		if (!path.includes(edge)) return;
		event.preventDefault();
		(event.shiftKey ? last : first).shadowRoot?.querySelector("button")?.focus();
	}

	async function confirmDelete(state: PendingDelete, nextId: string | undefined): Promise<void> {
		if (state.confirming) return;
		state.confirming = true;
		state.panel.setAttribute("aria-busy", "true");
		let deleted = false;
		try {
			await deps.onDelete(state.id);
			deleted = true;
		} catch {
			// reported by the caller; the row stays
		}
		if (disposed) return;
		if (pendingDelete === state) closeDelete();
		if (!deleted) {
			void focusItem(state.id);
			return;
		}
		const target = nextId === undefined ? undefined : sessionOf(nextId);
		if (target === undefined || !(await focusItem(target))) focusSearch();
	}

	const onDeleteCancel = (): void => {
		const state = pendingDelete;
		if (state === null) return;
		closeDelete();
		void focusItem(state.id);
	};
	root.addEventListener(EVENTS.historyDeleteCancel, onDeleteCancel);
	cleanups.push(() => root.removeEventListener(EVENTS.historyDeleteCancel, onDeleteCancel));

	cleanups.push(
		listenDetail(root, EVENTS.historyItemMenuAction, isHistoryMenuActionDetail, (detail) => {
			const id = sessionOf(detail.itemId);
			if (id === undefined) return;
			if (detail.action === RENAME) startRename(id);
			else if (detail.action === DELETE) startDelete(id);
		}),
	);

	// -- header, toolbar, keys -----------------------------------------------------------------------

	const onHeaderClose = (): void => deps.onClose();
	const onNewChat = (): void => deps.onNewChat();
	const onRetry = (): void => deps.onRetry();
	root.addEventListener(EVENTS.historyHeaderClose, onHeaderClose);
	root.addEventListener(EVENTS.historyNewChat, onNewChat);
	retry.addEventListener("click", onRetry);
	cleanups.push(
		() => root.removeEventListener(EVENTS.historyHeaderClose, onHeaderClose),
		() => root.removeEventListener(EVENTS.historyNewChat, onNewChat),
		() => retry.removeEventListener("click", onRetry),
	);

	// cds-search stops every Escape typed in its field (it clears a non-empty field, and does nothing with
	// an empty one), so an empty field would never close the list from the bubbling phase
	const onKeyCapture = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || query !== "") return;
		if (!event.composedPath().some(isSearchHost)) return;
		event.stopPropagation();
		event.preventDefault();
		deps.onClose();
	};
	// the side-nav base has no arrow-key model, so a long list would be Tab-only (two stops per row)
	function onArrow(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const path = event.composedPath();
		const origin = path[0];
		// only the row's own button: the overflow menu and the rename field have their own arrow keys
		if (!(origin instanceof HTMLElement) || !origin.classList.contains("cds--side-nav__link")) return;
		const rows = visibleRows();
		const at = rows.findIndex((row) => path.includes(row));
		if (at === -1) return;
		let to: number;
		if (event.key === "ArrowDown") to = Math.min(at + 1, rows.length - 1);
		else if (event.key === "ArrowUp") to = Math.max(at - 1, 0);
		else if (event.key === "Home") to = 0;
		else to = rows.length - 1;
		event.preventDefault();
		rows[to]?.focus();
	}

	/** The rows in screen order, leaving out those inside a collapsed group. */
	function visibleRows(): HistoryPanelItemElement[] {
		const rows: HistoryPanelItemElement[] = [];
		for (const menu of menuHost.children) {
			for (const row of menu.children) {
				const element = itemEls.get(sessionOf(row.id) ?? "");
				if (element === row && element.checkVisibility()) rows.push(element);
			}
		}
		return rows;
	}

	/**
	 * Carbon builds each row menu `flipped`: its right edge on the kebab's, opening towards the left. With the
	 * kebab at the left edge of a right-to-left list that runs off screen, so the menu opens the other way.
	 * Set just before the open (the body positions itself on the update that follows).
	 */
	const onMenuTrigger = (event: Event): void => {
		const menu = event.composedPath().find(isOverflowMenu);
		if (menu === undefined) return;
		const flipped = getComputedStyle(root).direction !== "rtl";
		const bodies = [...menu.querySelectorAll("cds-overflow-menu-body"), ...menuHost.children];
		for (const body of bodies) {
			if (!isMenuBody(body) || (body.parentElement !== menu && menuOwner(body) !== menu)) continue;
			if (body.flipped !== flipped) body.flipped = flipped;
		}
	};
	root.addEventListener("click", onMenuTrigger, true);
	root.addEventListener("keydown", onMenuTrigger, true);
	cleanups.push(
		() => root.removeEventListener("click", onMenuTrigger, true),
		() => root.removeEventListener("keydown", onMenuTrigger, true),
	);

	async function mirrorBackIcon(): Promise<void> {
		await rendered(header);
		const shadow = header.shadowRoot;
		if (disposed || shadow === null) return;
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(MIRROR_BACK_ICON);
		shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
	}
	void mirrorBackIcon();

	// Escape must not reach the panel's own handler, which would close the whole chat
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === "Tab") {
			trapDeleteTab(event);
			return;
		}
		if (ARROW_KEYS.has(event.key)) {
			onArrow(event);
			return;
		}
		if (event.key !== "Escape") return;
		event.stopPropagation();
		const path = event.composedPath();
		if (pendingDelete !== null && path.includes(pendingDelete.panel)) {
			onDeleteCancel();
			return;
		}
		// the rename field cancels itself; an open overflow menu closes itself and marks the event handled
		if (event.defaultPrevented || path.some(isRenameInput)) return;
		deps.onClose();
	};
	root.addEventListener("keydown", onKeyCapture, true);
	root.addEventListener("keydown", onKey);
	cleanups.push(
		() => root.removeEventListener("keydown", onKeyCapture, true),
		() => root.removeEventListener("keydown", onKey),
	);

	// -- model and store -----------------------------------------------------------------------------

	cleanups.push(
		deps.model.subscribe(render),
		deps.store.select((state) => state.session, render),
		deps.store.select(
			(state) => state.status === "submitted" || state.status === "streaming",
			(live) => {
				root.inert = live;
			},
		),
	);
	root.inert = deps.store.get().status === "submitted" || deps.store.get().status === "streaming";
	render();

	return {
		element: root,
		focusEntry() {
			closeDelete();
			stopRename();
			const field = searchField();
			if (field !== null) field.value = "";
			query = "";
			render();
			focusSearch();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			window.clearTimeout(suppressTimer);
			for (const cleanup of cleanups.splice(0)) cleanup();
			root.remove();
		},
	};
}
