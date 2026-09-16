import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.ts";

// ---------------------------------------------------------------------------
// What the page-evaluated bodies below hand back.
//
// `page.eval` is generic and defaults to `unknown` — the wire carries
// `returnByValue` JSON with no shape the driver can check, so declaring it is
// the caller's job. These interfaces are that declaration, one per probe and
// named after the binding it lands in. They double as a written record of the
// frappe-datatable compat surface (`datamanager`, `navigation`, `cellmanager`,
// `editing`, `style`) that the Report view drives.
// ---------------------------------------------------------------------------

/** The identity and legacy-DOM census taken once the report view has settled. */
interface ReportInfo {
	ctorName: string;
	isCarbon: boolean;
	frappeDataTableSame: boolean;
	scopeClass: string;
	nCols: number;
	nStd: number;
	nRows: number;
	hasDtRow: number;
	hasDtCell: number;
	cellIndexClass: boolean;
	colClass: boolean;
	rowIdxAttr: boolean;
	scrollable: boolean;
	carbonTable: boolean;
	dtFilter: number;
	inScope: boolean;
}

/** Computed style read back after `style.setStyle` painted a cell. */
interface StyledProbe {
	bg: string | null;
	fw: string | null;
	found: boolean;
}

/** `rowmanager.getCheckedRows()` and what ReportView makes of it. */
interface CheckedProbe {
	checked: number[];
	items: number;
}

/**
 * The checkbox INPUTS after a select-all, against the rows that are drawn.
 *
 * `checked` (the map) was asserted long before `ticked` (the DOM) was, and that
 * gap is exactly where "select-all highlights every row but ticks none" lived:
 * every internal count was right while the boxes the user looks at were empty.
 */
interface CheckAllProbe {
	rendered: number;
	ticked: number;
	highlighted: number;
	headChecked: boolean;
	headIndeterminate: boolean;
	mapChecked: number;
}

/** The `datamanager` members reports reach for. */
interface DataManagerProbe {
	dataIsOriginal: boolean;
	rowsIsArrayOfArrays: boolean;
	cellHasColumn: boolean;
	viewOrderLen: number;
	filteredLen: number;
	colsSkipStd: number;
	appliedFilters: string;
	visibleIdx: boolean;
}

/** Row/header geometry, in the CSS pixels Carbon's lg size promises. */
interface RowGeoProbe {
	rowH: number;
	headH: number;
	sizeClass: boolean;
}

/**
 * Where the grid focus sits.
 *
 * `navigation.focused` is nullable, but every probe that spreads it into a
 * plain object has just called `focus()` or `move()`, so `{ ...focused }` is
 * never the empty object there. Only `firstFocus` — which reads it straight
 * after a synthetic mousedown, and null-checks the result — declares the null.
 */
interface FocusPoint {
	colIndex: number;
	rowIndex: number;
}

/** The state a click on a data cell leaves behind. */
interface FirstFocusProbe {
	focused: FocusPoint | null;
	hasRing: boolean;
	compatFocusedCell: boolean;
}

/**
 * The four arrow steps, plus the column table they are checked against:
 * `[index, id, focusable]` per column.
 */
interface NavProbe {
	seen: FocusPoint[];
	cols: [number, string, boolean][];
}

/** Where ctrl+arrow lands, and the edges it should have landed on. */
interface EdgeProbe {
	right: FocusPoint;
	bottom: FocusPoint;
	lastCol: number;
	lastRow: number;
	order: number[];
}

/** The selection rectangle `navigation.bounds()` reports. */
interface Bounds {
	c1: number;
	c2: number;
	p1: number;
	p2: number;
}

/** A shift+arrow extension, and how much of it the DOM is painting. */
interface RangeProbe {
	bounds: Bounds | null;
	highlighted: number;
	focusRings: number;
	inRange: number;
}

/** What ctrl+C claims to have copied, against what was actually in range. */
interface CopiedProbe {
	n: number;
	cells: number;
}

/**
 * The editor probe. Every field is optional because the body has three exits:
 * `{ skipped }` when the doctype offers no doubly-editable column, `{ skipped,
 * colIndex }` when its cell is not rendered, and the full reading otherwise.
 * The assertions read the fields without narrowing first — they are testing
 * exactly that the full reading came back — so the shape stays flat rather
 * than becoming a union the call sites would have to discriminate.
 */
interface EditableProbe {
	skipped?: string;
	colIndex?: number;
	colId?: string;
	editing?: boolean;
	editingClass?: boolean;
	mount?: boolean;
	control?: boolean;
	compat?: boolean;
}

/** Widths of the cell and of the control mounted inside it. */
interface EditorBoxProbe {
	cell: number;
	input: number;
}

/** Backgrounds of a pinned body cell and a pinned header cell. */
interface FrozenProbe {
	body: string | null;
	head: string | null;
}

/** What a click on an option INSIDE an open editor did to the grid. */
interface EditorClickProbe {
	dragging: boolean;
	/** `null` when the grid lost focus altogether — the `&&` chain short-circuits. */
	focusUnchanged: boolean | null;
	stillEditing: boolean;
	focusStolen: boolean;
	highlighted: number;
}

/** A drag whose mouseup never arrived, and whether the grid healed itself. */
interface LostMouseUpProbe {
	startedDrag: boolean;
	stillDragging: boolean;
	selectingClass: number;
}

/** Computed `z-index` at each of the four sticky levels, plus the inline one. */
interface LayeringProbe {
	bodyPlain: string | null;
	bodyPinned: string | null;
	headPlain: string | null;
	headPinned: string | null;
	inlineOnPinned: string | null;
}

/** One x position in the frozen band where something else was on top. */
interface BleedMiss {
	x: number;
	top: string;
	cell: string | null;
}

/** The row had no pinned cells, so there was nothing to hit-test. */
interface BleedSkipped {
	skipped: true;
}

/** The sweep ran: where it swept, and everything it found in the way. */
interface BleedMeasured {
	/** Absent on the wire — declared so `bleed.skipped ||` discriminates. */
	skipped?: false;
	from: number;
	to: number;
	misses: BleedMiss[];
	missCount: number;
	scrollLeft: number;
	overflow: number;
}

type BleedProbe = BleedSkipped | BleedMeasured;

/** Left edge of the select-all box and of the column's own checkboxes. */
interface CbAlignProbe {
	head: number | null;
	body: number | null;
}

/** A viewport point, in the CSS pixels `Input.dispatchMouseEvent` wants. */
interface Point {
	x: number;
	y: number;
}

/** The two cell centres a real pointer drag should run between. */
interface DragBoxProbe {
	from: Point | null;
	to: Point | null;
}

/** What the pointer drag selected, and whether it let go afterwards. */
interface DraggedProbe {
	bounds: Bounds | null;
	highlighted: number;
	stillDragging: boolean;
	selectingClass: number;
}

/** The `enabled` / `bio` / `user_type` column indices once added, or why not. */
interface EditColumnsProbe {
	check: number;
	text: number;
	select: number;
	data: number;
	skipped?: string;
}

/** The Check editor's box: it must paint, not merely exist. */
interface CheckEditorProbe {
	present: boolean;
	width: number;
	height: number;
	border: string;
	background: string;
	/** Editor box minus the static box one row down, x and y (y less the row height). */
	dx: number;
	dy: number;
	weight: string;
}

/** Space on a focused Check cell: the write and the cell after it. */
interface CheckToggleProbe {
	before: unknown;
	after: unknown;
	calls: number;
	payload: unknown;
	focusKept: boolean;
}

/** The multi-line editor's geometry against its row. */
interface MultilineProbe {
	weight: string;
	marked: boolean;
	textareaHeight: number;
	contained: boolean;
	belowRowTop: boolean;
	framed: boolean;
	inlineHeight: string;
}

/** What one synthetic paste did. */
interface PasteProbe {
	prevented: boolean;
	result: { pasted: number; skipped: number; rejected: number } | null;
	calls: unknown[];
	cells: unknown[];
	bounds: Bounds | null;
	toast: string;
	dataValue?: unknown;
}

const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
// The condition is `unknown` on purpose: assertions hand this whatever their
// expression produced — a boolean, a string, a null out of `querySelector` —
// and the only thing read of it is its truthiness.
const ok = (n: string, c: unknown, x = "") =>
	results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A trusted key press through CDP; Enter/Space carry `text` so a textarea receives them. */
async function key(keyName: string, code = keyName, modifiers = 0): Promise<void> {
	const text = keyName === "Enter" ? "\r" : keyName === " " ? " " : undefined;
	await page.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		key: keyName,
		code,
		modifiers,
		...(text ? { text } : {}),
	});
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
	await sleep(150);
}
try {
	await login(page, BASE);
	const who = await page.eval<string | undefined>(
		`(async () => (await (await fetch('/api/method/frappe.auth.get_logged_user')).json()).message)()`,
	);
	ok("logged in", who === "Administrator", String(who));

	await page.goto(`${BASE}/app/user/view/report`);
	await page.waitFor(`!!window.cur_list && !!cur_list.datatable`, { timeout: 90000 });
	// Guard: a stolen assets.json key means we would be measuring stock frappe.
	await assertCarbonStylesheet(page);
	await new Promise((r) => setTimeout(r, 2500));

	const info = await page.eval<ReportInfo>(`(() => {
    const dt = cur_list.datatable;
    return {
      ctorName: dt.constructor.name,
      isCarbon: dt.constructor === window.DataTable && !!dt.engine,
      frappeDataTableSame: frappe.DataTable === window.DataTable,
      scopeClass: dt.style && dt.style.scopeClass,
      nCols: dt.datamanager.getColumns().length,
      nStd: dt.datamanager.getStandardColumnCount(),
      nRows: dt.datamanager.rowCount,
      hasDtRow: document.querySelectorAll('.dt-row').length,
      hasDtCell: document.querySelectorAll('.dt-cell').length,
      cellIndexClass: !!document.querySelector('.dt-cell--0-0'),
      colClass: !!document.querySelector('.dt-cell--col-0'),
      rowIdxAttr: document.querySelector('.dt-row[data-row-index]') !== null,
      scrollable: !!document.querySelector('.dt-scrollable'),
      carbonTable: !!document.querySelector('table.cds--data-table'),
      dtFilter: document.querySelectorAll('.dt-filter').length,
      inScope: !!document.querySelector('.' + dt.style.scopeClass + ' .dt-scrollable'),
    };
  })()`);
	console.log(JSON.stringify(info, null, 2));
	ok("ReportView uses CarbonDataTable", info.isCarbon, info.ctorName);
	ok("frappe.DataTable === window.DataTable", info.frappeDataTableSame);
	ok("renders Carbon light-DOM table", info.carbonTable);
	ok(
		"legacy .dt-row/.dt-cell emitted",
		info.hasDtRow > 0 && info.hasDtCell > 0,
		`rows=${info.hasDtRow} cells=${info.hasDtCell}`,
	);
	ok("per-cell .dt-cell--{c}-{r} target exists", info.cellIndexClass);
	ok("per-column .dt-cell--col-{c} target exists", info.colClass);
	ok("data-row-index on rows", info.rowIdxAttr);
	ok(".dt-scrollable under scopeClass (ERPNext selector)", info.inScope, info.scopeClass);
	ok("inline filter inputs are .dt-filter", info.dtFilter > 0, `n=${info.dtFilter}`);
	ok("checkbox + serial standard columns present", info.nStd === 2, `std=${info.nStd}`);

	// style.setStyle — the 13-call-site API
	const styled = await page.eval<StyledProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.style.setStyle('.dt-cell--1-0', { backgroundColor: 'rgb(255, 0, 0)', fontWeight: '700' });
    return new Promise(res => setTimeout(() => {
      const cell = document.querySelector('.dt-cell--1-0');
      const cs = cell && getComputedStyle(cell);
      res({ bg: cs && cs.backgroundColor, fw: cs && cs.fontWeight, found: !!cell });
    }, 300));
  })()`);
	ok(
		"style.setStyle applies to a cell",
		styled.found && styled.bg === "rgb(255, 0, 0)" && styled.fw === "700",
		JSON.stringify(styled),
	);

	// rowmanager checked rows
	const checked = await page.eval<CheckedProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.rowmanager.checkRow(0, true);
    dt.rowmanager.checkRow(1, true);
    return { checked: dt.rowmanager.getCheckedRows(), items: cur_list.get_checked_items().length };
  })()`);
	ok("rowmanager.getCheckedRows()", JSON.stringify(checked.checked) === "[0,1]", JSON.stringify(checked));
	ok("ReportView.get_checked_items() sees them", checked.items === 2, `n=${checked.items}`);

	// select-all, through the header box the user actually clicks
	const checkAll = await page.eval<CheckAllProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.rowmanager.checkAll(false);
    document.querySelector('.dt-row-header .dt-checkbox').click();
    const probe = () => {
      const boxes = [...document.querySelectorAll('tbody .dt-checkbox')];
      const head = document.querySelector('.dt-row-header .dt-checkbox');
      return {
        rendered: boxes.length,
        ticked: boxes.filter(b => b.checked).length,
        highlighted: document.querySelectorAll('tbody tr.cds--data-table--selected').length,
        headChecked: head.checked,
        headIndeterminate: head.indeterminate,
        mapChecked: dt.rowmanager.getCheckedRows().length,
      };
    };
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(probe()))));
  })()`);
	ok(
		"select-all ticks every row's checkbox, not just the highlight",
		checkAll.rendered > 0 && checkAll.ticked === checkAll.rendered,
		JSON.stringify(checkAll),
	);
	ok(
		"select-all highlights the same rows it ticks",
		checkAll.highlighted === checkAll.rendered,
		JSON.stringify(checkAll),
	);
	ok(
		"select-all leaves the header box checked, not indeterminate",
		checkAll.headChecked && !checkAll.headIndeterminate,
		JSON.stringify(checkAll),
	);

	// ...and one row on its own leaves the header showing "some"
	const partial = await page.eval<CheckAllProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.rowmanager.checkAll(false);
    dt.rowmanager.checkRow(1, true);
    const probe = () => {
      const boxes = [...document.querySelectorAll('tbody .dt-checkbox')];
      const head = document.querySelector('.dt-row-header .dt-checkbox');
      return {
        rendered: boxes.length,
        ticked: boxes.filter(b => b.checked).length,
        highlighted: document.querySelectorAll('tbody tr.cds--data-table--selected').length,
        headChecked: head.checked,
        headIndeterminate: head.indeterminate,
        mapChecked: dt.rowmanager.getCheckedRows().length,
      };
    };
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(probe()))));
  })()`);
	ok(
		"rowmanager.checkRow ticks the box it checks",
		partial.ticked === 1 && partial.mapChecked === 1,
		JSON.stringify(partial),
	);
	ok(
		"one checked row leaves the header box indeterminate",
		partial.headIndeterminate && !partial.headChecked,
		JSON.stringify(partial),
	);
	await page.eval(`(() => cur_list.datatable.rowmanager.checkAll(false))()`);

	// datamanager surface used by reports
	const dm = await page.eval<DataManagerProbe>(`(() => {
    const dt = cur_list.datatable;
    return {
      dataIsOriginal: !!dt.datamanager.getData(0),
      rowsIsArrayOfArrays: Array.isArray(dt.datamanager.rows[0]),
      cellHasColumn: !!(dt.datamanager.getCell(2,0) || {}).column,
      viewOrderLen: dt.datamanager.rowViewOrder.length,
      filteredLen: dt.datamanager.getFilteredRowIndices().length,
      colsSkipStd: dt.datamanager.getColumns(true).length,
      appliedFilters: JSON.stringify(dt.columnmanager.getAppliedFilters()),
      visibleIdx: Array.isArray(dt.bodyRenderer.visibleRowIndices),
    };
  })()`);
	ok(
		"datamanager shape (rows/data/cells/viewOrder)",
		dm.dataIsOriginal && dm.rowsIsArrayOfArrays && dm.cellHasColumn && dm.viewOrderLen > 0,
		JSON.stringify(dm),
	);

	// Carbon lg rows are 48px; a collapsed row height is the classic symptom of
	// frappe-datatable's stylesheet winning over Carbon's cell padding.
	const rowGeo = await page.eval<RowGeoProbe>(`(() => {
    const tr = document.querySelector('.cf-table__body .dt-row');
    const th = document.querySelector('.dt-cell--header');
    return { rowH: Math.round(tr.getBoundingClientRect().height),
             headH: Math.round(th.getBoundingClientRect().height),
             sizeClass: document.querySelector('.cds--data-table').className.includes('cds--data-table--lg') };
  })()`);
	ok("rows are Carbon lg (48px)", rowGeo.rowH >= 44 && rowGeo.rowH <= 52, JSON.stringify(rowGeo));
	ok("header row matches body row size", Math.abs(rowGeo.headH - rowGeo.rowH) <= 4, JSON.stringify(rowGeo));
	ok("cds--data-table--lg applied", rowGeo.sizeClass);

	// --- the Report view is a spreadsheet, not a list -----------------------
	// Most columns come back editable and report_view.js supplies a getEditor, so
	// the surface needs frappe-datatable's whole grid interaction: focus ring,
	// arrow movement skipping non-focusable columns, shift-extend, ctrl-edge,
	// enter-to-edit and ctrl+C. Reproduced from cellmanager.js:45-160.
	// click a data cell to focus it
	const firstFocus = await page.eval<FirstFocusProbe>(`(() => {
    const dt = cur_list.datatable;
    const td = document.querySelector('tbody .dt-cell[data-col-index="3"][data-row-index="0"]');
    td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // A real click also releases. Without the mouseup this left the grid in
    // drag mode for the remainder of the suite, and later assertions then
    // measured a drag nobody started.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return {
      focused: dt.navigation.focused,
      hasRing: td.classList.contains('dt-cell--focus'),
      compatFocusedCell: dt.cellmanager.$focusedCell === td,
    };
  })()`);
	ok("clicking a cell focuses it", firstFocus.hasRing && !!firstFocus.focused, JSON.stringify(firstFocus));
	ok("cellmanager.$focusedCell reflects it", firstFocus.compatFocusedCell);

	const nav = await page.eval<NavProbe>(`(() => {
    const dt = cur_list.datatable;
    const seen = [];
    const step = (dir, opts) => { dt.navigation.move(dir, opts || {}); seen.push({ ...dt.navigation.focused }); };
    step('right'); step('down'); step('left'); step('up');
    return { seen, cols: dt.columns.map((c, i) => [i, c.id, c.focusable !== false]) };
  })()`);
	const focusable = nav.cols.filter((c) => c[2]).map((c) => c[0]);
	ok(
		"arrows move focus and skip non-focusable columns",
		nav.seen.every((f) => focusable.includes(f.colIndex)),
		JSON.stringify({ seen: nav.seen, focusable }),
	);

	const edge = await page.eval<EdgeProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(3, 0);
    dt.navigation.move('right', { toEdge: true });
    const right = { ...dt.navigation.focused };
    dt.navigation.move('down', { toEdge: true });
    const bottom = { ...dt.navigation.focused };
    return { right, bottom, lastCol: dt.columns.length - 1, lastRow: dt.datamanager.rowCount - 1,
             order: dt.datamanager.rowViewOrder };
  })()`);
	ok(
		"ctrl+arrow jumps to the row/column edge",
		edge.right.colIndex === edge.lastCol && edge.bottom.rowIndex === edge.order[edge.order.length - 1],
		JSON.stringify(edge),
	);

	const range = await page.eval<RangeProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(3, 0);
    dt.navigation.move('right', { extend: true });
    dt.navigation.move('down', { extend: true });
    const b = dt.navigation.bounds();
    return { bounds: b,
      highlighted: document.querySelectorAll('.dt-cell--highlight').length,
      focusRings: document.querySelectorAll('.dt-cell--focus').length,
      inRange: dt.cellmanager.getCellsInRange().length };
  })()`);
	ok(
		"shift+arrow extends a selection rectangle",
		range.bounds && range.bounds.c2 > range.bounds.c1 && range.bounds.p2 > range.bounds.p1,
		JSON.stringify(range.bounds),
	);
	ok(
		"the range is painted and exactly one cell keeps the ring",
		range.highlighted >= 3 && range.focusRings === 1,
		JSON.stringify({ h: range.highlighted, f: range.focusRings, n: range.inRange }),
	);

	const copied = await page.eval<CopiedProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(3, 0);
    dt.navigation.move('down', { extend: true });
    const n = dt.navigation.copy();
    return { n, cells: dt.cellmanager.getCellsInRange().length };
  })()`);
	ok("ctrl+C copies the selection as TSV", copied.n === copied.cells && copied.n > 1, JSON.stringify(copied));

	const editable = await page.eval<EditableProbe>(`(() => {
    const dt = cur_list.datatable;
    // Editability is gated at BOTH levels, exactly as frappe-datatable gates it
    // (cellmanager.activateEditing checks the column, then the cell). On User,
    // user_image is column-editable but cell-editable false and is correctly
    // refused; username and user_type pass both. A column-only check picks the
    // wrong cell and reads as a product failure.
    const colIndex = dt.columns.findIndex((c, i) => {
      if (i < dt.standardColumnCount || c.editable === false || !c.docfield) return false;
      const cell = dt.datamanager.getCell(i, 0);
      return !!cell && cell.editable !== false;
    });
    if (colIndex === -1) return { skipped: 'no editable column on this doctype' };
    dt.navigation.focus(colIndex, 0);
    dt.navigation.activateFocused();
    const td = document.querySelector('tbody .dt-cell[data-col-index="' + colIndex + '"][data-row-index="0"]');
    if (!td) return { skipped: 'cell not rendered', colIndex };
    return {
      colIndex,
      colId: dt.columns[colIndex].id,
      editing: !!dt.editing.$editingCell,
      editingClass: td.classList.contains('dt-cell--editing'),
      mount: !!td.querySelector('.dt-cell__edit'),
      control: !!td.querySelector('.dt-cell__edit input, .dt-cell__edit select, .dt-cell__edit textarea, .dt-cell__edit .frappe-control'),
      compat: dt.cellmanager.$editingCell === td,
    };
  })()`);
	console.log(JSON.stringify(editable));
	ok(
		"enter opens a real frappe editor in the cell",
		editable.editing && editable.editingClass && editable.mount && editable.control,
		JSON.stringify(editable),
	);
	ok("cellmanager.$editingCell reflects it", editable.compat, JSON.stringify(editable));

	await page.eval(`cur_list.datatable.editing.deactivate(false)`);

	// --- the editor must actually be usable --------------------------------
	// `.dt-cell__edit` is positioned against the cell's PADDING box, so it is
	// already inset by Carbon's 16px; its own padding on top left a 120px column
	// with ~30px of usable width, and frappe's Link control reserves a further
	// 44px for its open-record arrow.
	const editorBox = await page.eval<EditorBoxProbe>(`(() => {
    const dt = cur_list.datatable;
    const colIndex = dt.columns.findIndex((c, i) => {
      if (i < dt.standardColumnCount || c.editable === false || !c.docfield) return false;
      const cell = dt.datamanager.getCell(i, 0);
      return !!cell && cell.editable !== false;
    });
    dt.navigation.focus(colIndex, 0);
    dt.navigation.activateFocused();
    const td = document.querySelector('tbody .dt-cell[data-col-index="' + colIndex + '"][data-row-index="0"]');
    const input = td.querySelector('.dt-cell__edit input, .dt-cell__edit textarea, .dt-cell__edit select');
    const w = (n) => (n ? Math.round(n.getBoundingClientRect().width) : 0);
    const res = { cell: w(td), input: w(input) };
    dt.editing.deactivate(false);
    return res;
  })()`);
	ok(
		"the editor uses most of the cell width",
		editorBox.input / editorBox.cell > 0.85,
		JSON.stringify(editorBox),
	);

	// --- editing: Check, multi-line, paste ----------------------------------
	// Four fixture columns on User, appended in this order so `bio` and
	// `first_name` are adjacent for the block paste: `bio` (Small Text),
	// `first_name` (Data), `mute_sounds` (Check — `enabled` is read_only and so
	// never editable in a report view) and `desk_theme` (Select). Every
	// write goes through report_view's `setValue` → `frappe.db.set_value`,
	// which is stubbed in-page so the doctype is never mutated: the stub keeps
	// report_view's contract (a thenable with `.fail`, resolving `{ message:
	// <the whole doc> }`) and rejects when a value is `REJECT_ME`.
	// The report view persists its columns in the user's settings on every
	// refresh, so the fixture remembers which ones it added and removes them at
	// the end (`__cfAddedFields`).
	await page.eval(`(() => {
    const rv = cur_list;
    window.__cfAddedFields = [];
    for (const f of ['bio', 'first_name', 'mute_sounds', 'desk_theme']) {
      if (rv.fields.some((x) => x[0] === f)) continue;
      window.__cfAddedFields.push(f);
      rv.add_column_to_datatable(f, 'User', rv.fields.length);
    }
  })()`);
	await page.waitFor(
		`!!cur_list.datatable && ['bio','first_name','mute_sounds','desk_theme'].every((f) => cur_list.datatable.columns.some((c) => c.docfield && c.docfield.fieldname === f)) && document.querySelectorAll('tbody .dt-cell').length > 0`,
		{ timeout: 90000 },
	);
	await sleep(800);
	const editCols = await page.eval<EditColumnsProbe>(`(() => {
    const dt = cur_list.datatable;
    const at = (f) => dt.columns.findIndex((c) => c.docfield && c.docfield.fieldname === f);
    return { check: at('mute_sounds'), text: at('bio'), select: at('desk_theme'), data: at('first_name') };
  })()`);
	await page.eval(`(() => {
    window.__cfSetValueCalls = [];
    window.__cfRealSetValue = frappe.db.set_value;
    frappe.db.set_value = (doctype, name, values) => {
      window.__cfSetValueCalls.push({ doctype, name, values });
      const d = $.Deferred();
      const base = Object.assign({ doctype, name }, cur_list.data.find((r) => r.name === name) || {});
      if (Object.values(values).some((v) => v === 'REJECT_ME')) setTimeout(() => d.reject(), 0);
      else setTimeout(() => d.resolve({ message: Object.assign(base, values) }), 0);
      return d.promise();
    };
  })()`);

	// Check editor paints
	const checkEditor = await page.eval<CheckEditorProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(${editCols.check}, 0);
    dt.navigation.activateFocused();
    const box = document.querySelector('tbody .dt-cell--editing .dt-cell__edit input[type="checkbox"]');
    const cs = box ? getComputedStyle(box) : null;
    const r = box ? box.getBoundingClientRect() : { width: 0, height: 0 };
    const below = document.querySelector('tbody .dt-cell[data-col-index="${editCols.check}"][data-row-index="' + dt.datamanager.rowViewOrder[1] + '"] input[type="checkbox"]');
    const b = below ? below.getBoundingClientRect() : { left: 0, top: 0 };
    const rowH = document.querySelector('tbody tr.dt-row').getBoundingClientRect().height;
    const res = { present: !!box, width: Math.round(r.width), height: Math.round(r.height), border: cs ? cs.borderTopWidth + ' ' + cs.borderTopColor : '', background: cs ? cs.backgroundColor + ' ' + cs.backgroundImage : '',
                  dx: Math.round(r.left - b.left), dy: Math.round(r.top - (b.top - rowH)), weight: cs ? cs.fontWeight : '' };
    dt.editing.deactivate(false);
    return res;
  })()`);
	ok(
		"the Check editor is a visible 16px box",
		checkEditor.present &&
			checkEditor.width === 16 &&
			checkEditor.height === 16 &&
			!/^0px/.test(checkEditor.border),
		JSON.stringify(checkEditor),
	);
	// The editor's box is centred in the cell; the static box is an inline-block
	// on a line box's baseline and so sits ~2px higher. Same column, same size.
	ok(
		"the Check editor sits where the static box sits",
		Math.abs(checkEditor.dx) <= 1 && Math.abs(checkEditor.dy) <= 2,
		JSON.stringify({ dx: checkEditor.dx, dy: checkEditor.dy }),
	);

	// Space toggles a focused Check cell through setValue
	await page.eval(
		`(() => { const dt = cur_list.datatable; dt.navigation.focus(${editCols.check}, 0); dt.engine.renderer.scroll.focus(); window.__cfSetValueCalls.length = 0; window.__cfBefore = dt.datamanager.getCell(${editCols.check}, 0).content; })()`,
	);
	await key(" ", "Space");
	await sleep(300);
	const toggled = await page.eval<CheckToggleProbe>(`(() => {
    const dt = cur_list.datatable;
    const calls = window.__cfSetValueCalls;
    return { before: window.__cfBefore, after: dt.datamanager.getCell(${editCols.check}, 0).content, calls: calls.length, payload: calls[0] && calls[0].values, focusKept: document.activeElement === dt.engine.renderer.scroll };
  })()`);
	ok(
		"space flips a focused Check cell and saves it once",
		toggled.calls === 1 &&
			Number(toggled.after) === (Number(toggled.before) ? 0 : 1) &&
			JSON.stringify(toggled.payload) === JSON.stringify({ mute_sounds: Number(toggled.after) }) &&
			toggled.focusKept,
		JSON.stringify(toggled),
	);
	await key(" ", "Space");
	await sleep(300);

	// multi-line editor is a contained popover; Enter is a newline; ctrl+Enter commits
	await page.eval(
		`(() => { const dt = cur_list.datatable; dt.navigation.focus(${editCols.text}, 0); dt.navigation.activateFocused(); })()`,
	);
	// `initValue` → `control.set_value` lands asynchronously; let it, or it clobbers the typed text below
	await sleep(400);
	const multiline = await page.eval<MultilineProbe>(`(() => {
    const td = document.querySelector('tbody .dt-cell--editing');
    const mount = td && td.querySelector('.dt-cell__edit');
    const ta = mount && mount.querySelector('textarea');
    if (!td || !mount || !ta) return { weight: '', marked: false, textareaHeight: 0, contained: false, belowRowTop: false, framed: false, inlineHeight: '' };
    const m = mount.getBoundingClientRect(), t = ta.getBoundingClientRect(), row = td.getBoundingClientRect();
    return { weight: getComputedStyle(ta).fontWeight, marked: mount.classList.contains('dt-cell__edit--multiline'), textareaHeight: Math.round(t.height),
             contained: t.top >= m.top - 1 && t.bottom <= m.bottom + 1, belowRowTop: m.top >= row.top - 1,
             framed: getComputedStyle(mount).outlineStyle !== 'none' && getComputedStyle(mount).boxShadow !== 'none', inlineHeight: ta.style.height };
  })()`);
	ok(
		"a Small Text editor is a framed popover that contains its textarea",
		multiline.marked &&
			multiline.textareaHeight >= 100 &&
			multiline.contained &&
			multiline.belowRowTop &&
			multiline.framed &&
			multiline.inlineHeight === "",
		JSON.stringify(multiline),
	);
	// frappe v16's espresso scale sets `--weight-regular: 420` on `.frappe-control`; the theme pins it to 400
	ok("the editor's text weighs the same as the cell's", multiline.weight === "400", multiline.weight);
	await page.eval(
		`(() => { const ta = document.querySelector('tbody .dt-cell--editing textarea'); ta.focus(); ta.value = 'line one'; ta.setSelectionRange(8, 8); window.__cfSetValueCalls.length = 0; })()`,
	);
	await key("Enter");
	const afterEnter = await page.eval<{ editing: boolean; value: string }>(
		`(() => ({ editing: !!cur_list.datatable.editing.$editingCell, value: (document.querySelector('tbody .dt-cell--editing textarea') || {}).value || '' }))()`,
	);
	ok(
		"enter in a multi-line editor inserts a newline and keeps editing",
		afterEnter.editing && afterEnter.value === "line one\n",
		JSON.stringify(afterEnter),
	);
	await key("Enter", "Enter", 2);
	await sleep(300);
	const afterCtrlEnter = await page.eval<{ editing: boolean; calls: number; value: unknown }>(
		`(() => ({ editing: !!cur_list.datatable.editing.$editingCell, calls: window.__cfSetValueCalls.length, value: window.__cfSetValueCalls[0] && window.__cfSetValueCalls[0].values.bio }))()`,
	);
	ok(
		"ctrl+enter commits the multi-line editor",
		!afterCtrlEnter.editing && afterCtrlEnter.calls === 1 && afterCtrlEnter.value === "line one\n",
		JSON.stringify(afterCtrlEnter),
	);

	// paste
	const PASTE = (tsv: string, focus: string, after = "") => `(async () => {
    const dt = cur_list.datatable;
    window.__cfSetValueCalls.length = 0;
    ${focus}
    const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(tsv)});
    const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    const target = dt.editing.$editingCell ? dt.editing.$editingCell.querySelector('input, textarea') : dt.engine.renderer.scroll;
    target.dispatchEvent(ev);
    const result = dt.navigation.lastPaste ? await dt.navigation.lastPaste : null;
    const toast = (document.querySelector('.dt-toast') || {}).textContent || '';
    ${after}
    return { prevented: ev.defaultPrevented, result, calls: window.__cfSetValueCalls.map((c) => c.values), cells: window.__cfCells ? window.__cfCells() : [], bounds: dt.navigation.bounds(), toast, dataValue: window.__cfDataValue };
  })()`;
	await page.eval(
		`window.__cfCells = () => { const dt = cur_list.datatable; const b = dt.navigation.bounds(); const out = []; for (let p = b.p1; p <= b.p2; p++) for (let c = b.c1; c <= b.c2; c++) out.push(dt.datamanager.getCell(c, dt.datamanager.rowViewOrder[p]).content); return out; }`,
	);

	const rowCount = await page.eval<number>(`cur_list.datatable.datamanager.rowViewOrder.length`);
	if (rowCount >= 3) {
		const fill = await page.eval<PasteProbe>(
			PASTE(
				"Pasted",
				`dt.navigation.focus(${editCols.data}, dt.datamanager.rowViewOrder[0]); dt.navigation.focus(${editCols.data}, dt.datamanager.rowViewOrder[2], { extend: true }); dt.navigation.lastPaste = undefined;`,
				`window.__cfDataValue = cur_list.data[0].first_name;`,
			),
		);
		ok(
			"a single value pasted over a 1x3 selection fills all three cells",
			fill.prevented &&
				fill.result &&
				fill.result.pasted === 3 &&
				fill.calls.length === 3 &&
				fill.calls.every((v) => JSON.stringify(v) === '{"first_name":"Pasted"}') &&
				fill.cells.join("|") === "Pasted|Pasted|Pasted",
			JSON.stringify(fill),
		);
		ok(
			"the report view's own data reflects the pasted value",
			fill.dataValue === "Pasted",
			String(fill.dataValue),
		);
	} else {
		ok("a single value pasted over a 1x3 selection fills all three cells", false, "fewer than 3 rows");
	}

	const block = await page.eval<PasteProbe>(
		PASTE(
			"A\tB\nC\tD\n",
			`dt.navigation.focus(${editCols.text}, dt.datamanager.rowViewOrder[0]); dt.navigation.lastPaste = undefined;`,
		),
	);
	ok(
		"a 2x2 block pasted on one cell extends past it and selects what landed",
		block.result &&
			block.result.pasted === 4 &&
			block.calls.length === 4 &&
			block.cells.join("|") === "A|B|C|D" &&
			!!block.bounds &&
			block.bounds.p2 - block.bounds.p1 === 1 &&
			block.bounds.c2 - block.bounds.c1 === 1,
		JSON.stringify(block),
	);

	const checkPaste = await page.eval<PasteProbe>(
		PASTE(
			"yes\nmaybe\n",
			`dt.navigation.focus(${editCols.check}, dt.datamanager.rowViewOrder[0]); dt.navigation.lastPaste = undefined;`,
		),
	);
	ok(
		'"yes" into a Check column arrives as 1 and "maybe" is skipped',
		checkPaste.result &&
			checkPaste.result.pasted === 1 &&
			checkPaste.cells[0] === 1 &&
			(checkPaste.calls.length === 0 || JSON.stringify(checkPaste.calls[0]) === '{"mute_sounds":1}') &&
			checkPaste.result.skipped === 1 &&
			/skipped/.test(checkPaste.toast),
		JSON.stringify(checkPaste),
	);

	const selectPaste = await page.eval<PasteProbe>(
		PASTE(
			"dark\nNope\n",
			`dt.navigation.focus(${editCols.select}, dt.datamanager.rowViewOrder[0]); dt.navigation.lastPaste = undefined;`,
		),
	);
	ok(
		"a Select accepts an option (case-insensitively, canonical spelling) and refuses a non-option",
		selectPaste.result &&
			selectPaste.calls.length === 1 &&
			JSON.stringify(selectPaste.calls[0]) === '{"desk_theme":"Dark"}' &&
			selectPaste.result.skipped === 1,
		JSON.stringify(selectPaste),
	);

	const rejected = await page.eval<PasteProbe>(
		PASTE(
			"REJECT_ME",
			`dt.navigation.focus(${editCols.data}, dt.datamanager.rowViewOrder[0]); window.__cfOld = dt.datamanager.getCell(${editCols.data}, dt.datamanager.rowViewOrder[0]).content; dt.navigation.lastPaste = undefined;`,
			`window.__cfDataValue = window.__cfOld;`,
		),
	);
	ok(
		"a value the server rejects is reverted in the cell",
		rejected.result && rejected.result.rejected === 1 && rejected.cells[0] === rejected.dataValue,
		JSON.stringify(rejected),
	);

	const whileEditing = await page.eval<PasteProbe>(
		PASTE(
			"X",
			`dt.navigation.focus(${editCols.data}, dt.datamanager.rowViewOrder[0]); dt.navigation.activateFocused(); dt.navigation.lastPaste = undefined;`,
			`dt.editing.deactivate(false);`,
		),
	);
	ok(
		"a paste while an editor is open belongs to the editor",
		!whileEditing.prevented && whileEditing.calls.length === 0 && whileEditing.result === null,
		JSON.stringify(whileEditing),
	);

	await page.eval(`(() => {
    frappe.db.set_value = window.__cfRealSetValue;
    const rv = cur_list;
    const added = window.__cfAddedFields || [];
    if (!added.length) return;
    rv.fields = rv.fields.filter((f) => !added.includes(f[0]));
    rv.build_fields();
    rv.setup_columns();
    if (rv.datatable) rv.datatable.destroy();
    rv.datatable = null;
    rv.refresh();
  })()`);
	await page.waitFor(
		`!!cur_list.datatable && document.querySelectorAll('tbody .dt-cell').length > 0 && !(window.__cfAddedFields || []).some((f) => cur_list.datatable.columns.some((c) => c.docfield && c.docfield.fieldname === f))`,
		{ timeout: 90000 },
	);
	await sleep(600);

	// --- frozen columns must be opaque -------------------------------------
	const frozen = await page.eval<FrozenProbe>(`(() => {
    const td = document.querySelector('tbody td.cf-table__cell--pinned');
    const th = document.querySelector('thead th.cf-table__cell--pinned');
    const bg = (n) => (n ? getComputedStyle(n).backgroundColor : null);
    return { body: bg(td), head: bg(th) };
  })()`);
	ok(
		"frozen columns are opaque so scrolled cells cannot show through",
		frozen.body &&
			!frozen.body.includes("rgba(0, 0, 0, 0)") &&
			frozen.head &&
			!frozen.head.includes("rgba(0, 0, 0, 0)"),
		JSON.stringify(frozen),
	);

	// --- an open editor owns its own clicks ---------------------------------
	// A Link editor renders awesomplete's option list inside the cell. Treating a
	// click on an option as a grid click stole focus to the scroll container —
	// closing the dropdown before it could commit — AND started a drag, so the
	// pointer travelling to the option swept a rectangle of cells behind it. The
	// user picked a value and got a multi-cell selection instead.
	const editorClick = await page.eval<EditorClickProbe>(`(() => {
    const dt = cur_list.datatable;
    const colIndex = dt.columns.findIndex((c, i) => {
      if (i < dt.standardColumnCount || c.editable === false || !c.docfield) return false;
      const cell = dt.datamanager.getCell(i, 0);
      return !!cell && cell.editable !== false;
    });
    dt.navigation.focus(colIndex, 0);
    dt.navigation.activateFocused();
    const td = document.querySelector('tbody .dt-cell[data-col-index="' + colIndex + '"][data-row-index="0"]');
    const mount = td.querySelector('.dt-cell__edit');
    const before = { ...dt.navigation.focused };

    // stand in for an awesomplete option rendered inside the editor
    const option = document.createElement('div');
    option.className = 'awesomplete';
    option.innerHTML = '<ul role="listbox"><li>an option</li></ul>';
    mount.appendChild(option);
    const li = option.querySelector('li');

    const active = document.activeElement;
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // and a pointer sweep, as happens while moving to the option
    const other = document.querySelector('tbody .dt-cell[data-col-index="' + (colIndex + 1) + '"][data-row-index="0"]');
    if (other) other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    const res = {
      dragging: !!dt.navigation.dragging,
      focusUnchanged: dt.navigation.focused && dt.navigation.focused.colIndex === before.colIndex
        && dt.navigation.focused.rowIndex === before.rowIndex,
      stillEditing: !!dt.editing.$editingCell,
      focusStolen: document.activeElement !== active && document.activeElement === dt.engine.renderer.scroll,
      highlighted: document.querySelectorAll('.dt-cell--highlight').length,
    };
    option.remove();
    dt.editing.deactivate(false);
    return res;
  })()`);
	ok("clicking inside an editor does not start a drag", !editorClick.dragging, JSON.stringify(editorClick));

	// A drag whose mouseup we never see (released outside the window, or over a
	// dialog that opened mid-drag) must not leave the grid selecting forever.
	const lostMouseUp = await page.eval<LostMouseUpProbe>(`(() => {
    const dt = cur_list.datatable;
    const cell = (c, r) => document.querySelector('tbody .dt-cell[data-col-index="' + c + '"][data-row-index="' + r + '"]');
    const start = cell(3, 0);
    start.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const startedDrag = !!dt.navigation.dragging;
    // no mouseup — then the pointer moves with no button held
    const other = cell(4, 0) || start;
    other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 0 }));
    const res = { startedDrag, stillDragging: !!dt.navigation.dragging,
                  selectingClass: document.querySelectorAll('.cf-table--selecting').length };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return res;
  })()`);
	ok(
		"a drag with no mouseup self-heals on the next button-less move",
		lostMouseUp.startedDrag && !lostMouseUp.stillDragging && lostMouseUp.selectingClass === 0,
		JSON.stringify(lostMouseUp),
	);
	ok(
		"clicking inside an editor does not move the grid focus",
		editorClick.focusUnchanged,
		JSON.stringify(editorClick),
	);
	ok("clicking inside an editor does not close it", editorClick.stillEditing, JSON.stringify(editorClick));
	ok(
		"clicking inside an editor does not steal DOM focus",
		!editorClick.focusStolen,
		JSON.stringify(editorClick),
	);
	ok(
		"no stray range is selected behind the dropdown",
		editorClick.highlighted === 0,
		JSON.stringify(editorClick),
	);

	// --- sticky stacking order ---------------------------------------------
	// Four levels are in play at once: ordinary body cells, the frozen body
	// column they scroll under, the sticky header, and the frozen header corner.
	// The engine used to write z-index INLINE for pinned cells, which always beat
	// the stylesheet — so the scrolling column headers painted OVER the frozen
	// header instead of sliding beneath it.
	const layering = await page.eval<LayeringProbe>(`(() => {
    const z = (s) => { const n = document.querySelector(s); return n ? getComputedStyle(n).zIndex : null; };
    const inlineZ = (s) => { const n = document.querySelector(s); return n ? (n.style.zIndex || '') : null; };
    return {
      bodyPlain: z('tbody td.cf-table__cell:not(.cf-table__cell--pinned)'),
      bodyPinned: z('tbody td.cf-table__cell--pinned'),
      headPlain: z('thead th.cf-table__cell:not(.cf-table__cell--pinned)'),
      headPinned: z('thead th.cf-table__cell--pinned'),
      inlineOnPinned: inlineZ('tbody td.cf-table__cell--pinned'),
    };
  })()`);
	const zi = (v: string | null) => (v === "auto" || v == null ? 0 : Number(v));
	ok(
		"frozen header sits above the scrolling headers",
		zi(layering.headPinned) > zi(layering.headPlain),
		JSON.stringify(layering),
	);
	ok(
		"sticky header sits above the body, frozen body above plain body",
		zi(layering.headPlain) > zi(layering.bodyPinned) && zi(layering.bodyPinned) > zi(layering.bodyPlain),
		JSON.stringify(layering),
	);
	ok(
		"layering is left to the stylesheet, not written inline",
		layering.inlineOnPinned === "",
		JSON.stringify(layering),
	);

	// --- nothing shows through the frozen columns ---------------------------
	// The real question is not "is the background set" but "is anything of the
	// scrolled column visible inside the frozen region". Hit-test across the
	// whole frozen band, including the seam between the two frozen columns and
	// both outer edges, and require the topmost element at every point to belong
	// to a pinned cell.
	const bleed = await page.eval<BleedProbe>(`(() => {
    const dt = cur_list.datatable;
    const scroll = dt.engine.renderer.scroll;
    // The check is only meaningful while columns are actually passing under the
    // frozen ones, so guarantee horizontal overflow first — this doctype's
    // columns may otherwise fit and the test would pass without testing.
    if (scroll.scrollWidth <= scroll.clientWidth) {
      const wide = dt.engine.table.getVisibleLeafColumns()[dt.standardColumnCount + 1];
      if (wide) dt.engine.setColumnSize(wide.id, 900);
      dt.engine.render();
    }
    scroll.scrollLeft = 260;
    const tr = document.querySelector('tbody tr.dt-row');
    const pinned = [...tr.children].filter((td) => td.classList.contains('cf-table__cell--pinned'));
    if (!pinned.length) return { skipped: true };
    const first = pinned[0].getBoundingClientRect();
    const last = pinned[pinned.length - 1].getBoundingClientRect();
    const y = Math.round(first.y + first.height / 2);
    const misses = [];
    // Start one pixel inside: a hit test exactly ON the shared edge resolves to
    // the ancestor rather than the cell, which is boundary behaviour, not bleed.
    for (let x = Math.ceil(first.x) + 1; x < Math.floor(last.right); x++) {
      const top = document.elementFromPoint(x, y);
      if (!top) continue;
      const cell = top.closest('.dt-cell');
      if (!cell || !cell.classList.contains('cf-table__cell--pinned')) {
        misses.push({ x, top: top.tagName + '.' + String(top.className).split(' ')[0],
                      cell: cell ? cell.dataset.colId : null });
      }
    }
    return { from: Math.ceil(first.x) + 1, to: Math.floor(last.right), misses: misses.slice(0, 6),
             missCount: misses.length, scrollLeft: scroll.scrollLeft,
             overflow: scroll.scrollWidth - scroll.clientWidth };
  })()`);
	ok(
		"the bleed check actually scrolled columns under the frozen ones",
		bleed.skipped || bleed.scrollLeft > 0,
		JSON.stringify(bleed),
	);
	ok(
		"no scrolled content shows through the frozen columns",
		bleed.skipped || bleed.missCount === 0,
		JSON.stringify(bleed),
	);

	// --- select-all lines up with the column it heads ----------------------
	const cbAlign = await page.eval<CbAlignProbe>(`(() => {
    const x = (s) => { const n = document.querySelector(s); return n ? Math.round(n.getBoundingClientRect().x) : null; };
    return {
      head: x('thead [data-col-id$=":_checkbox"] input'),
      body: x('tbody [data-col-id$=":_checkbox"] input'),
    };
  })()`);
	ok(
		"header checkbox aligns with the column's checkboxes",
		cbAlign.head !== null && cbAlign.head === cbAlign.body,
		JSON.stringify(cbAlign),
	);

	// --- drag to select a range --------------------------------------------
	const dragBox = await page.eval<DragBoxProbe>(`(() => {
    const dt = cur_list.datatable;
    dt.cellmanager.unfocusCell();
    const c = (col, row) => {
      const n = document.querySelector('tbody .dt-cell[data-col-index="' + col + '"][data-row-index="' + row + '"]');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    };
    const rows = dt.datamanager.rowViewOrder;
    return { from: c(3, rows[0]), to: c(4, rows[Math.min(1, rows.length - 1)]) };
  })()`);
	if (dragBox.from && dragBox.to) {
		await page.drag(dragBox.from.x, dragBox.from.y, dragBox.to.x, dragBox.to.y);
		const dragged = await page.eval<DraggedProbe>(`(() => {
      const dt = cur_list.datatable;
      return {
        bounds: dt.navigation.bounds(),
        highlighted: document.querySelectorAll('.dt-cell--highlight').length,
        stillDragging: !!dt.navigation.dragging,
        selectingClass: document.querySelectorAll('.cf-table--selecting').length,
      };
    })()`);
		ok(
			"dragging the mouse across cells selects a range",
			dragged.bounds && (dragged.bounds.c2 > dragged.bounds.c1 || dragged.bounds.p2 > dragged.bounds.p1),
			JSON.stringify(dragged),
		);
		ok(
			"the drag ends cleanly on mouseup",
			!dragged.stillDragging && dragged.selectingClass === 0,
			JSON.stringify(dragged),
		);
	} else {
		ok("dragging the mouse across cells selects a range", false, "cells not found");
	}

	await page.screenshot(SHOT + "/bench-report.png");
	const errs = page.consoleErrors();
	ok("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
	results.push("FAIL  harness: " + (e instanceof Error ? e.message : String(e)));
} finally {
	console.log("\n" + results.join("\n"));
	console.log(
		"\n" +
			results.filter((r) => r.startsWith("PASS")).length +
			" passed, " +
			results.filter((r) => r.startsWith("FAIL")).length +
			" failed",
	);
	page.close();
	proc.kill();
	process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
