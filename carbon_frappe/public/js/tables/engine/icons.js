// Icons for the table chrome.
//
// House rule (README, "Deliberate deviations"): Carbon assets come from
// @carbon/* packages or not at all, and frappe's own assets are reused rather
// than re-drawn. frappe already ships every glyph this engine needs in its
// sprite sheets (timeless `icon-sort-*`, `icon-drag`, `icon-filter`; espresso
// `es-line-*`), so we go through `frappe.utils.icon` and inherit sprite
// caching, RTL handling and the theme's `currentColor` treatment for free.
//
// The inline fallbacks exist ONLY so the engine renders in scripts/dev-table.mjs,
// which runs outside a desk and therefore has no `frappe` global. They are never
// reached in the app.

const FALLBACK = {
	"sort-ascending": '<path d="M8 3l4 4H4zM7 8h2v5H7z"/>',
	"sort-descending": '<path d="M8 13l-4-4h8zM7 3h2v5H7z"/>',
	sort: '<path d="M5 6l3-3 3 3zM5 10l3 3 3-3z"/>',
	drag: '<path d="M6 3h2v2H6zM6 7h2v2H6zM6 11h2v2H6zM10 3h2v2h-2zM10 7h2v2h-2zM10 11h2v2h-2z"/>',
	filter: '<path d="M2 3h12l-5 6v4l-2 1V9z"/>',
	"es-line-right-chevron": '<path d="M6 3l5 5-5 5z"/>',
	"es-line-settings": '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor"/>',
	"es-small-close": '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" fill="none"/>',
	"es-line-search": '<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor"/><path d="M10 10l3 3" stroke="currentColor"/>',
	"es-line-download": '<path d="M8 2v7M5 7l3 3 3-3M3 13h10" fill="none" stroke="currentColor"/>',
	"es-line-upload": '<path d="M8 12V5M5 8l3-3 3 3M3 13h10" fill="none" stroke="currentColor"/>',
	"expand-alt": '<path d="M6 3l5 5-5 5z"/>',
	collapse: '<path d="M3 6l5 5 5-5z"/>',
};

/** `frappe.utils.icon` when we are in a desk, a static fallback otherwise. */
export function icon(name, size = "sm") {
	if (typeof window !== "undefined" && window.frappe && frappe.utils && frappe.utils.icon) {
		return frappe.utils.icon(name, size);
	}
	const body = FALLBACK[name] || "";
	return `<svg class="icon icon-${size}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}

/** The sort glyph for a column's current sort state. */
export function sortIcon(direction) {
	if (direction === "asc") return icon("sort-ascending", "sm");
	if (direction === "desc") return icon("sort-descending", "sm");
	return icon("sort", "sm");
}
