// Copyright (c) 2026, Avunu LLC and contributors
// For license information, please see license.txt

import type { ShotSpec } from "./shots.d.ts";

// The demo site carries ERPNext's demo transactions (`erpnextDemo`), and
// carbon_theme/demo.py turns the dev indicator off, so the header is Carbon's
// own g100 UI Shell rather than the striped yellow one a .localhost site gets.
const SHELL = ".cf-shell-header";
const ROWS = ".frappe-list .list-row-container, .result .list-row";
const SETTLE = { wait: 1500 };

// The demo's largest Sales Invoice, opened from its list (its name comes from a
// naming series, so the spec looks it up rather than hard-coding it).
const OPEN_INVOICE = {
	eval: `frappe.db.get_list("Sales Invoice", { fields: ["name"], order_by: "grand_total desc", limit: 1 })
		.then((r) => frappe.set_route("Form", "Sales Invoice", r[0].name));`,
};
const ITEMS = '.frappe-control[data-fieldname="items"]';

// The demo's invoices are submitted, so their grids are read-only. Duplicating
// one (the form's own Duplicate) gives an unsaved draft with the same items,
// whose grid is editable and whose toolbar carries Add row. The eval resolves
// once the new form's grid has drawn its rows.
const DUPLICATE_INVOICE = {
	eval: `new Promise((resolve) => {
		cur_frm.copy_doc();
		const start = Date.now();
		const tick = () => {
			const grid = cur_frm.doc.__islocal && cur_frm.fields_dict.items?.grid;
			if ((grid && grid.wrapper.find(".grid-body .grid-row").length) || Date.now() - start > 20000) resolve();
			else setTimeout(tick, 200);
		};
		tick();
	});`,
};

// Opens the first row as Carbon's expandable row (the grid keeps frappe's
// GridRow.toggle_view), then scrolls the table's toolbar to just below the
// sticky page head, so the toolbar, the rows and the open panel all show.
const EXPAND_FIRST_ROW = {
	eval: `cur_frm.fields_dict.items.grid.grid_rows[0].toggle_view(true);
		window.scrollTo(0, window.scrollY + $(cur_frm.fields_dict.items.wrapper).get(0).getBoundingClientRect().top - 200);`,
};

export default {
	demo: { erpnextDemo: true, date: "2026-01-15", seed: 1 },
	shots: [
		{
			name: "list-view",
			route: "/desk/sales-invoice",
			alt: "The Sales Invoice list in Carbon: the g100 UI Shell header with the module's links, the side nav, filter fields and a Carbon data table with status tags",
			waitFor: SHELL,
			actions: [{ waitFor: ROWS }, SETTLE],
			mask: [".frappe-timestamp"],
			readme: "hero",
			featured: true,
		},
		{
			name: "child-table",
			route: "/desk/sales-invoice",
			alt: "An editable Sales Invoice's Items child table drawn by the theme's table engine, with the Carbon table toolbar and Add row, and the first row expanded into its form in place",
			waitFor: SHELL,
			actions: [
				{ waitFor: ROWS },
				OPEN_INVOICE,
				{ waitFor: `${ITEMS} .grid-body .grid-row` },
				SETTLE,
				DUPLICATE_INVOICE,
				SETTLE,
				EXPAND_FIRST_ROW,
				SETTLE,
			],
			mask: [".frappe-timestamp"],
			readme: "feature",
			featured: true,
		},
		{
			name: "report-view",
			route: "/desk/sales-invoice/view/report",
			alt: "The Sales Invoice Report view on the theme's table engine, with sortable, resizable Carbon column headers",
			waitFor: SHELL,
			actions: [{ waitFor: ".dt-row, .cds--data-table tbody tr" }, SETTLE],
			readme: "feature",
		},
	],
} satisfies ShotSpec;
