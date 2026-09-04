// TanStack feature composition and the frappe-flavoured filter/sort functions.
//
// The engine registers ONE feature set for every table rather than composing
// per-adapter. Two reasons: `tableFeatures()` validates slot prerequisites, so a
// per-surface set multiplies the ways a feature can be silently absent; and the
// row-model chain is memoised, so an unused model costs a reference comparison
// per render, not a pass over the data. The whole set measured at ~189 KB
// minified alongside virtual-core, which is smaller than the frappe-datatable
// it replaces.
import {
	cellSelectionFeature,
	columnFacetingFeature,
	columnFilteringFeature,
	columnOrderingFeature,
	columnPinningFeature,
	columnResizingFeature,
	columnSizingFeature,
	columnVisibilityFeature,
	createExpandedRowModel,
	createFilteredRowModel,
	createPaginatedRowModel,
	createSortedRowModel,
	globalFilteringFeature,
	rowExpandingFeature,
	rowPaginationFeature,
	rowPinningFeature,
	rowSelectionFeature,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_basic,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
} from "@tanstack/table-core";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";

/**
 * The slice of a TanStack `Row` these functions read.
 *
 * Declared structurally rather than as `Row<TFeatures, TData>`: TanStack marks
 * both of those parameters `in out`, so a concrete instantiation is invariant
 * and nothing but the engine's own feature set would be assignable. `getValue`
 * is copied from `coreRowsFeature.types.d.ts:90`, unparameterised at every call
 * site here so it lands as `unknown` and gets coerced explicitly.
 */
export interface FrappeFilterRow {
	getValue: <TValue>(columnId: string) => TValue;
}

/** The two values a comparison filter puts either side of a relational operator. */
export type FrappeCompareValue = string | number;

/**
 * The `columnDef.meta` members these functions look for.
 *
 * Adapters own the rest of the bag (the column `spec`, the List view's
 * `listCol` / `listMeta`); these two are the engine's half of it, and both are
 * optional because most columns supply neither.
 */
export interface FrappeFilterColumnMeta {
	/**
	 * The pair to compare, when a column knows better than "number if it parses,
	 * display text otherwise" — mirrors frappe-datatable's per-column
	 * `getCompareValues`. Anything that is not a 2-tuple is ignored.
	 */
	compareValue?: (
		row: FrappeFilterRow,
		keyword: string,
		columnId: string
	) => [FrappeCompareValue, FrappeCompareValue] | null | undefined | false;
	/** The display text to match substrings against, when the raw value is not it. */
	getFilterText?: (row: FrappeFilterRow, columnId: string) => string | null | undefined;
}

/** The column handle {@link FrappeFilterTable.getColumn} hands back. */
export interface FrappeFilterColumn {
	columnDef: { meta?: FrappeFilterColumnMeta | undefined };
}

/**
 * The slice of a TanStack `Table` these functions probe for column meta.
 *
 * NOTE that v9 never actually passes it: `createFilteredRowModel.js:86,95`
 * invokes a `filterFn` with four arguments, and `FilterFn` declares four. The
 * fifth parameter is kept — optional — because removing it would change the
 * functions' arity, and the `table &&` guards below already handle its absence.
 */
export interface FrappeFilterTable {
	getColumn(columnId: string): FrappeFilterColumn | undefined;
}

/** Is `v` a finite number, or a string that parses cleanly as one? */
function isNumeric(v: unknown): boolean {
	if (v === null || v === undefined || v === "") return false;
	return !isNaN(Number(v));
}

function stripHTML(s: unknown): string {
	return String(s == null ? "" : s).replace(/<[^>]*>/g, "");
}

/**
 * One parsed inline filter. The `text` type varies by branch — `equals` and
 * `notEquals` compare numerically, `range` carries its two ends — so this is a
 * union discriminated on `type` rather than one shape with a widened `text`.
 */
export type FrappeInlineFilter =
	| { type: "greaterThan"; text: string }
	| { type: "lessThan"; text: string }
	| { type: "equals"; text: number }
	| { type: "notEquals"; text: number }
	| { type: "containsNumber"; text: string }
	| { type: "range"; text: [string, string] }
	| { type: "contains"; text: string };

/**
 * Reproduce frappe-datatable's inline-filter grammar (datatable/src/filterRows.js
 * `guessFilter`) EXACTLY, including its quirks, so that a filter typed into a
 * report returns the same rows it did before the swap:
 *
 *   >5      greaterThan     <5   lessThan        =5   equals (numeric)
 *   5:10    range           5    containsNumber  foo  contains (substring)
 *
 * Deliberately faithful quirk: upstream tests `isNumber(compareString)` BEFORE
 * the `!=` branch, so `!=5` resolves to containsNumber, never notEquals. That is
 * upstream behaviour, and reports have been written against it.
 */
export function guessFilter(keyword = ""): FrappeInlineFilter | null {
	if (!keyword || keyword.length === 0) return null;

	let compareString = keyword;
	// `compareString[0]` is `string | undefined` under the index-signature
	// rules even though the guard above proves the string is non-empty.
	const lead = compareString[0];
	if (lead !== undefined && [">", "<", "="].includes(lead)) compareString = keyword.slice(1);
	else if (compareString.startsWith("!=")) compareString = keyword.slice(2);

	if (keyword.startsWith(">") && compareString)
		return { type: "greaterThan", text: compareString.trim() };
	if (keyword.startsWith("<") && compareString)
		return { type: "lessThan", text: compareString.trim() };
	if (keyword.startsWith("=") && isNumeric(compareString))
		return { type: "equals", text: Number(keyword.slice(1).trim()) };
	if (isNumeric(compareString)) return { type: "containsNumber", text: compareString };
	if (keyword.startsWith("!=") && isNumeric(compareString))
		return { type: "notEquals", text: Number(keyword.slice(2).trim()) };

	const parts = keyword.split(":");
	// Spelled out per end rather than `parts.every(...)` + `parts.map(...)`:
	// `length === 2` is what makes the two reads safe, and naming them is what
	// makes `text` a pair instead of an array the range branch has to re-check.
	const [low, high] = parts;
	if (
		parts.length === 2 &&
		low !== undefined &&
		high !== undefined &&
		isNumeric(low.trim()) &&
		isNumeric(high.trim())
	)
		return { type: "range", text: [low.trim(), high.trim()] };

	return { type: "contains", text: compareString.toLowerCase() };
}

/**
 * The two comparison values for a cell, mirroring filterRows.getCompareValues:
 * a column-supplied `compareValue` wins, then a numeric reading, then the
 * HTML-stripped formatted string.
 */
function compareValues(
	row: FrappeFilterRow,
	columnId: string,
	keyword: string,
	meta: FrappeFilterColumnMeta | null
): [FrappeCompareValue, FrappeCompareValue] {
	if (meta && typeof meta.compareValue === "function") {
		const pair = meta.compareValue(row, keyword, columnId);
		if (Array.isArray(pair)) return pair;
	}
	const raw = row.getValue(columnId);
	// `parseFloat` stringifies its argument anyway, so `String(raw)` is the
	// coercion that was already happening, spelled out.
	const float = parseFloat(String(raw));
	if (!isNaN(float)) return [float, keyword];
	return [filterText(row, columnId, meta), keyword];
}

/** HTML-stripped, lower-cased display text for a cell. */
function filterText(
	row: FrappeFilterRow,
	columnId: string,
	meta: FrappeFilterColumnMeta | null
): string {
	if (meta && typeof meta.getFilterText === "function") {
		return String(meta.getFilterText(row, columnId) || "").toLowerCase();
	}
	return stripHTML(row.getValue(columnId)).toLowerCase();
}

/** TanStack filterFn implementing the frappe-datatable grammar above. */
export function filterFn_frappe(
	row: FrappeFilterRow,
	columnId: string,
	filterValue: unknown,
	_addMeta?: unknown,
	table?: FrappeFilterTable
): boolean {
	const filter = guessFilter(String(filterValue == null ? "" : filterValue));
	if (!filter) return true;

	const column = table && table.getColumn ? table.getColumn(columnId) : null;
	const meta = (column && column.columnDef && column.columnDef.meta) || null;
	const raw = row.getValue(columnId);

	switch (filter.type) {
		case "greaterThan": {
			const [a, b] = compareValues(row, columnId, filter.text, meta);
			return a > b;
		}
		case "lessThan": {
			const [a, b] = compareValues(row, columnId, filter.text, meta);
			return a < b;
		}
		case "equals":
			return parseFloat(String(raw)) === filter.text;
		case "notEquals":
			return parseFloat(String(raw)) !== filter.text;
		case "range": {
			const [value, low] = compareValues(row, columnId, filter.text[0], meta);
			const [, high] = compareValues(row, columnId, filter.text[1], meta);
			return value >= low && value <= high;
		}
		case "containsNumber": {
			const number = parseFloat(filter.text);
			return (
				number === parseFloat(String(raw)) ||
				filterText(row, columnId, meta).includes(filter.text)
			);
		}
		default: {
			const needle = filter.text;
			if (!needle) return true;
			return (
				String(raw == null ? "" : raw)
					.toLowerCase()
					.includes(needle) || filterText(row, columnId, meta).includes(needle)
			);
		}
	}
}

/** Global (toolbar search) filter: substring over every column's display text. */
export function filterFn_frappeGlobal(
	row: FrappeFilterRow,
	columnId: string,
	filterValue: unknown,
	_addMeta?: unknown,
	table?: FrappeFilterTable
): boolean {
	const needle = String(filterValue == null ? "" : filterValue).toLowerCase();
	if (!needle) return true;
	const column = table && table.getColumn ? table.getColumn(columnId) : null;
	const meta = (column && column.columnDef && column.columnDef.meta) || null;
	return filterText(row, columnId, meta).includes(needle);
}

/**
 * Sort that keeps frappe's display semantics: numeric columns compare
 * numerically even when the underlying value arrived as a string (query report
 * results routinely do), everything else falls back to locale-aware text.
 */
export function sortFn_frappe(
	rowA: FrappeFilterRow,
	rowB: FrappeFilterRow,
	columnId: string
): number {
	const a = rowA.getValue(columnId);
	const b = rowB.getValue(columnId);
	const na = parseFloat(String(a));
	const nb = parseFloat(String(b));
	if (!isNaN(na) && !isNaN(nb)) return na === nb ? 0 : na > nb ? 1 : -1;
	const sa = stripHTML(a).toLowerCase();
	const sb = stripHTML(b).toLowerCase();
	return sa === sb ? 0 : sa > sb ? 1 : -1;
}

/** The single feature set every CarbonTable is constructed with. */
export function buildFeatures() {
	return tableFeatures({
		coreReactivityFeature: storeReactivityBindings(),

		columnSizingFeature,
		columnResizingFeature,
		columnPinningFeature,
		columnOrderingFeature,
		columnVisibilityFeature,

		columnFilteringFeature,
		globalFilteringFeature,
		columnFacetingFeature,
		filteredRowModel: createFilteredRowModel(),
		filterFns: {
			frappe: filterFn_frappe,
			frappeGlobal: filterFn_frappeGlobal,
		},

		rowSortingFeature,
		sortedRowModel: createSortedRowModel(),
		sortFns: {
			frappe: sortFn_frappe,
			alphanumeric: sortFn_alphanumeric,
			basic: sortFn_basic,
			datetime: sortFn_datetime,
			text: sortFn_text,
		},

		rowExpandingFeature,
		expandedRowModel: createExpandedRowModel(),

		rowPaginationFeature,
		paginatedRowModel: createPaginatedRowModel(),

		rowSelectionFeature,
		rowPinningFeature,
		cellSelectionFeature,
	});
}

/**
 * The feature set's own type, as `tableFeatures()` inferred it.
 *
 * Every TanStack type the engine touches — `Table`, `Row`, `Column`, `Header`,
 * `TableState` — is parameterised by it, and all of them are invariant in it,
 * so table.js and the adapters must name THIS type rather than re-deriving one.
 */
export type CarbonTableFeatures = ReturnType<typeof buildFeatures>;
