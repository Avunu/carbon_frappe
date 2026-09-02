// The `⋮` row overflow menu — Carbon's trailing row-action affordance.
//
// Carbon's data-table spec puts row actions behind a `cds--overflow-menu` in
// the last column (see the expandable-table examples in carbon-website). frappe
// puts them inside the row form's heading toolbar instead, which is unreachable
// until the row is already open. Every item below therefore calls the SAME
// inherited GridRow method frappe's own `.grid-*-row` buttons call
// (grid_row_form.js#set_form_events), so behaviour, script triggers and
// `frm.dirty()` bookkeeping are identical — only the affordance moved.
//
// The menu is portaled to <body>. Table cells clip their overflow (the engine
// sizes them from <colgroup>), which is the same reason frappe re-parents
// awesomplete dropdowns out of grid cells in grid_row.js:1082-1108.
import { CARBON } from "../engine/classes";
import type { CarbonGridRow } from "./expand";
import type { GridDocField } from "frappe-types";

const ICON =
	'<svg class="cds--overflow-menu__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"' +
	' width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">' +
	'<circle cx="16" cy="8" r="2"/><circle cx="16" cy="16" r="2"/><circle cx="16" cy="24" r="2"/></svg>';

let MENU: HTMLDivElement | null = null;
let OPEN_FOR: HTMLButtonElement | null = null;

/** The single portaled menu element, created once per page. */
function menuEl(): HTMLDivElement {
	if (MENU) return MENU;
	// The element is held in a local `const` as well as in the module-level
	// cache, because the listeners registered below outlive this call and a
	// mutable module binding cannot be narrowed inside a closure. The two names
	// refer to the same node for the lifetime of the page: nothing ever assigns
	// `MENU` again.
	const menu = document.createElement("div");
	MENU = menu;
	menu.className = "cds--overflow-menu-options cf-grid__row-menu";
	menu.setAttribute("role", "menu");
	menu.tabIndex = -1;
	menu.hidden = true;
	const ul = document.createElement("ul");
	ul.className = "cds--overflow-menu-options__content";
	menu.appendChild(ul);
	document.body.appendChild(menu);

	// Dismissal. `capture` so a click that also triggers a cell handler still
	// closes the menu first, and `true` on scroll so the menu cannot float away
	// from its trigger when any ancestor scroller moves.
	document.addEventListener("click", (e) => {
		// `Node#contains` takes `Node | null` and answers `false` for `null`,
		// which is exactly what a non-element target produced here before.
		const target = e.target instanceof Node ? e.target : null;
		if (!menu.hidden && !menu.contains(target)) closeMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !menu.hidden) closeMenu();
	});
	window.addEventListener("scroll", () => closeMenu(), true);
	window.addEventListener("resize", () => closeMenu());
	return menu;
}

function closeMenu(): void {
	if (!MENU || MENU.hidden) return;
	MENU.hidden = true;
	MENU.classList.remove("cds--overflow-menu-options--open");
	if (OPEN_FOR) {
		OPEN_FOR.setAttribute("aria-expanded", "false");
		OPEN_FOR.classList.remove("cds--overflow-menu--open");
	}
	OPEN_FOR = null;
}

/** One entry of the menu. `danger` is Carbon's destructive treatment. */
interface RowMenuItem {
	label: string;
	danger?: boolean | undefined;
	action: () => void;
}

/**
 * The item list for a row.
 *
 * Gating mirrors frappe exactly: `is_editable()` hides every mutating action
 * (that is what `toggle_add_delete_button_display` does), and the two docfield
 * flags are the ones `GridRow.show_form()` checks before revealing the
 * corresponding buttons.
 */
function itemsFor(grid_row: CarbonGridRow): RowMenuItem[] {
	const grid = grid_row.grid;
	// The `|| {}` fallback is frappe's own defensiveness about a grid built
	// without a parent docfield; typing it as the two flags actually read keeps
	// the empty object a legal value for it.
	const df: Pick<GridDocField, "cannot_add_rows" | "cannot_delete_rows"> = grid.df || {};
	const editable = grid.is_editable();
	const can_add = editable && !grid.cannot_add_rows && !df.cannot_add_rows;
	const can_delete = editable && !df.cannot_delete_rows;

	const items: RowMenuItem[] = [
		{
			label: __("Open in dialog", null, "Carbon grid row action"),
			action: () => grid_row.toggle_view(true, null, { modal: true }),
		},
	];
	if (can_add) {
		items.push({ label: __("Insert Above"), action: () => grid_row.insert(true) });
		items.push({ label: __("Insert Below"), action: () => grid_row.insert(true, true) });
		items.push({ label: __("Duplicate"), action: () => grid_row.insert(true, true, true) });
	}
	if (editable) {
		items.push({ label: __("Move"), action: () => grid_row.move() });
	}
	if (can_delete) {
		items.push({ label: __("Delete"), danger: true, action: () => grid_row.remove() });
	}
	return items;
}

function openMenu(trigger: HTMLButtonElement, grid_row: CarbonGridRow): void {
	const root = menuEl();
	const ul = root.firstChild;
	// `menuEl()` appends that <ul> as the root's only child and nothing ever
	// removes it, so this is a narrowing, not a possibility: an absent list
	// threw on the next line before it was typed, and still does — with a
	// message that names the invariant that broke.
	if (!(ul instanceof HTMLUListElement)) {
		throw new Error("carbon_frappe: the row menu lost its options list");
	}
	ul.textContent = "";

	for (const item of itemsFor(grid_row)) {
		const li = document.createElement("li");
		li.className = "cds--overflow-menu-options__option";
		if (item.danger) li.classList.add("cds--overflow-menu-options__option--danger");
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cds--overflow-menu-options__btn";
		btn.setAttribute("role", "menuitem");
		const content = document.createElement("div");
		content.className = "cds--overflow-menu-options__option-content";
		content.textContent = item.label;
		btn.appendChild(content);
		btn.addEventListener("click", () => {
			closeMenu();
			item.action();
		});
		li.appendChild(btn);
		ul.appendChild(li);
	}

	root.hidden = false;
	root.classList.add("cds--overflow-menu-options--open");
	trigger.setAttribute("aria-expanded", "true");
	trigger.classList.add("cds--overflow-menu--open");
	OPEN_FOR = trigger;

	// `position: fixed` against the viewport rect, flipped up or left when the
	// menu would otherwise overflow — the grid sits low on tall forms often
	// enough that a bottom-anchored menu would open off-screen.
	const rect = trigger.getBoundingClientRect();
	const box = root.getBoundingClientRect();
	const flipUp = rect.bottom + box.height > window.innerHeight && rect.top > box.height;
	root.style.top = `${flipUp ? rect.top - box.height : rect.bottom}px`;
	root.style.left = `${Math.max(4, Math.min(rect.right - box.width, window.innerWidth - box.width - 4))}px`;
	root.focus();
}

/** The `⋮` trigger for one row, created once and reused across renders. */
export function rowMenuButton(grid_row: CarbonGridRow): HTMLButtonElement {
	if (grid_row.row_menu_button) return grid_row.row_menu_button;
	const button = document.createElement("button");
	button.type = "button";
	button.className = `cds--overflow-menu ${CARBON.overflowMenuDataTable}`;
	button.setAttribute("aria-haspopup", "true");
	button.setAttribute("aria-expanded", "false");
	button.setAttribute("aria-label", __("Row actions", null, "Carbon grid row action"));
	button.innerHTML = ICON;
	button.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (OPEN_FOR === button) closeMenu();
		else {
			closeMenu();
			openMenu(button, grid_row);
		}
	});
	grid_row.row_menu_button = button;
	return button;
}

export { closeMenu };
