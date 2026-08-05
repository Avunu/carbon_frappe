// carbon_frappe anatomy layer — the only places this theme reaches past CSS.
//
// Every patch delegates to the original and fails soft: if frappe renames a
// target, the component reverts to stock styling and says so, rather than
// throwing inside the desk bundle. scripts/audit-markup.mjs guards the same
// targets statically at build time.
import { assertPatches } from "./anatomy/patch";
import "./anatomy/datatable";
import "./anatomy/editable_title";
import "./anatomy/ui_shell";

$(document).ready(assertPatches);
