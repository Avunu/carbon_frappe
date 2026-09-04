import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.ts";

// Every probe below is a source STRING evaluated inside Chromium, so nothing in
// this process types its body. What comes back is `returnByValue` JSON, which
// the driver cannot know the shape of — so each interface here names the object
// one probe assembles in the page, and that name is the whole contract for the
// assertions that read it.

/** `info` — the first render: engine, row markup and the header handles. */
interface InfoProbe {
	hasEngine: boolean;
	rows: number;
	dataLen: number;
	carbonTable: number;
	listRowCol: number;
	subject: number;
	checkboxes: number;
	selectAll: number;
	checkboxActions: number;
	sortBy: number;
	filterable: number;
	metaCol: number;
	/** the tag name behind `$list_head_subject`, or `null` if it has no node */
	headIsThead: string | null;
	headers: number;
	columns: number;
}

/** `rerender` — what survives two back-to-back `render_list()` calls. */
interface RerenderProbe {
	headerRows: number;
	headerCells: number;
	sortHandles: number;
	selectAll: number;
	bodyRows: number;
	headerAttached: boolean;
}

/**
 * The right edge of the meta rail's trailing control, header against body.
 * Either side is `null` when that cell has no visible children to measure.
 */
interface MetaTrailing {
	th: number | null;
	td: number | null;
}

/** `align` — header/body geometry, reported as the column ids that disagreed. */
interface AlignProbe {
	cellMismatch: string[];
	contentMismatch: string[];
	stacked: string[];
	subjectIsFlex: boolean;
	metaIsRight: boolean;
	metaFillsCell: boolean;
	metaTrailing: MetaTrailing | null;
	strayRows: number;
	overlayHeight: number;
	headHeight: number;
}

/** A viewport point handed back for the real pointer to visit. */
interface PointProbe {
	x: number;
	y: number;
}

/** One cell of the hovered row. */
interface HoverCell {
	/** `data-col-id`, absent on a cell the engine did not label */
	id?: string;
	pinned: boolean;
	bg: string;
}

/** `hover` — the row's own fill, and every cell's, while hovered. */
interface HoverProbe {
	rowBg: string;
	cells: HoverCell[];
}

/** `checked` — frappe's bulk-action machinery after a real click. */
interface CheckedProbe {
	checks: number;
	items: string[];
	overlayShown: boolean;
	theadHidden: boolean;
	meta: string;
}

/** `rv` — the ReportView subclass, which must still render its own way. */
interface ReportViewProbe {
	ctor: string;
	rows: number;
	view: string;
}
const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
const ok = (n: string, c: unknown, x = "") => results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
try {
  await login(page, BASE);
  // `/app/todo` honours the saved `last_view` user setting, and this suite ends
  // on the report view — so the NEXT run would be redirected there and wait
  // forever for view_name === 'List'. Ask for the list view explicitly.
  await page.goto(`${BASE}/app/todo/view/list`);
  await page.waitFor(`!!window.cur_list && cur_list.view_name === 'List'`, { timeout: 90000 });
  // Guard: a stolen assets.json key means we would be measuring stock frappe.
  await assertCarbonStylesheet(page);
  await new Promise(r => setTimeout(r, 2500));

  // Seed ToDos so the list is not empty. Use frappe.xcall throughout: a raw
  // fetch to /api/method/frappe.client.get_count needs the CSRF token as a
  // query arg, not a header, and quietly 400s.
  await page.eval(`(async () => {
    const existing = await frappe.xcall('frappe.client.get_list', {
      doctype: 'ToDo', filters: { description: ['like', 'Carbon table check%'] }, limit_page_length: 0,
    });
    for (let i = existing.length; i < 3; i++) {
      await frappe.xcall('frappe.client.insert', {
        doc: {
          doctype: 'ToDo',
          description: 'Carbon table check ' + i,
          status: i === 0 ? 'Open' : 'Closed',
          priority: 'Medium',
        },
      });
    }
    return true;
  })()`);
  await page.eval(`cur_list.refresh()`);
  await new Promise(r => setTimeout(r, 2500));

  const info = await page.eval<InfoProbe>(`(() => {
    const l = cur_list;
    const $r = l.$result;
    return {
      hasEngine: !!l.carbon_table,
      rows: $r.find('tbody tr.list-row-container').length,
      dataLen: l.data.length,
      carbonTable: $r.find('table.cds--data-table').length,
      listRowCol: $r.find('.list-row-col').length,
      subject: $r.find('.list-subject').length,
      checkboxes: $r.find('.list-row-checkbox').length,
      selectAll: $r.find('.list-header-subject .list-check-all').length,
      checkboxActions: $r.find('header .checkbox-actions').length,
      sortBy: $r.find('[data-sort-by]').length,
      filterable: $r.find('.filterable[data-filter]').length,
      metaCol: $r.find('.list-row-activity').length,
      headIsThead: l.$list_head_subject && l.$list_head_subject.get(0) ? l.$list_head_subject.get(0).tagName : null,
      headers: $r.find('thead th').length,
      columns: l.columns.length,
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ok("ListView renders through CarbonTable", info.hasEngine && info.carbonTable === 1);
  ok("one <tr class=list-row-container> per doc", info.rows === info.dataLen && info.rows > 0, `${info.rows}/${info.dataLen}`);
  ok("get_column_html reused (.list-row-col emitted)", info.listRowCol > 0, String(info.listRowCol));
  ok("subject column + row checkboxes", info.subject > 0 && info.checkboxes === info.rows, `${info.subject}/${info.checkboxes}`);
  ok("select-all lives under .list-header-subject", info.selectAll === 1);
  ok("bulk-action overlay present", info.checkboxActions === 1);
  ok("[data-sort-by] header handles preserved", info.sortBy > 0, String(info.sortBy));
  ok("filterable cells preserved", info.filterable > 0, String(info.filterable));
  ok("meta rail (assignments/comments/like) rendered", info.metaCol === info.rows, `${info.metaCol}/${info.rows}`);
  ok("$list_head_subject is the <thead>", info.headIsThead === "THEAD", String(info.headIsThead));
  const cur_data_len = info.dataLen;

  // --- the header must survive a re-render --------------------------------
  // This is where the header used to disappear: the adapter's stale-row sweep
  // matched the engine's own <thead> row (it carries .list-row-container by
  // design), and the engine only appended that row once. The first render
  // looked perfect and every later one had no header at all.
  const rerender = await page.eval<RerenderProbe>(`(() => {
    const l = cur_list;
    l.render_list();
    l.render_list();
    return new Promise((res) => setTimeout(() => {
      const $r = l.$result;
      res({
        headerRows: $r.find('thead tr').length,
        headerCells: $r.find('thead th').length,
        sortHandles: $r.find('thead [data-sort-by]').length,
        selectAll: $r.find('thead .list-check-all').length,
        bodyRows: $r.find('tbody tr.list-row-container').length,
        headerAttached: $r.find('thead tr').parent().is('thead'),
      });
    }, 800));
  })()`);
  console.log(JSON.stringify(rerender));
  ok(
    "header survives repeated render_list()",
    rerender.headerRows === 1 && rerender.headerCells > 0 && rerender.headerAttached,
    JSON.stringify(rerender)
  );
  ok("sort handles and select-all survive too", rerender.sortHandles > 0 && rerender.selectAll === 1, JSON.stringify(rerender));
  ok("body rows are not duplicated by re-render", rerender.bodyRows === cur_data_len, String(rerender.bodyRows));

  // --- header/body alignment ----------------------------------------------
  // The header cells are hand-built here, so they need frappe's own per-column
  // classes: .list-subject.level is the flex box that puts the select-all
  // checkbox beside the ID label, and .level-right right-aligns the meta rail.
  // Without them both stacked vertically and drifted out of line with the rows.
  const align = await page.eval<AlignProbe>(`(() => {
    const $r = cur_list.$result;
    const box = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
    const ids = [...$r.find('thead th')].map((th) => th.dataset.colId);
    const cols = ids.map((id) => {
      const th = $r.find('thead th[data-col-id="' + id + '"]')[0];
      const td = $r.find('tbody td[data-col-id="' + id + '"]')[0];
      if (!th || !td) return null;
      const thc = th.querySelector('.cf-table__cell-content');
      const tdc = td.querySelector('.cf-table__cell-content');
      return { id, cell: [box(th).x, box(th).w, box(td).x, box(td).w],
               thContent: box(thc), tdContent: box(tdc), thCls: thc.className,
               // vertical CENTRES: align-items:center legitimately gives
               // children of different heights a different y, so a raw y
               // comparison flags a correct single-line header as stacked.
               childMids: [...thc.children].map((c) => {
                 const r = c.getBoundingClientRect();
                 return Math.round(r.y + r.height / 2);
               }) };
    }).filter(Boolean);
    const last = cols[cols.length - 1];
    return {
      cellMismatch: cols.filter((c) => c.cell[0] !== c.cell[2] || c.cell[1] !== c.cell[3]).map((c) => c.id),
      contentMismatch: cols.filter((c) => c.thContent.x !== c.tdContent.x).map((c) => c.id),
      // "stacked" means the header cell's own children wrapped onto separate
      // lines. The content box filling the 48px row is correct and expected,
      // so compare the CHILDREN's y positions rather than the box height.
      stacked: cols
        .filter((c) => c.childMids.length > 1 && Math.max(...c.childMids) - Math.min(...c.childMids) > 4)
        .map((c) => c.id),
      subjectIsFlex: !!(cols[0] && cols[0].thCls.includes('list-subject') && cols[0].thCls.split(' ').includes('level')),
      metaIsRight: !!(last && last.thCls.includes('cf-table__meta')),
      metaFillsCell: !!(last && Math.abs(last.thContent.w - (last.cell[1] - 32)) <= 2),
      // the meta rail's trailing control (the like heart) must line up with
      // the hearts in the rows beneath it
      metaTrailing: (() => {
        const thc = $r.find('thead th[data-col-id="_meta"] .cf-table__cell-content')[0];
        const tdc = $r.find('tbody td[data-col-id="_meta"] .cf-table__cell-content')[0];
        if (!thc || !tdc) return null;
        const last = (n) => { const k = [...n.children].filter((c) => c.getBoundingClientRect().width > 0);
          return k.length ? Math.round(k[k.length - 1].getBoundingClientRect().right) : null; };
        return { th: last(thc), td: last(tdc) };
      })(),
      strayRows: $r.find('> .list-row-container').length,
      overlayHeight: Math.round($r.find('.list-carbon-header')[0].getBoundingClientRect().height),
      headHeight: Math.round($r.find('header.list-row-head')[0].getBoundingClientRect().height),
    };
  })()`);
  console.log(JSON.stringify(align));
  ok("header and body cells share column geometry", align.cellMismatch.length === 0, JSON.stringify(align.cellMismatch));
  ok("header content lines up with body content", align.contentMismatch.length === 0, JSON.stringify(align.contentMismatch));
  ok("no header cell stacks its contents", align.stacked.length === 0, JSON.stringify(align.stacked));
  ok("subject header is frappe's .list-subject.level flex box", align.subjectIsFlex);
  ok("meta rail header is right-aligned", align.metaIsRight);
  ok("meta rail fills its column rather than a fixed 130px", align.metaFillsCell, JSON.stringify(align.metaTrailing));
  ok(
    "meta rail trailing control aligns with the rows",
    align.metaTrailing && Math.abs(Number(align.metaTrailing.th) - Number(align.metaTrailing.td)) <= 1,
    JSON.stringify(align.metaTrailing)
  );
  ok("no stray .list-row-container left in $result", align.strayRows === 0, String(align.strayRows));
  ok("bulk-action host takes no space while unselected", align.overlayHeight === 0 && align.headHeight === 0, JSON.stringify({ o: align.overlayHeight, h: align.headHeight }));

  // --- row hover must span the whole row ----------------------------------
  // Pinned cells (the subject column and the meta rail) are opaque so scrolled
  // columns cannot show through them, which also means they cover the hover
  // fill Carbon paints on the <tr>. Left unhandled the highlight stops at the
  // first pinned column and resumes after the last.
  const rowBox = await page.eval<PointProbe>(`(() => {
    const tr = cur_list.$result.find('tbody tr.list-row-container')[0];
    const r = tr.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await page.hover(rowBox.x, rowBox.y);
  const hover = await page.eval<HoverProbe>(`(() => {
    const tr = cur_list.$result.find('tbody tr.list-row-container')[0];
    const cells = [...tr.children].map((td) => ({
      id: td.dataset.colId,
      pinned: td.classList.contains('cf-table__cell--pinned'),
      bg: getComputedStyle(td).backgroundColor,
    }));
    // a transparent cell shows the row fill behind it; that is the reference
    const rowBg = getComputedStyle(tr).backgroundColor;
    return { rowBg, cells };
  })()`);
  console.log(JSON.stringify(hover));
  const pinnedCells = hover.cells.filter((c) => c.pinned);
  ok("the row is actually hovered", hover.rowBg !== "rgba(0, 0, 0, 0)", hover.rowBg);
  ok("there are pinned cells to check", pinnedCells.length > 0, String(pinnedCells.length));
  ok(
    "hover fill spans pinned cells too",
    pinnedCells.every((c) => c.bg === hover.rowBg),
    JSON.stringify({ rowBg: hover.rowBg, pinned: pinnedCells.map((c) => [c.id, c.bg]) })
  );

  // checking a row must drive frappe's own bulk-action machinery
  const checked = await page.eval<CheckedProbe>(`(() => {
    const l = cur_list;
    // a real click toggles the box and fires BOTH click and change, which is
    // what drives on_row_checked; .trigger('click') fires neither.
    l.$result.find('.list-row-checkbox').get(0).click();
    return new Promise(res => setTimeout(() => res({
      checks: (l.$checks || []).length,
      items: l.get_checked_items(true),
      overlayShown: l.$result.find('header .checkbox-actions').is(':visible'),
      theadHidden: !l.$list_head_subject.is(':visible'),
      meta: l.$result.find('.list-header-meta').text(),
    }), 500));
  })()`);
  console.log(JSON.stringify(checked, null, 2));
  ok("checking a row updates get_checked_items()", checked.checks === 1 && checked.items.length === 1, JSON.stringify(checked.items));
  ok("batch-actions overlay replaces the header", checked.overlayShown && checked.theadHidden, JSON.stringify({o:checked.overlayShown,t:checked.theadHidden}));
  ok("'N items selected' rendered", /1/.test(checked.meta), checked.meta);

  await page.eval(`cur_list.clear_checked_items()`);
  await new Promise(r=>setTimeout(r,400));
  await page.screenshot(SHOT + "/bench-list.png");

  // ReportView (a ListView subclass) must be unaffected
  await page.goto(`${BASE}/app/todo/view/report`);
  await page.waitFor(`!!window.cur_list && !!cur_list.datatable`, { timeout: 90000 });
  await new Promise(r=>setTimeout(r,2000));
  const rv = await page.eval<ReportViewProbe>(`(() => ({ ctor: cur_list.datatable.constructor.name, rows: document.querySelectorAll('tbody .dt-row').length, view: cur_list.view_name }))()`);
  ok("ReportView subclass still renders its own way", rv.ctor === "CarbonDataTable" && rv.view === "Report", JSON.stringify(rv));

  const errs = page.consoleErrors();
  ok("no console errors", errs.length === 0, errs.slice(0,4).join(" | "));
} catch (e) {
  results.push("FAIL  harness: " + (e instanceof Error ? e.message : String(e)));
} finally {
  console.log("\n" + results.join("\n"));
  console.log("\n" + results.filter(r=>r.startsWith("PASS")).length + " passed, " + results.filter(r=>r.startsWith("FAIL")).length + " failed");
  page.close(); proc.kill();
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
