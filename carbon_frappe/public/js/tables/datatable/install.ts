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
//      `report_view.js:339 new DataTable(...)`. A global cannot reach that, so
//      `ReportView.prototype.setup_datatable` is overridden instead.
//
// Not reached, deliberately: `frappe/data_import/import_preview.js` and
// `system_console.js` also hold module-local imports. They are low-traffic,
// internal, and keep working on stock frappe-datatable; noted in the README.
import { safePatch } from "../../anatomy/patch";
import CarbonDataTable from "./datatable";
import type { FrappeListDoc, ReportView } from "frappe-types";

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
	safePatch(
		() => frappe.views && frappe.views.ReportView && frappe.views.ReportView.prototype,
		"setup_datatable",
		() =>
			// `this: ReportView` erases, and is the only annotation the body
			// needs: frappe calls the method as `this.setup_datatable(values)`
			// from `report_view.js:263`, so the receiver IS the view. A class
			// method's type carries no implicit `this` for the compiler to infer
			// one from — see safePatch's doc comment.
			//
			// `$datatable_wrapper[0]` needs neither `!` nor a guard: frappe-types
			// declares it a `JQueryRegion` (built from a literal template at
			// `report_view.js:86`), whose index `0` is a real element.
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
						},
					},
					hooks: { columnTotal: frappe.utils.report_column_total },
				});
			},
		"frappe.views.ReportView.prototype.setup_datatable (CarbonDataTable)"
	);
}
