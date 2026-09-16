// The header's view model, read from frappe's Workspace Sidebar.
//
// Carbon's global header names the product and carries its top-level
// navigation. In frappe v16 both of those are facts the LEFT sidebar already
// knows: `frappe.app.sidebar` resolves the route to a Workspace Sidebar
// (ui/sidebar/sidebar.js:665-689), names it (`sidebar_title`), finds the app
// that owns it (`choose_app_name()`, :43-77), and renders its items. The header
// is a PROJECTION of that — it never resolves routes or builds hrefs itself.
//
// The items come from the sidebar's rendered DOM rather than from
// `boot.workspace_sidebar_item`, deliberately. `TypeLink.get_path()`
// (sidebar_item.js:14-76) has six routing branches — reports gated on an
// enabled Report doc, public vs private workspaces, URLs, pages with
// route_options, doctypes with filters, tabs — and `make()` (:87-90) drops any
// item that resolves to no path. Reading the DOM inherits both the routing and
// those render decisions; re-deriving them from the data would be a second
// router that drifts. Labels are also already translated there (boot.py:465).
//
// What the DOM projection depends on (sidebar_item.html):
//   .sidebar-items > .sidebar-item-container            one per top-level row (:1)
//     [.section-item]                                   a Section Break (:2)
//     > .standard-sidebar-item > .item-anchor           the row's anchor (:10, :14, :23)
//         > .sidebar-item-label                         the label (:15, :39)
//     > .nested-container > .sidebar-item-container     the section's children (:61)
// `href` is written only when frappe computed a path (:24-26); an anchor with
// no href is a Sidebar Item Group, whose click opens a dialog from a handler
// on its wrapper (sidebar_item.js:369). Those become "actions" that delegate
// the click back to frappe's element.
import type { FrappeBootAppEntry, FrappeSidebar } from "frappe-types";
import { text } from "./dom";

/** A navigable item: frappe computed an href for it. */
export interface ShellLink {
	kind: "link";
	/** Index path within the sidebar, e.g. `"5/2"`; stable for one render. */
	key: string;
	label: string;
	href: string;
	/** `_blank` for URL items (sidebar_item.html:26); `null` otherwise. */
	target: string | null;
}

/** An item frappe renders without an href — its click lives on frappe's node. */
export interface ShellAction {
	kind: "action";
	key: string;
	label: string;
	/** frappe's own anchor; the header delegates `click()` to it. */
	source: HTMLElement;
}

/** A Section Break with children — a Carbon sub-menu. */
export interface ShellGroup {
	kind: "group";
	key: string;
	label: string;
	items: ShellLeaf[];
}

export type ShellLeaf = ShellLink | ShellAction;
export type ShellItem = ShellLeaf | ShellGroup;

export interface ShellModel {
	/** The app title (regular weight), or `""` when nothing owns the sidebar. */
	prefix: string;
	/** The product name (semibold): the workspace title, or "Desktop" on the launcher. */
	name: string;
	/**
	 * `sidebar.sidebar_title` as stored — untranslated, `""` on the launcher.
	 * Desktop Icon labels are matched against this (shell/desktop.ts), the way
	 * `SidebarHeader.set_header_icon` finds the icon for the current sidebar
	 * (sidebar_header.js:279-281).
	 */
	workspace: string;
	/** Where the header name links: the sidebar's first link, the app's home, or `/desk`. */
	home: string;
	items: ShellItem[];
	/** No sidebar to project — the landing page, a `hide_sidebar` page, or before the first `setup()`. */
	navHidden: boolean;
	/** The sidebar wrapper is hidden, so toggling it would only flip localStorage. */
	menuDisabled: boolean;
	/** `sidebar.sidebar_expanded`, defaulting to collapsed. */
	expanded: boolean;
	/** The `app_data` entry that owns the current sidebar, for the prefix and the switcher. */
	app: FrappeBootAppEntry | undefined;
	/** Everything the nav and name render from, joined — equal means "nothing to re-render". */
	signature: string;
}

/**
 * The app that owns the current sidebar — `choose_app_name()`'s own
 * predicate (sidebar.js:47-50), re-applied.
 *
 * Not `frappe.current_app`: that is assigned only on a match (:53) and never
 * cleared, so after "My Workspaces" or a folder sidebar it still names the
 * previous app while `header_subtitle` has moved on to the user / folder.
 */
export function appForSidebar(sidebar: FrappeSidebar): FrappeBootAppEntry | undefined {
	const title = sidebar.sidebar_title;
	const owner = sidebar.sidebar_data && sidebar.sidebar_data.app;
	if (!title && !owner) return undefined;
	const apps = (window.frappe && frappe.boot && frappe.boot.app_data) || [];
	return apps.find((a) => (!!title && a.workspaces.includes(title)) || (!!owner && a.app_name === owner));
}

/**
 * frappe's own current-item rule (sidebar.js:424-433): the href, stripped of
 * query and hash and any trailing slash, equals the pathname or is a
 * `/`-terminated prefix of it.
 */
export function isCurrentHref(href: string): boolean {
	const clean = (s: string): string => {
		try {
			return decodeURIComponent(s).replace(/\/$/, "");
		} catch (e) {
			return s.replace(/\/$/, "");
		}
	};
	const bare = (href.split("?")[0] ?? "").split("#")[0] ?? "";
	const h = clean(bare);
	const p = clean(window.location.pathname);
	return !!h && h !== "#" && (p === h || p.startsWith(h + "/"));
}

function leaf(anchor: Element, key: string, label: string): ShellLeaf | null {
	const href = anchor.getAttribute("href");
	if (href) {
		return { kind: "link", key, label, href, target: anchor.getAttribute("target") || null };
	}
	// no href: a Sidebar Item Group (or drift). Only a real HTMLElement can
	// receive the delegated click.
	if (anchor instanceof HTMLElement) return { kind: "action", key, label, source: anchor };
	return null;
}

function rowAnchor(container: Element): Element | null {
	return container.querySelector(":scope > .standard-sidebar-item > .item-anchor");
}

function rowLabel(anchor: Element | null): string {
	return text(anchor && anchor.querySelector(":scope > .sidebar-item-label"));
}

function readChildren(section: Element, prefix: string): ShellLeaf[] {
	const out: ShellLeaf[] = [];
	const nested = section.querySelector(":scope > .nested-container");
	if (!nested) return out;
	let i = 0;
	for (const c of nested.querySelectorAll(":scope > .sidebar-item-container")) {
		const anchor = rowAnchor(c);
		const label = rowLabel(anchor);
		if (!anchor || !label) continue;
		const item = leaf(anchor, `${prefix}/${i++}`, label);
		if (item) out.push(item);
	}
	return out;
}

/** Walk the sidebar's rendered rows, in order. */
export function readSidebar(body: Element): ShellItem[] {
	const out: ShellItem[] = [];
	let i = 0;
	for (const c of body.querySelectorAll(":scope .sidebar-items > .sidebar-item-container")) {
		const anchor = rowAnchor(c);
		const label = rowLabel(anchor);
		// Spacers render no label; edit-mode chrome renders no anchor
		if (!anchor || !label) continue;
		const key = `${i++}`;
		if (c.classList.contains("section-item")) {
			const items = readChildren(c, key);
			// an empty section (edit mode renders them) has nothing to open
			if (items.length) out.push({ kind: "group", key, label, items });
			continue;
		}
		const item = leaf(anchor, key, label);
		if (item) out.push(item);
	}
	return out;
}

function firstLink(items: ShellItem[]): ShellLink | undefined {
	for (const item of items) {
		if (item.kind === "link") return item;
	}
	return undefined;
}

function signatureOf(
	prefix: string,
	name: string,
	workspace: string,
	home: string,
	navHidden: boolean,
	items: ShellItem[],
): string {
	const parts: string[] = [prefix, name, workspace, home, navHidden ? "hidden" : "shown"];
	for (const item of items) {
		if (item.kind === "group") {
			parts.push(
				`group:${item.label}[${item.items.map((k) => `${k.kind}:${k.label}:${k.kind === "link" ? k.href : ""}`).join("|")}]`,
			);
		} else {
			parts.push(`${item.kind}:${item.label}:${item.kind === "link" ? item.href : ""}`);
		}
	}
	return parts.join(" ");
}

const EMPTY: Omit<ShellModel, "signature"> = {
	prefix: "",
	name: "",
	workspace: "",
	home: "/desk",
	items: [],
	navHidden: true,
	menuDisabled: true,
	expanded: false,
	app: undefined,
};

function withSignature(m: Omit<ShellModel, "signature">): ShellModel {
	return { ...m, signature: signatureOf(m.prefix, m.name, m.workspace, m.home, m.navHidden, m.items) };
}

/**
 * Read the header's state from the live sidebar.
 *
 * `frappe.app` is `{}` until the Application constructor returns (desk.js:10-12)
 * and the Sidebar constructor bails on an incomplete setup (sidebar.js:5-8),
 * so every step is guarded and the fallback is the launcher state.
 */
export function readModel(): ShellModel {
	const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
	// `typeof` on the ambient `__` does not throw when translate.js has not
	// loaded, which is the only reason it is not a bare call.
	const translate = (s: string): string => (typeof __ === "function" ? __(s) : s);
	const desktop = translate("Desktop");
	if (!sidebar) return withSignature({ ...EMPTY, name: desktop });

	const wrapper = sidebar.wrapper;
	const expanded = sidebar.sidebar_expanded === true;
	// The wrapper is hidden by container.js:87-93 on every `hide_sidebar` page
	// (the launcher above all), and `current_sub_path` is `""` on `/desk`
	// (router.js:146, 515-522). Both are read AFTER the route rendered, which
	// is when every caller of this function runs.
	const hidden = !wrapper || wrapper.is(":hidden");
	const landing = !!frappe.router && frappe.router.current_sub_path === "";

	if (landing || !sidebar.sidebar_title) {
		return withSignature({ ...EMPTY, name: desktop, expanded, menuDisabled: hidden });
	}

	const app = appForSidebar(sidebar);
	const prefix = app ? app.app_title : sidebar.header_subtitle || "";
	const name = translate(sidebar.sidebar_title);
	const body = wrapper ? wrapper.get(0) : undefined;
	const items = body ? readSidebar(body) : [];
	const first = firstLink(items);
	const home = first ? first.href : (app && app.app_route) || "/desk";

	return withSignature({
		prefix,
		name,
		workspace: sidebar.sidebar_title,
		home,
		items,
		navHidden: hidden,
		menuDisabled: hidden,
		expanded,
		app,
	});
}
