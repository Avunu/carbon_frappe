// Carbon's expandable-row anatomy, built for frappe's child-table Grid.
//
// WHAT CARBON REQUIRES (packages/styles/scss/components/data-table/expandable/
// _data-table-expandable.scss), and why each piece is load-bearing here:
//
//   1. The child row must be the parent row's IMMEDIATE next sibling. Nearly
//      every rule in that file is `tr.cds--parent-row… + tr[data-child-row]`,
//      so a wrapper element or a per-row <tbody> silently kills the styling.
//      The engine's `renderRowAddendum` seam already emits it in that position
//      (engine/render.js#renderBody).
//
//   2. The child row is NEVER removed from the DOM. Collapse is pure CSS —
//      `block-size: 0` on the row plus `max-block-size: 0` on the inner
//      container — which is also what makes the 240ms open/close transition
//      possible. So `ensureChildRow` is called for every row on every render,
//      not just the open one. The expensive part (frappe's GridRowForm, which
//      builds a whole `frappe.ui.form.Layout`) stays lazy: grid_row.js only
//      constructs it on first expand.
//
//   3. `data-previous-value="collapsed"` means EXPANDED. The name is inverted
//      upstream too (@carbon/react TableExpandRow.tsx:160 —
//      `const previousValue = isExpanded ? 'collapsed' : undefined`). It drives
//      the chevron rotation and suppresses the parent cell's bottom border.
//
// WHAT THE CHILD ROW MUST NOT BE: `.grid-row`. frappe binds Sortable with
// `draggable: ".grid-row"` (grid.js:752-787) and `renumber_based_on_dom()`
// walks the same selector to rewrite `idx` after a drag. A permanently
// present child row carrying that class would be draggable and would corrupt
// row order. It carries no frappe classes at all.
import { CARBON } from "../engine/classes";
import type Grid from "frappe/public/js/frappe/form/grid";
import type GridRow from "frappe/public/js/frappe/form/grid_row";

// ------------------------------------------------------ the carbon row's type
//
// `CarbonGridRow` is declared HERE, as an interface, rather than imported from
// ./grid_row — which imports THIS file, and ./row_menu, and would be a cycle.
// The helpers below both READ frappe's own GridRow members (`doc`, `grid`,
// `toggle_view`) and WRITE members only carbon_frappe's subclass has
// (`form_row`, `form_cell`, `form_inner`, `expand_button`), so `GridRow` alone
// is not a strong enough parameter type.
//
// An interface that extends the base CLASS is what breaks the cycle: it erases
// completely, it inherits every one of GridRow's ~70 members without restating
// them, and TypeScript only lets a class DERIVED from `GridRow` implement it —
// which is exactly the constraint that holds here. ./grid_row's
// `class CarbonGridRow extends GridRow` satisfies it whether or not it names it
// in an `implements` clause.

/**
 * The `CarbonTable` handle `CarbonGrid` mounts into `grid.carbon_table`, as far
 * as this module reaches into it.
 *
 * Declared structurally rather than imported from ../engine/table for the same
 * cycle reason, and because the engine's surface is two orders of magnitude
 * larger than the two members read here. The real `CarbonTable` satisfies it.
 */
export interface CarbonGridEngine {
	/** Per-table counter behind Carbon's `data-table-{instance}` id scheme. */
	readonly instanceId: number;
	/** The TanStack table. Only the visible-column COUNT is read. */
	readonly table: {
		getVisibleLeafColumns(): readonly unknown[];
	};
}

/**
 * frappe's `Grid` plus the engine CarbonGrid replaces its DOM with.
 *
 * `carbon_table` is optional because `CarbonGrid#make()` is what creates it and
 * every read of it in this app is guarded — a Grid that has not been made yet,
 * or a plain frappe Grid handed to one of these helpers, still type-checks and
 * still falls back the way the runtime does.
 */
export interface CarbonGridHost extends Grid {
	carbon_table?: CarbonGridEngine | undefined;
}

/**
 * frappe's `GridRow`, plus every member `CarbonGridRow` adds to it.
 *
 * Grouped below by which file owns each addition, because that is the only
 * documentation of an instance shape that four modules co-operate on.
 */
export interface CarbonGridRow extends GridRow {
	/** Narrowed from `Grid`: a CarbonGridRow only ever belongs to a CarbonGrid. */
	grid: CarbonGridHost;

	// ------------------------------------------------ this file's additions

	/** The permanently-present child `<tr>`; see 1. and 2. in the header. */
	form_row?: HTMLTableRowElement | undefined;
	/** Its single `<td>`, re-`colspan`ned on every {@link ensureChildRow}. */
	form_cell?: HTMLTableCellElement | undefined;
	/** `cds--child-row-inner-container` — what the detail form is appended to. */
	form_inner?: HTMLDivElement | undefined;
	/** The chevron, built once and reused across renders. */
	expand_button?: HTMLButtonElement | undefined;

	// ------------------------------------------------- ./row_menu's additions

	/** The `⋮` trigger, built once and reused across renders. */
	row_menu_button?: HTMLButtonElement | undefined;

	// ------------------------------------------------ ./grid_row's additions

	/** The cell the `⋮` trigger lives in — frappe's trailing `.col`, or a fresh div. */
	menu_cell?: HTMLElement | undefined;
	/** The OUTER `.col` of frappe's open-form button, which frappe itself drops. */
	open_form_cell?: JQuery | undefined;
	/** "This call asked for the legacy dialog" — see `toggle_view` in ./grid_row. */
	_request_modal?: boolean | undefined;
	/** "The open form IS the legacy dialog" — latched in `show_form`, read in `hide_form`. */
	_modal_form?: boolean | undefined;

	/** True while this row's detail panel is open. */
	is_expanded(): boolean;
	/** The child row's inner container, created on demand. */
	ensure_form_host(): HTMLDivElement;
	/** `_expand` column content. */
	expand_node(): HTMLButtonElement;
	/** `_menu` column content. */
	menu_node(): HTMLElement;
	/** The cell element for a fieldname, for the engine to place. */
	get_column_node(fieldname: string): HTMLElement | null;

	/**
	 * frappe's two-argument `toggle_view` plus `{ modal: true }`.
	 *
	 * Widening an override with an OPTIONAL parameter keeps it assignable to the
	 * base declaration, which is what lets ./row_menu call it three-arg through
	 * this type while frappe keeps re-entering it two-arg (grid_row.js:1460).
	 */
	toggle_view(
		show?: boolean | undefined,
		callback?: (() => void) | null | undefined,
		opts?: { modal?: boolean | undefined } | undefined
	): this | undefined;
}

/** Carbon's ChevronRight 16 (@carbon/icons), inlined — the engine has no icon dep. */
const CHEVRON =
	'<svg class="' +
	CARBON.expandSvg +
	'" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"' +
	' fill="currentColor" aria-hidden="true" focusable="false"' +
	' preserveAspectRatio="xMidYMid meet"><path d="M11 8 6 13 5.3 12.3 9.6 8 5.3 3.7 6 3z"/></svg>';

/** ids go into `aria-controls`, so anything outside [A-Za-z0-9_-] has to go. */
function idSafe(value: unknown): string {
	return String(value == null ? "" : value).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Stable DOM id for a row's child row, matching Carbon's own scheme
 * (`data-table-{instance}-expanded-row-{rowId}`, DataTable.tsx#getTablePrefix).
 */
export function childRowId(grid_row: CarbonGridRow): string {
	const table = grid_row.grid && grid_row.grid.carbon_table;
	const instance = table ? table.instanceId : 0;
	const name = grid_row.doc ? grid_row.doc.name : "";
	return `cf-grid-${instance}-expanded-row-${idSafe(name)}`;
}

/**
 * The child <tr>, created on demand and reused forever after.
 *
 * `colspan` is re-stamped on every call because Configure Columns and
 * `set_column_disp_in_list_view()` change the visible column count without
 * rebuilding the row.
 */
export function ensureChildRow(grid_row: CarbonGridRow, columnCount?: number): HTMLDivElement {
	// All three are written together, and only here, so testing all three is
	// the same test as testing `form_row` alone — and it is the spelling that
	// tells the compiler the other two are present below.
	if (!grid_row.form_row || !grid_row.form_cell || !grid_row.form_inner) {
		const tr = document.createElement("tr");
		// `cds--expandable-row` is permanent structure on a CHILD row (on a
		// parent row the same class means "expanded" — Carbon overloads it).
		tr.className = CARBON.expandableRow;
		tr.setAttribute("data-child-row", "true");

		const td = document.createElement("td");
		td.className = "cf-table__child-cell";

		const inner = document.createElement("div");
		inner.className = CARBON.childRowInner;

		td.appendChild(inner);
		tr.appendChild(td);

		grid_row.form_row = tr;
		grid_row.form_cell = td;
		grid_row.form_inner = inner;
	}
	grid_row.form_row.id = childRowId(grid_row);

	let columns = columnCount;
	if (!columns) {
		const table = grid_row.grid && grid_row.grid.carbon_table;
		columns = table ? table.table.getVisibleLeafColumns().length : 1;
	}
	// `String()` is the coercion `setAttribute` performs on a number anyway.
	grid_row.form_cell.setAttribute("colspan", String(columns));

	return grid_row.form_inner;
}

/**
 * The expand chevron. Returned as the `_expand` column's cell CONTENT, not as
 * the cell itself: an adapter-supplied cell node is appended raw into the <tr>
 * (engine/render.js#renderRow), so a supplied <div> would never match Carbon's
 * element-qualified `td.cds--table-expand` rules. Letting the engine build the
 * real <td> — and tagging it through the class profile — keeps them applicable.
 */
export function expandButton(grid_row: CarbonGridRow): HTMLButtonElement {
	if (!grid_row.expand_button) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = CARBON.expandRow;
		button.innerHTML = CHEVRON;
		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			// `toggle_view()` with no argument is frappe's accordion: it opens
			// this row only when no other row is open, and otherwise closes the
			// open one (grid_row.js:1448). Passing an explicit boolean is what
			// makes the chevron behave like a chevron.
			grid_row.toggle_view(!grid_row.is_expanded());
		});
		grid_row.expand_button = button;
	}
	syncExpandState(grid_row, grid_row.is_expanded());
	return grid_row.expand_button;
}

/** Mirror open/closed onto the button's ARIA and the cell's `data-previous-value`. */
export function syncExpandState(grid_row: CarbonGridRow, open: boolean): void {
	const button = grid_row.expand_button;
	if (!button) return;
	button.setAttribute("aria-expanded", open ? "true" : "false");
	button.setAttribute(
		"aria-label",
		open
			? __("Collapse current row", null, "Carbon expandable grid row")
			: __("Expand current row", null, "Carbon expandable grid row")
	);
	button.setAttribute("aria-controls", childRowId(grid_row));

	// Nearest cell, not `.cds--table-expand`: the class profile stamps that
	// class AFTER the cell's content is rendered (engine/render.js#renderRow
	// calls renderCellContent, then applyProfile), so on the very first render
	// a class-based lookup finds nothing.
	const cell = button.closest("td, th");
	if (!cell) return;
	// Inverted on purpose — see the header comment.
	if (open) cell.setAttribute("data-previous-value", "collapsed");
	else cell.removeAttribute("data-previous-value");
}
