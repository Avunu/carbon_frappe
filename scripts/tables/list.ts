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
	/** Diagnostic only. esbuild lowers the class, so this is NOT `"CarbonDataTable"`. */
	ctor: string;
	/** The identity test: our class, carrying a real engine. */
	isCarbon: boolean;
	rows: number;
	view: string;
}
/** `prune` — what survives a filter change in the selection, the overlay and the bulk-action reads. */
interface PruneProbe {
	/** rows in view before the second filter, all ticked */
	selected: number;
	/** rows in view after it */
	remaining: number;
	size: number;
	items: string[];
	names: string[];
	meta: string;
	checks: number;
	selectAll: boolean;
	/** after a filter that matches none of the selection */
	emptied: { size: number; items: number; overlayHidden: boolean; headShown: boolean };
	/** after the filters are cleared, with the narrowed selection still in place */
	cleared: { size: number; inView: boolean };
}

/** One column as `widths` saw it. */
interface WidthColumn {
	id: string;
	type: string;
	df: string | null;
	saved: number;
	size: number | null;
}

/** `widths` — column sizing after a re-render. */
interface WidthsProbe {
	sentinel: number | undefined;
	cols: WidthColumn[];
	recorded: Record<string, number>;
}

/** `resize` — what `onColumnResize` does to a list view. */
interface ResizeProbe {
	key: string;
	saved: Array<[string, number]>;
	recorded: number | undefined;
	dfWidth: number | string | undefined;
	size: number | null;
	tagCalls: number;
}

/** `drag` — a real header drag. */
interface DragProbe {
	saved: Array<[string, number]>;
	before: number;
	after: number | null;
}

/** `virtual` — a 2500-row page through the engine's window. */
interface VirtualProbe {
	enabled: boolean;
	domRows: number;
	scrollHeight: number;
	firstTicked: boolean;
	farFirst: string;
	farTicked: number;
	size: number;
	backFirstTicked: boolean;
	backFarTicked: boolean;
}

/** `removal` — a document a realtime update removed, and whether a later render brings it back. */
interface RemovalProbe {
	inDom: boolean;
	rows: number;
	data: number;
}

/** `paging` — frappe's page-size switcher and Load More. */
interface PagingProbe {
	tabs: boolean;
	pills: string[];
	active: string | null;
	more: boolean;
	oldGroup: boolean;
	height: number;
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
	// `/app/todo` honours the saved `last_view` user setting, and this suite ends
	// on the report view — so the NEXT run would be redirected there and wait
	// forever for view_name === 'List'. Ask for the list view explicitly.
	await page.goto(`${BASE}/app/todo/view/list`);
	await page.waitFor(`!!window.cur_list && cur_list.view_name === 'List'`, { timeout: 90000 });
	// Guard: a stolen assets.json key means we would be measuring stock frappe.
	await assertCarbonStylesheet(page);
	await new Promise((r) => setTimeout(r, 2500));

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
	// Reload rather than `cur_list.refresh()`: a list that rendered its empty
	// state does not reliably repopulate in place, and a cold bench (CI's,
	// freshly provisioned) takes well over the old fixed 2.5s anyway.
	await page.goto(`${BASE}/app/todo/view/list`);
	await page.waitFor(`!!window.cur_list && cur_list.view_name === 'List'`, { timeout: 90000 });
	await page.waitFor(
		`cur_list.data.length >= 3 && cur_list.$result.find('tbody tr.list-row-container').length >= 3`,
		{ timeout: 60000 },
	);
	await new Promise((r) => setTimeout(r, 500));

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
	ok(
		"one <tr class=list-row-container> per doc",
		info.rows === info.dataLen && info.rows > 0,
		`${info.rows}/${info.dataLen}`,
	);
	ok("get_column_html reused (.list-row-col emitted)", info.listRowCol > 0, String(info.listRowCol));
	ok(
		"subject column + row checkboxes",
		info.subject > 0 && info.checkboxes === info.rows,
		`${info.subject}/${info.checkboxes}`,
	);
	ok("select-all lives under .list-header-subject", info.selectAll === 1);
	ok("bulk-action overlay present", info.checkboxActions === 1);
	ok("[data-sort-by] header handles preserved", info.sortBy > 0, String(info.sortBy));
	ok("filterable cells preserved", info.filterable > 0, String(info.filterable));
	ok(
		"meta rail (assignments/comments/like) rendered",
		info.metaCol === info.rows,
		`${info.metaCol}/${info.rows}`,
	);
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
		JSON.stringify(rerender),
	);
	ok(
		"sort handles and select-all survive too",
		rerender.sortHandles > 0 && rerender.selectAll === 1,
		JSON.stringify(rerender),
	);
	ok(
		"body rows are not duplicated by re-render",
		rerender.bodyRows === cur_data_len,
		String(rerender.bodyRows),
	);

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
	ok(
		"header and body cells share column geometry",
		align.cellMismatch.length === 0,
		JSON.stringify(align.cellMismatch),
	);
	ok(
		"header content lines up with body content",
		align.contentMismatch.length === 0,
		JSON.stringify(align.contentMismatch),
	);
	ok("no header cell stacks its contents", align.stacked.length === 0, JSON.stringify(align.stacked));
	ok("subject header is frappe's .list-subject.level flex box", align.subjectIsFlex);
	ok("meta rail header is right-aligned", align.metaIsRight);
	ok(
		"meta rail fills its column rather than a fixed 130px",
		align.metaFillsCell,
		JSON.stringify(align.metaTrailing),
	);
	ok(
		"meta rail trailing control aligns with the rows",
		align.metaTrailing && Math.abs(Number(align.metaTrailing.th) - Number(align.metaTrailing.td)) <= 1,
		JSON.stringify(align.metaTrailing),
	);
	ok("no stray .list-row-container left in $result", align.strayRows === 0, String(align.strayRows));
	ok(
		"bulk-action host takes no space while unselected",
		align.overlayHeight === 0 && align.headHeight === 0,
		JSON.stringify({ o: align.overlayHeight, h: align.headHeight }),
	);

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
		JSON.stringify({ rowBg: hover.rowBg, pinned: pinnedCells.map((c) => [c.id, c.bg]) }),
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
	ok(
		"checking a row updates get_checked_items()",
		checked.checks === 1 && checked.items.length === 1,
		JSON.stringify(checked.items),
	);
	ok(
		"batch-actions overlay replaces the header",
		checked.overlayShown && checked.theadHidden,
		JSON.stringify({ o: checked.overlayShown, t: checked.theadHidden }),
	);
	ok("'N items selected' rendered", /1/.test(checked.meta), checked.meta);

	await page.eval(`cur_list.clear_checked_items()`);
	await new Promise((r) => setTimeout(r, 400));
	await page.screenshot(SHOT + "/bench-list.png");

	// --- the selection follows the data -------------------------------------
	// Since v16.50 the selection is the `checked_docnames` Set, not the DOM, and
	// `render_list()` is what keeps it honest (list_view.js:1031
	// `prune_checked_docnames`). The adapter replaces `render_list`, so it has to do
	// that itself: left alone, a filter change leaves names in the Set that are no
	// longer in the list, "N items selected" counts them, and
	// `get_checked_items(true)` — which bulk delete, export and every other bulk
	// action read — returns documents the user cannot see.
	// Each step is its own evaluation: one `Runtime.evaluate` is cut off at 60s by
	// the driver, and a cold bench can spend most of that on the three refreshes.
	const inDom = `cur_list.$result.find('tbody tr.list-row-container').length`;
	const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 700));
	// `filter_area.add` takes an ARRAY of filters; a bare tuple is read as the
	// variadic form and wrapped a second time, which silently applies nothing.
	const addFilter = (field: string, value: string): Promise<unknown> =>
		page.eval(`cur_list.filter_area.add([['ToDo', '${field}', '=', '${value}']])`);
	// an earlier, killed run may have left its filters in the user settings
	await page.eval(
		`(async () => { if (cur_list.filter_area.get().length) await cur_list.filter_area.clear(); return true; })()`,
	);
	await page.waitFor(`cur_list.data.length >= 3 && ${inDom} === cur_list.data.length`, { timeout: 30000 });
	await settle();

	// two Closed and two Open rows, ticked through the boxes a user clicks
	const picked = await page.eval<string[]>(`(() => {
    const l = cur_list;
    const pick = (status, n) => l.data.filter((d) => d.status === status).slice(0, n).map((d) => d.name);
    const names = pick('Closed', 2).concat(pick('Open', 2));
    for (const name of names) {
      l.$result.find('.list-row-checkbox').filter((_i, el) => l.get_checkbox_docname($(el)) === name)[0].click();
    }
    return names;
  })()`);
	await settle();

	await addFilter("status", "Closed");
	await page.waitFor(
		`cur_list.data.length > 0 && cur_list.data.every((d) => d.status === 'Closed') && ${inDom} === cur_list.data.length`,
		{ timeout: 30000 },
	);
	await settle();
	const narrowed = await page.eval<Omit<PruneProbe, "emptied" | "cleared">>(`(() => {
    const l = cur_list;
    return {
      selected: ${picked.length},
      remaining: l.data.length,
      size: l.checked_docnames.size,
      items: l.get_checked_items(true).slice().sort(),
      names: ${JSON.stringify(picked)}.filter((n) => l.data.some((d) => d.name === n)).sort(),
      meta: l.$result.find('.list-header-meta').text(),
      checks: l.$checks ? l.$checks.length : -1,
      selectAll: !!l.$result.find('.checkbox-actions .list-check-all').prop('checked'),
    };
  })()`);

	// clearing the filters keeps what is still in the list
	await page.eval(`cur_list.filter_area.clear()`);
	await page.waitFor(
		`cur_list.filter_area.get().length === 0 && cur_list.data.length > ${narrowed.remaining}`,
		{
			timeout: 30000,
		},
	);
	await settle();
	const cleared = await page.eval<PruneProbe["cleared"]>(`(() => {
    const l = cur_list;
    return { size: l.checked_docnames.size, inView: l.get_checked_items(true).every((n) => l.data.some((d) => d.name === n)) };
  })()`);

	// a filter that matches none of the selection empties it, overlay included
	await addFilter("owner", "zzz-nobody@example.com");
	await page.waitFor(`cur_list.data.length === 0`, { timeout: 30000 });
	await settle();
	const emptied = await page.eval<PruneProbe["emptied"]>(`(() => {
    const l = cur_list;
    return {
      size: l.checked_docnames.size,
      items: l.get_checked_items(true).length,
      overlayHidden: !!l.$checkbox_actions && l.$checkbox_actions[0].style.display === 'none',
      headShown: !!l.$list_head_subject && l.$list_head_subject[0].style.display !== 'none',
    };
  })()`);
	await page.eval(
		`(async () => { await cur_list.filter_area.clear(); cur_list.clear_checked_items(); return true; })()`,
	);
	await page.waitFor(`cur_list.data.length >= 3 && ${inDom} === cur_list.data.length`, { timeout: 30000 });
	const prune: PruneProbe = { ...narrowed, emptied, cleared };
	console.log(JSON.stringify(prune));
	ok(
		"a filter change prunes the selection to the rows still in view",
		prune.size > 0 &&
			prune.size < prune.selected &&
			prune.size === prune.names.length &&
			JSON.stringify(prune.items) === JSON.stringify(prune.names),
		JSON.stringify({ selected: prune.selected, remaining: prune.remaining, size: prune.size }),
	);
	ok(
		"'N items selected' counts the pruned selection",
		prune.meta.trim() === `${prune.size} items selected` && prune.checks === prune.size,
		JSON.stringify({ meta: prune.meta, checks: prune.checks }),
	);
	ok(
		"select-all is only ticked when the selection covers every row in view",
		prune.selectAll === (prune.size === prune.remaining),
		JSON.stringify({ selectAll: prune.selectAll, size: prune.size, remaining: prune.remaining }),
	);
	ok(
		"a filter that matches none of the selection empties it and resets the header",
		prune.emptied.size === 0 &&
			prune.emptied.items === 0 &&
			prune.emptied.overlayHidden &&
			prune.emptied.headShown,
		JSON.stringify(prune.emptied),
	);
	ok(
		"clearing the filters keeps the pruned selection, every name of it still in the list",
		prune.cleared.inView && prune.cleared.size === prune.size,
		JSON.stringify(prune.cleared),
	);

	// --- column widths ------------------------------------------------------
	// v16.50 sizes a column only when somebody chose a width; the text-length
	// estimator that used to fill `column_max_widths` is gone, so a <table> needs
	// its own. Before it, every unsized column fell back to a flat 160px (Subject
	// 280) and the table scrolled sideways on a list that fits.
	const widths = await page.eval<WidthsProbe>(`(() => {
    const l = cur_list;
    l.column_max_widths.__cf_sentinel = 7;
    l.render_list();
    const t = l.carbon_table;
    const cols = l.columns.map((c, i) => {
      const id = c.df && c.df.fieldname ? c.type + ':' + c.df.fieldname : c.type + ':' + i;
      return { id, type: c.type, df: c.df ? c.df.fieldname : null, saved: cint(c.df && c.df.width), size: t.getColumnSize(id) };
    });
    return { sentinel: l.column_max_widths.__cf_sentinel, cols, recorded: Object.assign({}, l.column_max_widths) };
  })()`);
	console.log(JSON.stringify(widths));
	ok("render_list no longer wipes column_max_widths", widths.sentinel === 7, String(widths.sentinel));
	const sized = widths.cols.filter((c) => c.type !== "Tag" && c.size !== null);
	ok(
		"a saved width (df.width) is honoured, within frappe's 50..400",
		sized.filter((c) => c.saved > 0).every((c) => c.size === Math.min(400, Math.max(50, c.saved))),
		JSON.stringify(sized.filter((c) => c.saved > 0)),
	);
	const unsized = sized.filter((c) => c.saved === 0 && c.type === "Field").map((c) => Number(c.size));
	ok(
		"unsized columns are sized from their content, not a flat 160",
		unsized.length > 1 && Math.min(...unsized) < 150 && new Set(unsized).size > 1,
		JSON.stringify(unsized),
	);
	ok(
		"column_max_widths carries the real width of every sized column (what a saved layout reads)",
		sized.every((c) => {
			const key = c.type === "Status" ? "status_field" : c.df;
			return !!key && widths.recorded[key] === c.size;
		}),
		JSON.stringify(widths.recorded),
	);

	// --- a header drag is persisted ----------------------------------------
	// frappe's own handle (`setup_column_resize`) is not in this header; the engine
	// reports the settled width as `onColumnResize` and the adapter hands it to
	// `save_column_width`. `save_column_width` is stubbed so the suite never
	// rewrites the site's List View Settings.
	const resize = await page.eval<ResizeProbe>(`(() => {
    const l = cur_list;
    window.__saved = [];
    l.save_column_width = (f, w) => { window.__saved.push([f, w]); };
    const t = l.carbon_table;
    const ci = l.columns.findIndex((c) => c.type === 'Field' && cint(c.df.width) === 0);
    const col = l.columns[ci];
    const id = 'Field:' + col.df.fieldname;
    t.emit('onColumnResize', { columnId: id, width: 222 });
    t.emit('onColumnResize', { columnId: id, width: 9999 });
    t.emit('onColumnResize', { columnId: id, width: 3 });
    const ti = l.columns.findIndex((c) => c.type === 'Tag');
    const before = window.__saved.length;
    t.emit('onColumnResize', { columnId: 'Tag:' + ti, width: 200 });
    t.emit('onColumnResize', { columnId: 'no-such-column', width: 200 });
    const tagCalls = window.__saved.length - before;
    l.render_list();
    return {
      key: col.df.fieldname,
      saved: window.__saved.slice(),
      recorded: l.column_max_widths[col.df.fieldname],
      dfWidth: col.df.width,
      size: t.getColumnSize(id),
      tagCalls,
    };
  })()`);
	console.log(JSON.stringify(resize));
	ok(
		"onColumnResize persists through save_column_width, clamped to 50..400",
		JSON.stringify(resize.saved) ===
			JSON.stringify([
				[resize.key, 222],
				[resize.key, 400],
				[resize.key, 50],
			]),
		JSON.stringify(resize.saved),
	);
	ok(
		"the saved width survives the next render (column_max_widths, df.width and the engine agree)",
		resize.recorded === 50 && Number(resize.dfWidth) === 50 && resize.size === 50,
		JSON.stringify({ recorded: resize.recorded, df: resize.dfWidth, size: resize.size }),
	);
	ok("a Tag column and an unknown column are not persisted", resize.tagCalls === 0, String(resize.tagCalls));

	// the real gesture, end to end: grab the handle and pull it 40px right
	// the width is set first and the handle located AFTER the table has settled:
	// the table stretches over the viewport, so resizing one column moves every
	// handle to its right.
	const dragId = await page.eval<string>(`(() => {
    const l = cur_list;
    const col = l.columns.find((c) => c.type === 'Field' && cint(c.df.width) === 0);
    const id = 'Field:' + col.df.fieldname;
    l.carbon_table.setColumnSize(id, 150);
    return id;
  })()`);
	await new Promise((r) => setTimeout(r, 500));
	const handle = await page.eval<PointProbe>(`(() => {
    const th = cur_list.$result.find('thead th[data-col-id="${dragId}"]')[0];
    const r = th.querySelector('.cf-table__resize-handle').getBoundingClientRect();
    window.__saved = [];
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
	await page.drag(handle.x, handle.y, handle.x + 40, handle.y, 8);
	const drag = await page.eval<DragProbe>(`(() => ({
    saved: window.__saved.slice(),
    before: 150,
    after: cur_list.carbon_table.getColumnSize(${JSON.stringify(dragId)}),
  }))()`);
	console.log(JSON.stringify(drag));
	ok(
		"dragging a header handle saves the settled width once",
		drag.saved.length === 1 && drag.saved[0]?.[1] === drag.after && drag.after === 190,
		JSON.stringify(drag),
	);
	await page.eval(`(delete cur_list.save_column_width, cur_list.render_list(), true)`);

	// --- the paging area ----------------------------------------------------
	// 16.50 swapped the btn-group of page sizes for frappe.ui.TabButtons and
	// Load More for an es-button (base_list.js:378-425).
	const paging = await page.eval<PagingProbe>(`(() => {
    const a = cur_list.$paging_area[0];
    const pills = [...a.querySelectorAll('.es-pill')];
    const more = a.querySelector('.btn-more');
    return {
      tabs: !!a.querySelector('.es-tab-buttons'),
      pills: pills.map((b) => b.textContent.trim()),
      active: (pills.find((b) => b.dataset.state === 'active') || { textContent: null }).textContent,
      more: !!more && more.classList.contains('es-button'),
      oldGroup: !!a.querySelector('.btn-group, .btn-paging'),
      height: Math.round(pills[0].getBoundingClientRect().height),
    };
  })()`);
	console.log(JSON.stringify(paging));
	ok(
		"the page-size switcher is frappe's TabButtons with Load More an es-button",
		paging.tabs &&
			JSON.stringify(paging.pills) === JSON.stringify(["20", "100", "500", "2500"]) &&
			paging.active === "20" &&
			paging.more &&
			!paging.oldGroup,
		JSON.stringify(paging),
	);
	ok(
		"the page-size pills are Carbon content-switcher height (32px)",
		paging.height === 32,
		String(paging.height),
	);

	// every size in the switcher renders, including 2500 — the one that makes
	// frappe preload its virtualization bundle for rows the engine windows itself
	for (const size of ["100", "2500", "20"]) {
		await page.eval(`(() => {
      [...cur_list.$paging_area[0].querySelectorAll('.es-pill')].find((b) => b.textContent.trim() === '${size}').click();
      return true;
    })()`);
		// the click sets `selected_page_count` at once and refreshes after a fetch,
		// so the count alone says nothing about whether the new page has rendered
		await new Promise((r) => setTimeout(r, 2500));
		const page_state = await page.eval<{ size: number; data: number; rows: number }>(`(() => ({
      size: cur_list.selected_page_count,
      data: cur_list.data.length,
      rows: cur_list.$result.find('tbody tr.list-row-container').length,
    }))()`);
		ok(
			`page size ${size} renders every row it loaded`,
			page_state.size === Number(size) && page_state.data > 0 && page_state.rows === page_state.data,
			JSON.stringify(page_state),
		);
	}

	// --- 2000+ rows: the engine's window, with the selection intact ----------
	// frappe virtualizes at `virtualization_threshold` through its own flex-row
	// windowing (list_view_virtualization.js). The adapter hands the same threshold
	// to the engine, whose spacer rows keep the table valid; recycled <tr>s come
	// back with fresh, unticked checkboxes, so the Set has to be repainted.
	const virt = await page.eval<VirtualProbe>(`(async () => {
    const l = cur_list;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const keep = l.data;
    l.data = Array.from({ length: 2500 }, (_, i) => ({
      name: 'cfv' + i, doctype: 'ToDo', description: 'CF virtual row ' + i, status: 'Open',
      priority: 'Medium', date: '2026-01-01', docstatus: 0, owner: 'Administrator',
      modified: '2026-01-01 00:00:00', creation: '2026-01-01 00:00:00', _comment_count: 0,
    }));
    l.render_list();
    await wait(600);
    const t = l.carbon_table;
    const scroller = l.$result.find('.cf-table__scroll')[0];
    const rows = () => [...l.$result.find('tbody tr.list-row-container')];
    const first = () => (rows()[0] ? rows()[0].dataset.name : null);
    const boxOf = (name) => l.$result.find('.list-row-checkbox').filter((_i, el) => l.get_checkbox_docname($(el)) === name)[0];
    l.checked_docnames.add('cfv0');
    l.set_rows_as_checked();
    const res = {
      enabled: t.virtualizer.enabled,
      domRows: rows().length,
      scrollHeight: scroller.scrollHeight,
      firstTicked: !!(boxOf('cfv0') && boxOf('cfv0').checked),
    };
    scroller.scrollTop = 60000;
    await wait(700);
    res.farFirst = first();
    const far = rows()[2];
    const farName = far.dataset.name;
    $(far).find('.list-row-checkbox')[0].click();
    await wait(300);
    res.farTicked = rows().filter((r) => r.querySelector('.list-row-checkbox').checked).length;
    res.size = l.checked_docnames.size;
    scroller.scrollTop = 0;
    await wait(700);
    res.backFirstTicked = !!(boxOf('cfv0') && boxOf('cfv0').checked);
    scroller.scrollTop = 60000;
    await wait(700);
    res.backFarTicked = !!(boxOf(farName) && boxOf(farName).checked);
    l.data = keep;
    l.clear_checked_items();
    l.render_list();
    return res;
  })()`);
	console.log(JSON.stringify(virt));
	ok(
		"2500 rows are windowed: spacer rows over a bounded scroller, not 2500 <tr>s",
		virt.enabled && virt.domRows > 0 && virt.domRows < 150 && virt.scrollHeight > 100000,
		JSON.stringify({ enabled: virt.enabled, domRows: virt.domRows, scrollHeight: virt.scrollHeight }),
	);
	ok(
		"the selection is painted on rows the window brings back",
		virt.firstTicked && virt.backFirstTicked && virt.backFarTicked && virt.farFirst !== "cfv0",
		JSON.stringify({
			first: virt.firstTicked,
			back: virt.backFirstTicked,
			backFar: virt.backFarTicked,
			farFirst: virt.farFirst,
		}),
	);
	ok(
		"off-screen selection stays in checked_docnames while its rows are out of the DOM",
		virt.size === 2 && virt.farTicked === 1,
		JSON.stringify({ size: virt.size, farTicked: virt.farTicked }),
	);

	// --- a realtime removal stays removed ------------------------------------
	// `process_document_refreshes` filters `this.data` and calls
	// `remove_list_items`, which takes the row's `.list-row-container` out of the
	// DOM. That node is the engine's `<tr>`, which the engine still holds, so
	// without the engine being handed the shorter data any later render of its own
	// puts the row back.
	const removal = await page.eval<RemovalProbe>(`(async () => {
    const l = cur_list;
    const gone = l.data[1].name;
    l.data = l.data.filter((d) => d.name !== gone);
    l.remove_list_items([gone]);
    l.carbon_table.render();
    await new Promise((r) => setTimeout(r, 400));
    const trs = [...l.$result.find('tbody tr.list-row-container')];
    return { inDom: trs.some((tr) => tr.dataset.name === gone), rows: trs.length, data: l.data.length };
  })()`);
	ok(
		"a document removed by a realtime update does not come back on the next render",
		!removal.inDom && removal.rows === removal.data,
		JSON.stringify(removal),
	);

	// --- FileView: list mode has no column model -----------------------------
	// `FileView` reaches `ListView.render_list()` (its own `render()` calls
	// `super.render()`) but never runs `setup_columns`, so there is nothing for the
	// engine to build a table from; it renders its own rows through
	// `get_left_html()`. Handing it to the engine threw inside `refresh()` and left
	// the File list blank.
	await page.goto(`${BASE}/app/file/view/list`);
	await page.waitFor(`!!window.cur_list && cur_list.view_name === 'File' && Array.isArray(cur_list.data)`, {
		timeout: 90000,
	});
	await new Promise((r) => setTimeout(r, 1500));
	const file = await page.eval<{
		threw: string | null;
		engine: boolean;
		rows: number;
		data: number;
		grid: boolean;
	}>(`(() => {
    const l = cur_list;
    let threw = null;
    try { l.render_list(); } catch (e) { threw = String(e && e.message || e); }
    return {
      threw,
      engine: !!l.carbon_table,
      rows: l.$result.find('.list-row-container').length,
      data: l.data.length,
      grid: !!frappe.views.FileView.grid_view,
    };
  })()`);
	console.log(JSON.stringify(file));
	ok(
		"the File list (list mode) renders through frappe's own rows, not the engine",
		file.grid || (file.threw === null && !file.engine && file.rows >= file.data),
		JSON.stringify(file),
	);

	// ReportView (a ListView subclass) must be unaffected
	await page.goto(`${BASE}/app/todo/view/report`);
	await page.waitFor(
		`!!window.cur_list && !!cur_list.datatable && document.querySelectorAll('tbody .dt-row').length > 0`,
		{ timeout: 90000 },
	);
	await new Promise((r) => setTimeout(r, 500));
	const rv = await page.eval<ReportViewProbe>(
		`(() => ({ ctor: cur_list.datatable.constructor.name, isCarbon: cur_list.datatable.constructor === window.DataTable && !!cur_list.datatable.engine, rows: document.querySelectorAll('tbody .dt-row').length, view: cur_list.view_name }))()`,
	);
	ok(
		"ReportView subclass still renders its own way",
		rv.isCarbon && rv.view === "Report" && rv.rows > 0,
		JSON.stringify(rv),
	);

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
