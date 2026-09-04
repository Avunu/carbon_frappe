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
//
// Every name below is spelled in frappe-types' frappe-datatable vocabulary
// (`DataTableRow`, `DataTableColIndex`, `DataTableCurrentSort`, …) rather than
// in a parallel one, because the shapes these shims hand back ARE the library's
// documented shapes — that is the whole point of the file. Where a shim
// genuinely diverges from what `src/datatable.d.ts` declares, the divergence is
// typed honestly and called out in a comment rather than papered over.
//
// This file has no runtime imports on purpose. `host.navigation` and
// `host.editing` are typed from frappe-types' declarations of carbon_frappe's
// own `CellNavigation` / `CellEditing` rather than from ./navigation and
// ./editing, which keeps the module graph acyclic: ./classes and ./navigation
// import FROM here, never the other way round.

import type {
	CellEditing,
	CellNavigation,
	DataTableAppliedFilters,
	DataTableCell,
	DataTableCellInput,
	DataTableCellValue,
	DataTableColIndex,
	DataTableColumn,
	DataTableTotalCell,
	DataTableCurrentSort,
	DataTableData,
	DataTableDataRow,
	DataTableEditor,
	DataTableFilterResult,
	DataTableKeyListener,
	DataTableOptions,
	DataTableRow,
	DataTableRowIndex,
	DataTableSortOrder,
	DataTableStyleObject,
} from "frappe-types";

// --------------------------------------------------------------------- types

/**
 * `CarbonDataTable.options` AFTER the defaults merge
 * (`./datatable.ts` `Object.assign(defaults(), options)`), which is the only
 * form a shim ever sees.
 *
 * Everything `defaults()` supplies is therefore present, which is what lets
 * `getRowHeight()` and `getColumnMinWidth()` promise the plain `number`
 * frappe-datatable's do instead of `number | undefined`.
 */
export interface CarbonDataTableOptions extends DataTableOptions {
	cellHeight: number;
	minimumColumnWidth: number;
	inlineFilters: boolean;
	sortingKey: string | null;
}

/**
 * One TanStack row, as these shims read it.
 *
 * Only the two members {@link rowIndexOf} needs are named: TanStack ships its
 * own generic `Row<T>`, and restating it here would be a maintenance trap. A
 * real `Row<DataTableRow>` satisfies this structurally.
 */
export interface CarbonEngineRow {
	/** The prepared row array the host handed the engine as this row's data. */
	original: DataTableRow;
	/** Position among SIBLINGS — under treeView that is not the data index. */
	index: number;
}

/** One entry of TanStack's `sorting` state slice. */
export interface CarbonEngineSort {
	id: string;
	desc: boolean;
}

/**
 * One entry of TanStack's `columnFilters` state slice.
 *
 * `value` is `unknown` because that is what TanStack stores. In this engine it
 * is only ever the inline filter `<input>`'s string (`engine/table.js:561`) or
 * a keyword forwarded from {@link DataTableAppliedFilters}, which is why
 * {@link ColumnManagerShim.getAppliedFilters} can promise strings back.
 */
export interface CarbonEngineColumnFilter {
	id: string;
	value: unknown;
}

/** The TanStack state slices these shims read (`engine/table.js:238-240`). */
export interface CarbonEngineState {
	sorting?: CarbonEngineSort[];
	columnFilters?: CarbonEngineColumnFilter[];
}

/** The TanStack `Table` methods reached through `engine.table`. */
export interface CarbonEngineTable {
	getRowModel(): { rows: CarbonEngineRow[] };
	toggleAllRowsExpanded(expanded?: boolean): void;
}

/** The row window currently in the DOM (`engine/table.js:398-406`). */
export interface CarbonEngineRenderRows {
	rows: CarbonEngineRow[];
	paddingTop: number;
	paddingBottom: number;
}

/**
 * The `CarbonTable` surface the datatable facade reaches.
 *
 * Declared structurally rather than imported from `../engine/table` so that
 * this module stays the bottom of the graph. The real `CarbonTable` satisfies
 * it; nothing here may be widened without checking that it still does.
 *
 * `getCellNode` / `getHeaderNode` take `string | null` because every call site
 * feeds them `host.engineColumnId(colIndex)`, which returns `null` for an
 * out-of-range column. The renderer `String()`s the id before looking it up
 * (`engine/render.js:555-565`), so a `null` is simply a miss.
 */
export interface CarbonEngine {
	renderer: { scroll: HTMLElement };
	table: CarbonEngineTable;
	state: CarbonEngineState;
	/** `rowHeight` is WRITTEN by {@link StyleShim.setCellHeight}. */
	options: { rowHeight?: number };
	render(): void;
	/** raf-coalesced render (`engine/table.js:94`). */
	scheduleRender(): void;
	getRowNode(rowId: string): HTMLElement | null;
	getCellNode(rowId: string, colId: string | null): HTMLElement | null;
	getHeaderNode(colId: string | null): HTMLElement | null;
	getRenderRows(): CarbonEngineRenderRows;
	setColumnSize(columnId: string, px: number): void;
	toggleFilters(show?: boolean): boolean;
	scrollToRowIndex(
		index: number,
		opts?: { align?: "start" | "center" | "end" | "auto" }
	): void;
	on(name: string, handler: (...args: unknown[]) => void): void;
}

/**
 * The `CarbonDataTable` surface every shim in this file — and
 * {@link CellNavigation} in ./navigation — reaches back into.
 *
 * This is the contract `CarbonDataTable` must keep, spelled out here because
 * the shims are constructed with `new DataManagerShim(this)` from inside its
 * constructor and cannot import it back.
 *
 * Several members are carbon_frappe's own and are deliberately absent from
 * frappe-types (they are not frappe API): `engine`, `standardColumnCount`,
 * `rowIdFor`, `engineColumnId`, `getDescendants`, `syncSelectionToEngine`,
 * `rebuildColumns`, `applyFilters`, `highlighted`, `highlightAll` and
 * `visibleOverride`.
 */
export interface CarbonDataTableHost {
	options: CarbonDataTableOptions;
	scopeClass: string;
	/** The wrapper element; `datatable.container === datatable.wrapper`. */
	container: HTMLElement;
	engine: CarbonEngine;

	datamanager: DataManagerShim;
	rowmanager: RowManagerShim;
	columnmanager: ColumnManagerShim;
	navigation: CellNavigation;
	editing: CellEditing;

	/** The ORIGINAL rows as passed in `options.data`. */
	data: DataTableData;
	/** The prepared rows — arrays of cells carrying `meta`. */
	rows: DataTableRow[];
	columns: DataTableColumn[];
	/** How many auto-injected `_checkbox` / `_rowIndex` columns come first. */
	standardColumnCount: number;

	/**
	 * Row highlighting bookkeeping. Written by
	 * {@link RowManagerShim.highlightRow} / {@link RowManagerShim.highlightAll}
	 * / {@link RowManagerShim.showRows} and — see the notes on those methods —
	 * read by nothing yet.
	 */
	highlighted: boolean[];
	highlightAll?: boolean;
	visibleOverride: DataTableRowIndex | DataTableRowIndex[] | null;

	/** `String(rowIndex)` — the engine's row id for a data index. */
	rowIdFor(rowIndex: DataTableRowIndex): string;
	/** `c{colIndex}:{col.id}`, or `null` when `colIndex` is out of range. */
	engineColumnId(colIndex: DataTableColIndex): string | null;

	/** Descendant ROWS of a tree node — see {@link DataManagerShim.getChildren}. */
	getDescendants(
		parentRowIndex: DataTableRowIndex,
		immediateOnly?: boolean
	): DataTableRow[];
	getTotalRow(): DataTableTotalCell[];

	/**
	 * These four return the host itself at runtime (they end in
	 * `return this`), which is neither what upstream returns nor anything a
	 * caller can use. Declared `void` so no shim can start depending on it.
	 */
	updateRow(row: DataTableCellInput[], rowIndex: DataTableRowIndex): void;
	refreshRow(row: DataTableCellInput[], rowIndex: DataTableRowIndex): void;
	appendRows(rows: DataTableData): void;
	rebuildColumns(): void;

	updateCell(
		colIndex: DataTableColIndex,
		rowIndex: DataTableRowIndex,
		options: Partial<DataTableCell>,
		refreshHtml?: boolean
	): DataTableCell | undefined;

	applyFilters(filters: DataTableAppliedFilters): Promise<DataTableFilterResult>;
	sortColumn(colIndex: DataTableColIndex, sortOrder?: DataTableSortOrder): void;
	switchColumn(colIndex1: DataTableColIndex, colIndex2: DataTableColIndex): void;
	removeColumn(colIndex: DataTableColIndex): void;
	setColumnSticky(colIndex: DataTableColIndex, sticky: boolean): void;

	syncSelectionToEngine(): void;
	setExpanded(rowIndex: DataTableRowIndex, expanded: boolean): void;
	setTreeDepth(depth: number): void;
	scrollToRow(rowIndex: DataTableRowIndex): void;

	showToastMessage(message: string, hideAfterSecs?: number): void;
	clearToastMessage(): void;
	translate(str: string, args?: { count?: number } & Record<string, unknown>): string;
	fireEvent(name: string, ...args: unknown[]): void;
}

/**
 * What the `*$` accessors hand back.
 *
 * A real jQuery object on a desk; a plain one-element array in the headless
 * harness, where there is no jQuery to build one with. Callers that only index
 * (`$row[0]`) or read `.length` work with either, which is why the fallback is
 * shaped like a collection rather than like a bare node.
 */
export type MaybeJQuery = JQuery<HTMLElement> | HTMLElement[];

// ------------------------------------------------------------------ constants

/**
 * frappe-datatable's per-cell defaults (datamanager.js `prepareHeader`).
 *
 * Annotated rather than `satisfies`-checked: frappe bundles esbuild 0.14, which
 * predates the `satisfies` operator and fails to PARSE it, so the build breaks
 * before tsc ever runs.
 */
export const BASE_CELL: Partial<DataTableColumn> = {
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
 * and these shims are also exercised by scripts/dev-table.ts, which runs
 * outside a desk and therefore has no jQuery.
 */
export function $of(node: HTMLElement | null | undefined): MaybeJQuery {
	const jq = typeof window !== "undefined" && window.$;
	if (!jq) return node ? [node] : [];
	return node ? jq(node) : jq();
}

/** Original-data index of a TanStack row, tree-safe. */
export function rowIndexOf(row: CarbonEngineRow | null | undefined): DataTableRowIndex {
	const original = row && row.original;
	if (original && original.meta && original.meta.rowIndex != null) return original.meta.rowIndex;
	return row ? row.index : -1;
}

/**
 * A raw DOM element rather than a jQuery object.
 *
 * Duck-typed on `nodeType` exactly as the JS did, not `instanceof Element`:
 * `cellmanager.focusCell` is a public entry point that report scripts call with
 * either kind of value, and an element from another realm (a dialog rendered
 * into an iframe) fails `instanceof` while still being a perfectly good node.
 */
function isDomElement(value: HTMLElement | JQuery<HTMLElement> | null | undefined): value is HTMLElement {
	return !!value && "nodeType" in value && !!value.nodeType;
}

// ---------------------------------------------------------------- DataManager

export class DataManagerShim {
	host: CarbonDataTableHost;
	options: CarbonDataTableOptions;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.options = host.options;
	}

	get data(): DataTableData {
		return this.host.data;
	}
	get rows(): DataTableRow[] {
		return this.host.rows;
	}
	get columns(): DataTableColumn[] {
		return this.host.columns;
	}
	get rowCount(): number {
		return this.host.rows.length;
	}
	/** Display order as original-data indices — upstream's `rowViewOrder`. */
	get rowViewOrder(): DataTableRowIndex[] {
		return this.host.engine.table.getRowModel().rows.map(rowIndexOf);
	}
	get currentSort(): DataTableCurrentSort {
		const sorting = this.host.engine.state.sorting || [];
		// `sorting[0]` rather than `sorting.length`: the two differ only for a
		// hole at index 0, which TanStack's state cannot contain.
		const first = sorting[0];
		if (!first) return { colIndex: -1, sortOrder: "none" };
		const colIndex = this.getColumnIndexById(first.id);
		return { colIndex, sortOrder: first.desc ? "desc" : "asc" };
	}

	getRow(rowIndex: DataTableRowIndex): DataTableRow | undefined {
		return this.host.rows[rowIndex];
	}
	/** The ORIGINAL row object — what report scripts read (`data.row_type`). */
	getData(rowIndex: DataTableRowIndex): DataTableDataRow | undefined {
		return this.host.data[rowIndex];
	}
	getCell(colIndex: DataTableColIndex, rowIndex: DataTableRowIndex): DataTableCell | undefined {
		const row = this.host.rows[rowIndex];
		return row ? row[colIndex] : undefined;
	}
	getRows(start?: number, end?: number): DataTableRow[] {
		return this.host.rows.slice(start, end);
	}
	getRowCount(): number {
		return this.host.rows.length;
	}
	getColumn(colIndex: DataTableColIndex): DataTableColumn | undefined {
		if (colIndex < 0) colIndex = this.host.columns.length + colIndex;
		return this.host.columns[colIndex];
	}
	getColumnById(id: string): DataTableColumn | undefined {
		return this.host.columns.find((c) => c.id === id);
	}
	getColumnIndexById(id: string): number {
		return this.host.columns.findIndex((c) => c.id === id);
	}
	getColumnIndex(name: string): number {
		return this.host.columns.findIndex((c) => c.name === name);
	}
	hasColumn(name: string): boolean {
		return this.getColumnIndex(name) !== -1;
	}
	hasColumnById(id: string): boolean {
		return this.getColumnIndexById(id) !== -1;
	}
	/**
	 * Count of auto-injected `_checkbox` / `_rowIndex` columns.
	 *
	 * Upstream narrows this to `0 | 1 | 2`; the host counts a pushed array, so
	 * the honest type here is `number`.
	 */
	getStandardColumnCount(): number {
		return this.host.standardColumnCount;
	}
	getColumnCount(skipStandardColumns?: boolean): number {
		return this.host.columns.length - (skipStandardColumns ? this.getStandardColumnCount() : 0);
	}
	/** `report_view.get_column_widths()` calls this with `true`. */
	getColumns(skipStandardColumns?: boolean): DataTableColumn[] {
		return skipStandardColumns
			? this.host.columns.slice(this.getStandardColumnCount())
			: this.host.columns;
	}
	getFilteredRowIndices(): DataTableRowIndex[] {
		return this.host.engine.table.getRowModel().rows.map(rowIndexOf);
	}
	getAllRowIndices(): DataTableRowIndex[] {
		return this.host.rows.map((_, i) => i);
	}
	/**
	 * Descendants of a tree node.
	 *
	 * NOTE the return type: `host.getDescendants` collects prepared ROWS, while
	 * upstream's `datamanager.getChildren` (datamanager.js:546-565) returns row
	 * INDICES. Typed as it behaves; see the migration notes.
	 */
	getChildren(parentRowIndex: DataTableRowIndex): DataTableRow[] {
		return this.host.getDescendants(parentRowIndex);
	}
	getImmediateChildren(parentRowIndex: DataTableRowIndex): DataTableRow[] {
		return this.host.getDescendants(parentRowIndex, true);
	}
	get(): { columns: DataTableColumn[]; rows: DataTableRow[] } {
		return { columns: this.host.columns, rows: this.host.rows };
	}

	updateRow(row: DataTableCellInput[], rowIndex: DataTableRowIndex): void {
		return this.host.updateRow(row, rowIndex);
	}
	updateCell(
		colIndex: DataTableColIndex,
		rowIndex: DataTableRowIndex,
		options: Partial<DataTableCell>
	): DataTableCell | undefined {
		return this.host.updateCell(colIndex, rowIndex, options);
	}
	updateColumn(colIndex: DataTableColIndex, keyValPairs: Partial<DataTableColumn>): void {
		const column = this.host.columns[colIndex];
		// The JS threw a bare `TypeError` out of `Object.assign(undefined, …)`
		// here; say which index was wrong instead.
		if (!column) {
			throw new Error(`carbon_frappe: updateColumn — no column at index ${colIndex}`);
		}
		Object.assign(column, keyValPairs);
		this.host.rebuildColumns();
	}
	appendRows(rows: DataTableData): void {
		return this.host.appendRows(rows);
	}
	filterRows(filters: DataTableAppliedFilters): Promise<DataTableFilterResult> {
		return this.host.applyFilters(filters);
	}
	sortRows(colIndex: DataTableColIndex, sortOrder?: DataTableSortOrder): void {
		return this.host.sortColumn(colIndex, sortOrder);
	}
	switchColumn(a: DataTableColIndex, b: DataTableColIndex): void {
		return this.host.switchColumn(a, b);
	}
	removeColumn(colIndex: DataTableColIndex): void {
		return this.host.removeColumn(colIndex);
	}
}

// ----------------------------------------------------------------- RowManager

export class RowManagerShim {
	host: CarbonDataTableHost;
	/**
	 * Sparse array of 0|1 indexed by rowIndex. ERPNext's
	 * bank_reconciliation dialog_manager assigns to it directly
	 * (`this.datatable.rowmanager.checkMap = []`), so it must stay a plain
	 * array on the instance, not a getter.
	 */
	checkMap: Array<0 | 1 | undefined>;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.checkMap = [];
	}

	get datamanager(): DataManagerShim {
		return this.host.datamanager;
	}

	/**
	 * Indices of checked rows. 13 call sites — ERPNext stock reports,
	 * bank reconciliation, HRMS, and avunu's timesheet_review.
	 */
	getCheckedRows(): DataTableRowIndex[] {
		return this.checkMap.reduce<DataTableRowIndex[]>((acc, val, i) => {
			if (val) acc.push(i);
			return acc;
		}, []);
	}

	checkRow(rowIndex: DataTableRowIndex, toggle: boolean): void {
		this.checkMap[rowIndex] = toggle ? 1 : 0;
		this.host.syncSelectionToEngine();
		this.host.fireEvent("onCheckRow", this.host.datamanager.getRow(rowIndex));
	}

	checkAll(toggle: boolean): void {
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

	highlightCheckedRows(): void {
		this.host.engine.scheduleRender();
	}
	highlightRow(rowIndex: DataTableRowIndex, toggle = true): void {
		this.host.highlighted[rowIndex] = toggle;
		this.host.engine.scheduleRender();
	}
	highlightAll(toggle = true): void {
		this.host.highlightAll = toggle;
		this.host.engine.scheduleRender();
	}
	refreshRows(): void {
		this.host.engine.render();
	}
	refreshRow(row: DataTableCellInput[], rowIndex: DataTableRowIndex): void {
		return this.host.refreshRow(row, rowIndex);
	}
	showRows(rowIndices: DataTableRowIndex | DataTableRowIndex[]): void {
		this.host.visibleOverride = rowIndices;
		this.host.engine.scheduleRender();
	}
	showAllRows(): void {
		this.host.visibleOverride = null;
		this.host.engine.scheduleRender();
	}

	openSingleNode(rowIndex: DataTableRowIndex): void {
		this.host.setExpanded(rowIndex, true);
	}
	closeSingleNode(rowIndex: DataTableRowIndex): void {
		this.host.setExpanded(rowIndex, false);
	}
	expandAllNodes(): void {
		this.host.engine.table.toggleAllRowsExpanded(true);
	}
	collapseAllNodes(): void {
		this.host.engine.table.toggleAllRowsExpanded(false);
	}
	/** `query_report.js` calls this with `report_settings.initial_depth`. */
	setTreeDepth(depth: number): void {
		this.host.setTreeDepth(depth);
	}

	getRow$(rowIndex: DataTableRowIndex): MaybeJQuery {
		const node = this.host.engine.getRowNode(this.host.rowIdFor(rowIndex));
		return $of(node);
	}
	getTotalRows(): number {
		return this.host.rows.length;
	}
	getFirstRowIndex(): number {
		return 0;
	}
	getLastRowIndex(): number {
		return this.host.rows.length - 1;
	}
	scrollToRow(rowIndex: DataTableRowIndex): void {
		this.host.scrollToRow(rowIndex);
	}
	selector(rowIndex: DataTableRowIndex): string {
		return `.dt-row-${rowIndex}`;
	}
}

// -------------------------------------------------------------- ColumnManager

export class ColumnManagerShim {
	host: CarbonDataTableHost;
	isFilterShown: boolean;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.isFilterShown = !!host.options.inlineFilters;
	}

	get sortState(): DataTableCurrentSort {
		return this.host.datamanager.currentSort;
	}
	get sortingKey(): string | null {
		return this.host.options.sortingKey;
	}

	/** `report_view.js` reads this to persist inline filters. */
	getAppliedFilters(): DataTableAppliedFilters {
		const out: DataTableAppliedFilters = {};
		for (const f of this.host.engine.state.columnFilters || []) {
			const colIndex = this.host.datamanager.getColumnIndexById(f.id);
			// `String()` is the identity for every value this state can hold —
			// the filter `<input>`'s own string, or a keyword forwarded from a
			// caller's `DataTableAppliedFilters`. It is here so the declared
			// `Record<string, string>` is true of the object, not to convert.
			if (colIndex !== -1 && f.value != null && f.value !== "") out[colIndex] = String(f.value);
		}
		return out;
	}
	applyFilter(filters: DataTableAppliedFilters): Promise<DataTableFilterResult> {
		return this.host.applyFilters(filters);
	}
	toggleFilter(flag?: boolean): boolean {
		this.isFilterShown = this.host.engine.toggleFilters(flag);
		return this.isFilterShown;
	}
	focusFilter(colIndex: DataTableColIndex): string | null {
		const column = this.host.engineColumnId(colIndex);
		const input = this.host.container.querySelector<HTMLElement>(
			`.dt-filter[data-col-index="${colIndex}"]`
		);
		if (input) input.focus();
		return column;
	}

	getColumn(colIndex: DataTableColIndex): DataTableColumn | undefined {
		return this.host.datamanager.getColumn(colIndex);
	}
	getColumns(): DataTableColumn[] {
		return this.host.columns;
	}
	setColumnWidth(colIndex: DataTableColIndex, width: number): void {
		const id = this.host.engineColumnId(colIndex);
		if (id) this.host.engine.setColumnSize(id, width);
	}
	getColumnMinWidth(colIndex: DataTableColIndex): number {
		const col = this.host.datamanager.getColumn(colIndex);
		return (col && col.minWidth) || this.host.options.minimumColumnWidth;
	}
	getFirstColumnIndex(): DataTableColIndex {
		return this.host.standardColumnCount;
	}
	getLastColumnIndex(): DataTableColIndex {
		return this.host.columns.length - 1;
	}
	getHeaderCell$(colIndex: DataTableColIndex): MaybeJQuery {
		const node = this.host.engine.getHeaderNode(this.host.engineColumnId(colIndex));
		return $of(node);
	}
	sortColumn(colIndex: DataTableColIndex, order?: DataTableSortOrder): void {
		return this.host.sortColumn(colIndex, order);
	}
	setColumnSticky(colIndex: DataTableColIndex, sticky: boolean): void {
		return this.host.setColumnSticky(colIndex, sticky);
	}
	switchColumn(a: DataTableColIndex, b: DataTableColIndex): void {
		return this.host.switchColumn(a, b);
	}
	removeColumn(colIndex: DataTableColIndex): void {
		return this.host.removeColumn(colIndex);
	}
	refreshHeader(): void {
		this.host.engine.scheduleRender();
	}
	renderHeader(): void {
		this.host.engine.scheduleRender();
	}
}

// ---------------------------------------------------------------- CellManager

export class CellManagerShim {
	host: CarbonDataTableHost;
	currentCellEditor: DataTableEditor | null;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.currentCellEditor = null;
	}

	/** Live views onto the real state, so callers never read a stale copy. */
	get $focusedCell(): HTMLElement | null {
		const nav = this.host.navigation;
		if (!nav || !nav.focused) return null;
		return this.host.engine.getCellNode(
			this.host.rowIdFor(nav.focused.rowIndex),
			this.host.engineColumnId(nav.focused.colIndex)
		);
	}

	get $editingCell(): HTMLElement | null {
		return this.host.editing.$editingCell;
	}

	get $selectionCursor(): HTMLElement | null {
		const nav = this.host.navigation;
		if (!nav || !nav.cursor) return null;
		return this.host.engine.getCellNode(
			this.host.rowIdFor(nav.cursor.rowIndex),
			this.host.engineColumnId(nav.cursor.colIndex)
		);
	}

	/** `report_view.js:render_editing_input` calls this before opening a dialog. */
	deactivateEditing(submitValue = true): boolean {
		return this.host.editing.deactivate(submitValue);
	}
	activateEditing($cell: HTMLElement | null): boolean {
		return this.host.editing.activate($cell);
	}
	submitEditing(): void {
		return this.host.editing.submit();
	}
	focusCell($cell: HTMLElement | JQuery<HTMLElement> | null | undefined): boolean {
		const node = isDomElement($cell) ? $cell : $cell && $cell[0];
		if (!node) return false;
		return this.host.navigation.focus(
			Number(node.getAttribute("data-col-index")),
			Number(node.getAttribute("data-row-index"))
		);
	}
	unfocusCell(): void {
		this.host.navigation.focused = null;
		this.host.navigation.cursor = null;
		this.host.navigation.render();
	}
	getSelectionCursor(): HTMLElement | null {
		return this.$selectionCursor;
	}
	clearSelection(): void {
		this.unfocusCell();
	}
	getCellsInRange(): Array<[DataTableColIndex, DataTableRowIndex]> | false {
		const b = this.host.navigation.bounds();
		if (!b) return false;
		const order = this.host.navigation.viewOrder;
		const out: Array<[DataTableColIndex, DataTableRowIndex]> = [];
		for (let p = b.p1; p <= b.p2; p++) {
			// `bounds()` returns POSITIONS, and a position is `-1` when the
			// focused row has since been filtered out of the view. `-1` is the
			// same miss as the `undefined` the JS pushed here, everywhere these
			// pairs are used.
			const rowIndex = order[p] ?? -1;
			for (let c = b.c1; c <= b.c2; c++) out.push([c, rowIndex]);
		}
		return out;
	}
	copyCellContents(): number {
		return this.host.navigation.copy();
	}
	updateCell(
		colIndex: DataTableColIndex,
		rowIndex: DataTableRowIndex,
		value: DataTableCellValue,
		refreshHtml?: boolean
	): DataTableCell | undefined {
		return this.host.updateCell(colIndex, rowIndex, { content: value }, refreshHtml);
	}
	getCell$(colIndex: DataTableColIndex, rowIndex: DataTableRowIndex): MaybeJQuery {
		const node = this.host.engine.getCellNode(
			this.host.rowIdFor(rowIndex),
			this.host.engineColumnId(colIndex)
		);
		return $of(node);
	}
	getCell(colIndex: DataTableColIndex, rowIndex: DataTableRowIndex): DataTableCell | undefined {
		return this.host.datamanager.getCell(colIndex, rowIndex);
	}
	isStandardCell(colIndex: DataTableColIndex): boolean {
		return colIndex < this.host.standardColumnCount;
	}
	selector(colIndex: DataTableColIndex, rowIndex: DataTableRowIndex): string {
		return `.dt-cell--${colIndex}-${rowIndex}`;
	}
	getRowHeight(): number {
		return this.host.options.cellHeight;
	}
	/**
	 * Despite the `$` name this only works on a raw node — as it did in the JS,
	 * which duck-typed `scrollIntoView` for exactly that reason.
	 */
	scrollToCell($cell: HTMLElement | null | undefined): void {
		if ($cell && typeof $cell.scrollIntoView === "function") {
			$cell.scrollIntoView({ block: "nearest" });
		}
	}
}

// --------------------------------------------------------------- BodyRenderer

export class BodyRendererShim {
	host: CarbonDataTableHost;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
	}
	/** Rows currently in the DOM window — ERPNext reads `.includes(rowIndex)`. */
	get visibleRowIndices(): DataTableRowIndex[] {
		return this.host.engine.getRenderRows().rows.map(rowIndexOf);
	}
	get visibleRows(): Array<DataTableRow | undefined> {
		return this.host.engine
			.getRenderRows()
			.rows.map((r) => this.host.rows[rowIndexOf(r)]);
	}
	/**
	 * `query_report.js` reads the computed totals row back out.
	 *
	 * The cells the host builds carry `content`, `colIndex` and `column` but no
	 * `isTotalRow: 1`, matching stock (`body-renderer.js:95-131`), so these are
	 * full `DataTableTotalCell`s.
	 */
	getTotalRow(): DataTableTotalCell[] {
		return this.host.getTotalRow();
	}
	render(): void {
		this.host.engine.render();
	}
	renderRows(): void {
		this.host.engine.render();
	}
	showToastMessage(message: string, hideAfter?: number): void {
		this.host.showToastMessage(message, hideAfter);
	}
	clearToastMessage(): void {
		this.host.clearToastMessage();
	}
}

// ---------------------------------------------------------------------- Style

export class StyleShim {
	host: CarbonDataTableHost;
	scopeClass: string;
	_rules: Map<string, string>;
	_el: HTMLStyleElement;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.scopeClass = host.scopeClass;
		this._rules = new Map();
		this._el = document.createElement("style");
		this._el.setAttribute("data-carbon-table-style", this.scopeClass);
		document.head.appendChild(this._el);
	}

	get stylesheet(): CSSStyleSheet | null {
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
	setStyle(selector: string, styleObject: DataTableStyleObject): void {
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

	removeStyle(selector: string): void {
		const scoped = `.${this.scopeClass} ${selector}`;
		this._rules.delete(scoped);
		this.flush();
	}

	flush(): void {
		let css = "";
		for (const [sel, body] of this._rules) if (body) css += `${sel} { ${body} }\n`;
		this._el.textContent = css;
	}

	setCellHeight(height: number): void {
		this.host.options.cellHeight = height;
		this.host.engine.options.rowHeight = height;
		this.host.engine.scheduleRender();
	}
	setDimensions(): void {
		this.host.engine.scheduleRender();
	}
	refreshColumnWidth(): void {
		this.host.engine.scheduleRender();
	}
	getColumnHeaderElement(colIndex: DataTableColIndex): HTMLElement | null {
		return this.host.engine.getHeaderNode(this.host.engineColumnId(colIndex));
	}
	destroy(): void {
		this._rules.clear();
		if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
	}
}

// ------------------------------------------------------------------- Keyboard

export class KeyboardShim {
	host: CarbonDataTableHost;
	listeners: Map<string, DataTableKeyListener[]>;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.listeners = new Map();
	}
	/** Upstream contract: a listener returning `false` lets the event through. */
	on(key: string, listener: DataTableKeyListener): void {
		let list = this.listeners.get(key);
		if (!list) {
			list = [];
			this.listeners.set(key, list);
		}
		list.push(listener);
	}
	dispatch(key: string, event: KeyboardEvent): boolean {
		const list = this.listeners.get(key);
		if (!list) return true;
		let handled = true;
		for (const fn of list) if (fn(event) === false) handled = false;
		return handled;
	}
}
