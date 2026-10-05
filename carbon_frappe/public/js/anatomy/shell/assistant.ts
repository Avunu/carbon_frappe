// The AI assistant's header action, its host panel, the lazy loader and the takeover
// of flow's own panel. Always loaded (carbon_anatomy.bundle), so everything about the
// chat itself stays behind `import()`; see scripts/build-ai-chat.ts for what that loads.
//
// Like every anatomy hook it fails soft: a thrown error here must leave the desk as it
// was, so ui_shell.ts builds this only after `shouldMountAssistant`, inside its own
// try/catch, and records the outcome with patch.ts' `record`.
//
// Markup, as shell/switcher.ts does for its action:
//
//   button#cf-ai-trigger.cds--header__action.cf-ai-trigger[aria-expanded][aria-controls]
//     in .cds--header__global, directly before the switcher's button (ui_shell.ts)
//   aside#cf-ai-panel.cf-ai[.cf-ai--open][.cf-ai--expanded]      last child of <body>
//     div.cf-ai-status          while the chat module loads or failed to
//     cds-aichat-shell          after the chat mounted (js/ai_chat/view/panel.ts)
//
// The host is on <body>, not in <header>: that keeps it out of the header's g100 zone, so
// it follows the page theme, and it is a non-modal complementary landmark, not a dialog.
// Closed is `visibility: hidden` (desk/_ai-chat.scss), which drops it from the tab order
// and the accessibility tree without any state here to keep in step.
//
// Non-modal: no focus trap, and the page stays usable beside the 360px strip. Once the
// panel covers the whole page (expanded, or a narrow window) the page behind it is
// `inert`, or Tab would walk focus through rows nobody can see.
//
// Parsed by frappe's esbuild 0.14: no `satisfies`, `accessor` or `using` (see assistant_gate.ts).
import type { ChatHandle, ChatModule } from "../../ai_chat/entry.ts";
import { SESSION_KEY } from "../../ai_chat/storage_keys.ts";
import { aiLaunch20, errorFilled20 } from "../../generated/shell-icons.ts";
import { record } from "../patch.ts";
import {
	assetUrl,
	closedFlowState,
	entrySpecifier,
	FLOW_PANEL_STATE_KEY,
	isChatModule,
	isFlowPanel,
	MANIFEST_URL,
	PANEL_STATE_KEY,
	parseManifest,
	parsePanelState,
	reconcileSession,
	serialisePanelState,
	SESSION_USER_KEY,
} from "./assistant_gate.ts";
import type { FlowPanelLike } from "./assistant_gate.ts";
import { esc, isHTMLElement } from "./dom.ts";

export interface ShellAssistant {
	/** `button.cds--header__action.cf-ai-trigger#cf-ai-trigger`. ui_shell.ts places it directly before the switcher's button. */
	readonly button: HTMLButtonElement;
	/** `aside#cf-ai-panel.cf-ai`, appended to <body>. */
	readonly host: HTMLElement;
	toggle(): void;
	/** Open (loading the chat bundle on first use). Calls the `onOpen` listeners. No-op when open. */
	open(): void;
	/** Close. `restoreFocus` (default false) returns focus to `button`: set it for Escape and the header's close button. */
	close(options?: { restoreFocus?: boolean }): void;
	isOpen(): boolean;
	/** Called each time the panel opens, so other right-side surfaces (switcher, bell, nav menus) can yield. */
	onOpen(fn: () => void): void;
}

const BUTTON_ID = "cf-ai-trigger";
const HOST_ID = "cf-ai-panel";
const SHORTCUT = "ctrl+i";
const CSS_TIMEOUT_MS = 15000;
// the breakpoint where desk/_ai-chat.scss makes the panel full width
const NARROW_QUERY = "(width <= 42rem)";
// what a full-width panel covers: frappe's sidebar (rebuilt on a sidebar render, hence
// the observer in mountAssistant) and the page column; the header stays reachable
const COVERED_PAGE = "body > .body-sidebar-container, .main-section > #body";

// -- storage ------------------------------------------------------------------

// localStorage throws in a blocked-storage window and under some embeds; every read
// then behaves as "absent" and every write as a no-op, so the feature never depends on it
function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// persistence is best-effort
	}
}

// -- flow ---------------------------------------------------------------------

/**
 * `frappe.flow` belongs to apps/flow and is not in frappe-types, so it is read as
 * `unknown` and proven by `isFlowPanel`. Null when flow's bundle failed, or when an
 * older flow has no such panel: the takeover then has nothing to hide.
 */
function readFlowPanel(): FlowPanelLike | null {
	try {
		const flow: unknown = Reflect.get(frappe, "flow");
		if (typeof flow !== "object" || flow === null) return null;
		const panel: unknown = Reflect.get(flow, "panel");
		return isFlowPanel(panel) ? panel : null;
	} catch {
		return null;
	}
}

/**
 * Close flow's slide-over. `FlowPanel.hide()` persists `session: store.sessionName`,
 * which is still null until flow's own async restore ran, so a hide right after boot
 * would erase the stored session; `raw` is the state as it was BEFORE that, and goes
 * back with `open: false` so flow keeps its session for when it is handed the panel back.
 */
function hideFlow(raw: string | null): FlowPanelLike | null {
	const panel = readFlowPanel();
	if (!panel) return null;
	try {
		if (panel.visible) {
			panel.hide();
			const closed = closedFlowState(raw);
			if (closed !== null) writeStorage(FLOW_PANEL_STATE_KEY, closed);
		}
	} catch (error) {
		console.error(error);
	}
	return panel;
}

/**
 * `add_shortcut` calls `keys.off(shortcut, page)` first, and without a `page` that
 * removes every handler for the key (keyboard.js:62-80): registering replaces flow's
 * Ctrl+I, and flow registering again would replace ours.
 */
function registerShortcut(shortcut: string, description: string, action: () => void): void {
	try {
		frappe.ui.keys.add_shortcut({
			shortcut,
			// returns nothing, so frappe preventDefaults the browser's own binding
			action: () => {
				action();
			},
			description,
			ignore_inputs: true,
		});
	} catch (error) {
		console.error(error);
	}
}

// -- lazy loader --------------------------------------------------------------

let modulePromise: Promise<ChatModule> | null = null;
// Failed imports of the entry in this document; see `entrySpecifier`. Never reset: the
// module map it works around lasts as long as the page.
let importFailures = 0;

/**
 * Resolves once the stylesheet applies. It starts together with the module import, since
 * only `mountChat` needs it and that runs after both; the 15 s cap turns a stalled
 * request into the failure state instead of an endless spinner.
 */
function ensureStylesheet(href: string): Promise<void> {
	const existing = document.querySelector<HTMLLinkElement>("link[data-cf-ai-css]");
	if (existing && existing.getAttribute("href") === href && existing.sheet) return Promise.resolve();
	// a dead link (failed, stalled or from an older build) must not satisfy a later attempt
	if (existing) existing.remove();
	return new Promise((resolve, reject) => {
		const link = document.createElement("link");
		const timer = setTimeout(() => {
			link.remove();
			reject(new Error(`carbon_frappe: ${href} did not load within ${CSS_TIMEOUT_MS / 1000}s`));
		}, CSS_TIMEOUT_MS);
		link.addEventListener("load", () => {
			clearTimeout(timer);
			resolve();
		});
		link.addEventListener("error", () => {
			clearTimeout(timer);
			link.remove();
			reject(new Error(`carbon_frappe: ${href} failed to load`));
		});
		link.rel = "stylesheet";
		link.setAttribute("data-cf-ai-css", "");
		link.href = href;
		document.head.appendChild(link);
	});
}

async function fetchChatModule(): Promise<ChatModule> {
	const response = await fetch(MANIFEST_URL, { cache: "no-cache", credentials: "same-origin" });
	// 404 means `yarn build:chat` never ran for this checkout
	if (!response.ok) throw new Error(`carbon_frappe: ${MANIFEST_URL} answered ${response.status}`);
	const data: unknown = await response.json();
	const manifest = parseManifest(data);
	if (!manifest) throw new Error(`carbon_frappe: ${MANIFEST_URL} is not a chat bundle manifest`);
	// a variable specifier: frappe's esbuild 0.14 leaves `import(url)` untouched
	const imported: Promise<unknown> = import(entrySpecifier(manifest.entry, importFailures)).catch(
		(error: unknown) => {
			importFailures += 1;
			throw error;
		},
	);
	const [, loaded] = await Promise.all([ensureStylesheet(assetUrl(manifest.css)), imported]);
	// a stale entry cached from before a contract change is a load failure, not a TypeError at the first click
	if (!isChatModule(loaded)) {
		importFailures += 1;
		throw new Error(`carbon_frappe: ${manifest.entry} is not a compatible chat module`);
	}
	return loaded;
}

function loadChatModule(): Promise<ChatModule> {
	if (modulePromise) return modulePromise;
	const attempt = fetchChatModule();
	modulePromise = attempt;
	// a rejection is never kept: the next open must be able to try again
	attempt.catch(() => {
		if (modulePromise === attempt) modulePromise = null;
	});
	return attempt;
}

// -- status markup ------------------------------------------------------------

// @carbon/react's InlineLoading + Loading (small), class for class. The svg is hidden
// from assistive technology and the nested live regions are off: the status block holds
// the one announcement, and a second assertive one would read the same words twice.
function loadingHtml(): string {
	return (
		`<div class="cds--inline-loading" aria-live="off">` +
		`<div class="cds--inline-loading__animation">` +
		`<div class="cds--loading cds--loading--small" aria-atomic="true" aria-live="off">` +
		`<svg class="cds--loading__svg" viewBox="0 0 100 100" aria-hidden="true">` +
		`<circle class="cds--loading__background" cx="50%" cy="50%" r="42"></circle>` +
		`<circle class="cds--loading__stroke" cx="50%" cy="50%" r="42"></circle>` +
		`</svg></div></div>` +
		`<div class="cds--inline-loading__text">${esc(__("Loading the AI assistant…"))}</div>` +
		`</div>`
	);
}

// @carbon/react's InlineNotification (error, no close button); its actions sit beside it
// because Carbon's inline kind has no action slot.
function failureHtml(offerFlow: boolean, offerReload: boolean): string {
	const flow = offerFlow
		? `<button type="button" class="cds--btn cds--btn--sm cds--btn--ghost" data-action="flow">${esc(__("Open the Flow panel"))}</button>`
		: "";
	// a chunk of a failed import is cached as failed until the page is reloaded
	const reload = offerReload
		? `<button type="button" class="cds--btn cds--btn--sm cds--btn--ghost" data-action="reload">${esc(__("Reload the page"))}</button>`
		: "";
	return (
		`<div class="cds--inline-notification cds--inline-notification--error" role="alert">` +
		`<div class="cds--inline-notification__details">${errorFilled20}` +
		`<div class="cds--inline-notification__text-wrapper">` +
		`<div class="cds--inline-notification__title">${esc(__("The AI assistant could not be loaded"))}</div>` +
		`<div class="cds--inline-notification__subtitle">${esc(__("Check your connection and try again."))}</div>` +
		`</div></div></div>` +
		`<div class="cf-ai-status__actions">` +
		`<button type="button" class="cds--btn cds--btn--sm cds--btn--ghost" data-action="retry">${esc(__("Retry"))}</button>` +
		reload +
		flow +
		`</div>`
	);
}

// -- the assistant ------------------------------------------------------------

export function mountAssistant(global: HTMLElement): ShellAssistant {
	const label = __("AI assistant");
	const saved = parsePanelState(readStorage(PANEL_STATE_KEY));
	const user = frappe.session.user || "";

	const button = document.createElement("button");
	button.type = "button";
	button.id = BUTTON_ID;
	button.className = "cds--header__action cf-ai-trigger";
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-controls", HOST_ID);
	button.innerHTML = aiLaunch20;
	global.appendChild(button);

	const host = document.createElement("aside");
	host.id = HOST_ID;
	host.className = "cf-ai";
	host.setAttribute("aria-label", label);
	document.body.appendChild(host);

	let opened = false;
	let expanded = saved.expanded;
	let handle: ChatHandle | null = null;
	let loading = false;
	/** Flow's panel is back in charge (the chat failed to load). */
	let released = false;
	let status: HTMLElement | null = null;
	const openListeners: Array<() => void> = [];
	const narrow = window.matchMedia(NARROW_QUERY);

	function persist(): void {
		writeStorage(PANEL_STATE_KEY, serialisePanelState({ open: opened, expanded }));
	}

	function syncInert(): void {
		const covered = opened && (expanded || narrow.matches);
		for (const el of document.querySelectorAll<HTMLElement>(COVERED_PAGE)) {
			if (el.inert !== covered) el.inert = covered;
		}
	}

	function apply(): void {
		button.setAttribute("aria-expanded", opened ? "true" : "false");
		button.classList.toggle("cds--header__action--active", opened);
		host.classList.toggle("cf-ai--open", opened);
		host.classList.toggle("cf-ai--expanded", expanded);
		const body = document.body.classList;
		body.toggle("cf-ai-open", opened);
		// follows the saved flag, not visibility: the width is already right when it opens
		body.toggle("cf-ai-expanded", expanded);
		syncInert();
	}

	// -- flow takeover ----------------------------------------------------------

	function takeOver(raw: string | null): FlowPanelLike | null {
		const panel = hideFlow(raw);
		// CSS hides #flow-root even when there is no panel object to hide
		document.body.classList.add("cf-ai-chat");
		registerShortcut(SHORTCUT, __("Toggle AI assistant"), toggle);
		return panel;
	}

	// Hand Ctrl+I and the screen back to flow. Its panel is not shown for the user: they
	// asked for ours, and two panels at once would be worse than the failure.
	function release(): void {
		released = true;
		document.body.classList.remove("cf-ai-chat");
		const panel = readFlowPanel();
		if (panel) registerShortcut(SHORTCUT, __("Toggle Flow panel"), () => panel.toggle());
	}

	// -- status block -----------------------------------------------------------

	function setStatus(html: string, loadingState: boolean): HTMLElement {
		const block = document.createElement("div");
		block.className = "cf-ai-status";
		if (loadingState) {
			block.setAttribute("role", "status");
			// a focus target, so a screen reader announces the state the user just asked for
			block.tabIndex = -1;
			host.setAttribute("aria-busy", "true");
		} else {
			host.removeAttribute("aria-busy");
		}
		block.innerHTML = html;
		// also drops anything a chat that threw half-way through mountChat left behind
		host.replaceChildren(block);
		status = block;
		return block;
	}

	function focusIsOnStatusOrTrigger(): boolean {
		const active = document.activeElement;
		return active !== null && ((status !== null && status.contains(active)) || active === button);
	}

	function showFailure(): void {
		const hadFocus = opened && (focusIsOnStatusOrTrigger() || document.activeElement === document.body);
		const block = setStatus(failureHtml(readFlowPanel() !== null, importFailures > 0), false);
		if (!hadFocus) return;
		const retry = block.querySelector<HTMLElement>("[data-action=retry]");
		if (retry) retry.focus();
	}

	function mount(chat: ChatModule): void {
		const takeFocus = opened && focusIsOnStatusOrTrigger();
		if (status) status.remove();
		status = null;
		host.removeAttribute("aria-busy");
		handle = chat.mountChat({
			host,
			expanded,
			onRequestClose: () => close({ restoreFocus: true }),
			onExpandedChange: (value) => {
				expanded = value;
				apply();
				persist();
			},
		});
		if (takeFocus) handle.focusInput();
	}

	async function load(focusStatus: boolean): Promise<void> {
		if (handle !== null || loading) return;
		loading = true;
		const block = setStatus(loadingHtml(), true);
		if (focusStatus) block.focus({ preventScroll: true });
		try {
			const chat = await loadChatModule();
			// a retry that worked: flow's panel was handed back, so take it over again
			if (released) {
				released = false;
				takeOver(readStorage(FLOW_PANEL_STATE_KEY));
			}
			mount(chat);
		} catch (error) {
			console.error(error);
			showFailure();
			release();
		} finally {
			loading = false;
		}
	}

	// -- open / close -----------------------------------------------------------

	function show(focus: boolean): void {
		if (opened) return;
		opened = true;
		apply();
		persist();
		for (const fn of openListeners) fn();
		if (handle) {
			if (focus) handle.focusInput();
		} else {
			void load(focus);
		}
	}

	function open(): void {
		show(true);
	}

	function close(options?: { restoreFocus?: boolean }): void {
		if (!opened) return;
		opened = false;
		apply();
		persist();
		// the host stays focusable until its slide-out ends, so focus must be moved
		// explicitly; left alone it would drop to <body> when the host turns hidden
		if (options && options.restoreFocus) button.focus();
	}

	function toggle(): void {
		if (!opened) {
			open();
			return;
		}
		const active = document.activeElement;
		close({ restoreFocus: active !== null && host.contains(active) });
	}

	// -- events -----------------------------------------------------------------

	button.addEventListener("click", () => {
		if (opened) close({ restoreFocus: true });
		else open();
	});

	// Escape while the chat is not mounted (loading, failed). Once it is, the chat owns
	// Escape: it means something else in a row, an approval card or an open toggle.
	host.addEventListener("keydown", (e) => {
		if (handle !== null || e.key !== "Escape" || e.defaultPrevented) return;
		e.preventDefault();
		// frappe's window-level Escape blurs document.activeElement, which would drop the
		// focus close() is about to give back to the trigger
		e.stopPropagation();
		close({ restoreFocus: true });
	});

	host.addEventListener("click", (e) => {
		const target = e.target;
		if (!isHTMLElement(target)) return;
		const action = target.closest<HTMLElement>(".cf-ai-status [data-action]");
		if (!action) return;
		const name = action.dataset["action"];
		if (name === "retry") {
			void load(true);
		} else if (name === "reload") {
			window.location.reload();
		} else if (name === "flow") {
			close();
			const panel = readFlowPanel();
			if (panel) panel.show();
		}
	});

	// -- boot -------------------------------------------------------------------

	// The snapshot comes first: hiding flow's panel rewrites flow-panel-state (see hideFlow)
	const flowRaw = readStorage(FLOW_PANEL_STATE_KEY);
	// the chat writes "" for a deliberate new chat, so a cleared session is not resurrected
	const seed = reconcileSession(user, readStorage(SESSION_USER_KEY), readStorage(SESSION_KEY), flowRaw);
	if (seed !== null) writeStorage(SESSION_KEY, seed);
	writeStorage(SESSION_USER_KEY, user);

	const panel = takeOver(flowRaw);
	record("Carbon AI assistant (flow takeover)", panel !== null);

	apply();
	narrow.addEventListener("change", apply);
	new MutationObserver(syncInert).observe(document.body, { childList: true });
	setTimeout(() => {
		// another `app_ready` handler of this tick may have shown flow's panel or
		// registered its Ctrl+I after us
		if (!released) {
			hideFlow(flowRaw);
			registerShortcut(SHORTCUT, __("Toggle AI assistant"), toggle);
		}
		if (saved.open) show(false);
	}, 0);

	return {
		button,
		host,
		toggle,
		open,
		close,
		isOpen: () => opened,
		onOpen: (fn) => {
			openListeners.push(fn);
		},
	};
}
