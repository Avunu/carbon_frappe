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

/** Carbon's ChevronRight 16 (@carbon/icons), inlined — the engine has no icon dep. */
const CHEVRON =
	'<svg class="' +
	CARBON.expandSvg +
	'" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"' +
	' fill="currentColor" aria-hidden="true" focusable="false"' +
	' preserveAspectRatio="xMidYMid meet"><path d="M11 8 6 13 5.3 12.3 9.6 8 5.3 3.7 6 3z"/></svg>';

/** ids go into `aria-controls`, so anything outside [A-Za-z0-9_-] has to go. */
function idSafe(value) {
	return String(value == null ? "" : value).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Stable DOM id for a row's child row, matching Carbon's own scheme
 * (`data-table-{instance}-expanded-row-{rowId}`, DataTable.tsx#getTablePrefix).
 */
export function childRowId(grid_row) {
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
export function ensureChildRow(grid_row, columnCount) {
	if (!grid_row.form_row) {
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
	grid_row.form_cell.setAttribute("colspan", columns);

	return grid_row.form_inner;
}

/**
 * The expand chevron. Returned as the `_expand` column's cell CONTENT, not as
 * the cell itself: an adapter-supplied cell node is appended raw into the <tr>
 * (engine/render.js#renderRow), so a supplied <div> would never match Carbon's
 * element-qualified `td.cds--table-expand` rules. Letting the engine build the
 * real <td> — and tagging it through the class profile — keeps them applicable.
 */
export function expandButton(grid_row) {
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
export function syncExpandState(grid_row, open) {
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
