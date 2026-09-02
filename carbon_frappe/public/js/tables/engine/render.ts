// Keyed, incremental DOM renderer for CarbonTable.
//
// WHY NOT A FULL RE-RENDER. The obvious vanilla approach — rebuild <tbody> from
// `table.getRowModel()` on every store change — is wrong here for two reasons
// specific to frappe:
//
//   1. Grid cells contain LIVE frappe controls (`frappe.ui.form.make_control`
//      mounts a Link/Select/Date control with an awesomplete or air-datepicker
//      instance bound to the input). Replacing the cell node destroys the
//      control, drops its handlers, and closes an open dropdown mid-keystroke.
//   2. Report-view cells are edited in place; blowing away the focused cell on
//      the very state change the edit caused loses the caret.
//
// So rows are keyed by `row.id`, cells by `column.id`, nodes are reused across
// renders, and content is written only when it differs. A cell whose columnDef
// returns a Node (the Grid's case) keeps that exact Node forever.
import { attr, el, reconcileOrder, setStyles, toggleClass } from "./dom";
import { CARBON, applyProfile } from "./classes";
import type { CarbonRowSizeClass, ResolvedTableClassProfile } from "./classes";

/** Marker on nodes we own, so adapters can tell engine DOM from their own. */
const OWNED = "__carbon_table_node";

/** Marker on a child row whose hover mirroring is already bound. */
const CHILD_HOVER = "__carbon_child_hover";

// Both markers are real properties on the element rather than a WeakSet the
// renderer keeps to itself: "adapters can tell engine DOM from their own" means
// code outside this module — including third-party report scripts — reads them
// off a node it found in the DOM, so they are part of the emitted contract.
declare global {
	interface Element {
		/** Set by the table engine on every node it built itself. */
		__carbon_table_node?: boolean;
		/** Set on an addendum row whose parent-hover mirroring is bound. */
		__carbon_child_hover?: boolean;
	}
}

// ------------------------------------------------------------- the host seam
//
// Everything down to `TableRendererHost` types the CarbonTable surface this
// renderer drives. It is declared HERE, structurally, rather than imported from
// ./table, because table.js imports THIS module: the two are mutually dependent
// and the dependency has to point one way (./virtual does the same with
// `RowVirtualizerHost`).
//
// The TanStack handles are declared structurally for a second reason: `Column`,
// `Row`, `Header` and `Table` are all `in out` in their feature set AND their
// data type, so naming a concrete instantiation would pin this file to one
// `TData` the engine deliberately does not have. Every member below is copied
// from the shipped `.d.ts`, so a real TanStack object satisfies these by
// structure.

/** Where a column is pinned. TanStack v9 pins logically: 'start' / 'end'. */
export type RenderPinnedPosition = "start" | "end";

/** How a column's cells are aligned — `host.columnAlign`'s answer. */
export type RenderColumnAlign = "left" | "right" | "center";

/** The slice of TanStack's `Column` the renderer reads. */
export interface RenderColumn {
	readonly id: string;
	/** Width in px, honouring an in-flight resize; written to `<colgroup>`. */
	getSize(): number;
	getIsPinned(): RenderPinnedPosition | false;
	/** Distance from the leading edge for a start-pinned column, in px. */
	getStart(position: RenderPinnedPosition): number;
	/** Distance from the trailing edge for an end-pinned column, in px. */
	getAfter(position: RenderPinnedPosition): number;
	getIsLastColumn(position: RenderPinnedPosition): boolean;
	getIsFirstColumn(position: RenderPinnedPosition): boolean;
	/** Open, as TanStack declares it: the filter row `String()`s it. */
	getFilterValue(): unknown;
}

/**
 * The slice of TanStack's `Row` the renderer reads.
 *
 * `getIsSelected` / `getIsExpanded` are optional because the renderer guards
 * both — they exist only while the selection and expanding features are
 * registered, and a row model built without them must still render.
 */
export interface RenderRow {
	readonly id: string;
	readonly index: number;
	readonly depth: number;
	/** Whatever the adapter handed the engine as data. Narrow before reading. */
	readonly original: unknown;
	getIsSelected?(): boolean;
	getIsExpanded?(): boolean;
}

/**
 * The slice of TanStack's `Header` the renderer passes through.
 *
 * The renderer itself reads only `column.id`, to pair a header with its leaf
 * column; `getResizeHandler` is here because it is what table.js binds to
 * `mousedown` / `touchstart` on the header it is handed back.
 */
export interface RenderHeader {
	readonly column: { readonly id: string };
	getResizeHandler(context?: Document): (event: unknown) => void;
}

/** One row of the header group model — the renderer uses only the last group. */
export interface RenderHeaderGroup {
	readonly headers: readonly RenderHeader[];
}

/** The slice of TanStack's `Table` the renderer reads. */
export interface RenderTable {
	getVisibleLeafColumns(): readonly RenderColumn[];
	getHeaderGroups(): readonly RenderHeaderGroup[];
	/** Total px width of every visible column — the `<table>`'s own width. */
	getTotalSize(): number;
	getRowModel(): { readonly rows: readonly RenderRow[] };
}

/** The window of rows to draw, as `host.getRenderRows()` reports it. */
export interface RenderRowSlice {
	readonly rows: readonly RenderRow[];
	/** Height of the leading spacer row, in px. */
	readonly paddingTop: number;
	/** Height of the trailing spacer row, in px. */
	readonly paddingBottom: number;
}

/** The options the renderer reads off its host. CarbonTable owns the rest. */
export interface TableRendererOptions {
	/** `"rtl"` puts `dir="rtl"` on the container. */
	direction: "ltr" | "rtl";
	/** Shown in `div.cf-table__empty`; interpolated into a `<span>` as HTML. */
	emptyMessage: string;
	/** Whether an inline-filter row exists at all — `host.filtersVisible` shows it. */
	inlineFilters: boolean;
	/** Emit Carbon's expandable-row contract and mirror child-row hover. */
	expandable: boolean;
	showTotalRow: boolean;
	/** `false` opts out of the sticky header. */
	stickyHeader: boolean;
}

/** What `applyContent` (table.js) remembers it last wrote into a cell. */
export type RenderedContent = Node | string | undefined;

/** A cell whose last-written content is cached, so a no-op write is skipped. */
export interface RenderedContentEntry {
	rendered: RenderedContent;
}

/**
 * A header cell.
 *
 * The renderer builds it with the first four members; table.js#renderHeaderContent
 * and #wireResizeHandle grow the sort button and the resize handle onto the same
 * object, and both files must agree about it — hence one type here, where the
 * object is created.
 */
export interface HeaderCellEntry extends RenderedContentEntry {
	readonly th: HTMLTableCellElement;
	/** The inner `div.cf-table__cell-content`. */
	readonly content: HTMLElement;
	wired: boolean;
	/** Carbon's sort button, built on first render of a sortable column. */
	button?: HTMLButtonElement | undefined;
	flex?: HTMLSpanElement | undefined;
	labelNode?: HTMLDivElement | undefined;
	iconNode?: HTMLSpanElement | undefined;
	/** Last sort glyph written, so an unchanged icon is not re-parsed. */
	iconHtml?: string | undefined;
	/** The resize affordance; `null` once removed from a no-longer-resizable column. */
	resizer?: HTMLSpanElement | null | undefined;
}

/**
 * A filter cell. `input` is the engine's own `<input>`, and stays `null` when
 * the adapter supplied the cell's contents itself.
 */
export interface FilterCellEntry {
	readonly td: HTMLTableCellElement;
	input: HTMLInputElement | null;
}

/**
 * A body cell. For an adapter-supplied cell `td` and `content` are the SAME
 * node — the adapter owns everything inside it, which is what `adapterOwned`
 * tells the renderer.
 */
export interface RowCellEntry extends RenderedContentEntry {
	readonly td: HTMLTableCellElement;
	readonly content: HTMLElement;
	adapterOwned?: boolean | undefined;
}

/** A body row and its cells, keyed by column id. */
export interface RowEntry {
	readonly tr: HTMLTableRowElement;
	readonly cells: Map<string, RowCellEntry>;
	/** True when the adapter supplied the `<tr>` (the Grid does). */
	readonly adapterOwned: boolean;
}

/** A total-row cell. */
export interface TotalCellEntry extends RenderedContentEntry {
	readonly td: HTMLTableCellElement;
	/** The inner `div.cf-table__cell-content`. */
	readonly content: HTMLElement;
}

/**
 * What the three node lookups accept. They `String()` their argument because
 * adapters address rows and columns by index as readily as by id — frappe's
 * datatable API is index-based throughout.
 */
export type NodeLookupKey = string | number | null | undefined;

/**
 * The CarbonTable surface this renderer drives.
 *
 * `THost` is the concrete engine type, and it exists for ONE member: `profile`.
 * A class profile's hooks are handed `ctx.host` and reach real CarbonTable
 * methods through it (`gridProfile` and `listProfile` both call
 * `ctx.host.getSpec(...)`), so an adapter writes its hooks against the engine,
 * not against this interface. A hook is a function-typed property, so its
 * parameters are checked CONTRAVARIANTLY: a
 * `ResolvedTableClassProfile<CarbonTable>` is assignable to a
 * `ResolvedTableClassProfile<X>` only when `X` is assignable to `CarbonTable` —
 * and this interface, being the smaller type, is not. Naming the host as a
 * parameter is what makes the profile line up, and it costs the implementer
 * three mentions: `implements TableRendererHost<CarbonTable>`, the `renderer`
 * field's type, and the `new TableRenderer(this)` call (which infers it).
 */
export interface TableRendererHost<THost> {
	readonly options: TableRendererOptions;
	readonly profile: ResolvedTableClassProfile<THost>;
	readonly table: RenderTable;
	/** The Carbon row-size modifier class, e.g. `cds--data-table--lg`. */
	readonly sizeClass: CarbonRowSizeClass;
	/** Whether the inline-filter row is currently shown. */
	readonly filtersVisible: boolean;

	/** The rows to draw plus the two spacer heights standing in for the rest. */
	getRenderRows(): RenderRowSlice;

	columnAlign(column: RenderColumn): RenderColumnAlign;
	columnLabel(column: RenderColumn): string;
	columnFilterable(column: RenderColumn): boolean;

	renderHeaderContent(
		entry: HeaderCellEntry,
		header: RenderHeader | undefined,
		column: RenderColumn,
		colIndex: number
	): void;
	renderCellContent(
		cell: RowCellEntry,
		row: RenderRow,
		column: RenderColumn,
		colIndex: number
	): void;
	renderTotalContent(entry: TotalCellEntry, column: RenderColumn, colIndex: number): void;

	/** The adapter's extra `<tr>` for this row, placed immediately after it. */
	renderRowAddendum(
		row: RenderRow,
		leaf: readonly RenderColumn[]
	): HTMLTableRowElement | null | undefined;

	/** The adapter's own `<tr>`, or nullish to let the engine build one. */
	createRowNode(row: RenderRow): HTMLTableRowElement | null | undefined;
	/** The adapter's own `<td>`, or nullish to let the engine build one. */
	createCellNode(
		row: RenderRow,
		column: RenderColumn,
		colIndex: number
	): HTMLTableCellElement | null | undefined;
	/**
	 * Let the adapter fill a filter cell. Only the TRUTHINESS of the result is
	 * read — a truthy answer suppresses the engine's own `<input>` — so this
	 * stays open rather than pinning adapters to one return shape.
	 */
	createFilterCell(entry: FilterCellEntry, column: RenderColumn, colIndex: number): unknown;
	/** Bind the engine's own filter `<input>` to the column's filter value. */
	wireFilterInput(entry: FilterCellEntry, column: RenderColumn): void;

	adoptRow(row: RenderRow, entry: RowEntry): void;
	releaseRow(rowId: string, entry: RowEntry): void;
}

export default class TableRenderer<THost extends TableRendererHost<THost>> {
	readonly host: THost;
	/** rowId -> the row's `<tr>` and its cells, keyed by column id. */
	readonly rows: Map<string, RowEntry>;
	/** rowId -> the adapter's addendum `<tr>`. */
	readonly addenda: Map<string, HTMLTableRowElement>;
	/** colId -> the header cell. */
	readonly headerCells: Map<string, HeaderCellEntry>;
	/** colId -> the filter cell and its `<input>`. */
	readonly filterCells: Map<string, FilterCellEntry>;
	/** colId -> the total-row cell. */
	readonly footCells: Map<string, TotalCellEntry>;
	/** colId -> the `<col>` carrying that column's width. */
	readonly cols: Map<string, HTMLTableColElement>;
	mounted: boolean;

	/** The element mounted into; only known once {@link mount} has run. */
	container: HTMLElement | undefined;
	readonly toolbar: HTMLElement;
	readonly scroll: HTMLDivElement;
	readonly table: HTMLTableElement;
	readonly colgroup: HTMLTableColElement;
	readonly thead: HTMLTableSectionElement;
	readonly tbody: HTMLTableSectionElement;
	readonly tfoot: HTMLTableSectionElement;
	readonly empty: HTMLDivElement;
	readonly footer: HTMLDivElement;
	readonly spacerTop: HTMLTableRowElement;
	readonly spacerBottom: HTMLTableRowElement;
	/**
	 * The spacer rows' single cells, held rather than re-found through
	 * `spacerTop.firstChild` — that is a `ChildNode`, and the height and colspan
	 * written to it every render need an element.
	 */
	readonly _spacerTopCell: HTMLTableCellElement;
	readonly _spacerBottomCell: HTMLTableCellElement;

	/** The row-size class currently on the `<table>`, so it is swapped once. */
	_sizeClass: CarbonRowSizeClass | undefined;
	_headerRow: HTMLTableRowElement | undefined;
	_filterRow: HTMLTableRowElement | undefined;
	_footRow: HTMLTableRowElement | undefined;

	constructor(host: THost) {
		this.host = host;
		this.rows = new Map();
		this.addenda = new Map();
		this.headerCells = new Map();
		this.filterCells = new Map();
		this.footCells = new Map();
		this.cols = new Map();
		this.mounted = false;

		// The scaffold is BUILT here and merely ATTACHED by mount(). Every one
		// of these fields is read by table.js and by the adapters the moment
		// mount() returns (`renderer.scroll`, `.thead`, `.tfoot`, `.toolbar`,
		// `.footer`, `.table`), so building them here is what lets them be
		// declared without `| undefined` and without a definite-assignment
		// assertion. Nothing observable moves: the nodes are detached until
		// mount() appends them, mount() is called exactly once (table.js
		// constructs the renderer and mounts it four lines later), and the only
		// option read at construction — `emptyMessage` — is fixed before the
		// renderer exists. Every profile hook still runs in mount(), in the
		// same order, so an adapter sees the DOM exactly when it did before.
		const o = this.host.options;

		this.toolbar = el("section", { className: `cf-table__toolbar ${CARBON.toolbar}` });
		this.scroll = el("div", { className: `cf-table__scroll ${CARBON.content}` });

		this.table = el("table", { className: `cf-table__table ${CARBON.table}` });
		this.colgroup = el("colgroup");
		this.thead = el("thead", { className: "cf-table__head" });
		this.tbody = el("tbody", { className: "cf-table__body" });
		this.tfoot = el("tfoot", { className: "cf-table__foot" });

		this.table.appendChild(this.colgroup);
		this.table.appendChild(this.thead);
		this.table.appendChild(this.tbody);
		this.table.appendChild(this.tfoot);
		this.scroll.appendChild(this.table);

		this.empty = el("div", {
			className: "cf-table__empty",
			html: `<span>${o.emptyMessage || ""}</span>`,
		});

		this.footer = el("div", { className: "cf-table__footer" });

		// Spacer rows carry the virtualizer's offset. A single colspan'd cell
		// cannot disturb widths because <colgroup> owns them.
		this._spacerTopCell = el("td");
		this._spacerBottomCell = el("td");
		this.spacerTop = el("tr", {
			className: "cf-table__spacer",
			children: [this._spacerTopCell],
		});
		this.spacerBottom = el("tr", {
			className: "cf-table__spacer",
			children: [this._spacerBottomCell],
		});
		this.spacerTop.hidden = true;
		this.spacerBottom.hidden = true;
	}

	// ---------------------------------------------------------------- scaffold

	mount(container: HTMLElement): this {
		const o = this.host.options;
		const p = this.host.profile;

		this.container = container;
		container.classList.add("cf-table", CARBON.container);
		if (o.direction === "rtl") attr(container, "dir", "rtl");
		applyProfile(p, "root", container, { host: this.host });

		applyProfile(p, "scroll", this.scroll, { host: this.host });
		applyProfile(p, "head", this.thead, { host: this.host });
		applyProfile(p, "body", this.tbody, { host: this.host });
		applyProfile(p, "foot", this.tfoot, { host: this.host });

		applyProfile(p, "empty", this.empty, { host: this.host });
		this.empty.hidden = true;

		container.appendChild(this.toolbar);
		container.appendChild(this.scroll);
		container.appendChild(this.empty);
		container.appendChild(this.footer);

		this.mounted = true;
		return this;
	}

	destroy(): void {
		this.rows.clear();
		this.addenda.clear();
		this.headerCells.clear();
		this.filterCells.clear();
		this.footCells.clear();
		this.cols.clear();
		if (this.container) {
			this.container.classList.remove("cf-table", CARBON.container);
			this.container.innerHTML = "";
		}
		this.mounted = false;
	}

	// ------------------------------------------------------------------ render

	render(): void {
		if (!this.mounted) return;
		const leaf = this.host.table.getVisibleLeafColumns();
		this.renderSizeClass();
		this.renderColgroup(leaf);
		this.renderHeader(leaf);
		this.renderFilterRow(leaf);
		this.renderBody(leaf);
		this.renderFoot(leaf);
		this.renderEmptyState();
	}

	renderSizeClass(): void {
		const cls = this.host.sizeClass;
		if (this._sizeClass === cls) return;
		if (this._sizeClass) this.table.classList.remove(this._sizeClass);
		this.table.classList.add(cls);
		this._sizeClass = cls;
	}

	/**
	 * Column widths live on <colgroup>, not on every cell. One write per column
	 * per resize instead of one per cell is what keeps
	 * `columnResizeMode: 'onChange'` smooth at report-view column counts.
	 */
	renderColgroup(leaf: readonly RenderColumn[]): void {
		// A fixed-layout table only honours <colgroup> widths when its own width
		// is definite. Left to `max-content` the browser sizes the table from
		// cell CONTENT and then redistributes the surplus across the columns,
		// which silently discards every width TanStack computed (and desynced
		// the header row from the body, because they redistribute differently).
		// So the table gets an explicit px width — the same thing
		// tanstack-carbon's resizing example does with `getCenterTotalSize()`.
		setStyles(this.table, { width: `${this.host.table.getTotalSize()}px` });

		const desired: HTMLTableColElement[] = [];
		for (const column of leaf) {
			let col = this.cols.get(column.id);
			if (!col) {
				col = el("col");
				col[OWNED] = true;
				this.cols.set(column.id, col);
			}
			setStyles(col, { width: `${column.getSize()}px` });
			desired.push(col);
		}
		this.prune(this.cols, desired, (c) => c);
		reconcileOrder(this.colgroup, desired);
	}

	/** Sticky offsets for pinned columns. v9 pins logically: 'start' / 'end'. */
	applyPinning(node: HTMLElement, column: RenderColumn): void {
		const pinned = column.getIsPinned();
		if (!pinned) {
			setStyles(node, { position: "", insetInlineStart: "", insetInlineEnd: "", zIndex: "" });
			toggleClass(node, "cf-table__cell--pinned", false);
			toggleClass(node, "cf-table__cell--pinned-start", false);
			toggleClass(node, "cf-table__cell--pinned-end", false);
			toggleClass(node, "cf-table__cell--pinned-last", false);
			toggleClass(node, "cf-table__cell--pinned-first", false);
			return;
		}
		// Offsets inline (they are computed per column); LAYERING is left to the
		// stylesheet. An inline z-index here always beat the sheet, so a pinned
		// header cell sat below the ordinary header cells and the scrolling
		// column headers painted over the frozen one.
		setStyles(node, {
			position: "sticky",
			insetInlineStart: pinned === "start" ? `${column.getStart("start")}px` : "",
			insetInlineEnd: pinned === "end" ? `${column.getAfter("end")}px` : "",
			zIndex: "",
		});
		toggleClass(node, "cf-table__cell--pinned", true);
		toggleClass(node, "cf-table__cell--pinned-start", pinned === "start");
		toggleClass(node, "cf-table__cell--pinned-end", pinned === "end");
		// The last start-pinned / first end-pinned column carries the divider
		// shadow, matching tanstack-carbon's sticky-columns example.
		toggleClass(
			node,
			"cf-table__cell--pinned-last",
			pinned === "start" && column.getIsLastColumn("start")
		);
		toggleClass(
			node,
			"cf-table__cell--pinned-first",
			pinned === "end" && column.getIsFirstColumn("end")
		);
	}

	renderHeader(leaf: readonly RenderColumn[]): void {
		const o = this.host.options;
		const p = this.host.profile;
		let tr = this._headerRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__header-row" });
			applyProfile(p, "headerRow", tr, { host: this.host });
			this._headerRow = tr;
		}
		// Re-attach rather than assuming it is still mounted. Adapters put their
		// own classes on these rows and may sweep the DOM by class between
		// renders; a detached header row is otherwise invisible and permanent.
		if (tr.parentNode !== this.thead) this.thead.appendChild(tr);

		const groups = this.host.table.getHeaderGroups();
		// The last group is the leaf one. Read out before the test so the index
		// is taken once and lands definite — `groups.length ? …` proves nothing
		// to the compiler about `groups[groups.length - 1]`.
		const last = groups[groups.length - 1];
		const headers = last ? last.headers : [];
		const byId = new Map<string, RenderHeader>();
		for (const h of headers) byId.set(h.column.id, h);

		const desired: HTMLTableCellElement[] = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			// `leaf` is the array TanStack just handed us, so it is never
			// sparse; the guard is what the index signature costs, not a case
			// that happens.
			if (column === undefined) continue;
			const header = byId.get(column.id);
			let entry = this.headerCells.get(column.id);
			if (!entry) {
				const th = el("th", { className: "cf-table__cell cf-table__cell--header" });
				const content = el("div", { className: "cf-table__cell-content" });
				th.appendChild(content);
				th[OWNED] = true;
				entry = { th, content, rendered: undefined, wired: false };
				this.headerCells.set(column.id, entry);
			}
			const { th, content } = entry;
			attr(th, "data-col-id", column.id);
			attr(th, "data-col-index", i);
			attr(th, "scope", "col");

			const align = this.host.columnAlign(column);
			toggleClass(th, "cf-table__cell--right", align === "right");
			toggleClass(th, "cf-table__cell--center", align === "center");

			this.host.renderHeaderContent(entry, header, column, i);
			this.applyPinning(th, column);
			applyProfile(p, "headerCell", th, {
				host: this.host,
				column,
				header,
				content,
				colIndex: i,
			});
			desired.push(th);
		}
		this.prune(this.headerCells, desired, (e) => e.th);
		reconcileOrder(tr, desired);
		if (o.stickyHeader !== false) toggleClass(this.thead, "cf-table__head--sticky", true);
	}

	/** Inline filter row — frappe's `inlineFilters`, rendered as a second <tr>. */
	renderFilterRow(leaf: readonly RenderColumn[]): void {
		const show = this.host.options.inlineFilters && this.host.filtersVisible;
		if (!show) {
			if (this._filterRow) this._filterRow.hidden = true;
			return;
		}
		const p = this.host.profile;
		let tr = this._filterRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__filter-row" });
			applyProfile(p, "filterRow", tr, { host: this.host });
			this._filterRow = tr;
		}
		if (tr.parentNode !== this.thead) this.thead.appendChild(tr);
		tr.hidden = false;

		const desired: HTMLTableCellElement[] = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			if (column === undefined) continue;
			let entry = this.filterCells.get(column.id);
			if (!entry) {
				const td = el("td", { className: "cf-table__cell cf-table__cell--filter" });
				entry = { td, input: null };
				this.filterCells.set(column.id, entry);
				// The Grid supplies its own search inputs: frappe's GridRow
				// search row writes into `grid.filter` and re-runs
				// `grid.get_data()`, with per-fieldtype matching the engine
				// knows nothing about (Sr No, Duration, Barcode, Rating...).
				const supplied = this.host.createFilterCell(entry, column, i);
				if (!supplied) {
					const input = el("input", {
						className: "cf-table__filter-input",
						attrs: { type: "text", "data-col-id": column.id },
					});
					entry.input = input;
					td.appendChild(input);
					this.host.wireFilterInput(entry, column);
				}
			}
			attr(entry.td, "data-col-id", column.id);
			attr(entry.td, "data-col-index", i);
			if (entry.input) {
				attr(entry.input, "title", this.host.columnLabel(column));
				entry.input.disabled = this.host.columnFilterable(column) === false;
				if (document.activeElement !== entry.input) {
					const current = column.getFilterValue();
					// `String()` spells out the coercion assigning to `.value`
					// was already doing — the filter value is whatever an
					// adapter set, and TanStack reports it as `unknown`.
					entry.input.value = current == null ? "" : String(current);
				}
			}
			this.applyPinning(entry.td, column);
			applyProfile(p, "filterCell", entry.td, { host: this.host, column, colIndex: i });
			desired.push(entry.td);
		}
		this.prune(this.filterCells, desired, (e) => e.td);
		reconcileOrder(tr, desired);
	}

	renderBody(leaf: readonly RenderColumn[]): void {
		const slice = this.host.getRenderRows();
		const desired: HTMLTableRowElement[] = [];

		if (slice.paddingTop > 0) {
			this.spacerTop.hidden = false;
			setStyles(this._spacerTopCell, { height: `${slice.paddingTop}px` });
			attr(this._spacerTopCell, "colspan", leaf.length);
			desired.push(this.spacerTop);
		} else {
			this.spacerTop.hidden = true;
		}

		const seen = new Set<string>();
		for (const row of slice.rows) {
			seen.add(row.id);
			desired.push(this.renderRow(row, leaf));
			// Addendum rows are ADAPTER-OWNED but ENGINE-PLACED, so the engine
			// has to own their removal as well. `reconcileOrder` only positions
			// the nodes it is given; anything left behind stays in the <tbody>
			// exactly where it was. Before this was tracked, a row that got
			// released — or rebuilt, which `grid.reset_grid()` does to every
			// GridRow on a Configure Columns change — left its addendum
			// stranded, and a stray child row ahead of the first data row
			// breaks Carbon's `tr.cds--parent-row + tr[data-child-row]`
			// adjacency for the whole table.
			const extra = this.host.renderRowAddendum(row, leaf);
			const previous = this.addenda.get(row.id);
			if (previous && previous !== extra) previous.remove();
			if (extra) {
				this.addenda.set(row.id, extra);
				if (this.host.options.expandable) this.wireChildHover(extra);
				desired.push(extra);
			} else if (previous) {
				this.addenda.delete(row.id);
			}
		}

		if (slice.paddingBottom > 0) {
			this.spacerBottom.hidden = false;
			setStyles(this._spacerBottomCell, { height: `${slice.paddingBottom}px` });
			attr(this._spacerBottomCell, "colspan", leaf.length);
			desired.push(this.spacerBottom);
		} else {
			this.spacerBottom.hidden = true;
		}

		// Recycle rows that scrolled out. `releaseRow` lets an adapter keep a
		// row's controls alive (the Grid does) rather than dropping them.
		for (const [id, entry] of this.rows) {
			if (!seen.has(id)) {
				this.host.releaseRow(id, entry);
				entry.tr.remove();
				this.rows.delete(id);
			}
		}
		for (const [id, node] of this.addenda) {
			if (!seen.has(id)) {
				node.remove();
				this.addenda.delete(id);
			}
		}
		reconcileOrder(this.tbody, desired);
	}

	renderRow(row: RenderRow, leaf: readonly RenderColumn[]): HTMLTableRowElement {
		const p = this.host.profile;
		// An adapter may own the row element. The Grid does: its GridRow builds
		// the <tr> so that `grid_row.wrapper` / `.row` are the very nodes frappe
		// and third-party code already hold references to, and so the live
		// controls mounted in its cells are never re-created.
		const supplied = this.host.createRowNode(row);
		let entry: RowEntry | null | undefined = this.rows.get(row.id);

		// The adapter may also REPLACE the element for a row id it has already
		// rendered — `grid.reset_grid()` (which Configure Columns triggers)
		// discards every GridRow and builds new ones for the same docnames.
		// Keeping the cached node then leaves the visible <tr> orphaned from the
		// GridRow that owns it: `grid_row.wrapper` is detached, so row indices,
		// `grid-row-open`, the checkbox delegation in `setup_check` and every
		// `.grid-row[data-name]` lookup silently address a node nobody can see.
		if (entry && supplied && entry.tr !== supplied) {
			this.host.releaseRow(row.id, entry);
			entry.tr.remove();
			this.rows.delete(row.id);
			entry = null;
		}

		if (!entry) {
			const tr = supplied || el("tr", { className: "cf-table__row" });
			if (supplied) tr.classList.add("cf-table__row");
			else tr[OWNED] = true;
			entry = { tr, cells: new Map(), adapterOwned: !!supplied };
			this.rows.set(row.id, entry);
			this.host.adoptRow(row, entry);
		}
		const { tr } = entry;
		attr(tr, "data-row-id", row.id);
		attr(tr, "data-row-index", row.index);
		attr(tr, "data-depth", row.depth || 0);
		toggleClass(tr, CARBON.selectedRow, !!(row.getIsSelected && row.getIsSelected()));
		const expanded = !!(row.getIsExpanded && row.getIsExpanded());
		toggleClass(tr, "cf-table__row--expanded", expanded);
		if (this.host.options.expandable) {
			// Carbon's expandable stylesheet is written almost entirely as
			// `tr.cds--parent-row… + tr[data-child-row]`, so BOTH the class and
			// the attribute are selectors, not decoration — and `cds--expandable-row`
			// means "expanded" on a parent row while being a permanent structural
			// class on the child row.
			toggleClass(tr, CARBON.parentRow, true);
			attr(tr, "data-parent-row", "true");
			toggleClass(tr, CARBON.expandableRow, expanded);
		}

		const desired: HTMLTableCellElement[] = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			if (column === undefined) continue;
			let cell = entry.cells.get(column.id);
			if (!cell) {
				// Same seam for cells. A Grid cell IS the `$col` element frappe's
				// GridRow created, carrying its `.static-area` / `.field-area`
				// pair, its `data-fieldname` / `data-fieldtype` (which
				// desk/_numerics.scss selects on) and its mounted control. The
				// engine positions it; it never rebuilds it.
				const supplied = this.host.createCellNode(row, column, i);
				if (supplied) {
					supplied.classList.add("cf-table__cell");
					cell = { td: supplied, content: supplied, rendered: undefined, adapterOwned: true };
				} else {
					const td = el("td", { className: "cf-table__cell" });
					const content = el("div", { className: "cf-table__cell-content" });
					td.appendChild(content);
					td[OWNED] = true;
					cell = { td, content, rendered: undefined };
				}
				entry.cells.set(column.id, cell);
			}
			attr(cell.td, "data-col-id", column.id);
			attr(cell.td, "data-col-index", i);
			attr(cell.td, "data-row-index", row.index);

			const align = this.host.columnAlign(column);
			toggleClass(cell.td, "cf-table__cell--right", align === "right");
			toggleClass(cell.td, "cf-table__cell--center", align === "center");

			if (!cell.adapterOwned) this.host.renderCellContent(cell, row, column, i);
			this.applyPinning(cell.td, column);
			applyProfile(p, "cell", cell.td, {
				host: this.host,
				row,
				column,
				colIndex: i,
				content: cell.content,
			});
			desired.push(cell.td);
		}
		this.prune(entry.cells, desired, (c) => c.td);
		reconcileOrder(tr, desired);
		applyProfile(p, "row", tr, { host: this.host, row });
		return tr;
	}

	/**
	 * Carbon paints the parent row's hover state, not the child's, so hovering
	 * the open panel leaves a white seam across the row above it. @carbon/react
	 * fixes this in JS (TableExpandedRow.tsx) by mirroring the hover onto the
	 * previous sibling; light DOM has no other way to do it either.
	 */
	wireChildHover(node: HTMLTableRowElement): void {
		if (node[CHILD_HOVER]) return;
		node[CHILD_HOVER] = true;
		const set = (on: boolean): void => {
			const parent = node.previousElementSibling;
			if (parent) toggleClass(parent, CARBON.expandableRowHover, on);
		};
		node.addEventListener("mouseenter", () => set(true));
		node.addEventListener("mouseleave", () => set(false));
	}

	renderFoot(leaf: readonly RenderColumn[]): void {
		const p = this.host.profile;
		if (!this.host.options.showTotalRow) {
			if (this._footRow) this._footRow.hidden = true;
			return;
		}
		let tr = this._footRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__total-row" });
			applyProfile(p, "totalRow", tr, { host: this.host });
			this._footRow = tr;
		}
		if (tr.parentNode !== this.tfoot) this.tfoot.appendChild(tr);
		tr.hidden = false;

		const desired: HTMLTableCellElement[] = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			if (column === undefined) continue;
			let entry = this.footCells.get(column.id);
			if (!entry) {
				const td = el("td", { className: "cf-table__cell cf-table__cell--total" });
				const content = el("div", { className: "cf-table__cell-content" });
				td.appendChild(content);
				entry = { td, content, rendered: undefined };
				this.footCells.set(column.id, entry);
			}
			attr(entry.td, "data-col-id", column.id);
			attr(entry.td, "data-col-index", i);
			const align = this.host.columnAlign(column);
			toggleClass(entry.td, "cf-table__cell--right", align === "right");
			this.host.renderTotalContent(entry, column, i);
			this.applyPinning(entry.td, column);
			applyProfile(p, "totalCell", entry.td, { host: this.host, column, colIndex: i });
			desired.push(entry.td);
		}
		this.prune(this.footCells, desired, (e) => e.td);
		reconcileOrder(tr, desired);
	}

	renderEmptyState(): void {
		const empty = this.host.table.getRowModel().rows.length === 0;
		this.empty.hidden = !empty;
		toggleClass(this.scroll, "cf-table__scroll--empty", empty);
	}

	/** Drop map entries whose node is no longer wanted. */
	prune<TEntry>(
		map: Map<string, TEntry>,
		desired: readonly Element[],
		pick: (entry: TEntry) => Element
	): void {
		for (const [key, entry] of map) {
			const node = pick(entry);
			if (desired.indexOf(node) === -1) {
				node.remove();
				map.delete(key);
			}
		}
	}

	// ------------------------------------------------------------------ lookup

	getRowNode(rowId: NodeLookupKey): HTMLTableRowElement | null {
		const entry = this.rows.get(String(rowId));
		return entry ? entry.tr : null;
	}

	getCellNode(rowId: NodeLookupKey, colId: NodeLookupKey): HTMLTableCellElement | null {
		const entry = this.rows.get(String(rowId));
		if (!entry) return null;
		const cell = entry.cells.get(String(colId));
		return cell ? cell.td : null;
	}

	getHeaderNode(colId: NodeLookupKey): HTMLTableCellElement | null {
		const entry = this.headerCells.get(String(colId));
		return entry ? entry.th : null;
	}
}
