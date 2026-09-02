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
import { ensureChildRow } from "./expand";
import CarbonGridRow from "./grid_row";
import GridToolbar, { mountFooter } from "./toolbar";
import type { CarbonColumnSpec, CarbonTableOptions } from "../engine/table";
import type { Form, GridChildDoc, GridDataRow, GridDocField } from "frappe-types";

/**
 * The row shape the engine is instantiated at.
 *
 * `Grid#data` is `GridChildDoc[]`, so this is simply that element type given a
 * name — but it is the one type argument that makes `ctx.row.original.name`,
 * `getRowId` and `setData()` all agree, instead of each adapter callback
 * re-deriving the row shape from the engine's `Record<string, unknown>` default.
 */
type GridRowData = GridChildDoc;

/**
 * What a cell or header hands the engine: the element frappe already built, or
 * the empty string for "nothing here".
 *
 * `""` rather than `null` throughout because that is what the original returns
 * and what `CarbonTable#applyContent` treats as an empty `innerHTML` write; the
 * `undefined` arm is jQuery's — `.get(0)` on a handle frappe may not have filled.
 */
type GridNodeContent = HTMLElement | "" | undefined;

/**
 * frappe's own Bootstrap-span -> pixel table (grid_row.js:970-983), reused so a
 * DocType that has always declared `columns: 3` keeps the width it had.
 */
const SPAN_PX: Record<number, number> = {
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

/**
 * `{ frm }` when there is one, `{}` when there is not.
 *
 * `Grid#frm` is optional — a grid in a Dialog or a Web Form has none — and so is
 * `GridRowOptions#frm`, which under `exactOptionalPropertyTypes` means the key
 * may be ABSENT but may not be present-and-`undefined`. Spreading this is the
 * same instance shape the old `frm: this.frm` produced: `GridRow`'s constructor
 * merges its options with `$.extend`, which skips an `undefined` value outright
 * (jquery.js#extend), so neither spelling ever put an `frm` on the row.
 *
 * Exported because `./install` needs the identical shape for the identical
 * reason: `GridOptions#frm` is optional too, and `ControlTable#frm` is
 * `Form | undefined`.
 */
export function frmOption(frm: Form | undefined): { frm?: Form } {
	return frm ? { frm } : {};
}

/**
 * Is this the `<tr>` `CarbonGridRow#make` built?
 *
 * `wrapper` is a `JQueryRegion`, so `.get(0)` is guaranteed to be an element —
 * but jQuery cannot say WHICH element, and the engine's `createRowNode` seam
 * wants an `HTMLTableRowElement`. The tag test rather than `instanceof` for the
 * same reason `engine/table.ts` duck-types `Node`: element constructors are
 * per-document and frappe renders into iframes.
 */
function isTableRow(node: HTMLElement): node is HTMLTableRowElement {
	return node.tagName === "TR";
}

export default class CarbonGrid extends Grid {
	// ---------------------------------------------------- carbon's own members
	//
	// All `declare`: every one is assigned imperatively (from `make()`, from
	// `make_head()`, or by the engine calling back into `renderToolbar`), and a
	// real class field would be defined — as `undefined` — after `super()`
	// returns, blanking whatever had already been written. `declare` emits
	// nothing, which is the runtime shape this class has always had.

	/** The engine this grid renders through. Created by {@link CarbonGrid.make}. */
	declare carbon_table?: CarbonTable<GridRowData> | undefined;
	/** Publishes `--cf-panel-width`; see {@link CarbonGrid.observe_panel_width}. */
	declare _panel_observer?: ResizeObserver | undefined;
	/** The Carbon toolbar, built by the engine's `renderToolbar` region hook. */
	declare toolbar?: GridToolbar | undefined;
	/** Whether frappe's per-column filter row is showing. */
	declare search_open?: boolean | undefined;

	// ------------------------------------------- frappe's members, narrowed
	//
	// Every GridRow this grid creates is a CarbonGridRow (`make_head` and
	// `render_result_rows` are the only constructors, and both are overridden
	// here), so the four collections that hold them are narrowed to say so.
	// That is what lets the engine callbacks below reach `expand_node()`,
	// `menu_node()` and `form_row`, none of which exist on frappe's GridRow.

	/** @see Grid.header_row */
	declare header_row: CarbonGridRow;
	/** @see Grid.header_search */
	declare header_search: CarbonGridRow;
	/** Sparse outside the current page, exactly as frappe leaves it. @see Grid.grid_rows */
	declare grid_rows: Array<CarbonGridRow | undefined>;
	/** @see Grid.grid_rows_by_docname */
	declare grid_rows_by_docname: Record<string, CarbonGridRow>;

	override make(): void {
		super.make();
		// Replace the div scaffolding inside `.form-grid` with the engine. The
		// outer template (label, description, custom buttons, footer, pagination,
		// bulk actions) is frappe's and is left alone — every `data-action`
		// binding and every button handle set up by `super.make()` still works.
		this.form_grid.empty();
		this.carbon_table = new CarbonTable(this.form_grid.get(0), this.engine_options());
		this.observe_panel_width();
	}

	/**
	 * Publish the scroll viewport's width as `--cf-panel-width`.
	 *
	 * The expanded detail panel lives in a cell that spans every column, so it
	 * is as wide as the TABLE — which on a wide child table is wider than the
	 * screen. `_carbon-table.scss` sticks the panel's inner container to the
	 * viewport edge and sizes it from this property, so the form stays put while
	 * the columns scroll behind it. Same discipline as <colgroup>: measure in
	 * JS, write one explicit px value, let CSS consume it.
	 */
	observe_panel_width(): void {
		const scroll = this.carbon_table && this.carbon_table.renderer.scroll;
		if (!scroll || typeof ResizeObserver === "undefined") return;
		const write = (): void => {
			// Re-read through `this` rather than closing over the engine, so a
			// second `make()` retargets an already-running observer the way it
			// always did. The guard is what narrows it; `make()` assigns
			// `carbon_table` on the line before this observer is created and
			// never clears it, so the early return is unreachable.
			const table = this.carbon_table;
			if (!table) return;
			table.container.style.setProperty("--cf-panel-width", `${scroll.clientWidth}px`);
		};
		this._panel_observer = new ResizeObserver(write);
		this._panel_observer.observe(scroll);
		write();
	}

	engine_options(): CarbonTableOptions<GridRowData> {
		return {
			columns: [],
			data: [],
			getRowId: (doc) => doc.name,
			rowHeight: 40,
			profile: gridProfile(),
			sortable: false, // row order is the child table's `idx`, dragged not sorted
			resizable: true,
			// The filter row is always BUILT (CarbonGridRow#show_search_row);
			// the toolbar's magnifier owns whether it is SHOWN.
			inlineFilters: true,
			// Emit Carbon's `cds--parent-row` / `data-parent-row` contract, and
			// mirror child-row hover back onto the parent.
			expandable: true,
			renderToolbar: (node) => {
				this.toolbar = new GridToolbar(this, node);
			},
			renderFooter: (node) => mountFooter(this, node),
			// Rows carry live frappe controls, so the engine must never rebuild
			// them; CarbonGridRow owns the <tr> and every cell inside it.
			createRowNode: (row) => {
				const grid_row = this.grid_rows_by_docname[row.original.name];
				if (!grid_row || !grid_row.wrapper) return null;
				const node = grid_row.wrapper.get(0);
				return isTableRow(node) ? node : null;
			},
			// The detail panel rides in its own <tr> after the data row, and is
			// present for EVERY row whether open or not. Carbon collapses it
			// with CSS (`block-size: 0` + `max-block-size: 0`), which is both
			// what its adjacent-sibling selectors require and what makes the
			// open/close transition possible. Only the expensive part —
			// frappe's GridRowForm and its Layout — stays lazy.
			renderRowAddendum: (row, leaf) => {
				const grid_row = this.grid_rows_by_docname[row.original.name];
				if (!grid_row) return null;
				ensureChildRow(grid_row, leaf ? leaf.length : 0);
				return grid_row.form_row;
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
			// `_header` and `_colIndex` keep their positions — `host` is the
			// fifth argument — and take the underscore `noUnusedParameters`
			// asks of a parameter that exists only to hold a slot.
			renderHeader: (entry, _header, column, _colIndex, host) => {
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
	override setup_visible_columns(): void {
		if (this.visible_columns && this.visible_columns.length > 0) return;

		this.user_defined_columns = [];
		this.setup_user_defined_columns();
		const fields =
			this.user_defined_columns && this.user_defined_columns.length > 0
				? this.user_defined_columns
				: this.editable_fields || this.docfields;

		this.visible_columns = [];
		// `for…in` over an array, as upstream: the keys arrive as strings, so
		// the index has to be converted back before it can address the array.
		// `for…in` only yields keys the array actually has, so the miss branch
		// is unreachable — it is what `noUncheckedIndexedAccess` asks for.
		for (const ci in fields) {
			const _df = fields[Number(ci)];
			if (!_df) continue;
			const df =
				this.user_defined_columns && this.user_defined_columns.length > 0
					? _df
					: this.fields_map[_df.fieldname];

			if (
				df &&
				!df.hidden &&
				(this.editable_fields || df.in_list_view) &&
				// `df.permlevel` is optional. Passing `undefined` to
				// `get_perm` reached `this.perm[undefined]` and came back
				// `null`, so an absent permlevel already excluded the column;
				// the explicit test says that instead of relying on it.
				((this.frm &&
					df.permlevel !== undefined &&
					this.frm.get_perm(df.permlevel, "read")) ||
					!this.frm) &&
				!frappe.model.layout_fields.includes(df.fieldtype)
			) {
				// attach formatter on refresh (frappe does the same)
				if (
					df.fieldtype == "Link" &&
					!df.formatter &&
					df.parent &&
					frappe.meta.docfield_map[df.parent]
				) {
					// Read the parent's map into a local first: TypeScript only
					// carries a truthiness narrowing through an element access
					// whose key is a literal, and `df.parent` is a plain
					// `string`, so the guard above does not reach the lookup.
					const parent_map = frappe.meta.docfield_map[df.parent];
					const docfield = parent_map && parent_map[df.fieldname];
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
	column_width_for(df: GridDocField): number {
		let value = df.columns || df.colsize;
		if (!value) {
			this.update_default_colsize(df);
			value = df.colsize;
		}
		// `update_default_colsize` ends in an unconditional `df.colsize = colsize`
		// (grid.js:1383-1395), so `value` is a number on every path that gets
		// here; 140 is the same fallback an unrecognised span already takes.
		if (value === undefined) return 140;
		return value <= 12 ? SPAN_PX[value] || 140 : value;
	}

	/**
	 * Header and search rows are still GridRow instances — they own the
	 * Configure Columns dialog, the per-fieldtype search inputs and the
	 * `grid.filter` wiring — but they are never appended anywhere. The engine
	 * pulls their column nodes into <thead> instead.
	 */
	override make_head(): void {
		if (this.prevent_build) return;

		this.header_row = new CarbonGridRow({
			parent: $("<div></div>"),
			parent_df: this.df,
			docfields: this.docfields,
			...frmOption(this.frm),
			grid: this,
			configure_columns: true,
			header_row: true,
		});

		this.header_search = new CarbonGridRow({
			parent: $("<div></div>"),
			parent_df: this.df,
			docfields: this.docfields,
			...frmOption(this.frm),
			grid: this,
			show_search: true,
		});
		this.header_search.row && this.header_search.row.addClass("filter-row");

		// The filter row is always built; the toolbar's magnifier decides
		// whether it is shown. An active filter forces it open so a user can
		// always see — and clear — what is filtering the grid.
		if (this.filter_applied) this.search_open = true;
		const show_search = !!this.search_open;
		if (this.carbon_table) {
			this.carbon_table.options.inlineFilters = true;
			this.carbon_table.filtersVisible = show_search;
		}
		$(this.parent).find(".grid-heading-row").toggleClass("with-filter", show_search);

		// `make_head()` builds a NEW header row on every refresh, so the gear it
		// owns has to be re-adopted into the toolbar each time.
		this.toolbar && this.toolbar.sync();

		this.filter_applied && this.update_search_columns();
	}

	/** Show/hide frappe's per-column filter row. Driven by the toolbar magnifier. */
	toggle_search(show?: boolean | undefined): boolean {
		this.search_open = show === undefined ? !this.search_open : !!show;
		if (this.carbon_table) {
			this.carbon_table.filtersVisible = this.search_open;
			this.carbon_table.render();
		}
		$(this.parent).find(".grid-heading-row").toggleClass("with-filter", this.search_open);
		return this.search_open;
	}

	/**
	 * Carbon's batch-action bar is driven by the same debounced hook every
	 * checkbox change already funnels through (grid.js:362), so there is no new
	 * selection plumbing — only a second consumer of the existing signal.
	 */
	override refresh_remove_rows_button(): void {
		super.refresh_remove_rows_button();
		this.toolbar && this.toolbar.refreshBatch();
	}

	/**
	 * The batch bar's Cancel action: drop the whole selection.
	 *
	 * The tail mirrors what `setup_check`'s click handler does (grid.js:236-262)
	 * — unchecking boxes with `.prop()` fires no click, so without it the
	 * "Add row" button stays hidden (it is hidden while anything is selected)
	 * and the Delete/Edit/Duplicate labels keep their stale counts.
	 */
	clear_selection(): void {
		this.wrapper.find(".grid-row-check:checked").prop("checked", false);
		for (const row of this.grid_rows || []) {
			if (row && row.doc) row.doc.__checked = 0;
		}
		this.setup_toolbar();
		this.refresh_remove_rows_button();
		this.refresh_edit_rows_button();
		this.refresh_duplicate_rows_button();
	}

	header_node_for(columnId: string): GridNodeContent {
		const hr = this.header_row;
		if (!hr) return "";
		if (columnId === "_check") return hr.row_check ? hr.row_check.get(0) : "";
		if (columnId === "_index") return hr.row_index ? hr.row_index.get(0) : "";
		// Both gutters are blank in the header: there is no expand-all (this
		// grid opens one row at a time) and the Configure Columns gear has moved
		// to the Carbon toolbar, where Carbon puts table-level settings.
		if (columnId === "_expand" || columnId === "_menu") return "";
		const $col = hr.columns && hr.columns[columnId];
		return $col && $col.length ? $col.get(0) : "";
	}

	search_node_for(columnId: string): HTMLElement | null | undefined {
		const hs = this.header_search;
		if (!hs) return null;
		if (columnId === "_expand" || columnId === "_menu") return null;
		if (columnId === "_check") return hs.row_check ? hs.row_check.get(0) : null;
		if (columnId === "_index") return hs.row_index ? hs.row_index.get(0) : null;
		const $col = hs.search_columns && hs.search_columns[columnId];
		return $col && $col.length ? $col.get(0) : null;
	}

	/** Engine column specs derived from `visible_columns`, plus the gutters. */
	build_engine_columns(): CarbonColumnSpec<GridRowData>[] {
		const node_of = (
			rowOriginal: GridRowData,
			pick: (r: CarbonGridRow) => GridNodeContent
		): GridNodeContent => {
			const grid_row = this.grid_rows_by_docname[rowOriginal.name];
			return grid_row ? pick(grid_row) : "";
		};

		const columns: CarbonColumnSpec<GridRowData>[] = [
			{
				// Carbon orders the gutters expand-then-checkbox
				// (carbon-website data-table usage.mdx: "The expandable icon
				// always appears first and to the left of the selection icon").
				id: "_expand",
				label: "",
				size: 32,
				pinned: "start",
				sortable: false,
				filterable: false,
				resizable: false,
				align: "center",
				cell: (ctx) => node_of(ctx.row.original, (r) => r.expand_node()),
			},
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
			id: "_menu",
			label: "",
			size: 48,
			pinned: "end",
			sortable: false,
			filterable: false,
			resizable: false,
			align: "center",
			cell: (ctx) => node_of(ctx.row.original, (r) => r.menu_node()),
		});

		return columns;
	}

	/**
	 * Same identity-based row reconciliation as frappe's (match by `doc` object
	 * reference, refresh matches, drop stale, keep `grid_rows` sparse outside the
	 * current page), but the reconciled rows are handed to the engine as data
	 * rather than appended to a div.
	 */
	override render_result_rows($rows?: JQuery | undefined): void {
		const result_length = this.grid_pagination.get_result_length();
		const page_index = this.grid_pagination.page_index;
		const page_length = this.grid_pagination.page_length;
		const page_start = (page_index - 1) * page_length;
		if (!this.grid_rows) this.grid_rows = [];

		const rows_by_doc = new Map<GridRowData, CarbonGridRow>();
		for (const row of this.grid_rows) {
			if (row && row.doc) rows_by_doc.set(row.doc, row);
		}

		const page_docs: GridRowData[] = [];
		for (let ri = page_start; ri < result_length; ri++) {
			const d = this.data[ri];
			if (!d) break;
			// `Grid#data` is declared with `name` and `idx` REQUIRED, which is
			// true of a form-bound grid but not of a frm-less one: its rows come
			// from `df.data` as bare literals, and frappe's own grid.js:1058
			// pushes `{ idx, __islocal, ...defaults }` with no `name` at all.
			// That is exactly why these two backfills exist. Reading the same
			// object through frappe-types' `GridDataRow` — the shape whose
			// TSDoc documents this very guard — is what keeps them the checks
			// they have always been instead of a TS2367 "no overlap" error.
			const maybe: GridDataRow = d;
			if (maybe.idx === undefined) d.idx = ri + 1;
			if (maybe.name === undefined) d.name = this.get_random_name();

			let grid_row = rows_by_doc.get(d);
			if (grid_row) {
				grid_row.refresh();
			} else {
				grid_row = new CarbonGridRow({
					// `$rows` is optional on the base signature —
					// `GridPagination#go_to_page` calls this with no argument
					// (grid_pagination.js:153) — while `GridRowOptions#parent`
					// is required. Nothing here ever reads it: frappe's only
					// read is `this.wrapper.appendTo(this.parent)` in
					// `GridRow#make` (grid_row.js:53), and CarbonGridRow
					// replaces that method and appends nothing, because the
					// engine owns placement. An empty set is the same inert
					// value the missing argument was.
					parent: $rows ?? $(),
					parent_df: this.df,
					docfields: this.docfields,
					doc: d,
					...frmOption(this.frm),
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

	override reset_grid(): void {
		this.visible_columns = [];
		this.grid_rows = [];
		if (this.carbon_table) this.carbon_table.setData([]);
		this.refresh();
	}
}
