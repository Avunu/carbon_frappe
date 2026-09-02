// The `dt-*` class contract of frappe-datatable, re-emitted onto engine DOM.
//
// This file is the entire reason a report written against frappe-datatable keeps
// working. Every selector below is one that frappe core, ERPNext, HRMS or an app
// report reaches for by hand — in CSS, in jQuery, or through
// `datatable.style.setStyle()`. Losing one is a silent visual regression in
// somebody else's app, so they are enumerated rather than generated, and
// scripts/markup-manifest.ts holds the audit list.
//
// Naming follows frappe-datatable exactly (src/cellmanager.js `getCellHTML`,
// src/rowmanager.js `getRowHTML`, src/style.js `setStyle`):
//
//   .dt-cell--{colIndex}-{rowIndex}   per-cell target — what timesheet_review.js writes
//   .dt-cell--col-{colIndex}          whole-column target (ERPNext asset.js)
//   .dt-row-{rowIndex}                whole-row target
//   data-row-index / data-col-index   read back via element.dataset, so STRINGS
//
// `colIndex` counts the auto-injected `_checkbox` and `_rowIndex` columns,
// because frappe-datatable's does: `datamanager.columns` includes them, and
// callers iterate that array to build selectors.

import { rowIndexOf } from "./managers";
import type { CarbonEngineRow } from "./managers";
import type { TableClassProfile, TableClassRow } from "../engine/classes";
import type { DataTableInstanceClass, DataTableRowIndex } from "frappe-types";

/** What {@link nextScopeClass} hands back: the counter, and the class built from it. */
export interface DatatableScope {
	/** `DataTable.instances` at construction — 1-based. */
	instance: number;
	/** `dt-instance-{n}`, the per-instance selector `style.setStyle()` scopes with. */
	scopeClass: DataTableInstanceClass;
}

/** Instance counter, mirroring frappe-datatable's `DataTable.instances`. */
let INSTANCES = 0;

export function nextScopeClass(): DatatableScope {
	INSTANCES++;
	return { instance: INSTANCES, scopeClass: `dt-instance-${INSTANCES}` };
}

function add(node: Element, ...names: string[]): void {
	for (const n of names) if (n && !node.classList.contains(n)) node.classList.add(n);
}

function setData(node: Element, name: string, value: string | number): void {
	// The JS stringified twice — once explicitly for the comparison, once
	// implicitly inside `setAttribute`, which takes a DOMString. Naming the
	// result is what lets `setAttribute` be handed a `string`; the value written
	// is character-for-character the one it wrote before.
	const next = String(value);
	if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

/**
 * Is this the prepared row THIS adapter fed the engine?
 *
 * The engine declares `row.original` as `unknown` on purpose — an adapter may
 * hand it anything, and the Grid and List adapters hand it something else
 * entirely — while `rowIndexOf` is written against the prepared
 * `DataTableRow` (an array of cells with `meta` bolted on) that datatable.ts
 * builds. The property tested here is exactly the one
 * `rowIndexOf` goes on to read, so a `true` from this guard is the same
 * condition its own `original && original.meta` branch tests, and a `false`
 * lands on the same `row.index` fallback it would have taken.
 */
function isPreparedRowHandle(row: TableClassRow): row is TableClassRow & CarbonEngineRow {
	const original: unknown = row.original;
	return typeof original === "object" && original !== null && "meta" in original;
}

/**
 * Original-data index of the row behind a profile hook's row handle.
 *
 * Narrowing wrapper around {@link rowIndexOf}, not a second implementation:
 * both branches below are the branches `rowIndexOf` itself would take.
 */
function rowIndexFrom(row: TableClassRow): DataTableRowIndex {
	return isPreparedRowHandle(row) ? rowIndexOf(row) : row.index;
}

/**
 * Build the legacy profile for one CarbonDataTable instance.
 * `scopeClass` goes on the root so `style.setStyle()` can scope rules the way
 * frappe-datatable does, and so ERPNext's `$(".{scopeClass} .dt-scrollable")`
 * still resolves.
 *
 * Typed `TableClassProfile` with its default `THost` of `unknown`: not one hook
 * here reads `ctx.host`, and leaving the host unconstrained is what makes this
 * profile assignable to the engine whatever host it is handed.
 */
export function datatableProfile(scopeClass: string): TableClassProfile {
	return {
		root(node) {
			add(node, "datatable", scopeClass);
		},
		scroll(node) {
			add(node, "dt-scrollable");
		},
		head(node) {
			add(node, "dt-header");
		},
		foot(node) {
			add(node, "dt-footer");
		},
		empty(node) {
			add(node, "dt-scrollable__no-data");
			const span = node.firstElementChild;
			if (span) add(span, "no-data-message");
		},

		headerRow(node) {
			add(node, "dt-row", "dt-row-header");
			setData(node, "data-is-header", "1");
		},
		headerCell(node, { colIndex, content }) {
			add(
				node,
				"dt-cell",
				"dt-cell--header",
				`dt-cell--header-${colIndex}`,
				`dt-cell--col-${colIndex}`
			);
			setData(node, "data-col-index", colIndex);
			setData(node, "data-is-header", "1");
			add(content, "dt-cell__content", `dt-cell__content--header-${colIndex}`);
		},

		filterRow(node) {
			add(node, "dt-row", "dt-row-filter");
			setData(node, "data-is-filter", "1");
		},
		filterCell(node, { colIndex }) {
			add(node, "dt-cell", "dt-cell--filter");
			setData(node, "data-col-index", colIndex);
			const input = node.querySelector("input");
			if (input) {
				add(input, "dt-filter", "dt-input");
				setData(input, "data-col-index", colIndex);
			}
		},

		row(node, { row }) {
			// rowIndexOf, not row.index: under treeView a TanStack row's `index`
			// is its position among SIBLINGS, while every `dt-*` selector and
			// every caller means the row's position in the original flat data.
			const r = rowIndexFrom(row);
			add(node, "dt-row", `dt-row-${r}`);
			setData(node, "data-row-index", r);
		},
		cell(node, { row, colIndex, content }) {
			const r = rowIndexFrom(row);
			add(
				node,
				"dt-cell",
				`dt-cell--col-${colIndex}`,
				`dt-cell--${colIndex}-${r}`,
				`dt-cell--row-${r}`
			);
			setData(node, "data-col-index", colIndex);
			setData(node, "data-row-index", r);
			add(content, "dt-cell__content", `dt-cell__content--col-${colIndex}`);
		},

		totalRow(node) {
			add(node, "dt-row", "dt-row-totalRow");
			setData(node, "data-is-total-row", "1");
		},
		totalCell(node, { colIndex, content }) {
			add(node, "dt-cell", `dt-cell--col-${colIndex}`);
			setData(node, "data-col-index", colIndex);
			setData(node, "data-is-total-row", "1");
			// Stock puts `dt-cell__content` on the inner div of EVERY cell, and
			// the non-header variant of the modifier on anything that is not a
			// header — total-row cells included (cellmanager.js:919-920). This
			// is not decoration: `columnmanager.setColumnWidth` sizes a column
			// by injecting a rule for `.dt-cell__content--col-N`
			// (columnmanager.js:435-450), so a total cell without the class is
			// invisible to every width caller in the ecosystem.
			//
			// This line was dead for the life of the engine: the hook used to
			// destructure a `content` the renderer never passed, so `add`
			// dereferenced `undefined.classList` and threw on every total-row
			// render. `applyProfile` swallowed it into a console.error, which is
			// why it went unnoticed — the two `add`/`setData` calls above had
			// already run, so the row looked right apart from the missing
			// classes. render.ts#renderFoot now passes `content`.
			add(content, "dt-cell__content", `dt-cell__content--col-${colIndex}`);
		},
	};
}
