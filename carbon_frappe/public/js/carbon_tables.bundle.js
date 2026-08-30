// carbon_frappe tables — the TanStack + Carbon table engine and its adapters.
//
// This bundle lifts carbon_frappe from a stylesheet to a functional
// replacement: frappe's Grid, List view and Report/Query views all render
// through ONE Carbon-styled, TanStack-driven engine instead of three unrelated
// renderers (a Bootstrap 12-column grid, hand-built div rows, and
// frappe-datatable).
//
// Compatibility is the whole point. Nothing here changes a public frappe API:
// the adapters subclass or override frappe's own classes and re-emit the legacy
// DOM contract (`dt-*`, `grid-*`, `list-row-*`) alongside Carbon's, so existing
// app code — report scripts, doctype list settings, ERPNext's bank
// reconciliation, avunu's timesheet_review — keeps working unmodified.
//
// Load order matters: carbon_frappe's `app_include_js` entries come after
// frappe's, so `frappe.views.ReportView`, `frappe.ui.form.ControlTable` and
// `window.DataTable` all exist by the time this runs.
import { assertPatches } from "./anatomy/patch";
import installDataTable from "./tables/datatable/install";
import installGrid from "./tables/grid/install";
import installListView from "./tables/list/list_view";

function install() {
	installDataTable();
	installGrid();
	installListView();
}

install();
$(document).ready(assertPatches);
