// The lazy chat bundle's entry: what the header button import()s on first open.
// scripts/build-ai-chat.ts builds this file (and everything it pulls in) as split ESM
// into public/dist/ai_chat/. It is not named `*.bundle.*`, so frappe's own esbuild
// pass never sees it, and the always-loaded anatomy code names it by type only.
//
// The shell side checks the import result with `isChatModule` (anatomy/shell/
// assistant_gate.ts) before calling anything, so a stale entry that predates a contract
// change is a handled load failure rather than a TypeError at the first click.
//
// register.ts holds the element registrations (deep imports of the prompt-line pieces,
// never `prompt-line/index.js`, whose barrel statically pulls tiptap into the first
// load). It is imported first so every element is defined before a view creates one.
import "./register.ts";
import { createController } from "./controller.ts";
import { globalTranslate } from "./i18n.ts";
import type { Translate } from "./i18n.ts";
import { createChatStore } from "./store.ts";
import { readTimeZones } from "./timestamps.ts";
import { readUploadLimits } from "./uploads.ts";
import { createPanel } from "./view/panel.ts";

/** Bump together with CHAT_CONTRACT_VERSION in assistant_gate.ts on any breaking change below. */
export const CHAT_CONTRACT = 1;

export interface ChatMountOptions {
	/**
	 * `aside#cf-ai-panel`, already in the document and already styled by the always-loaded
	 * stylesheet. mountChat appends exactly one child to it (the chat shell) and, in
	 * `dispose`, removes it again. It must not read or write the host's own attributes or
	 * classes: the shell side owns open/expanded/hidden.
	 */
	host: HTMLElement;
	/** The saved expanded state, applied before the first paint of the header icon. */
	expanded: boolean;
	/** The header's close button, or Escape outside a message row: the shell side closes and restores focus. */
	onRequestClose(): void;
	/** The header's expand/collapse button, after the module updated its own icon. */
	onExpandedChange(expanded: boolean): void;
	/** Defaults to frappe's `__`. Tests and non-desk hosts pass their own. */
	translate?: Translate;
}

export interface ChatHandle {
	/** Move focus to the prompt line. Safe to call before the elements finish upgrading (it waits). */
	focusInput(): void;
	/** Remove everything `mountChat` added and release the controller, listeners and observers. */
	dispose(): void;
}

/** The shape of this module as the shell side sees it. */
export interface ChatModule {
	readonly CHAT_CONTRACT: 1;
	mountChat(options: ChatMountOptions): ChatHandle;
}

/** A tag Intl accepts, else English: a malformed `frappe.boot.lang` must not stop the panel from mounting. */
function localeOf(tag: string | undefined): string {
	try {
		return Intl.getCanonicalLocales(tag ?? "en")[0] ?? "en";
	} catch {
		return "en";
	}
}

export function mountChat(options: ChatMountOptions): ChatHandle {
	const translate = options.translate ?? globalTranslate();
	const store = createChatStore();
	// frappe.boot.time_zone is not in frappe-types; readTimeZones reads it as unknown.
	const zones = readTimeZones(frappe.boot);
	// flow_supported_file_types is flow's boot key, which frappe-types does not declare.
	const uploadLimits = readUploadLimits(frappe.boot);
	const locale = localeOf(frappe.boot.lang);
	const controller = createController({
		store,
		translate,
		user: frappe.session.user ?? "",
		uploadLimits,
		locale,
		...(zones.system !== undefined && { systemTimeZone: zones.system }),
	});
	const panel = createPanel({
		controller,
		store,
		translate,
		locale,
		timeZone: zones.user,
		firstName: frappe.boot.user.first_name || frappe.session.user_fullname || "",
		canConfigure: frappe.boot.user.roles.includes("System Manager"),
		uploadLimits,
		expanded: options.expanded,
		countAgents: () => frappe.db.count("Flow Agent", { filters: { enabled: 1 } }),
		// show_alert interpolates the message into markup as is.
		notify: (message) => {
			frappe.show_alert({ message: frappe.utils.escape_html(message), indicator: "red" });
		},
		onRequestClose: options.onRequestClose,
		onExpandedChange: options.onExpandedChange,
	});
	options.host.append(panel.element);
	// Not awaited: a failed restore shows as the store's `error` status, not as a rejection.
	void controller.start();
	return {
		focusInput: () => panel.focusInput(),
		dispose() {
			controller.dispose();
			panel.dispose();
			panel.element.remove();
		},
	};
}
