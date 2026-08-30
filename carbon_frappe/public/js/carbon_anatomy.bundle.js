// carbon_frappe anatomy layer — the places this theme reaches past CSS for
// page chrome.
//
// Every patch delegates to the original and fails soft: if frappe renames a
// target, the component reverts to stock styling and says so, rather than
// throwing inside the desk bundle. scripts/audit-markup.mjs guards the same
// targets statically at build time.
//
// `anatomy/datatable.js` used to live here, forcing 48px rows onto
// frappe-datatable after construction. It is gone: carbon_tables.bundle.js now
// REPLACES frappe-datatable outright, and its engine owns the row height. The
// two patches could not coexist anyway — safePatch is idempotent per method, so
// whichever ran first would have locked the other out of
// `ReportView.prototype.setup_datatable`.
import { assertPatches } from "./anatomy/patch";
import "./anatomy/editable_title";
import "./anatomy/ui_shell";

$(document).ready(assertPatches);
