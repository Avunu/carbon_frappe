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
  const form = await page.eval(`(() => {
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
  ok("detail panel gets its own <tr> inside <tbody>", form.addendumInTable && form.colspan > 1, JSON.stringify({ t: form.addendumInTable, c: form.colspan }));
  ok("child row is the parent's immediate sibling (Carbon selectors need it)", form.adjacent && form.childRowMarked, JSON.stringify({ a: form.adjacent, m: form.childRowMarked }));
  ok("child row exists for every row and is not a .grid-row", form.childRowsForEveryRow && form.childNotGridRow, JSON.stringify({ all: form.childRowsForEveryRow, notGridRow: form.childNotGridRow }));
  ok("the form renders inline, not as a modal", form.formInsideAddendum && form.formVisible && form.formInline && form.fieldsRendered > 0, JSON.stringify({ v: form.formVisible, inline: form.formInline, f: form.fieldsRendered }));
  ok("the panel is stuck to the scroll viewport", form.panelStuck && form.panelHolds, JSON.stringify({ sticky: form.panelStuck, holds: form.panelHolds }));
  ok("no freeze backdrop, and the freeze count is balanced", form.frozen === 0 && form.freezeBalanced, JSON.stringify({ frozen: form.frozen, balanced: form.freezeBalanced }));
  ok("Carbon expandable classes and ARIA", form.parentRowClass && form.expandedClass && form.previousValue === 'collapsed' && form.ariaExpanded === 'true' && form.ariaControls, JSON.stringify({ p: form.parentRowClass, e: form.expandedClass, pv: form.previousValue, a: form.ariaExpanded, c: form.ariaControls }));
  ok("frappe's open-row bookkeeping still holds", form.openGridRow && form.dataRowVisible && form.markedOpen && form.findable && form.curGrid, JSON.stringify(form));

  await page.screenshot(SHOT + "/bench-grid-expanded.png");

  // Opening a second row collapses the first: frappe's toggle_view() is an
  // accordion and `cur_frm.cur_grid` / `grid.open_grid_row` are single slots.
  const accordion = await page.eval(`(() => {
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
  ok("one row at a time", accordion.firstClosed && accordion.secondOpen && accordion.onlyOne && accordion.curGrid, JSON.stringify(accordion));

  const closed = await page.eval(`(() => {
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
  ok("closing collapses the panel and leaves no backdrop behind", closed.collapsed && closed.expandedClassGone && closed.previousValueGone && closed.rowBack && closed.frozen === 0 && closed.freezeBalanced, JSON.stringify(closed));

  // The "Open in dialog" escape hatch, and the freeze count around it. Opening
  // another row while a modal row is open closes the modal one through
  // `toggle_view(false)` — a path that knows nothing about the mode, and that
  // used to leave the backdrop stranded over the whole desk.
  const modal = await page.eval(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const rows = grid.grid_rows.filter(Boolean);
    rows[0].toggle_view(true, null, { modal: true });
    return new Promise((res) => setTimeout(() => {
      const formEl = rows[0].grid_form.wrapper[0];
      const opened = {
        modalClass: grid.wrapper.hasClass('cf-grid--modal-form'),
        fixed: getComputedStyle(formEl).position === 'fixed',
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
  ok("Open in dialog restores the centered modal", modal.modalClass && modal.fixed && modal.frozen === 1, JSON.stringify(modal));
  ok("switching rows lifts the modal backdrop instead of stranding it", modal.afterFrozen === 0 && modal.afterCount === 0 && modal.modalClassGone && modal.secondInline, JSON.stringify(modal));
  await page.eval(`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[1].toggle_view(false); return true; })()`);

  // The expand chevron itself, not just the API behind it.
  const chevron = await page.eval(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    row.expand_button.click();
    return new Promise((res) => setTimeout(() => res({
      opened: row.wrapper.hasClass('grid-row-open'),
      aria: row.expand_button.getAttribute('aria-expanded'),
    }), 900));
  })()`);
  ok("the chevron opens the panel", chevron.opened && chevron.aria === 'true', JSON.stringify(chevron));
  await page.eval(`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[0].toggle_view(false); return true; })()`);

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
  const headerPaint = await page.eval(`(() => {
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
    JSON.stringify(headerPaint)
  );

  const panelBox = await page.eval(`(() => {
    const grid = cur_frm.fields_dict.items.grid;
    const row = grid.grid_rows.filter(Boolean)[0];
    row.toggle_view(true);
    return new Promise((res) => setTimeout(() => {
      const r = row.form_row.getBoundingClientRect();
      res({ x: Math.round(r.left + 200), y: Math.round(r.top + 40) });
    }, 900));
  })()`);
  await page.hover(panelBox.x, panelBox.y);
  const rowPaint = await page.eval(`(() => {
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
    JSON.stringify(rowPaint)
  );
  await page.eval(`(() => { cur_frm.fields_dict.items.grid.grid_rows.filter(Boolean)[0].toggle_view(false); return true; })()`);

  // --- the Carbon toolbar --------------------------------------------------
  // Everything here MOVED from `.grid-footer`; nothing was rebuilt. The point
  // of the assertions is that the nodes are the same ones frappe wired its
  // data-action handlers and cached handles onto.
  const toolbar = await page.eval(`(() => {
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
  ok("the Carbon toolbar exists with the batch bar before the content", toolbar.hasToolbar && toolbar.batchBeforeContent, JSON.stringify(toolbar));
  ok("Add row moved into the toolbar (same node, handlers intact)", toolbar.addRowInToolbar && toolbar.addRowIsSameNode);
  ok("Delete moved into the batch action list", toolbar.deleteInBatch);
  ok("Configure Columns gear moved into the toolbar", toolbar.gearInToolbar);
  ok("the filter-row toggle is present", toolbar.searchToggle);
  ok("pagination sits below the table, footer is hidden", toolbar.paginationInFooter && toolbar.footerHidden, JSON.stringify({ p: toolbar.paginationInFooter, f: toolbar.footerHidden }));

  const batch = await page.eval(`(() => {
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
  ok("selecting a row raises the batch bar with a count", batch.active && /1/.test(batch.label), JSON.stringify({ a: batch.active, l: batch.label }));
  ok("Cancel clears the selection, lowers the bar and restores Add row", batch.selected === 0 && !batch.clearedActive && batch.clearedHidden === 'true' && batch.addRowBack, JSON.stringify(batch));

  // The magnifier reveals frappe's per-column filter row at ANY row count —
  // upstream it only appears past `rows_threshold_for_grid_search` (20).
  const search = await page.eval(`(() => {
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
  ok("the magnifier reveals the filter row below the 20-row threshold", search.rows < 20 && search.before === 0 && search.after === 1 && search.inputs > 0, JSON.stringify(search));

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
