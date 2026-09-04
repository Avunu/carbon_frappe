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
//
// The bundle entry is `.ts`, and that MOVES the assets.json key — the output
// name is unchanged, the key is not. frappe's esbuild globs
// `*.bundle.{js,ts,…}` (esbuild/esbuild.js:258) and emits
// `dist/js/carbon_tables.bundle.<hash>.js` whatever the entry extension was, but
// it keys assets.json by the ENTRY basename —
// `path.basename(info.entryPoint)` (esbuild.js:450) — so a normal
// `bench build` files this under `carbon_tables.bundle.ts`. Only the
// `--using-cached` path keys off the OUTPUT name (`update_assets_obj`,
// esbuild.js:181-185) and still writes `carbon_tables.bundle.js`.
//
// hooks.py keeps asking for `.js`, the one name BOTH paths can be made to
// answer, and scripts/patch-assets.ts re-points that key at the freshly built
// file after a normal build. Verified by building: `include_script` does a bare
// dict lookup with no extension fallback (frappe/utils/jinja_globals.py:151-156),
// so without that step the `.js` key silently keeps whatever stale hash an
// older build left in assets.json.
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
