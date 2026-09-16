// The switcher's view model: frappe's desktop, as a tree.
//
// The `/desk` landing page (desk/page/desktop/desktop.js) lays out
// `frappe.boot.desktop_icons` — every Desktop Icon the user may see, already
// permission-filtered and idx-sorted by the server
// (desk/doctype/desktop_icon/desktop_icon.py:122-213). The switcher shows the
// same icons, in the same order, with the same nesting, so the rules here are
// the desktop page's own, re-applied over the boot data:
//
//   - `DesktopPage.prepare()` (desktop.js:184-211): a `hidden` icon is dropped;
//     an icon whose `parent_icon` names a VISIBLE icon nests under it; any other
//     icon — no parent, or a hidden one — is a top-level row. That promotion is
//     why ERPNext's workspaces sit at the top level on a stock site: the
//     "ERPNext" App icon ships hidden (its label collides with the app title).
//   - `DesktopIcon.validate_icon()` (:1082-1093): a Folder with no visible
//     children is not rendered; "My Workspaces" is not rendered while its
//     sidebar is empty.
//   - `DesktopIcon.setup_click()` (:1121-1147): ANY icon with children — a
//     Folder or an App — opens the children instead of navigating, so both
//     kinds are expandable rows here and neither carries an href of its own.
//   - `get_route(desktop_icon)` (:46-110) is `frappe.utils.get_route_for_icon`
//     (utils/utils.js:1314-1370) with `window.location.origin` prefixed for
//     External links; the leaf's href is that route, `_blank` when it is
//     absolute (:1149-1151). A leaf the route cannot resolve shows a msgprint
//     on the desktop (:1155-1161); it is skipped here — a switcher row that
//     only says "misconfigured" is noise, and the desktop still reports it.
//   - Children keep `idx` order (`get_child_icons_data`, :1094-1096); the
//     top level keeps boot order. Boot is already idx-sorted, and the sort is
//     stable, so both are "boot order".
//   - Labels are `__(icon.label)` (ui/desktop_icon.html:19).
//
// NOT `ui/sidebar/sidebar_header.js`'s "Workspaces" menu: that one is scoped
// to `frappe.current_app`, moves Folders first, and drops External icons —
// three ways it differs from the desktop the user is asked to recognise.
//
// Also not the user's saved Desktop Layout (edit-mode reorders and hides):
// that is fetched by the landing page from its own template context
// (desktop.py:17, desktop.js:253-255) and is not in boot. Reading it here
// would be one more request per session; this module takes boot only, and
// `buildDesktopTree`'s signature is the seam if that changes.
//
// Pure: takes the boot arrays and the current sidebar title, returns a tree.
// Nothing here touches the DOM, so the rules can be checked against fixtures.
import type { FrappeDesktopIconRecord, FrappeWorkspaceSidebar } from "frappe-types";

/** One switcher row. `children` non-empty ⇒ an expandable row with no href. */
export interface DesktopEntry {
	/** The icon's untranslated label — the key `sidebar_title` is matched against. */
	label: string;
	/** Translated, for display. */
	title: string;
	/** `null` for expandable rows. */
	href: string | null;
	/** `_blank` for absolute URLs, as the desktop sets it. */
	target: string | null;
	/** The icon whose label is the current Workspace Sidebar's title. */
	selected: boolean;
	children: DesktopEntry[];
}

function translate(s: string): string {
	return typeof __ === "function" ? __(s) : s;
}

/**
 * The desktop's route for a leaf, or `null` when frappe cannot resolve one.
 *
 * `get_route_for_icon` is the desktop's `get_route` minus the origin prefix
 * on External links (utils.js:1318-1319 vs desktop.js:51-54); the prefix only
 * matters for `startsWith("http")`, which is checked on the raw link here.
 */
function routeFor(icon: FrappeDesktopIconRecord): { href: string; target: string | null } | null {
	const utils = window.frappe && frappe.utils;
	if (!utils || typeof utils.get_route_for_icon !== "function") return null;
	const route = utils.get_route_for_icon(icon);
	if (!route) return null;
	return { href: route, target: /^https?:/.test(route) ? "_blank" : null };
}

/**
 * Build the desktop's icon tree.
 *
 * @param icons    `frappe.boot.desktop_icons`
 * @param sidebars `frappe.boot.workspace_sidebar_item`, for the "My Workspaces" rule
 * @param current  the current `sidebar.sidebar_title` (untranslated), or `""`
 */
export function buildDesktopTree(
	icons: readonly FrappeDesktopIconRecord[],
	sidebars: Readonly<Record<string, FrappeWorkspaceSidebar>>,
	current: string,
): DesktopEntry[] {
	// prepare(): the visible icons, by label — a parent must be in here to nest
	const visible = new Map<string, FrappeDesktopIconRecord>();
	for (const icon of icons) {
		if (icon.hidden === 1) continue;
		visible.set(icon.label, icon);
	}

	// validate_icon(): "My Workspaces" only while its sidebar has items
	const myWorkspaces = sidebars["my workspaces"];
	if (visible.has("My Workspaces") && !(myWorkspaces && myWorkspaces.items.length)) {
		visible.delete("My Workspaces");
	}

	// children by parent label, in boot (= idx) order
	const childrenOf = new Map<string, FrappeDesktopIconRecord[]>();
	const top: FrappeDesktopIconRecord[] = [];
	for (const icon of visible.values()) {
		const parent = icon.parent_icon;
		if (parent && visible.has(parent) && parent !== icon.label) {
			const list = childrenOf.get(parent);
			if (list) list.push(icon);
			else childrenOf.set(parent, [icon]);
		} else {
			top.push(icon);
		}
	}

	function leaf(icon: FrappeDesktopIconRecord): DesktopEntry | null {
		const route = routeFor(icon);
		if (!route) return null;
		return {
			label: icon.label,
			title: translate(icon.label),
			selected: !!current && icon.label === current,
			href: route.href,
			target: route.target,
			children: [],
		};
	}

	function entry(icon: FrappeDesktopIconRecord): DesktopEntry | null {
		const children: DesktopEntry[] = [];
		for (const k of childrenOf.get(icon.label) || []) {
			// one level: the desktop's modal lists a folder's icons flat
			const child = leaf(k);
			if (child) children.push(child);
		}
		if (children.length) {
			return {
				label: icon.label,
				title: translate(icon.label),
				selected: !!current && icon.label === current,
				href: null,
				target: null,
				children,
			};
		}
		// an empty Folder is not rendered (validate_icon); an App with nothing
		// routable under it is still its own link
		if (icon.icon_type === "Folder") return null;
		return leaf(icon);
	}

	const out: DesktopEntry[] = [];
	for (const icon of top) {
		const e = entry(icon);
		if (e) out.push(e);
	}
	return out;
}
