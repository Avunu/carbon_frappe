// carbon_frappe anatomy layer — the places this theme reaches past CSS for
// page chrome.
//
// Every patch delegates to the original and fails soft: if frappe renames a
// target, the component reverts to stock styling and says so, rather than
// throwing inside the desk bundle. scripts/audit-markup.ts guards the same
// targets statically at build time.
//
// `anatomy/datatable.js` used to live here, forcing 48px rows onto
// frappe-datatable after construction. It is gone: carbon_tables.bundle.js now
// REPLACES frappe-datatable outright, and its engine owns the row height. The
// two patches could not coexist anyway — safePatch is idempotent per method, so
// whichever ran first would have locked the other out of
// `ReportView.prototype.setup_datatable`.
//
// The bundle entry is `.js`, deliberately. frappe's esbuild keys assets.json
// by the ENTRY basename — `path.basename(info.entryPoint)` (esbuild.js:450) —
// and emits `dist/js/carbon_anatomy.bundle.<hash>.js` whatever the entry
// extension was, while the `--using-cached` path keys off the OUTPUT name
// (`update_assets_obj`, esbuild.js:181-185). When the entry was `.ts` the
// normal/watch path wrote the key under `carbon_anatomy.bundle.ts`, which
// nothing loads, so the served `.bundle.js` key silently kept its stale hash
// after every watch rebuild. With the entry named `.js`, both keying paths
// agree in every build mode and scripts/patch-assets.ts's JS re-point became a
// no-op tripwire. Renamed from `.ts` 2026-09-17; `include_script` still does a
// bare dict lookup with no extension fallback
// (frappe/utils/jinja_globals.py:151-156).
import { assertPatches } from "./anatomy/patch.ts";
import "./anatomy/editable_title.ts";
import "./anatomy/ui_shell.ts";

$(document).ready(assertPatches);
