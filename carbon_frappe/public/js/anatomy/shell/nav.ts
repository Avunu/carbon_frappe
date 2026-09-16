// Carbon HeaderNavigation + HeaderMenu, rendered from the shell model.
//
// Markup is @carbon/react's (UIShell/HeaderNavigation.tsx, HeaderMenu.tsx,
// HeaderMenuItem.tsx), so @carbon/styles' header mixin styles it unchanged:
//
//   nav.cds--header__nav[aria-label] > ul.cds--header__menu-bar
//     li > a.cds--header__menu-item[href][aria-current=page]
//     li.cds--header__submenu
//       a.cds--header__menu-item.cds--header__menu-title[href="#"][aria-haspopup=menu][aria-expanded]
//         + svg.cds--header__menu-arrow
//       ul.cds--header__menu > li > a.cds--header__menu-item
//
// Behaviour is HeaderMenu.tsx's, no more: click / Enter / Space toggle a
// sub-menu, Escape closes it and returns focus to its title, focus leaving the
// item closes it, and a click anywhere else closes all. Carbon's HeaderMenu has
// no arrow-key handling, so neither does this. Opening is purely CSS:
// header/_header.scss keys the dropdown off `aria-expanded` on the title.
//
// Two things Carbon leaves to the product:
//
// 1. Overflow. Carbon's header has no priority+ behaviour, and a Workspace
//    Sidebar carries 3-13 top-level rows (Recruitment has 13) while ~630px is
//    what remains at the `lg` breakpoint after the name and the utilities. So
//    the bar is measured: every top-level `li` is sized once per render, and
//    `layout()` keeps the longest prefix that fits beside a trailing "More"
//    sub-menu, which receives the rest. Top-level nodes keep their identity
//    (only `hidden` toggles); More's list is re-rendered from the model slice.
//    Below `lg` Carbon hides the whole nav (`.cds--header__nav { display: none }`)
//    and the left sidebar carries every link, so `layout()` simply skips.
//
// 2. The current page. `aria-current="page"` is set by frappe's own rule
//    (sidebar.js:424-433, mirrored in model.ts) on every route change; a
//    collapsed sub-menu whose child is current gets
//    `cds--header__menu-item--current` on its title, as HeaderMenu.tsx:238-246
//    does.
//
// Sub-menu titles are `href="#"`. frappe's body-level click router returns
// early for that href WITHOUT preventDefault (router.js:52), so the title
// handler here prevents it itself — it runs first, being bound deeper.
import { chevronDown16 } from "../../generated/shell-icons.ts";
import { esc, isHTMLElement } from "./dom.ts";
import { isCurrentHref } from "./model.ts";
import type { ShellItem, ShellLeaf, ShellModel } from "./model.ts";

export interface ShellNav {
	/** The `<nav>` element, for the orchestrator to place. */
	el: HTMLElement;
	/** Rebuild the bar from the model. Re-measures; call `layout()` after. */
	render(model: ShellModel): void;
	/** Apply `aria-current` / `--current` from `location.pathname`. */
	markCurrent(): void;
	/**
	 * Fit the bar to the space between the name and the global bar.
	 * `remeasure` discards the cached item widths — for when the font loaded.
	 */
	layout(remeasure?: boolean): void;
	/** Collapse every open sub-menu. */
	closeAll(): void;
}

const MORE = "cf-header__more";
const GROUP = "cf-header__menu-group";

function itemHtml(item: ShellLeaf): string {
	const label = `<span class="cds--text-truncate--end">${esc(item.label)}</span>`;
	if (item.kind === "link") {
		const target = item.target ? ` target="${esc(item.target)}" rel="noopener"` : "";
		return `<li><a class="cds--header__menu-item" href="${esc(item.href)}" tabindex="0" data-cf-href${target}>${label}</a></li>`;
	}
	return `<li><a class="cds--header__menu-item" href="#" role="button" tabindex="0" data-cf-action="${esc(item.key)}">${label}</a></li>`;
}

function submenuHtml(label: string, inner: string, extraClass: string, hidden: boolean): string {
	return (
		`<li class="cds--header__submenu${extraClass ? " " + extraClass : ""}"${hidden ? " hidden" : ""}>` +
		`<a class="cds--header__menu-item cds--header__menu-title" href="#" tabindex="0" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(label)}">${esc(label)}${chevronDown16}</a>` +
		`<ul class="cds--header__menu" aria-label="${esc(label)}">${inner}</ul>` +
		`</li>`
	);
}

function topHtml(item: ShellItem, index: number): string {
	if (item.kind === "group") {
		return submenuHtml(item.label, item.items.map(itemHtml).join(""), "", false).replace(
			"<li ",
			`<li data-cf-index="${index}" `,
		);
	}
	return itemHtml(item).replace("<li>", `<li data-cf-index="${index}">`);
}

/** The overflowed tail, flattened: a group becomes a heading row plus its items. */
function moreHtml(items: ShellItem[]): string {
	let out = "";
	for (const item of items) {
		if (item.kind === "group") {
			out += `<li><span class="${GROUP}" role="presentation">${esc(item.label)}</span></li>`;
			out += item.items.map(itemHtml).join("");
		} else {
			out += itemHtml(item);
		}
	}
	return out;
}

function titleOf(li: Element): HTMLElement | null {
	const a = li.querySelector(":scope > .cds--header__menu-title");
	return isHTMLElement(a) ? a : null;
}

export function mountNav(header: HTMLElement): ShellNav {
	const el = document.createElement("nav");
	el.className = "cds--header__nav";
	el.innerHTML = `<ul class="cds--header__menu-bar"></ul>`;
	const first = el.firstElementChild;
	if (!(first instanceof HTMLUListElement)) throw new Error("carbon_frappe: UI Shell nav has no menu bar");
	// re-bound so the narrowing reaches the closures below
	const bar: HTMLUListElement = first;

	let model: ShellModel | null = null;
	/** Delegated click targets for href-less items, by model key. */
	let actions = new Map<string, HTMLElement>();
	/** Top-level `<li>`s in model order, excluding More. */
	let tops: HTMLElement[] = [];
	let more: HTMLElement | null = null;
	/** Intrinsic widths, measured with everything visible. */
	let widths: number[] = [];
	let moreWidth = 0;
	/** How many top-level items the last `layout()` showed; -1 = never laid out. */
	let shown = -1;

	function submenus(): HTMLElement[] {
		return Array.from(bar.querySelectorAll<HTMLElement>(":scope > li.cds--header__submenu"));
	}

	function setOpen(li: Element, open: boolean): void {
		const title = titleOf(li);
		if (title) title.setAttribute("aria-expanded", open ? "true" : "false");
	}

	function closeAll(): void {
		for (const li of submenus()) setOpen(li, false);
		markCurrent();
	}

	function toggle(li: Element): void {
		const title = titleOf(li);
		const open = !!title && title.getAttribute("aria-expanded") === "true";
		for (const other of submenus()) if (other !== li) setOpen(other, false);
		setOpen(li, !open);
		markCurrent();
	}

	function markCurrent(): void {
		for (const a of el.querySelectorAll<HTMLElement>("a[data-cf-href]")) {
			const href = a.getAttribute("href") || "";
			if (isCurrentHref(href)) a.setAttribute("aria-current", "page");
			else a.removeAttribute("aria-current");
		}
		for (const li of submenus()) {
			const title = titleOf(li);
			if (!title) continue;
			const collapsed = title.getAttribute("aria-expanded") !== "true";
			const has = !!li.querySelector(":scope > .cds--header__menu [aria-current='page']");
			title.classList.toggle("cds--header__menu-item--current", collapsed && has);
		}
	}

	function collectActions(items: ShellItem[]): Map<string, HTMLElement> {
		const map = new Map<string, HTMLElement>();
		for (const item of items) {
			if (item.kind === "action") map.set(item.key, item.source);
			else if (item.kind === "group")
				for (const k of item.items) if (k.kind === "action") map.set(k.key, k.source);
		}
		return map;
	}

	function measure(): void {
		if (!more) return;
		// everything visible, More measured but not seen, one read pass
		for (const li of tops) li.hidden = false;
		const wasHidden = more.hidden;
		more.hidden = false;
		more.style.visibility = "hidden";
		widths = tops.map((li) => li.offsetWidth);
		moreWidth = more.offsetWidth;
		more.style.visibility = "";
		more.hidden = wasHidden;
		shown = -1;
	}

	function render(next: ShellModel): void {
		closeAll();
		model = next;
		actions = collectActions(next.items);
		el.hidden = next.navHidden;
		const label = `${next.prefix} ${next.name}`.trim();
		el.setAttribute("aria-label", label);
		bar.innerHTML =
			next.items.map(topHtml).join("") +
			submenuHtml(typeof __ === "function" ? __("More") : "More", "", MORE, true);
		tops = Array.from(bar.querySelectorAll<HTMLElement>(":scope > li[data-cf-index]"));
		const last = bar.lastElementChild;
		more = isHTMLElement(last) ? last : null;
		widths = [];
		moreWidth = 0;
		shown = -1;
		markCurrent();
	}

	function layout(remeasure = false): void {
		if (!model || !more || el.hidden) return;
		// below `lg` Carbon hides the nav; measuring a display:none tree reads 0
		if (el.getClientRects().length === 0) return;
		if (remeasure || widths.length !== tops.length) measure();

		const headerRect = header.getBoundingClientRect();
		const navRect = el.getBoundingClientRect();
		const padStart = parseFloat(getComputedStyle(el).paddingInlineStart) || 0;
		// the global bar is `flex: 1 1 0%` and can be squeezed, so its INTRINSIC
		// width (48px cells) is what the bar must leave room for
		const global = header.querySelector<HTMLElement>(".cds--header__global");
		let actionsWidth = 0;
		if (global)
			for (const child of global.children) if (isHTMLElement(child)) actionsWidth += child.offsetWidth;
		const isRtl = getComputedStyle(header).direction === "rtl";
		const navStart = isRtl ? headerRect.right - navRect.right : navRect.left - headerRect.left;
		const budget = headerRect.width - navStart - padStart - actionsWidth;

		let n = 0;
		let used = 0;
		while (n < widths.length) {
			const w = widths[n] ?? 0;
			const rest = n + 1 === widths.length ? 0 : moreWidth;
			if (used + w + rest > budget) break;
			used += w;
			n++;
		}
		if (n === shown) return;
		shown = n;

		tops.forEach((li, i) => {
			li.hidden = i >= n;
		});
		if (n >= tops.length) {
			more.hidden = true;
			const list = more.querySelector(".cds--header__menu");
			if (list) list.innerHTML = "";
		} else {
			const list = more.querySelector(".cds--header__menu");
			if (list) list.innerHTML = moreHtml(model.items.slice(n));
			more.hidden = false;
		}
		markCurrent();
	}

	// -- behaviour, bound once; delegation survives every re-render -----------

	el.addEventListener("click", (e) => {
		const target = e.target;
		if (!isHTMLElement(target)) return;
		const title = target.closest(".cds--header__menu-title");
		if (title && el.contains(title)) {
			e.preventDefault();
			const li = title.parentElement;
			if (li) toggle(li);
			return;
		}
		const action = target.closest<HTMLElement>("[data-cf-action]");
		if (action) {
			e.preventDefault();
			const key = action.getAttribute("data-cf-action") || "";
			const source = actions.get(key);
			closeAll();
			if (source) source.click();
			return;
		}
		if (target.closest("a[data-cf-href]")) {
			// let frappe's body-level router take the navigation
			closeAll();
		}
	});

	el.addEventListener("keydown", (e) => {
		const target = e.target;
		if (!isHTMLElement(target)) return;
		if (e.key === "Escape") {
			const li = target.closest(".cds--header__submenu");
			const title = li && titleOf(li);
			if (li && title && title.getAttribute("aria-expanded") === "true") {
				e.preventDefault();
				setOpen(li, false);
				markCurrent();
				title.focus();
			}
			return;
		}
		if ((e.key === "Enter" || e.key === " ") && target.classList.contains("cds--header__menu-title")) {
			e.preventDefault();
			const li = target.parentElement;
			if (li) toggle(li);
		}
	});

	el.addEventListener("focusout", (e) => {
		const next = e.relatedTarget;
		for (const li of submenus()) {
			const title = titleOf(li);
			if (!title || title.getAttribute("aria-expanded") !== "true") continue;
			if (!(next instanceof Node) || !li.contains(next)) {
				setOpen(li, false);
				markCurrent();
			}
		}
	});

	document.addEventListener("click", (e) => {
		const target = e.target;
		if (target instanceof Node && el.contains(target)) return;
		closeAll();
	});

	return { el, render, markCurrent, layout, closeAll };
}
