// Carbon UI Shell header.
//
// frappe/www/desk.html:40 ships an empty <header></header> that frappe only
// fills under four narrow conditions (read_only, impersonated, announcement
// widget, mobile — see ui/toolbar/toolbar.js:9-21). On a normal desktop desk
// load it stays empty, which makes it a mount point rather than a takeover.
//
// The markup is @carbon/react's UI Shell, class for class, so @carbon/styles'
// header / header-panel / switcher mixins (desk/_ui-shell.scss) style it
// unchanged. Anatomy, against patterns/global-header:
//
//   1 Main menu    — hamburger; delegates to frappe's own sidebar toggle
//   2 Header name  — <app title> (400) + <module label> (600), e.g.
//                    "ERPNext Projects"; links to the module's landing route
//   3 Header links — the module sidebar's top-level rows (shell/nav.ts)
//   4 Sub-menu     — its Section Breaks, plus a measured "More" overflow
//   5 Utilities    — search, notifications and the account menu, each calling
//                    the frappe API the sidebar's own control calls
//                    (shell/utilities.ts)
//   6 Switcher     — the apps, as /desk lays them out, in a right header panel
//                    (shell/switcher.ts)
//   7 Assistant    — when flow is installed, the AI chat's action just before
//                    the switcher; its panel is a body-level aside
//                    (shell/assistant.ts)
//
// Everything the header shows is read from `frappe.app.sidebar` (shell/model.ts):
// frappe's module sidebar is what resolves a route to a shell, names the app that
// owns it, and renders its items — the header is a projection of it. What it does
// NOT replace sits beside it: the dock (the module switcher inside an app) and the
// left panel, with the `.sidebar-header` menu that is the only home of Edit
// Sidebar, Help and, on an app without a dock, the Modules submenu.
//
// When it renders:
//
//   - `Sidebar.prototype.make_sidebar` is wrapped (patch.ts' safePatch). It is the
//     render step of `setup()` (ui/sidebar/sidebar.js:235), which a shell switch
//     and a saved Edit Sidebar dialog both call (sidebar_manager.js:843), i.e. the
//     one place the sidebar DOM is rebuilt — by then `current_module`,
//     `sidebar_data` and the rendered rows are all set. (`sidebar_setup` fires
//     BEFORE any of that, sidebar.js:229, so it is deliberately not used.)
//   - `highlight_active_item` is wrapped: it is where frappe writes
//     `.active-sidebar`, the row the header marks `aria-current`
//     (sidebar.js:513-518), and it runs on every route even when `setup()` is
//     skipped because the shell did not change.
//   - `apply_page_visibility` is wrapped: it is where the panel and the dock turn
//     on and off for the page now on screen (sidebar.js:359-370), which is what
//     makes /desk the launcher ("Desktop", no links) and a workspace a module.
//   - Every router "change" re-marks the current link and re-syncs the
//     hamburger; a full re-render only when the model's signature changed.
//   - `sidebar-expand` (sidebar.js:759-761) syncs the hamburger's aria state.
//
// Mount gate: `body > .main-section > header` — never bare `header`, the
// landing page's `.desktop-navbar` is one too — empty, and only once
// `frappe.app.sidebar` exists. `frappe.app` is `{}` until the Application
// constructor returns (desk.js:7-12) and `startup()` runs `make_nav_bar()`
// (the Toolbar whose constructor decides whether to replace <header>) before
// `make_sidebar()` (desk.js:39-40), so the sidebar's presence proves the
// replacement decision was already made. Either order of mount and first
// `make_sidebar()` converges: the hook re-projects if the header exists, the
// mount reads whatever sidebar state exists.
import type { FrappeSidebar } from "frappe-types";
import { record, safePatch } from "./patch.ts";
import { menu20 } from "../generated/shell-icons.ts";
import { esc, required } from "./shell/dom.ts";
import { readModel } from "./shell/model.ts";
import type { ShellModel } from "./shell/model.ts";
import { mountAssistant } from "./shell/assistant.ts";
import type { ShellAssistant } from "./shell/assistant.ts";
import { shouldMountAssistant } from "./shell/assistant_gate.ts";
import { mountNav } from "./shell/nav.ts";
import type { ShellNav } from "./shell/nav.ts";
import { mountSwitcher } from "./shell/switcher.ts";
import type { ShellSwitcher } from "./shell/switcher.ts";
import { mountUtilities } from "./shell/utilities.ts";
import type { ShellUtilities } from "./shell/utilities.ts";

const MOUNTED = "cf-shell-mounted";
// Set on <body> only when the header actually mounts, because the CSS that
// compensates for a FIXED header (reserving its row, re-cutting the three
// full-height columns, hiding the controls the header replaces) must not fire in
// the four cases where frappe fills <header> itself — read_only, impersonation,
// announcement, mobile.
const SHELL_ON = "cf-has-shell";
// The g100 zone: desk/_ui-shell.scss re-emits Carbon's g100 theme (and the
// frappe variables the header's own nodes read) under this class, so the header
// runs dark in both desk themes.
const ZONE = "cf-zone-g100";

interface Shell {
	header: HTMLElement;
	menu: HTMLButtonElement;
	name: HTMLAnchorElement;
	nav: ShellNav;
	global: HTMLElement;
	utilities: ShellUtilities;
	switcher: ShellSwitcher;
	assistant: ShellAssistant | null;
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
 * rail (or, beside a pinned dock, slides shut) rather than going away, so a
 * permanent ✕ would mislead.
 */
function syncMenuButton(s: Shell, expanded: boolean, disabled: boolean): void {
	s.menu.setAttribute("aria-expanded", expanded ? "true" : "false");
	s.menu.disabled = disabled;
}

/** The utilities and the assistant are placed at mount; the switcher is Carbon's "furthest right icon", so it is re-appended last and the assistant's action sits just before it. */
function placeActions(s: Shell): void {
	s.global.appendChild(s.switcher.button);
	if (s.assistant) s.global.insertBefore(s.assistant.button, s.switcher.button);
}

/**
 * The assistant is optional (flow may be absent) and must never take the header
 * down with it: a throw leaves the bar as it was, minus the action. It rides on the
 * header, so below the mobile breakpoint (where `mount()` leaves frappe's header alone)
 * there is no trigger and no panel.
 */
function mountOptionalAssistant(global: HTMLElement): ShellAssistant | null {
	if (!shouldMountAssistant(window.frappe && frappe.boot)) return null;
	try {
		const assistant = mountAssistant(global);
		record("Carbon AI assistant (mount)", true);
		return assistant;
	} catch (e) {
		record("Carbon AI assistant (mount)", false);
		console.error(e);
		return null;
	}
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
	s.utilities.sync();
	placeActions(s);
	s.nav.layout();
}

/**
 * Bring the header up to date with a sidebar that did not rebuild: a full
 * re-render only when what the name and the nav render from changed, otherwise the
 * current link and the hamburger. `menus` also closes the open sub-menus and the
 * switcher — a navigation does, a page-visibility change in place does not.
 */
function refresh(menus: boolean): void {
	const s = shell;
	if (!s) return;
	const model = readModel();
	if (model.signature !== s.lastSignature) {
		project();
		return;
	}
	s.nav.markCurrent();
	if (menus) {
		s.nav.closeAll();
		s.switcher.close();
	}
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
	// The skip link's target: desk.html:41's #body is the content column. The
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
	// The right-side surfaces are mutually exclusive: opening any one closes the
	// others (and the nav's sub-menus). The bell yields the switcher and the assistant
	// here; the reverse — frappe's panel registry closing the notifications on any
	// click outside them — needs nothing.
	const utilities = mountUtilities(() => {
		nav.closeAll();
		switcher.close();
		if (assistant) assistant.close();
	});
	for (const cell of utilities.cells) global.appendChild(cell);
	const switcher = mountSwitcher(header, global);
	const assistant = mountOptionalAssistant(global);
	const yieldToOpened = (): void => {
		nav.closeAll();
		utilities.closeNotifications();
	};
	switcher.onOpen(() => {
		yieldToOpened();
		if (assistant) assistant.close();
	});
	if (assistant) {
		assistant.onOpen(() => {
			yieldToOpened();
			switcher.close();
		});
	}

	// Delegates to frappe's own toggle: it opens or collapses the panel, persists the
	// choice (`desk-sidebar-collapsed`) and fires `sidebar-expand` (sidebar.js:709-715,
	// 740-762). The page head's own toggle (page.html:4) is hidden while this header
	// is mounted (desk/_page-head.scss), so there is one hamburger.
	menu.addEventListener("click", () => {
		const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
		if (sidebar && typeof sidebar.toggle_width === "function") sidebar.toggle_width();
	});

	shell = { header, menu, name, nav, global, utilities, switcher, assistant, lastSignature: "" };
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

// 2. the current link follows the row frappe lights. `highlight_active_item` writes
//    `.active-sidebar` on every route, including the ones where `setup()` is skipped
//    because the shell did not change, and `open()` re-lights after the panel opens
//    (sidebar.js:513-518, 789-794). Called from inside `make_sidebar` too, before
//    the re-projection above, where there is nothing yet to mark.
safePatch(
	() => window.frappe && frappe.ui && frappe.ui.Sidebar && frappe.ui.Sidebar.prototype,
	"highlight_active_item",
	(orig) =>
		function (this: FrappeSidebar): void {
			orig.call(this);
			if (shell) shell.nav.markCurrent();
		},
	"Carbon UI Shell header (Sidebar.highlight_active_item → markCurrent)",
);

// 3. the launcher and the modules are told apart by which shells the page on screen
//    allows, which `apply_page_visibility` decides when the container changes page
//    (container.js:98) — after the router's own "change", on a first load.
safePatch(
	() => window.frappe && frappe.ui && frappe.ui.Sidebar && frappe.ui.Sidebar.prototype,
	"apply_page_visibility",
	(orig) =>
		function (this: FrappeSidebar): void {
			orig.call(this);
			refresh(false);
		},
	"Carbon UI Shell header (Sidebar.apply_page_visibility → refresh)",
);

// 4. route changes — deferred, because the sidebar's own "change" handler
//    (sidebar.js:255-260) is registered after ours (it binds in its constructor,
//    ours at bundle load) and must run set_workspace_sidebar() first
if (window.frappe && frappe.router && typeof frappe.router.on === "function") {
	frappe.router.on("change", () => {
		setTimeout(() => refresh(true), 0);
	});
	record("Carbon UI Shell header (router change)", true);
} else {
	record("Carbon UI Shell header (router change)", false);
}

// 5. hamburger state follows the sidebar. The event's `sidebar_expand` is "the panel
//    is not a rail" (sidebar.js:759-761): beside a pinned dock a collapsed sidebar
//    slides shut instead of folding to a rail, and that reads as `true` there, so
//    the state is `sidebar_expanded`, which `close()` / `open()` set first
//    (sidebar.js:782-794).
$(document).on("sidebar-expand", () => {
	const s = shell;
	if (!s) return;
	const sidebar = window.frappe && frappe.app && frappe.app.sidebar;
	syncMenuButton(s, !!(sidebar && sidebar.sidebar_expanded), s.menu.disabled);
});
record("Carbon UI Shell header (sidebar-expand sync)", true);

// 6. The desk boots asynchronously, so retry until the header can mount. Ten
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
