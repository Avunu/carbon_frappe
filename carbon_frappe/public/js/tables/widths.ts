// Column widths for tables whose columns have no width of their own: the List
// view and, when a caller gives none, Report and Query views.
//
// frappe sizes list columns with CSS flex (`.list-row-col { flex: 1 }`, desk/
// list.scss:381) and only pins a column to a pixel width when somebody chose
// one: a saved layout or the List View Settings `fields` JSON (`df.width`), or a
// header drag. v16.36 additionally ESTIMATED a width from the rendered text of
// every cell (`textLength * 10 / 1.3`, v16.36.1 list_view.js:1055-1071); v16.50.0 removed
// that estimator (list_view.js:1408-1415, 1559-1563), because its flex layout
// shares the free space between unsized columns by itself.
//
// A <table> has no such sharing: every column needs a pixel width up front, and
// `table-layout: fixed` ignores cell content. So the adapters own the estimator
// the frappe version dropped. It is pure — HTML strings in, pixels out — so it
// runs without a DOM and the unit suite can pin its numbers.

/** frappe's own bounds on a list column (`apply_column_widths`, list_view.js:1579-1580). */
export const MIN_WIDTH = 50;
export const MAX_WIDTH = 400;

/**
 * The narrowest an ESTIMATED column gets. Below this a header such as "Status"
 * with its resize affordance starts to clip, and a one-letter column reads as a
 * sliver. Deliberately not frappe's 50: that is the floor of a width somebody
 * dragged to, not of one nobody chose.
 */
export const MIN_ESTIMATE = 96;

/** Carbon's data-table cell inset: 1rem each side. */
const CELL_PADDING = 32;

/**
 * Subject only: the select checkbox and the gap before the title sit in the same
 * cell (`get_subject_element`, list_view.js:1843-1861).
 */
const SUBJECT_EXTRA = 40;

/**
 * A status or select pill is a 24px tag with 8px of inline padding
 * (desk/_widgets.scss), so it is wider than the text inside it.
 */
const PILL_EXTRA = 16;

/** Room the header needs beside its label by default: the resize handle and a little air. */
const HEADER_EXTRA = 16;

// IBM Plex at 14px. Sans averages about 0.54em a character on mixed text; Mono is
// exactly 0.6em. The semibold header runs a little wider than regular text.
const SANS_CHAR = 7.6;
const MONO_CHAR = 8.4;
const HEADER_CHAR = 8;

/** How many characters a cell with no text (a progress bar, an image) is worth. */
const EMPTY_CELL_CHARS = 12;

/** The entities `get_column_html` output actually carries, so `&amp;` counts as one character. */
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi;

/** The visible text of a rendered cell, without a DOM: tags dropped, entities collapsed. */
export function textOf(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(ENTITY, "x")
		.replace(/\s+/g, " ")
		.trim();
}

/** `[min, max]` bounds for a drag or a saved width. */
export function clampWidth(px: number, min: number = MIN_WIDTH, max: number = MAX_WIDTH): number {
	return Math.min(Math.max(px, min), max);
}

/** What {@link estimateWidth} needs to know about one column. */
export interface WidthColumn {
	/** The plain header label; empty for the button and rail columns. */
	label: string;
	/** `true` for the Subject column, which carries the row checkbox. */
	subject?: boolean;
	/**
	 * What the header needs beside its label, in px; defaults to a resize handle
	 * and a little air. A Report or Query column adds its sort glyph and menu
	 * toggle on top (tables/datatable/datatable.ts).
	 */
	headerExtra?: number;
}

/**
 * The width a column wants, from its label and the rendered HTML of a sample of
 * its cells. The widest cell wins; the header is a floor.
 */
export function estimateWidth(column: WidthColumn, cells: Iterable<string>): number {
	const headerExtra = column.headerExtra ?? HEADER_EXTRA;
	let wanted = column.label ? column.label.length * HEADER_CHAR + CELL_PADDING + headerExtra : 0;
	for (const html of cells) {
		const text = textOf(html);
		// `carbon-num` is what carbon_desk.bundle puts on numeric and date output
		// to set it in Plex Mono; a cell that has it is mono end to end.
		const per = html.includes("carbon-num") ? MONO_CHAR : SANS_CHAR;
		const chars = text.length || EMPTY_CELL_CHARS;
		const pill = /indicator-pill|es-badge/.test(html) ? PILL_EXTRA : 0;
		const width = chars * per + CELL_PADDING + pill + (column.subject ? SUBJECT_EXTRA : 0);
		if (width > wanted) wanted = width;
	}
	return clampWidth(Math.ceil(wanted), MIN_ESTIMATE);
}

/**
 * The meta rail's width, by how many assignment avatars the widest row shows.
 *
 * frappe's own minimums for the rail (desk/list.scss:158-188: 130px with none,
 * 165 / 180 / 200 for one, two and three), plus the cell inset, which frappe's
 * flex rail carries as padding inside those numbers and a table cell does not.
 */
export function metaWidth(assignCount: number): number {
	const base = assignCount <= 0 ? 130 : assignCount === 1 ? 165 : assignCount === 2 ? 180 : 200;
	return base + CELL_PADDING;
}
