import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.ts";

// ---------------------------------------------------------------------------
// What the page-evaluated bodies below hand back.
//
// `page.eval` is generic and defaults to `unknown` — the wire carries
// `returnByValue` JSON with no shape the driver can check, so declaring it is
// the caller's job. These interfaces are that declaration, one per probe and
// named after the binding it lands in. They double as a written record of the
// QueryReport / CarbonDataTable surface this suite asserts.
// ---------------------------------------------------------------------------

/** The datatable QueryReport builds for us, before any report script is installed. */
interface BaseProbe {
	/** Diagnostic only. esbuild lowers the class, so this is NOT `"CarbonDataTable"`. */
	ctor: string;
	/** The identity test: `window.DataTable` itself, carrying a real engine. */
	viaWindow: boolean;
	rows: number;
	cols: number;
	dtRows: number;
	carbon: boolean;
}

/**
 * The counters `window.__probe` accumulates while the installed report script
 * runs. `hasRowmanager`/`hasDatamanager` are optional because the object is
 * created without them: `after_datatable_render` is what adds them, so they are
 * absent until it has fired.
 */
interface ReportScriptProbe {
	formatter: number;
	getOpts: number;
	afterRender: number;
	editor: number;
	setValueSeen: string | null;
	hasRowmanager?: boolean;
	hasDatamanager?: boolean;
}

/** The report as it stands once the installed script has re-rendered it. */
interface AfterProbe {
	probe: ReportScriptProbe;
	cellBg: string | null;
	cellFw: string | null;
	probeCells: number;
	stdCols: number;
	cellHeight: number;
	rowH: number;
}

/** The `getEditor` round trip: mounted, typed into, committed. */
interface EditProbe {
	editorCalls: number;
	mounted: boolean;
	setValueSeen: string | null;
}

/** `rowmanager.getCheckedRows()` and what QueryReport makes of it. */
interface ChecksProbe {
	checked: number[];
	items: number;
}

/**
 * One reading of a standalone tree table's selection: the map, and the two
 * group boxes as the DOM has them. `indeterminate` is not in `checkMap` — it is
 * derived per render — so it can only be read off the input.
 */
interface TreeSelectionProbe {
	checked: number[];
	groupChecked: boolean[];
	groupIndeterminate: boolean[];
}

/** Print and export read "every row the table shows"; this is that, against the DOM window. */
interface VisibleProbe {
	/** `datamanager.getFilteredRowIndices().length` */
	all: number;
	/** `bodyRenderer.visibleRowIndices.length` */
	visible: number;
	/** `<tr>`s actually in the DOM — the virtualization window */
	dom: number;
	printed: number | string;
	data: number;
}

/** The Link-cell side panel: the wiring, and the engine contract its handler reads. */
interface SidePanelProbe {
	wired: boolean;
	handled: boolean;
	opened: string[] | null;
	required: string | null;
	column: string | null;
}

/** The header menu: its toggle, its items, and what sorting through it does to the columns. */
interface HeaderMenuProbe {
	toggles: number;
	labels: string[];
	sorted: Array<string | undefined>;
	currentSort: string;
	afterReset: Array<string | undefined>;
}

const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
const REPORT = "Database Storage Usage By Tables";
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
// The condition is `unknown` on purpose: assertions hand this whatever their
// expression produced — a boolean, a string, a null out of `querySelector` —
// and the only thing read of it is its truthiness.
const ok = (n: string, c: unknown, x = "") =>
	results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
try {
	await login(page, BASE);
	await page.goto(`${BASE}/app/query-report/${encodeURIComponent(REPORT)}`);
	await page.waitFor(`!!(window.frappe && frappe.query_report && frappe.query_report.datatable)`, {
		timeout: 120000,
	});
	// Guard: a stolen assets.json key means we would be measuring stock frappe.
	await assertCarbonStylesheet(page);
	await new Promise((r) => setTimeout(r, 2000));

	const base = await page.eval<BaseProbe>(`(() => {
    const qr = frappe.query_report;
    return {
      ctor: qr.datatable.constructor.name,
      viaWindow: qr.datatable.constructor === window.DataTable && !!qr.datatable.engine,
      rows: qr.datatable.datamanager.rowCount,
      cols: qr.datatable.datamanager.getColumns().length,
      dtRows: document.querySelectorAll('tbody .dt-row').length,
      carbon: !!document.querySelector('table.cds--data-table'),
    };
  })()`);
	console.log(JSON.stringify(base));
	ok("QueryReport constructs CarbonDataTable via window.DataTable", base.viaWindow, base.ctor);
	ok(
		"report data rendered as a Carbon table",
		base.carbon && base.dtRows > 0,
		`rows=${base.dtRows}/${base.rows}`,
	);

	// --- columns nobody gave a width are sized from their content --------------
	// frappe-datatable measured a natural width per column (style.js
	// `setupNaturalColumnWidth`); a flat 120px clipped values and left no room for
	// the sort glyph beside a label. (Report View is different: frappe itself
	// gives every column 120px, report_view.js:1170.)
	const natural = await page.eval<number[]>(`(() => {
    const dt = frappe.query_report.datatable;
    return dt.columns.slice(dt.standardColumnCount).filter((c) => !c.width).map((c) => dt.engine.getColumnSize(dt.engineColumnId(c.colIndex)));
  })()`);
	ok(
		"columns with no width are sized from their header and cells, not a flat 120px",
		natural.length > 1 && natural.every((w) => w >= 96) && natural.some((w) => w !== 120),
		JSON.stringify(natural),
	);

	// --- print and export read every row the table shows, not the DOM window ---
	// `bodyRenderer.visibleRowIndices` is "the rows passed to renderRows"
	// (frappe-datatable body-renderer.js:17): every row that survives the filters,
	// however many the viewport shows. `get_data_for_print()` and
	// `get_validated_visible_indexes()` (query_report.js:1648, 1981) intersect
	// `rowViewOrder` with it. Reading the engine's render window instead made a
	// 1000-row report print and export one screenful.
	const visible = await page.eval<VisibleProbe>(`(() => {
    const qr = frappe.query_report;
    const dt = qr.datatable;
    let printed = null;
    try { printed = qr.get_data_for_print().length; } catch (e) { printed = 'threw: ' + (e && e.message || e); }
    return {
      all: dt.datamanager.getFilteredRowIndices().length,
      visible: dt.bodyRenderer.visibleRowIndices.length,
      dom: document.querySelectorAll('tbody .dt-row').length,
      printed,
      data: qr.data.length,
    };
  })()`);
	console.log(JSON.stringify(visible));
	ok(
		"visibleRowIndices is every row the table shows, past the virtualization window",
		visible.visible === visible.all && visible.all > visible.dom,
		JSON.stringify(visible),
	);
	ok(
		"get_data_for_print() returns every row, not one screenful",
		typeof visible.printed === "number" && visible.printed >= visible.all,
		JSON.stringify({ printed: visible.printed, all: visible.all }),
	);

	// --- Link cells preview in the side panel --------------------------------
	// `setup_link_side_panel` delegates `a[data-doctype][data-name]` clicks to
	// `frappe.ui.handle_link_cell_click`, which finds the column from the nearest
	// `.dt-cell[data-col-index]` and `datatable.getColumn()`
	// (link_side_panel.js:16-40). The report's own columns are not Link columns, so
	// a Link anchor is planted in a cell and the column's `fieldtype` set, which
	// is exactly what a query report that has one looks like. The panel's bundle
	// is stubbed; what is under test is that the engine gives the handler what it
	// reads.
	const sidePanel = await page.eval<SidePanelProbe>(`(() => {
    const qr = frappe.query_report;
    const dt = qr.datatable;
    const events = $._data(qr.$report[0], 'events');
    const wired = !!(events && events.click && events.click.some((h) => h.namespace === 'side-panel'));
    const td = document.querySelector('tbody .dt-cell[data-col-index="2"]');
    const content = td.querySelector('.dt-cell__content') || td;
    const original = content.innerHTML;
    content.innerHTML = '<a data-doctype="User" data-name="Administrator" href="#">x</a>';
    const column = dt.getColumn(2);
    const savedType = column.fieldtype;
    column.fieldtype = 'Link';
    const saved = { require: frappe.require, panel: frappe.ui.get_side_panel };
    const res = { wired, handled: false, opened: null, required: null, column: column && column.id };
    frappe.require = (name) => { res.required = name; return Promise.resolve(); };
    frappe.ui.get_side_panel = () => ({ open: (doctype, name) => { res.opened = [doctype, name]; } });
    const evt = { which: 1, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      currentTarget: content.firstChild, preventDefault() {}, stopPropagation() {} };
    res.handled = frappe.ui.handle_link_cell_click(evt, dt) === true;
    return new Promise((done) => setTimeout(() => {
      frappe.require = saved.require;
      frappe.ui.get_side_panel = saved.panel;
      column.fieldtype = savedType;
      content.innerHTML = original;
      done(res);
    }, 100));
  })()`);
	console.log(JSON.stringify(sidePanel));
	ok("QueryReport wires the Link-cell side panel", sidePanel.wired);
	ok(
		"the side-panel handler finds its column through .dt-cell[data-col-index] and getColumn()",
		sidePanel.handled &&
			sidePanel.required === "side_panel.bundle.js" &&
			sidePanel.opened?.join("/") === "User/Administrator",
		JSON.stringify(sidePanel),
	);

	// --- the column header menu ---------------------------------------------
	// frappe-datatable's `dt-dropdown`: Sort Ascending / Descending, Reset
	// sorting, Remove column, Freeze — as a Carbon overflow menu on each header.
	// Sorting through it has to land on `columns[].sortOrder`, which is what
	// Report View's "Export all rows" reads back (report_view.js:1795-1818).
	const std = await page.eval<number>(`frappe.query_report.datatable.standardColumnCount`);
	const toggles = await page.eval<number>(`document.querySelectorAll('thead .cf-dt-menu__toggle').length`);
	const toggleBox = await page.eval<{ x: number; y: number }>(`(() => {
    const th = document.querySelector('thead th[data-col-index="${std}"]');
    th.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const r = th.querySelector('.cf-dt-menu__toggle').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
	const clickAt = async (x: number, y: number): Promise<void> => {
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await page.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
	};
	await clickAt(toggleBox.x, toggleBox.y);
	await page.waitFor(`!!document.querySelector('.cf-dt-menu:not([hidden]) button')`, { timeout: 5000 });
	const labels = await page.eval<string[]>(
		`[...document.querySelectorAll('.cf-dt-menu:not([hidden]) .cds--overflow-menu-options__option-content')].map((n) => n.textContent.trim())`,
	);
	const sortDesc = await page.eval<{ x: number; y: number }>(`(() => {
    const item = [...document.querySelectorAll('.cf-dt-menu:not([hidden]) button')].find((b) => b.textContent.trim() === 'Sort Descending');
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
	await clickAt(sortDesc.x, sortDesc.y);
	await new Promise((r) => setTimeout(r, 400));
	const sorted = await page.eval<{ sorted: Array<string | undefined>; currentSort: string }>(`(() => {
    const dt = frappe.query_report.datatable;
    return { sorted: dt.datamanager.getColumns().map((c) => c.sortOrder), currentSort: JSON.stringify(dt.datamanager.currentSort) };
  })()`);
	await page.eval(`(frappe.query_report.datatable.sortColumn(${std}, 'none'), true)`);
	await new Promise((r) => setTimeout(r, 200));
	const afterReset = await page.eval<Array<string | undefined>>(
		`frappe.query_report.datatable.datamanager.getColumns().map((c) => c.sortOrder)`,
	);
	const menu: HeaderMenuProbe = {
		toggles,
		labels,
		sorted: sorted.sorted,
		currentSort: sorted.currentSort,
		afterReset,
	};
	console.log(JSON.stringify(menu));
	ok(
		"data columns get a header menu; the checkbox and serial columns do not",
		menu.toggles > 0 && menu.toggles === base.cols - std,
		JSON.stringify({ toggles: menu.toggles, cols: base.cols, std }),
	);
	ok(
		"the menu offers frappe-datatable's items",
		["Sort Ascending", "Sort Descending", "Reset sorting", "Remove column", "Freeze"].every((l) =>
			menu.labels.includes(l),
		),
		JSON.stringify(menu.labels),
	);
	ok(
		"sorting through the menu writes columns[].sortOrder (what export reads)",
		menu.sorted[std] === "desc" && menu.sorted.filter((o) => o === "desc").length === 1,
		JSON.stringify(menu.sorted),
	);
	ok(
		"resetting the sort clears every column's sortOrder",
		menu.afterReset.every((o) => o === "none"),
		JSON.stringify(menu.afterReset),
	);

	// Install a timesheet_review-shaped consumer and re-render through it.
	await page.eval<true>(`(() => {
    window.__probe = { formatter: 0, getOpts: 0, afterRender: 0, editor: 0, setValueSeen: null };
    frappe.query_reports[${JSON.stringify(REPORT)}] = Object.assign(frappe.query_reports[${JSON.stringify(REPORT)}] || {}, {
      initial_depth: 1,
      formatter: function (value, row, column, data, default_formatter) {
        window.__probe.formatter++;
        return '<span class="probe-cell">' + default_formatter(value, row, column, data) + '</span>';
      },
      get_datatable_options: function (options) {
        window.__probe.getOpts++;
        return Object.assign(options, {
          checkboxColumn: true,
          serialNoColumn: true,
          cellHeight: 36,
          getEditor: function (colIndex, rowIndex, value, parent, column, row, data) {
            window.__probe.editor++;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'dt-input probe-editor';
            parent.appendChild(input);
            return {
              initValue(v) { input.value = v == null ? '' : v; input.focus(); },
              getValue() { return input.value; },
              setValue(v) { window.__probe.setValueSeen = v; },
            };
          },
        });
      },
      after_datatable_render: function (datatable) {
        window.__probe.afterRender++;
        window.__probe.hasRowmanager = !!datatable.rowmanager;
        window.__probe.hasDatamanager = !!datatable.datamanager;
        datatable.rowmanager.checkMap = [];
        datatable.datamanager.rows.forEach((row, rowIndex) => {
          datatable.datamanager.columns.forEach((_, colIdx) => {
            datatable.style.setStyle('.dt-cell--' + colIdx + '-' + rowIndex, { backgroundColor: '', fontWeight: '' });
          });
        });
        datatable.style.setStyle('.dt-cell--2-0', { backgroundColor: 'rgb(0, 128, 0)', fontWeight: '700' });
        // query_report.js:1431 builds every cell with editable: column.editable ?? false,
        // and frappe-datatable's activateEditing bails on that too, so a report
        // that wants inline editing opts its cells in. Do the same here.
        // frappe-datatable gates on BOTH: activateEditing returns early if the
        // column is non-editable, then again if the cell is. Query reports mark
        // both false by default, so a report enabling inline editing opts both in.
        datatable.datamanager.columns.forEach((c, i) => { if (i >= datatable.standardColumnCount) c.editable = true; });
        datatable.datamanager.rows.forEach((r) => r.forEach((c) => { c.editable = true; }));
      },
    });
    // query_report.js only calls get_datatable_options on CONSTRUCTION; when a
    // datatable already exists with a matching showTotalRow it takes the
    // datatable.refresh(data, columns) reuse path instead. Drop the instance
    // so this exercises the first-load path a real report script sees.
    frappe.query_report.datatable.destroy();
    frappe.query_report.datatable = null;
    frappe.query_report.refresh();
    return true;
  })()`);
	await new Promise((r) => setTimeout(r, 4000));

	const after = await page.eval<AfterProbe>(`(() => {
    const p = window.__probe;
    const dt = frappe.query_report.datatable;
    const cell = document.querySelector('.dt-cell--2-0');
    return {
      probe: p,
      cellBg: cell ? getComputedStyle(cell).backgroundColor : null,
      cellFw: cell ? getComputedStyle(cell).fontWeight : null,
      probeCells: document.querySelectorAll('.probe-cell').length,
      stdCols: dt.datamanager.getStandardColumnCount(),
      cellHeight: dt.options.cellHeight,
      rowH: Math.round(document.querySelector('tbody .dt-row').getBoundingClientRect().height),
    };
  })()`);
	console.log(JSON.stringify(after, null, 2));
	ok(
		"report_settings.get_datatable_options() applied",
		after.probe.getOpts > 0 && after.stdCols === 2,
		JSON.stringify({ g: after.probe.getOpts, std: after.stdCols }),
	);
	ok(
		"report_settings.formatter() drives cell HTML",
		after.probe.formatter > 0 && after.probeCells > 0,
		`calls=${after.probe.formatter} cells=${after.probeCells}`,
	);
	ok(
		"after_datatable_render() receives a usable instance",
		after.probe.afterRender > 0 && after.probe.hasRowmanager && after.probe.hasDatamanager,
	);
	ok(
		"style.setStyle from after_datatable_render paints the cell",
		after.cellBg === "rgb(0, 128, 0)" && after.cellFw === "700",
		JSON.stringify({ bg: after.cellBg, fw: after.cellFw }),
	);
	ok("cellHeight honoured (36 -> Carbon md 40)", after.rowH >= 32 && after.rowH <= 44, `rowH=${after.rowH}`);

	// getEditor path
	const edit = await page.eval<EditProbe>(`(() => {
    const td = document.querySelector('tbody .dt-row .dt-cell[data-col-index="3"]');
    td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return new Promise(res => setTimeout(() => {
      const input = document.querySelector('.probe-editor');
      if (input) { input.value = 'edited-by-probe'; }
      document.querySelector('.datatable').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      setTimeout(() => res({ editorCalls: window.__probe.editor, mounted: !!input, setValueSeen: window.__probe.setValueSeen }), 400);
    }, 400));
  })()`);
	ok(
		"getEditor() called and its input mounted in the cell",
		edit.editorCalls > 0 && edit.mounted,
		JSON.stringify(edit),
	);
	ok(
		"editor setValue() receives the new value",
		edit.setValueSeen === "edited-by-probe",
		String(edit.setValueSeen),
	);

	// rowmanager.getCheckedRows — the 13-call-site API
	const checks = await page.eval<ChecksProbe>(`(() => {
    const dt = frappe.query_report.datatable;
    dt.rowmanager.checkRow(0, true);
    dt.rowmanager.checkRow(1, true);
    return { checked: dt.rowmanager.getCheckedRows(), items: frappe.query_report.get_checked_items().length };
  })()`);
	ok(
		"rowmanager.getCheckedRows() + QueryReport.get_checked_items()",
		JSON.stringify(checks.checked) === "[0,1]" && checks.items === 2,
		JSON.stringify(checks),
	);

	// ---------------------------------------------------------------- tree mode
	//
	// Selection cascade, on a standalone CarbonDataTable rather than this
	// suite's report: "Database Storage Usage By Tables" is flat, and the
	// cascade's whole subject is what a group header does to the rows under it.
	// Two groups of two, which is the shape a custom Print Queue report has
	// (a fabric, then its jobs) and enough to catch a cascade that leaks into a
	// sibling group.
	await page.eval<true>(`(() => {
    const host = document.createElement('div');
    host.id = 'probe-tree';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:600px;height:320px;z-index:9999;background:var(--cds-layer, #fff)';
    document.body.appendChild(host);
    window.__tree = new window.DataTable(host, {
      columns: [{ id: 'label', name: 'Label' }, { id: 'qty', name: 'Qty' }],
      data: [
        { indent: 0, label: 'Group A', qty: '' },
        { indent: 1, label: 'A1', qty: '1' },
        { indent: 1, label: 'A2', qty: '2' },
        { indent: 0, label: 'Group B', qty: '' },
        { indent: 1, label: 'B1', qty: '3' },
        { indent: 1, label: 'B2', qty: '4' },
      ],
      treeView: true,
      checkboxColumn: true,
      serialNoColumn: false,
      layout: 'fluid',
    });
    // Groups open, so every box in the assertions below is in the DOM to read.
    window.__tree.rowmanager.expandAllNodes();
    // Indices into the FLAT data, which is what checkMap is keyed by.
    window.__treeProbe = () => {
      const dt = window.__tree;
      const box = (i) => dt.engine.renderer.tbody.querySelector('.dt-cell[data-row-index="' + i + '"] .dt-checkbox');
      const a = box(0), b = box(3);
      return {
        checked: dt.rowmanager.getCheckedRows(),
        groupChecked: [!!(a && a.checked), !!(b && b.checked)],
        groupIndeterminate: [!!(a && a.indeterminate), !!(b && b.indeterminate)],
      };
    };
    return true;
  })()`);
	await new Promise((r) => setTimeout(r, 500));

	const treeDown = await page.eval<TreeSelectionProbe>(`(() => {
    window.__tree.rowmanager.checkAll(false);
    window.__tree.rowmanager.checkRow(0, true);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__treeProbe()))));
  })()`);
	ok(
		"checking a group header checks the rows under it",
		JSON.stringify(treeDown.checked) === "[0,1,2]",
		JSON.stringify(treeDown),
	);
	ok(
		"the cascade stops at the group it started in",
		treeDown.groupChecked[0] && !treeDown.groupChecked[1] && !treeDown.groupIndeterminate[1],
		JSON.stringify(treeDown),
	);

	const treePartial = await page.eval<TreeSelectionProbe>(`(() => {
    window.__tree.rowmanager.checkRow(1, false);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__treeProbe()))));
  })()`);
	ok(
		"unchecking one child releases its group header",
		JSON.stringify(treePartial.checked) === "[2]",
		JSON.stringify(treePartial),
	);
	ok(
		"a partly-selected group header reads indeterminate",
		treePartial.groupIndeterminate[0] && !treePartial.groupChecked[0],
		JSON.stringify(treePartial),
	);

	const treeBack = await page.eval<TreeSelectionProbe>(`(() => {
    window.__tree.rowmanager.checkRow(1, true);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__treeProbe()))));
  })()`);
	ok(
		"completing a group's children re-checks its header",
		JSON.stringify(treeBack.checked) === "[0,1,2]" &&
			treeBack.groupChecked[0] &&
			!treeBack.groupIndeterminate[0],
		JSON.stringify(treeBack),
	);

	// Collapsed: getRowModel() is the VISIBLE model, so select-all sees two rows
	// and has to reach the four it cannot see.
	const treeAll = await page.eval<TreeSelectionProbe>(`(() => {
    const dt = window.__tree;
    dt.rowmanager.checkAll(false);
    dt.rowmanager.collapseAllNodes();
    dt.rowmanager.checkAll(true);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__treeProbe()))));
  })()`);
	ok(
		"select-all over a collapsed tree reaches the hidden children",
		JSON.stringify(treeAll.checked) === "[0,1,2,3,4,5]",
		JSON.stringify(treeAll),
	);

	await page.eval(
		`(() => { window.__tree.destroy(); document.getElementById('probe-tree').remove(); return true; })()`,
	);

	await page.screenshot(SHOT + "/bench-queryreport.png");
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
