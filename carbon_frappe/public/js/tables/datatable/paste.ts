// Paste into the Report / Query view grid.
//
// frappe-datatable had a paste (`cellmanager.js:149-161`, `pasteContentInCell`
// :628-649) that `report_view.js` never enabled — and for good reason: it only
// called `updateCell`, so the grid showed values the server never received.
// This one goes through the same door an edited cell does: the report view's
// `getEditor(...)` hands back an editor whose `setValue` is
// `frappe.db.set_value` plus its own `this.data` bookkeeping
// (report_view.js:712-754), and `commitValue` (./editing.ts) writes
// optimistically and reverts on rejection. So a pasted Link the server refuses
// snaps back exactly like a typed one.
//
// "Compatible values" is decided here, before anything is written:
// {@link coerceForPaste} turns clipboard text into the target fieldtype's
// value or refuses it. Refusals are counted and reported in the toast, never
// written. Numbers accept the user's number format (`strip_number_groups`),
// dates accept the system format `copy()` emits and the user's display format
// (`frappe.datetime.user_to_str`), Selects must name an option, and the
// fieldtypes whose control is a dialog, an upload, or a rich editor are
// refused outright.
//
// Fill semantics are the spreadsheet ones: the clipboard block lands with its
// top-left on the selection's top-left; a single value pasted over a range
// fills the range; a block larger than the selection extends past it, clipped
// to the rows in view and the last focusable column. Columns map 1:1 — a
// non-editable target DROPS its value (counted as skipped) rather than
// shifting the rest left into the wrong column.
//
// Writes are sequential on purpose: `setValue`'s continuation patches the
// report view's `this.data` and may call `datatable.refresh()`, and
// `set_control_value` overwrites `last_updated_doc`; concurrent writes would
// race both.
//
// `writeCell` is also how Space toggles a focused Check cell (./navigation.ts).
import { commitValue } from "./editing";
import type { CarbonDataTableHost } from "./managers";
import type {
	DataTableCellValue,
	DataTableColIndex,
	DataTableEditor,
	DataTableRowIndex,
	DataTableSelectionBounds,
	DocField,
} from "frappe-types";

export interface PasteResult {
	/** Cells whose write stuck. */
	pasted: number;
	/** Cells refused before writing: non-editable, or an incompatible value. */
	skipped: number;
	/** Cells the server rejected (reverted). */
	rejected: number;
}

/** `text` split into rows and cells. One trailing newline (Excel's) is dropped. */
export function parseClipboard(text: string): string[][] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.map((line) => line.split("\t"));
}

/**
 * Fieldtypes a paste never writes: their control is a dialog (Text Editor,
 * report_view.js:781), an upload, a rich editor, or not a value at all.
 */
const REFUSED = new Set<string>([
	"Table",
	"Table MultiSelect",
	"Attach",
	"Attach Image",
	"Attachment Gallery",
	"Image",
	"Signature",
	"Barcode",
	"Geolocation",
	"Password",
	"HTML",
	"Button",
	"Read Only",
	"Heading",
	"Section Break",
	"Column Break",
	"Tab Break",
	"Fold",
	"Text Editor",
	"Code",
	"JSON",
	"HTML Editor",
	"Markdown Editor",
]);

const TRUE_WORDS = new Set(["1", "true", "yes", "y", "✓", "✔", "x"]);
const FALSE_WORDS = new Set(["0", "false", "no", "n"]);

const INT_RE = /^[+-]?\d+(\.0+)?$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function selectOptions(df: DocField): string[] {
	const options = df.options;
	if (typeof options === "string") return options.split("\n");
	if (!Array.isArray(options)) return [];
	const out: string[] = [];
	for (const o of options) {
		if (typeof o === "string") out.push(o);
		else if (o.value !== undefined) out.push(o.value);
		else if (o.label !== undefined) out.push(o.label);
	}
	return out;
}

/** `flt` returns 0 on garbage, so the numeric check is a regex on the normalised text. */
function numeric(t: string, re: RegExp): string | null {
	const s = strip_number_groups(t).replace(/[^\d.eE+-]/g, "");
	return re.test(s) ? s : null;
}

function systemDate(t: string, kind: "Date" | "Datetime" | "Time"): string | undefined {
	const dt = frappe.datetime;
	if (dt.validate(t)) {
		if (kind === "Datetime" && t.indexOf(" ") === -1) return `${t} 00:00:00`;
		return t;
	}
	// user format; moment renders a miss as "Invalid date", which validate refuses
	const s = dt.user_to_str(t, kind === "Time");
	if (!dt.validate(s)) return undefined;
	if (kind === "Datetime" && s.indexOf(" ") === -1) return `${s} 00:00:00`;
	return s;
}

/**
 * The value to write for `text` in a cell of fieldtype `df.fieldtype`, or
 * `undefined` when the text is not a value of that type.
 *
 * An empty string is the type's empty (`0` for the numeric family and Check,
 * `""` otherwise), so clearing cells by pasting blanks works.
 */
export function coerceForPaste(df: DocField, text: string): DataTableCellValue | undefined {
	const type = df.fieldtype;
	if (REFUSED.has(type)) return undefined;
	const t = text.trim();

	switch (type) {
		case "Check": {
			if (t === "") return 0;
			const w = t.toLowerCase();
			if (TRUE_WORDS.has(w)) return 1;
			if (FALSE_WORDS.has(w)) return 0;
			return undefined;
		}
		case "Int":
		case "Duration": {
			if (t === "") return 0;
			const s = numeric(t, INT_RE);
			if (s === null) return undefined;
			const n = cint(s, null);
			if (type === "Duration" && n < 0) return undefined;
			return n;
		}
		case "Float":
		case "Currency":
		case "Percent":
		case "Rating": {
			if (t === "") return 0;
			const s = numeric(t, FLOAT_RE);
			if (s === null) return undefined;
			const n = Number(s);
			if (!Number.isFinite(n)) return undefined;
			if (type === "Rating" && (n < 0 || n > 1)) return undefined;
			return n;
		}
		case "Date":
			return t === "" ? "" : systemDate(t, "Date");
		case "Datetime":
			return t === "" ? "" : systemDate(t, "Datetime");
		case "Time":
			return t === "" ? "" : systemDate(t, "Time");
		case "Select": {
			if (t === "") return "";
			const options = selectOptions(df);
			if (options.includes(t)) return t;
			const lower = t.toLowerCase();
			return options.find((o) => o.toLowerCase() === lower);
		}
		case "Color":
			if (t === "") return "";
			return COLOR_RE.test(t) ? t : undefined;
		default:
			// Data, Link, Dynamic Link, Autocomplete, Phone, Small Text, Text,
			// Long Text, …: the server validates what needs validating (a Link
			// that does not exist rejects and reverts).
			return t;
	}
}

/**
 * Persist `value` into a cell through the host's `getEditor` contract without
 * showing an editor.
 *
 * The control is mounted into an off-DOM `.dt-cell > .dt-cell__edit` — the
 * shape `getEditor` callers walk back up (`parent.closest('.dt-cell')`), so a
 * report script's editor still resolves its cell. Nothing is rendered, and
 * `set_value`'s `df.change → set_focus()` (report_view.js:701) focuses an
 * element that is not being rendered, which the DOM makes a no-op, so the
 * grid keeps keyboard focus.
 *
 * Resolves `"pasted"`, `"rejected"` (the server refused; reverted) or
 * `"skipped"` (no editor: the cell or column is not editable, or `getEditor`
 * refused). A `getEditor` that returns nothing would fall back to a plain
 * input with no server write, which is not a persist, so that is a skip too.
 */
export async function writeCell(
	host: CarbonDataTableHost,
	colIndex: DataTableColIndex,
	rowIndex: DataTableRowIndex,
	value: DataTableCellValue
): Promise<"pasted" | "rejected" | "skipped"> {
	const column = host.datamanager.getColumn(colIndex);
	const cell = host.datamanager.getCell(colIndex, rowIndex);
	if (!column || !cell) return "skipped";
	if (cell.editable === false || column.editable === false) return "skipped";
	if (colIndex < host.standardColumnCount) return "skipped";
	const getEditor = host.options.getEditor;
	if (typeof getEditor !== "function") return "skipped";

	const td = document.createElement("div");
	td.className = "dt-cell";
	td.setAttribute("data-col-index", String(colIndex));
	td.setAttribute("data-row-index", String(rowIndex));
	const parent = document.createElement("div");
	parent.className = `dt-cell__edit dt-cell__edit--col-${colIndex}`;
	td.appendChild(parent);

	const editor: DataTableEditor | false | undefined | void = getEditor(
		colIndex,
		rowIndex,
		cell.content,
		parent,
		column,
		host.datamanager.getRow(rowIndex),
		host.datamanager.getData(rowIndex)
	);
	if (!editor) return "skipped";
	if (value === cell.content) return "pasted";
	const ok = await commitValue(host, colIndex, rowIndex, column, editor, value, cell.content);
	return ok ? "pasted" : "rejected";
}

/** Where a paste lands: one target per clipboard cell that maps onto the grid. */
interface Target {
	colIndex: DataTableColIndex;
	rowIndex: DataTableRowIndex;
	text: string;
}

/**
 * Lay `block` over the grid from the selection's top-left.
 *
 * Returns the targets in row-major order plus the rectangle they cover (view
 * positions and column indices), which becomes the new selection.
 */
export function planFill(
	host: CarbonDataTableHost,
	block: string[][],
	bounds: DataTableSelectionBounds
): { targets: Target[]; rect: DataTableSelectionBounds } {
	const nav = host.navigation;
	const order = nav.viewOrder;
	const cols = nav.focusableColumns();
	const startCol = cols.indexOf(bounds.c1);
	const targets: Target[] = [];
	if (startCol === -1 || !block.length) return { targets, rect: bounds };

	const single = block.length === 1 && (block[0] ?? []).length === 1;
	const selectionIsRange = bounds.c1 !== bounds.c2 || bounds.p1 !== bounds.p2;

	let rows: number;
	let width: number;
	if (single && selectionIsRange) {
		rows = bounds.p2 - bounds.p1 + 1;
		width = cols.indexOf(bounds.c2) - startCol + 1;
	} else {
		rows = block.length;
		width = block.reduce((w, line) => Math.max(w, line.length), 0);
	}

	let lastPos = bounds.p1;
	let lastColAt = startCol;
	for (let r = 0; r < rows; r++) {
		const pos = bounds.p1 + r;
		const rowIndex = order[pos];
		if (rowIndex === undefined) break;
		const line = single ? block[0] : block[r];
		for (let c = 0; c < width; c++) {
			const colIndex = cols[startCol + c];
			if (colIndex === undefined) break;
			const text = single ? (line && line[0]) ?? "" : (line && line[c]) ?? "";
			targets.push({ colIndex, rowIndex, text });
			lastPos = pos;
			lastColAt = startCol + c;
		}
	}
	const lastCol = cols[lastColAt] ?? bounds.c1;
	return { targets, rect: { c1: bounds.c1, c2: lastCol, p1: bounds.p1, p2: lastPos } };
}

/** Paste `text` over the current selection. Resolves once every write settled. */
export async function pasteIntoSelection(host: CarbonDataTableHost, text: string): Promise<PasteResult> {
	const result: PasteResult = { pasted: 0, skipped: 0, rejected: 0 };
	const nav = host.navigation;
	const bounds = nav.bounds();
	if (!bounds) return result;
	const block = parseClipboard(text);
	const { targets, rect } = planFill(host, block, bounds);
	if (!targets.length) return result;

	for (const target of targets) {
		const column = host.datamanager.getColumn(target.colIndex);
		const df = column && column.docfield;
		const value = df ? coerceForPaste(df, target.text) : undefined;
		if (value === undefined) {
			result.skipped++;
			continue;
		}
		const outcome = await writeCell(host, target.colIndex, target.rowIndex, value);
		result[outcome]++;
	}

	// the selection becomes what landed, as a spreadsheet does
	const order = nav.viewOrder;
	const first = order[rect.p1];
	const last = order[rect.p2];
	if (first !== undefined && last !== undefined) {
		nav.focused = { colIndex: rect.c1, rowIndex: first };
		nav.cursor = { colIndex: rect.c2, rowIndex: last };
		nav.render();
	}

	const written = result.pasted + result.rejected + result.skipped;
	if (written) {
		let message = host.translate("{count} cells pasted").replace("{count}", String(result.pasted));
		const missed = result.skipped + result.rejected;
		if (missed) message += ", " + host.translate("{count} skipped").replace("{count}", String(missed));
		host.showToastMessage(message, 3);
	}
	return result;
}
