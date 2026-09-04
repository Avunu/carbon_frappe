import fs from "node:fs";
import net from "node:net";
import { launch, newPage } from "./cdp.ts";
import { spawn } from "node:child_process";

// `page.eval` is generic and defaults to `unknown` — the wire carries
// `returnByValue` JSON the driver cannot check — so each probe below names the
// shape its own browser-side expression builds.

/** Markup census and geometry, read straight after the first render. */
interface RenderInfo {
  rowsRendered: number;
  totalRows: number;
  headers: number;
  carbonTable: boolean;
  carbonContainer: boolean;
  sortButtons: number;
  colgroupCols: number;
  tableWidth: number;
  scrollWidth: number;
  clientWidth: number;
  /** Absent when there is no trailing spacer row — the optional chain drops it. */
  spacerBottom?: string;
  pinnedStart: number;
  pinnedEnd: number;
  totalRow?: string | null;
  firstCell?: string | null;
}

/** thead vs first body row vs the colgroup, measured in page pixels. */
interface ColumnGeometry {
  aligned: boolean;
  widthsHonoured: boolean;
  stickyHeaderClass: boolean;
  cols: number[];
  actual: number[];
}

/** Sort state after one click on the qty header button. */
interface SortState {
  /** TanStack's `getIsSorted()`: a direction, or `false` when unsorted. */
  dir: "asc" | "desc" | false;
  nonDecreasing: boolean;
  head: number[];
  ariaSort: string | null;
  activeBtn: boolean;
}

/** What frappe's `>40` grammar left in the row model. */
interface FilterState {
  count: number;
  min: number;
  filterRowShown: boolean;
}

/** What frappe's `10:20` range grammar left in the row model. */
interface RangeState {
  count: number;
  min: number;
  max: number;
}

/** Column width either side of a programmatic resize. */
interface ResizeState {
  before: number;
  after: number;
  colWidth: string;
  handles: number;
}

/** Whether a re-render reused the same row and cell nodes. */
interface IdentityState {
  sameRow: boolean;
  /** `null` when the row could not be found again at all. */
  sameCell: boolean | null;
}

/** Selected-row count, and how many rows Carbon marked as selected. */
interface SelectionState {
  selected: number;
  classed: number;
}

/** Cost of swapping in 50k rows. */
interface ScaleState {
  ms: number;
  rendered: number;
  total: number;
}

const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
const APP = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
fs.mkdirSync(SHOT, { recursive: true });
// An ephemeral port, for the same reason the debug port is ephemeral: a fixed
// one makes two overlapping runs fight over the fixture server.
const fixturePort = await new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    // `address()` is `string | AddressInfo | null` because the one method also
    // answers for pipe servers and for one that never bound. A TCP listen on
    // 127.0.0.1 only ever lands in the AddressInfo branch.
    const address = s.address();
    if (address === null || typeof address === "string") {
      s.close(() => reject(new Error(`could not read an ephemeral port (got ${JSON.stringify(address)})`)));
      return;
    }
    const { port } = address;
    s.close(() => resolve(port));
  });
});
const FIXTURE_SERVER = `${APP}/scripts/dev-table.ts`;
const server = spawn("node", [FIXTURE_SERVER, "--serve"], {
  env: { ...process.env, PORT: String(fixturePort) },
  stdio: "inherit",
});
// Wait for the fixture server to actually serve, rather than guessing at a
// sleep. dev-table.ts esbuilds the demo and compiles its SCSS before it
// listens, which on a loaded machine takes well over the 3s this used to
// allow — the page then 404'd and the whole suite failed on a timeout that
// looked like an engine bug.
await (async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${fixturePort}/`);
      if (r.ok) return;
    } catch (e) {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`fixture server never came up on :${fixturePort}`);
})();

const { proc, port } = await launch();
const page = await newPage(port);
// The engine renders on requestAnimationFrame, so every "change state then read
// the DOM" assertion is a race. Fixed sleeps passed on an idle box and failed
// once the machine was loaded; poll for the expected DOM instead.
const settle = (expr: string, timeout = 5000) =>
  page.waitFor(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`, { timeout });

const results: string[] = [];
const ok = (name: string, cond: unknown, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };

try {
  await page.goto(`http://127.0.0.1:${fixturePort}/?rows=500`);
  await page.waitFor(`!!window.demo && !!document.querySelector('.cf-table__row')`);

  const info = await page.eval<RenderInfo>(`(() => {
    const t = window.demo.table;
    const q = (s) => document.querySelectorAll(s).length;
    return {
      rowsRendered: q('.cf-table__body .cf-table__row'),
      totalRows: t.table.getRowModel().rows.length,
      headers: q('.cf-table__head .cf-table__cell--header'),
      carbonTable: !!document.querySelector('table.cds--data-table'),
      carbonContainer: !!document.querySelector('.cds--data-table-container'),
      sortButtons: q('button.cds--table-sort'),
      colgroupCols: q('colgroup col'),
      tableWidth: document.querySelector('.cf-table__table').getBoundingClientRect().width,
      scrollWidth: document.querySelector('.cf-table__scroll').scrollWidth,
      clientWidth: document.querySelector('.cf-table__scroll').clientWidth,
      spacerBottom: document.querySelector('.cf-table__spacer:last-of-type td')?.style.height,
      pinnedStart: q('.cf-table__cell--pinned-start'),
      pinnedEnd: q('.cf-table__cell--pinned-end'),
      totalRow: document.querySelector('.cf-table__total-row td:nth-child(5) .cf-table__cell-content')?.textContent,
      firstCell: document.querySelector('.cf-table__body .cf-table__row td .cf-table__cell-content')?.textContent,
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));

  ok("Carbon light-DOM markup", info.carbonTable && info.carbonContainer);
  ok("13 columns rendered (>10, the frappe grid cap)", info.headers === 13, `headers=${info.headers}`);
  ok("colgroup drives widths", info.colgroupCols === 13);
  ok("virtualization windows rows", info.rowsRendered > 0 && info.rowsRendered < 100, `rendered=${info.rowsRendered}/${info.totalRows}`);
  ok("horizontal scroll (max-content table)", info.scrollWidth > info.clientWidth, `${info.scrollWidth}>${info.clientWidth}`);
  ok("pinned start + end columns sticky", info.pinnedStart > 0 && info.pinnedEnd > 0);
  ok("totals row computed", info.totalRow && info.totalRow !== "", `qty total=${info.totalRow}`);

  // Regression guard: Carbon's own `--sticky-header` class sets display:block/flex
  // on the table and silently discards <colgroup>, desyncing thead from tbody.
  const geo = await page.eval<ColumnGeometry>(`(() => {
    const head = [...document.querySelector('.cf-table__header-row').children];
    const row = [...document.querySelector('.cf-table__body .cf-table__row').children];
    const cols = [...document.querySelectorAll('colgroup col')].map(c => parseInt(c.style.width));
    const r = (n) => Math.round(n.getBoundingClientRect().width);
    const x = (n) => Math.round(n.getBoundingClientRect().x);
    return {
      aligned: head.every((h, i) => x(h) === x(row[i]) && r(h) === r(row[i])),
      widthsHonoured: row.every((c, i) => r(c) === cols[i]),
      stickyHeaderClass: document.querySelector('.cds--data-table--sticky-header') !== null,
      cols, actual: row.map(r),
    };
  })()`);
  ok("thead and tbody share one column model", geo.aligned, JSON.stringify(geo.actual));
  ok("colgroup px widths are honoured verbatim", geo.widthsHonoured, JSON.stringify(geo.cols));
  ok("Carbon --sticky-header class never applied", !geo.stickyHeaderClass);

  // --- sorting
  await page.eval(`document.querySelectorAll('button.cds--table-sort')[4].click()`);
  await settle(`document.querySelectorAll('.cf-table__cell--header')[4].getAttribute('aria-sort') === 'ascending'`);
  const sorted = await page.eval<SortState>(`(() => {
    const t = window.demo.table;
    return new Promise(res => setTimeout(() => {
      const vals = t.table.getRowModel().rows.map(r => r.getValue('qty'));
      const nonDecreasing = vals.every((v, i) => i === 0 || v >= vals[i - 1]);
      res({ dir: t.table.getColumn('qty').getIsSorted(), nonDecreasing, head: vals.slice(0, 3),
            ariaSort: document.querySelectorAll('.cf-table__cell--header')[4].getAttribute('aria-sort'),
            activeBtn: !!document.querySelector('button.cds--table-sort--active') });
    }, 300));
  })()`);
  ok("first click sorts ASC (frappe-datatable parity)", sorted.dir === "asc" && sorted.nonDecreasing, JSON.stringify(sorted));
  ok("aria-sort + cds--table-sort--active applied", sorted.ariaSort === "ascending" && sorted.activeBtn);

  // --- frappe filter grammar through the UI
  const filtered = await page.eval<FilterState>(`(() => {
    const t = window.demo.table;
    t.toggleFilters(true);
    return new Promise(res => setTimeout(() => {
      const input = document.querySelector('.cf-table__filter-row input[data-col-id="qty"]');
      input.value = '>40';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const rows = t.table.getRowModel().rows;
        res({ count: rows.length, min: Math.min(...rows.map(r => r.getValue('qty'))),
              filterRowShown: !document.querySelector('.cf-table__filter-row').hidden });
      }, 600);
    }, 200));
  })()`);
  ok("inline filter row renders", filtered.filterRowShown);
  ok("frappe '>40' grammar filters", filtered.count > 0 && filtered.min > 40, JSON.stringify(filtered));

  const ranged = await page.eval<RangeState>(`(() => {
    const t = window.demo.table;
    const input = document.querySelector('.cf-table__filter-row input[data-col-id="qty"]');
    input.value = '10:20';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise(res => setTimeout(() => {
      const rows = t.table.getRowModel().rows;
      res({ count: rows.length, min: Math.min(...rows.map(r=>r.getValue('qty'))), max: Math.max(...rows.map(r=>r.getValue('qty'))) });
    }, 600));
  })()`);
  ok("frappe '10:20' range grammar", ranged.count > 0 && ranged.min >= 10 && ranged.max <= 20, JSON.stringify(ranged));

  // --- resize
  await page.eval(`(window.demo.table.setColumnSize('first', 320), true)`);
  await settle(`document.querySelectorAll('colgroup col')[1].style.width === '320px'`);
  const resized = await page.eval<ResizeState>(`(() => {
    const t = window.demo.table;
    const before = 140;
    return new Promise(res => setTimeout(() => {
      const col = document.querySelectorAll('colgroup col')[1];
      res({ before, after: t.getColumnSize('first'), colWidth: col.style.width,
            handles: document.querySelectorAll('.cf-table__resize-handle').length });
    }, 300));
  })()`);
  ok("column resize writes colgroup width", resized.after === 320 && resized.colWidth === "320px", JSON.stringify(resized));
  ok("resize handles rendered", resized.handles > 0, `handles=${resized.handles}`);

  // --- node identity preservation (the whole reason for keyed rendering)
  const identity = await page.eval<IdentityState>(`(() => {
    const t = window.demo.table;
    document.querySelector('.cf-table__filter-row input[data-col-id="qty"]').value = '';
    document.querySelector('.cf-table__filter-row input[data-col-id="qty"]').dispatchEvent(new Event('input',{bubbles:true}));
    return new Promise(res => setTimeout(() => {
      const firstRow = document.querySelector('.cf-table__body .cf-table__row');
      const id = firstRow.dataset.rowId;
      const cell = firstRow.querySelector('td');
      cell.__probe = 'kept';
      t.scheduleRender(); t.render();
      setTimeout(() => {
        const again = document.querySelector('.cf-table__body .cf-table__row[data-row-id="'+id+'"]');
        res({ sameRow: again === firstRow, sameCell: again && again.querySelector('td').__probe === 'kept' });
      }, 300);
    }, 600));
  })()`);
  ok("re-render reuses row + cell nodes (live controls survive)", identity.sameRow && identity.sameCell, JSON.stringify(identity));

  // --- selection
  await page.eval(`(() => {
    const rows = window.demo.table.table.getRowModel().rows;
    window.demo.table.table.setRowSelection({ [rows[0].id]: true, [rows[1].id]: true });
    return true;
  })()`);
  await settle(`document.querySelectorAll('.cds--data-table--selected').length >= 1`);
  const sel = await page.eval<SelectionState>(`(() => {
    const t = window.demo.table;
    return new Promise(res => setTimeout(() => res({
      selected: t.table.getSelectedRowModel().rows.length,
      classed: document.querySelectorAll('.cds--data-table--selected').length,
    }), 300));
  })()`);
  ok("row selection + Carbon selected class", sel.selected === 2 && sel.classed >= 1, JSON.stringify(sel));

  // --- scale
  const scale = await page.eval<ScaleState>(`(() => {
    const t = window.demo.table;
    const t0 = performance.now();
    t.setData(window.demo.makeData(50000));
    t.render();
    const t1 = performance.now();
    return { ms: Math.round(t1 - t0), rendered: document.querySelectorAll('.cf-table__body .cf-table__row').length,
             total: t.table.getRowModel().rows.length };
  })()`);
  ok("50k rows render windowed and fast", scale.rendered < 100 && scale.ms < 3000, JSON.stringify(scale));

  await page.screenshot(SHOT + "/engine-light.png");
  await page.eval(`document.documentElement.dataset.theme='dark'`);
  await new Promise(r=>setTimeout(r,400));
  await page.screenshot(SHOT + "/engine-dark.png");

  const errs = page.consoleErrors();
  ok("no console errors", errs.length === 0, errs.join(" | "));
} catch (e) {
  results.push("FAIL  harness: " + (e instanceof Error ? e.message : String(e)));
} finally {
  console.log("\n" + results.join("\n"));
  console.log("\n" + results.filter(r=>r.startsWith("PASS")).length + " passed, " + results.filter(r=>r.startsWith("FAIL")).length + " failed");
  page.close(); proc.kill(); server.kill();
  process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
}
