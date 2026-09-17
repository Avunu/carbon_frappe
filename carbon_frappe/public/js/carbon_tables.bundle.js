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
// The bundle entry is `.js`, deliberately. frappe's esbuild keys assets.json
// by the ENTRY basename — `path.basename(info.entryPoint)` (esbuild.js:450) —
// and emits `dist/js/carbon_tables.bundle.<hash>.js` whatever the extension
// was, while the `--using-cached` path keys off the OUTPUT name
// (`update_assets_obj`, esbuild.js:181-185). When the entry was `.ts` the
// normal/watch path wrote the key under `carbon_tables.bundle.ts`, which
// nothing loads, so the served `.bundle.js` key silently kept its stale hash
// after every watch rebuild. With the entry named `.js`, both keying paths
// agree in every build mode — watch, full build, `--using-cached` — and
// scripts/patch-assets.ts's JS re-point became a no-op tripwire. Renamed from
// `.ts` 2026-09-17; `include_script` still does a bare dict lookup with no
// extension fallback (frappe/utils/jinja_globals.py:151-156).
import { assertPatches } from "./anatomy/patch.ts";
import installDataTable from "./tables/datatable/install.ts";
import installGrid from "./tables/grid/install.ts";
import installListView from "./tables/list/list_view.ts";

function install() {
	installDataTable();
	installGrid();
	installListView();
}

install();
$(document).ready(assertPatches);
