// The switcher's view model: what frappe's `/desk` desktop lays out, as a tree.
//
// Two desktops exist in v16.50, chosen by Desktop Settings -> Desktop Page
// (boot.py:265-270), and the switcher mirrors whichever one the site renders:
//
// 1. THE APPS SCREEN (`Apps`, the default). `DesktopPage.render_app_icons`
//    (desk/page/desktop/desktop.js:169-212) draws one tile per `app_data` entry
//    that opted into the screen (`on_apps_screen`), ordered by `sequence_id`
//    (lower first, ties in installed-apps order — `sort()` is stable), and each
//    tile leads to `sidebar.app_landing_route(app) || app.app_route || "/desk"`,
//    in a new tab when that is an absolute URL (:216-219). That is also exactly
//    the "Apps" submenu of frappe's own sidebar-header menu, which has no rail
//    to switch with (ui/sidebar/sidebar_header.js:192-225): the two are one list.
//    The current app (`sidebar.get_sidebar_app()`) is the selected row. Modules
//    inside an app are NOT here: the dock is the module switcher, and a module
//    row under an app would show the same list twice.
//
// 2. THE DESKTOP ICON GRID (`Desktop Icons`, retiring — desk/RETIRING.md). The
//    grid is `frappe.boot.desktop_icons`, which the server puts in the payload
//    ONLY in this mode (boot.py:265-270), permission-filtered and idx-sorted
//    (desk/doctype/desktop_icon/desktop_icon.py:243-310). The rules re-applied
//    over it are the grid's own (public/js/desktop_icons.bundle.js):
//      - `DesktopIconsPage.prepare()` (:167-198): a `hidden` icon is dropped; an
//        icon whose `parent_icon` names a VISIBLE icon nests under it; any other
//        icon — no parent, or a hidden one — is a top-level row.
//      - `DesktopIcon.validate_icon()` (:627-632): a Folder with no visible
//        children is not rendered.
//      - `DesktopIcon.setup_click()` (:707-751): ANY icon with children — a Folder
//        or an App — opens the children instead of navigating, so both kinds are
//        expandable rows here and neither carries an href of its own.
//      - Order: every grid sorts its icons by `idx`, then by label
//        (`DesktopIconGrid.prepare()`, :413-419, which the top level and a
//        folder's modal both go through), whatever order boot sent them in.
//      - Labels are `__(icon.label)` (ui/desktop_icons_item.html:19).
//    A leaf the route cannot resolve shows a msgprint on the desktop (:741-748);
//    it is skipped here — a switcher row that only says "misconfigured" is noise,
//    and the desktop still reports it. The user's saved Desktop Layout (edit
//    mode reorders and hides) arrives from the page's own template context
//    (desktop.html `#desktop-layout`), not boot, and is not read.
//
// Pure: both builders take the boot arrays plus a route resolver and return a
// tree. Nothing here touches the DOM or `frappe`, so the rules can be checked
// against fixtures (test/unit/desktop.test.ts); shell/switcher.ts supplies the
// resolvers.
import type { FrappeBootAppEntry, FrappeDesktopIconRecord } from "frappe-types";

/** One switcher row. `children` non-empty ⇒ an expandable row with no href. */
export interface DesktopEntry {
	/** The row's identity: an app's `app_name`, or an icon's untranslated label. Keys the expanded set. */
	label: string;
	/** Translated, for display. */
	title: string;
	/** `null` for expandable rows. */
	href: string | null;
	/** `_blank` for absolute URLs, as the desktop sets it. */
	target: string | null;
	/** The app, or the icon, that owns the shell on screen. */
	selected: boolean;
	children: DesktopEntry[];
}

/** Where a desktop icon leads, and the shell it opens, as `DesktopIcon.icon_route` resolves them. */
export interface IconRoute {
	href: string;
	/** The `module_sidebars` key the icon opens, or `null` for an External link. */
	shell: string | null;
}

export interface DesktopTranslate {
	(s: string): string;
}

const identity: DesktopTranslate = (s) => s;

function targetFor(href: string): string | null {
	return href.startsWith("http") ? "_blank" : null;
}

/**
 * The Apps screen's tiles, as switcher rows.
 *
 * @param apps       `frappe.boot.app_data`
 * @param current    `app_name` of `sidebar.get_sidebar_app()`, or `null` on the launcher
 * @param route      `sidebar.app_landing_route(app)`
 * @param translate  `__`
 */
export function buildAppsTree(
	apps: readonly FrappeBootAppEntry[],
	current: string | null,
	route: (app: FrappeBootAppEntry) => string | null | undefined,
	translate: DesktopTranslate = identity,
): DesktopEntry[] {
	return apps
		.filter((app) => app.on_apps_screen)
		.map((app, index) => ({ app, index }))
		.sort((a, b) => (a.app.sequence_id ?? 100) - (b.app.sequence_id ?? 100) || a.index - b.index)
		.map(({ app }) => {
			const href = route(app) || app.app_route || "/desk";
			return {
				label: app.app_name,
				title: translate(app.app_title || app.app_name),
				href,
				target: targetFor(href),
				selected: !!current && app.app_name === current,
				children: [],
			};
		});
}

/**
 * The Desktop Icon grid, as switcher rows.
 *
 * @param icons    `frappe.boot.desktop_icons`
 * @param current  the `module_sidebars` key on screen (`sidebar.current_module`), or `""`
 * @param resolve  the grid's `get_route` for an icon, plus the shell it opens
 */
export function buildDesktopTree(
	icons: readonly FrappeDesktopIconRecord[],
	current: string,
	resolve: (icon: FrappeDesktopIconRecord) => IconRoute | null,
	translate: DesktopTranslate = identity,
): DesktopEntry[] {
	// prepare(): the visible icons, by label — a parent must be in here to nest
	const visible = new Map<string, FrappeDesktopIconRecord>();
	for (const icon of icons) {
		if (icon.hidden === 1) continue;
		visible.set(icon.label, icon);
	}

	// children by parent label
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

	// the grid's order: `idx`, then label, as `localeCompare` says (no locale argument, as there)
	const gridOrder = (a: FrappeDesktopIconRecord, b: FrappeDesktopIconRecord): number =>
		a.idx === b.idx ? a.label.localeCompare(b.label) : a.idx - b.idx;
	top.sort(gridOrder);

	function leaf(icon: FrappeDesktopIconRecord): DesktopEntry | null {
		const route = resolve(icon);
		if (!route) return null;
		return {
			label: icon.label,
			title: translate(icon.label),
			selected: !!current && route.shell === current,
			href: route.href,
			target: targetFor(route.href),
			children: [],
		};
	}

	function entry(icon: FrappeDesktopIconRecord): DesktopEntry | null {
		const children: DesktopEntry[] = [];
		for (const k of (childrenOf.get(icon.label) || []).sort(gridOrder)) {
			// one level: the desktop's modal lists a folder's icons flat
			const child = leaf(k);
			if (child) children.push(child);
		}
		if (children.length) {
			return {
				label: icon.label,
				title: translate(icon.label),
				selected: false,
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
