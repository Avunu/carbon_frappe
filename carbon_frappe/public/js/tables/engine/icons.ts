// Icons for the table chrome.
//
// House rule (README, "Deliberate deviations"): Carbon assets come from
// @carbon/* packages or not at all, and the theme owns the glyphs it draws.
// These were frappe's sprite icons (`frappe.utils.icon`) until frappe's own
// icon systems started disappearing under the theme (octicons, FontAwesome);
// they are now Carbon's own glyphs, rendered at codegen time from @carbon/icons
// by scripts/generate-icons.ts (named in scripts/lib/icon-manifest.ts) and
// committed in ../../generated/icons.ts. Nothing here reaches frappe, so the
// engine renders identically in a desk and in scripts/dev-table.ts, which has no
// `frappe` global and used to need a hand-drawn fallback table for exactly that.

import { arrowDown16, arrowUp16, arrowsVertical16 } from "../../generated/icons.ts";

/**
 * A column's current sort state, as TanStack reports it: `column.getIsSorted()`
 * returns `false` when the column is unsorted.
 */
export type SortIconDirection = "asc" | "desc" | false;

/** The sort glyph for a column's current sort state. */
export function sortIcon(direction: SortIconDirection): string {
	if (direction === "asc") return arrowUp16;
	if (direction === "desc") return arrowDown16;
	return arrowsVertical16;
}
