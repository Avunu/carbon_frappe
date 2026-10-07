// CarbonGrid — frappe's child-table Grid, rendered by the Carbon table engine.
//
// WHAT CHANGES: who lays the columns out. frappe 16.50 sizes every column in
// pixels itself (`Grid#get_column_width`, grid.js:1526-1538: a user's saved
// `df.width`, else a legacy `columns` span, else a fieldtype default, clamped to
// 60-600) and writes them inline on each cell as `flex: 1 0 Npx; width: Npx`
// (grid_row.js:910, 970), inside a `display: flex` row that scrolls sideways.
// Here the same widths seed TanStack's column-sizing feature, which owns them
// from then on: they live in a <colgroup>, the table scrolls horizontally the
// way any table does, and a header drag is the ENGINE's (`onColumnResize`),
// handed back to frappe's own `save_column_width` so it is persisted exactly
// where frappe persists it. (`df.sticky` is declared to the engine as column
// pinning, which is inert on a child table; see the README's "Known limits".)
//
// WHAT DOES NOT CHANGE: everything else, and in particular the width model.
// This subclasses frappe's Grid and overrides only the three methods that
// produce DOM (`make`, `make_head`, `render_result_rows`) plus
// `_teardown_column_layout`, which has to reach the engine. `setup_visible_columns`,
// `get_column_width` and `setup_user_defined_columns` are INHERITED, so a width
// frappe computes is a width this grid renders. `refresh()` in particular is
// INHERITED too — it finds `.rows` (the profile puts that class on our <tbody>),
// `.grid-empty` and `.form-grid-container` exactly where it expects them, and
// `make_sortable()` binds Sortable to the same element it always did.
//
// The ~60 `.grid.*` members app code calls (70 `update_docfield_property`,
// 51 `get_field`, 44 `refresh`, 35 `grid_rows`, ...) are therefore inherited
// implementations operating on new DOM, not reimplementations.
import Grid, { GRID_MAX_COLUMN_WIDTH, GRID_MIN_COLUMN_WIDTH } from "frappe/public/js/frappe/form/grid";
import CarbonTable, { isColumnResize } from "../engine/table.ts";
import { gridProfile } from "./classes.ts";
import { ensureChildRow } from "./expand.ts";
import CarbonGridRow from "./grid_row.ts";
import GridToolbar, { mountFooter } from "./toolbar.ts";
import type { CarbonColumnResize, CarbonColumnSpec, CarbonTableOptions } from "../engine/table.ts";
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
		this.close_dropdowns_on_scroll();
	}

	/**
	 * Close an open Link dropdown when the table scrolls sideways.
	 *
	 * frappe 16.50 does this on `.form-grid`'s own scroll (grid.js:182-192): a
	 * Link cell's dropdown is re-parented to `.grid-field` and absolutely
	 * positioned (grid_row.js:1003-1030), so it would otherwise stay where it was
	 * while its cell moved away. `.form-grid` is the engine's mount point now and
	 * never scrolls; the engine's scroll box does, and `scroll` does not bubble, so
	 * the listener has to be on that box.
	 */
	close_dropdowns_on_scroll(): void {
		const scroll = this.carbon_table && this.carbon_table.renderer.scroll;
		if (!scroll) return;
		scroll.addEventListener("scroll", () => {
			if (scroll.scrollLeft === 0) return;
			for (const row of this.grid_rows || []) {
				if (!row) continue;
				for (const field of row.on_grid_fields) {
					if (field.df.fieldtype === "Link" && field.awesomplete) field.awesomplete.close();
				}
			}
		});
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
			// frappe persists a dragged width through `save_column_width`, which
			// stock frappe's own handle calls on mouseup (grid.js:548-633). That
			// handle is not running here (see `make_head`), so the engine's drag
			// reports its settled width and this hands it over.
			events: {
				onColumnResize: (...args) => {
					const [detail] = args;
					if (isColumnResize(detail)) this.persist_column_width(detail);
				},
			},
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
	 * Persist a column width the engine settled on, the way frappe's own drag does.
	 *
	 * `save_column_width` (grid.js:597-633) is what stock frappe's mouseup handler
	 * calls: it records `df.width` and `visible_columns[n][1]` (so rows built later
	 * start at the new width), re-derives the sticky offsets, and writes the whole
	 * layout to the per-user `GridView` setting (the same record Configure Columns
	 * writes, which is also what `setup_user_defined_columns` reads back). It does
	 * nothing without a `frm`, so a grid in a dialog or Web Form keeps the width
	 * for the session only, exactly as stock frappe does.
	 *
	 * Only a column this grid is showing is a candidate: the gutters are not
	 * resizable, but the guard is what keeps an unknown id from ever reaching the
	 * saved layout.
	 */
	persist_column_width({ columnId, width }: CarbonColumnResize): void {
		const shown = (this.visible_columns || []).some(([df]) => df.fieldname === columnId);
		if (!shown) return;
		this.save_column_width(columnId, this.clamp_column_width(width));
	}

	/**
	 * Header and search rows are still GridRow instances — they own the
	 * Configure Columns dialog, the per-fieldtype search inputs and the
	 * `grid.filter` wiring — but they are never appended anywhere. The engine
	 * pulls their column nodes into <thead> instead.
	 *
	 * Upstream's `make_head` ends with `setup_column_resize()` (grid.js:545), the
	 * drag handler behind each header's `.grid-col-resize-handle`. It is skipped
	 * on purpose, not forgotten: it resizes the cell's inline `width`, which in a
	 * table is the engine's <colgroup>'s business, so it would drag a handle that
	 * moves nothing. The engine draws its own handle on the <th> and reports the
	 * drag as `onColumnResize` (see `engine_options`); the stale one is hidden in
	 * `_carbon-table.scss`.
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
		this.header_search.row?.addClass("filter-row");

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
		this.toolbar?.sync();

		if (this.filter_applied) this.update_search_columns();
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
	 * checkbox change already funnels through (grid.js:327, 474), so there is no
	 * new selection plumbing — only a second consumer of the existing signal.
	 */
	override refresh_remove_rows_button(): void {
		super.refresh_remove_rows_button();
		this.toolbar?.refreshBatch();
	}

	/**
	 * The batch bar's Cancel action: drop the whole selection.
	 *
	 * The tail mirrors what `setup_check`'s click handler does (grid.js:263-337)
	 * — unchecking boxes with `.prop()` fires no click, so without it the
	 * "Add row" button stays hidden (it is hidden while anything is selected)
	 * and the Delete/Edit/Duplicate buttons stay shown.
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

	/**
	 * `visible_columns`, rebuilt first if it is unset.
	 *
	 * frappe builds it lazily and only ever through a row: `GridRow#setup_columns`
	 * calls `setup_visible_columns()` (grid_row.js:722), and the header row is
	 * always rendered before the body (grid.js:680 → 691), so upstream can read
	 * the field unguarded from a body row. `FrappeForm#switch_doc` breaks that
	 * order: it sets `visible_columns = null` on every grid and immediately
	 * re-renders the body through `go_to_page(1, true)` (form.js:580-585),
	 * which ends in `render_result_rows`, before `refresh()` rebuilds the head.
	 * Upstream survives because the rows being refreshed rebuild the columns,
	 * and a grid with no rows reads nothing. This grid reads the field directly
	 * to derive the engine's columns BEFORE any row exists, so the rebuild has
	 * to be here — otherwise a child table that was empty on the previous
	 * document dies with "TypeError: this.visible_columns is not iterable"
	 * mid-`refresh()` and the form never switches (the header keeps the old
	 * title, the fields keep the old values).
	 *
	 * Note the timing still matches stock: at this instant `frm.doc` is the OLD
	 * document (`switch_doc` swaps `docname` last), so the freshly built column
	 * set uses the old doc's permlevel visibility — exactly when stock's first
	 * row render builds its `columns_list` too.
	 */
	visible_columns_or_build(): Array<[GridDocField, number]> {
		this.setup_visible_columns();
		const visible = this.visible_columns;
		if (!visible) throw new Error("carbon_frappe: setup_visible_columns() left visible_columns unset");
		return visible;
	}

	/** Engine column specs derived from `visible_columns`, plus the gutters. */
	build_engine_columns(): CarbonColumnSpec<GridRowData>[] {
		const node_of = (
			rowOriginal: GridRowData,
			pick: (r: CarbonGridRow) => GridNodeContent,
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
				// Carbon's expand column at the md row size (`td.cds--table-expand`:
				// 2.5rem, of which 0.5rem is leading padding, and the 16px chevron
				// button's own padding takes the rest). Any narrower and the glyph is
				// squeezed to fit what is left. The columns' widths are exact now, so
				// this number is what is drawn; it used to be stretched past it.
				size: 40,
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
				// A gutter, like the three around it: frappe gives the row number a
				// fixed column and only DATA columns a resize handle (grid_row.js:1068-1070),
				// and a width dragged here would have nowhere to be saved.
				resizable: false,
				align: "center",
				cell: (ctx) => node_of(ctx.row.original, (r) => (r.row_index ? r.row_index.get(0) : "")),
			},
		];

		const visible = this.visible_columns_or_build();
		visible.forEach(([df, width], i) => {
			columns.push({
				id: df.fieldname,
				label: __(df.label, null, df.parent),
				// `width` is frappe's own, already clamped, pixel width for the column
				// (`get_column_width`); the drag is held to the same 60-600 range
				// `clamp_column_width` enforces on what gets saved.
				size: width,
				minSize: GRID_MIN_COLUMN_WIDTH,
				maxSize: GRID_MAX_COLUMN_WIDTH,
				align: ["Int", "Currency", "Float", "Percent"].includes(df.fieldtype)
					? "right"
					: df.fieldtype === "Check"
						? "center"
						: "left",
				sortable: false,
				filterable: true,
				pinned: df.sticky ? "start" : undefined,
				// frappe's `.grid-data-last` (grid_row.js:766-768): the last data
				// column takes whatever width the others leave, so a short grid
				// fills its container without any one column being stretched past
				// the width it was given.
				fill: i === visible.length - 1,
				meta: { df },
				cell: (ctx) =>
					node_of(ctx.row.original, (r) => {
						const $col = r.columns && r.columns[df.fieldname];
						return $col && $col.length ? $col.get(0) : "";
					}),
			});
		});

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
		if (!this.grid_rows) return;

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
			// from `df.data` as bare literals, and frappe's own grid.js:1211
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
					// (grid_pagination.js:167) — while `GridRowOptions#parent`
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

	/**
	 * Throw the cached column layout away, without pulling nodes out from under the
	 * engine.
	 *
	 * Upstream (grid.js:500-504) also does
	 * `$(".grid-body .grid-row").remove()`. Those are this table's own <tr>s now,
	 * and removing them behind the renderer would leave it holding detached nodes
	 * it believes are in the table. The engine is handed an empty data set instead
	 * and releases them itself. `reset_grid()` (Configure Columns) and
	 * `set_column_disp()` (a script hiding a column) both go through here, so
	 * overriding this one covers both.
	 *
	 * The next layout is rebuilt from `visible_columns`, i.e. from the user's saved
	 * widths, so a width dragged under the old layout is forgotten rather than left
	 * to outrank the new one (`resetColumnSizes`).
	 */
	override _teardown_column_layout(): void {
		this.visible_columns = [];
		this.grid_rows = [];
		if (this.carbon_table) {
			this.carbon_table.setData([]);
			this.carbon_table.resetColumnSizes();
		}
	}
}
