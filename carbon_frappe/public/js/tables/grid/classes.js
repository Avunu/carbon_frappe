// The `grid-*` class contract of frappe's child-table Grid, re-emitted onto
// engine DOM.
//
// Same rationale as tables/datatable/classes.js: the classes below are queried
// by frappe core and by app code, so they must keep resolving even though the
// element underneath is now a <tr>/<td> instead of a stack of divs.
//
// Load-bearing examples:
//   .grid-row[data-name]          form/controls/table.js paste handler
//   .grid-row-open                layout.js:712, ui/keyboard.js:335, grid.js:8
//                                 — all do `$(".grid-row-open").data("grid_row")`
//   [data-idx]                    grid.js:1068 `$("[data-idx=N]").data("grid_row")`
//   .grid-static-col[data-fieldtype]  desk/_numerics.scss selects on both
//   .sortable-handle              the Sortable.js drag handle
//   .rows                         the element Sortable is bound to
//
// The row and cell elements themselves are built by CarbonGridRow, not by the
// engine (see engine/render.js `createRowNode`), so this profile only decorates
// the scaffolding around them.

import { CARBON } from "../engine/classes";

function add(node, ...names) {
	for (const n of names) if (n && !node.classList.contains(n)) node.classList.add(n);
}

export function gridProfile() {
	return {
		root(node) {
			add(node, "form-grid");
		},
		scroll(node) {
			add(node, "grid-body");
		},
		head(node) {
			add(node, "grid-heading-row");
		},
		body(node) {
			// Sortable.js binds to this element; frappe's `make_sortable` is
			// inherited unchanged and expects `.rows`.
			add(node, "rows");
		},
		// NOT `.row`: Bootstrap's `.row` is `display: flex`, which blockifies
		// every <th> and collapses the table. Body rows omit it for the same
		// reason (see tables/grid/grid_row.js#make).
		headerRow(node) {
			add(node, "grid-row", "data-row");
		},

		// A marker only. Do NOT add `col grid-static-col` here: the REAL
		// `.grid-static-col` is the element frappe's `GridRow.make_column()`
		// built, which the engine nests inside this cell. Adding the class to
		// the cell as well produced two nested `.grid-static-col`s, and frappe
		// sizes that class with `height: 43px` and `padding: 6px 8px !important`
		// (common/grid.scss:174) — so the <th> ended up shorter than its row,
		// leaving the <thead> background showing above and below it as a grey
		// band. Body cells never had the class, which is why only the header
		// looked wrong.
		headerCell(node, ctx) {
			add(node, "cf-table__cell--grid");
			gutter(node, ctx);
		},
		cell(node, ctx) {
			add(node, "cf-table__cell--grid");
			gutter(node, ctx);
		},
		filterRow(node) {
			add(node, "grid-row", "data-row", "filter-row");
		},
		filterCell(node) {
			add(node, "cf-table__cell--grid", "search");
		},
		empty(node) {
			add(node, "grid-empty", "text-center", "text-extra-muted");
		},
	};
}

/**
 * Carbon's expand and row-menu gutters.
 *
 * These go on the ENGINE's <th>/<td>, not on a supplied node, because Carbon
 * writes them element-qualified — `th.cds--table-expand`, `td.cds--table-expand`
 * — and half the expandable stylesheet keys off `td.cds--table-expand
 * [data-previous-value]` to rotate the chevron and drop the row's borders. An
 * adapter-supplied <div> would match none of it.
 */
function gutter(node, ctx) {
	const id = ctx && ctx.column && ctx.column.id;
	if (id === "_expand") add(node, CARBON.expandCell);
	else if (id === "_menu") add(node, CARBON.columnMenu);
}
