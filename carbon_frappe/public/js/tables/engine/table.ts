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
// Nodes, and a `profile` of legacy-class hooks (see ./classes.ts).
import { constructTable } from "@tanstack/table-core";
import type {
	CellData,
	Column,
	ColumnPinningState,
	ColumnVisibilityState,
	Header,
	Row,
	RowData,
	Table,
	TableFeatures,
	TableOptions,
	TableState,
} from "@tanstack/table-core";
import { CARBON, ROW_SIZES, makeProfile, nearestRowSize, sizeClass } from "./classes";
import type {
	CarbonRowSize,
	CarbonRowSizeClass,
	ResolvedTableClassProfile,
	TableClassProfile,
} from "./classes";
import { buildFeatures } from "./features";
import type { CarbonTableFeatures } from "./features";
import { attr, el, raf, toggleClass } from "./dom";
import type { RafScheduler } from "./dom";
import { sortIcon } from "./icons";
import TableRenderer from "./render";
import type {
	FilterCellEntry,
	HeaderCellEntry,
	NodeLookupKey,
	RenderColumnAlign,
	RenderedContentEntry,
	RowCellEntry,
	RowEntry,
	TableRendererHost,
	TotalCellEntry,
} from "./render";
import RowVirtualizer, { VIRTUAL_THRESHOLD } from "./virtual";
import type { RowScrollToOptions, RowVirtualizerHost } from "./virtual";

// The column spec is carried on the TanStack column def's `meta` bag —
// `toColumnDef` writes it, `getSpec` reads it back, and that round trip is the
// only way the renderer and the adapters ever find a column's spec again.
//
// v9 offers exactly two ways to type that bag: a `columnMeta` type-only slot on
// the features object, or declaration merging on `ColumnMeta`. The slot is out
// of reach — `buildFeatures()` (./features.ts) is not generic in the row type,
// and the spec is, so the slot could not name it — which leaves the merge. It
// is the documented extension point, this app has exactly one TanStack table,
// and it is what makes `getSpec` return a real `CarbonColumnSpec` off a plain
// property read instead of a hand-written predicate that could only ever have
// checked `typeof === "object"`.
declare module "@tanstack/table-core" {
	interface ColumnMeta<
		in out TFeatures extends TableFeatures,
		in out TData extends RowData,
		TValue extends CellData = CellData,
	> {
		/** The engine's own column spec, as `toColumnDef` stored it. */
		spec?: CarbonColumnSpec<TData>;
	}
}

let INSTANCE_SEQ = 0;

// ---------------------------------------------------------------- the row type
//
// The engine is generic over its row data because the three adapters disagree
// about what a row IS: the Grid and the List hand it frappe documents (objects),
// the Report view hands it prepared cell ARRAYS (`DataTableRow extends
// Array<DataTableCell>`). TanStack's own `RowData` covers both, and the datatable
// facade's `CarbonEngine` seam (../datatable/managers.ts) names
// `original: DataTableRow` — so nothing but a real type parameter would let one
// engine satisfy all three.

/** The default row shape: an open bag, or an array of cells. */
export type CarbonTableData = Record<string, unknown> | unknown[];

/** The TanStack table this engine constructs, at its one feature set. */
export type CarbonTableInstance<TData extends RowData> = Table<CarbonTableFeatures, TData>;

/** One of {@link CarbonTableInstance}'s columns. */
export type CarbonColumn<TData extends RowData> = Column<CarbonTableFeatures, TData, unknown>;

/** One of {@link CarbonTableInstance}'s rows. */
export type CarbonRow<TData extends RowData> = Row<CarbonTableFeatures, TData>;

/** One of {@link CarbonTableInstance}'s headers. */
export type CarbonHeader<TData extends RowData> = Header<CarbonTableFeatures, TData, unknown>;

/** The full state snapshot {@link CarbonTable.state} hands back. */
export type CarbonTableState = TableState<CarbonTableFeatures>;

// ------------------------------------------------------------ content results

/**
 * The `{html|text|node}` envelope a renderer may return instead of a bare value.
 * Every member is optional and read in that order — see {@link CarbonTable.applyContent}.
 */
export interface CarbonContentEnvelope {
	node?: Node | null | undefined;
	text?: unknown;
	html?: unknown;
}

/**
 * What a `cell` / `header` renderer hands back. A `Node` is kept by identity
 * (this is what keeps a Grid cell's live frappe control alive); anything else is
 * stringified into `innerHTML`.
 */
export type CarbonRenderResult = Node | string | number | CarbonContentEnvelope | null | undefined;

/**
 * The context the engine calls a column's `cell` renderer with.
 *
 * WHY THE ENGINE'S OWN MEMBERS ARE OPTIONAL. This function is stored in the
 * TanStack column def's `cell` slot, whose declared parameter is TanStack's
 * `CellContext` — so for that assignment to typecheck, a real `CellContext` has
 * to be assignable to this. Everything the engine adds on top (`host`,
 * `colIndex`, `value`) is therefore optional, and `cell` — which the engine uses
 * for the DOM entry, not for TanStack's `Cell` — stays `unknown`. At runtime the
 * engine always passes all of them; no adapter in tree reads anything but `row`.
 */
export interface CarbonCellRenderContext<TData extends RowData> {
	table: CarbonTableInstance<TData>;
	row: CarbonRow<TData>;
	column: CarbonColumn<TData>;
	getValue(): unknown;
	host?: CarbonTable<TData> | undefined;
	colIndex?: number | undefined;
	value?: unknown;
	/** The renderer's cell entry. `unknown` because TanStack's `cell` is a `Cell`. */
	cell?: unknown;
}

/** The context the engine calls a column's `header` renderer with. Same rule as above. */
export interface CarbonHeaderRenderContext<TData extends RowData> {
	column: CarbonColumn<TData>;
	header?: CarbonHeader<TData> | undefined;
	host?: CarbonTable<TData> | undefined;
}

/** A column's body-cell renderer. */
export type CarbonCellRenderer<TData extends RowData> = (
	ctx: CarbonCellRenderContext<TData>
) => CarbonRenderResult;

/** A column's header, either a fixed string or a renderer. */
export type CarbonHeaderTemplate<TData extends RowData> =
	| string
	| ((ctx: CarbonHeaderRenderContext<TData>) => CarbonRenderResult);

// ------------------------------------------------------------- the column spec

/** The filter functions ./features.ts registers, by name. */
export type CarbonFilterFnName = "frappe" | "frappeGlobal";

/** The sort functions ./features.ts registers, by name. */
export type CarbonSortFnName = "frappe" | "alphanumeric" | "basic" | "datetime" | "text";

/**
 * Where a column pins. `"left"`/`"right"` are accepted because frappe's own
 * vocabulary is physical; the engine maps them onto TanStack's logical
 * `start`/`end` in {@link CarbonTable.initialState}.
 */
export type CarbonColumnPinned = "start" | "end" | "left" | "right" | boolean;

/** A column's accessor. Its result is what filters and sorts see. */
export type CarbonAccessorFn<TData extends RowData> = (
	originalRow: TData,
	index: number
) => unknown;

/**
 * A column, as an adapter describes it to the engine.
 *
 * `meta` is the engine's pass-through slot: whatever an adapter puts here comes
 * back out of {@link CarbonTable.getSpec} untouched, so each adapter declares
 * its own view of it (../list/classes.ts's `ListColumnMeta` is one). It is
 * `object` here rather than a bag of `unknown`s precisely so those views stay
 * assignable — an index signature of `unknown` would not be.
 */
export interface CarbonColumnSpec<TData extends RowData = CarbonTableData> {
	/** Unique and stable; it is the column's TanStack id and its DOM `data-col-id`. */
	id: string;
	/** The plain-text label. Used for the header, the filter `<input>`'s title and a11y. */
	label?: string | undefined;
	/** Overrides `label` for rendering only. */
	header?: CarbonHeaderTemplate<TData> | undefined;
	cell?: CarbonCellRenderer<TData> | undefined;
	sortable?: boolean | undefined;
	resizable?: boolean | undefined;
	filterable?: boolean | undefined;
	hideable?: boolean | undefined;
	pinnable?: boolean | undefined;
	filterFn?: CarbonFilterFnName | undefined;
	sortFn?: CarbonSortFnName | undefined;
	meta?: object | undefined;
	size?: number | undefined;
	minSize?: number | undefined;
	maxSize?: number | undefined;
	accessor?: CarbonAccessorFn<TData> | undefined;
	/** Ignored when `accessor` is a function; defaults to `id`. */
	accessorKey?: string | undefined;
	pinned?: CarbonColumnPinned | undefined;
	hidden?: boolean | undefined;
	align?: RenderColumnAlign | undefined;
}

/**
 * The column def the engine builds from a {@link CarbonColumnSpec}.
 *
 * Declared as its own shape rather than as TanStack's `ColumnDef` because
 * `toColumnDef` grows `size`/`minSize`/`maxSize` and one of
 * `accessorFn`/`accessorKey` onto the object AFTER the literal — and `ColumnDef`
 * is a union (`AccessorFnColumnDef | AccessorKeyColumnDef | …`) that no single
 * mutable literal can be typed as while it is still being assembled. The
 * finished object is assignable to that union, which is all `constructTable`
 * asks for — see {@link CarbonTableColumnDef} for the two members that are not.
 */
interface CarbonColumnDef<TData extends RowData> {
	id: string;
	header: CarbonHeaderTemplate<TData> | undefined;
	cell: CarbonCellRenderer<TData> | undefined;
	enableSorting: boolean;
	enableResizing: boolean;
	enableColumnFilter: boolean;
	enableHiding: boolean;
	enablePinning: boolean;
	filterFn: CarbonFilterFnName;
	sortFn: CarbonSortFnName;
	meta: { spec: CarbonColumnSpec<TData> };
	// The five below are written only when there is a value to write, so they
	// are `?: T` rather than `?: T | undefined`: an omitted `size` must reach
	// TanStack as an ABSENT key so `defaultColumn`'s value survives the spread
	// in constructColumn, and `exactOptionalPropertyTypes` is what says so.
	size?: number;
	minSize?: number;
	maxSize?: number;
	accessorFn?: CarbonAccessorFn<TData>;
	accessorKey?: string;
}

/**
 * A finished column def, as `constructTable` is handed it.
 *
 * `cell` and `header` are dropped from the TYPE only; the object still carries
 * both keys, and carrying them is load-bearing. TanStack's own
 * `getDefaultColumnDef()` supplies a `cell` and a `header` of its own
 * (coreColumnsFeature.utils.js:52-58) and the resolved def is a spread of the
 * defaults under ours (constructColumn.js:20-23), so an ABSENT key would let
 * those defaults through — and TanStack's default cell calls
 * `props.renderValue()`, which this engine's cell context has no member for.
 *
 * They are dropped because `ColumnDef` declares them `cell?: ColumnDefTemplate<…>`
 * with no `| undefined`, which under `exactOptionalPropertyTypes` cannot express
 * "present, and undefined" — the very state that does the shadowing. Nothing in
 * TanStack ever reads either one (`flexRender` and `cell.getContext()` are the
 * only consumers and this engine uses neither), and the engine reads its own
 * copies off the spec — see {@link CarbonTable.renderCellContent}.
 */
type CarbonTableColumnDef<TData extends RowData> = Omit<
	CarbonColumnDef<TData>,
	"cell" | "header"
>;

// ------------------------------------------------------------------ the hooks

/** `renderCell` — takes a body cell's contents over entirely. */
export type CarbonCellContentHook<TData extends RowData> = (
	cell: RowCellEntry,
	row: CarbonRow<TData>,
	column: CarbonColumn<TData>,
	colIndex: number,
	host: CarbonTable<TData>
) => void;

/** `renderHeader` — takes a header cell's contents over entirely. */
export type CarbonHeaderContentHook<TData extends RowData> = (
	entry: HeaderCellEntry,
	header: CarbonHeader<TData> | undefined,
	column: CarbonColumn<TData>,
	colIndex: number,
	host: CarbonTable<TData>
) => void;

/** `renderTotal` — fills one cell of the totals row. */
export type CarbonTotalContentHook<TData extends RowData> = (
	entry: TotalCellEntry,
	column: CarbonColumn<TData>,
	colIndex: number,
	host: CarbonTable<TData>
) => void;

/** `renderRowAddendum` — the extra `<tr>` placed immediately after a row. */
export type CarbonRowAddendumHook<TData extends RowData> = (
	row: CarbonRow<TData>,
	leaf: readonly CarbonColumn<TData>[],
	host: CarbonTable<TData>
) => HTMLTableRowElement | null | undefined;

/** `createRowNode` — the adapter's own `<tr>`, or nullish for the engine's. */
export type CarbonRowNodeHook<TData extends RowData> = (
	row: CarbonRow<TData>,
	host: CarbonTable<TData>
) => HTMLTableRowElement | null | undefined;

/** `createCellNode` — the adapter's own `<td>`, or nullish for the engine's. */
export type CarbonCellNodeHook<TData extends RowData> = (
	row: CarbonRow<TData>,
	column: CarbonColumn<TData>,
	colIndex: number,
	host: CarbonTable<TData>
) => HTMLTableCellElement | null | undefined;

/** `createFilterCell` — a truthy result suppresses the engine's own `<input>`. */
export type CarbonFilterCellHook<TData extends RowData> = (
	entry: FilterCellEntry,
	column: CarbonColumn<TData>,
	colIndex: number,
	host: CarbonTable<TData>
) => unknown;

/** `onRowAdopt` — a row's `<tr>` has just entered the DOM. */
export type CarbonRowAdoptHook<TData extends RowData> = (
	row: CarbonRow<TData>,
	entry: RowEntry,
	host: CarbonTable<TData>
) => void;

/** `onRowRelease` — a row's `<tr>` has just left it. */
export type CarbonRowReleaseHook<TData extends RowData> = (
	rowId: string,
	entry: RowEntry,
	host: CarbonTable<TData>
) => void;

/** `renderToolbar` / `renderFooter` — called once, after mount, with the region. */
export type CarbonRegionHook<TData extends RowData> = (
	node: HTMLElement,
	host: CarbonTable<TData>
) => void;

/**
 * An event handler.
 *
 * `this` is the engine, and the arguments are open: `emit` is variadic and
 * `fn.apply(this, args)` is what frappe-datatable's `fireEvent` did, so a
 * handler that wants its first argument as a column narrows it itself. The four
 * events the engine emits are `onDestroy`, `onRender`, `onSortColumn` (the
 * column) and `onFilterColumn` (the column and the typed string).
 */
export type CarbonTableEventHandler<TData extends RowData> = (
	this: CarbonTable<TData>,
	...args: unknown[]
) => void;

/** The `events` bag: handler-per-name, registered at construction. */
export type CarbonTableEvents<TData extends RowData> = Record<
	string,
	CarbonTableEventHandler<TData>
>;

/** `layout` is carried for adapters; the engine sizes through `<colgroup>`. */
export type CarbonTableLayout = "fixed" | "auto";

/** Writing direction. `"rtl"` puts `dir="rtl"` on the container. */
export type CarbonTableDirection = "ltr" | "rtl";

/** `true`/`false` force windowing on or off; `"auto"` decides on the row count. */
export type CarbonTableVirtualize = boolean | "auto";

/** The per-instance scope class the engine puts on its container. */
export type CarbonTableScopeClass = `cf-table-instance-${number}`;

/**
 * What a caller hands the constructor.
 *
 * EVERY KEY IS OPTIONAL AND NONE ACCEPTS AN EXPLICIT `undefined`. That is not
 * pedantry: the merge is `Object.assign({}, DEFAULTS, options)`, so passing
 * `{ direction: undefined }` does not fall back to the default — it OVERWRITES
 * it with `undefined`. Declaring these `?: T` rather than `?: T | undefined`
 * (under `exactOptionalPropertyTypes`) is what makes that unrepresentable, and
 * it is what lets {@link ResolvedCarbonTableOptions} promise the plain
 * `direction: "ltr" | "rtl"` / `emptyMessage: string` / `inlineFilters: boolean`
 * that ./render.ts's `TableRendererOptions` requires. A caller holding an
 * optional value passes `x ?? <the default>`, or omits the key.
 *
 * The hook slots take `| null` because that is what {@link DEFAULTS} holds and
 * what an adapter passes to mean "no hook" (../datatable/datatable.ts's
 * `getSubRows` does exactly that).
 */
export interface CarbonTableOptions<TData extends RowData = CarbonTableData> {
	columns?: readonly CarbonColumnSpec<TData>[];
	data?: readonly TData[];
	/** A stable row identity. Without one, TanStack keys rows by index. */
	getRowId?: ((originalRow: TData, index: number, parent?: CarbonRow<TData>) => string) | null;
	/** Tree children, for the Report view's `treeView`. */
	getSubRows?: ((originalRow: TData, index: number) => undefined | readonly TData[]) | null;
	/** Requested px row height; snapped to the nearest Carbon row size. */
	rowHeight?: number;
	layout?: CarbonTableLayout;
	direction?: CarbonTableDirection;
	inlineFilters?: boolean;
	showTotalRow?: boolean;
	stickyHeader?: boolean;
	selectable?: boolean;
	expandable?: boolean;
	sortable?: boolean;
	resizable?: boolean;
	reorderable?: boolean;
	virtualize?: CarbonTableVirtualize;
	emptyMessage?: string;
	/** A CSS length capping the scroll viewport, or `null` to size to content. */
	scrollHeight?: string | null;
	defaultColumnSize?: number;
	minColumnSize?: number;
	maxColumnSize?: number;
	profile?: TableClassProfile<CarbonTable<TData>> | null;
	events?: CarbonTableEvents<TData> | null;
	renderCell?: CarbonCellContentHook<TData> | null;
	renderHeader?: CarbonHeaderContentHook<TData> | null;
	renderTotal?: CarbonTotalContentHook<TData> | null;
	renderRowAddendum?: CarbonRowAddendumHook<TData> | null;
	createRowNode?: CarbonRowNodeHook<TData> | null;
	createCellNode?: CarbonCellNodeHook<TData> | null;
	createFilterCell?: CarbonFilterCellHook<TData> | null;
	onRowAdopt?: CarbonRowAdoptHook<TData> | null;
	onRowRelease?: CarbonRowReleaseHook<TData> | null;
	renderToolbar?: CarbonRegionHook<TData> | null;
	renderFooter?: CarbonRegionHook<TData> | null;
	/**
	 * Merged over the engine's own pinning/visibility seed. The one option with
	 * no entry in {@link DEFAULTS}, so it stays optional after the merge too.
	 */
	initialState?: Partial<CarbonTableState>;
}

/**
 * The options bag as the engine holds it — `this.options`, after the DEFAULTS
 * merge, with every defaulted key now present.
 */
export type ResolvedCarbonTableOptions<TData extends RowData = CarbonTableData> = Required<
	Omit<CarbonTableOptions<TData>, "initialState">
> &
	Pick<CarbonTableOptions<TData>, "initialState">;

/**
 * The two shapes `@tanstack/store`'s `subscribe()` has been known to return.
 * See the note at the subscription site.
 */
type CarbonTableStoreTeardown = (() => void) | { unsubscribe: () => void };

const DEFAULTS: ResolvedCarbonTableOptions = {
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

/**
 * The spec behind a column, straight off its `columnDef`.
 *
 * Separate from {@link CarbonTable.getSpec} because the render path already
 * HOLDS the column: `getSpec` accepts an id and therefore has to go through
 * `table.getColumn()`, and paying for that lookup once per cell per render is
 * exactly what the JS version did not do.
 */
function specOf<TData extends RowData>(
	column: CarbonColumn<TData>
): CarbonColumnSpec<TData> | null {
	const meta = column.columnDef.meta;
	return meta && meta.spec ? meta.spec : null;
}

/** Is `value` a DOM node? Duck-typed on `nodeType`, as the JS version was. */
function isRenderNode(value: unknown): value is Node {
	if (typeof value !== "object" || value === null) return false;
	// `instanceof Node` would be the obvious test and is the wrong one: it is
	// per-document, and frappe renders into iframes (print, PDF preview).
	return "nodeType" in value && Boolean(value.nodeType);
}

export default class CarbonTable<TData extends RowData = CarbonTableData>
	implements TableRendererHost<CarbonTable<TData>>, RowVirtualizerHost
{
	readonly instanceId: number;
	readonly scopeClass: CarbonTableScopeClass;
	options: ResolvedCarbonTableOptions<TData>;
	readonly profile: ResolvedTableClassProfile<CarbonTable<TData>>;
	readonly handlers: Map<string, CarbonTableEventHandler<TData>[]>;
	filtersVisible: boolean;
	destroyed: boolean;

	readonly renderer: TableRenderer<CarbonTable<TData>>;
	readonly virtualizer: RowVirtualizer;
	readonly scheduleRender: RafScheduler;

	readonly features: CarbonTableFeatures;
	/** The specs the current column model was built from, in order. */
	columnSpecs: CarbonColumnSpec<TData>[];
	readonly table: CarbonTableInstance<TData>;

	/** The element the engine mounted into. */
	readonly container: HTMLElement;

	/** The store subscription, dropped in {@link destroy}. */
	_subscription: CarbonTableStoreTeardown | null;

	constructor(
		container: string | Element | null | undefined,
		options: CarbonTableOptions<TData> = {}
	) {
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

		// Read into a local first: `on()` is a call, and a narrowing held on
		// `this.options.events` across one would be the compiler's to keep, not
		// something this loop should depend on.
		const events = this.options.events;
		if (events) {
			for (const name in events) this.on(name, events[name]);
		}

		this.renderer = new TableRenderer<CarbonTable<TData>>(this);
		this.virtualizer = new RowVirtualizer(this);
		this.scheduleRender = raf(() => this.render());

		this.features = buildFeatures();
		this.columnSpecs = this.options.columns.slice();
		this.table = this.buildTable();
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

	/**
	 * Construct the TanStack instance from `this.options`.
	 *
	 * Returns it rather than assigning `this.table` itself, so the constructor
	 * holds the only assignment: with `features`, `columnSpecs` and `table` all
	 * written there, none of the three needs `| undefined` or a
	 * definite-assignment assertion. Nothing else moves — this is still called
	 * exactly once, from the constructor, with the other two already in place.
	 */
	buildTable(): CarbonTableInstance<TData> {
		const o = this.options;

		const opts: TableOptions<CarbonTableFeatures, TData> = {
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

		return constructTable(opts);
	}

	initialState(): Partial<CarbonTableState> {
		const o = this.options;
		const pinning: ColumnPinningState = { start: [], end: [] };
		for (const spec of o.columns) {
			if (spec.pinned === "end" || spec.pinned === "right") pinning.end.push(spec.id);
			else if (spec.pinned) pinning.start.push(spec.id);
		}
		const visibility: ColumnVisibilityState = {};
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
	toColumnDef(spec: CarbonColumnSpec<TData>): CarbonTableColumnDef<TData> {
		const def: CarbonColumnDef<TData> = {
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

	on(name: string, handler: CarbonTableEventHandler<TData> | null | undefined): this {
		if (typeof handler !== "function") return this;
		// One `get` where the JS did `has` then `get`: the map never holds an
		// undefined value, so an absent list and a missing key are the same
		// thing, and this is what makes `push` definite.
		let list = this.handlers.get(name);
		if (!list) {
			list = [];
			this.handlers.set(name, list);
		}
		list.push(handler);
		return this;
	}

	off(name: string, handler: CarbonTableEventHandler<TData>): this {
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
	emit(name: string, ...args: unknown[]): void {
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
	get state(): CarbonTableState {
		return this.table.store.state;
	}

	/** The Carbon row size this table's requested `rowHeight` snaps to. */
	get rowSize(): CarbonRowSize {
		return nearestRowSize(this.options.rowHeight);
	}

	get sizeClass(): CarbonRowSizeClass {
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
	get rowHeightPx(): number {
		return ROW_SIZES[this.rowSize];
	}

	setData(data: readonly TData[] | null | undefined): this {
		this.options.data = data || [];
		this.table.setOptions((prev) => Object.assign({}, prev, { data: this.options.data }));
		this.scheduleRender();
		return this;
	}

	setColumns(columns: readonly CarbonColumnSpec<TData>[] | null | undefined): this {
		this.options.columns = columns || [];
		this.columnSpecs = this.options.columns.slice();
		this.table.setOptions((prev) =>
			Object.assign({}, prev, { columns: this.columnSpecs.map((s) => this.toColumnDef(s)) })
		);
		this.scheduleRender();
		return this;
	}

	refresh(
		data?: readonly TData[] | null | undefined,
		columns?: readonly CarbonColumnSpec<TData>[] | null | undefined
	): this {
		if (columns) this.setColumns(columns);
		if (data) this.setData(data);
		this.render();
		return this;
	}

	/**
	 * The spec behind a column, by handle or by id.
	 *
	 * The parameter is `column | id` and NOT `| null | undefined`, even though
	 * the `&&` below still tolerates a nullish handle: a profile hook reaches
	 * this through its own view of the host (../list/classes.ts's
	 * `ListClassHost`), and a parameter that admitted `null` would make the two
	 * signatures unrelated in BOTH directions — which is the one thing that
	 * would stop a profile typed against that view from being handed to the
	 * engine at all.
	 */
	getSpec(columnOrId: CarbonColumn<TData> | string): CarbonColumnSpec<TData> | null {
		const id = typeof columnOrId === "string" ? columnOrId : columnOrId && columnOrId.id;
		// `getColumn` demands a string; a nullish id could only ever have missed,
		// so it short-circuits to the same `undefined` the lookup returned.
		const column = typeof id === "string" ? this.table.getColumn(id) : undefined;
		return column ? specOf(column) : null;
	}

	/**
	 * Set one column's width in px. v9 has no `column.setSize`; sizing is a
	 * single table-level state slice, which is also why the renderer can write
	 * every width to <colgroup> in one pass.
	 */
	setColumnSize(columnId: string, px: number): this {
		this.table.setColumnSizing((prev) => Object.assign({}, prev, { [columnId]: px }));
		return this;
	}

	/** Current width of a column in px, honouring any active resize. */
	getColumnSize(columnId: string): number | null {
		const column = this.table.getColumn(columnId);
		return column ? column.getSize() : null;
	}

	/** Invoke a region hook once; a failure must not take the table down. */
	fillRegion(name: "renderToolbar" | "renderFooter", node: HTMLElement | null | undefined): void {
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
	setExpandedRow(rowId: string | null | undefined): this {
		this.table.setExpanded(rowId == null ? {} : { [rowId]: true });
		return this;
	}

	toggleFilters(show?: boolean): boolean {
		this.filtersVisible = show === undefined ? !this.filtersVisible : !!show;
		if (!this.filtersVisible) this.table.resetColumnFilters();
		this.scheduleRender();
		return this.filtersVisible;
	}

	destroy(): void {
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

	render(): void {
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
	shouldVirtualize(count: number): boolean {
		const mode = this.options.virtualize;
		if (mode === false) return false;
		if (this.hasVariableHeightRows()) return false;
		if (mode === true) return true;
		return count >= VIRTUAL_THRESHOLD;
	}

	hasVariableHeightRows(): boolean {
		if (typeof this.options.renderRowAddendum !== "function") return false;
		const expanded = this.state.expanded;
		if (!expanded) return false;
		if (expanded === true) return true;
		return Object.keys(expanded).some((k) => expanded[k]);
	}

	getRenderRows(): { rows: CarbonRow<TData>[]; paddingTop: number; paddingBottom: number } {
		const rows = this.table.getRowModel().rows;
		const win = this.virtualizer.window(rows.length);
		return {
			rows: rows.slice(win.start, win.end),
			paddingTop: win.paddingTop,
			paddingBottom: win.paddingBottom,
		};
	}

	columnAlign(column: CarbonColumn<TData>): RenderColumnAlign {
		const spec = this.getSpec(column);
		return (spec && spec.align) || "left";
	}

	columnLabel(column: CarbonColumn<TData>): string {
		const spec = this.getSpec(column);
		if (spec && spec.label != null) return String(spec.label);
		const header = column.columnDef.header;
		return typeof header === "string" ? header : column.id;
	}

	columnFilterable(column: CarbonColumn<TData>): boolean {
		const spec = this.getSpec(column);
		return !(spec && spec.filterable === false);
	}

	/**
	 * Write `result` into `target`, doing nothing when it has not changed.
	 * Accepts a Node (identity-preserved — this is what keeps a Grid cell's live
	 * control alive), an HTML string, or `{html|text|node}`.
	 */
	applyContent(entry: RenderedContentEntry, target: HTMLElement, result: unknown): void {
		if (isRenderNode(result)) {
			if (entry.rendered !== result) {
				target.textContent = "";
				target.appendChild(result);
				entry.rendered = result;
			}
			return;
		}
		if (result && typeof result === "object") {
			// `in` is what an open value costs: the three keys are read exactly
			// as the JS read them, and an object carrying none of them falls
			// through to the stringify below with `result` already undefined.
			if ("node" in result && result.node) return this.applyContent(entry, target, result.node);
			if ("text" in result && result.text != null) {
				const text = String(result.text);
				if (entry.rendered !== text) {
					target.textContent = text;
					entry.rendered = text;
				}
				return;
			}
			result = "html" in result ? result.html : undefined;
		}
		const html = result == null ? "" : String(result);
		if (entry.rendered !== html) {
			target.innerHTML = html;
			entry.rendered = html;
		}
	}

	renderCellContent(
		cell: RowCellEntry,
		row: CarbonRow<TData>,
		column: CarbonColumn<TData>,
		colIndex: number
	): void {
		if (typeof this.options.renderCell === "function") {
			this.options.renderCell(cell, row, column, colIndex, this);
			return;
		}
		// The renderer is read off the SPEC, not off `columnDef.cell`, even
		// though `toColumnDef` puts the same function in both. Once it is in the
		// column def its declared parameter is TanStack's `CellContext` — a
		// context this engine does not build and does not want to (it would mean
		// materialising a `Cell` per cell per render). The spec keeps the
		// engine's own signature, and it is one property read either way.
		const spec = specOf(column);
		const ctx: CarbonCellRenderContext<TData> = {
			table: this.table,
			host: this,
			row,
			column,
			colIndex,
			getValue: () => row.getValue(column.id),
			value: row.getValue(column.id),
			cell: cell,
		};
		const render = spec ? spec.cell : undefined;
		const out = typeof render === "function" ? render(ctx) : ctx.value;
		this.applyContent(cell, cell.content, out);
	}

	renderHeaderContent(
		entry: HeaderCellEntry,
		header: CarbonHeader<TData> | undefined,
		column: CarbonColumn<TData>,
		colIndex: number
	): void {
		if (typeof this.options.renderHeader === "function") {
			this.options.renderHeader(entry, header, column, colIndex, this);
			return;
		}
		const label = this.columnLabel(column);
		const sortable = column.getCanSort && column.getCanSort();

		if (!sortable) {
			// Off the spec, for the reason given in renderCellContent. Reading
			// `columnDef.header` instead would be equivalent: it holds
			// `spec.header` when there is one and `spec.label` — a string, never
			// a function — when there is not.
			const spec = specOf(column);
			const def = spec ? spec.header : undefined;
			const out = typeof def === "function" ? def({ header, column, host: this }) : label;
			this.applyContent(entry, entry.content, out);
			entry.th.classList.remove(CARBON.sortHeaderCell);
			attr(entry.th, "aria-sort", null);
			return;
		}

		entry.th.classList.add(CARBON.sortHeaderCell);
		const direction = column.getIsSorted();
		attr(entry.th, "aria-sort", direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none");

		// The four chrome nodes are held in locals as well as on the entry:
		// HeaderCellEntry declares them as four independent optional fields
		// (that is where the object is created — ./render.ts), so nothing but a
		// local carries the fact that this branch just built all of them.
		let button = entry.button;
		let labelNode = entry.labelNode;
		let iconNode = entry.iconNode;
		if (!button) {
			button = el("button", {
				className: CARBON.sortHeader,
				attrs: { type: "button" },
			});
			const flex = el("span", { className: CARBON.sortFlex });
			labelNode = el("div", { className: CARBON.headerLabel });
			iconNode = el("span", { className: "cf-table__sort-icon" });
			flex.appendChild(labelNode);
			flex.appendChild(iconNode);
			button.appendChild(flex);
			entry.content.appendChild(button);
			button.addEventListener("click", (e) => {
				const handler = column.getToggleSortingHandler();
				if (handler) handler(e);
				this.emit("onSortColumn", column);
			});
			entry.button = button;
			entry.flex = flex;
			entry.labelNode = labelNode;
			entry.iconNode = iconNode;
		}
		// `labelNode` and `iconNode` are only ever written beside `button`, so an
		// entry that has the button has all three; these two guards are what the
		// separate optional fields cost, not a case that happens.
		if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
		toggleClass(button, CARBON.sortActive, !!direction);
		toggleClass(button, CARBON.sortDescending, direction === "desc");
		const iconHtml = sortIcon(direction);
		if (iconNode && entry.iconHtml !== iconHtml) {
			iconNode.innerHTML = iconHtml;
			entry.iconHtml = iconHtml;
		}
		this.wireResizeHandle(entry, header, column);
	}

	/** Carbon puts the resize affordance on the header cell's trailing edge. */
	wireResizeHandle(
		entry: HeaderCellEntry,
		header: CarbonHeader<TData> | undefined,
		column: CarbonColumn<TData>
	): void {
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

	wireFilterInput(entry: FilterCellEntry, column: CarbonColumn<TData>): void {
		// ./render.ts calls this immediately after assigning `entry.input`, and
		// never for an adapter-supplied cell — which is the only case that
		// leaves it null. Holding it in a local both proves that and is what the
		// two listeners close over, exactly as they closed over `entry.input`.
		const input = entry.input;
		if (!input) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		input.addEventListener("input", () => {
			clearTimeout(timer);
			const value = input.value;
			// 300ms matches frappe-datatable's inline-filter debounce, so typing
			// feels identical to what report users are used to.
			timer = setTimeout(() => {
				column.setFilterValue(value === "" ? undefined : value);
				this.emit("onFilterColumn", column, value);
			}, 300);
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				input.value = "";
				column.setFilterValue(undefined);
			}
		});
	}

	renderTotalContent(entry: TotalCellEntry, column: CarbonColumn<TData>, colIndex: number): void {
		if (typeof this.options.renderTotal === "function") {
			this.options.renderTotal(entry, column, colIndex, this);
			return;
		}
		this.applyContent(entry, entry.content, "");
	}

	renderRowAddendum(
		row: CarbonRow<TData>,
		leaf: readonly CarbonColumn<TData>[]
	): HTMLTableRowElement | null | undefined {
		if (typeof this.options.renderRowAddendum === "function") {
			return this.options.renderRowAddendum(row, leaf, this);
		}
		return null;
	}

	/**
	 * Let an adapter supply the <tr>. Returning null keeps the engine's own.
	 * See render.ts#renderRow for why this seam exists.
	 */
	createRowNode(row: CarbonRow<TData>): HTMLTableRowElement | null | undefined {
		return typeof this.options.createRowNode === "function"
			? this.options.createRowNode(row, this)
			: null;
	}

	/** Let an adapter own a filter cell's contents. Truthy skips the default input. */
	createFilterCell(entry: FilterCellEntry, column: CarbonColumn<TData>, colIndex: number): unknown {
		return typeof this.options.createFilterCell === "function"
			? this.options.createFilterCell(entry, column, colIndex, this)
			: null;
	}

	/** Let an adapter supply the <td>. Returning null keeps the engine's own. */
	createCellNode(
		row: CarbonRow<TData>,
		column: CarbonColumn<TData>,
		colIndex: number
	): HTMLTableCellElement | null | undefined {
		return typeof this.options.createCellNode === "function"
			? this.options.createCellNode(row, column, colIndex, this)
			: null;
	}

	adoptRow(row: CarbonRow<TData>, entry: RowEntry): void {
		if (typeof this.options.onRowAdopt === "function") this.options.onRowAdopt(row, entry, this);
	}

	releaseRow(rowId: string, entry: RowEntry): void {
		if (typeof this.options.onRowRelease === "function")
			this.options.onRowRelease(rowId, entry, this);
	}

	// ------------------------------------------------------------------ lookup

	getRowNode(rowId: NodeLookupKey): HTMLTableRowElement | null {
		return this.renderer.getRowNode(rowId);
	}

	getCellNode(rowId: NodeLookupKey, colId: NodeLookupKey): HTMLTableCellElement | null {
		return this.renderer.getCellNode(rowId, colId);
	}

	getHeaderNode(colId: NodeLookupKey): HTMLTableCellElement | null {
		return this.renderer.getHeaderNode(colId);
	}

	scrollToRowIndex(index: number, opts?: RowScrollToOptions): void {
		this.virtualizer.scrollToIndex(index, opts);
	}

	get wrapper(): HTMLElement {
		return this.container;
	}
}
