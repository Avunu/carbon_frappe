// Carbon class vocabulary, and the seam for legacy class emission.
//
// DUAL EMISSION is the compatibility contract of this whole effort. Every
// element the engine renders carries its Carbon class AND the legacy class the
// frappe ecosystem already targets, so that:
//
//   - `datatable.style.setStyle(".dt-cell--0-3", {...})` keeps working (13 call
//     sites across frappe / erpnext / avunu),
//   - third-party report and doctype stylesheets keep matching,
//   - frappe's own jQuery reaches into rows it did not render
//     (`report_view.js` queries `.dt-row[data-row-index]` and `.dt-filter`;
//     `controls/table.js` queries `.grid-row[data-name]` and `.form-in-grid`).
//
// The engine itself knows only the Carbon half. Each adapter supplies a
// "legacy profile" — a bag of hooks that decorate the nodes the engine builds —
// so all of an adapter's legacy naming lives in one readable file next to that
// adapter, and the engine never accumulates per-surface special cases.

import type { CarbonDataTableDomClass } from "frappe-types";

export const CARBON = {
	container: "cds--data-table-container",
	content: "cds--data-table-content",
	table: "cds--data-table",
	toolbar: "cds--table-toolbar",
	toolbarContent: "cds--toolbar-content",
	batchActions: "cds--batch-actions",
	batchActionsActive: "cds--batch-actions--active",
	batchSummary: "cds--batch-summary",
	sortHeader: "cds--table-sort",
	sortActive: "cds--table-sort--active",
	sortDescending: "cds--table-sort--descending",
	sortFlex: "cds--table-sort__flex",
	sortIcon: "cds--table-sort__icon",
	sortIconUnsorted: "cds--table-sort__icon-unsorted",
	sortHeaderCell: "cds--table-sort__header",
	headerLabel: "cds--table-header-label",
	sortableTable: "cds--data-table--sort",
	// `cds--data-table--sticky-header` is deliberately NOT used — see the note
	// in table.js#render. Sticky is done with position:sticky on the <th>s.
	// Expandable rows. `expandableRow` is overloaded by Carbon itself: on a
	// parent row it means EXPANDED, on the child row it is permanent structure.
	// `data-parent-row` / `data-child-row` are selectors too — see render.js.
	expandableRow: "cds--expandable-row",
	expandableRowHover: "cds--expandable-row--hover",
	parentRow: "cds--parent-row",
	childRow: "cds--child-row",
	childRowInner: "cds--child-row-inner-container",
	expandCell: "cds--table-expand",
	expandRow: "cds--table-expand__button",
	expandSvg: "cds--table-expand__svg",
	columnMenu: "cds--table-column-menu",
	overflowMenuDataTable: "cds--overflow-menu--data-table",
	selectedRow: "cds--data-table--selected",
	// Toolbar / batch actions.
	actionList: "cds--action-list",
	toolbarAction: "cds--toolbar-action",
	searchExpandable: "cds--toolbar-search-container-expandable",
	searchActive: "cds--toolbar-search-container-active",
	pagination: "cds--pagination",
	skeleton: "cds--skeleton",
	// Bare `as const`, so the literal types survive for `sizeClass` to build a
	// template-literal type off `CARBON.table`. The value check that a
	// `satisfies` clause would give is done separately, just below — frappe
	// vendors esbuild 0.14.54, which predates `satisfies` and fails to PARSE it
	// (`Expected ";" but found "satisfies"`), breaking the build before tsc ever
	// runs. Nothing here may use syntax newer than that esbuild.
} as const;

/** The names the engine and its adapters reach for a Carbon class by. */
export type CarbonClassKey = keyof typeof CARBON;

/** One of the `cds--*` class names {@link CARBON} resolves to. */
export type CarbonClassName = (typeof CARBON)[CarbonClassKey];

/**
 * The conformance half of what a `satisfies` clause would have done for
 * {@link CARBON}: every value must be a class name frappe-types records for
 * this app's markup. A typo here is a silent visual regression, so it is worth
 * checking even at the cost of the ceremony below.
 *
 * Written as a type-level assertion because it must ERASE — see the note on
 * `CARBON` about esbuild 0.14.54. The tuple wrappers stop the conditional from
 * distributing over the union and from collapsing to `never` (which would pass
 * vacuously, since `never` is assignable to everything).
 */
type Assert<T extends true> = T;
export type CarbonClassNamesAreValid = Assert<
	[CarbonClassName] extends [CarbonDataTableDomClass] ? true : false
>;

/** Carbon's five data-table row sizes. The header row always matches the body. */
export const ROW_SIZES = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64 } as const;

/** One of {@link ROW_SIZES}' five names. */
export type CarbonRowSize = keyof typeof ROW_SIZES;

/** The modifier class {@link sizeClass} builds, e.g. `cds--data-table--lg`. */
export type CarbonRowSizeClass = `${typeof CARBON.table}--${CarbonRowSize}`;

/** Carbon modifier class for a row size, e.g. lg -> cds--data-table--lg. */
export function sizeClass(size: CarbonRowSize): CarbonRowSizeClass {
	return `${CARBON.table}--${size}`;
}

/**
 * `for…in` hands its key back as a plain `string`, and every own key of
 * ROW_SIZES is a row size — so this is a real check, not an assertion.
 */
function isRowSize(name: string): name is CarbonRowSize {
	return name in ROW_SIZES;
}

/**
 * Nearest Carbon row size for an arbitrary pixel height. Frappe hands us 33px
 * (query report), 35px (report view) and 40px (datatable default); Carbon has
 * no 33/35, so we snap rather than emit an off-ramp height that would break the
 * "header row matches body row" rule.
 */
export function nearestRowSize(px: number): CarbonRowSize {
	let best: CarbonRowSize = "lg";
	let delta = Infinity;
	for (const name in ROW_SIZES) {
		if (!isRowSize(name)) continue;
		const d = Math.abs(ROW_SIZES[name] - px);
		if (d < delta) {
			delta = d;
			best = name;
		}
	}
	return best;
}

// ------------------------------------------------------------- the hook seam
//
// Everything below types the profile. It is the contract three adapters
// implement and the renderer calls, so it is spelled out per hook rather than
// as a `Record<string, Function>`: the node an adapter is handed differs by
// hook (a <th> is not a <tr>), and so does what the engine knows at that point.

/**
 * The column handle a hook receives — TanStack's `Column`. Only `id` is
 * declared, because that is all the engine promises about it; an adapter that
 * needs the spec behind it goes through `ctx.host`.
 */
export interface TableClassColumn {
	readonly id: string;
}

/**
 * The row handle a hook receives — TanStack's `Row`. `original` is whatever the
 * adapter handed the engine as data, so it stays open: narrow before reading.
 */
export interface TableClassRow {
	readonly id: string;
	readonly index: number;
	readonly original: unknown;
}

/**
 * What every hook gets: the engine instance that is rendering.
 *
 * `THost` is a parameter rather than an import of `CarbonTable` because
 * table.js imports THIS module — the dependency has to point one way. An
 * adapter names its own host type; the engine passes itself.
 */
export interface TableRegionClassContext<THost> {
	host: THost;
}

/** A body row's context (`row`). */
export interface TableRowClassContext<THost> extends TableRegionClassContext<THost> {
	row: TableClassRow;
}

/** A header cell's context (`headerCell`). */
export interface TableHeaderCellClassContext<THost> extends TableRegionClassContext<THost> {
	column: TableClassColumn;
	/**
	 * TanStack's `Header` for this column — `undefined` when the column has no
	 * entry in the last header group. Nothing in-tree reads it, so it stays
	 * `unknown` rather than pinning a generic instantiation into this seam.
	 */
	header: unknown;
	/** The inner `div.cf-table__cell-content`, NOT the `<th>` handed in as `node`. */
	content: HTMLElement;
	colIndex: number;
}

/** A body cell's context (`cell`). */
export interface TableCellClassContext<THost> extends TableRegionClassContext<THost> {
	row: TableClassRow;
	column: TableClassColumn;
	colIndex: number;
	/**
	 * The inner `div.cf-table__cell-content` — or, for a cell the adapter
	 * supplied itself, the `<td>` again (render.js#renderRow stores one node as
	 * both `td` and `content`).
	 */
	content: HTMLElement;
}

/**
 * A filter- or total-row cell's context (`filterCell`, `totalCell`).
 *
 * Neither carries `content`: the filter cell's contents are the adapter's own
 * (or the engine's `<input>`), and the total cell's are written by
 * `renderTotalContent` after the hook has run.
 */
export interface TableColumnCellClassContext<THost> extends TableRegionClassContext<THost> {
	column: TableClassColumn;
	colIndex: number;
}

/**
 * The element each hook decorates. These are the engine's own nodes except
 * `root` (the container the caller mounted into) and `row`/`cell`, which an
 * adapter may have supplied — see render.js#renderRow.
 */
export interface TableClassHookNodes {
	/** The container the table was mounted into. */
	root: HTMLElement;
	/** `div.cf-table__scroll` — the scroll viewport the virtualizer measures. */
	scroll: HTMLElement;
	head: HTMLTableSectionElement;
	body: HTMLTableSectionElement;
	foot: HTMLTableSectionElement;
	headerRow: HTMLTableRowElement;
	headerCell: HTMLTableCellElement;
	filterRow: HTMLTableRowElement;
	filterCell: HTMLTableCellElement;
	row: HTMLTableRowElement;
	cell: HTMLTableCellElement;
	totalRow: HTMLTableRowElement;
	totalCell: HTMLTableCellElement;
	/** `div.cf-table__empty`; its first element child is the message `<span>`. */
	empty: HTMLElement;
}

/** The context each hook receives alongside its node. */
export interface TableClassHookContexts<THost> {
	root: TableRegionClassContext<THost>;
	scroll: TableRegionClassContext<THost>;
	head: TableRegionClassContext<THost>;
	body: TableRegionClassContext<THost>;
	foot: TableRegionClassContext<THost>;
	headerRow: TableRegionClassContext<THost>;
	headerCell: TableHeaderCellClassContext<THost>;
	filterRow: TableRegionClassContext<THost>;
	filterCell: TableColumnCellClassContext<THost>;
	row: TableRowClassContext<THost>;
	cell: TableCellClassContext<THost>;
	totalRow: TableRegionClassContext<THost>;
	totalCell: TableColumnCellClassContext<THost>;
	empty: TableRegionClassContext<THost>;
}

/** The name of one profile hook. */
export type TableClassProfileHook = keyof TableClassHookNodes;

/** The element hook `K` decorates. */
export type TableClassHookNode<K extends TableClassProfileHook> = TableClassHookNodes[K];

/** The context hook `K` receives. */
export type TableClassHookContext<
	K extends TableClassProfileHook,
	THost = unknown,
> = TableClassHookContexts<THost>[K];

/** One profile hook. */
export type TableClassHook<K extends TableClassProfileHook, THost = unknown> = (
	node: TableClassHookNode<K>,
	ctx: TableClassHookContext<K, THost>
) => void;

/**
 * The bag an adapter returns from its `*Profile()` factory.
 *
 * Written as a mapped type, not an interface with fourteen members: that is
 * what lets `applyProfile` index it with a hook name it only knows generically
 * and still get back one concrete signature.
 */
export type TableClassProfile<THost = unknown> = {
	[K in TableClassProfileHook]?: TableClassHook<K, THost> | null | undefined;
};

/** A profile after {@link makeProfile} has filled the gaps with `null`. */
export type ResolvedTableClassProfile<THost = unknown> = Required<TableClassProfile<THost>>;

/**
 * The hook surface an adapter implements to add its legacy classes/attributes.
 * Every hook is optional and receives (node, context). Contexts carry whatever
 * the engine knows at that point — see render.js for the exact shapes.
 */
export const NOOP_PROFILE: ResolvedTableClassProfile = {
	root: null,
	scroll: null,
	head: null,
	body: null,
	foot: null,
	headerRow: null,
	headerCell: null,
	filterRow: null,
	filterCell: null,
	row: null,
	cell: null,
	totalRow: null,
	totalCell: null,
	empty: null,
};

/** Merge an adapter profile over the no-op defaults. */
export function makeProfile<THost>(
	profile: TableClassProfile<THost> | null | undefined
): ResolvedTableClassProfile<THost> {
	return Object.assign({}, NOOP_PROFILE, profile || {});
}

/** Invoke a profile hook if the adapter defined one. Never throws upward. */
export function applyProfile<THost, K extends TableClassProfileHook>(
	profile: TableClassProfile<THost> | null | undefined,
	hook: K,
	node: TableClassHookNode<K>,
	ctx: TableClassHookContext<K, THost>
): void {
	const fn = profile && profile[hook];
	if (typeof fn !== "function") return;
	try {
		fn(node, ctx);
	} catch (e) {
		// A legacy-class hook must never take the table down with it; the
		// component degrades to Carbon-only classes and says so.
		console.error(`carbon_frappe: table class profile hook "${hook}" failed`, e);
	}
}
