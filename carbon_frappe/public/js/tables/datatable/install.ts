// Install CarbonDataTable in place of frappe-datatable.
//
// Three separate reach-points, because frappe imports the library three ways:
//
//   1. `frappe.DataTable`  — set by frappe/public/js/frappe/ui/datatable.js,
//      which is the 3-line module `import DataTable from "frappe-datatable";
//      frappe.DataTable = DataTable`. Used by ERPNext (asset.js, ledger_preview,
//      bank reconciliation) and HRMS.
//   2. `window.DataTable`  — set by BOTH report_view.js and query_report.js at
//      module scope. query_report.js constructs from `window.DataTable`, so
//      reassigning it is enough for every Query Report and every third-party
//      report script.
//   3. report_view.js's MODULE-LOCAL import, used at
//      `report_view.js:305 new DataTable(...)`. A global cannot reach that, so
//      `ReportView.prototype.setup_datatable` is overridden instead.
//
// Not reached, deliberately: `frappe/data_import/import_preview.js` and
// `system_console.js` also hold module-local imports. They are low-traffic,
// internal, and keep working on stock frappe-datatable; noted in the README.
import { safePatch } from "../../anatomy/patch.ts";
import CarbonDataTable from "./datatable.ts";
import type { DataTableColumn, FrappeListDoc, ReportView } from "frappe-types";

/**
 * The "Add Column" dialog, which is report_view.js's `headerDropdown` entry
 * (report_view.js:336-407) restated.
 *
 * It cannot be reused: stock builds it as a closure inside `setup_datatable`,
 * which this module replaces, so there is no method to call. What it reaches
 * — `get_columns_for_picker`, `is_column_added`, `add_column_to_datatable` —
 * IS frappe's, and so is every label, which is why the strings match stock's
 * exactly (translations are keyed by them).
 */
function showAddColumnDialog(view: ReportView, anchor: DataTableColumn): void {
	const columns = view.get_columns_for_picker();

	const picker = (columns[view.doctype] ?? [])
		.filter((df) => !view.is_column_added(df))
		.map((df) => ({
			label: __(df.label ?? df.fieldname, null, df.parent),
			value: df.fieldname,
		}));

	// Everything that is not the report's own doctype is a child table's column,
	// offered as "<Label> (<Doctype>)" and keyed "fieldname,Doctype".
	for (const cdt of Object.keys(columns)) {
		if (cdt === view.doctype) continue;
		for (const df of columns[cdt] ?? []) {
			if (view.is_column_added(df)) continue;
			picker.push({
				label: `${__(df.label ?? df.fieldname, null, df.parent)} (${cdt})`,
				value: `${df.fieldname},${cdt}`,
			});
		}
	}

	const anchorLabel = (anchor.docfield && __(anchor.docfield.label)) || "";
	const dialog = new frappe.ui.Dialog({
		title: __("Add Column"),
		fields: [
			{
				label: __("Select Column"),
				fieldname: "column",
				fieldtype: "Autocomplete",
				options: picker,
			},
			{
				label: __("Insert Column Before {0}", [anchorLabel.bold()]),
				fieldname: "insert_before",
				fieldtype: "Check",
			},
		],
		primary_action: ({ column, insert_before }) => {
			if (typeof column !== "string" || !picker.some((option) => option.value === column)) {
				frappe.show_alert({ message: __("Invalid column"), indicator: "orange" });
				dialog.hide();
				return;
			}

			let fieldname = column;
			let doctype = view.doctype;
			if (column.includes(",")) {
				[fieldname = column, doctype = view.doctype] = column.split(",");
			}

			// `colIndex` is the clicked column's position in `datamanager.columns`,
			// which counts the checkbox and serial-number columns; "before" is one
			// to its left (report_view.js:394-397).
			const at = anchor.colIndex ?? 0;
			const index = insert_before ? at - 1 : at;
			view.add_column_to_datatable(fieldname, doctype, index);
			dialog.hide();
		},
	});
	dialog.show();
}

export default function installDataTable(): void {
	if (!window.frappe) return;

	// 1 + 2: the globals.
	window.DataTable = CarbonDataTable;
	frappe.DataTable = CarbonDataTable;

	// 3: report_view.js's module-local import.
	//
	// This REPLACES the 48px-row-height patch that used to live in
	// js/anatomy/datatable.js: the row height is now the engine's own
	// `rowHeight`, snapped to a Carbon row size, so there is nothing left to
	// correct after construction.
	//
	// It restates `setup_datatable` (report_view.js:303-412) in full, because
	// the original constructs the stock library through its module-local
	// import and there is no seam to substitute the class. Everything the
	// original does after `new DataTable(...)` is repeated, and so is every
	// option: a report script that works on stock frappe must find the same
	// `events`, `hooks` and `headerDropdown` here.
	safePatch(
		() => frappe.views && frappe.views.ReportView && frappe.views.ReportView.prototype,
		"setup_datatable",
		() =>
			// `this: ReportView` erases, and is the only annotation the body
			// needs: frappe calls the method as `this.setup_datatable(values)`
			// from `report_view.js:228`, so the receiver IS the view. A class
			// method's type carries no implicit `this` for the compiler to infer
			// one from — see safePatch's doc comment.
			//
			// `$datatable_wrapper[0]` needs neither `!` nor a guard: frappe-types
			// declares it a `JQueryRegion` (built from a literal template at
			// `report_view.js:94`), whose index `0` is a real element.
			function (this: ReportView, values: FrappeListDoc[]) {
				this.$datatable_wrapper.empty();
				this.datatable = new CarbonDataTable(this.$datatable_wrapper[0], {
					columns: this.columns,
					data: this.get_data(values),
					getEditor: this.get_editing_object.bind(this),
					language: frappe.boot.lang,
					translations: frappe.utils.datatable.get_translations(),
					checkboxColumn: true,
					inlineFilters: true,
					noDataMessage: __("No matching entries in the current results"),
					cellHeight: 48,
					direction: frappe.utils.is_rtl() ? "rtl" : "ltr",
					events: {
						onRemoveColumn: (column) => this.remove_column_from_datatable(column),
						onSwitchColumn: (c1, c2) => this.switch_column(c1, c2),
						onCheckRow: () => {
							const checked_items = this.get_checked_items();
							this.toggle_actions_menu_button(checked_items.length > 0);
							// Workflow actions refresh when the SELECTION changes
							// (report_view.js:323-331). The `show.bs.dropdown` hook that
							// used to do it on menu open is gone (`setup_events`), so
							// without this the bulk workflow actions never update.
							if (checked_items.length > 0) this.debounced_toggle_workflow_actions();
						},
					},
					hooks: { columnTotal: frappe.utils.report_column_total },
					headerDropdown: [
						{
							label: __("Add Column"),
							action: (column) => showAddColumnDialog(this, column),
						},
					],
				});

				this.setup_inline_filter_observer();
				this.setup_link_side_panel();
			},
		"frappe.views.ReportView.prototype.setup_datatable (CarbonDataTable)",
	);
}
