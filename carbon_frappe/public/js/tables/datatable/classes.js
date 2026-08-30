// The `dt-*` class contract of frappe-datatable, re-emitted onto engine DOM.
//
// This file is the entire reason a report written against frappe-datatable keeps
// working. Every selector below is one that frappe core, ERPNext, HRMS or an app
// report reaches for by hand — in CSS, in jQuery, or through
// `datatable.style.setStyle()`. Losing one is a silent visual regression in
// somebody else's app, so they are enumerated rather than generated, and
// scripts/markup-manifest.mjs holds the audit list.
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

/** Instance counter, mirroring frappe-datatable's `DataTable.instances`. */
let INSTANCES = 0;

export function nextScopeClass() {
	INSTANCES++;
	return { instance: INSTANCES, scopeClass: `dt-instance-${INSTANCES}` };
}

function add(node, ...names) {
	for (const n of names) if (n && !node.classList.contains(n)) node.classList.add(n);
}

function setData(node, name, value) {
	if (node.getAttribute(name) !== String(value)) node.setAttribute(name, value);
}

/**
 * Build the legacy profile for one CarbonDataTable instance.
 * `scopeClass` goes on the root so `style.setStyle()` can scope rules the way
 * frappe-datatable does, and so ERPNext's `$(".{scopeClass} .dt-scrollable")`
 * still resolves.
 */
export function datatableProfile(scopeClass) {
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
			const r = rowIndexOf(row);
			add(node, "dt-row", `dt-row-${r}`);
			setData(node, "data-row-index", r);
		},
		cell(node, { row, colIndex, content }) {
			const r = rowIndexOf(row);
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
			add(content, "dt-cell__content");
		},
	};
}
