import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.mjs";
const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
const REPORT = "Database Storage Usage By Tables";
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results = [];
const ok = (n, c, x = "") => results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
try {
  await login(page, BASE);
  await page.goto(`${BASE}/app/query-report/${encodeURIComponent(REPORT)}`);
  await page.waitFor(`!!(window.frappe && frappe.query_report && frappe.query_report.datatable)`, { timeout: 120000 });
  // Guard: a stolen assets.json key means we would be measuring stock frappe.
  await assertCarbonStylesheet(page);
  await new Promise(r => setTimeout(r, 2000));

  const base = await page.eval(`(() => {
    const qr = frappe.query_report;
    return {
      ctor: qr.datatable.constructor.name,
      viaWindow: qr.datatable instanceof window.DataTable,
      rows: qr.datatable.datamanager.rowCount,
      cols: qr.datatable.datamanager.getColumns().length,
      dtRows: document.querySelectorAll('tbody .dt-row').length,
      carbon: !!document.querySelector('table.cds--data-table'),
    };
  })()`);
  console.log(JSON.stringify(base));
  ok("QueryReport constructs CarbonDataTable via window.DataTable", base.ctor === "CarbonDataTable" && base.viaWindow, base.ctor);
  ok("report data rendered as a Carbon table", base.carbon && base.dtRows > 0, `rows=${base.dtRows}/${base.rows}`);

  // Install a timesheet_review-shaped consumer and re-render through it.
  const hooks = await page.eval(`(() => {
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
  await new Promise(r => setTimeout(r, 4000));

  const after = await page.eval(`(() => {
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
  ok("report_settings.get_datatable_options() applied", after.probe.getOpts > 0 && after.stdCols === 2, JSON.stringify({g:after.probe.getOpts,std:after.stdCols}));
  ok("report_settings.formatter() drives cell HTML", after.probe.formatter > 0 && after.probeCells > 0, `calls=${after.probe.formatter} cells=${after.probeCells}`);
  ok("after_datatable_render() receives a usable instance", after.probe.afterRender > 0 && after.probe.hasRowmanager && after.probe.hasDatamanager);
  ok("style.setStyle from after_datatable_render paints the cell", after.cellBg === "rgb(0, 128, 0)" && after.cellFw === "700", JSON.stringify({bg:after.cellBg,fw:after.cellFw}));
  ok("cellHeight honoured (36 -> Carbon md 40)", after.rowH >= 32 && after.rowH <= 44, `rowH=${after.rowH}`);

  // getEditor path
  const edit = await page.eval(`(() => {
    const td = document.querySelector('tbody .dt-row .dt-cell[data-col-index="3"]');
    td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return new Promise(res => setTimeout(() => {
      const input = document.querySelector('.probe-editor');
      if (input) { input.value = 'edited-by-probe'; }
      document.querySelector('.datatable').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      setTimeout(() => res({ editorCalls: window.__probe.editor, mounted: !!input, setValueSeen: window.__probe.setValueSeen }), 400);
    }, 400));
  })()`);
  ok("getEditor() called and its input mounted in the cell", edit.editorCalls > 0 && edit.mounted, JSON.stringify(edit));
  ok("editor setValue() receives the new value", edit.setValueSeen === "edited-by-probe", String(edit.setValueSeen));

  // rowmanager.getCheckedRows — the 13-call-site API
  const checks = await page.eval(`(() => {
    const dt = frappe.query_report.datatable;
    dt.rowmanager.checkRow(0, true);
    dt.rowmanager.checkRow(1, true);
    return { checked: dt.rowmanager.getCheckedRows(), items: frappe.query_report.get_checked_items().length };
  })()`);
  ok("rowmanager.getCheckedRows() + QueryReport.get_checked_items()", JSON.stringify(checks.checked) === "[0,1]" && checks.items === 2, JSON.stringify(checks));

  await page.screenshot(SHOT + "/bench-queryreport.png");
  const errs = page.consoleErrors();
  ok("no console errors", errs.length === 0, errs.slice(0,4).join(" | "));
} catch (e) {
  results.push("FAIL  harness: " + e.message);
} finally {
  console.log("\n" + results.join("\n"));
  console.log("\n" + results.filter(r=>r.startsWith("PASS")).length + " passed, " + results.filter(r=>r.startsWith("FAIL")).length + " failed");
  page.close(); proc.kill();
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
