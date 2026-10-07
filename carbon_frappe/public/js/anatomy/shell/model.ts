// The header's view model, read from frappe's module sidebar.
//
// Carbon's global header names the product and carries its top-level
// navigation. In frappe v16.50 both of those are facts the LEFT sidebar already
// knows: `frappe.app.sidebar` resolves the route to a SHELL (a key of
// `frappe.boot.module_sidebars`; `set_workspace_sidebar`, ui/sidebar/sidebar.js:812),
// keeps it in `current_module`, finds the app that owns it (`get_sidebar_app()`,
// :282-289) and renders its items. The header is a PROJECTION of that — it never
// resolves routes or builds hrefs itself.
//
// The items come from the sidebar's rendered DOM rather than from
// `boot.module_sidebars[shell].items`, deliberately. `get_route()`
// (sidebar_item.js:58-138) has six routing branches — reports gated on an enabled
// Report doc, public vs private workspaces, URLs, pages with route_options,
// doctypes with filters, tabs — plus the shell prefix `in_shell()` writes into every
// desk href (:17-30), and `make()` (:161-166) drops any item that resolves to no
// path. Reading the DOM inherits all of it; re-deriving it from the data would be a
// second router that drifts. Labels are also already translated there (sidebar.py:2079).
//
// What the DOM projection depends on (sidebar_item.html):
//   .sidebar-items > .sidebar-item-container            one per top-level row (:2)
//     [.section-item]                                   a Section Break (:2)
//     > .standard-sidebar-item > .item-anchor           the row's anchor (:7, :11, :25)
//         > .sidebar-item-label                         the label (:12, :33)
//     > .nested-container > .sidebar-item-container     the section's children (:43)
// `href` is written only when frappe computed a path (:21-24); an anchor with no
// href is a Section Break drawn as a collapsible row, whose click toggles its
// children (sidebar_item.js:327-345). Those become "actions" that delegate the
// click back to frappe's element.
//
// What changed from 16.33 is the STATE, not the markup: the name and the app come
// from `current_module` / `sidebar_data.label` / `get_sidebar_app()`
// (`sidebar_title`, `choose_app_name()` and `frappe.current_app` are gone), and
// "which row is current" is the one `.active-sidebar` that `find_active_item()`
// writes (sidebar.js:547-575), not a second pathname rule re-derived here.
import type { FrappeBootAppEntry, FrappeSidebar } from "frappe-types";
import { text } from "./dom.ts";

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
	/** The app title (regular weight), or `""` when no app owns the shell on screen. */
	prefix: string;
	/** The product name (semibold): the module's label, or "Desktop" on the launcher. */
	name: string;
	/**
	 * `sidebar.current_module` — the shell on screen — or `""` on the launcher.
	 * The switcher marks the app (or, on the icon grid, the icon) that opens it.
	 */
	module: string;
	/** Where the header name links: the shell's landing route, its app's, or `/desk`. */
	home: string;
	items: ShellItem[];
	/** No sidebar to project — the launcher, a page that hides the panel, or before the first `setup()`. */
	navHidden: boolean;
	/** The sidebar wrapper is hidden, so toggling it would only flip localStorage. */
	menuDisabled: boolean;
	/** `sidebar.sidebar_expanded`, defaulting to collapsed. */
	expanded: boolean;
	/** `get_sidebar_app()`: the `app_data` entry that owns the shell on screen, for the prefix and the switcher. */
	app: FrappeBootAppEntry | null | undefined;
	/** Everything the nav and name render from, joined — equal means "nothing to re-render". */
	signature: string;
}

/**
 * The href of the one sidebar row frappe lit as current, or `null`.
 *
 * `find_active_item()` scores every `.item-anchor[href]` by `route_claim()` and
 * `highlight_active_item()` writes `.active-sidebar` on the winner's
 * `.standard-sidebar-item` (sidebar.js:513-518, 547-575) — one row, the longest
 * and most specific claim. Scoped to `.sidebar-items` because the sidebar header
 * also takes the class while its menu is open (sidebar_header.js:273-283).
 */
export function activeHref(): string | null {
	const anchor = document.querySelector(".body-sidebar .sidebar-items .active-sidebar > a.item-anchor[href]");
	return anchor ? anchor.getAttribute("href") : null;
}

/**
 * The slice of `Element` the sidebar walk reads. Narrower than `Element` so the walk
 * can be run over a fake tree in a unit test (test/unit/model.test.ts), which has no DOM;
 * every `Element` satisfies it.
 */
export interface RowNode {
	getAttribute(name: string): string | null;
	querySelector(selectors: string): RowNode | null;
	querySelectorAll(selectors: string): Iterable<RowNode>;
	readonly classList: { contains(token: string): boolean };
	readonly textContent: string | null;
}

function leaf(anchor: RowNode, key: string, label: string): ShellLeaf | null {
	const href = anchor.getAttribute("href");
	if (href) {
		return { kind: "link", key, label, href, target: anchor.getAttribute("target") || null };
	}
	// no href: a Section Break drawn as a row (or drift). Only a real HTMLElement
	// can receive the delegated click.
	if (anchor instanceof HTMLElement) return { kind: "action", key, label, source: anchor };
	return null;
}

function rowAnchor(container: RowNode): RowNode | null {
	return container.querySelector(":scope > .standard-sidebar-item > .item-anchor");
}

function rowLabel(anchor: RowNode | null): string {
	return text(anchor && anchor.querySelector(":scope > .sidebar-item-label"));
}

function readChildren(section: RowNode, prefix: string): ShellLeaf[] {
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
export function readSidebar(body: RowNode): ShellItem[] {
	const out: ShellItem[] = [];
	let i = 0;
	for (const c of body.querySelectorAll(":scope .sidebar-items > .sidebar-item-container")) {
		const anchor = rowAnchor(c);
		const label = rowLabel(anchor);
		// Spacers render no label; a row with no anchor is chrome, not navigation
		if (!anchor || !label) continue;
		const key = `${i++}`;
		if (c.classList.contains("section-item")) {
			const items = readChildren(c, key);
			// an empty section has nothing to open
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
	module: string,
	home: string,
	navHidden: boolean,
	items: ShellItem[],
): string {
	const parts: string[] = [prefix, name, module, home, navHidden ? "hidden" : "shown"];
	for (const item of items) {
		if (item.kind === "group") {
			parts.push(
				`group:${item.label}[${item.items.map((k) => `${k.kind}:${k.label}:${k.kind === "link" ? k.href : ""}`).join("|")}]`,
			);
		} else {
			parts.push(`${item.kind}:${item.label}:${item.kind === "link" ? item.href : ""}`);
		}
	}
	return parts.join("\u0000");
}

const EMPTY: Omit<ShellModel, "signature"> = {
	prefix: "",
	name: "",
	module: "",
	home: "/desk",
	items: [],
	navHidden: true,
	menuDisabled: true,
	expanded: false,
	app: undefined,
};

function withSignature(m: Omit<ShellModel, "signature">): ShellModel {
	return { ...m, signature: signatureOf(m.prefix, m.name, m.module, m.home, m.navHidden, m.items) };
}

/**
 * Whether the page on screen is the launcher.
 *
 * `/desk` itself renders the Desktop page, which opts out of both shells
 * (desktop.js:22-23: `hide_sidebar` and `hide_dock`), and `Sidebar` answers each
 * decision with `page_allows_sidebar()` / `page_allows_dock()` (sidebar.js:342-356).
 * A page that hides both has no module to name, whatever `current_module` still
 * holds from the last page — `set_workspace_sidebar` keeps the shell on screen
 * for a route it does not know and chooses the user's home shell for an empty
 * one (:825-836), so `current_module` is set on the launcher too. Before the first
 * page exists both answers are false, which reads as the launcher as well.
 */
function onLauncher(sidebar: FrappeSidebar): boolean {
	return !sidebar.page_allows_sidebar() && !sidebar.page_allows_dock();
}

/**
 * Read the header's state from the live sidebar.
 *
 * `frappe.app` is `{}` until the Application constructor returns (desk.js:7-12)
 * and the Sidebar constructor bails on an incomplete setup (sidebar.js:58-60),
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
	// `apply_page_visibility()` hides the wrapper with jQuery's `.hide()`, an inline
	// `display: none` (sidebar.js:359-370). Not `:hidden`, which also answers true for
	// a zero-width box — and a collapsed sidebar beside a pinned dock is one
	// (`.sidebar-hidden`, dock.scss), which would disable the hamburger that reopens it.
	const el = wrapper ? wrapper.get(0) : undefined;
	const hidden = !el || getComputedStyle(el).display === "none";

	const module = sidebar.current_module;
	if (!module || onLauncher(sidebar)) {
		return withSignature({ ...EMPTY, name: desktop, expanded, menuDisabled: hidden });
	}

	const app = sidebar.get_sidebar_app();
	const data = sidebar.sidebar_data;
	const prefix = app ? translate(app.app_title || app.app_name) : "";
	const name = translate((data && data.label) || module);
	const items = el ? readSidebar(el) : [];
	const first = firstLink(items);
	// the dock's own "open this module" route (sidebar.js:1058-1067), so the name and
	// the dock tile cannot disagree; the rendered first link only when that is null
	const home = sidebar.module_landing_route(module) || (first && first.href) || "/desk";

	return withSignature({
		prefix,
		name,
		module,
		home,
		items,
		navHidden: hidden,
		menuDisabled: hidden,
		expanded,
		app,
	});
}
