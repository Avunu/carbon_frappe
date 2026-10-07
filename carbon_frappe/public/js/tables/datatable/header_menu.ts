// The per-column header menu — frappe-datatable's `dt-dropdown`, as a Carbon
// overflow menu.
//
// frappe-datatable put a chevron on every header cell that opened a list of
// actions on the COLUMN: Sort Ascending, Sort Descending, Reset sorting, Remove
// column, Freeze / Unfreeze (defaults.js:9-50), and then whatever a caller added
// through `options.headerDropdown`. Report View adds one — "Add Column"
// (report_view.js:335-405) — which is the only inline way to add a column to a
// report. The Carbon header has a sort button and a resize handle but no menu,
// so without this those six actions and Add Column were unreachable.
//
// The toggle is a button appended to the header `<th>`, beside (not inside) the
// engine's own sort button, so neither can clobber the other. The menu is
// portaled to <body> because a table cell clips its overflow — the same reason
// the Grid's row menu is.
//
// Items are built when the menu OPENS, not when the toggle is created: Freeze
// and Unfreeze are one slot (a column is either frozen or it is not), and the
// extras a caller supplied live on `options` and may have been changed since.
import { chevronRight16 } from "../../generated/icons.ts";
import type CarbonDataTable from "./datatable.ts";
import type { DataTableColumn } from "frappe-types";

/** One row of the open menu. */
interface MenuItem {
	label: string;
	run: () => void;
}

let MENU: HTMLDivElement | null = null;
let OPEN_FOR: HTMLButtonElement | null = null;

function closeMenu(): void {
	if (!MENU || MENU.hidden) return;
	MENU.hidden = true;
	MENU.classList.remove("cds--overflow-menu-options--open");
	if (OPEN_FOR) OPEN_FOR.setAttribute("aria-expanded", "false");
	OPEN_FOR = null;
}

/** The single portaled menu element, created once per page. */
function menuEl(): HTMLDivElement {
	if (MENU) return MENU;
	const menu = document.createElement("div");
	MENU = menu;
	menu.className = "cds--overflow-menu-options cf-dt-menu";
	menu.setAttribute("role", "menu");
	menu.tabIndex = -1;
	menu.hidden = true;
	const list = document.createElement("ul");
	list.className = "cds--overflow-menu-options__content";
	menu.appendChild(list);
	document.body.appendChild(menu);

	// Dismissal. Document-level and on the capture phase for scroll, so a menu
	// cannot float away from its header when any ancestor scroller moves.
	document.addEventListener("click", (e) => {
		const target = e.target instanceof Node ? e.target : null;
		if (menu.hidden || menu.contains(target)) return;
		// the toggle that opened it handles its own click (it closes the menu)
		if (OPEN_FOR && OPEN_FOR.contains(target)) return;
		closeMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (menu.hidden) return;
		if (e.key === "Escape") {
			const back = OPEN_FOR;
			closeMenu();
			if (back) back.focus();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
		if (!buttons.length) return;
		e.preventDefault();
		const down = e.key === "ArrowDown";
		const at = buttons.findIndex((b) => b === document.activeElement);
		const next =
			at < 0 ? (down ? 0 : buttons.length - 1) : (at + (down ? 1 : -1) + buttons.length) % buttons.length;
		buttons[next]?.focus();
	});
	window.addEventListener("scroll", () => closeMenu(), true);
	window.addEventListener("resize", () => closeMenu());
	return menu;
}

/**
 * The items for one column: frappe-datatable's six, then the caller's extras.
 *
 * Labels go through `translate`, as stock does (`instance.translate`), so the
 * strings `frappe.utils.datatable.get_translations()` ships (Sort Ascending,
 * Sort Descending, Reset sorting, Remove column) resolve. Freeze and Unfreeze
 * are not in that table in either implementation, so they fall through as
 * written, which is what stock does too.
 */
function itemsFor(table: CarbonDataTable, column: DataTableColumn): MenuItem[] {
	const at = column.colIndex ?? -1;
	const items: MenuItem[] = [
		{ label: table.translate("Sort Ascending"), run: () => table.sortColumn(at, "asc") },
		{ label: table.translate("Sort Descending"), run: () => table.sortColumn(at, "desc") },
		{ label: table.translate("Reset sorting"), run: () => table.sortColumn(at, "none") },
		{ label: table.translate("Remove column"), run: () => table.removeColumn(at) },
		column.sticky
			? { label: table.translate("Unfreeze"), run: () => table.setColumnSticky(at, false) }
			: { label: table.translate("Freeze"), run: () => table.setColumnSticky(at, true) },
	];
	for (const extra of table.options.headerDropdown) {
		const action = extra.action;
		// `display` hides an item at build time (columnmanager.js:501), which is
		// how a caller ships an entry it will switch on later.
		if (!action || extra.display) continue;
		items.push({ label: extra.label, run: () => action.call(table, column) });
	}
	return items;
}

function openMenu(trigger: HTMLButtonElement, table: CarbonDataTable, column: DataTableColumn): void {
	const root = menuEl();
	const list = root.firstChild;
	if (!(list instanceof HTMLUListElement)) {
		throw new Error("carbon_frappe: the column menu lost its options list");
	}
	list.textContent = "";

	for (const item of itemsFor(table, column)) {
		const li = document.createElement("li");
		li.className = "cds--overflow-menu-options__option";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cds--overflow-menu-options__btn";
		button.setAttribute("role", "menuitem");
		const content = document.createElement("div");
		content.className = "cds--overflow-menu-options__option-content";
		// Text, never markup: a label like "Insert Column Before <b>X</b>" is the
		// dialog's, and a menu entry is a plain string everywhere it is built.
		content.textContent = item.label;
		button.appendChild(content);
		button.addEventListener("click", () => {
			closeMenu();
			item.run();
		});
		li.appendChild(button);
		list.appendChild(li);
	}

	root.hidden = false;
	root.classList.add("cds--overflow-menu-options--open");
	trigger.setAttribute("aria-expanded", "true");
	OPEN_FOR = trigger;

	// `position: fixed` against the viewport, flipped up or left when the menu
	// would overflow it.
	const rect = trigger.getBoundingClientRect();
	const box = root.getBoundingClientRect();
	const flipUp = rect.bottom + box.height > window.innerHeight && rect.top > box.height;
	root.style.top = `${flipUp ? rect.top - box.height : rect.bottom}px`;
	root.style.left = `${Math.max(4, Math.min(rect.right - box.width, window.innerWidth - box.width - 4))}px`;
	const first = root.querySelector("button");
	if (first) first.focus();
}

/** The toggle's class: a hook for the stylesheet, and how this module finds its own button. */
const TOGGLE = "cf-dt-menu__toggle";

/**
 * Give every eligible header cell its menu toggle, and take it off any that is
 * not. Called after every engine render: header cells persist across renders
 * (the engine caches them by column id), so this only ever adds to a cell that
 * is new, and costs one `querySelector` per header otherwise.
 *
 * Eligible is stock's rule: not the injected checkbox / serial columns, and not
 * a column that says `dropdown: false` (cellmanager.js:877-878).
 */
export function syncHeaderMenus(table: CarbonDataTable): void {
	for (const th of table.engine.renderer.thead.querySelectorAll<HTMLTableCellElement>(
		"tr.dt-row-header > th",
	)) {
		const index = Number(th.getAttribute("data-col-index"));
		const column = table.columns[index];
		const wanted = !!column && index >= table.standardColumnCount && column.dropdown !== false;
		let toggle = th.querySelector<HTMLButtonElement>(`:scope > .${TOGGLE}`);
		if (!wanted || !column) {
			if (toggle) toggle.remove();
			continue;
		}
		if (!toggle) {
			toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = TOGGLE;
			toggle.setAttribute("aria-haspopup", "menu");
			toggle.setAttribute("aria-expanded", "false");
			toggle.innerHTML = chevronRight16;
			const button = toggle;
			toggle.addEventListener("click", (e) => {
				// not a sort, not a cell click
				e.preventDefault();
				e.stopPropagation();
				if (OPEN_FOR === button) {
					closeMenu();
					return;
				}
				closeMenu();
				// read at click time: the column objects are rebuilt on refresh()
				const live = table.columns[Number(button.parentElement?.getAttribute("data-col-index"))];
				if (live) openMenu(button, table, live);
			});
			th.appendChild(toggle);
		}
		// Only when it changed: this runs after every engine render, which while a
		// long report scrolls is every frame.
		const label = `${table.translate("Menu")}: ${String(column.name ?? column.content ?? "")}`;
		if (toggle.getAttribute("aria-label") !== label) toggle.setAttribute("aria-label", label);
	}
}

export { closeMenu as closeHeaderMenu };
