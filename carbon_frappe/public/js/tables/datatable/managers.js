// frappe-datatable sub-manager shims.
//
// Swapping the constructor is the easy half. The hard half is that frappe,
// ERPNext, HRMS and app reports reach PAST the public API into
// `datatable.datamanager`, `.rowmanager`, `.columnmanager`, `.cellmanager`,
// `.bodyRenderer` and `.style` in ~20 places — `rowmanager.getCheckedRows()`
// alone has 13 call sites. Those are not documented API, but they are load-
// bearing, so each shim below reproduces the shape and the semantics of the
// member that is actually used, and says which caller depends on it.
//
// The one structural mismatch to keep in mind: frappe-datatable addresses
// everything by INTEGER (colIndex, rowIndex) and a `rowViewOrder` permutation,
// while TanStack addresses by STRING row.id / column.id. The host keeps both and
// these shims translate; `rowIndex` always means the row's position in the
// ORIGINAL data array and is stable across sorting and filtering, exactly as
// upstream's is.

/** frappe-datatable's per-cell defaults (datamanager.js `prepareHeader`). */
export const BASE_CELL = {
	isHeader: 0,
	editable: true,
	sortable: true,
	resizable: true,
	focusable: true,
	dropdown: true,
	width: null,
};

/**
 * jQuery wrapper for the `*$` accessors frappe calls. Guarded because the engine
 * and these shims are also exercised by scripts/dev-table.mjs, which runs
 * outside a desk and therefore has no jQuery.
 */
export function $of(node) {
	const jq = typeof window !== "undefined" && window.$;
	if (!jq) return node ? [node] : [];
	return node ? jq(node) : jq();
}

/** Original-data index of a TanStack row, tree-safe. */
export function rowIndexOf(row) {
	const original = row && row.original;
	if (original && original.meta && original.meta.rowIndex != null) return original.meta.rowIndex;
	return row ? row.index : -1;
}

// ---------------------------------------------------------------- DataManager

export class DataManagerShim {
	constructor(host) {
		this.host = host;
		this.options = host.options;
	}

	get data() {
		return this.host.data;
	}
	get rows() {
		return this.host.rows;
	}
	get columns() {
		return this.host.columns;
	}
	get rowCount() {
		return this.host.rows.length;
	}
	/** Display order as original-data indices — upstream's `rowViewOrder`. */
	get rowViewOrder() {
		return this.host.engine.table.getRowModel().rows.map(rowIndexOf);
	}
	get currentSort() {
		const sorting = this.host.engine.state.sorting || [];
		if (!sorting.length) return { colIndex: -1, sortOrder: "none" };
		const colIndex = this.getColumnIndexById(sorting[0].id);
		return { colIndex, sortOrder: sorting[0].desc ? "desc" : "asc" };
	}

	getRow(rowIndex) {
		return this.host.rows[rowIndex];
	}
	/** The ORIGINAL row object — what report scripts read (`data.row_type`). */
	getData(rowIndex) {
		return this.host.data[rowIndex];
	}
	getCell(colIndex, rowIndex) {
		const row = this.host.rows[rowIndex];
		return row ? row[colIndex] : undefined;
	}
	getRows(start, end) {
		return this.host.rows.slice(start, end);
	}
	getRowCount() {
		return this.host.rows.length;
	}
	getColumn(colIndex) {
		if (colIndex < 0) colIndex = this.host.columns.length + colIndex;
		return this.host.columns[colIndex];
	}
	getColumnById(id) {
		return this.host.columns.find((c) => c.id === id);
	}
	getColumnIndexById(id) {
		return this.host.columns.findIndex((c) => c.id === id);
	}
	getColumnIndex(name) {
		return this.host.columns.findIndex((c) => c.name === name);
	}
	hasColumn(name) {
		return this.getColumnIndex(name) !== -1;
	}
	hasColumnById(id) {
		return this.getColumnIndexById(id) !== -1;
	}
	/** Count of auto-injected `_checkbox` / `_rowIndex` columns. */
	getStandardColumnCount() {
		return this.host.standardColumnCount;
	}
	getColumnCount(skipStandardColumns) {
		return this.host.columns.length - (skipStandardColumns ? this.getStandardColumnCount() : 0);
	}
	/** `report_view.get_column_widths()` calls this with `true`. */
	getColumns(skipStandardColumns) {
		return skipStandardColumns
			? this.host.columns.slice(this.getStandardColumnCount())
			: this.host.columns;
	}
	getFilteredRowIndices() {
		return this.host.engine.table.getRowModel().rows.map(rowIndexOf);
	}
	getAllRowIndices() {
		return this.host.rows.map((_, i) => i);
	}
	getChildren(parentRowIndex) {
		return this.host.getDescendants(parentRowIndex);
	}
	getImmediateChildren(parentRowIndex) {
		return this.host.getDescendants(parentRowIndex, true);
	}
	get() {
		return { columns: this.host.columns, rows: this.host.rows };
	}

	updateRow(row, rowIndex) {
		return this.host.updateRow(row, rowIndex);
	}
	updateCell(colIndex, rowIndex, options) {
		return this.host.updateCell(colIndex, rowIndex, options);
	}
	updateColumn(colIndex, keyValPairs) {
		Object.assign(this.host.columns[colIndex], keyValPairs);
		this.host.rebuildColumns();
	}
	appendRows(rows) {
		return this.host.appendRows(rows);
	}
	filterRows(filters) {
		return this.host.applyFilters(filters);
	}
	sortRows(colIndex, sortOrder) {
		return this.host.sortColumn(colIndex, sortOrder);
	}
	switchColumn(a, b) {
		return this.host.switchColumn(a, b);
	}
	removeColumn(colIndex) {
		return this.host.removeColumn(colIndex);
	}
}

// ----------------------------------------------------------------- RowManager

export class RowManagerShim {
	constructor(host) {
		this.host = host;
		// Sparse array of 0|1 indexed by rowIndex. ERPNext's
		// bank_reconciliation dialog_manager assigns to it directly
		// (`this.datatable.rowmanager.checkMap = []`), so it must stay a plain
		// array on the instance, not a getter.
		this.checkMap = [];
	}

	get datamanager() {
		return this.host.datamanager;
	}

	/**
	 * Indices of checked rows. 13 call sites — ERPNext stock reports,
	 * bank reconciliation, HRMS, and avunu's timesheet_review.
	 */
	getCheckedRows() {
		return this.checkMap.reduce((acc, val, i) => {
			if (val) acc.push(i);
			return acc;
		}, []);
	}

	checkRow(rowIndex, toggle) {
		this.checkMap[rowIndex] = toggle ? 1 : 0;
		this.host.syncSelectionToEngine();
		this.host.fireEvent("onCheckRow", this.host.datamanager.getRow(rowIndex));
	}

	checkAll(toggle) {
		if (toggle) {
			for (const row of this.host.engine.table.getRowModel().rows) {
				this.checkMap[rowIndexOf(row)] = 1;
			}
		} else {
			this.checkMap = [];
		}
		this.host.syncSelectionToEngine();
		this.host.fireEvent("onCheckRow");
	}

	highlightCheckedRows() {
		this.host.engine.scheduleRender();
	}
	highlightRow(rowIndex, toggle = true) {
		this.host.highlighted[rowIndex] = toggle;
		this.host.engine.scheduleRender();
	}
	highlightAll(toggle = true) {
		this.host.highlightAll = toggle;
		this.host.engine.scheduleRender();
	}
	refreshRows() {
		this.host.engine.render();
	}
	refreshRow(row, rowIndex) {
		return this.host.refreshRow(row, rowIndex);
	}
	showRows(rowIndices) {
		this.host.visibleOverride = rowIndices;
		this.host.engine.scheduleRender();
	}
	showAllRows() {
		this.host.visibleOverride = null;
		this.host.engine.scheduleRender();
	}

	openSingleNode(rowIndex) {
		this.host.setExpanded(rowIndex, true);
	}
	closeSingleNode(rowIndex) {
		this.host.setExpanded(rowIndex, false);
	}
	expandAllNodes() {
		this.host.engine.table.toggleAllRowsExpanded(true);
	}
	collapseAllNodes() {
		this.host.engine.table.toggleAllRowsExpanded(false);
	}
	/** `query_report.js` calls this with `report_settings.initial_depth`. */
	setTreeDepth(depth) {
		this.host.setTreeDepth(depth);
	}

	getRow$(rowIndex) {
		const node = this.host.engine.getRowNode(this.host.rowIdFor(rowIndex));
		return $of(node);
	}
	getTotalRows() {
		return this.host.rows.length;
	}
	getFirstRowIndex() {
		return 0;
	}
	getLastRowIndex() {
		return this.host.rows.length - 1;
	}
	scrollToRow(rowIndex) {
		this.host.scrollToRow(rowIndex);
	}
	selector(rowIndex) {
		return `.dt-row-${rowIndex}`;
	}
}

// -------------------------------------------------------------- ColumnManager

export class ColumnManagerShim {
	constructor(host) {
		this.host = host;
		this.isFilterShown = !!host.options.inlineFilters;
	}

	get sortState() {
		return this.host.datamanager.currentSort;
	}
	get sortingKey() {
		return this.host.options.sortingKey;
	}

	/** `report_view.js` reads this to persist inline filters. */
	getAppliedFilters() {
		const out = {};
		for (const f of this.host.engine.state.columnFilters || []) {
			const colIndex = this.host.datamanager.getColumnIndexById(f.id);
			if (colIndex !== -1 && f.value != null && f.value !== "") out[colIndex] = f.value;
		}
		return out;
	}
	applyFilter(filters) {
		return this.host.applyFilters(filters);
	}
	toggleFilter(flag) {
		this.isFilterShown = this.host.engine.toggleFilters(flag);
		return this.isFilterShown;
	}
	focusFilter(colIndex) {
		const column = this.host.engineColumnId(colIndex);
		const input = this.host.container.querySelector(`.dt-filter[data-col-index="${colIndex}"]`);
		if (input) input.focus();
		return column;
	}

	getColumn(colIndex) {
		return this.host.datamanager.getColumn(colIndex);
	}
	getColumns() {
		return this.host.columns;
	}
	setColumnWidth(colIndex, width) {
		const id = this.host.engineColumnId(colIndex);
		if (id) this.host.engine.setColumnSize(id, width);
	}
	getColumnMinWidth(colIndex) {
		const col = this.host.datamanager.getColumn(colIndex);
		return (col && col.minWidth) || this.host.options.minimumColumnWidth;
	}
	getFirstColumnIndex() {
		return this.host.standardColumnCount;
	}
	getLastColumnIndex() {
		return this.host.columns.length - 1;
	}
	getHeaderCell$(colIndex) {
		const node = this.host.engine.getHeaderNode(this.host.engineColumnId(colIndex));
		return $of(node);
	}
	sortColumn(colIndex, order) {
		return this.host.sortColumn(colIndex, order);
	}
	setColumnSticky(colIndex, sticky) {
		return this.host.setColumnSticky(colIndex, sticky);
	}
	switchColumn(a, b) {
		return this.host.switchColumn(a, b);
	}
	removeColumn(colIndex) {
		return this.host.removeColumn(colIndex);
	}
	refreshHeader() {
		this.host.engine.scheduleRender();
	}
	renderHeader() {
		this.host.engine.scheduleRender();
	}
}

// ---------------------------------------------------------------- CellManager

export class CellManagerShim {
	constructor(host) {
		this.host = host;
		this.currentCellEditor = null;
	}

	/** Live views onto the real state, so callers never read a stale copy. */
	get $focusedCell() {
		const nav = this.host.navigation;
		if (!nav || !nav.focused) return null;
		return this.host.engine.getCellNode(
			this.host.rowIdFor(nav.focused.rowIndex),
			this.host.engineColumnId(nav.focused.colIndex)
		);
	}

	get $editingCell() {
		return this.host.editing.$editingCell;
	}

	get $selectionCursor() {
		const nav = this.host.navigation;
		if (!nav || !nav.cursor) return null;
		return this.host.engine.getCellNode(
			this.host.rowIdFor(nav.cursor.rowIndex),
			this.host.engineColumnId(nav.cursor.colIndex)
		);
	}

	/** `report_view.js:render_editing_input` calls this before opening a dialog. */
	deactivateEditing(submitValue = true) {
		return this.host.editing.deactivate(submitValue);
	}
	activateEditing($cell) {
		return this.host.editing.activate($cell);
	}
	submitEditing() {
		return this.host.editing.submit();
	}
	focusCell($cell) {
		const node = $cell && $cell.nodeType ? $cell : $cell && $cell[0];
		if (!node) return false;
		return this.host.navigation.focus(
			Number(node.getAttribute("data-col-index")),
			Number(node.getAttribute("data-row-index"))
		);
	}
	unfocusCell() {
		this.host.navigation.focused = null;
		this.host.navigation.cursor = null;
		this.host.navigation.render();
	}
	getSelectionCursor() {
		return this.$selectionCursor;
	}
	clearSelection() {
		this.unfocusCell();
	}
	getCellsInRange() {
		const b = this.host.navigation.bounds();
		if (!b) return false;
		const order = this.host.navigation.viewOrder;
		const out = [];
		for (let p = b.p1; p <= b.p2; p++) {
			for (let c = b.c1; c <= b.c2; c++) out.push([c, order[p]]);
		}
		return out;
	}
	copyCellContents() {
		return this.host.navigation.copy();
	}
	updateCell(colIndex, rowIndex, value, refreshHtml) {
		return this.host.updateCell(colIndex, rowIndex, { content: value }, refreshHtml);
	}
	getCell$(colIndex, rowIndex) {
		const node = this.host.engine.getCellNode(
			this.host.rowIdFor(rowIndex),
			this.host.engineColumnId(colIndex)
		);
		return $of(node);
	}
	getCell(colIndex, rowIndex) {
		return this.host.datamanager.getCell(colIndex, rowIndex);
	}
	isStandardCell(colIndex) {
		return colIndex < this.host.standardColumnCount;
	}
	selector(colIndex, rowIndex) {
		return `.dt-cell--${colIndex}-${rowIndex}`;
	}
	getRowHeight() {
		return this.host.options.cellHeight;
	}
	scrollToCell($cell) {
		if ($cell && $cell.scrollIntoView) $cell.scrollIntoView({ block: "nearest" });
	}
}

// --------------------------------------------------------------- BodyRenderer

export class BodyRendererShim {
	constructor(host) {
		this.host = host;
	}
	/** Rows currently in the DOM window — ERPNext reads `.includes(rowIndex)`. */
	get visibleRowIndices() {
		return this.host.engine.getRenderRows().rows.map(rowIndexOf);
	}
	get visibleRows() {
		return this.host.engine
			.getRenderRows()
			.rows.map((r) => this.host.rows[rowIndexOf(r)]);
	}
	/** `query_report.js` reads the computed totals row back out. */
	getTotalRow() {
		return this.host.getTotalRow();
	}
	render() {
		this.host.engine.render();
	}
	renderRows() {
		this.host.engine.render();
	}
	showToastMessage(message, hideAfter) {
		this.host.showToastMessage(message, hideAfter);
	}
	clearToastMessage() {
		this.host.clearToastMessage();
	}
}

// ---------------------------------------------------------------------- Style

export class StyleShim {
	constructor(host) {
		this.host = host;
		this.scopeClass = host.scopeClass;
		this._rules = new Map();
		this._el = document.createElement("style");
		this._el.setAttribute("data-carbon-table-style", this.scopeClass);
		document.head.appendChild(this._el);
	}

	get stylesheet() {
		return this._el.sheet;
	}

	/**
	 * `setStyle(".dt-cell--0-3", {backgroundColor: "..."})`.
	 *
	 * Rules are scoped with the instance class exactly as frappe-datatable does,
	 * so two tables on one page cannot bleed into each other. camelCase property
	 * names are accepted because every existing caller writes them that way
	 * (`backgroundColor`, `fontWeight`, `"margin-left"` both appear in ERPNext).
	 */
	setStyle(selector, styleObject) {
		const scoped = selector
			.split(",")
			.map((s) => `.${this.scopeClass} ${s.trim()}`)
			.join(", ");
		const body = Object.keys(styleObject)
			.map((k) => {
				const prop = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
				const value = styleObject[k];
				return value === "" || value == null ? "" : `${prop}: ${value};`;
			})
			.filter(Boolean)
			.join(" ");
		this._rules.set(scoped, body);
		this.flush();
	}

	removeStyle(selector) {
		const scoped = `.${this.scopeClass} ${selector}`;
		this._rules.delete(scoped);
		this.flush();
	}

	flush() {
		let css = "";
		for (const [sel, body] of this._rules) if (body) css += `${sel} { ${body} }\n`;
		this._el.textContent = css;
	}

	setCellHeight(height) {
		this.host.options.cellHeight = height;
		this.host.engine.options.rowHeight = height;
		this.host.engine.scheduleRender();
	}
	setDimensions() {
		this.host.engine.scheduleRender();
	}
	refreshColumnWidth() {
		this.host.engine.scheduleRender();
	}
	getColumnHeaderElement(colIndex) {
		return this.host.engine.getHeaderNode(this.host.engineColumnId(colIndex));
	}
	destroy() {
		this._rules.clear();
		if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
	}
}

// ------------------------------------------------------------------- Keyboard

export class KeyboardShim {
	constructor(host) {
		this.host = host;
		this.listeners = new Map();
	}
	/** Upstream contract: a listener returning `false` lets the event through. */
	on(key, listener) {
		if (!this.listeners.has(key)) this.listeners.set(key, []);
		this.listeners.get(key).push(listener);
	}
	dispatch(key, event) {
		const list = this.listeners.get(key);
		if (!list) return true;
		let handled = true;
		for (const fn of list) if (fn(event) === false) handled = false;
		return handled;
	}
}
