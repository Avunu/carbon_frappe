import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.mjs";
const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results = [];
const ok = (n, c, x = "") => results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
try {
  await login(page, BASE);
  await page.goto(`${BASE}/app/sales-order/new`);
  await page.waitFor(`!!window.cur_frm && !!cur_frm.fields_dict && !!cur_frm.fields_dict.items`, { timeout: 90000 });
  // Guard: a stolen assets.json key means we would be measuring stock frappe.
  await assertCarbonStylesheet(page);
  await new Promise(r => setTimeout(r, 2500));

  const setup = await page.eval(`(() => {
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

  const dom = await page.eval(`(() => {
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
  ok("<tr class=grid-row data-name data-idx>", dom.trGridRow === setup.dataLen && dom.dataName === dom.trGridRow && dom.dataIdx === dom.trGridRow, JSON.stringify({r:dom.trGridRow,n:dom.dataName,i:dom.dataIdx,expect:setup.dataLen}));
  ok(".grid-static-col keeps data-fieldname/-fieldtype", dom.staticCol > 0 && dom.fieldtypeAttr > 0, `${dom.staticCol}/${dom.fieldtypeAttr}`);
  ok(".static-area / .field-area preserved", dom.staticArea > 0 && dom.fieldArea > 0, `${dom.staticArea}/${dom.fieldArea}`);
  ok("row checkboxes + sortable handles", dom.rowCheck > 0 && dom.sortableHandle > 0);
  ok("tbody carries .rows (Sortable target)", dom.rowsTbody === 1);
  ok(".grid-heading-row and .grid-empty present", dom.headingRow === 1 && dom.gridEmpty === 1);
  ok("no .column-limit-reached", dom.limitReached === 0);

  // >10 columns — the headline capability
  const many = await page.eval(`(() => {
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
  ok("more than 10 grid columns render", many.visible > 10, `visible=${many.visible} headers=${many.headers}`);
  ok("widths are px, not bootstrap spans", many.widths.every(w => w >= 60), JSON.stringify(many.widths));
  ok("still no .column-limit-reached past 10 columns", many.limitReached === 0);
  ok("horizontal scroll instead of the overflow hack", many.scrollW > many.clientW, `${many.scrollW}>${many.clientW}`);
  ok("every column rendered as a cell", many.cellsInFirstRow === many.headers, `${many.cellsInFirstRow} vs ${many.headers}`);

  // inherited Grid API surface
  const api = await page.eval(`(() => {
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
  ok("grid.get_field / update_docfield_property / toggle_enable", api.get_field && api.update_docfield_property && api.toggle_enable);
  ok("grid_rows_by_docname populated", api.byDocname === setup.dataLen, String(api.byDocname));
  ok("GridRow wrapper is the <tr>, row === wrapper", api.rowWrapperIsTr && api.rowIsWrapper);
  ok("columns_list / get_visible_columns intact", api.columnsList && api.getVisibleColumns);
  ok("in-place editing mounts real frappe controls", api.editableClass && api.controlsMounted);

  // add_new_row through the inherited path
  const added = await page.eval(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    grid.add_new_row();
    return new Promise(res => setTimeout(() => res({
      data: grid.data.length,
      trs: grid.wrapper.find('tbody tr.grid-row').length,
    }), 900));
  })()`);
  ok("grid.add_new_row() renders a new <tr>", added.data === setup.dataLen + 1 && added.trs === added.data, JSON.stringify(added));

  // --- click-to-edit anywhere in a cell -----------------------------------
  // The clickable element is the `.grid-static-col` frappe built, nested inside
  // the engine's <td>. Any padding left on the <td> is dead space where a click
  // silently does nothing, which is what "only certain row clicks work" meant.
  const clickEdit = await page.eval(`(() => {
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
  ok("<td> has no dead padding around the clickable cell", clickEdit.tdPadding === "0px", clickEdit.tdPadding);
  ok(
    "a click anywhere in a cell enters edit mode",
    clickEdit.hits.every((h) => h.insideCol && h.editable),
    JSON.stringify(clickEdit.hits)
  );

  // --- header/body column alignment ---------------------------------------
  const align = await page.eval(`(() => {
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
  ok("every header cell aligns with its body cell", align.mismatched.length === 0, JSON.stringify(align.mismatched));

  // --- the detail form ----------------------------------------------------
  // GridRowForm appends its wrapper to row.wrapper, which here is a <tr>, and
  // show_form() then hides that row — so the form went down with it and the
  // user got the freeze backdrop and nothing else. It now lives in a
  // zero-height host row that carries .grid-row-open, which is the selector
  // that turns .form-in-grid from height:0 into frappe's centered modal.
  const form = await page.eval(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    window.__formRow = row;
    row.toggle_view();
    return new Promise((res) => setTimeout(() => {
      const host = row.form_row;
      const formEl = row.grid_form && row.grid_form.wrapper[0];
      res({
        addendumInTable: !!(host && host.parentElement && host.parentElement.tagName === 'TBODY'),
        hostCollapsed: !!(host && host.getBoundingClientRect().height < 2),
        hostOpenClass: !!(host && host.classList.contains('grid-row-open')),
        colspan: host && host.firstElementChild.getAttribute('colspan'),
        formInsideAddendum: !!(formEl && host && host.contains(formEl)),
        formVisible: !!(formEl && formEl.getBoundingClientRect().height > 200),
        formFixed: !!(formEl && getComputedStyle(formEl).position === 'fixed'),
        frozen: document.querySelectorAll('#freeze').length,
        fieldsRendered: row.grid_form && Object.keys(row.grid_form.fields_dict || {}).length,
        openGridRow: grid.open_grid_row === row.grid_form,
        dataRowHidden: row.wrapper.css('display') === 'none',
        markedOpen: row.wrapper.hasClass('grid-row-open'),
        findable: $('.grid-row-open').data('grid_row') === row,
        curGrid: window.cur_frm.cur_grid === row,
      });
    }, 1200));
  })()`);
  console.log(JSON.stringify(form, null, 2));
  ok("detail form gets its own <tr> inside <tbody>", form.addendumInTable && form.colspan > 1, JSON.stringify({ t: form.addendumInTable, c: form.colspan }));
  ok("host row is collapsed and carries .grid-row-open", form.hostCollapsed && form.hostOpenClass, JSON.stringify({ h: form.hostCollapsed, o: form.hostOpenClass }));
  ok("the form renders as frappe's centered modal", form.formInsideAddendum && form.formVisible && form.formFixed && form.fieldsRendered > 0, JSON.stringify({ v: form.formVisible, p: form.formFixed, f: form.fieldsRendered }));
  ok("the freeze backdrop is up behind it", form.frozen > 0, String(form.frozen));
  ok("frappe's open-row bookkeeping still holds", form.openGridRow && form.dataRowHidden && form.markedOpen && form.findable && form.curGrid, JSON.stringify(form));

  const closed = await page.eval(`(() => {
    const row = window.__formRow;
    row.toggle_view();
    return new Promise((res) => setTimeout(() => res({
      addendumHidden: row.form_row.style.display === 'none',
      rowBack: row.wrapper.css('display') !== 'none',
      frozen: document.querySelectorAll('#freeze').length,
    }), 800));
  })()`);
  ok("closing the form restores the row and lifts the overlay", closed.addendumHidden && closed.rowBack && closed.frozen === 0, JSON.stringify(closed));

  await page.screenshot(SHOT + "/bench-grid.png");
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
