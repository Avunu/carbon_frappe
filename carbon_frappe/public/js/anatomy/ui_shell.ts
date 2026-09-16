// Carbon UI Shell header.
//
// frappe/www/desk.html:39 ships an empty <header></header> that frappe only
// fills under four narrow conditions (read_only, impersonated, announcement
// widget, mobile — see ui/toolbar/toolbar.js:9-21). On a normal desktop desk
// load it stays empty, which makes it a mount point rather than a takeover.
//
// The markup is @carbon/react's UI Shell, class for class, so @carbon/styles'
// header / header-panel / switcher mixins (desk/_ui-shell.scss) style it
// unchanged. Anatomy, against patterns/global-header:
//
//   1 Main menu    — hamburger; delegates to frappe's own sidebar toggle
//   2 Header name  — <app title> (400) + <workspace sidebar title> (600),
//                    e.g. "ERPNext Projects"; links to the sidebar's home
//   3 Header links — the Workspace Sidebar's top-level rows (shell/nav.ts)
//   4 Sub-menu     — its Section Breaks, plus a measured "More" overflow
//   5 Utilities    — frappe's search / notifications / account, MOVED in
//                    (shell/utilities.ts)
//   6 Switcher     — the desktop's icons (apps + workspaces, nested as on
//                    /desk), in a right header panel (shell/switcher.ts)
//
// Everything the header shows is read from `frappe.app.sidebar` (shell/model.ts):
// frappe's Workspace Sidebar is what resolves a route to a workspace, names the
// app that owns it, and renders its items — the header is a projection of it.
//
// When it renders:
//
//   - `Sidebar.prototype.make_sidebar` is wrapped (shell/patch.ts' safePatch).
//     It is the last step of `setup()` (ui/sidebar/sidebar.js:291) and the
//     editor's own re-render call (sidebar_editor.js:75, :82, :537-579), i.e. the
//     one place the sidebar DOM is rebuilt — by then `sidebar_title`,
//     `header_subtitle`, `sidebar_data` and `frappe.current_app` are all set.
//     (`sidebar_setup` fires BEFORE any of that, sidebar.js:283, so it is
//     deliberately not used.)
//   - Every router "change" re-marks the current link and re-syncs the
//     hamburger; a full re-render only when the model's signature changed
//     (`set_workspace_sidebar` skips `setup()` when the sidebar is unchanged,
//     sidebar.js:681-683, so most route changes are exactly this).
//   - `sidebar-expand` (sidebar.js:623-625) syncs the hamburger's aria state.
//
// Mount gate: `body > .main-section > header` — never bare `header`, the
// landing page's `.desktop-navbar` is one too — empty, and only once
// `frappe.app.sidebar` exists. `frappe.app` is `{}` until the Application
// constructor returns (desk.js:10-12) and `startup()` runs `make_nav_bar()`
// (the Toolbar whose constructor decides whether to replace <header>) before
// `make_sidebar()` (desk.js:39-40), so the sidebar's presence proves the
// replacement decision was already made. Either order of mount and first
// `make_sidebar()` converges: the hook re-projects if the header exists, the
// mount reads whatever sidebar state exists.
import type { FrappeSidebar } from "frappe-types";
import { record, safePatch } from "./patch";
import { menu20 } from "../generated/shell-icons";
import { esc, required } from "./shell/dom";
import { readModel } from "./shell/model";
import type { ShellModel } from "./shell/model";
import { mountNav } from "./shell/nav";
import type { ShellNav } from "./shell/nav";
import { mountSwitcher } from "./shell/switcher";
import type { ShellSwitcher } from "./shell/switcher";
import { harvestUtilities } from "./shell/utilities";

const MOUNTED = "cf-shell-mounted";
// Set on <body> only when the header actually mounts, because the CSS that
// compensates for a FIXED header (reserving its row, re-cutting the two
// full-height columns) must not fire in the four cases where frappe fills
// <header> itself — read_only, impersonation, announcement, mobile.
const SHELL_ON = "cf-has-shell";
// The g100 zone: desk/_ui-shell.scss re-emits Carbon's g100 theme (and the
// frappe variables the harvested nodes read) under this class, so the header
// runs dark in both desk themes.
const ZONE = "cf-zone-g100";

interface Shell {
	header: HTMLElement;
	menu: HTMLButtonElement;
	name: HTMLAnchorElement;
	nav: ShellNav;
	global: HTMLElement;
	switcher: ShellSwitcher;
	lastSignature: string;
}

let shell: Shell | null = null;

function translate(s: string): string {
	return typeof __ === "function" ? __(s) : s;
}

function renderName(s: Shell, model: ShellModel): void {
	// HeaderName.tsx: prefix span (omitted when empty) + `&nbsp;` + name span
	s.name.href = model.home;
	s.name.innerHTML =
		(model.prefix ? `<span class="cds--header__name--prefix">${esc(model.prefix)}</span>&nbsp;` : "") +
		`<span>${esc(model.name)}</span>`;
	s.header.setAttribute("aria-label", `${model.prefix} ${model.name}`.trim());
}

/**
 * The hamburger reflects the sidebar's state through `aria-expanded` only.
 * Carbon's `--active` + Close glyph mean "an overlay is open and this
 * dismisses it"; frappe's sidebar is expanded by default and collapses to a
 * rail rather than going away, so a permanent ✕ would mislead.
 */
function syncMenuButton(s: Shell, expanded: boolean, disabled: boolean): void {
	s.menu.setAttribute("aria-expanded", expanded ? "true" : "false");
	s.menu.disabled = disabled;
}

function project(): void {
	const s = shell;
	if (!s) return;
	const model = readModel();
	s.lastSignature = model.signature;
	renderName(s, model);
	s.nav.render(model);
	s.switcher.render(model);
	syncMenuButton(s, model.expanded, model.menuDisabled);
	harvestUtilities(s.global, () => s.switcher.close());
	// the harvest appends; the switcher is Carbon's "furthest right icon"
	s.global.appendChild(s.switcher.button);
	s.nav.layout();
}

function refreshRoute(): void {
	const s = shell;
	if (!s) return;
	const model = readModel();
	if (model.signature !== s.lastSignature) {
		project();
		return;
	}
	s.nav.markCurrent();
	s.nav.closeAll();
	s.switcher.close();
	syncMenuButton(s, model.expanded, model.menuDisabled);
}

function mount(): boolean {
	const header = document.querySelector<HTMLElement>("body > .main-section > header");
	// bail if absent, already ours, or frappe filled it (read-only / mobile /
	// impersonation / announcement) — those cases must keep frappe's markup
	if (!header || header.classList.contains(MOUNTED) || header.children.length) return false;
	if (!(window.frappe && frappe.app && frappe.app.sidebar)) return false;

	const toggleLabel = translate("Toggle navigation");
	header.classList.add(MOUNTED, "cf-shell-header", "cds--header", ZONE);
	document.body.classList.add(SHELL_ON);
	header.innerHTML = `
		<a class="cds--skip-to-content" href="#body" tabindex="0">${esc(translate("Skip to main content"))}</a>
		<button class="cds--header__action cds--header__menu-trigger cds--header__menu-toggle" type="button"
			aria-label="${esc(toggleLabel)}" title="${esc(toggleLabel)}" aria-expanded="false">${menu20}</button>
		<a class="cds--header__name" href="/desk"></a>
		<div class="cds--header__global"></div>
	`;
	// The skip link's target: desk.html:40's #body is the content column. The
	// click is handled here and STOPPED: frappe's body-level router rewrites
	// every same-host <a> click into `set_route(pathname)` (router.js:26-70)
	// and does not consult `defaultPrevented`, so a plain `#body` fragment
	// would re-route the current page instead of moving focus.
	const body = document.getElementById("body");
	if (body && !body.hasAttribute("tabindex")) body.tabIndex = -1;
	required(header, ".cds--skip-to-content").addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		const target = document.getElementById("body");
		if (target) target.focus();
	});

	const menu = required(header, ".cds--header__menu-toggle");
	const name = required(header, ".cds--header__name");
	const global = required(header, ".cds--header__global");
	if (!(menu instanceof HTMLButtonElement) || !(name instanceof HTMLAnchorElement)) {
		throw new Error("carbon_frappe: UI Shell header template drifted");
	}

	const nav = mountNav(header);
	header.insertBefore(nav.el, global);
	const switcher = mountSwitcher(header, global);
	switcher.onOpen(() => {
		nav.closeAll();
		const panel = global.querySelector(".dropdown-notifications");
		if (panel) panel.classList.add("hidden");
	});

	menu.addEventListener("click", () => {
		const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
		if (sidebar && typeof sidebar.toggle_width === "function") {
			sidebar.toggle_width();
			return;
		}
		// `querySelector<HTMLElement>`: `.click()` is HTMLElement's, and the
		// toggle is a <button> in frappe's template (ui/sidebar/sidebar.html:71).
		const btn = document.querySelector<HTMLElement>(".body-sidebar .sidebar-toggle-btn");
		if (btn) btn.click();
	});

	shell = { header, menu, name, nav, global, switcher, lastSignature: "" };
	project();

	// the bar's fit depends on the viewport and on what the global bar holds;
	// both are observed, coalesced to one layout per frame
	if (typeof ResizeObserver === "function") {
		let frame = 0;
		const ro = new ResizeObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				nav.layout();
			});
		});
		ro.observe(header);
		ro.observe(global);
	}
	// IBM Plex may land after the first render; the cached widths are then wrong
	if (document.fonts && document.fonts.ready) {
		document.fonts.ready.then(() => nav.layout(true)).catch(() => undefined);
	}
	return true;
}

// -- hooks, bound at bundle load -------------------------------------------

// 1. re-project after every sidebar render
safePatch(
	() => window.frappe && frappe.ui && frappe.ui.Sidebar && frappe.ui.Sidebar.prototype,
	"make_sidebar",
	(orig) =>
		function (this: FrappeSidebar): void {
			orig.call(this);
			project();
		},
	"Carbon UI Shell header (Sidebar.make_sidebar → project)",
);

// 2. route changes — deferred, because the sidebar's own "change" handler
//    (sidebar.js:327-334) is registered after ours (it binds in its constructor,
//    ours at bundle load) and must run set_workspace_sidebar() first; and
//    re-harvest late, because a route can rebuild the utilities' hosts
if (window.frappe && frappe.router && typeof frappe.router.on === "function") {
	frappe.router.on("change", () => {
		setTimeout(refreshRoute, 0);
		setTimeout(() => {
			const s = shell;
			if (!s) return;
			harvestUtilities(s.global, () => s.switcher.close());
			s.global.appendChild(s.switcher.button);
			s.nav.layout();
		}, 200);
	});
	record("Carbon UI Shell header (router change)", true);
} else {
	record("Carbon UI Shell header (router change)", false);
}

// 3. hamburger state follows the sidebar (sidebar.js:623-625)
$(document).on(
	"sidebar-expand",
	(_e: JQuery.TriggeredEvent, data: { sidebar_expand?: boolean } | undefined) => {
		const s = shell;
		if (!s) return;
		syncMenuButton(s, !!(data && data.sidebar_expand), s.menu.disabled);
	},
);
record("Carbon UI Shell header (sidebar-expand sync)", true);

// 4. The desk boots asynchronously, so retry until the header can mount. Ten
//    seconds is generous. Once the app is up, a <header> that frappe replaced
//    (`$("header").replaceWith`, toolbar.js:9-21 — the element is GONE, not
//    filled) or filled itself is "not applicable", not a failure; only a
//    template drift or a timeout is.
const MOUNT_ID = "Carbon UI Shell header (<header> mount)";
let tries = 0;
const timer = setInterval(() => {
	let mounted = false;
	try {
		mounted = mount();
	} catch (e) {
		clearInterval(timer);
		record(MOUNT_ID, false);
		console.error(e);
		return;
	}
	if (mounted) {
		clearInterval(timer);
		record(MOUNT_ID, true);
		return;
	}
	const appUp = !!(window.frappe && frappe.app && frappe.app.sidebar);
	const header = document.querySelector<HTMLElement>("body > .main-section > header");
	const notApplicable =
		appUp && (!header || (header.children.length > 0 && !header.classList.contains(MOUNTED)));
	if (notApplicable || ++tries > 100) {
		clearInterval(timer);
		record(MOUNT_ID, notApplicable);
	}
}, 100);

// 5. The landing page rebuilds .desktop-navbar on every visit, and it does so
//    from a server round-trip's callback (desk/page/desktop/desktop.js make()),
//    so the fixed delay above races it — too early and the navbar lands
//    afterwards, alone and unstyled, under our header. Watch for it instead of
//    guessing.
//
//    Scoped to the template's own root so this stays O(added nodes) and never
//    walks a freshly rendered datatable subtree.
if (typeof MutationObserver === "function") {
	const observer = new MutationObserver((records) => {
		for (const rec of records) {
			for (const node of rec.addedNodes) {
				if (!(node instanceof Element) || !node.matches(".desktop-wrapper, .desktop-navbar")) continue;
				// unmounted (mobile, frappe-filled header): the landing navbar
				// is frappe's to keep
				const s = shell;
				if (!s) return;
				harvestUtilities(s.global, () => s.switcher.close());
				s.global.appendChild(s.switcher.button);
				s.nav.layout();
				return;
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	record("Carbon UI Shell header (.desktop-navbar observer)", true);
}
