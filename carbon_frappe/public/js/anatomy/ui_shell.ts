// Carbon UI Shell header.
//
// frappe/www/desk.html ships an empty <header></header> that frappe only fills
// under four narrow conditions (read_only, impersonated, announcement widget,
// mobile — see ui/toolbar/toolbar.js). On a normal desktop desk load it stays
// empty, which makes it a mount point rather than a takeover.
//
// Anatomy, against patterns/global-header:
//   1 Main menu    — hamburger, delegates to frappe's own sidebar toggle
//   2 Header name  — company prefix (400) + product name (600), links home
//   3 Header links — NOT USED. These are for a handful of product-level links
//                    that "drop down to the side menu in narrow screen widths".
//                    An ERPNext workspace carries ~58 nav items, and Carbon's
//                    left-panel rule is explicit: "Use the left panel if there
//                    are more than five secondary navigation items." So product
//                    navigation stays in the left panel.
//   4 Sub-menu     — NOT USED, same reason.
//   5 Utilities    — "global system-level utilities ... such as profile,
//                    search, notifications". Harvested from frappe rather than
//                    rebuilt, so every handler stays bound.
//   6 Switcher     — frappe has no cross-product switcher in the desk; the
//                    nearest thing is the /app launcher. Left out rather than
//                    faked.
//
// Everything is MOVED, never cloned: frappe binds handlers to those exact
// nodes, so relocating keeps them live and avoids a second copy of each
// affordance.
import { record } from "./patch";
import type { FrappeBootPartial } from "frappe-types";

const MOUNTED = "cf-shell-mounted";
// Set on <body> only when the header actually mounts, because the CSS that
// compensates for a FIXED header (reserving its row, re-cutting the two
// full-height columns) must not fire in the four cases where frappe fills
// <header> itself — read_only, impersonation, announcement, mobile.
const SHELL_ON = "cf-has-shell";

/** The two halves of the header name: company prefix, then product. */
interface ProductName {
	company: string;
	app: string;
}

function productName(): ProductName {
	// Annotated `FrappeBootPartial`, not inferred: `(window.frappe && frappe.boot) || {}`
	// infers `FrappeBoot | {}` and every read below then fails. `{}` is
	// assignable to a Partial, and each read comes back `T | undefined` —
	// exactly what the `&&` chains here already assume.
	const boot: FrappeBootPartial = (window.frappe && frappe.boot) || {};
	const company = (boot.sysdefaults && boot.sysdefaults.company) || "";
	const app = (boot.app_data && boot.app_data[0] && boot.app_data[0].app_title) || "Frappe";
	return { company, app };
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
 */
function harvestUtilities(slot: Element): void {
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
	const sidebarUtilities = document.querySelector(".body-sidebar .standard-items-sections");
	const alreadyHeld = slot.querySelector(".standard-items-sections, .desktop-search-wrapper");

	if (sidebarUtilities || alreadyHeld) {
		adopt(sidebarUtilities, ".standard-items-sections");
	} else {
		const desktopNav = document.querySelector(".desktop-navbar");
		for (const sel of [".desktop-search-wrapper", ".desktop-notifications", ".desktop-avatar"]) {
			const el = desktopNav && desktopNav.querySelector(sel);
			if (el) slot.appendChild(el);
		}
	}

	// Once we own the header, the landing page's navbar is redundant chrome —
	// whether we just emptied it or the side nav had already supplied the
	// utilities. Dropping it unconditionally is also what stops it stacking a
	// second header under ours.
	dropDesktopNavbar();

	// account menu — adopted last so it sits furthest right, per Carbon's
	// ordering (search leftmost, account second from the right)
	adopt(document.querySelector(".body-sidebar .dropdown-navbar-user"), ".dropdown-navbar-user");

	bindNotifications(slot);
}

/**
 * Re-arm the notification bell after the move.
 *
 * frappe wires the bell to `this.wrapper.find(".dropdown-notifications")`
 * (ui/sidebar/sidebar.js), and that wrapper is the SIDEBAR container. Harvesting
 * the utilities moves the panel into <header>, so the lookup returns an empty
 * set from then on and the click toggles nothing — adopting the bell is what
 * kills it. Redo the toggle against where the panel actually lives now.
 *
 * frappe's own handler still runs and still no-ops on its empty set, so this
 * adds the missing toggle rather than racing a working one.
 */
function bindNotifications(slot: Element): void {
	// `querySelector<HTMLElement>` for the bell only: `dataset` is on
	// HTMLElement, and the bell is frappe's own <button> (sidebar.js builds it
	// as a standard item of `type: "Button"`). The panel is only ever read for
	// its classList, which every Element has.
	const bell = slot.querySelector<HTMLElement>(".sidebar-notification");
	const panel = slot.querySelector(".dropdown-notifications");
	// harvest re-runs on every route change; the listener must not stack up
	if (!bell || !panel || bell.dataset.cfBell) return;
	bell.dataset.cfBell = "1";

	bell.addEventListener("click", () => {
		panel.classList.toggle("hidden");
		// what frappe fires on open, so the panel refreshes its counts
		if (!panel.classList.contains("hidden") && window.jQuery) {
			jQuery(panel).trigger("show.bs.dropdown");
		}
	});
}

function dropDesktopNavbar(): void {
	const nav = document.querySelector(".desktop-navbar");
	if (nav) nav.remove();
}

/**
 * `nodeType === 1` stays the decision the JS made; the rest is only what lets
 * the compiler believe it, since `Node` carries no `matches`. Duck-typed rather
 * than `instanceof Element` for the same reason
 * tables/datatable/navigation.ts is: a node adopted from another realm fails
 * `instanceof` while still being a perfectly good element.
 */
function isElementNode(node: Node): node is Element {
	return node.nodeType === 1 && "matches" in node && typeof node.matches === "function";
}

/**
 * A node the header template below just wrote.
 *
 * The JS dereferenced these lookups unchecked, so a template/selector drift
 * surfaced as a bare `TypeError: … is null` one line later. This throws in the
 * same place for the same reason and names the selector that went missing —
 * `mount()` runs inside the retry interval either way.
 */
function required(root: ParentNode, sel: string): HTMLElement {
	const node = root.querySelector<HTMLElement>(sel);
	if (!node) throw new Error(`carbon_frappe: UI Shell header is missing ${sel}`);
	return node;
}

function mount(): boolean {
	const header = document.querySelector("header");
	// bail if absent, already ours, or frappe filled it (read-only / mobile /
	// impersonation / announcement) — those cases must keep frappe's markup
	if (!header || header.classList.contains(MOUNTED) || header.children.length) return false;

	const { company, app } = productName();
	const esc = (s: string): string => frappe.utils.escape_html(s);

	header.classList.add(MOUNTED, "cf-shell-header");
	document.body.classList.add(SHELL_ON);
	header.innerHTML = `
		<button class="cf-shell-menu" aria-label="Open navigation" type="button">
			<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
				<rect x="2" y="5"    width="16" height="1.4"></rect>
				<rect x="2" y="9.3"  width="16" height="1.4"></rect>
				<rect x="2" y="13.6" width="16" height="1.4"></rect>
			</svg>
		</button>
		<a class="cf-shell-name" href="/app">
			${company ? `<span class="cf-shell-prefix">${esc(company)}</span> ` : ""}
			<span class="cf-shell-product">${esc(app)}</span>
		</a>
		<div class="cf-shell-spacer"></div>
		<div class="cf-shell-actions"></div>
	`;

	required(header, ".cf-shell-menu").addEventListener("click", () => {
		// `querySelector<HTMLElement>`: `.click()` is HTMLElement's, and the
		// toggle is a <button> in both of frappe's templates (ui/page.html:5,
		// ui/sidebar/sidebar.html:71).
		const btn = document.querySelector<HTMLElement>(".sidebar-toggle-btn");
		if (btn) btn.click();
	});

	harvestUtilities(required(header, ".cf-shell-actions"));
	return true;
}

// The desk boots asynchronously, so retry until the header exists.
let tries = 0;
const timer = setInterval(() => {
	if (mount() || ++tries > 40) {
		clearInterval(timer);
		record("Carbon UI Shell header (<header> mount)", tries <= 40);
	}
}, 100);

const actionSlot = (): Element | null =>
	document.querySelector(".cf-shell-header .cf-shell-actions");

// Route changes re-render the side nav, which can re-create the utilities we
// moved. Re-harvest so they do not reappear in the sidebar.
if (window.frappe && frappe.router && typeof frappe.router.on === "function") {
	frappe.router.on("change", () => {
		const slot = actionSlot();
		if (slot) setTimeout(() => harvestUtilities(slot), 200);
	});
}

// The landing page rebuilds .desktop-navbar on every visit, and it does so from
// a server round-trip's callback (desk/page/desktop/desktop.js make()), so the
// fixed delay above races it — too early and the navbar lands afterwards, alone
// and unstyled, under our header. Watch for it instead of guessing.
//
// Scoped to the template's own root so this stays O(added nodes) and never
// walks a freshly rendered datatable subtree.
if (typeof MutationObserver === "function") {
	const observer = new MutationObserver((records) => {
		for (const rec of records) {
			for (const node of rec.addedNodes) {
				if (!isElementNode(node) || !node.matches(".desktop-wrapper, .desktop-navbar")) continue;
				const slot = actionSlot();
				if (slot) harvestUtilities(slot);
				else dropDesktopNavbar();
				return;
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	record("Carbon UI Shell header (.desktop-navbar observer)", true);
}
