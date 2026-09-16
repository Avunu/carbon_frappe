// The header's global bar: frappe's own search, notifications and account
// controls, MOVED into `.cds--header__global` and presented as Carbon
// `cds--header__action` cells.
//
// Carbon (components/UI-shell-header): "Header utilities: these utilities are
// reserved for universal, system-level functions such as profile, search,
// notifications". frappe v16 builds exactly those three — as the first two
// rows of the Workspace Sidebar (`add_standard_items`, ui/sidebar/sidebar.js:503-543)
// plus the account button at its foot (sidebar.html:50-68) — or, on the
// landing page, as its own `.desktop-navbar` (desk/page/desktop/desktop.html).
//
// Everything is MOVED, never cloned: frappe binds handlers to those exact
// nodes (the awesomebar to `#navbar-modal-search`, sidebar.js:544-546; the
// bell's `onClick` to its wrapper, sidebar_item.js:420-425), so relocating
// keeps them live and avoids a second copy of each affordance.
//
// Three frappe facts this has to work around, each guarded in
// scripts/markup-manifest.ts:
//
// 1. `TypeButton` REPLACES its container's class list with `item.class`
//    (sidebar_item.js:414), so the search and bell rows are
//    `#navbar-modal-search.navbar-search-bar` and `.sidebar-notification`, not
//    `.sidebar-item-container` — the presence test below looks for the inner
//    `.standard-sidebar-item`, which survives.
// 2. `NotificationsView` resolves its unread badge and bell indicator via
//    `this.parent.closest(".body-sidebar")` (notifications.js:229-234, 414-420).
//    Once the bell leaves the sidebar that lookup is empty and the count
//    freezes at its boot value. `bindNotifications` re-homes both on the
//    instance — the one place this theme re-states frappe logic.
// 3. Every sidebar row carries `data-toggle="tooltip" data-placement="right"`
//    (sidebar_item.html:6-7) and `expand_sidebar()` initialises Bootstrap
//    tooltips globally when the rail collapses (sidebar.js:600-604). Stripped
//    on harvest; the cell's `title` is its tooltip.
import type { FrappeNotificationsView } from "frappe-types";
import { safePatch } from "../patch";
import { isHTMLElement } from "./dom";

const BADGE = "cds--badge-indicator cds--badge-indicator--count";

/**
 * Present one harvested control as a Carbon header action.
 *
 * Idempotent: class adds and attribute removals. The class goes on the
 * INTERACTIVE element (frappe's `<a>`/`<button>`), so Carbon's own
 * hover / active / focus ramp applies to the thing that receives the events.
 */
function markAction(el: Element | null, label: string | null): void {
	if (!isHTMLElement(el)) return;
	el.classList.add("cds--header__action");
	if (el instanceof HTMLAnchorElement && !el.hasAttribute("href")) {
		// an href-less <a> is neither focusable nor keyboard-activatable
		if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
		if (!el.hasAttribute("role")) el.setAttribute("role", "button");
		if (!el.dataset.cfKeys) {
			el.dataset.cfKeys = "1";
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					el.click();
				}
			});
		}
	}
	if (label && !el.hasAttribute("aria-label")) el.setAttribute("aria-label", label);
	if (label && !el.hasAttribute("title")) el.setAttribute("title", label);
}

/** Strip the sidebar's tooltip wiring and class the badge, for every row in the slot. */
function dressSidebarRows(slot: Element): void {
	for (const row of slot.querySelectorAll<HTMLElement>("[data-toggle='tooltip']")) {
		row.removeAttribute("data-toggle");
		row.removeAttribute("data-placement");
	}
	const search = slot.querySelector("#navbar-modal-search");
	markAction(
		search && search.querySelector(".standard-sidebar-item > .item-anchor"),
		search && search.getAttribute("title"),
	);
	const bell = slot.querySelector(".sidebar-notification");
	markAction(
		bell && bell.querySelector(".standard-sidebar-item > .item-anchor"),
		bell && bell.getAttribute("title"),
	);
	const count = slot.querySelector(".sidebar-notification-count");
	if (count) for (const cls of BADGE.split(" ")) count.classList.add(cls);
	markAction(slot.querySelector(".dropdown-navbar-user .sidebar-user-button"), null);
}

function dressLandingNodes(slot: Element): void {
	markAction(slot.querySelector("#desktop-navbar-modal-search"), null);
	markAction(slot.querySelector(".desktop-notification-icon"), null);
	markAction(slot.querySelector(".desktop-avatar"), null);
}

/**
 * Move the system-level utilities into the header's right rail.
 *
 * Two sources, because the desk has two shapes: workspace pages keep search and
 * notifications as the first entries of the side nav, while the landing page
 * has its own .desktop-navbar carrying the same three affordances. Taking
 * whichever exists is also what removes the duplicate header the landing page
 * would otherwise show.
 *
 * Runs again on every route change, so it must be idempotent. The decision has
 * to be driven by what the slot ALREADY HOLDS, not by where the sidebar's node
 * currently lives: after the first harvest that node sits in the slot, so the
 * `.body-sidebar .standard-items-sections` lookup goes permanently null. Keying
 * off that lookup alone hands every later call to the .desktop-navbar branch,
 * and the landing page re-renders a fresh navbar on each visit — which is how a
 * second search / bell / avatar used to stack up beside the first.
 *
 * On a fresh `/desk` load the sidebar's section can exist EMPTY: search and
 * bell are only built by `prepare()`, which the launcher route may never run.
 * An empty section is not a source — the landing navbar is.
 */
export function harvestUtilities(slot: Element, onBellOpen?: () => void): void {
	// Move `node` in, evicting whatever it replaces. Re-appending a node the
	// slot already owns just moves it to the end, which is how ordering stays
	// stable across re-harvests.
	const adopt = (node: Element | null, sel: string): void => {
		const stale = slot.querySelector(sel);
		if (node && stale && stale !== node) stale.remove();
		const live = node || stale;
		if (live) slot.appendChild(live);
	};

	// EXACTLY ONE source, or the header shows two search icons and two bells.
	// The side nav's copy is preferred because it exists on every route.
	const inSidebar = document.querySelector(".body-sidebar .standard-items-sections");
	const sidebarUtilities = inSidebar && inSidebar.querySelector(".standard-sidebar-item") ? inSidebar : null;
	const held = slot.querySelector(".standard-items-sections");
	const alreadyHeld = held && held.querySelector(".standard-sidebar-item") ? held : null;

	if (sidebarUtilities || alreadyHeld) {
		// the sidebar's copy wins; any landing-page nodes a previous visit left
		// behind would be a second search / bell beside it
		for (const sel of [".desktop-search-wrapper", ".desktop-notifications", ".desktop-avatar"]) {
			const dup = slot.querySelector(sel);
			if (dup) dup.remove();
		}
		adopt(sidebarUtilities, ".standard-items-sections");
		dressSidebarRows(slot);
	} else {
		const desktopNav = document.querySelector(".desktop-navbar");
		for (const sel of [".desktop-search-wrapper", ".desktop-notifications", ".desktop-avatar"]) {
			const el = desktopNav && desktopNav.querySelector(sel);
			if (el) slot.appendChild(el);
		}
		dressLandingNodes(slot);
	}

	// Once we own the header, the landing page's navbar is redundant chrome —
	// whether we just emptied it or the side nav had already supplied the
	// utilities. Dropping it unconditionally is also what stops it stacking a
	// second header under ours.
	dropDesktopNavbar();

	// account menu — adopted last so it sits furthest right of frappe's three,
	// per Carbon's ordering (search leftmost, account second from the right;
	// the switcher, which the orchestrator re-appends, is last)
	adopt(document.querySelector(".body-sidebar .dropdown-navbar-user"), ".dropdown-navbar-user");
	markAction(slot.querySelector(".dropdown-navbar-user .sidebar-user-button"), null);

	bindNotifications(slot, onBellOpen);
}

/**
 * Re-arm the notification bell after the move.
 *
 * frappe wires the bell to `this.wrapper.find(".dropdown-notifications")`
 * (ui/sidebar/sidebar.js:527-530), and that wrapper is the SIDEBAR container.
 * Harvesting the utilities moves the panel into <header>, so the lookup
 * returns an empty set from then on and the click toggles nothing — adopting
 * the bell is what kills it. Redo the toggle against where the panel actually
 * lives now.
 *
 * frappe's own handler still runs and still no-ops on its empty set, so this
 * adds the missing toggle rather than racing a working one.
 */
function bindNotifications(slot: Element, onOpen: (() => void) | undefined): void {
	// `querySelector<HTMLElement>` for the bell only: `dataset` is on
	// HTMLElement, and the bell is frappe's own row (sidebar.js builds it as a
	// standard item of `type: "Button"`). The panel is only ever read for
	// its classList, which every Element has.
	const bell = slot.querySelector<HTMLElement>(".sidebar-notification");
	const panel = slot.querySelector(".dropdown-notifications");
	// harvest re-runs on every route change; the listener must not stack up
	if (!bell || !panel || bell.dataset.cfBell) return;
	bell.dataset.cfBell = "1";

	bell.addEventListener("click", () => {
		panel.classList.toggle("hidden");
		const opened = !panel.classList.contains("hidden");
		// what frappe fires on open, so the panel refreshes its counts
		if (opened && window.jQuery) jQuery(panel).trigger("show.bs.dropdown");
		if (opened && onOpen) onOpen();
	});

	rehomeBadge(slot);
}

/**
 * Point the unread badge and bell indicator at the header's copy of the bell.
 *
 * `NotificationsView` is module-private (notifications.js:222); only its
 * instance is reachable, so this is an instance patch: the original runs (it
 * still stores `unread_count`), then the same eight lines
 * (notifications.js:421-428) run against the header's badge whenever frappe's
 * own `.body-sidebar`-relative lookup came up empty.
 */
function rehomeBadge(slot: Element): void {
	const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
	const view = sidebar && sidebar.notifications && sidebar.notifications.tabs.notifications;
	if (!view) return;

	const icon = slot.querySelector<HTMLElement>(".sidebar-notification .sidebar-item-icon");
	if (icon) view.bell_indicator = $(icon);

	safePatch(
		() => view,
		"update_count_badge",
		(orig) =>
			function (this: FrappeNotificationsView, count: number): void {
				orig.call(this, count);
				if (this.parent.closest(".body-sidebar").length) return;
				const $suffix = $(slot).find(".sidebar-notification .sidebar-notification-count");
				if (!$suffix.length) return;
				if (count > 0) {
					$suffix
						.text(count > 99 ? "99+" : String(count))
						.attr("aria-label", __("{0} unread notifications", [count]))
						.removeClass("hidden");
				} else {
					$suffix.removeAttr("aria-label").addClass("hidden");
				}
			},
		"Carbon UI Shell header (notification badge re-home)",
	);
	view.update_count_badge(view.unread_count);
}

export function dropDesktopNavbar(): void {
	const nav = document.querySelector(".desktop-navbar");
	if (nav) nav.remove();
}
