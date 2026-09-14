// Carbon Switcher — the app switcher in the header's right panel.
//
// Carbon (patterns/global-header): "The switcher provides a way for the user
// to easily navigate between products and systems", it is "the furthest right
// icon", and "the switcher icon and the switcher panel should only be used
// together". frappe's products are its installed apps — `frappe.boot.app_data`
// (boot.py:175-227), each with a title and the route of its first allowed
// workspace — so that is the list, with the current app selected and the
// Desktop launcher below a divider, which is also the first entry of frappe's
// own sidebar-header menu (ui/sidebar/sidebar_header.js:10-17).
//
// Markup is @carbon/react's (UIShell/HeaderGlobalAction.tsx, HeaderPanel.tsx,
// Switcher.tsx, SwitcherItem.tsx, SwitcherDivider.tsx):
//
//   button.cds--header__action[aria-expanded][aria-controls]     in .cds--header__global, last
//   div.cds--header-panel[.cds--header-panel--expanded]           last child of <header>
//     ul.cds--switcher[aria-label]
//       li.cds--switcher__item > a.cds--switcher__item-link[.--selected][tabindex]
//       li > hr.cds--switcher__item--divider
//
// Behaviour is HeaderPanel.tsx + Switcher.tsx: the action toggles the panel
// and takes `cds--header__action--active`; Escape closes and returns focus to
// the action; focus or a click leaving both closes; ArrowUp/ArrowDown move
// focus through the links with wrap (Switcher.tsx:74-118, the one place
// Carbon's shell does handle arrow keys); links are tabbable only while the
// panel is open (SwitcherItem.tsx:100). Opening is CSS: header-panel's mixin
// keys the 16rem width off `--expanded`.
//
// Workspaces are deliberately NOT listed here. Carbon's switcher changes "what
// product occupies the shell"; the header nav and the left sidebar already own
// the workspace level, and frappe's own sidebar-header menu still lists them.
// `extraItems` is the seam if that changes.
import type { FrappeBootAppEntry } from "frappe-types";
import { switcher20 } from "../../generated/shell-icons";
import { esc, isHTMLElement } from "./dom";

export interface SwitcherEntry {
	label: string;
	href: string;
	selected: boolean;
}

export interface ShellSwitcher {
	/** The action button, so the orchestrator can keep it last in the global bar. */
	button: HTMLButtonElement;
	/** Rebuild the list; `app` is the entry to mark selected (none on the launcher). */
	render(app: FrappeBootAppEntry | undefined, extraItems?: SwitcherEntry[]): void;
	close(): void;
	isOpen(): boolean;
	/** Called when the panel opens, so other right-side surfaces can yield. */
	onOpen(fn: () => void): void;
}

const BUTTON_ID = "cf-switcher-button";
const PANEL_ID = "cf-switcher-panel";

function translate(s: string): string {
	return typeof __ === "function" ? __(s) : s;
}

function entriesFor(app: FrappeBootAppEntry | undefined): SwitcherEntry[] {
	const apps = (window.frappe && frappe.boot && frappe.boot.app_data) || [];
	const out: SwitcherEntry[] = [];
	for (const entry of apps) {
		// `""` when the app has neither an app_home hook nor an allowed
		// workspace (boot.py:215-220): nothing to switch to
		if (!entry.app_route) continue;
		out.push({ label: entry.app_title, href: entry.app_route, selected: !!app && entry.app_name === app.app_name });
	}
	return out;
}

function itemHtml(entry: SwitcherEntry, open: boolean): string {
	const selected = entry.selected ? " cds--switcher__item-link--selected" : "";
	const current = entry.selected ? ` aria-current="page"` : "";
	return (
		`<li class="cds--switcher__item">` +
		`<a class="cds--switcher__item-link${selected}" href="${esc(entry.href)}" tabindex="${open ? 0 : -1}"${current}>${esc(entry.label)}</a>` +
		`</li>`
	);
}

const DIVIDER = `<li><hr class="cds--switcher__item--divider"></li>`;

export function mountSwitcher(header: HTMLElement, global: HTMLElement): ShellSwitcher {
	const button = document.createElement("button");
	button.type = "button";
	button.id = BUTTON_ID;
	button.className = "cds--header__action";
	button.setAttribute("aria-label", translate("App switcher"));
	button.setAttribute("title", translate("App switcher"));
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-controls", PANEL_ID);
	button.innerHTML = switcher20;
	global.appendChild(button);

	const panel = document.createElement("div");
	panel.id = PANEL_ID;
	panel.className = "cds--header-panel";
	panel.innerHTML = `<ul class="cds--switcher" aria-label="${esc(translate("App switcher"))}"></ul>`;
	header.appendChild(panel);
	const list = panel.firstElementChild;
	if (!(list instanceof HTMLUListElement)) throw new Error("carbon_frappe: UI Shell switcher has no list");
	const switcher: HTMLUListElement = list;

	let open = false;
	const openListeners: Array<() => void> = [];

	function links(): HTMLElement[] {
		return Array.from(switcher.querySelectorAll<HTMLElement>(".cds--switcher__item-link"));
	}

	function apply(): void {
		button.setAttribute("aria-expanded", open ? "true" : "false");
		button.classList.toggle("cds--header__action--active", open);
		panel.classList.toggle("cds--header-panel--expanded", open);
		for (const a of links()) a.tabIndex = open ? 0 : -1;
	}

	function close(): void {
		if (!open) return;
		open = false;
		apply();
	}

	function show(): void {
		if (open) return;
		open = true;
		apply();
		for (const fn of openListeners) fn();
	}

	function render(app: FrappeBootAppEntry | undefined, extraItems: SwitcherEntry[] = []): void {
		const entries = entriesFor(app).concat(extraItems);
		const desktop: SwitcherEntry = { label: translate("Desktop"), href: "/desk", selected: false };
		switcher.innerHTML =
			entries.map((e) => itemHtml(e, open)).join("") + (entries.length ? DIVIDER : "") + itemHtml(desktop, open);
	}

	button.addEventListener("click", () => {
		if (open) close();
		else show();
	});

	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			button.focus();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const all = links();
		if (!all.length) return;
		const target = e.target;
		const i = isHTMLElement(target) ? all.indexOf(target) : -1;
		e.preventDefault();
		const step = e.key === "ArrowDown" ? 1 : -1;
		const next = i < 0 ? (step > 0 ? 0 : all.length - 1) : (i + step + all.length) % all.length;
		const el = all[next];
		if (el) el.focus();
	});

	// focus leaving both the panel and its button closes it
	panel.addEventListener("focusout", (e) => {
		const next = e.relatedTarget;
		if (next instanceof Node && (panel.contains(next) || button.contains(next))) return;
		close();
	});

	// a click leaving both closes it (HeaderPanel.tsx's window listener); a
	// click on a link closes it too — navigation is frappe's, the panel's job
	// is done
	document.addEventListener("click", (e) => {
		const target = e.target;
		if (!(target instanceof Node)) return;
		if (button.contains(target)) return;
		if (panel.contains(target) && !(isHTMLElement(target) && target.closest(".cds--switcher__item-link"))) return;
		close();
	});

	render(undefined);

	return {
		button,
		render,
		close,
		isOpen: () => open,
		onOpen: (fn) => {
			openListeners.push(fn);
		},
	};
}
