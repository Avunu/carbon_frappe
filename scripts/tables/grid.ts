import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.ts";

// Every probe below is a source STRING evaluated inside Chromium, so nothing in
// this process types its body. What comes back is `returnByValue` JSON, which
// the driver cannot know the shape of — so each interface here names the object
// one probe assembles in the page, and that name is the whole contract for the
// assertions that read it.

/** `setup` — the CarbonGrid the ControlTable built, plus the seeded rows. */
interface SetupProbe {
	ctor: string;
	isCarbon: boolean;
	nRows: number;
	dataLen: number;
	added: number;
}

/** `dom` — one count per markup contract the Carbon grid must keep emitting. */
interface DomProbe {
	carbonTable: number;
	trGridRow: number;
	dataName: number;
	dataIdx: number;
	staticCol: number;
	fieldtypeAttr: number;
	staticArea: number;
	fieldArea: number;
	rowCheck: number;
	sortableHandle: number;
	rowsTbody: number;
	headingRow: number;
	gridEmpty: number;
	limitReached: number;
	colgroup: number;
}

/** `many` — the measurements taken past the ten-column threshold. */
interface ManyProbe {
	visible: number;
	headers: number;
	widths: number[];
	limitReached: number;
	scrollW: number;
	clientW: number;
	cellsInFirstRow: number;
}

/** One column's width as the model, the <colgroup> and the DOM each report it. */
interface ColumnWidth {
	id: string;
	/** `visible_columns[n][1]` — frappe's own width for the column */
	model: number;
	/** the <col> the engine wrote, in px; `null` when it left the width to the layout */
	col: number | null;
	/** the header cell's rendered width */
	th: number;
	/** the first body row's frappe cell, which has to fill its <td> */
	cell: number;
}

/** `widths` — every visible column, plus the one frappe computes it from. */
interface WidthsProbe {
	rows: ColumnWidth[];
	/** columns whose three widths disagree */
	mismatched: ColumnWidth[];
	/** `grid.get_column_width(df) === visible_columns[n][1]` for every column */
	modelIsFrappes: boolean;
	/** how many `.column-limit-reached` elements the grid wrapper holds */
	limitReached: number;
}

/** `dfWidth` — `df.width`, set by hand, before and after the grid is rebuilt. */
interface DfWidthProbe {
	/** `df.width = 222` */
	exact: number;
	/** `df.width = "700px"` — a docfield width is a CSS length — clamped to 600 */
	clampedHigh: number;
	/** `df.width = 20`, clamped to 60 */
	clampedLow: number;
	/** the same column's content box in the first body row, for the exact case */
	cell: number;
}

/** Where a header's resize handle is, and how wide its column is before the drag. */
interface HandleStart {
	x: number;
	y: number;
	before: number;
}

/** `resize` — one real drag on a header handle, and what frappe was told. */
interface ResizeProbe {
	before: number;
	after: number;
	/** frappe's own cells inside the resized column, header and first body row */
	headCell: number;
	bodyCell: number;
	/** every `frappe.model.user_settings.update` call, in order */
	saved: Array<{ doctype: string; widths: Record<string, number | undefined> }>;
	dfWidth: number | string | null;
	modelWidth: number | null;
	/** the engine's handle count on this header row, and frappe's own (hidden) ones */
	handles: number;
	frappeHandlesShown: number;
	/** gutters get no handle: they have nowhere to save a width */
	gutterHandles: number;
}

/** `roundTrip` — user settings read back into a rebuilt grid. */
interface RoundTripProbe {
	/** the saved GridView width of the column that was dragged, and its th after a rebuild */
	saved: number | null;
	rebuilt: number;
	/** legacy `columns` spans (3, 4) and a px `width` (90), as three header widths */
	legacy: number[];
	legacyColumns: string[];
}

/** `configure` — the Configure Columns dialog: its inputs, a clamp, and Update. */
interface ConfigureProbe {
	inputs: number[];
	/** what 700 and 30 typed into the first two inputs became */
	clamped: number[];
	saved: Array<number | undefined>;
	rebuilt: number[];
}

/** `labels` — frappe's own label mechanism, driven against the moved buttons. */
interface LabelProbe {
	one: { del: string; dup: string };
	two: { del: string; dup: string };
	/** after `set_button_label` on the icon-only Download button */
	download: {
		label: string;
		glyph: boolean;
		spinner: boolean;
		hiddenLabel: boolean;
		title: string | null;
	};
}

/** `pager` — more rows than one page, and the controls that page through them. */
interface PagerProbe {
	rows: number;
	pages: string;
	buttons: { first: boolean; prev: boolean; next: boolean; last: boolean };
	espresso: boolean;
	visible: boolean;
	inFooter: boolean;
	page1: number;
	page1First: string | null;
}

/** `paged` — page two, and select-all across a page change. */
interface PagedProbe {
	rows: number;
	firstIdx: string | null;
	sparse: boolean;
	selectAllOnTwo: boolean;
	checkedOnTwo: number;
	selected: number;
	selectAllBackOnOne: boolean;
	selectAllBackOnTwo: boolean;
}

/** `fill` — a short grid: every column but the last exact, the last takes the spare. */
interface FillProbe {
	container: number;
	table: number;
	sum: number;
	others: Array<{ id: string; model: number; th: number }>;
	last: { id: string; model: number; th: number };
	overflows: boolean;
}

/** `api` — the inherited Grid/GridRow surface, one flag per call. */
interface ApiProbe {
	get_field: boolean;
	update_docfield_property: boolean;
	byDocname: number;
	rowDoc: boolean;
	rowWrapperIsTr: boolean;
	rowIsWrapper: boolean;
	columnsList: boolean;
	getVisibleColumns: boolean;
	editableClass: boolean;
	controlsMounted: boolean;
	toggle_enable: boolean;
	selected: boolean;
	dataApi: boolean;
}

/** `added` — row count and <tr> count after `add_new_row()`. */
interface AddedProbe {
	data: number;
	trs: number;
}

/** `renamed` — the added row after it is renamed in place, as a save renames it. */
interface RenamedProbe {
	sameTr: boolean;
	name: string;
	rowId: string | undefined;
	cells: number;
	columns: number;
	widest: number;
}

/** One click point across a cell: where it landed, and what it did. */
interface ClickHit {
	label: string;
	insideCol: boolean;
	editable: boolean;
	/** what actually sat at the probe point, so a failure says WHY */
	hit: string | null;
}

/** `clickEdit` — the three probe points plus the <td>'s own padding. */
interface ClickEditProbe {
	hits: ClickHit[];
	tdPadding: string;
}

/** One column's header and body geometry, each as `[x, width]`. */
interface AlignedColumn {
	id: string;
	th: [number, number];
	td: [number, number];
}

/** `align` — every column measured, and the subset that did not line up. */
interface AlignProbe {
	rows: AlignedColumn[];
	mismatched: AlignedColumn[];
}

/** `form` — the expanded detail panel, from markup through to bookkeeping. */
interface FormProbe {
	addendumInTable: boolean;
	adjacent: boolean;
	childRowMarked: boolean;
	childNotGridRow: boolean;
	childRowsForEveryRow: boolean;
	/**
	 * The raw `colspan` attribute rather than a parsed number, so a wrong value
	 * is reported exactly as it was written. The assertion coerces it the way
	 * the relational operator used to.
	 */
	colspan: string | null;
	formInsideAddendum: boolean;
	formVisible: boolean;
	formInline: boolean;
	panelStuck: boolean;
	frozen: number;
	freezeBalanced: boolean;
	fieldsRendered: number;
	parentRowClass: boolean;
	expandedClass: boolean;
	previousValue: string | null;
	ariaExpanded: string | null;
	ariaControls: boolean;
	panelHolds: boolean;
	openGridRow: boolean;
	dataRowVisible: boolean;
	markedOpen: boolean;
	findable: boolean;
	curGrid: boolean;
}

/** `accordion` — opening a second row has to close the first. */
interface AccordionProbe {
	firstClosed: boolean;
	secondOpen: boolean;
	onlyOne: boolean;
	curGrid: boolean;
}

/** `closed` — what is left behind once the panel collapses. */
interface ClosedProbe {
	collapsed: boolean;
	expandedClassGone: boolean;
	previousValueGone: boolean;
	rowBack: boolean;
	frozen: number;
	freezeBalanced: boolean;
	/**
	 * `cur_frm.cur_grid` read raw rather than compared — it is only ever
	 * reported, so whatever the slot holds stays unnarrowed here.
	 */
	curGrid: unknown;
}

/** `modal` — the "Open in dialog" hatch, before and after switching rows. */
interface ModalProbe {
	modalClass: boolean;
	fixed: boolean;
	/** the form, not its backdrop, is what sits at the form's own centre */
	onTop: boolean;
	frozen: number;
	afterFrozen: number;
	afterCount: number;
	modalClassGone: boolean;
	secondInline: boolean;
}

/** `chevron` — the expand button itself, not just the API behind it. */
interface ChevronProbe {
	opened: boolean;
	aria: string | null;
}

/** `headerPaint` — the distinct fills across the header row and its interiors. */
interface HeaderPaintProbe {
	fills: string[];
	inners: string[];
}

/** `rowPaint` — the same measurement across an expanded row's cells. */
interface RowPaintProbe {
	hoverCls: boolean;
	tds: string[];
	inners: string[];
}

/** A viewport point handed back for the real pointer to visit. */
interface PointProbe {
	x: number;
	y: number;
}

/** `toolbar` — every footer control the Carbon toolbar re-homed. */
interface ToolbarProbe {
	hasToolbar: boolean;
	batchBeforeContent: boolean;
	addRowInToolbar: boolean;
	addRowIsSameNode: boolean;
	deleteInBatch: boolean;
	gearInToolbar: boolean;
	searchToggle: boolean;
	paginationInFooter: boolean;
	footerHidden: boolean;
}

/** `batch` — the batch bar a selection raises, and its teardown. */
interface BatchProbe {
	active: boolean;
	label: string;
	selected: number;
	clearedActive: boolean;
	clearedHidden: string | null;
	addRowBack: boolean;
}

/** `search` — the filter row the magnifier reveals. */
interface SearchProbe {
	rows: number;
	before: number;
	after: number;
	inputs: number;
}

/** `seeded` — the two Contacts the document-switch case navigates between. */
interface SwitchSeedProbe {
	a: string;
	b: string;
}

/** `switched` — the form after A → list → B, where A's child table was empty. */
interface SwitchProbe {
	docname: string;
	firstName: string;
	title: string;
	/** `visible_columns` of the grid that was empty on A, after the switch */
	visibleColumns: number;
	/** engine rows rendered for B's one email row */
	rows: number;
	errorsBefore: number;
	errorsAfter: number;
	errors: string[];
}
const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
const ok = (n: string, c: unknown, x = "") =>
	results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
try {
	await login(page, BASE);
	await page.goto(`${BASE}/app/sales-order/new`);
	await page.waitFor(`!!window.cur_frm && !!cur_frm.fields_dict && !!cur_frm.fields_dict.items`, {
		timeout: 90000,
	});
	// Guard: a stolen assets.json key means we would be measuring stock frappe.
	await assertCarbonStylesheet(page);
	await new Promise((r) => setTimeout(r, 2500));

	const setup = await page.eval<SetupProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    window.__before = grid.data.length;
    for (let i = 0; i < 3; i++) cur_frm.add_child('items', { qty: i + 1, rate: (i+1)*100 });
    cur_frm.refresh_field('items');
    return new Promise(res => setTimeout(() => res({
      ctor: grid.constructor.name,
      isCarbon: !!grid.carbon_table,
      nRows: grid.grid_rows.filter(Boolean).length,
      dataLen: grid.data.length,
      added: grid.data.length - window.__before,
    }), 1200));
  })()`);
	ok("ControlTable builds a CarbonGrid", setup.isCarbon, setup.ctor);
	ok("three child rows created", setup.added === 3 && setup.nRows === setup.dataLen, JSON.stringify(setup));

	const dom = await page.eval<DomProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const w = grid.wrapper;
    return {
      carbonTable: w.find('table.cds--data-table').length,
      trGridRow: w.find('tbody tr.grid-row').length,
      dataName: w.find('tbody tr.grid-row[data-name]').length,
      dataIdx: w.find('tbody tr.grid-row[data-idx]').length,
      staticCol: w.find('.grid-static-col[data-fieldname]').length,
      fieldtypeAttr: w.find('.grid-static-col[data-fieldtype]').length,
      staticArea: w.find('.static-area').length,
      fieldArea: w.find('.field-area').length,
      rowCheck: w.find('.grid-row-check').length,
      sortableHandle: w.find('.sortable-handle').length,
      rowsTbody: w.find('tbody.rows').length,
      headingRow: w.find('.grid-heading-row').length,
      gridEmpty: w.find('.grid-empty').length,
      limitReached: w.find('.column-limit-reached').length,
      colgroup: w.find('colgroup col').length,
    };
  })()`);
	console.log(JSON.stringify(dom, null, 2));
	ok("renders a Carbon table", dom.carbonTable === 1);
	ok(
		"<tr class=grid-row data-name data-idx>",
		dom.trGridRow === setup.dataLen && dom.dataName === dom.trGridRow && dom.dataIdx === dom.trGridRow,
		JSON.stringify({ r: dom.trGridRow, n: dom.dataName, i: dom.dataIdx, expect: setup.dataLen }),
	);
	ok(
		".grid-static-col keeps data-fieldname/-fieldtype",
		dom.staticCol > 0 && dom.fieldtypeAttr > 0,
		`${dom.staticCol}/${dom.fieldtypeAttr}`,
	);
	ok(
		".static-area / .field-area preserved",
		dom.staticArea > 0 && dom.fieldArea > 0,
		`${dom.staticArea}/${dom.fieldArea}`,
	);
	ok("row checkboxes + sortable handles", dom.rowCheck > 0 && dom.sortableHandle > 0);
	ok("tbody carries .rows (Sortable target)", dom.rowsTbody === 1);
	ok(".grid-heading-row and .grid-empty present", dom.headingRow === 1 && dom.gridEmpty === 1);
	ok("no .column-limit-reached", dom.limitReached === 0);

	// >10 columns — the headline capability
	const many = await page.eval<ManyProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    let n = 0;
    for (const df of grid.docfields) {
      if (n >= 16) break;
      if (frappe.model.layout_fields.includes(df.fieldtype) || df.hidden) continue;
      df.in_list_view = 1; n++;
    }
    grid.reset_grid();
    return new Promise(res => setTimeout(() => {
      const w = grid.wrapper;
      const scroll = w.find('.grid-body')[0];
      res({
        visible: grid.visible_columns.length,
        headers: w.find('thead th').length,
        widths: grid.visible_columns.map(c => c[1]).slice(0, 6),
        limitReached: w.find('.column-limit-reached').length,
        scrollW: scroll ? scroll.scrollWidth : 0,
        clientW: scroll ? scroll.clientWidth : 0,
        cellsInFirstRow: w.find('tbody tr.grid-row').first().find('td').length,
      });
    }, 1500));
  })()`);
	console.log(JSON.stringify(many, null, 2));
	ok(
		"more than 10 grid columns render",
		many.visible > 10,
		`visible=${many.visible} headers=${many.headers}`,
	);
	ok(
		"widths are px, not bootstrap spans",
		many.widths.every((w) => w >= 60),
		JSON.stringify(many.widths),
	);
	ok("still no .column-limit-reached past 10 columns", many.limitReached === 0);
	ok(
		"horizontal scroll instead of the overflow hack",
		many.scrollW > many.clientW,
		`${many.scrollW}>${many.clientW}`,
	);
	ok(
		"every column rendered as a cell",
		many.cellsInFirstRow === many.headers,
		`${many.cellsInFirstRow} vs ${many.headers}`,
	);

	// --- column widths: frappe's pixel model, rendered by the engine -----------
	// frappe 16.50 sizes columns in px itself (`get_column_width`: a saved or
	// docfield `width`, else a legacy `columns` span, else a fieldtype default,
	// clamped to 60-600). The grid renders those numbers; it must not compute
	// its own, and a column the engine resizes has to take its cell with it.
	const widths = await page.eval<WidthsProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const w = grid.wrapper;
    const cols = [...w.find('colgroup col')];
    const ids = [...w.find('thead tr.grid-row th')].map((th) => th.dataset.colId);
    const row = w.find('tbody tr.grid-row')[0];
    const rows = grid.visible_columns.map(([df, model]) => {
      const col = cols[ids.indexOf(df.fieldname)];
      const th = w.find('thead th[data-col-id="' + df.fieldname + '"]')[0];
      const cell = row.querySelector('td[data-col-id="' + df.fieldname + '"] .grid-static-col');
      return {
        id: df.fieldname,
        model,
        col: col && col.style.width ? parseFloat(col.style.width) : null,
        th: Math.round(th.getBoundingClientRect().width),
        cell: Math.round(cell.getBoundingClientRect().width),
      };
    });
    return {
      rows,
      mismatched: rows.filter((r) => r.th !== r.model || r.cell !== r.model || (r.col !== null && r.col !== r.model)),
      modelIsFrappes: grid.visible_columns.every(([df, m]) => grid.get_column_width(df) === m),
      limitReached: w.find('.column-limit-reached').length,
    };
  })()`);
	ok(
		"every column is exactly the width frappe's get_column_width gives it (model, <col>, <th>, cell)",
		widths.rows.length > 10 && widths.modelIsFrappes && widths.mismatched.length === 0,
		JSON.stringify(widths.mismatched.slice(0, 3)),
	);

	// `df.width` is the docfield's own pixel width ("150px" on Sales Order Item's
	// item_code); the per-user setting writes a number into the same slot.
	const dfWidth = await page.eval<DfWidthProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    const df = grid.fields_map.qty;
    const had = Object.prototype.hasOwnProperty.call(df, 'width');
    const old = df.width;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const th = () => Math.round(grid.wrapper.find('thead th[data-col-id="qty"]')[0].getBoundingClientRect().width);
    const measure = async (value) => { df.width = value; grid.reset_grid(); await sleep(900); return th(); };
    const exact = await measure(222);
    const cell = Math.round(grid.wrapper.find('tbody tr.grid-row')[0]
      .querySelector('td[data-col-id="qty"] .grid-static-col').getBoundingClientRect().width);
    const clampedHigh = await measure('700px');
    const clampedLow = await measure(20);
    if (had) df.width = old; else delete df.width;
    grid.reset_grid();
    await sleep(900);
    return { exact, clampedHigh, clampedLow, cell };
  })()`);
	ok(
		"df.width drives the column: honoured exactly, and held to 60-600",
		dfWidth.exact === 222 && dfWidth.cell === 222 && dfWidth.clampedHigh === 600 && dfWidth.clampedLow === 60,
		JSON.stringify(dfWidth),
	);

	// A header drag: the ENGINE's handle (frappe's own is hidden and unwired),
	// reported through onColumnResize and handed to frappe's save_column_width.
	// `user_settings.update` is the network leaf, so it is stubbed — the test
	// reads what frappe would have stored without writing the user's settings.
	const start = await page.eval<HandleStart>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    window.__saved = [];
    window.__origUpdate = frappe.model.user_settings.update;
    window.__origSettings = frappe.model.user_settings['Sales Order'];
    window.__origWidths = Object.fromEntries(grid.docfields.map((d) => [d.fieldname, d.width]));
    frappe.model.user_settings.update = (doctype, settings) => {
      window.__saved.push({ doctype, settings: JSON.parse(JSON.stringify(settings)) });
      frappe.model.user_settings[doctype] = settings;
      return Promise.resolve({ message: settings });
    };
    const th = grid.wrapper.find('thead th[data-col-id="qty"]')[0];
    th.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    const r = th.querySelector('.cf-table__resize-handle').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), before: Math.round(th.getBoundingClientRect().width) };
  })()`);
	await page.drag(start.x, start.y, start.x + 50, start.y, 8);
	await new Promise((r) => setTimeout(r, 600));
	const resize = await page.eval<ResizeProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const w = grid.wrapper;
    const th = w.find('thead th[data-col-id="qty"]')[0];
    const saved = window.__saved.map((s) => ({
      doctype: s.doctype,
      widths: Object.fromEntries((s.settings.GridView['Sales Order Item'] || []).map((c) => [c.fieldname, c.width])),
    }));
    const vc = grid.visible_columns.find(([df]) => df.fieldname === 'qty');
    return {
      before: ${start.before},
      after: Math.round(th.getBoundingClientRect().width),
      // frappe sized these inline at the width the column had when the row was
      // built; they have to follow the <colgroup>, not stay behind at that width
      headCell: Math.round(th.querySelector('.grid-static-col').getBoundingClientRect().width),
      bodyCell: Math.round(w.find('tbody tr.grid-row')[0]
        .querySelector('td[data-col-id="qty"] .grid-static-col').getBoundingClientRect().width),
      saved,
      dfWidth: grid.fields_map.qty.width === undefined ? null : grid.fields_map.qty.width,
      modelWidth: vc ? vc[1] : null,
      handles: w.find('thead tr.grid-row .cf-table__resize-handle').length,
      frappeHandlesShown: [...w.find('.grid-col-resize-handle')].filter((h) => getComputedStyle(h).display !== 'none').length,
      gutterHandles: ['_expand', '_check', '_index', '_menu']
        .reduce((n, id) => n + w.find('thead th[data-col-id="' + id + '"] .cf-table__resize-handle').length, 0),
    };
  })()`);
	ok(
		"dragging a header handle resizes the column to follow the pointer",
		resize.after === resize.before + 50,
		`${resize.before} -> ${resize.after}`,
	);
	ok(
		"a resized column's cells widen with it (frappe's inline cell width does not hold them back)",
		resize.headCell === resize.after && resize.bodyCell === resize.after,
		JSON.stringify({ th: resize.after, head: resize.headCell, body: resize.bodyCell }),
	);
	ok(
		"the drag is persisted once, through frappe's save_column_width, as a GridView width",
		resize.saved.length === 1 &&
			resize.saved[0]?.doctype === "Sales Order" &&
			resize.saved[0].widths["qty"] === resize.after &&
			resize.dfWidth === resize.after &&
			resize.modelWidth === resize.after,
		JSON.stringify(resize),
	);
	ok(
		"every column is saved with a width, and only data columns get a handle",
		Object.values(resize.saved[0]?.widths ?? {}).every((v) => typeof v === "number" && v >= 60 && v <= 600) &&
			resize.handles === widths.rows.length &&
			resize.gutterHandles === 0,
		JSON.stringify({ h: resize.handles, cols: widths.rows.length, g: resize.gutterHandles }),
	);
	ok(
		"frappe's own resize handle is hidden",
		resize.frappeHandlesShown === 0,
		String(resize.frappeHandlesShown),
	);

	// The stored layout, read back: the dragged width, then settings an older
	// frappe wrote (`columns` spans) next to a px `width` and a sticky column.
	const roundTrip = await page.eval<RoundTripProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const th = (id) => Math.round(grid.wrapper.find('thead th[data-col-id="' + id + '"]')[0].getBoundingClientRect().width);
    const last = window.__saved[window.__saved.length - 1].settings;
    const mine = last.GridView['Sales Order Item'].find((c) => c.fieldname === 'qty');
    grid.reset_grid();
    await sleep(900);
    const rebuilt = th('qty');
    frappe.model.user_settings['Sales Order'] = { GridView: { 'Sales Order Item': [
      { fieldname: 'item_code', columns: 3, sticky: 1 },
      { fieldname: 'qty', columns: 4 },
      { fieldname: 'rate', width: 90 },
    ] } };
    grid.reset_grid();
    await sleep(900);
    const headers = [...grid.wrapper.find('thead tr.grid-row th')].filter((n) => !n.dataset.colId.startsWith('_'));
    return {
      saved: mine ? mine.width : null,
      rebuilt,
      legacy: headers.map((n) => Math.round(n.getBoundingClientRect().width)),
      legacyColumns: headers.map((n) => n.dataset.colId),
    };
  })()`);
	ok(
		"a saved width comes back after a rebuild",
		roundTrip.saved === resize.after && roundTrip.rebuilt === resize.after,
		JSON.stringify(roundTrip),
	);
	ok(
		"legacy `columns` spans still resolve (3 -> 140, 4 -> 200) beside a px width",
		roundTrip.legacyColumns.join() === "item_code,qty,rate" &&
			roundTrip.legacy[0] === 140 &&
			roundTrip.legacy[1] === 200 &&
			(roundTrip.legacy[2] ?? 0) >= 90,
		JSON.stringify(roundTrip),
	);

	// `df.sticky` still draws the column where it belongs: frappe writes
	// `position: sticky; left: Npx` on the cell, and the engine pins the <td>, so
	// the nested cell has to stay out of the way.
	const sticky = await page.eval<{
		position: string;
		offset: number;
		header: [number, number];
		body: [number, number];
	}>(
		`(() => {
    const w = cur_frm.fields_dict.items.grid.wrapper;
    const cell = w.find('tbody tr.grid-row')[0].querySelector('td[data-col-id="item_code"] .grid-static-col');
    const td = cell.closest('td');
    const head = w.find('thead th[data-col-id="item_code"] .grid-static-col')[0];
    const box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)]; };
    return {
      position: getComputedStyle(cell).position,
      offset: Math.round(cell.getBoundingClientRect().x - td.getBoundingClientRect().x),
      header: box(head),
      body: box(cell),
    };
  })()`,
	);
	ok(
		"a sticky column stays in its cell (no inline left offset applied)",
		sticky.position === "static" &&
			sticky.offset === 0 &&
			sticky.header[0] === sticky.body[0] &&
			sticky.header[1] === sticky.body[1],
		JSON.stringify(sticky),
	);

	// Configure Columns writes `width`, 60-600 (frappe clamps what is typed), and
	// Update rebuilds the grid from it.
	const configure = await page.eval<ConfigureProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hr = grid.header_row;
    hr.configure_dialog_for_columns_selector();
    await sleep(600);
    const dialog = hr.grid_settings_dialog;
    const $in = $(dialog.$wrapper).find('.column-width');
    const inputs = [...$in].map((i) => parseInt(i.value));
    const type = (i, v) => { $in[i].value = v; $($in[i]).trigger('change'); };
    type(0, 700);
    type(1, 30);
    const clamped = [parseInt($in[0].value), parseInt($in[1].value)];
    dialog.get_primary_btn().click();
    await sleep(1500);
    const th = (id) => Math.round(grid.wrapper.find('thead th[data-col-id="' + id + '"]')[0].getBoundingClientRect().width);
    const last = window.__saved[window.__saved.length - 1].settings;
    return {
      inputs,
      clamped,
      saved: last.GridView['Sales Order Item'].map((c) => c.width),
      rebuilt: [th('item_code'), th('qty')],
    };
  })()`);
	ok(
		"Configure Columns shows the current px widths",
		configure.inputs.join() === "140,200,90",
		JSON.stringify(configure.inputs),
	);
	ok(
		"Configure Columns: widths are held to 60-600, saved, and applied by Update",
		configure.clamped.join() === "600,60" &&
			configure.saved.join() === "600,60,90" &&
			configure.rebuilt.join() === "600,60",
		JSON.stringify(configure),
	);

	// Put the stub and the settings back, then rebuild the 16-column grid the
	// rest of the suite measures.
	await page.eval(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    frappe.model.user_settings.update = window.__origUpdate;
    if (window.__origSettings === undefined) delete frappe.model.user_settings['Sales Order'];
    else frappe.model.user_settings['Sales Order'] = window.__origSettings;
    for (const df of grid.docfields) {
      if (window.__origWidths[df.fieldname] === undefined) delete df.width;
      else df.width = window.__origWidths[df.fieldname];
      delete df.sticky;
    }
    grid.reset_grid();
    await new Promise((r) => setTimeout(r, 900));
    return true;
  })()`);

	// inherited Grid API surface
	const api = await page.eval<ApiProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const out = {};
    out.get_field = typeof grid.get_field('qty') === 'object';
    grid.update_docfield_property('qty', 'reqd', 1);
    out.update_docfield_property = grid.fields_map.qty.reqd === 1;
    out.byDocname = Object.keys(grid.grid_rows_by_docname).length;
    const row0 = grid.grid_rows[0];
    out.rowDoc = !!row0.doc;
    out.rowWrapperIsTr = row0.wrapper.get(0).tagName === 'TR';
    out.rowIsWrapper = row0.row.get(0) === row0.wrapper.get(0);
    out.columnsList = row0.columns_list.length > 0;
    out.getVisibleColumns = row0.get_visible_columns().length > 0;
    row0.toggle_editable_row(true);
    out.editableClass = row0.row.hasClass('editable-row');
    out.controlsMounted = Object.keys(row0.on_grid_fields_dict).length > 0;
    row0.toggle_editable_row(false);
    grid.toggle_enable('qty', false);
    out.toggle_enable = grid.fields_map.qty.read_only === 1;
    grid.toggle_enable('qty', true);
    out.selected = Array.isArray(grid.get_selected_children());
    out.dataApi = Array.isArray(grid.get_data());
    return out;
  })()`);
	console.log(JSON.stringify(api, null, 2));
	ok(
		"grid.get_field / update_docfield_property / toggle_enable",
		api.get_field && api.update_docfield_property && api.toggle_enable,
	);
	ok("grid_rows_by_docname populated", api.byDocname === setup.dataLen, String(api.byDocname));
	ok("GridRow wrapper is the <tr>, row === wrapper", api.rowWrapperIsTr && api.rowIsWrapper);
	ok("columns_list / get_visible_columns intact", api.columnsList && api.getVisibleColumns);
	ok("in-place editing mounts real frappe controls", api.editableClass && api.controlsMounted);

	// add_new_row through the inherited path
	const added = await page.eval<AddedProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    grid.add_new_row();
    return new Promise(res => setTimeout(() => res({
      data: grid.data.length,
      trs: grid.wrapper.find('tbody tr.grid-row').length,
    }), 900));
  })()`);
	ok(
		"grid.add_new_row() renders a new <tr>",
		added.data === setup.dataLen + 1 && added.trs === added.data,
		JSON.stringify(added),
	);

	// Saving renames every new row from `new-<doctype>-<hash>` to its real name
	// on the SAME doc object (frappe.model.sync), and 16.50's identity matching
	// keeps the same GridRow, so the engine sees a familiar <tr> under an
	// unfamiliar id. It once built a second set of cells onto it, leaving the
	// emptied first set in front: the row doubled in width and split the table.
	const renamed = await page.eval<RenamedProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const d = grid.data[grid.data.length - 1];
    const tr = grid.grid_rows_by_docname[d.name].wrapper.get(0);
    delete locals[d.doctype][d.name];
    d.name = 'cf-renamed-' + Math.random().toString(36).slice(2, 8);
    locals[d.doctype][d.name] = d;
    grid.refresh();
    return new Promise(res => setTimeout(() => {
      const now = grid.grid_rows_by_docname[d.name].wrapper.get(0);
      res({
        sameTr: now === tr,
        name: d.name,
        rowId: now.dataset.rowId,
        cells: now.children.length,
        columns: grid.carbon_table.table.getVisibleLeafColumns().length,
        widest: Math.max(...[...grid.wrapper.find('tbody tr.grid-row')].map((r) => r.children.length)),
      });
    }, 900));
  })()`);
	ok(
		"a row renamed in place (as on save) keeps one cell per column",
		renamed.sameTr &&
			renamed.rowId === renamed.name &&
			renamed.cells === renamed.columns &&
			renamed.widest === renamed.columns,
		JSON.stringify(renamed),
	);

	// --- click-to-edit anywhere in a cell -----------------------------------
	// The clickable element is the `.grid-static-col` frappe built, nested inside
	// the engine's <td>. Any padding left on the <td> is dead space where a click
	// silently does nothing, which is what "only certain row clicks work" meant.
	const clickEdit = await page.eval<ClickEditProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    row.toggle_editable_row(false);
    // ERPNext floats an onboarding panel over the form; elementFromPoint would
    // return that instead of the cell and the probe would report the cell as
    // unclickable when it is merely covered.
    document.querySelectorAll('.onboarding-widget-box, .ONBOARDING, [data-widget-name]')
      .forEach((n) => { if (n.closest('.widget-group, .onboarding-widget-box')) n.style.display = 'none'; });
    // A real DATA column: the _check / _index / _open gutters keep a tighter
    // inset, and the row-index cell opens the detail form rather than entering
    // edit mode.
    const td = [...row.wrapper[0].querySelectorAll('td[data-col-id]')]
      .find((c) => c.querySelector('.grid-static-col[data-fieldname]'));
    td.scrollIntoView({ block: 'center' });
    const r = td.getBoundingClientRect();
    const hits = [];
    // near the leading edge (was <td> padding), the centre, and near the trailing edge
    for (const [label, x] of [['leading', r.left + 3], ['centre', r.left + r.width / 2], ['trailing', r.right - 4]]) {
      row.toggle_editable_row(false);
      const el = document.elementFromPoint(Math.round(x), Math.round(r.top + r.height / 2));
      const insideCol = !!(el && el.closest('.grid-static-col'));
      el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      hits.push({
        label,
        insideCol,
        editable: row.row.hasClass('editable-row'),
        // what actually sat at the probe point, so a failure says WHY
        hit: el ? (el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.')) : null,
      });
    }
    row.toggle_editable_row(false);
    return { hits, tdPadding: getComputedStyle(td).padding };
  })()`);
	console.log(JSON.stringify(clickEdit));
	ok(
		"<td> has no dead padding around the clickable cell",
		clickEdit.tdPadding === "0px",
		clickEdit.tdPadding,
	);
	ok(
		"a click anywhere in a cell enters edit mode",
		clickEdit.hits.every((h) => h.insideCol && h.editable),
		JSON.stringify(clickEdit.hits),
	);

	// --- header/body column alignment ---------------------------------------
	const align = await page.eval<AlignProbe>(`(() => {
    const w = cur_frm.fields_dict.items.grid.wrapper;
    const ids = [...w.find('thead th')].map((th) => th.dataset.colId).filter(Boolean);
    const box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)]; };
    const rows = ids.map((id) => {
      const th = w.find('thead th[data-col-id="' + id + '"] .grid-static-col')[0];
      const td = w.find('tbody td[data-col-id="' + id + '"] .grid-static-col')[0];
      if (!th || !td) return null;
      return { id, th: box(th), td: box(td) };
    }).filter(Boolean);
    return { rows, mismatched: rows.filter((r) => r.th[0] !== r.td[0] || r.th[1] !== r.td[1]) };
  })()`);
	ok(
		"every header cell aligns with its body cell",
		align.mismatched.length === 0,
		JSON.stringify(align.mismatched),
	);

	// --- the detail panel (Carbon expandable row) ---------------------------
	// frappe's row form is a centered pseudo-modal: GridRowForm appends
	// `.form-in-grid` to row.wrapper, show_form() hides that row, and
	// `.grid-row-open .form-in-grid` (common/grid.scss:533) makes it
	// position:fixed over a frappe.dom.freeze() backdrop. Carbon's equivalent is
	// an expandable row — the summary stays put and a child row unfolds under it.
	//
	// Every assertion below is one of the ways that swap can silently go wrong:
	// an adjacent-sibling break (Carbon's whole expandable stylesheet is written
	// as `tr.cds--parent-row… + tr[data-child-row]`), a `.grid-row` on the child
	// row (Sortable would make it draggable and renumber_based_on_dom() would
	// count it), or an unbalanced freeze count (show_form freezes, hide_form
	// unfreezes; inline mode has to counterweight both, not skip them).
	const form = await page.eval<FormProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    window.__formRow = row;
    window.__freezeBefore = frappe.dom.freeze_count;
    row.toggle_view(true);
    return new Promise((res) => setTimeout(() => {
      const host = row.form_row;
      const parent = row.wrapper[0];
      const formEl = row.grid_form && row.grid_form.wrapper[0];
      const expandCell = parent.querySelector('td.cds--table-expand');
      const button = row.expand_button;
      const tbody = grid.wrapper.find('tbody.rows')[0];
      res({
        addendumInTable: !!(host && host.parentElement && host.parentElement.tagName === 'TBODY'),
        adjacent: parent.nextElementSibling === host,
        childRowMarked: !!(host && host.hasAttribute('data-child-row')),
        childNotGridRow: !!(host && !host.classList.contains('grid-row')),
        childRowsForEveryRow:
          tbody.querySelectorAll('tr[data-child-row]').length ===
          grid.grid_rows.filter(Boolean).length,
        colspan: host && host.firstElementChild.getAttribute('colspan'),
        formInsideAddendum: !!(formEl && host && host.contains(formEl)),
        formVisible: !!(formEl && formEl.getBoundingClientRect().height > 200),
        formInline: !!(formEl && getComputedStyle(formEl).position === 'static'),
        panelStuck: !!(row.form_inner && getComputedStyle(row.form_inner).position === 'sticky'),
        frozen: document.querySelectorAll('#freeze').length,
        freezeBalanced: frappe.dom.freeze_count === window.__freezeBefore,
        fieldsRendered: row.grid_form && Object.keys(row.grid_form.fields_dict || {}).length,
        parentRowClass: parent.classList.contains('cds--parent-row'),
        expandedClass: parent.classList.contains('cds--expandable-row'),
        previousValue: expandCell && expandCell.getAttribute('data-previous-value'),
        ariaExpanded: button && button.getAttribute('aria-expanded'),
        ariaControls: button && button.getAttribute('aria-controls') === host.id,
        // Not just the computed value: a sticky box that fills its containing
        // block cannot move, which is exactly how this was wrong the first time.
        panelHolds: (() => {
          const scroll = grid.carbon_table.renderer.scroll;
          if (scroll.scrollWidth - scroll.clientWidth < 200) return true;
          const before = row.form_inner.getBoundingClientRect().left;
          scroll.scrollLeft = 200;
          const after = row.form_inner.getBoundingClientRect().left;
          scroll.scrollLeft = 0;
          return Math.abs(after - before) < 2;
        })(),
        openGridRow: grid.open_grid_row === row.grid_form,
        dataRowVisible: row.wrapper.css('display') !== 'none',
        markedOpen: row.wrapper.hasClass('grid-row-open'),
        findable: $('.grid-row-open').data('grid_row') === row,
        curGrid: window.cur_frm.cur_grid === row,
      });
    }, 1200));
  })()`);
	console.log(JSON.stringify(form, null, 2));
	ok(
		"detail panel gets its own <tr> inside <tbody>",
		form.addendumInTable && Number(form.colspan) > 1,
		JSON.stringify({ t: form.addendumInTable, c: form.colspan }),
	);
	ok(
		"child row is the parent's immediate sibling (Carbon selectors need it)",
		form.adjacent && form.childRowMarked,
		JSON.stringify({ a: form.adjacent, m: form.childRowMarked }),
	);
	ok(
		"child row exists for every row and is not a .grid-row",
		form.childRowsForEveryRow && form.childNotGridRow,
		JSON.stringify({ all: form.childRowsForEveryRow, notGridRow: form.childNotGridRow }),
	);
	ok(
		"the form renders inline, not as a modal",
		form.formInsideAddendum && form.formVisible && form.formInline && form.fieldsRendered > 0,
		JSON.stringify({ v: form.formVisible, inline: form.formInline, f: form.fieldsRendered }),
	);
	ok(
		"the panel is stuck to the scroll viewport",
		form.panelStuck && form.panelHolds,
		JSON.stringify({ sticky: form.panelStuck, holds: form.panelHolds }),
	);
	ok(
		"no freeze backdrop, and the freeze count is balanced",
		form.frozen === 0 && form.freezeBalanced,
		JSON.stringify({ frozen: form.frozen, balanced: form.freezeBalanced }),
	);
	ok(
		"Carbon expandable classes and ARIA",
		form.parentRowClass &&
			form.expandedClass &&
			form.previousValue === "collapsed" &&
			form.ariaExpanded === "true" &&
			form.ariaControls,
		JSON.stringify({
			p: form.parentRowClass,
			e: form.expandedClass,
			pv: form.previousValue,
			a: form.ariaExpanded,
			c: form.ariaControls,
		}),
	);
	ok(
		"frappe's open-row bookkeeping still holds",
		form.openGridRow && form.dataRowVisible && form.markedOpen && form.findable && form.curGrid,
		JSON.stringify(form),
	);

	await page.screenshot(SHOT + "/bench-grid-expanded.png");

	// Opening a second row collapses the first: frappe's toggle_view() is an
	// accordion and `cur_frm.cur_grid` / `grid.open_grid_row` are single slots.
	const accordion = await page.eval<AccordionProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const rows = grid.grid_rows.filter(Boolean);
    rows[1].toggle_view(true);
    return new Promise((res) => setTimeout(() => res({
      firstClosed: !rows[0].wrapper.hasClass('grid-row-open'),
      secondOpen: rows[1].wrapper.hasClass('grid-row-open'),
      onlyOne: document.querySelectorAll('.grid-row-open').length === 1,
      curGrid: window.cur_frm.cur_grid === rows[1],
    }), 900));
  })()`);
	ok(
		"one row at a time",
		accordion.firstClosed && accordion.secondOpen && accordion.onlyOne && accordion.curGrid,
		JSON.stringify(accordion),
	);

	const closed = await page.eval<ClosedProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[1];
    row.toggle_view(false);
    return new Promise((res) => setTimeout(() => res({
      collapsed: row.wrapper[0].nextElementSibling.getBoundingClientRect().height < 2,
      expandedClassGone: !row.wrapper[0].classList.contains('cds--expandable-row'),
      previousValueGone: !row.wrapper[0].querySelector('td.cds--table-expand').hasAttribute('data-previous-value'),
      rowBack: row.wrapper.css('display') !== 'none',
      frozen: document.querySelectorAll('#freeze').length,
      freezeBalanced: frappe.dom.freeze_count === window.__freezeBefore,
      curGrid: window.cur_frm.cur_grid,
    }), 900));
  })()`);
	ok(
		"closing collapses the panel and leaves no backdrop behind",
		closed.collapsed &&
			closed.expandedClassGone &&
			closed.previousValueGone &&
			closed.rowBack &&
			closed.frozen === 0 &&
			closed.freezeBalanced,
		JSON.stringify(closed),
	);

	// The "Open in dialog" escape hatch, and the freeze count around it. Opening
	// another row while a modal row is open closes the modal one through
	// `toggle_view(false)` — a path that knows nothing about the mode, and that
	// used to leave the backdrop stranded over the whole desk.
	const modal = await page.eval<ModalProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const rows = grid.grid_rows.filter(Boolean);
    rows[0].toggle_view(true, null, { modal: true });
    return new Promise((res) => setTimeout(() => {
      const formEl = rows[0].grid_form.wrapper[0];
      const opened = {
        modalClass: grid.wrapper.hasClass('cf-grid--modal-form'),
        fixed: getComputedStyle(formEl).position === 'fixed',
        onTop: (() => {
          const r = formEl.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 30));
          return !!(hit && formEl.contains(hit));
        })(),
        frozen: document.querySelectorAll('#freeze').length,
      };
      rows[1].toggle_view(true);
      setTimeout(() => res(Object.assign(opened, {
        afterFrozen: document.querySelectorAll('#freeze').length,
        afterCount: frappe.dom.freeze_count,
        modalClassGone: !grid.wrapper.hasClass('cf-grid--modal-form'),
        secondInline: getComputedStyle(rows[1].grid_form.wrapper[0]).position === 'static',
      })), 900);
    }, 1200));
  })()`);
	ok(
		"Open in dialog restores the centered modal, above its own backdrop",
		modal.modalClass && modal.fixed && modal.onTop && modal.frozen === 1,
		JSON.stringify(modal),
	);
	ok(
		"switching rows lifts the modal backdrop instead of stranding it",
		modal.afterFrozen === 0 && modal.afterCount === 0 && modal.modalClassGone && modal.secondInline,
		JSON.stringify(modal),
	);
	await page.eval(
		`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[1].toggle_view(false); return true; })()`,
	);

	// The expand chevron itself, not just the API behind it.
	const chevron = await page.eval<ChevronProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    row.expand_button.click();
    return new Promise((res) => setTimeout(() => res({
      opened: row.wrapper.hasClass('grid-row-open'),
      aria: row.expand_button.getAttribute('aria-expanded'),
    }), 900));
  })()`);
	ok("the chevron opens the panel", chevron.opened && chevron.aria === "true", JSON.stringify(chevron));
	await page.eval(
		`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[0].toggle_view(false); return true; })()`,
	);

	// --- cell interiors must not occlude row/header state ----------------------
	// Carbon puts hover, selection and expansion on the <tr> and $layer-accent on
	// the <th>; all of them sit BEHIND the cells. frappe paints cell surfaces at
	// .grid-body scope, and `.grid-body .col:last-child` is (0,3,0) — a
	// pseudo-class counts class-level — which in this layout matches EVERY cell,
	// because the engine nests each frappe cell alone inside
	// .cf-table__cell-content. That produced a header band visible only in the
	// two gutters that have no frappe cell in them, and an expanded row whose
	// hover tint reached the chevron column and nothing else.
	//
	// The hover half is driven with the REAL pointer, as the list suite does:
	// Carbon's row-hover fill is behind `@media (any-hover: hover)` and a
	// MouseEvent dispatched from page script does not make `:hover` match.
	const headerPaint = await page.eval<HeaderPaintProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const bg = (n) => n ? getComputedStyle(n).backgroundColor : null;
    const inner = (c) => c.querySelector('.grid-static-col, .row-check, .row-index');
    const ths = Array.from(grid.wrapper.find('thead tr.grid-row th'));
    return {
      fills: Array.from(new Set(ths.map(bg))),
      inners: Array.from(new Set(ths.map(inner).filter(Boolean).map(bg))),
    };
  })()`);
	ok(
		"the header band reaches every column, not just the gutters",
		headerPaint.fills.length === 1 &&
			headerPaint.fills[0] !== "rgba(0, 0, 0, 0)" &&
			headerPaint.inners.length === 1 &&
			headerPaint.inners[0] === "rgba(0, 0, 0, 0)",
		JSON.stringify(headerPaint),
	);

	const panelBox = await page.eval<PointProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    row.toggle_view(true);
    return new Promise((res) => setTimeout(() => {
      const r = row.form_row.getBoundingClientRect();
      res({ x: Math.round(r.left + 200), y: Math.round(r.top + 40) });
    }, 900));
  })()`);
	await page.hover(panelBox.x, panelBox.y);
	const rowPaint = await page.eval<RowPaintProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    const bg = (n) => n ? getComputedStyle(n).backgroundColor : null;
    const inner = (c) => c.querySelector('.grid-static-col, .row-check, .row-index');
    const parent = row.wrapper[0];
    const tds = Array.from(parent.querySelectorAll('td'));
    return {
      hoverCls: parent.classList.contains('cds--expandable-row--hover'),
      tds: Array.from(new Set(tds.map(bg))),
      inners: Array.from(new Set(tds.map(inner).filter(Boolean).map(bg))),
    };
  })()`);
	console.log(JSON.stringify({ headerPaint, rowPaint }));
	ok(
		"an expanded row's hover tint covers the whole row, not just the chevron",
		rowPaint.hoverCls &&
			rowPaint.tds.length === 1 &&
			rowPaint.tds[0] !== "rgba(0, 0, 0, 0)" &&
			rowPaint.inners.length === 1 &&
			rowPaint.inners[0] === "rgba(0, 0, 0, 0)",
		JSON.stringify(rowPaint),
	);
	await page.eval(
		`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[0].toggle_view(false); return true; })()`,
	);

	// --- the Carbon toolbar --------------------------------------------------
	// Everything here MOVED from `.grid-footer`; nothing was rebuilt. The point
	// of the assertions is that the nodes are the same ones frappe wired its
	// data-action handlers and cached handles onto.
	const toolbar = await page.eval<ToolbarProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const bar = grid.wrapper.find('.cf-table__toolbar')[0];
    const batch = bar && bar.querySelector('.cds--batch-actions');
    const content = bar && bar.querySelector('.cds--toolbar-content');
    const addRow = grid.wrapper.find('.grid-add-row')[0];
    const footer = grid.wrapper.find('.cf-table__footer')[0];
    return {
      hasToolbar: !!bar,
      batchBeforeContent: !!(batch && content && batch.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING),
      addRowInToolbar: !!(content && content.contains(addRow)),
      addRowIsSameNode: addRow === grid.wrapper.find('.grid-buttons .grid-add-row')[0],
      deleteInBatch: !!(batch && batch.contains(grid.remove_rows_button[0])),
      gearInToolbar: !!(content && grid.header_row.configure_columns_button &&
        content.contains(grid.header_row.configure_columns_button[0])),
      searchToggle: !!(content && content.querySelector('[aria-pressed]')),
      paginationInFooter: !!(footer && footer.querySelector('.grid-pagination')),
      footerHidden: getComputedStyle(grid.wrapper.find('.grid-footer')[0]).display === 'none',
    };
  })()`);
	console.log(JSON.stringify(toolbar, null, 2));
	ok(
		"the Carbon toolbar exists with the batch bar before the content",
		toolbar.hasToolbar && toolbar.batchBeforeContent,
		JSON.stringify(toolbar),
	);
	ok(
		"Add row moved into the toolbar (same node, handlers intact)",
		toolbar.addRowInToolbar && toolbar.addRowIsSameNode,
	);
	ok("Delete moved into the batch action list", toolbar.deleteInBatch);
	ok("Configure Columns gear moved into the toolbar", toolbar.gearInToolbar);
	ok("the filter-row toggle is present", toolbar.searchToggle);
	ok(
		"pagination sits below the table, footer is hidden",
		toolbar.paginationInFooter && toolbar.footerHidden,
		JSON.stringify({ p: toolbar.paginationInFooter, f: toolbar.footerHidden }),
	);

	const batch = await page.eval<BatchProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    // A BODY row's checkbox. The grid-body class is on the engine's scroll
    // box, which wraps <thead> too, so the first match there is select-all.
    grid.wrapper.find('tbody.rows .grid-row-check').first().click();
    return new Promise((res) => setTimeout(() => {
      const bar = grid.wrapper.find('.cds--batch-actions')[0];
      const active = bar.classList.contains('cds--batch-actions--active');
      const label = bar.querySelector('.cds--batch-summary__para').textContent;
      grid.clear_selection();
      return setTimeout(() => res({
        active,
        label,
        selected: grid.get_selected().length,
        clearedActive: bar.classList.contains('cds--batch-actions--active'),
        clearedHidden: bar.getAttribute('aria-hidden'),
        addRowBack: !grid.wrapper.find('.grid-add-row').hasClass('hidden'),
      }), 500);
    }, 700));
  })()`);
	ok(
		"selecting a row raises the batch bar with a count",
		batch.active && /1/.test(batch.label),
		JSON.stringify({ a: batch.active, l: batch.label }),
	);
	ok(
		"Cancel clears the selection, lowers the bar and restores Add row",
		batch.selected === 0 && !batch.clearedActive && batch.clearedHidden === "true" && batch.addRowBack,
		JSON.stringify(batch),
	);

	// frappe 16.50's grid buttons are espresso buttons; their label lives in a
	// `.es-button__label` span that `Grid#set_button_label` rewrites in place. The
	// toolbar moves those buttons (and turns two into icon-only actions) without
	// replacing what is inside them, or the counts below would stop updating.
	const labels = await page.eval<LabelProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const label = (b) => b.find('.es-button__label').text();
    const checks = grid.wrapper.find('tbody.rows .grid-row-check');
    checks.eq(0).click();
    await sleep(500);
    const one = { del: label(grid.remove_rows_button), dup: label(grid.duplicate_rows_button) };
    checks.eq(1).click();
    await sleep(500);
    const two = { del: label(grid.remove_rows_button), dup: label(grid.duplicate_rows_button) };
    const dl = grid.wrapper.find('.grid-download')[0];
    grid.set_button_label($(dl), 'Export');
    const node = dl.querySelector('.es-button__label');
    const download = {
      label: node ? node.textContent : '',
      glyph: !!dl.querySelector(':scope > svg'),
      spinner: !!dl.querySelector('.es-spinner'),
      hiddenLabel: !!node && node.classList.contains('cds--visually-hidden'),
      title: dl.getAttribute('title'),
    };
    grid.set_button_label($(dl), 'Download');
    grid.clear_selection();
    await sleep(500);
    return { one, two, download };
  })()`);
	ok(
		"Delete / Duplicate labels follow the selection count (set_button_label)",
		labels.one.del === "Delete row" &&
			labels.one.dup === "Duplicate row" &&
			labels.two.del === "Delete 2 rows" &&
			labels.two.dup === "Duplicate 2 rows",
		JSON.stringify(labels),
	);
	ok(
		"an icon-only toolbar action keeps its es-button label node, which set_button_label still reaches",
		labels.download.label === "Export" &&
			labels.download.glyph &&
			labels.download.spinner &&
			labels.download.hiddenLabel &&
			!!labels.download.title,
		JSON.stringify(labels.download),
	);

	// The magnifier reveals frappe's per-column filter row at ANY row count —
	// upstream it only appears past `rows_threshold_for_grid_search` (20).
	const search = await page.eval<SearchProbe>(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const before = grid.wrapper.find('tr.filter-row:visible').length;
    grid.wrapper.find('.cds--toolbar-content [aria-pressed]')[0].click();
    return new Promise((res) => setTimeout(() => res({
      rows: grid.data.length,
      before,
      after: grid.wrapper.find('tr.filter-row').filter(function () {
        return this.offsetParent !== null;
      }).length,
      inputs: grid.wrapper.find('tr.filter-row input').length,
    }), 700));
  })()`);
	ok(
		"the magnifier reveals the filter row below the 20-row threshold",
		search.rows < 20 && search.before === 0 && search.after === 1 && search.inputs > 0,
		JSON.stringify(search),
	);

	// --- pagination (more than grid_page_length rows) -------------------------
	// frappe's pager is three es-buttons around a page number, re-`.html()`d into
	// `.grid-pagination` on every change; the toolbar moves that element below
	// the table. 16.50 also re-syncs the header's select-all with the page shown
	// (`update_select_all_checkbox`).
	const pager = await page.eval<PagerProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    window.__itemsBefore = cur_frm.doc.items.length;
    for (let i = 0; i < 110; i++) cur_frm.add_child('items', { qty: i + 1 });
    cur_frm.refresh_field('items');
    await new Promise((r) => setTimeout(r, 2500));
    const w = grid.wrapper;
    const node = (s) => w.find(s)[0];
    const shown = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const names = ['.first-page', '.prev-page', '.next-page', '.last-page'];
    const rows = w.find('tbody.rows tr.grid-row');
    return {
      rows: grid.data.length,
      pages: w.find('.total-page-number').text().trim(),
      buttons: { first: !!node('.first-page'), prev: !!node('.prev-page'), next: !!node('.next-page'), last: !!node('.last-page') },
      espresso: names.every((s) => node(s) && node(s).classList.contains('es-button')),
      visible: names.every((s) => node(s) && shown(node(s))),
      inFooter: !!node('.cf-table__footer .grid-pagination'),
      page1: rows.length,
      page1First: rows.first().attr('data-idx') || null,
    };
  })()`);
	ok(
		"more rows than one page: First / Previous / Next / Last render as visible es-buttons below the table",
		pager.rows > 100 &&
			pager.pages === String(Math.ceil(pager.rows / 50)) &&
			pager.buttons.first &&
			pager.buttons.prev &&
			pager.buttons.next &&
			pager.buttons.last &&
			pager.espresso &&
			pager.visible &&
			pager.inFooter,
		JSON.stringify(pager),
	);
	ok(
		"page one renders 50 rows",
		pager.page1 === 50 && pager.page1First === "1",
		JSON.stringify({ n: pager.page1, first: pager.page1First }),
	);
	await page.screenshot(SHOT + "/bench-grid-pager.png");

	const paged = await page.eval<PagedProbe>(`(async () => {
    const grid = cur_frm.fields_dict.items.grid;
    const w = grid.wrapper;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowsHere = () => w.find('tbody.rows tr.grid-row');
    const headerCheck = () => w.find('.grid-heading-row .grid-row-check');
    w.find('.next-page')[0].click();
    await sleep(900);
    const first = rowsHere().first().attr('data-idx') || null;
    const rows = rowsHere().length;
    const sparse = !grid.grid_rows[0] && grid.grid_rows.filter(Boolean).length === rows;
    headerCheck()[0].click();
    await sleep(600);
    const checkedOnTwo = w.find('tbody.rows .grid-row-check:checked').length;
    const selected = grid.get_selected_children().length;
    const selectAllOnTwo = headerCheck().prop('checked');
    w.find('.prev-page')[0].click();
    await sleep(900);
    const selectAllBackOnOne = headerCheck().prop('checked');
    w.find('.next-page')[0].click();
    await sleep(900);
    const selectAllBackOnTwo = headerCheck().prop('checked');
    grid.clear_selection();
    await sleep(400);
    return { rows, firstIdx: first, sparse, selectAllOnTwo, checkedOnTwo, selected, selectAllBackOnOne, selectAllBackOnTwo };
  })()`);
	ok(
		"Next page renders rows 51-100, and grid_rows stays sparse outside the page",
		paged.rows === 50 && paged.firstIdx === "51" && paged.sparse,
		JSON.stringify(paged),
	);
	ok(
		"select-all checks the page shown, and the header checkbox follows the page (update_select_all_checkbox)",
		paged.selectAllOnTwo &&
			paged.checkedOnTwo === 50 &&
			paged.selected === 50 &&
			!paged.selectAllBackOnOne &&
			paged.selectAllBackOnTwo,
		JSON.stringify(paged),
	);
	await page.eval(`(async () => {
    cur_frm.doc.items = cur_frm.doc.items.slice(0, window.__itemsBefore);
    cur_frm.refresh_field('items');
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  })()`);

	// --- switching documents ------------------------------------------------
	// `FrappeForm#switch_doc` nulls every grid's `visible_columns` and
	// re-renders the rows BEFORE the new docname is set (form.js:537-539).
	// Upstream rebuilds the columns lazily through the rows it refreshes, so a
	// grid that had NO rows on the first document never rebuilt them; this
	// grid reads `visible_columns` directly for the engine's columns and used
	// to throw there — mid-`refresh()`, so the form kept the first document's
	// title and values. Contact is in core and its `email_ids` table is
	// optional, which makes the empty-then-populated pair cheap to seed.
	const seeded = await page.eval<SwitchSeedProbe>(`(async () => {
    const mk = async (first_name, email_ids) => {
      const existing = await frappe.db.get_list('Contact', { filters: { first_name }, fields: ['name'] });
      for (const c of existing) await frappe.db.delete_doc('Contact', c.name);
      const r = await frappe.call('frappe.client.insert', { doc: { doctype: 'Contact', first_name, email_ids } });
      return r.message.name;
    };
    const a = await mk('CF Switch A', []);
    const b = await mk('CF Switch B', [{ email_id: 'cf-switch-b@example.com', is_primary: 1 }]);
    return { a, b };
  })()`);
	const errorsBefore = page.consoleErrors().length;
	await page.eval(`frappe.set_route('Form', 'Contact', ${JSON.stringify(seeded.a)})`);
	await page.waitFor(
		`!!window.cur_frm && cur_frm.doctype === 'Contact' && cur_frm.docname === ${JSON.stringify(seeded.a)} && !!cur_frm.fields_dict.email_ids.grid.grid_rows`,
	);
	await page.eval(`frappe.set_route('List', 'Contact')`);
	await page.waitFor(`frappe.get_route()[0] === 'List' && !!(cur_list && cur_list.doctype === 'Contact')`);
	await page.eval(`frappe.set_route('Form', 'Contact', ${JSON.stringify(seeded.b)})`);
	// The failing shape never reaches docname B, so a plain wait would only
	// time out; wait for the router to settle on B's route, then read the form.
	await page.waitFor(`frappe.get_route().join('/') === 'Form/Contact/' + ${JSON.stringify(seeded.b)}`);
	await new Promise((r) => setTimeout(r, 1500));
	const switched = await page.eval<SwitchProbe>(`(() => {
    const grid = cur_frm.fields_dict.email_ids.grid;
    return {
      docname: cur_frm.docname,
      firstName: cur_frm.doc.first_name,
      title: cur_frm.page.title + ' | ' + document.title,
      visibleColumns: grid.visible_columns ? grid.visible_columns.length : -1,
      rows: grid.wrapper.find('tbody.rows tr.grid-row').length,
      errorsBefore: ${errorsBefore},
      errorsAfter: 0,
      errors: [],
    };
  })()`);
	switched.errorsAfter = page.consoleErrors().length;
	switched.errors = page.consoleErrors().slice(errorsBefore);
	console.log(JSON.stringify(switched));
	ok(
		"switching to a document whose child table was empty on the last one loads it",
		switched.docname === seeded.b && switched.firstName === "CF Switch B" && switched.rows === 1,
		JSON.stringify({ docname: switched.docname, first: switched.firstName, rows: switched.rows }),
	);
	ok(
		"the page title is the new document's",
		switched.title.startsWith("CF Switch B |") && switched.title.includes("| CF Switch B"),
		JSON.stringify(switched.title),
	);
	ok(
		"the empty grid rebuilt its columns instead of throwing",
		switched.visibleColumns > 0 && switched.errorsAfter === switched.errorsBefore,
		switched.errors.slice(0, 2).join(" | "),
	);

	// A short grid: the last data column takes the spare width and the others
	// are exactly what frappe says (frappe's `.grid-data-last`), instead of the
	// browser stretching every column in proportion.
	const fill = await page.eval<FillProbe>(`(() => {
    const grid = cur_frm.fields_dict.email_ids.grid;
    const w = grid.wrapper;
    const scroll = grid.carbon_table.renderer.scroll;
    const th = (id) => Math.round(w.find('thead th[data-col-id="' + id + '"]')[0].getBoundingClientRect().width);
    const entry = ([df, model]) => ({ id: df.fieldname, model, th: th(df.fieldname) });
    const vc = grid.visible_columns;
    const sum = [...w.find('thead tr.grid-row th')]
      .reduce((n, h) => n + Math.round(h.getBoundingClientRect().width), 0);
    return {
      container: Math.round(scroll.clientWidth),
      table: Math.round(w.find('table')[0].getBoundingClientRect().width),
      sum,
      others: vc.slice(0, -1).map(entry),
      last: entry(vc[vc.length - 1]),
      overflows: scroll.scrollWidth > scroll.clientWidth,
    };
  })()`);
	ok(
		"a short grid fills its container through the last column; the others keep their width",
		!fill.overflows &&
			Math.abs(fill.table - fill.container) <= 1 &&
			Math.abs(fill.sum - fill.container) <= 1 &&
			fill.others.length > 0 &&
			fill.others.every((c) => c.th === c.model) &&
			fill.last.th > fill.last.model,
		JSON.stringify(fill),
	);
	await page.eval(`(async () => {
    await frappe.set_route('List', 'Contact');
    for (const n of ${JSON.stringify([seeded.a, seeded.b])}) await frappe.db.delete_doc('Contact', n);
    return true;
  })()`);

	await page.screenshot(SHOT + "/bench-grid.png");
	// `consoleErrors()` is the Log domain only; an exception thrown inside a
	// promise (a column that cannot be sized, say) is `Runtime.exceptionThrown`
	// and never reaches it — which is how a grid that did not render at all
	// used to pass as "no console errors".
	const thrown = page.events
		.filter((e) => e.method === "Runtime.exceptionThrown")
		.map((e) => JSON.stringify(e.params).slice(0, 300));
	ok("no uncaught exceptions or unhandled rejections", thrown.length === 0, thrown.slice(0, 2).join(" | "));
	const errs = page.consoleErrors();
	ok("no console errors", errs.length === 0, errs.slice(0, 4).join(" | "));
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
