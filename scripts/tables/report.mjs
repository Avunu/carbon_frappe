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
  const who = await page.eval(`(async () => (await (await fetch('/api/method/frappe.auth.get_logged_user')).json()).message)()`);
  ok("logged in", who === "Administrator", String(who));

  await page.goto(`${BASE}/app/user/view/report`);
  await page.waitFor(`!!window.cur_list && !!cur_list.datatable`, { timeout: 90000 });
  // Guard: a stolen assets.json key means we would be measuring stock frappe.
  await assertCarbonStylesheet(page);
  await new Promise(r => setTimeout(r, 2500));

  const info = await page.eval(`(() => {
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
  ok("legacy .dt-row/.dt-cell emitted", info.hasDtRow > 0 && info.hasDtCell > 0, `rows=${info.hasDtRow} cells=${info.hasDtCell}`);
  ok("per-cell .dt-cell--{c}-{r} target exists", info.cellIndexClass);
  ok("per-column .dt-cell--col-{c} target exists", info.colClass);
  ok("data-row-index on rows", info.rowIdxAttr);
  ok(".dt-scrollable under scopeClass (ERPNext selector)", info.inScope, info.scopeClass);
  ok("inline filter inputs are .dt-filter", info.dtFilter > 0, `n=${info.dtFilter}`);
  ok("checkbox + serial standard columns present", info.nStd === 2, `std=${info.nStd}`);

  // style.setStyle — the 13-call-site API
  const styled = await page.eval(`(() => {
    const dt = cur_list.datatable;
    dt.style.setStyle('.dt-cell--1-0', { backgroundColor: 'rgb(255, 0, 0)', fontWeight: '700' });
    return new Promise(res => setTimeout(() => {
      const cell = document.querySelector('.dt-cell--1-0');
      const cs = cell && getComputedStyle(cell);
      res({ bg: cs && cs.backgroundColor, fw: cs && cs.fontWeight, found: !!cell });
    }, 300));
  })()`);
  ok("style.setStyle applies to a cell", styled.found && styled.bg === "rgb(255, 0, 0)" && styled.fw === "700", JSON.stringify(styled));

  // rowmanager checked rows
  const checked = await page.eval(`(() => {
    const dt = cur_list.datatable;
    dt.rowmanager.checkRow(0, true);
    dt.rowmanager.checkRow(1, true);
    return { checked: dt.rowmanager.getCheckedRows(), items: cur_list.get_checked_items().length };
  })()`);
  ok("rowmanager.getCheckedRows()", JSON.stringify(checked.checked) === "[0,1]", JSON.stringify(checked));
  ok("ReportView.get_checked_items() sees them", checked.items === 2, `n=${checked.items}`);

  // datamanager surface used by reports
  const dm = await page.eval(`(() => {
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
  ok("datamanager shape (rows/data/cells/viewOrder)", dm.dataIsOriginal && dm.rowsIsArrayOfArrays && dm.cellHasColumn && dm.viewOrderLen > 0, JSON.stringify(dm));

  // Carbon lg rows are 48px; a collapsed row height is the classic symptom of
  // frappe-datatable's stylesheet winning over Carbon's cell padding.
  const rowGeo = await page.eval(`(() => {
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
  const firstFocus = await page.eval(`(() => {
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

  const nav = await page.eval(`(() => {
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
    JSON.stringify({ seen: nav.seen, focusable })
  );

  const edge = await page.eval(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(3, 0);
    dt.navigation.move('right', { toEdge: true });
    const right = { ...dt.navigation.focused };
    dt.navigation.move('down', { toEdge: true });
    const bottom = { ...dt.navigation.focused };
    return { right, bottom, lastCol: dt.columns.length - 1, lastRow: dt.datamanager.rowCount - 1,
             order: dt.datamanager.rowViewOrder };
  })()`);
  ok("ctrl+arrow jumps to the row/column edge",
     edge.right.colIndex === edge.lastCol && edge.bottom.rowIndex === edge.order[edge.order.length - 1],
     JSON.stringify(edge));

  const range = await page.eval(`(() => {
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
  ok("shift+arrow extends a selection rectangle",
     range.bounds && range.bounds.c2 > range.bounds.c1 && range.bounds.p2 > range.bounds.p1,
     JSON.stringify(range.bounds));
  ok("the range is painted and exactly one cell keeps the ring",
     range.highlighted >= 3 && range.focusRings === 1,
     JSON.stringify({ h: range.highlighted, f: range.focusRings, n: range.inRange }));

  const copied = await page.eval(`(() => {
    const dt = cur_list.datatable;
    dt.navigation.focus(3, 0);
    dt.navigation.move('down', { extend: true });
    const n = dt.navigation.copy();
    return { n, cells: dt.cellmanager.getCellsInRange().length };
  })()`);
  ok("ctrl+C copies the selection as TSV", copied.n === copied.cells && copied.n > 1, JSON.stringify(copied));

  const editable = await page.eval(`(() => {
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
    JSON.stringify(editable)
  );
  ok("cellmanager.$editingCell reflects it", editable.compat, JSON.stringify(editable));

  await page.eval(`cur_list.datatable.editing.deactivate(false)`);

  // --- the editor must actually be usable --------------------------------
  // `.dt-cell__edit` is positioned against the cell's PADDING box, so it is
  // already inset by Carbon's 16px; its own padding on top left a 120px column
  // with ~30px of usable width, and frappe's Link control reserves a further
  // 44px for its open-record arrow.
  const editorBox = await page.eval(`(() => {
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
    JSON.stringify(editorBox)
  );

  // --- frozen columns must be opaque -------------------------------------
  const frozen = await page.eval(`(() => {
    const td = document.querySelector('tbody td.cf-table__cell--pinned');
    const th = document.querySelector('thead th.cf-table__cell--pinned');
    const bg = (n) => (n ? getComputedStyle(n).backgroundColor : null);
    return { body: bg(td), head: bg(th) };
  })()`);
  ok(
    "frozen columns are opaque so scrolled cells cannot show through",
    frozen.body && !frozen.body.includes("rgba(0, 0, 0, 0)") &&
      frozen.head && !frozen.head.includes("rgba(0, 0, 0, 0)"),
    JSON.stringify(frozen)
  );

  // --- an open editor owns its own clicks ---------------------------------
  // A Link editor renders awesomplete's option list inside the cell. Treating a
  // click on an option as a grid click stole focus to the scroll container —
  // closing the dropdown before it could commit — AND started a drag, so the
  // pointer travelling to the option swept a rectangle of cells behind it. The
  // user picked a value and got a multi-cell selection instead.
  const editorClick = await page.eval(`(() => {
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
  const lostMouseUp = await page.eval(`(() => {
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
    JSON.stringify(lostMouseUp)
  );
  ok("clicking inside an editor does not move the grid focus", editorClick.focusUnchanged, JSON.stringify(editorClick));
  ok("clicking inside an editor does not close it", editorClick.stillEditing, JSON.stringify(editorClick));
  ok("clicking inside an editor does not steal DOM focus", !editorClick.focusStolen, JSON.stringify(editorClick));
  ok("no stray range is selected behind the dropdown", editorClick.highlighted === 0, JSON.stringify(editorClick));

  // --- sticky stacking order ---------------------------------------------
  // Four levels are in play at once: ordinary body cells, the frozen body
  // column they scroll under, the sticky header, and the frozen header corner.
  // The engine used to write z-index INLINE for pinned cells, which always beat
  // the stylesheet — so the scrolling column headers painted OVER the frozen
  // header instead of sliding beneath it.
  const layering = await page.eval(`(() => {
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
  const zi = (v) => (v === 'auto' || v == null ? 0 : Number(v));
  ok(
    "frozen header sits above the scrolling headers",
    zi(layering.headPinned) > zi(layering.headPlain),
    JSON.stringify(layering)
  );
  ok(
    "sticky header sits above the body, frozen body above plain body",
    zi(layering.headPlain) > zi(layering.bodyPinned) && zi(layering.bodyPinned) > zi(layering.bodyPlain),
    JSON.stringify(layering)
  );
  ok(
    "layering is left to the stylesheet, not written inline",
    layering.inlineOnPinned === "",
    JSON.stringify(layering)
  );

  // --- nothing shows through the frozen columns ---------------------------
  // The real question is not "is the background set" but "is anything of the
  // scrolled column visible inside the frozen region". Hit-test across the
  // whole frozen band, including the seam between the two frozen columns and
  // both outer edges, and require the topmost element at every point to belong
  // to a pinned cell.
  const bleed = await page.eval(`(() => {
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
  ok("the bleed check actually scrolled columns under the frozen ones",
     bleed.skipped || bleed.scrollLeft > 0, JSON.stringify(bleed));
  ok(
    "no scrolled content shows through the frozen columns",
    bleed.skipped || bleed.missCount === 0,
    JSON.stringify(bleed)
  );

  // --- select-all lines up with the column it heads ----------------------
  const cbAlign = await page.eval(`(() => {
    const x = (s) => { const n = document.querySelector(s); return n ? Math.round(n.getBoundingClientRect().x) : null; };
    return {
      head: x('thead [data-col-id$=":_checkbox"] input'),
      body: x('tbody [data-col-id$=":_checkbox"] input'),
    };
  })()`);
  ok(
    "header checkbox aligns with the column's checkboxes",
    cbAlign.head !== null && cbAlign.head === cbAlign.body,
    JSON.stringify(cbAlign)
  );

  // --- drag to select a range --------------------------------------------
  const dragBox = await page.eval(`(() => {
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
    const dragged = await page.eval(`(() => {
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
      JSON.stringify(dragged)
    );
    ok(
      "the drag ends cleanly on mouseup",
      !dragged.stillDragging && dragged.selectingClass === 0,
      JSON.stringify(dragged)
    );
  } else {
    ok("dragging the mouse across cells selects a range", false, "cells not found");
  }

  await page.screenshot(SHOT + "/bench-report.png");
  const errs = page.consoleErrors();
  ok("no console errors", errs.length === 0, errs.slice(0,3).join(" | "));
} catch (e) {
  results.push("FAIL  harness: " + e.message);
} finally {
  console.log("\n" + results.join("\n"));
  console.log("\n" + results.filter(r=>r.startsWith("PASS")).length + " passed, " + results.filter(r=>r.startsWith("FAIL")).length + " failed");
  page.close(); proc.kill();
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
