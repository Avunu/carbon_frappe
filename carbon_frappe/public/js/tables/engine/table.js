// CarbonTable — the headless-TanStack + light-DOM-Carbon table engine.
//
// One engine sits behind all three frappe surfaces (child-table Grid, List view,
// Report/Query view). It owns: the TanStack instance and its state, the Carbon
// markup, column sizing/pinning/ordering, sorting, filtering, selection,
// expansion, the totals row, virtualization and the inline-filter row.
//
// It owns NOTHING frappe-specific. Everything that knows about docfields,
// docstatus, `frappe.format`, GridRow controls or the `dt-*` class contract
// lives in an adapter under ../{grid,list,datatable}/ and reaches the engine
// through two seams: a `columns` array whose `cell`/`header` may return DOM
// Nodes, and a `profile` of legacy-class hooks (see ./classes.js).
import { constructTable } from "@tanstack/table-core";
import { CARBON, ROW_SIZES, makeProfile, nearestRowSize, sizeClass } from "./classes";
import { buildFeatures } from "./features";
import { attr, el, raf, toggleClass } from "./dom";
import { sortIcon } from "./icons";
import TableRenderer from "./render";
import RowVirtualizer, { VIRTUAL_THRESHOLD } from "./virtual";

let INSTANCE_SEQ = 0;

const DEFAULTS = {
	columns: [],
	data: [],
	getRowId: null,
	getSubRows: null,
	rowHeight: 48,
	layout: "fixed",
	direction: "ltr",
	inlineFilters: false,
	showTotalRow: false,
	stickyHeader: true,
	selectable: false,
	// Emit Carbon's expandable-row contract: `cds--parent-row` +
	// `data-parent-row` on every body row, `cds--expandable-row` on the open
	// one, and the parent/child hover coupling Carbon's CSS cannot do alone.
	// Only meaningful together with `renderRowAddendum`, which supplies the
	// child <tr>.
	expandable: false,
	sortable: true,
	resizable: true,
	reorderable: false,
	virtualize: "auto",
	emptyMessage: "",
	// CSS length capping the scroll viewport. Virtualization can only window
	// rows when the viewport is SHORTER than the content; left unconstrained the
	// scroll box grows to fit every row and the virtualizer correctly decides it
	// has nothing to hide. Report views set this; the Grid sizes to content.
	scrollHeight: null,
	defaultColumnSize: 150,
	minColumnSize: 30,
	maxColumnSize: 2000,
	profile: null,
	events: null,
	// Adapters override these to take over content rendering entirely.
	renderCell: null,
	renderHeader: null,
	renderTotal: null,
	renderRowAddendum: null,
	createRowNode: null,
	createCellNode: null,
	createFilterCell: null,
	onRowAdopt: null,
	onRowRelease: null,
	// Called once, after mount, with the (empty) toolbar / footer regions the
	// renderer scaffolds. Both are `display: none` while empty, so an adapter
	// that ignores them pays nothing.
	renderToolbar: null,
	renderFooter: null,
};

export default class CarbonTable {
	constructor(container, options = {}) {
		if (typeof container === "string") container = document.querySelector(container);
		if (!container || !(container instanceof HTMLElement)) {
			throw new Error("CarbonTable: invalid container");
		}

		this.instanceId = ++INSTANCE_SEQ;
		this.scopeClass = `cf-table-instance-${this.instanceId}`;
		this.options = Object.assign({}, DEFAULTS, options);
		this.profile = makeProfile(this.options.profile);
		this.handlers = new Map();
		this.filtersVisible = !!this.options.inlineFilters;
		this.destroyed = false;

		if (this.options.events) {
			for (const name in this.options.events) this.on(name, this.options.events[name]);
		}

		this.renderer = new TableRenderer(this);
		this.virtualizer = new RowVirtualizer(this);
		this.scheduleRender = raf(() => this.render());

		this.buildTable();
		this.renderer.mount(container);
		if (this.options.scrollHeight) {
			this.renderer.scroll.style.maxHeight = this.options.scrollHeight;
		}
		container.classList.add(this.scopeClass);
		this.container = container;

		// Region hooks run after mount so an adapter can move its own nodes in
		// (the Grid relocates frappe's button DOM rather than rebuilding it) and
		// still hold live element references afterwards.
		this.fillRegion("renderToolbar", this.renderer.toolbar);
		this.fillRegion("renderFooter", this.renderer.footer);

		// @tanstack/store's subscribe() returns `{ unsubscribe }`, NOT a bare
		// teardown function. Both shapes are accepted here so a future store
		// version cannot turn destroy() into a TypeError.
		this._subscription = this.table.store.subscribe(() => this.scheduleRender());
		this.render();
	}

	// ------------------------------------------------------------ construction

	buildTable() {
		const o = this.options;
		this.features = buildFeatures();
		this.columnSpecs = o.columns.slice();

		const opts = {
			features: this.features,
			data: o.data,
			columns: this.columnSpecs.map((spec) => this.toColumnDef(spec)),
			defaultColumn: {
				size: o.defaultColumnSize,
				minSize: o.minColumnSize,
				maxSize: o.maxColumnSize,
			},
			columnResizeMode: "onChange",
			columnResizeDirection: o.direction === "rtl" ? "rtl" : "ltr",
			enableColumnResizing: o.resizable !== false,
			enableSorting: o.sortable !== false,
			// frappe-datatable sorts ASCENDING on the first click (its header
			// dropdown lists "Sort Ascending" first) and so does Carbon's
			// DataTable. TanStack would otherwise infer descending-first for
			// numeric columns, which reads as a regression on every report.
			sortDescFirst: false,
			enableRowSelection: !!o.selectable,
			enableSubRowSelection: false,
			manualPagination: true,
			initialState: this.initialState(),
		};
		if (o.getRowId) opts.getRowId = o.getRowId;
		if (o.getSubRows) opts.getSubRows = o.getSubRows;

		this.table = constructTable(opts);
	}

	initialState() {
		const o = this.options;
		const pinning = { start: [], end: [] };
		for (const spec of o.columns) {
			if (spec.pinned === "end" || spec.pinned === "right") pinning.end.push(spec.id);
			else if (spec.pinned) pinning.start.push(spec.id);
		}
		const visibility = {};
		for (const spec of o.columns) if (spec.hidden) visibility[spec.id] = false;
		return Object.assign(
			{ columnPinning: pinning, columnVisibility: visibility },
			o.initialState || {}
		);
	}

	/**
	 * Frappe-neutral column spec -> TanStack ColumnDef. `cell` and `header` are
	 * passed straight through: the engine's renderer accepts a string, a Node or
	 * a `{html|text|node}` object back from them, so an adapter can hand over a
	 * persistent element (the Grid does exactly that with its GridRow columns).
	 */
	toColumnDef(spec) {
		const def = {
			id: spec.id,
			header: spec.header !== undefined ? spec.header : spec.label,
			cell: spec.cell,
			enableSorting: spec.sortable !== false && this.options.sortable !== false,
			enableResizing: spec.resizable !== false && this.options.resizable !== false,
			enableColumnFilter: spec.filterable !== false,
			enableHiding: spec.hideable !== false,
			enablePinning: spec.pinnable !== false,
			filterFn: spec.filterFn || "frappe",
			sortFn: spec.sortFn || "frappe",
			meta: Object.assign({ spec }, spec.meta || {}),
		};
		if (spec.size != null) def.size = spec.size;
		if (spec.minSize != null) def.minSize = spec.minSize;
		if (spec.maxSize != null) def.maxSize = spec.maxSize;
		if (typeof spec.accessor === "function") def.accessorFn = spec.accessor;
		else def.accessorKey = spec.accessorKey || spec.id;
		return def;
	}

	// ------------------------------------------------------------------ events

	on(name, handler) {
		if (typeof handler !== "function") return this;
		if (!this.handlers.has(name)) this.handlers.set(name, []);
		this.handlers.get(name).push(handler);
		return this;
	}

	off(name, handler) {
		const list = this.handlers.get(name);
		if (!list) return this;
		const i = list.indexOf(handler);
		if (i >= 0) list.splice(i, 1);
		return this;
	}

	/**
	 * Fire an event. Handlers are called with `this` bound to the engine, which
	 * is what frappe-datatable does (`fireEvent` uses `handler.apply(this, args)`)
	 * and what report scripts written against it expect.
	 */
	emit(name, ...args) {
		const list = this.handlers.get(name);
		if (!list) return;
		for (const fn of list.slice()) {
			try {
				fn.apply(this, args);
			} catch (e) {
				console.error(`carbon_frappe: table event "${name}" handler failed`, e);
			}
		}
	}

	// ------------------------------------------------------------------- state

	/**
	 * Current state snapshot. v9 REMOVED `table.getState()`; the flat readonly
	 * store is the replacement (`migrate-v8-to-v9`: "Full current snapshot ->
	 * table.store.state"). Kept as one accessor so adapters never touch the
	 * store shape directly.
	 */
	get state() {
		return this.table.store.state;
	}

	/** The Carbon row size this table's requested `rowHeight` snaps to. */
	get rowSize() {
		return nearestRowSize(this.options.rowHeight);
	}

	get sizeClass() {
		return sizeClass(this.rowSize);
	}

	/**
	 * The row height actually used, in px.
	 *
	 * Carbon has exactly five row sizes and one hard rule — the header row must
	 * match the body row size — so an arbitrary request (frappe asks for 33 and
	 * 35) snaps to the nearest. Publishing it as a custom property rather than
	 * leaning on Carbon's own `tr { block-size }` is what keeps frappe's
	 * `.datatable .dt-row { height: 35px }` (0,2,0) from outranking it, and it
	 * keeps the class and the height from ever disagreeing.
	 */
	get rowHeightPx() {
		return ROW_SIZES[this.rowSize];
	}

	setData(data) {
		this.options.data = data || [];
		this.table.setOptions((prev) => Object.assign({}, prev, { data: this.options.data }));
		this.scheduleRender();
		return this;
	}

	setColumns(columns) {
		this.options.columns = columns || [];
		this.columnSpecs = this.options.columns.slice();
		this.table.setOptions((prev) =>
			Object.assign({}, prev, { columns: this.columnSpecs.map((s) => this.toColumnDef(s)) })
		);
		this.scheduleRender();
		return this;
	}

	refresh(data, columns) {
		if (columns) this.setColumns(columns);
		if (data) this.setData(data);
		this.render();
		return this;
	}

	getSpec(columnOrId) {
		const id = typeof columnOrId === "string" ? columnOrId : columnOrId && columnOrId.id;
		const column = this.table.getColumn(id);
		return column && column.columnDef.meta ? column.columnDef.meta.spec : null;
	}

	/**
	 * Set one column's width in px. v9 has no `column.setSize`; sizing is a
	 * single table-level state slice, which is also why the renderer can write
	 * every width to <colgroup> in one pass.
	 */
	setColumnSize(columnId, px) {
		this.table.setColumnSizing((prev) => Object.assign({}, prev, { [columnId]: px }));
		return this;
	}

	/** Current width of a column in px, honouring any active resize. */
	getColumnSize(columnId) {
		const column = this.table.getColumn(columnId);
		return column ? column.getSize() : null;
	}

	/** Invoke a region hook once; a failure must not take the table down. */
	fillRegion(name, node) {
		const fn = this.options[name];
		if (typeof fn !== "function" || !node) return;
		try {
			fn(node, this);
		} catch (e) {
			console.error(`carbon_frappe: table region hook "${name}" failed`, e);
		}
	}

	/**
	 * Expand exactly one row, or none. TanStack's expanded state is a
	 * `{rowId: true}` map; adapters get this accessor so they never reach into
	 * `table.store.state` (v9 removed `getState()`), and so "one row at a time"
	 * is expressed once rather than at every call site.
	 */
	setExpandedRow(rowId) {
		this.table.setExpanded(rowId == null ? {} : { [rowId]: true });
		return this;
	}

	toggleFilters(show) {
		this.filtersVisible = show === undefined ? !this.filtersVisible : !!show;
		if (!this.filtersVisible) this.table.resetColumnFilters();
		this.scheduleRender();
		return this.filtersVisible;
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.scheduleRender.cancel();
		const sub = this._subscription;
		if (typeof sub === "function") sub();
		else if (sub && typeof sub.unsubscribe === "function") sub.unsubscribe();
		this._subscription = null;
		this.virtualizer.teardown();
		this.renderer.destroy();
		if (this.container) this.container.classList.remove(this.scopeClass);
		this.emit("onDestroy");
		this.handlers.clear();
	}

	// ------------------------------------------------------- renderer host API

	render() {
		if (this.destroyed) return;
		const rows = this.table.getRowModel().rows;
		const rowHeight = this.rowHeightPx;
		if (this.container) this.container.style.setProperty("--cf-row-height", `${rowHeight}px`);
		this.virtualizer.sync(rows.length, rowHeight, this.renderer.scroll);
		toggleClass(this.renderer.table, CARBON.sortableTable, this.options.sortable !== false);
		// NOT `cds--data-table--sticky-header`. Carbon implements that by setting
		// `display: block` on the table and `display: flex` on thead/tbody/tr,
		// which abandons the table layout model altogether — <colgroup> widths
		// stop applying and the header row sizes itself independently of the
		// body (measured: 75px header cells over 150px body cells). Our sticky
		// header is `position: sticky` on the <th>s instead (see
		// `.cf-table__head--sticky` in desk/_carbon-table.scss), which keeps one
		// shared column model for thead, tbody and tfoot.
		this.renderer.render();
		this.emit("onRender");
	}

	/**
	 * Virtualize only when it pays AND when every row is the same height. An
	 * expanded row (Grid detail form, report tree child) breaks the fixed
	 * `estimateSize` contract, so we render everything rather than let the
	 * scrollbar drift out of step with the content.
	 */
	shouldVirtualize(count) {
		const mode = this.options.virtualize;
		if (mode === false) return false;
		if (this.hasVariableHeightRows()) return false;
		if (mode === true) return true;
		return count >= VIRTUAL_THRESHOLD;
	}

	hasVariableHeightRows() {
		if (typeof this.options.renderRowAddendum !== "function") return false;
		const expanded = this.state.expanded;
		if (!expanded) return false;
		if (expanded === true) return true;
		return Object.keys(expanded).some((k) => expanded[k]);
	}

	getRenderRows() {
		const rows = this.table.getRowModel().rows;
		const win = this.virtualizer.window(rows.length);
		return {
			rows: rows.slice(win.start, win.end),
			paddingTop: win.paddingTop,
			paddingBottom: win.paddingBottom,
		};
	}

	columnAlign(column) {
		const spec = this.getSpec(column);
		return (spec && spec.align) || "left";
	}

	columnLabel(column) {
		const spec = this.getSpec(column);
		if (spec && spec.label != null) return String(spec.label);
		const header = column.columnDef.header;
		return typeof header === "string" ? header : column.id;
	}

	columnFilterable(column) {
		const spec = this.getSpec(column);
		return !(spec && spec.filterable === false);
	}

	/**
	 * Write `result` into `target`, doing nothing when it has not changed.
	 * Accepts a Node (identity-preserved — this is what keeps a Grid cell's live
	 * control alive), an HTML string, or `{html|text|node}`.
	 */
	applyContent(entry, target, result) {
		if (result && result.nodeType) {
			if (entry.rendered !== result) {
				target.textContent = "";
				target.appendChild(result);
				entry.rendered = result;
			}
			return;
		}
		if (result && typeof result === "object") {
			if (result.node) return this.applyContent(entry, target, result.node);
			if (result.text != null) {
				const text = String(result.text);
				if (entry.rendered !== text) {
					target.textContent = text;
					entry.rendered = text;
				}
				return;
			}
			result = result.html;
		}
		const html = result == null ? "" : String(result);
		if (entry.rendered !== html) {
			target.innerHTML = html;
			entry.rendered = html;
		}
	}

	renderCellContent(cell, row, column, colIndex) {
		if (typeof this.options.renderCell === "function") {
			this.options.renderCell(cell, row, column, colIndex, this);
			return;
		}
		const def = column.columnDef;
		const ctx = {
			table: this.table,
			host: this,
			row,
			column,
			colIndex,
			getValue: () => row.getValue(column.id),
			value: row.getValue(column.id),
			cell: cell,
		};
		const out = typeof def.cell === "function" ? def.cell(ctx) : ctx.value;
		this.applyContent(cell, cell.content, out);
	}

	renderHeaderContent(entry, header, column, colIndex) {
		if (typeof this.options.renderHeader === "function") {
			this.options.renderHeader(entry, header, column, colIndex, this);
			return;
		}
		const label = this.columnLabel(column);
		const sortable = column.getCanSort && column.getCanSort();

		if (!sortable) {
			const def = column.columnDef.header;
			const out = typeof def === "function" ? def({ header, column, host: this }) : label;
			this.applyContent(entry, entry.content, out);
			entry.th.classList.remove(CARBON.sortHeaderCell);
			attr(entry.th, "aria-sort", null);
			return;
		}

		entry.th.classList.add(CARBON.sortHeaderCell);
		const direction = column.getIsSorted();
		attr(entry.th, "aria-sort", direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none");

		if (!entry.button) {
			entry.button = el("button", {
				className: CARBON.sortHeader,
				attrs: { type: "button" },
			});
			entry.flex = el("span", { className: CARBON.sortFlex });
			entry.labelNode = el("div", { className: CARBON.headerLabel });
			entry.iconNode = el("span", { className: "cf-table__sort-icon" });
			entry.flex.appendChild(entry.labelNode);
			entry.flex.appendChild(entry.iconNode);
			entry.button.appendChild(entry.flex);
			entry.content.appendChild(entry.button);
			entry.button.addEventListener("click", (e) => {
				const handler = column.getToggleSortingHandler();
				if (handler) handler(e);
				this.emit("onSortColumn", column);
			});
		}
		if (entry.labelNode.textContent !== label) entry.labelNode.textContent = label;
		toggleClass(entry.button, CARBON.sortActive, !!direction);
		toggleClass(entry.button, CARBON.sortDescending, direction === "desc");
		const iconHtml = sortIcon(direction);
		if (entry.iconHtml !== iconHtml) {
			entry.iconNode.innerHTML = iconHtml;
			entry.iconHtml = iconHtml;
		}
		this.wireResizeHandle(entry, header, column);
	}

	/** Carbon puts the resize affordance on the header cell's trailing edge. */
	wireResizeHandle(entry, header, column) {
		if (!header || !column.getCanResize || !column.getCanResize()) {
			if (entry.resizer) {
				entry.resizer.remove();
				entry.resizer = null;
			}
			return;
		}
		if (entry.resizer) return;
		const handle = el("span", {
			className: "cf-table__resize-handle",
			attrs: { role: "separator", "aria-orientation": "vertical" },
		});
		const start = header.getResizeHandler();
		// The shipped handler distinguishes touchstart from the mouse path, so
		// both must be bound; a lone pointerdown gives no working touch resize.
		handle.addEventListener("mousedown", start);
		handle.addEventListener("touchstart", start, { passive: true });
		handle.addEventListener("dblclick", () => column.resetSize());
		handle.addEventListener("click", (e) => e.stopPropagation());
		entry.th.appendChild(handle);
		entry.resizer = handle;
	}

	wireFilterInput(entry, column) {
		let timer = null;
		entry.input.addEventListener("input", () => {
			clearTimeout(timer);
			const value = entry.input.value;
			// 300ms matches frappe-datatable's inline-filter debounce, so typing
			// feels identical to what report users are used to.
			timer = setTimeout(() => {
				column.setFilterValue(value === "" ? undefined : value);
				this.emit("onFilterColumn", column, value);
			}, 300);
		});
		entry.input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				entry.input.value = "";
				column.setFilterValue(undefined);
			}
		});
	}

	renderTotalContent(entry, column, colIndex) {
		if (typeof this.options.renderTotal === "function") {
			this.options.renderTotal(entry, column, colIndex, this);
			return;
		}
		this.applyContent(entry, entry.content, "");
	}

	renderRowAddendum(row, leaf) {
		if (typeof this.options.renderRowAddendum === "function") {
			return this.options.renderRowAddendum(row, leaf, this);
		}
		return null;
	}

	/**
	 * Let an adapter supply the <tr>. Returning null keeps the engine's own.
	 * See render.js#renderRow for why this seam exists.
	 */
	createRowNode(row) {
		return typeof this.options.createRowNode === "function"
			? this.options.createRowNode(row, this)
			: null;
	}

	/** Let an adapter own a filter cell's contents. Truthy skips the default input. */
	createFilterCell(entry, column, colIndex) {
		return typeof this.options.createFilterCell === "function"
			? this.options.createFilterCell(entry, column, colIndex, this)
			: null;
	}

	/** Let an adapter supply the <td>. Returning null keeps the engine's own. */
	createCellNode(row, column, colIndex) {
		return typeof this.options.createCellNode === "function"
			? this.options.createCellNode(row, column, colIndex, this)
			: null;
	}

	adoptRow(row, entry) {
		if (typeof this.options.onRowAdopt === "function") this.options.onRowAdopt(row, entry, this);
	}

	releaseRow(rowId, entry) {
		if (typeof this.options.onRowRelease === "function")
			this.options.onRowRelease(rowId, entry, this);
	}

	// ------------------------------------------------------------------ lookup

	getRowNode(rowId) {
		return this.renderer.getRowNode(rowId);
	}

	getCellNode(rowId, colId) {
		return this.renderer.getCellNode(rowId, colId);
	}

	getHeaderNode(colId) {
		return this.renderer.getHeaderNode(colId);
	}

	scrollToRowIndex(index, opts) {
		this.virtualizer.scrollToIndex(index, opts);
	}

	get wrapper() {
		return this.container;
	}
}
