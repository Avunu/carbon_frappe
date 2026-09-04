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
// The bundle entry is `.ts`, and that MOVES the assets.json key — the output
// name is unchanged, the key is not. frappe's esbuild globs
// `*.bundle.{js,ts,…}` (esbuild/esbuild.js:258) and emits
// `dist/js/carbon_anatomy.bundle.<hash>.js` whatever the entry extension was, but
// it keys assets.json by the ENTRY basename —
// `path.basename(info.entryPoint)` (esbuild.js:450) — so a normal
// `bench build` files this under `carbon_anatomy.bundle.ts`. Only the
// `--using-cached` path keys off the OUTPUT name (`update_assets_obj`,
// esbuild.js:181-185) and still writes `carbon_anatomy.bundle.js`.
//
// hooks.py keeps asking for `.js`, the one name BOTH paths can be made to
// answer, and scripts/patch-assets.ts re-points that key at the freshly built
// file after a normal build. Verified by building: `include_script` does a bare
// dict lookup with no extension fallback (frappe/utils/jinja_globals.py:151-156),
// so without that step the `.js` key silently keeps whatever stale hash an
// older build left in assets.json.
import { assertPatches } from "./anatomy/patch";
import "./anatomy/editable_title";
import "./anatomy/ui_shell";

$(document).ready(assertPatches);
