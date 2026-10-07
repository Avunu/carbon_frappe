// The header's global bar: search, notifications and the account menu, as
// Carbon `cds--header__action` cells.
//
// Carbon (components/UI-shell-header): "Header utilities: these utilities are
// reserved for universal, system-level functions such as profile, search,
// notifications". frappe v16.50 builds exactly those three, in three different
// places: search and notifications are the first two rows of the sidebar's
// "standard items" band (`add_standard_items`, ui/sidebar/sidebar.js:640-668), the
// account button is the user chip at the foot of the sidebar (sidebar.html:16-40)
// and again as the dock's avatar (dock.js:33-37), and the desktop page draws a
// fourth set in its own `.desktop-navbar` (desk/page/desktop/desktop.html).
//
// 16.33 MOVED those nodes into the header and kept frappe's handlers on them.
// That stopped working: the rows are built by a `Sidebar` that is re-rendered, the
// desktop page rebuilds its navbar on every visit and finds its pieces with GLOBAL
// selectors (`$(".desktop-avatar")`, `$(".desktop-notifications")`,
// desktop.js:232-239, 286), so a moved node and a fresh one both answer the same
// lookup and every control is bound twice. So the cells here are the theme's, built
// once, and each one calls the frappe API the node it replaces called:
//
//   search   `.navbar-modal-search-mobile` — the class `AwesomeBar.setup` delegates
//            its click to on `document` (awesome_bar.js:74-80, 84-89, page.js:74-91), so
//            frappe's own handler opens the search modal, closes it on a second
//            click, and survives a rename of anything but that one class
//   bell     `frappe.ui.sidebar_panels.toggle("notifications")`, what the band row's
//            `onClick` calls (sidebar.js:659). The cell keeps the row's class,
//            `.sidebar-notification`, because that is the panel's
//            `trigger_selector` (notifications.js:39): frappe mirrors the panel's
//            state into `aria-expanded` on every match and does not count a click
//            on one as "outside" (sidebar_panel.js:132-145)
//   account  `sidebar.create_user_menu(...)` — the one menu the sidebar chip and the
//            dock avatar share (sidebar.js:416-511)
//
// The unread count needs nothing: `update_count_badge()` writes into EVERY
// `.notification-count` in the document, re-queried on each call
// (notifications.js:423-439), so the cell's badge is kept by frappe.
//
// The notifications panel is frappe's `frappe.ui.SidebarPanel`, mounted inside
// `.body-sidebar-container` (sidebar_panel.js:7, 54-82), which is `display: none`
// on every page that hides the sidebar — the launcher above all — and the panel is
// built once, by the Sidebar. So the panel's element is re-hosted on <body> and
// restyled as a right header panel by desk/_ui-shell.scss; frappe still owns its
// content, its open state and every way of closing it.
import { notification20, search20 } from "../../generated/shell-icons.ts";

export interface ShellUtilities {
	/** The cells in Carbon's order (search, notifications, account) for the orchestrator to place. */
	readonly cells: readonly HTMLElement[];
	/** Re-read what frappe decides after the header mounts: the notifications exist once the first `setup()` ran. */
	sync(): void;
	/** Close the notifications panel, for the other right-side surfaces to call when they open. */
	closeNotifications(): void;
}

const NOTIFICATIONS = "notifications";
const BADGE = "notification-count cds--badge-indicator cds--badge-indicator--count";
// The panel's own class (sidebar_panel.js:67) plus the zone the header's panels run in
const ZONE = "cf-zone-g100";

function translate(s: string): string {
	return typeof __ === "function" ? __(s) : s;
}

/** The notifications panel's element, once the Sidebar has built it. */
function panelElement(): HTMLElement | null {
	const panel =
		window.frappe && frappe.ui && frappe.ui.sidebar_panels && frappe.ui.sidebar_panels.get(NOTIFICATIONS);
	const el = panel ? panel.$panel.get(0) : undefined;
	return el || null;
}

/**
 * Take the panel out of the sidebar's container.
 *
 * Idempotent, and cheap enough to run on every projection: `register()` replaces a
 * panel that is built again under the same name and appends the new element to the
 * container (sidebar_panel.js:175-181), so this has to look every time rather
 * than once.
 */
function hostPanel(): void {
	const el = panelElement();
	if (!el || el.parentElement === document.body) return;
	el.classList.add(ZONE);
	document.body.appendChild(el);
}

function makeSearch(): HTMLButtonElement | null {
	// the condition of the row it replaces (sidebar.js:650)
	if (!frappe.boot.desk_settings.search_bar) return null;
	const label = translate("Search");
	const cell = document.createElement("button");
	cell.type = "button";
	cell.className = "cds--header__action cf-header__search navbar-modal-search-mobile";
	cell.setAttribute("aria-label", label);
	cell.setAttribute("aria-haspopup", "dialog");
	cell.title = label;
	cell.innerHTML = search20;
	return cell;
}

function makeBell(onOpen: () => void): HTMLButtonElement {
	const label = translate("Notifications");
	const cell = document.createElement("button");
	cell.type = "button";
	cell.className = "cds--header__action cf-header__bell sidebar-notification";
	cell.setAttribute("aria-label", label);
	cell.setAttribute("aria-haspopup", "dialog");
	cell.setAttribute("aria-expanded", "false");
	cell.title = label;
	// hidden until the Sidebar has built the notifications (`sync()`), as frappe's own
	// row is (`sidebar-notification hidden`, shown by Notifications.make(), :17)
	cell.hidden = true;
	cell.innerHTML = `${notification20}<span class="${BADGE} hidden" aria-live="polite"></span>`;
	cell.addEventListener("click", () => {
		hostPanel();
		const panels = frappe.ui.sidebar_panels;
		const panel = panels.get(NOTIFICATIONS);
		if (!panel) return;
		// the other right-side surfaces yield to the one being opened; the reverse
		// (any of them closing this one) is the registry's outside-click rule
		if (!panel.is_open) onOpen();
		panels.toggle(NOTIFICATIONS);
	});
	return cell;
}

function makeAccount(): HTMLButtonElement | null {
	const sidebar = frappe.app && frappe.app.sidebar;
	if (!sidebar || typeof sidebar.create_user_menu !== "function") return null;
	const user = frappe.session.user;
	const name = frappe.session.user_fullname || user || "";
	const cell = document.createElement("button");
	cell.type = "button";
	cell.className = "cds--header__action cf-header__account";
	cell.setAttribute("aria-label", translate("User Menu"));
	cell.title = name;
	cell.innerHTML = `<span class="cf-header__avatar">${frappe.avatar(user, "avatar-medium", name)}</span>`;
	// The Dropdown binds to the element it is given (components/dropdown.js:50-100), and
	// the cell is built once, so exactly one menu is ever attached to it. `button` only
	// takes `user-menu-active` while the menu is open (sidebar.js:508-509).
	const $cell = $(cell);
	sidebar.create_user_menu({ parent: $cell, button: $cell, side: "bottom", align: "end" });
	return cell;
}

/**
 * Build the utilities. `onBellOpen` is called when the bell is about to open the
 * panel, so the switcher, the assistant and the nav's sub-menus can yield to it.
 */
export function mountUtilities(onBellOpen: () => void): ShellUtilities {
	const search = makeSearch();
	const bell = makeBell(onBellOpen);
	let account: HTMLButtonElement | null = null;
	try {
		account = makeAccount();
	} catch (e) {
		// the menu is frappe's; its absence must not take the rest of the bar down
		console.error(e);
	}
	const cells = [search, bell, account].filter((c): c is HTMLButtonElement => c !== null);

	function sync(): void {
		const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
		// `Sidebar.setup_notifications` builds it only when the desk setting is on and the
		// user is not Guest (sidebar.js:669-673)
		bell.hidden = !(sidebar && sidebar.notifications);
		hostPanel();
	}

	return {
		cells,
		sync,
		closeNotifications: () => {
			const panels = window.frappe && frappe.ui && frappe.ui.sidebar_panels;
			if (panels) panels.hide(NOTIFICATIONS);
		},
	};
}
