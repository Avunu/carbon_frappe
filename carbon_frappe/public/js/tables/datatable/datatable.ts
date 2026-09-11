// CarbonDataTable — a frappe-datatable-compatible facade over CarbonTable.
//
// This is the drop-in: `window.DataTable` and `frappe.DataTable` are reassigned
// to it, so Report View, Query Report, Data Import preview, the multi-select
// dialog, ERPNext's bank reconciliation and every third-party report script
// construct THIS instead of frappe-datatable, without changing a line.
//
// The compatibility target is not the library's documentation, it is what the
// bench actually calls. Options, methods, sub-managers, the `dt-*` DOM contract
// and the `getEditor` protocol are all reproduced against measured call sites;
// see ./managers.ts for the sub-manager surface and ./classes.ts for the DOM.
//
// Deliberately NOT reproduced, because they are inert upstream too:
//   `clusterize`        — dead since the switch from clusterize.js to HyperList
//   `dynamicRowHeight`  — read nowhere outside defaults.js
// Both are accepted and ignored so a caller passing them still works.
//
// TYPE VOCABULARY. Every shape this file hands out is frappe-datatable's, so it
// is spelled in frappe-types' names (`DataTableColumn`, `DataTableRow`,
// `DataTableCell`, …) rather than in a parallel set — the same discipline
// ./managers.ts follows, and for the same reason: these ARE the library's
// documented shapes. The one local vocabulary is the engine seam
// ({@link EngineColumnRef}, {@link TotalCellTarget}, {@link TotalCellHost}),
// which exists because two of this file's methods are called with FABRICATED
// arguments — see {@link CarbonDataTable.getTotalRow}.
import CarbonTable from "../engine/table";
import { nearestRowSize } from "../engine/classes";
import { datatableProfile, nextScopeClass } from "./classes";
import CellEditing from "./editing";
import CellNavigation from "./navigation";
import {
	BASE_CELL,
	BodyRendererShim,
	CellManagerShim,
	ColumnManagerShim,
	DataManagerShim,
	KeyboardShim,
	RowManagerShim,
	StyleShim,
	rowIndexOf,
} from "./managers";
import type { CarbonDataTableOptions } from "./managers";
import type { CarbonColumnSpec, CarbonRow } from "../engine/table";
import type { RenderedContentEntry } from "../engine/render";
import type { CarbonRowSize } from "../engine/classes";
import type {
	DataTableAppliedFilters,
	DataTableCell,
	DataTableCellValue,
	DataTableColIndex,
	DataTableColumn,
	DataTableColumnInput,
	DataTableTotalCell,
	DataTableComponentOverrides,
	DataTableData,
	DataTableDataRow,
	DataTableDirection,
	DataTableEvents,
	DataTableFilterResult,
	DataTableFilterRows,
	DataTableGetEditor,
	DataTableHeaderDropdownItem,
	DataTableHooks,
	DataTableLayout,
	DataTableOptions,
	DataTableRow,
	DataTableRowIndex,
	DataTableRowMeta,
	DataTableSortOrder,
	DataTableTranslations,
} from "frappe-types";

function __(str: string): string {
	return typeof window !== "undefined" && typeof window.__ === "function" ? window.__(str) : str;
}

/**
 * A column's text, as the engine wants it.
 *
 * `content` is a {@link DataTableCellValue} — every caller in the bench passes a
 * string (`report_view.js:1285` `content: title`), but the type allows a number
 * or a boolean — while the engine's `label` is a `string` and its render result
 * has no `boolean` arm. `String()` here is character-for-character what
 * `CarbonTable#columnLabel` (`String(spec.label)`) and `#applyContent`
 * (`String(result)`) would have done to the very same value one frame later, so
 * the rendered header text is unchanged.
 */
function columnText(value: DataTableCellValue): string {
	return value == null ? "" : String(value);
}

/**
 * How this file names a column to {@link CarbonDataTable.colIndexOfEngineColumn}.
 *
 * The engine hands it a real TanStack `Column` (`id: string`);
 * {@link CarbonDataTable.getTotalRow} hands it a bare `{ id }` built from
 * {@link CarbonDataTable.engineColumnId}, whose `id` is `null` for an
 * out-of-range column. Both reach the same two lines, so the parameter is the
 * structural minimum of the two rather than the engine's type.
 */
export type EngineColumnRef = string | { readonly id: string | null } | null | undefined;

/**
 * Narrow an engine event argument back to a column reference.
 *
 * `CarbonTableEventHandler`'s arguments are open (`...args: unknown[]`) because
 * the engine's `emit` is variadic, so the `onSortColumn` payload — which IS a
 * TanStack `Column` at runtime — arrives as `unknown` and has to be narrowed
 * here. Only `id` is ever read, which is all
 * {@link CarbonDataTable.colIndexOfEngineColumn} needs.
 */
function engineColumnRef(value: unknown): EngineColumnRef {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && "id" in value) {
		const id: unknown = value.id;
		return typeof id === "string" ? id : null;
	}
	return null;
}

/**
 * Narrow a delegated event's `target` to something `closest()` can be called on.
 *
 * Duck-typed rather than `instanceof Element`, exactly as the JS was
 * (`e.target.classList && …`): an `EventTarget` here can be a `Document`, a
 * `Window`, or an element from another realm — a control frappe rendered into an
 * iframe — and only the first two genuinely lack `closest`. ./editing.ts and
 * ./navigation.ts each keep their own copy of this guard for their own
 * delegated handlers; duplicating four tokens is cheaper than publishing a
 * helper none of the three modules wants on its surface.
 */
function isElement(target: EventTarget | null | undefined): target is Element {
	return !!target && "closest" in target && typeof target.closest === "function";
}

/**
 * Both chevrons a tree toggle carries, open first.
 *
 * frappe styles them itself and expects BOTH in the DOM at once: `.icon-open`
 * is `display: flex` and `.icon-close` is `display: none` by default, and
 * `.dt-cell--tree-close` (which {@link CarbonDataTable.cellHTML} puts on the
 * toggle, an ancestor of both, so the descendant selectors still match) swaps
 * which one shows. An empty toggle therefore renders as nothing at all — zero
 * width, no icon, no hint that the row opens. Same feather chevrons
 * frappe-datatable's icons.js ships, so the two render identically.
 */
const TREE_TOGGLE_ICONS =
	'<span class="icon-open"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-chevron-down"><polyline points="6 9 12 15 18 9"></polyline></svg></span>' +
	'<span class="icon-close"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-chevron-right"><polyline points="9 18 15 12 9 6"></polyline></svg></span>';

/**
 * `checked` off a delegated `change` target.
 *
 * The JS read `input.checked` straight off the event target after testing only
 * `classList`; the `in` test is what makes that read expressible, and
 * `=== true` is the identity for the `<input type="checkbox">` that is the only
 * thing carrying `.dt-checkbox` — the class is written by
 * {@link CarbonDataTable.getCheckboxHTML} and nowhere else.
 */
function isChecked(node: Element): boolean {
	return "checked" in node && node.checked === true;
}

/** The two DOM properties a checkbox's visual state lives in. */
interface CheckboxInput {
	checked: boolean;
	indeterminate: boolean;
}

/**
 * The WRITE side of {@link isChecked}.
 *
 * Duck-typed for the reason {@link isElement} is: a checkbox belonging to a
 * document in another realm is a perfectly good checkbox that
 * `instanceof HTMLInputElement` answers `false` for. Both properties are tested
 * because {@link CarbonDataTable.syncCheckboxes} assigns both — `indeterminate`
 * is the header box's third state, and it exists only on an input.
 */
function isCheckboxInput(node: Element): node is Element & CheckboxInput {
	return "checked" in node && "indeterminate" in node;
}

/**
 * `options` after the defaults merge — the only form this class ever holds.
 *
 * ./managers.ts's {@link CarbonDataTableOptions} already promises the four keys
 * the SHIMS need; this promises every key {@link defaults} supplies, because the
 * engine's own options bag refuses an explicit `undefined` (see the note on
 * `CarbonTableOptions` in ../engine/table.ts) and `direction`,
 * `noDataMessage`, `showTotalRow` and `checkboxColumn` are passed straight
 * through to it.
 */
export interface CarbonDataTableResolvedOptions extends CarbonDataTableOptions {
	columns: DataTableColumnInput[];
	data: DataTableData;
	/** `null`, not a chevron: carbon_frappe renders column menus through Carbon. */
	dropdownButton: string | null;
	headerDropdown: DataTableHeaderDropdownItem[];
	events: Partial<DataTableEvents>;
	hooks: DataTableHooks;
	sortIndicator: Partial<Record<DataTableSortOrder, string>>;
	overrideComponents: DataTableComponentOverrides;
	/** `null`: filtering is TanStack's, not `filterRows.js`'s. */
	filterRows: DataTableFilterRows | null;
	freezeMessage: string;
	getEditor: DataTableGetEditor | null;
	serialNoColumn: boolean;
	serialNoColumnLabel: string;
	checkboxColumn: boolean;
	clusterize: boolean;
	logs: boolean;
	layout: DataTableLayout;
	noDataMessage: string;
	treeView: boolean;
	checkedRowStatus: boolean;
	dynamicRowHeight: boolean;
	pasteFromClipboard: boolean;
	showTotalRow: boolean;
	direction: DataTableDirection;
	disableReorderColumn: boolean;
	language: string;
	translations: DataTableTranslations;
	saveSorting: boolean;
}

/**
 * One entry of the events bag.
 *
 * `...args: never[]` is the widest thing every stored handler is assignable to,
 * and every one of them has a DIFFERENT declared signature: the bag holds
 * frappe-datatable's five specifically-typed events (`onSwitchColumn` takes two
 * columns, `onDestroy` takes none — see frappe-types' `DataTableEvents`)
 * alongside whatever {@link CarbonDataTable.on} was handed, while `fireEvent`
 * sprays a variadic argument list at whichever name it is given. The dispatch
 * genuinely is unchecked, exactly as `datatable.js:249-260`'s is; what a
 * parameter type can honestly say about it is "no argument is guaranteed", and
 * that is what this says. {@link isEventHandler} is where the one call that has
 * to bridge the two is made, once.
 *
 * Deliberately WITHOUT a `this` parameter, for the reason frappe-types gives on
 * `frappe.utils.report_column_total`: `fireEvent` invokes handlers as
 * `handler.apply(this, args)` with the datatable as the receiver, and a declared
 * `this` would have to name a type both this class and stock frappe-datatable's
 * `DataTable` satisfy — which they do not (see the migration notes on the
 * sub-manager divergences).
 */
export type CarbonDataTableEventHandler = (...args: never[]) => void;

/**
 * Is this bag entry callable, and callable with `fireEvent`'s arguments?
 *
 * The runtime test is the JS's, unchanged: `typeof handler === "function"`. The
 * predicate is what carries it across the gap described on
 * {@link CarbonDataTableEventHandler} — the stored signature says "no argument
 * is guaranteed", the caller has `unknown[]` — instead of that gap being
 * papered over at each of the three call sites. It is the one place in this file
 * that asserts something the runtime check does not itself prove, and it asserts
 * exactly what frappe-datatable's own `fireEvent` assumes.
 */
function isEventHandler(value: unknown): value is (...args: unknown[]) => void {
	return typeof value === "function";
}

/**
 * The events bag: the five documented frappe-datatable events, plus whatever
 * name {@link CarbonDataTable.on} registers, since `fireEvent` looks them up by
 * string.
 */
export type CarbonDataTableEvents = Partial<DataTableEvents> &
	Record<string, CarbonDataTableEventHandler | undefined>;

/**
 * What {@link CarbonDataTable.renderTotalCell} writes into.
 *
 * NOT the engine's `TotalCellEntry`: {@link CarbonDataTable.getTotalRow} calls
 * the same method with an entry that has a `content` div and no `<td>` at all,
 * to compute the totals off-DOM. A real `TotalCellEntry` satisfies this.
 */
export interface TotalCellTarget extends RenderedContentEntry {
	readonly content: HTMLElement;
}

/**
 * What {@link CarbonDataTable.renderTotalCell} needs of the engine.
 *
 * The structural minimum, for the same reason as {@link TotalCellTarget}: the
 * real `CarbonTable` satisfies it, and nothing here may be widened without
 * checking that it still does.
 */
export interface TotalCellHost {
	applyContent(entry: RenderedContentEntry, target: HTMLElement, result: unknown): void;
	table: { getRowModel(): { rows: ReadonlyArray<{ original: DataTableRow }> } };
}

/**
 * The `columnDef.meta` this adapter attaches to every engine column.
 *
 * `colIndex` and `dtColumn` are its own bookkeeping; `compareValue` and
 * `getFilterText` are the two members ../engine/features.ts probes for
 * (`FrappeFilterColumnMeta`). They are declared against the engine's `CarbonRow`
 * rather than that file's `FrappeFilterRow` because both read `row.original`,
 * which `FrappeFilterRow` — written for the value-only path — does not name.
 */
interface DatatableColumnMeta {
	colIndex: DataTableColIndex;
	dtColumn: DataTableColumn;
	compareValue?:
		| ((row: CarbonRow<DataTableRow>, keyword: string) => [number | string, number | string] | null | undefined)
		| undefined;
	getFilterText?: ((row: CarbonRow<DataTableRow>) => string) | undefined;
}

/** frappe-datatable's defaults (datatable/src/defaults.js), verbatim. */
function defaults(): CarbonDataTableResolvedOptions {
	return {
		columns: [],
		data: [],
		dropdownButton: null,
		headerDropdown: [],
		events: {},
		hooks: { columnTotal: null },
		sortIndicator: { asc: "↑", desc: "↓", none: "" },
		overrideComponents: {},
		filterRows: null,
		freezeMessage: "",
		getEditor: null,
		serialNoColumn: true,
		serialNoColumnLabel: "",
		checkboxColumn: false,
		clusterize: true,
		logs: false,
		layout: "fixed",
		noDataMessage: __("No Data"),
		cellHeight: 40,
		minimumColumnWidth: 30,
		inlineFilters: false,
		treeView: false,
		checkedRowStatus: true,
		dynamicRowHeight: false,
		pasteFromClipboard: false,
		showTotalRow: false,
		direction: "ltr",
		disableReorderColumn: false,
		language: "en",
		translations: {},
		saveSorting: false,
		sortingKey: null,
	};
}

let INSTANCES = 0;

export default class CarbonDataTable {
	// ------------------------------------------------------- constructed state

	scopeClass: string;
	wrapper: HTMLElement;
	container: HTMLElement;
	options: CarbonDataTableResolvedOptions;
	events: CarbonDataTableEvents;

	datamanager: DataManagerShim;
	rowmanager: RowManagerShim;
	columnmanager: ColumnManagerShim;
	cellmanager: CellManagerShim;
	bodyRenderer: BodyRendererShim;
	keyboard: KeyboardShim;
	editing: CellEditing;
	navigation: CellNavigation;
	style: StyleShim;

	/** Per-row highlight bookkeeping, written by `rowmanager.highlightRow`. */
	highlighted: boolean[];
	/** `rowmanager.showRows()`'s override of the visible set, or `null`. */
	visibleOverride: DataTableRowIndex | DataTableRowIndex[] | null;
	noData: boolean;

	// ------------------------------------------------ imperatively assigned
	//
	// All `declare`: every one is written from `prepare()`, `buildEngine()`,
	// `prepareDom()` or — for `highlightAll` — from a sub-manager reaching back
	// in (`rowmanager.highlightAll`). A real class field would be DEFINED, as
	// `undefined`, at the top of the constructor, which is not the runtime shape
	// this class has ever had; `declare` emits nothing and says so. The same
	// discipline ../grid/grid.ts uses for its own imperative members.

	/** The prepared columns, including the injected standard ones. */
	declare columns: DataTableColumn[];
	/** How many auto-injected `_checkbox` / `_rowIndex` columns come first. */
	declare standardColumnCount: number;
	/** The ORIGINAL rows, as passed in `options.data`. */
	declare data: DataTableData;
	/** The prepared rows — arrays of cells carrying `meta`. */
	declare rows: DataTableRow[];
	/** Roots of the re-nested tree, or `null` when `treeView` is off. */
	declare treeRoots: DataTableRow[] | null;
	/** The rendering engine. */
	declare engine: CarbonTable<DataTableRow>;
	/** Set by `rowmanager.highlightAll`; read by nothing yet. */
	declare highlightAll?: boolean;

	// DOM handles, cached by `prepareDom`.
	declare datatableWrapper: HTMLElement;
	declare header: HTMLElement;
	declare footer: HTMLElement;
	declare bodyScrollable: HTMLElement;
	declare freezeContainer: HTMLElement;
	declare toastMessage: HTMLElement;
	declare pasteTarget: HTMLTextAreaElement;

	/** Mirrors frappe-datatable's `DataTable.instances = 0` (datatable.js:298). */
	static instances = 0;
	static __version__ = "carbon_frappe";

	constructor(wrapper: HTMLElement | string, options: DataTableOptions = {}) {
		const el = typeof wrapper === "string" ? document.querySelector(wrapper) : wrapper;
		if (!el || !(el instanceof HTMLElement)) {
			throw new Error("Invalid argument given for `wrapper`");
		}

		CarbonDataTable.instances = ++INSTANCES;
		const scope = nextScopeClass();
		this.scopeClass = scope.scopeClass;

		this.wrapper = el;
		this.container = el;
		this.options = Object.assign(defaults(), options);
		// `events` and `hooks` are merged, not replaced — a caller passing only
		// `onCheckRow` must not wipe the other five no-ops.
		this.events = Object.assign({}, defaults().events, options.events || {});
		this.options.events = this.events;
		this.options.hooks = Object.assign({ columnTotal: null }, options.hooks || {});

		this.datamanager = new DataManagerShim(this);
		this.rowmanager = new RowManagerShim(this);
		this.columnmanager = new ColumnManagerShim(this);
		this.cellmanager = new CellManagerShim(this);
		this.bodyRenderer = new BodyRendererShim(this);
		this.keyboard = new KeyboardShim(this);
		this.editing = new CellEditing(this);
		this.navigation = new CellNavigation(this);

		this.highlighted = [];
		this.visibleOverride = null;
		this.noData = true;

		this.prepare(this.options.columns, this.options.data);
		this.buildEngine();
		this.style = new StyleShim(this);
		this.editing.bind(this.container);
		this.prepareDom();
		this.navigation.bind(this.container);

		if (this.options.data && this.options.data.length) this.render();
	}

	// -------------------------------------------------------------- normalise

	/**
	 * Column normalisation, following datamanager.prepareColumns /
	 * prepareDefaultColumns. The `_checkbox` and `_rowIndex` columns are
	 * PREPENDED and counted in every colIndex the outside world sees, because
	 * that is what `datamanager.columns` does upstream and what every
	 * `.dt-cell--{colIndex}-{rowIndex}` selector assumes.
	 */
	prepareColumns(columns?: DataTableColumnInput[]): DataTableColumn[] {
		const std: DataTableColumn[] = [];
		if (this.options.checkboxColumn) {
			std.push({
				id: "_checkbox",
				content: '<input type="checkbox" class="dt-checkbox" />',
				editable: false,
				resizable: false,
				sortable: false,
				focusable: false,
				dropdown: false,
				sticky: true,
				width: 32,
			});
		}
		if (this.options.serialNoColumn) {
			std.push({
				id: "_rowIndex",
				content: this.options.serialNoColumnLabel || "",
				align: "center",
				editable: false,
				resizable: true,
				sortable: false,
				focusable: false,
				dropdown: false,
				sticky: true,
				width: 60,
			});
		}
		this.standardColumnCount = std.length;

		const user = (columns || []).map((col): DataTableColumn => {
			const base: Partial<DataTableColumn> =
				typeof col === "string" ? { content: col } : Object.assign({}, col);
			const merged: Partial<DataTableColumn> = Object.assign({}, BASE_CELL, base);
			// The JS finished with `if (!merged.format) merged.format = undefined;`.
			// It is dropped, not translated: `format` is a function or absent, so
			// "falsy" and "undefined" are the same state, and the assignment only
			// ever made the KEY present with an undefined value — invisible to
			// every reader (`cell.format || cell.column.format`), to
			// `Object.assign` and to `JSON.stringify` alike.
			const content = merged.content || merged.name || "";
			// `id` falls back to `content` exactly as datamanager.js:107-108 does,
			// through `String()` because a column id is a string and `content`
			// need not be. Every id this file builds is either compared against
			// `"_checkbox"` / `"_rowIndex"` or interpolated into a template
			// literal, so a non-string id already behaved as its string form.
			const identity: Pick<DataTableColumn, "isHeader" | "content" | "id"> = {
				isHeader: 1,
				content,
				id: merged.id || String(content),
			};
			return Object.assign(merged, identity);
		});

		this.columns = std.concat(user).map((col, i) => {
			col.colIndex = i;
			return col;
		});
		return this.columns;
	}

	/** Row normalisation, following datamanager.prepareRows / prepareRow. */
	prepareRows(data?: DataTableData): DataTableRow[] {
		const cols = this.columns;
		return (data || []).map((d, index) => {
			const raw: Array<DataTableCellValue | Partial<DataTableCell>> = [];
			if (Array.isArray(d)) {
				if (this.options.checkboxColumn) raw.push(this.getCheckboxHTML());
				if (this.options.serialNoColumn) raw.push(String(index + 1));
				for (const cell of d) raw.push(cell);
				while (raw.length < cols.length) raw.push("");
			} else {
				for (const col of cols) {
					if (col.id === "_checkbox") raw.push(this.getCheckboxHTML());
					else if (col.id === "_rowIndex") raw.push(String(index + 1));
					else raw.push(d[col.id]);
				}
			}

			const indent = Array.isArray(d) ? 0 : d.indent || 0;
			const meta: DataTableRowMeta = { rowIndex: index, indent };
			const cells = raw.map((content, i) => {
				const cell: DataTableCell = { content: "", sortOrder: "none", colIndex: i };
				// `column` is assigned rather than written into the literal, and
				// only when there is one: a data ROW longer than the column list
				// leaves `cols[i]` undefined, and the JS then parked that
				// `undefined` on the key. An absent key and a present-undefined
				// one read identically at every site (`cell.column && …`).
				const column = cols[i];
				if (column) cell.column = column;
				if (content !== null && typeof content === "object") Object.assign(cell, content);
				else cell.content = content;
				if (cell.rowIndex == null) cell.rowIndex = meta.rowIndex;
				if (cell.indent == null) cell.indent = indent;
				return cell;
			});
			return Object.assign(cells, { meta });
		});
	}

	getCheckboxHTML(): string {
		return '<input type="checkbox" class="dt-checkbox" />';
	}

	prepare(columns?: DataTableColumnInput[], data?: DataTableData): void {
		this.prepareColumns(columns);
		this.data = data || [];
		this.rows = this.prepareRows(this.data);
		this.prepareTree();
	}

	/**
	 * frappe-datatable expresses a tree as a FLAT list with an `indent` field;
	 * TanStack expects nesting. Build the nesting once, keeping every row's
	 * original flat index in `meta.rowIndex` so the two addressing schemes stay
	 * reconcilable (see managers.rowIndexOf).
	 */
	prepareTree(): void {
		this.treeRoots = null;
		if (!this.options.treeView) return;
		const roots: DataTableRow[] = [];
		const stack: DataTableRow[] = [];
		for (const row of this.rows) {
			const children: DataTableRow[] = [];
			row.__children = children;
			const indent = row.meta.indent || 0;
			// The JS read `stack[stack.length - 1]` twice inside the condition;
			// naming it is what makes the read definite, and `!top` is
			// unreachable while `stack.length` is truthy.
			for (;;) {
				const top = stack[stack.length - 1];
				if (!top || (top.meta.indent || 0) < indent) break;
				stack.pop();
			}
			const parent = stack[stack.length - 1];
			if (parent) {
				// Every row is given `__children` at the top of this loop before
				// it can reach the stack, so the fallback is never taken.
				const siblings = parent.__children || [];
				parent.__children = siblings;
				siblings.push(row);
			} else {
				roots.push(row);
			}
			stack.push(row);
		}
		for (const row of this.rows) row.meta.isLeaf = (row.__children || []).length === 0;
		this.treeRoots = roots;
	}

	getDescendants(parentRowIndex: DataTableRowIndex, immediateOnly?: boolean): DataTableRow[] {
		const parent = this.rows[parentRowIndex];
		if (!parent || !parent.__children) return [];
		if (immediateOnly) return parent.__children.slice();
		const out: DataTableRow[] = [];
		const walk = (node: DataTableRow): void => {
			for (const child of node.__children || []) {
				out.push(child);
				walk(child);
			}
		};
		walk(parent);
		return out;
	}

	// ----------------------------------------------------------------- engine

	engineColumnId(colIndex: DataTableColIndex): string | null {
		const col = this.columns[colIndex];
		return col ? this.engineIdFor(col, colIndex) : null;
	}

	/** Column ids must be unique and stable; `id` can repeat, colIndex cannot. */
	engineIdFor(col: DataTableColumn, colIndex: DataTableColIndex): string {
		return `c${colIndex}:${col.id}`;
	}

	rowIdFor(rowIndex: DataTableRowIndex): string {
		return String(rowIndex);
	}

	buildEngine(): void {
		const engineColumns = this.columns.map((col, i) => this.toEngineColumn(col, i));
		this.engine = new CarbonTable<DataTableRow>(this.container, {
			columns: engineColumns,
			data: this.options.treeView ? this.treeRoots || [] : this.rows,
			getRowId: (row) => String(row.meta.rowIndex),
			getSubRows: this.options.treeView ? (row) => row.__children : null,
			rowHeight: this.options.cellHeight,
			direction: this.options.direction,
			inlineFilters: this.options.inlineFilters,
			showTotalRow: this.options.showTotalRow,
			selectable: this.options.checkboxColumn,
			resizable: true,
			emptyMessage: this.options.noDataMessage,
			// Report views scroll INSIDE the table, as frappe-datatable did
			// (`.dt-scrollable { height: 40vw }`). Without a bounded viewport a
			// 100k-row report would put every row in the DOM.
			scrollHeight: this.options.scrollHeight || "calc(100vh - 260px)",
			profile: datatableProfile(this.scopeClass),
			renderTotal: (entry, column, colIndex, host) =>
				this.renderTotalCell(entry, column, colIndex, host),
			events: {
				// Every render: the renderer recycles row nodes as the window
				// scrolls, and a recycled node comes back with the markup
				// `getCheckboxHTML` returns — an UNCHECKED box — however the
				// map reads. See {@link CarbonDataTable.syncCheckboxes}.
				onRender: () => this.syncCheckboxes(),
				onSortColumn: (column) => {
					const col = this.columns[this.colIndexOfEngineColumn(engineColumnRef(column))];
					this.fireEvent("onSortColumn", col);
					if (this.options.saveSorting) this.persistSorting();
				},
			},
		});
	}

	colIndexOfEngineColumn(column: EngineColumnRef): DataTableColIndex {
		const id = typeof column === "string" ? column : column && column.id;
		// The JS let a `null` id straight into `exec`, which stringified it to
		// `"null"` and simply did not match; -1 is that same miss.
		if (id == null) return -1;
		const m = /^c(\d+):/.exec(id);
		const digits = m && m[1];
		return digits == null ? -1 : Number(digits);
	}

	toEngineColumn(col: DataTableColumn, i: DataTableColIndex): CarbonColumnSpec<DataTableRow> {
		const isStandard = i < this.standardColumnCount;
		// Held in a local so the closure below carries the narrowing: the field
		// is `DataTableCompareValue | null | undefined` and the closure only
		// exists on the branch where it is a function.
		const compareValue = col.compareValue;
		const meta: DatatableColumnMeta = {
			colIndex: i,
			dtColumn: col,
			compareValue: compareValue
				? (row, keyword) => {
						const cell = row.original[i];
						// The JS handed `col.compareValue` whatever
						// `row.original[i]` was, and every column of a prepared
						// row has a cell; `null` is ../engine/features.ts's
						// "no opinion, compare the usual way", which is where a
						// hole would have thrown instead.
						return cell ? compareValue(cell, keyword) : null;
				  }
				: undefined,
			getFilterText: (row) => this.plainText(this.cellHTML(row.original[i], false)),
		};
		return {
			id: this.engineIdFor(col, i),
			label: columnText(col.name || col.content || ""),
			header: () => columnText(col.content || col.name || ""),
			size: col.width || (isStandard ? 60 : 120),
			minSize: col.minWidth || this.options.minimumColumnWidth,
			align: col.align || "left",
			sortable: col.sortable !== false && !isStandard,
			resizable: col.resizable !== false,
			filterable: col.focusable !== false && !isStandard,
			pinned: col.sticky ? "start" : undefined,
			accessor: (rowArr) => {
				const cell = rowArr[i];
				return cell ? cell.content : "";
			},
			meta,
			cell: (ctx) => this.cellHTML(ctx.row.original[i], false, ctx.row),
		};
	}

	plainText(html: unknown): string {
		return String(html == null ? "" : html).replace(/<[^>]*>/g, "");
	}

	/**
	 * Cell HTML, following cellmanager.getCellContent: a `format` on the cell
	 * wins over one on the column, the result is memoised on `cell.html`, and
	 * treeView injects the indent and toggle into the column right after
	 * `_rowIndex` at 20px per level.
	 */
	cellHTML(
		cell: DataTableCell | undefined,
		refreshHtml?: boolean,
		row?: CarbonRow<DataTableRow>
	): string {
		if (!cell) return "";
		const formatter = cell.format || (cell.column && cell.column.format) || null;
		let html: DataTableCellValue;
		if (!formatter) {
			html = cell.content;
		} else if (!cell.html || refreshHtml) {
			// `rowIndex` is set on every cell `prepareRows` builds; naming it is
			// what lets the two lookups be indexed, and an absent one lands on
			// the same `undefined` the JS got out of `this.rows[undefined]`.
			const rowIndex = cell.rowIndex;
			html = formatter(
				cell.content,
				rowIndex == null ? undefined : this.rows[rowIndex],
				cell.column,
				rowIndex == null ? undefined : this.data[rowIndex]
			);
		} else {
			html = cell.html;
		}
		cell.html = html;
		let out = html == null ? "" : String(html);

		if (this.options.treeView && cell.colIndex === this.treeColumnIndex()) {
			const indent = cell.indent || 0;
			const hasChildren = row && row.subRows && row.subRows.length;
			// `typeof … === "function"`, not the JS's bare truthiness test: the
			// member is declared on TanStack's `Row`, so a truthiness test on it
			// is a compile error ("this function is always defined"). The guard
			// is kept because the engine's expansion feature is opt-in.
			const expanded = row && typeof row.getIsExpanded === "function" && row.getIsExpanded();
			const closed = expanded ? "" : " dt-cell--tree-close";
			const toggle = hasChildren
				? `<span class="dt-tree-node__toggle${closed}">${TREE_TOGGLE_ICONS}</span>`
				: '<span class="dt-tree-node__toggle-placeholder"></span>';
			out = `<span class="dt-tree-node" style="padding-left:${indent * 20}px">${toggle}${out}</span>`;
		}
		return out;
	}

	treeColumnIndex(): DataTableColIndex {
		const i = this.datamanager.getColumnIndexById("_rowIndex");
		return i + 1;
	}

	renderTotalCell(
		entry: TotalCellTarget,
		column: EngineColumnRef,
		_colIndex: number,
		host: TotalCellHost
	): void {
		const dtColIndex = this.colIndexOfEngineColumn(column);
		const col = this.columns[dtColIndex];
		if (!col || dtColIndex < this.standardColumnCount) {
			host.applyContent(entry, entry.content, dtColIndex === 0 ? __("Total") : "");
			return;
		}
		const values = host.table.getRowModel().rows.map((r) => {
			const cell = r.original[dtColIndex];
			return cell ? cell.content : null;
		});
		// The full stock cell (`body-renderer.js:97-108`), member for member, so
		// a third-party `columnTotal` hook cannot tell the two implementations
		// apart. `content` is `null` at hook time on stock too: it is seeded
		// `null` at :98 and only replaced by the hook's own return value
		// afterwards (:115-129). `frappe.utils.report_column_total` happens to
		// read only `column` (utils.js:970-975), but a hook is entitled to the
		// whole shape, and passing less was a real divergence.
		const cell: DataTableTotalCell = {
			content: null,
			isTotalRow: 1,
			colIndex: dtColIndex,
			column: col,
		};
		let total: string | number | null | undefined = null;
		const hook = this.options.hooks && this.options.hooks.columnTotal;
		if (typeof hook === "function") total = hook.call(this, values, cell);
		if (total === null || total === undefined) {
			let sum = 0;
			let numeric = false;
			for (const v of values) {
				// `String(v)` is what `parseFloat` did to the same value
				// implicitly: it stringifies its argument before parsing, so
				// `null` → `"null"` → NaN and `5` → `"5"` → 5, unchanged.
				const n = parseFloat(String(v));
				if (!isNaN(n)) {
					sum += n;
					numeric = true;
				}
			}
			total = numeric ? sum : "";
		}
		host.applyContent(entry, entry.content, total);
	}

	/**
	 * The computed totals row, as `query_report.js` reads it back.
	 *
	 * Member for member what stock returns (`body-renderer.js:95-131`):
	 * `content` holding the rendered total, plus `isTotalRow: 1`, `colIndex` and
	 * `column`. The marker matters beyond assignability — it is what
	 * `getCellHTML` keys the `data-is-total-row` attribute off
	 * (`cellmanager.js:809-823`), so a consumer round-tripping these cells back
	 * through stock rendering gets the right markup.
	 */
	getTotalRow(): DataTableTotalCell[] {
		return this.columns.map((column, i) => {
			const entry: TotalCellTarget = {
				content: document.createElement("div"),
				rendered: undefined,
			};
			this.renderTotalCell(entry, { id: this.engineColumnId(i) }, i, this.engine);
			return { content: entry.content.innerHTML, isTotalRow: 1, colIndex: i, column };
		});
	}

	prepareDom(): void {
		// frappe-datatable exposes these handles and ERPNext styles through them
		// (`$(".${scopeClass} .dt-scrollable")`), so keep them resolvable.
		this.datatableWrapper = this.container;
		this.header = this.engine.renderer.thead;
		this.footer = this.engine.renderer.tfoot;
		this.bodyScrollable = this.engine.renderer.scroll;

		this.freezeContainer = document.createElement("div");
		this.freezeContainer.className = "dt-freeze";
		this.freezeContainer.style.display = "none";
		this.freezeContainer.innerHTML = `<span class="dt-freeze__message">${this.options.freezeMessage}</span>`;
		this.container.appendChild(this.freezeContainer);

		this.toastMessage = document.createElement("div");
		this.toastMessage.className = "dt-toast";
		this.container.appendChild(this.toastMessage);

		this.pasteTarget = document.createElement("textarea");
		this.pasteTarget.className = "dt-paste-target";
		this.container.appendChild(this.pasteTarget);

		this.bindCheckboxes();
		this.bindTreeToggles();
	}

	bindCheckboxes(): void {
		this.container.addEventListener("change", (e) => {
			const input = e.target;
			if (!isElement(input) || !input.classList.contains("dt-checkbox")) return;
			const td = input.closest(".dt-cell");
			if (!td) return;
			const isHeader = !!input.closest(".dt-row-header");
			if (isHeader) {
				this.rowmanager.checkAll(isChecked(input));
			} else {
				const rowIndex = Number(td.getAttribute("data-row-index"));
				this.rowmanager.checkRow(rowIndex, isChecked(input));
			}
		});
	}

	/**
	 * Open/close a tree node when its toggle is clicked.
	 *
	 * frappe-datatable bound this in `CellManager.bindTreeEvents` (cellmanager.js
	 * :200-212) and nothing else ever did, so a tree report rendered by this
	 * class had a chevron that no listener answered: `initial_depth` still
	 * collapsed the rows, because `query_report.js` reaches
	 * {@link RowManagerShim.setTreeDepth} directly, but no click could open one
	 * again.
	 *
	 * Delegated off `container` like {@link CarbonDataTable.bindCheckboxes}, and
	 * matching with `closest` rather than a `classList` test on the target
	 * itself: the toggle owns two icon spans and an SVG apiece, so the click
	 * usually lands on a descendant — and a report is free to render its own
	 * element carrying the class, which the stock delegated handler accepted and
	 * which some do (little_cocalico's Print Queue renders a labelled button).
	 *
	 * The header is excluded: a `thead` cell has no row to expand, and its
	 * `data-row-index` is not a data row's.
	 */
	bindTreeToggles(): void {
		this.container.addEventListener("click", (e) => {
			if (!this.options.treeView) return;
			if (!isElement(e.target)) return;
			const toggle = e.target.closest(".dt-tree-node__toggle");
			if (!toggle) return;
			const td = toggle.closest(".dt-cell");
			if (!td || td.closest("thead")) return;
			const rowIndex = Number(td.getAttribute("data-row-index"));
			if (!Number.isFinite(rowIndex)) return;
			// A toggle inside a <button> would otherwise submit an enclosing
			// form; the click still reaches the cell-focus handler, which is
			// what a click anywhere else in the cell does anyway.
			e.preventDefault();
			const row = this.engine.table.getRow(this.rowIdFor(rowIndex));
			// `typeof`, not truthiness, for the reason given in `cellHTML`.
			const expanded =
				!!row && typeof row.getIsExpanded === "function" && row.getIsExpanded();
			this.setExpanded(rowIndex, !expanded);
		});
	}

	syncSelectionToEngine(): void {
		// `Record<string, true>`, not `<string, boolean>`: that is TanStack's
		// `RowSelectionState`, and the only value this loop writes is `true` —
		// an unchecked row is ABSENT from the map, not present-and-false.
		const selection: Record<string, true> = {};
		this.rowmanager.checkMap.forEach((v, i) => {
			if (v) selection[this.rowIdFor(i)] = true;
		});
		this.engine.table.setRowSelection(selection);
		// Directly, as well as from `onRender`: the engine coalesces renders
		// into a rAF, and this is the path that already KNOWS the map moved, so
		// the boxes tick in the same frame as the click that ticked them.
		this.syncCheckboxes();
		if (this.options.checkedRowStatus) {
			const n = this.rowmanager.getCheckedRows().length;
			if (n) this.showToastMessage(`${n} ${n === 1 ? __("row selected") : __("rows selected")}`);
			else this.clearToastMessage();
		}
	}

	/**
	 * Reflect `rowmanager.checkMap` onto the checkbox INPUTS, row and header.
	 *
	 * Nothing else does. A checkbox cell's content is the fixed markup
	 * {@link CarbonDataTable.getCheckboxHTML} returns, and the engine rewrites a
	 * cell only when its rendered content CHANGES (../engine/table.ts's
	 * `applyContent`) — so that string, identical on every render, is never
	 * written twice and no render has ever moved a `checked`. The only thing
	 * that used to move one was the user's own click on it, which is why
	 * `checkAll` highlighted every row while leaving every row's box unticked,
	 * and why a checked row scrolled out of the virtualized window came back
	 * unticked (a recycled `<td>`, freshly innerHTML'd, holding a brand-new
	 * input).
	 *
	 * Which is also why the state is DERIVED here on every render rather than
	 * written once at the moment of the toggle: `checkMap` is the only place a
	 * row's checked-ness survives, so the DOM has to be caught up to it each
	 * time the renderer hands back a node.
	 */
	syncCheckboxes(): void {
		if (!this.options.checkboxColumn) return;
		const checkMap = this.rowmanager.checkMap;
		const renderer = this.engine.renderer;

		// `.dt-checkbox` is written by `getCheckboxHTML` and nowhere else, so
		// inside the <tbody> the class picks out exactly the row boxes — the
		// same identity `bindCheckboxes` dispatches a `change` on, read back.
		for (const node of renderer.tbody.querySelectorAll(".dt-checkbox")) {
			if (!isCheckboxInput(node)) continue;
			const td = node.closest(".dt-cell");
			if (!td) continue;
			// The row's index in the ORIGINAL data, which is what the profile's
			// `cell` hook writes here and what `checkMap` is keyed by — not the
			// row's position in the render window, and under `treeView` not its
			// position among its siblings either.
			node.checked = !!checkMap[Number(td.getAttribute("data-row-index"))];
		}

		// The header box summarises the rows `checkAll` acts on — the CURRENT
		// row model, i.e. what filtering and (under treeView) collapsing have
		// left visible — so that ticking every row by hand leaves it in the
		// same state ticking it would have.
		const rows = this.engine.table.getRowModel().rows;
		let checked = 0;
		for (const row of rows) if (checkMap[rowIndexOf(row)]) checked++;
		for (const node of renderer.thead.querySelectorAll(".dt-checkbox")) {
			if (!isCheckboxInput(node)) continue;
			node.checked = checked > 0 && checked === rows.length;
			node.indeterminate = checked > 0 && checked < rows.length;
		}
	}

	// ------------------------------------------------------------ public API

	refresh(data?: DataTableData, columns?: DataTableColumnInput[]): this {
		if (columns) this.options.columns = columns;
		if (data) this.options.data = data;
		this.prepare(this.options.columns, this.options.data);
		this.engine.setColumns(this.columns.map((col, i) => this.toEngineColumn(col, i)));
		this.engine.setData(this.options.treeView ? this.treeRoots || [] : this.rows);
		this.engine.options.showTotalRow = this.options.showTotalRow;
		this.engine.options.rowHeight = this.options.cellHeight;
		this.noData = !this.rows.length;
		this.engine.render();
		return this;
	}

	rebuildColumns(): this {
		this.engine.setColumns(this.columns.map((col, i) => this.toEngineColumn(col, i)));
		return this;
	}

	appendRows(rows?: DataTableData): this {
		this.options.data = this.data.concat(rows || []);
		return this.refresh(this.options.data);
	}

	refreshRow(row: DataTableDataRow | null | undefined, rowIndex: DataTableRowIndex): this {
		if (row) {
			// One input row in, exactly one prepared row out.
			const prepared = this.prepareRows([row])[0];
			if (prepared) this.rows[rowIndex] = prepared;
		}
		const cells = this.rows[rowIndex] || [];
		for (const cell of cells) cell.html = null;
		this.engine.render();
		return this;
	}

	updateRow(row: DataTableDataRow | null | undefined, rowIndex: DataTableRowIndex): this {
		return this.refreshRow(row, rowIndex);
	}

	updateCell(
		colIndex: DataTableColIndex,
		rowIndex: DataTableRowIndex,
		options?: Partial<DataTableCell>,
		refreshHtml?: boolean
	): DataTableCell | undefined {
		const cell = this.datamanager.getCell(colIndex, rowIndex);
		if (!cell) return;
		Object.assign(cell, options || {});
		if (refreshHtml !== false) cell.html = null;
		// Keep the ORIGINAL data object in step, because report scripts read it
		// back through `datamanager.getData(rowIndex)`.
		const original = this.data[rowIndex];
		const col = this.columns[colIndex];
		if (original && !Array.isArray(original) && col && options && "content" in options) {
			original[col.id] = options.content;
		}
		this.engine.render();
		return cell;
	}

	render(): this {
		this.noData = !this.rows.length;
		this.engine.render();
		return this;
	}
	renderHeader(): this {
		return this.render();
	}
	renderBody(): this {
		return this.render();
	}
	setDimensions(): this {
		return this.render();
	}

	destroy(): void {
		this.fireEvent("onDestroy");
		if (this.style) this.style.destroy();
		if (this.engine) this.engine.destroy();
		this.container.innerHTML = "";
		this.container.classList.remove("datatable", this.scopeClass);
	}

	getColumn(colIndex: DataTableColIndex): DataTableColumn | undefined {
		return this.datamanager.getColumn(colIndex);
	}
	getColumns(skipStandardColumns?: boolean): DataTableColumn[] {
		return this.datamanager.getColumns(skipStandardColumns);
	}
	getRows(): DataTableRow[] {
		return this.rows;
	}
	getCell(colIndex: DataTableColIndex, rowIndex: DataTableRowIndex): DataTableCell | undefined {
		return this.datamanager.getCell(colIndex, rowIndex);
	}
	getColumnHeaderElement(colIndex: DataTableColIndex): HTMLElement | null {
		return this.engine.getHeaderNode(this.engineColumnId(colIndex));
	}
	getViewportHeight(): number {
		return this.engine.renderer.scroll.clientHeight;
	}

	sortColumn(colIndex: DataTableColIndex, sortOrder: DataTableSortOrder = "none"): void {
		const id = this.engineColumnId(colIndex);
		if (!id) return;
		if (sortOrder === "none") this.engine.table.setSorting([]);
		else this.engine.table.setSorting([{ id, desc: sortOrder === "desc" }]);
		this.fireEvent("onSortColumn", this.columns[colIndex]);
	}

	persistSorting(): void {
		try {
			const key = this.options.sortingKey
				? `${this.options.sortingKey}::sortedColumns`
				: "sortedColumns";
			localStorage.setItem(key, JSON.stringify(this.engine.state.sorting || []));
		} catch (e) {
			/* private mode / quota — sorting simply is not remembered */
		}
	}

	saveSorting(colIndex: DataTableColIndex, sortOrder?: DataTableSortOrder): void {
		this.sortColumn(colIndex, sortOrder);
		this.persistSorting();
	}

	removeColumn(colIndex: DataTableColIndex): void {
		const col = this.columns[colIndex];
		if (!col) return;
		this.options.columns = this.options.columns.filter(
			(_c, i) => i !== colIndex - this.standardColumnCount
		);
		this.refresh(this.options.data, this.options.columns);
		this.fireEvent("onRemoveColumn", col);
	}

	switchColumn(colIndex1: DataTableColIndex, colIndex2: DataTableColIndex): void {
		const a = colIndex1 - this.standardColumnCount;
		const b = colIndex2 - this.standardColumnCount;
		const cols = this.options.columns.slice();
		const first = cols[a];
		const second = cols[b];
		// The JS swapped unconditionally, which for an out-of-range index wrote
		// `undefined` into the list and re-rendered a blank column. Both indices
		// come from a header drag over two live columns, so the guard is
		// unreachable; it is here because a hole is not a column.
		if (first !== undefined && second !== undefined) {
			cols[a] = second;
			cols[b] = first;
		}
		const c1 = this.columns[colIndex1];
		const c2 = this.columns[colIndex2];
		this.refresh(this.options.data, cols);
		this.fireEvent("onSwitchColumn", c1, c2);
	}

	setColumnSticky(colIndex: DataTableColIndex, sticky: boolean): void {
		const col = this.columns[colIndex];
		if (!col) return;
		col.sticky = sticky;
		// `engineIdFor`, not `engineColumnId`: the two return the same string
		// once the column is known to exist, and this one cannot be `null`.
		const column = this.engine.table.getColumn(this.engineIdFor(col, colIndex));
		if (column) column.pin(sticky ? "start" : false);
	}

	scrollToLastColumn(): void {
		const scroll = this.engine.renderer.scroll;
		scroll.scrollLeft = scroll.scrollWidth;
	}

	scrollToRow(rowIndex: DataTableRowIndex): void {
		const rows = this.engine.table.getRowModel().rows;
		const pos = rows.findIndex((r) => rowIndexOf(r) === rowIndex);
		if (pos >= 0) this.engine.scrollToRowIndex(pos, { align: "start" });
	}

	setExpanded(rowIndex: DataTableRowIndex, expanded: boolean): void {
		const row = this.engine.table.getRow(this.rowIdFor(rowIndex));
		// `typeof` rather than the JS's bare truthiness test, for the reason
		// given in `cellHTML`: the member is declared, so a truthiness test on it
		// is a compile error. The guard stays because expansion is opt-in.
		if (row && typeof row.toggleExpanded === "function") row.toggleExpanded(expanded);
	}

	setTreeDepth(depth: number): void {
		const expanded: Record<string, boolean> = {};
		for (const row of this.rows) {
			if ((row.meta.indent || 0) < depth) expanded[this.rowIdFor(row.meta.rowIndex)] = true;
		}
		this.engine.table.setExpanded(expanded);
	}

	applyFilters(filters: DataTableAppliedFilters): Promise<DataTableFilterResult> {
		const next: Array<{ id: string; value: string }> = [];
		const applied = filters || {};
		for (const colIndex in applied) {
			const id = this.engineColumnId(Number(colIndex));
			const value = applied[colIndex];
			if (id && value !== "" && value != null) next.push({ id, value });
		}
		this.engine.table.setColumnFilters(next);
		return Promise.resolve({ rowsToShow: this.datamanager.getFilteredRowIndices() });
	}

	freeze(): void {
		this.freezeContainer.style.display = "";
	}
	unfreeze(): void {
		this.freezeContainer.style.display = "none";
	}

	showToastMessage(message: string, hideAfterSecs?: number): void {
		this.toastMessage.innerHTML = `<span class="dt-toast__message">${message}</span>`;
		if (hideAfterSecs) setTimeout(() => this.clearToastMessage(), hideAfterSecs * 1000);
	}
	clearToastMessage(): void {
		this.toastMessage.innerHTML = "";
	}

	updateOptions(options?: DataTableOptions): void {
		const next = options || {};
		Object.assign(this.options, next);
		// The JS tested `"cellHeight" in (options || {})`. A present-but-undefined
		// key is the only case where these differ, and it is the case where the
		// `in` test forwarded `undefined` into the engine and broke it; every
		// caller that means "change the row height" passes a number.
		if (next.cellHeight !== undefined) this.engine.options.rowHeight = next.cellHeight;
		if ("treeView" in next) this.prepareTree();
		if (next.showTotalRow !== undefined) this.engine.options.showTotalRow = next.showTotalRow;
		this.refresh(this.options.data, this.options.columns);
	}

	/** Upstream binds handlers with `this === datatable`. Report scripts rely on it. */
	fireEvent(name: string, ...args: unknown[]): void {
		const handler = this.events && this.events[name];
		if (!isEventHandler(handler)) return;
		try {
			handler.apply(this, args);
		} catch (e) {
			console.error(`carbon_frappe: datatable event "${name}" failed`, e);
		}
	}

	on(event: string, handler: CarbonDataTableEventHandler): void {
		const existing = this.events[event];
		// A `function`, not an arrow, and `this: unknown` rather than a named
		// receiver: the wrapper's `this` is whatever `fireEvent` applied it with,
		// and it is forwarded on untouched — which is what keeps a report
		// script's `this === datatable` promise through a chained handler.
		this.events[event] = function (this: unknown, ...args: unknown[]): void {
			if (isEventHandler(handler)) handler.apply(this, args);
			if (isEventHandler(existing)) existing.apply(this, args);
		};
	}

	log(...args: unknown[]): void {
		if (this.options.logs) console.log(...args);
	}

	translate(str: string): string {
		const lang = this.options.language;
		const table = (this.options.translations || {})[lang];
		const hit = table ? table[str] : undefined;
		if (typeof hit === "string") return hit;
		return str;
	}

	get rowHeightSize(): CarbonRowSize {
		return nearestRowSize(this.options.cellHeight);
	}
}
