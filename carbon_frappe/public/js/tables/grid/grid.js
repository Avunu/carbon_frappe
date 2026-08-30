// CarbonGrid — frappe's child-table Grid, rendered by the Carbon table engine.
//
// WHAT CHANGES: the layout model. frappe lays a grid out on a Bootstrap
// 12-column grid, sizing each field with `col-xs-{1..12}` and refusing to go
// past a total span of 10 (grid.js:1357-1380), beyond which it latches
// `.column-limit-reached` and swaps in a hand-rolled horizontal-scroll hack with
// a px map duplicated in JS and SCSS. Here, columns get real pixel widths owned
// by TanStack's column-sizing feature, the table scrolls horizontally the way
// any table does, and `df.sticky` becomes real column pinning. There is no cap.
//
// WHAT DOES NOT CHANGE: everything else. This subclasses frappe's Grid and
// overrides only the four methods that produce or size DOM
// (`make`, `make_head`, `render_result_rows`, `setup_visible_columns`) plus
// `reset_grid`, which has to reach the engine. `refresh()` in particular is
// INHERITED — it finds `.rows` (the profile puts that class on our <tbody>),
// `.grid-empty` and `.form-grid-container` exactly where it expects them, and
// `make_sortable()` binds Sortable to the same element it always did.
//
// The ~60 `.grid.*` members app code calls (70 `update_docfield_property`,
// 51 `get_field`, 44 `refresh`, 35 `grid_rows`, ...) are therefore inherited
// implementations operating on new DOM, not reimplementations.
import Grid from "frappe/public/js/frappe/form/grid";
import CarbonTable from "../engine/table";
import { gridProfile } from "./classes";
import CarbonGridRow from "./grid_row";

/**
 * frappe's own Bootstrap-span -> pixel table (grid_row.js:970-983), reused so a
 * DocType that has always declared `columns: 3` keeps the width it had.
 */
const SPAN_PX = {
	1: 60,
	2: 100,
	3: 140,
	4: 200,
	5: 250,
	6: 300,
	7: 350,
	8: 400,
	9: 450,
	10: 500,
	11: 550,
	12: 600,
};

export default class CarbonGrid extends Grid {
	make() {
		super.make();
		// Replace the div scaffolding inside `.form-grid` with the engine. The
		// outer template (label, description, custom buttons, footer, pagination,
		// bulk actions) is frappe's and is left alone — every `data-action`
		// binding and every button handle set up by `super.make()` still works.
		this.form_grid.empty();
		this.carbon_table = new CarbonTable(this.form_grid.get(0), this.engine_options());
	}

	engine_options() {
		return {
			columns: [],
			data: [],
			getRowId: (doc) => doc.name,
			rowHeight: 40,
			profile: gridProfile(),
			sortable: false, // row order is the child table's `idx`, dragged not sorted
			resizable: true,
			inlineFilters: false,
			// Rows carry live frappe controls, so the engine must never rebuild
			// them; CarbonGridRow owns the <tr> and every cell inside it.
			createRowNode: (row) => {
				const grid_row = this.grid_rows_by_docname[row.original.name];
				return grid_row && grid_row.wrapper ? grid_row.wrapper.get(0) : null;
			},
			// The expanded detail form rides in its own <tr> after the data row.
			renderRowAddendum: (row) => {
				const grid_row = this.grid_rows_by_docname[row.original.name];
				if (!grid_row || !grid_row.form_row) return null;
				return grid_row.form_row.style.display === "none" ? null : grid_row.form_row;
			},
			// Grids are never virtualized: rows hold live frappe controls, an
			// open detail form makes row heights non-uniform, and
			// `grid_page_length` (50 by default) already bounds the row count.
			virtualize: false,
			createFilterCell: (entry, column) => {
				const node = this.search_node_for(column.id);
				if (!node) return null;
				entry.td.appendChild(node);
				return true;
			},
			renderHeader: (entry, header, column, colIndex, host) => {
				host.applyContent(entry, entry.content, this.header_node_for(column.id));
			},
		};
	}

	/**
	 * Pixel widths instead of Bootstrap spans, and no redistribution loop.
	 *
	 * Mirrors frappe's inclusion predicate exactly (hidden / in_list_view /
	 * permlevel / layout fields) and keeps the Link-formatter inheritance, so
	 * which columns appear is unchanged — only how wide they are.
	 */
	setup_visible_columns() {
		if (this.visible_columns && this.visible_columns.length > 0) return;

		this.user_defined_columns = [];
		this.setup_user_defined_columns();
		const fields =
			this.user_defined_columns && this.user_defined_columns.length > 0
				? this.user_defined_columns
				: this.editable_fields || this.docfields;

		this.visible_columns = [];
		for (const ci in fields) {
			const _df = fields[ci];
			const df =
				this.user_defined_columns && this.user_defined_columns.length > 0
					? _df
					: this.fields_map[_df.fieldname];

			if (
				df &&
				!df.hidden &&
				(this.editable_fields || df.in_list_view) &&
				((this.frm && this.frm.get_perm(df.permlevel, "read")) || !this.frm) &&
				!frappe.model.layout_fields.includes(df.fieldtype)
			) {
				// attach formatter on refresh (frappe does the same)
				if (
					df.fieldtype == "Link" &&
					!df.formatter &&
					df.parent &&
					frappe.meta.docfield_map[df.parent]
				) {
					const docfield = frappe.meta.docfield_map[df.parent][df.fieldname];
					if (docfield && docfield.formatter) df.formatter = docfield.formatter;
				}
				this.visible_columns.push([df, this.column_width_for(df)]);
			}
		}
	}

	/**
	 * A `columns` value of 1-12 is a legacy Bootstrap span and is translated
	 * through frappe's own px table; anything larger is already a pixel width
	 * (which is what Configure Columns now writes). This is what lets existing
	 * DocTypes and existing GridView user settings keep their widths.
	 */
	column_width_for(df) {
		let value = df.columns || df.colsize;
		if (!value) {
			this.update_default_colsize(df);
			value = df.colsize;
		}
		return value <= 12 ? SPAN_PX[value] || 140 : value;
	}

	/**
	 * Header and search rows are still GridRow instances — they own the
	 * Configure Columns dialog, the per-fieldtype search inputs and the
	 * `grid.filter` wiring — but they are never appended anywhere. The engine
	 * pulls their column nodes into <thead> instead.
	 */
	make_head() {
		if (this.prevent_build) return;

		this.header_row = new CarbonGridRow({
			parent: $("<div></div>"),
			parent_df: this.df,
			docfields: this.docfields,
			frm: this.frm,
			grid: this,
			configure_columns: true,
			header_row: true,
		});

		this.header_search = new CarbonGridRow({
			parent: $("<div></div>"),
			parent_df: this.df,
			docfields: this.docfields,
			frm: this.frm,
			grid: this,
			show_search: true,
		});
		this.header_search.row && this.header_search.row.addClass("filter-row");

		const show_search =
			this.header_search.show_search || !!this.header_search.show_search_row();
		if (this.carbon_table) {
			this.carbon_table.options.inlineFilters = show_search;
			this.carbon_table.filtersVisible = show_search;
		}
		$(this.parent).find(".grid-heading-row").toggleClass("with-filter", show_search);

		this.filter_applied && this.update_search_columns();
	}

	header_node_for(columnId) {
		const hr = this.header_row;
		if (!hr) return "";
		if (columnId === "_check") return hr.row_check ? hr.row_check.get(0) : "";
		if (columnId === "_index") return hr.row_index ? hr.row_index.get(0) : "";
		if (columnId === "_open") {
			// On the header the trailing cell is the Configure Columns gear.
			return hr.configure_columns_button ? hr.configure_columns_button.get(0) : "";
		}
		const $col = hr.columns && hr.columns[columnId];
		return $col && $col.length ? $col.get(0) : "";
	}

	search_node_for(columnId) {
		const hs = this.header_search;
		if (!hs) return null;
		if (columnId === "_check") return hs.row_check ? hs.row_check.get(0) : null;
		if (columnId === "_index") return hs.row_index ? hs.row_index.get(0) : null;
		const $col = hs.search_columns && hs.search_columns[columnId];
		return $col && $col.length ? $col.get(0) : null;
	}

	/** Engine column specs derived from `visible_columns`, plus the gutters. */
	build_engine_columns() {
		const node_of = (rowOriginal, pick) => {
			const grid_row = this.grid_rows_by_docname[rowOriginal.name];
			return grid_row ? pick(grid_row) : "";
		};

		const columns = [
			{
				id: "_check",
				label: "",
				size: 48,
				pinned: "start",
				sortable: false,
				filterable: false,
				resizable: false,
				cell: (ctx) => node_of(ctx.row.original, (r) => (r.row_check ? r.row_check.get(0) : "")),
			},
			{
				id: "_index",
				label: __("No.", null, "Title of the 'row number' column"),
				size: 64,
				pinned: "start",
				sortable: false,
				filterable: false,
				align: "center",
				cell: (ctx) => node_of(ctx.row.original, (r) => (r.row_index ? r.row_index.get(0) : "")),
			},
		];

		for (const [df, width] of this.visible_columns) {
			columns.push({
				id: df.fieldname,
				label: __(df.label, null, df.parent),
				size: width,
				align: ["Int", "Currency", "Float", "Percent"].includes(df.fieldtype)
					? "right"
					: df.fieldtype === "Check"
					? "center"
					: "left",
				sortable: false,
				filterable: true,
				pinned: df.sticky ? "start" : undefined,
				meta: { df },
				cell: (ctx) =>
					node_of(ctx.row.original, (r) => {
						const $col = r.columns && r.columns[df.fieldname];
						return $col && $col.length ? $col.get(0) : "";
					}),
			});
		}

		columns.push({
			id: "_open",
			label: "",
			size: 50,
			pinned: "end",
			sortable: false,
			filterable: false,
			resizable: false,
			cell: (ctx) =>
				node_of(ctx.row.original, (r) =>
					r.open_form_cell && r.open_form_cell.length ? r.open_form_cell.get(0) : ""
				),
		});

		return columns;
	}

	/**
	 * Same identity-based row reconciliation as frappe's (match by `doc` object
	 * reference, refresh matches, drop stale, keep `grid_rows` sparse outside the
	 * current page), but the reconciled rows are handed to the engine as data
	 * rather than appended to a div.
	 */
	render_result_rows($rows) {
		const result_length = this.grid_pagination.get_result_length();
		const page_index = this.grid_pagination.page_index;
		const page_length = this.grid_pagination.page_length;
		const page_start = (page_index - 1) * page_length;
		if (!this.grid_rows) this.grid_rows = [];

		const rows_by_doc = new Map();
		for (const row of this.grid_rows) {
			if (row && row.doc) rows_by_doc.set(row.doc, row);
		}

		const page_docs = [];
		for (let ri = page_start; ri < result_length; ri++) {
			const d = this.data[ri];
			if (!d) break;
			if (d.idx === undefined) d.idx = ri + 1;
			if (d.name === undefined) d.name = this.get_random_name();

			let grid_row = rows_by_doc.get(d);
			if (grid_row) {
				grid_row.refresh();
			} else {
				grid_row = new CarbonGridRow({
					parent: $rows,
					parent_df: this.df,
					docfields: this.docfields,
					doc: d,
					frm: this.frm,
					grid: this,
				});
			}
			this.grid_rows[ri] = grid_row;
			this.grid_rows_by_docname[d.name] = grid_row;
			page_docs.push(d);
		}

		// keep `grid_rows` sparse outside the page, as frappe does — app code
		// indexes it by ABSOLUTE row index and null-checks the gaps.
		for (let i = 0; i < this.grid_rows.length; i++) {
			if (i < page_start || i >= result_length) delete this.grid_rows[i];
		}
		if (this.grid_rows.length > this.data.length) this.grid_rows.length = this.data.length;

		if (this.carbon_table) {
			this.carbon_table.setColumns(this.build_engine_columns());
			this.carbon_table.setData(page_docs);
			this.carbon_table.render();
		}
	}

	reset_grid() {
		this.visible_columns = [];
		this.grid_rows = [];
		if (this.carbon_table) this.carbon_table.setData([]);
		this.refresh();
	}
}
