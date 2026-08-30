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

/** Is `v` a finite number, or a string that parses cleanly as one? */
function isNumeric(v) {
	if (v === null || v === undefined || v === "") return false;
	return !isNaN(Number(v));
}

function stripHTML(s) {
	return String(s == null ? "" : s).replace(/<[^>]*>/g, "");
}

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
export function guessFilter(keyword = "") {
	if (!keyword || keyword.length === 0) return null;

	let compareString = keyword;
	if ([">", "<", "="].includes(compareString[0])) compareString = keyword.slice(1);
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
	if (parts.length === 2 && parts.every((v) => isNumeric(v.trim())))
		return { type: "range", text: parts.map((v) => v.trim()) };

	return { type: "contains", text: compareString.toLowerCase() };
}

/**
 * The two comparison values for a cell, mirroring filterRows.getCompareValues:
 * a column-supplied `compareValue` wins, then a numeric reading, then the
 * HTML-stripped formatted string.
 */
function compareValues(row, columnId, keyword, meta) {
	if (meta && typeof meta.compareValue === "function") {
		const pair = meta.compareValue(row, keyword, columnId);
		if (Array.isArray(pair)) return pair;
	}
	const raw = row.getValue(columnId);
	const float = parseFloat(raw);
	if (!isNaN(float)) return [float, keyword];
	return [filterText(row, columnId, meta), keyword];
}

/** HTML-stripped, lower-cased display text for a cell. */
function filterText(row, columnId, meta) {
	if (meta && typeof meta.getFilterText === "function") {
		return String(meta.getFilterText(row, columnId) || "").toLowerCase();
	}
	return stripHTML(row.getValue(columnId)).toLowerCase();
}

/** TanStack filterFn implementing the frappe-datatable grammar above. */
export function filterFn_frappe(row, columnId, filterValue, _addMeta, table) {
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
			return parseFloat(raw) === filter.text;
		case "notEquals":
			return parseFloat(raw) !== filter.text;
		case "range": {
			const [value, low] = compareValues(row, columnId, filter.text[0], meta);
			const [, high] = compareValues(row, columnId, filter.text[1], meta);
			return value >= low && value <= high;
		}
		case "containsNumber": {
			const number = parseFloat(filter.text);
			return number === parseFloat(raw) || filterText(row, columnId, meta).includes(filter.text);
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
export function filterFn_frappeGlobal(row, columnId, filterValue, _addMeta, table) {
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
export function sortFn_frappe(rowA, rowB, columnId) {
	const a = rowA.getValue(columnId);
	const b = rowB.getValue(columnId);
	const na = parseFloat(a);
	const nb = parseFloat(b);
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
