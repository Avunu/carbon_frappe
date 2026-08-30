// The `list-row-*` class contract of frappe's List view, re-emitted onto engine
// DOM.
//
// Unlike the Grid and the Report view, the List view's markup is also styled by
// carbon_frappe's OWN stylesheet (desk/_list.scss), which already renders it as
// a Carbon data table — including selection state driven purely by
// `:has(.list-row-checkbox:checked)`. Keeping these class names therefore
// preserves both frappe's behaviour and this app's existing styling.
//
// Load-bearing:
//   .list-row-checkbox[data-name]   setup_check_events shift-select, get_checked_items
//   .list-header-subject            setup_check_events select-all delegation
//   .checkbox-actions               the bulk-action overlay on_row_checked toggles
//   .list-row-col / .list-subject   desk/_list.scss column insets and typography
//   .filterable[data-filter]        setup_filterable
//   [data-sort-by]                  setup_sort_by

/**
 * Right-alignment for the meta rail.
 *
 * NOT frappe's `.level-right`, which looks like the obvious choice: frappe pins
 * that class to `flex: 0 0 130px` whenever no row carries an assignment
 * (`.frappe-list .result.no-assign-to .list-row .level-right`). That is sizing
 * for its own flex rail and is meaningless inside a table cell — it left the
 * meta content 130px wide in a 315px column, floating with dead space beside
 * it. We only ever wanted the alignment, so we bring our own class.
 */
const META_CLASS = "cf-table__meta";

function add(node, ...names) {
	for (const n of names) if (n && !node.classList.contains(n)) node.classList.add(n);
}

export function listProfile() {
	return {
		root(node) {
			add(node, "list-carbon-table");
		},
		head(node) {
			// `setup_check_events` delegates the select-all through
			// `.list-header-subject .list-check-all`, and `on_row_checked`
			// toggles this element against the bulk-action overlay. The <thead>
			// plays that part now.
			// NOT `.level`: that is frappe's `display: flex` utility, and on a
			// <thead> it blockifies every <th> and collapses the table — the
			// same failure Bootstrap's `.row` caused on the Grid's <tr>.
			add(node, "list-row-head", "list-header-subject");
		},
		headerRow(node) {
			add(node, "list-row-container");
		},

		/**
		 * Reproduce frappe's per-column header classes exactly
		 * (`get_header_html`, list_view.js:767-775). These are not decoration:
		 * `.list-subject.level` is the FLEX CONTAINER that puts the select-all
		 * checkbox beside the column label. Without it the two stacked
		 * vertically and the label lost its left alignment with the body cells
		 * below — the ID column's header sat centred over left-aligned rows.
		 */
		headerCell(node, ctx) {
			const spec = ctx.host.getSpec(ctx.column);
			const col = spec && spec.meta && spec.meta.listCol;
			add(ctx.content, "list-row-col", "ellipsis");
			if (spec && spec.meta && spec.meta.listMeta) {
				add(ctx.content, "level", META_CLASS);
				return;
			}
			if (!col) return;
			if (col.type === "Subject") add(ctx.content, "list-subject", "level");
			else add(ctx.content, "hidden-xs");
			if (col.type === "Tag") add(ctx.content, "tag-col");
			if (window.frappe && frappe.model.is_numeric_field(col.df)) add(ctx.content, "text-right");
		},

		/**
		 * The meta rail's body cell needs the same box as its header.
		 *
		 * `list-row-col` matters as much as the flex classes: it is the class
		 * this app's stylesheet zeroes the inset on, and the header cell has it.
		 * Without it the body cell kept a 16px trailing inset the header did
		 * not, so the "liked by me" heart in the header sat 16px right of the
		 * hearts in the rows under it.
		 */
		cell(node, ctx) {
			const spec = ctx.host.getSpec(ctx.column);
			if (spec && spec.meta && spec.meta.listMeta) {
				add(ctx.content, "list-row-col", "level", META_CLASS);
			}
		},
		row(node) {
			// frappe nests `.list-row-container > .list-row`; one <tr> carries
			// both, and desk/_carbon-table.scss re-points the `:has()` selection
			// rule that assumed the nesting.
			// `.level` omitted for the same reason as on the <thead> above.
			add(node, "list-row-container", "list-row");
		},
		empty(node) {
			add(node, "no-result");
		},
	};
}
