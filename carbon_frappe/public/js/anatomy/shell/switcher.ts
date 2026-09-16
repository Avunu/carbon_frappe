// Carbon Switcher — the app switcher in the header's right panel.
//
// Carbon (patterns/global-header): "The switcher provides a way for the user
// to easily navigate between products and systems", it is "the furthest right
// icon", and "the switcher icon and the switcher panel should only be used
// together". frappe's products are what its `/desk` landing page lays out —
// the Desktop Icons: the installed apps AND the workspaces, as the user has
// them on the desktop, in its order and with its nesting (shell/desktop.ts
// re-applies the desktop page's rules over `boot.desktop_icons`). The current
// workspace is selected, and the Desktop launcher sits below a divider — it is
// also the first entry of frappe's own sidebar-header menu
// (ui/sidebar/sidebar_header.js:10-17).
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
// plus one row Carbon's Switcher does not have — an expandable one, for a
// desktop Folder or an App icon with workspaces under it (the desktop opens
// those in a modal, desktop.js:1123-1143). Carbon's SideNavMenu is the
// disclosure pattern of the shell, but its CSS is the side-nav mixin, which
// this theme deliberately does not include (the left panel is frappe's), so the
// row borrows only its ARIA — a `<button aria-expanded aria-controls>` before
// a `<ul>` — and Carbon's own switcher-item classes for its look:
//
//       li.cds--switcher__item.cf-switcher__group
//         button.cds--switcher__item-link.cf-switcher__toggle[aria-expanded][aria-controls]
//           > text + svg.cf-switcher__arrow
//         ul.cf-switcher__submenu[id][hidden]
//           li.cds--switcher__item > a.cds--switcher__item-link
//
// Behaviour is HeaderPanel.tsx + Switcher.tsx: the action toggles the panel
// and takes `cds--header__action--active`; Escape closes and returns focus to
// the action; focus or a click leaving both closes; ArrowUp/ArrowDown move
// focus through the VISIBLE rows with wrap (Switcher.tsx:74-118, the one place
// Carbon's shell does handle arrow keys) — toggles included, collapsed
// children excluded; ArrowRight/ArrowLeft on a toggle expand/collapse it
// (SideNavMenu's convention). Rows are tabbable only while the panel is open
// (SwitcherItem.tsx:100). Opening is CSS: header-panel's mixin keys the 16rem
// width off `--expanded`.
//
// Expansion is remembered for the session, and the group holding the current
// workspace opens itself on every render — the panel is rebuilt on each
// `project()`, and a fresh one should show where the user is.
import type { ShellModel } from "./model";
import { buildDesktopTree } from "./desktop";
import type { DesktopEntry } from "./desktop";
import { chevronDown16Switcher, switcher20 } from "../../generated/shell-icons";
import { esc, isHTMLElement } from "./dom";

export interface ShellSwitcher {
	/** The action button, so the orchestrator can keep it last in the global bar. */
	button: HTMLButtonElement;
	/** Rebuild the list; `model.workspace` is the entry to mark selected (none on the launcher). */
	render(model: ShellModel): void;
	close(): void;
	isOpen(): boolean;
	/** Called when the panel opens, so other right-side surfaces can yield. */
	onOpen(fn: () => void): void;
}

const BUTTON_ID = "cf-switcher-button";
const PANEL_ID = "cf-switcher-panel";
const SUBMENU_ID = "cf-switcher-submenu-";

function translate(s: string): string {
	return typeof __ === "function" ? __(s) : s;
}

function linkHtml(entry: DesktopEntry, open: boolean): string {
	const selected = entry.selected ? " cds--switcher__item-link--selected" : "";
	const current = entry.selected ? ` aria-current="page"` : "";
	const target = entry.target ? ` target="${esc(entry.target)}" rel="noopener"` : "";
	return (
		`<li class="cds--switcher__item">` +
		`<a class="cds--switcher__item-link${selected}" href="${esc(entry.href ?? "#")}" tabindex="${open ? 0 : -1}"${current}${target}>${esc(entry.title)}</a>` +
		`</li>`
	);
}

function groupHtml(entry: DesktopEntry, index: number, expanded: boolean, open: boolean): string {
	const id = `${SUBMENU_ID}${index}`;
	return (
		`<li class="cds--switcher__item cf-switcher__group">` +
		`<button type="button" class="cds--switcher__item-link cf-switcher__toggle" data-group="${esc(entry.label)}"` +
		` aria-expanded="${expanded ? "true" : "false"}" aria-controls="${id}" tabindex="${open ? 0 : -1}">` +
		`<span class="cf-switcher__toggle-label">${esc(entry.title)}</span>${chevronDown16Switcher}</button>` +
		`<ul class="cf-switcher__submenu" id="${id}"${expanded ? "" : " hidden"}>` +
		entry.children.map((c) => linkHtml(c, open && expanded)).join("") +
		`</ul>` +
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
	/** Labels of the groups currently expanded; survives re-renders. */
	const expanded = new Set<string>();

	/** The rows a keyboard user can reach right now: every link or toggle not inside a collapsed group. */
	function rows(): HTMLElement[] {
		return Array.from(switcher.querySelectorAll<HTMLElement>(".cds--switcher__item-link")).filter(
			(el) => !el.closest(".cf-switcher__submenu[hidden]"),
		);
	}

	function apply(): void {
		button.setAttribute("aria-expanded", open ? "true" : "false");
		button.classList.toggle("cds--header__action--active", open);
		panel.classList.toggle("cds--header-panel--expanded", open);
		for (const a of switcher.querySelectorAll<HTMLElement>(".cds--switcher__item-link")) a.tabIndex = -1;
		if (open) for (const a of rows()) a.tabIndex = 0;
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

	function setExpanded(toggle: HTMLElement, value: boolean): void {
		const label = toggle.dataset["group"];
		const id = toggle.getAttribute("aria-controls");
		const submenu = id ? document.getElementById(id) : null;
		if (label === undefined || !submenu) return;
		toggle.setAttribute("aria-expanded", value ? "true" : "false");
		submenu.hidden = !value;
		if (value) expanded.add(label);
		else expanded.delete(label);
		for (const a of submenu.querySelectorAll<HTMLElement>(".cds--switcher__item-link"))
			a.tabIndex = open && value ? 0 : -1;
	}

	function render(model: ShellModel): void {
		const boot = window.frappe && frappe.boot;
		const icons = (boot && boot.desktop_icons) || [];
		const sidebars = (boot && boot.workspace_sidebar_item) || {};
		const tree = buildDesktopTree(icons, sidebars, model.workspace);
		const parts: string[] = [];
		tree.forEach((entry, i) => {
			if (!entry.children.length) {
				parts.push(linkHtml(entry, open));
				return;
			}
			if (entry.children.some((c) => c.selected)) expanded.add(entry.label);
			parts.push(groupHtml(entry, i, expanded.has(entry.label), open));
		});
		const desktop: DesktopEntry = {
			label: "Desktop",
			title: translate("Desktop"),
			href: "/desk",
			target: null,
			selected: false,
			children: [],
		};
		switcher.innerHTML = parts.join("") + (parts.length ? DIVIDER : "") + linkHtml(desktop, open);
	}

	button.addEventListener("click", () => {
		if (open) close();
		else show();
	});

	// a toggle's click is the disclosure; nothing else in the panel is a button
	switcher.addEventListener("click", (e) => {
		const target = e.target;
		if (!isHTMLElement(target)) return;
		const toggle = target.closest<HTMLElement>(".cf-switcher__toggle");
		if (!toggle) return;
		e.preventDefault();
		setExpanded(toggle, toggle.getAttribute("aria-expanded") !== "true");
	});

	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			button.focus();
			return;
		}
		const target = e.target;
		if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
			if (!isHTMLElement(target) || !target.classList.contains("cf-switcher__toggle")) return;
			e.preventDefault();
			setExpanded(target, e.key === "ArrowRight");
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const all = rows();
		if (!all.length) return;
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
	// is done. A toggle's click keeps it open.
	document.addEventListener("click", (e) => {
		const target = e.target;
		if (!(target instanceof Node)) return;
		if (button.contains(target)) return;
		if (panel.contains(target) && !(isHTMLElement(target) && target.closest("a.cds--switcher__item-link")))
			return;
		close();
	});

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
