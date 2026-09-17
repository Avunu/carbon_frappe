// CarbonDataTable, constructed the way ERPNext's Bank Reconciliation Tool
// constructs it — directly, on a bare wrapper, with no `.empty()` or
// `.destroy()` in between two calls.
//
// `DataTableManager.make_dt` (erpnext bank_reconciliation_tool/
// data_table_manager.js) does `new frappe.DataTable(this.$reconciliation_tool_dt
// .get(0), opts)` fresh on every "Get Unreconciled Entries" click, trusting the
// CONSTRUCTOR to replace whatever was already in the wrapper — which is exactly
// what stock frappe-datatable does (`prepareDom()` sets `wrapper.innerHTML =
// <scaffold>` unconditionally, datatable.js:113). CarbonDataTable's own
// `prepareDom`/`buildEngine` only ever APPENDED into the container, so a second
// construction on the same wrapper stacked a second table under the first
// instead of replacing it — every scaffold, every listener, doubling on each
// call. See datatable.ts's `mountedOn` for the fix.
//
// This suite reproduces the bug at the level it actually lives — the
// constructor's contract — rather than through ERPNext's doctype (Company,
// Bank Account, Bank Transaction fixtures neither belong to this app nor to a
// fresh bench). A scratch `<div>` on any loaded desk page is the whole
// reproduction; nothing here is bank-reconciliation-specific.
import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.ts";
import type { Page } from "./cdp.ts";

/** The rows found in the wrapper after three blind reconstructions. */
interface RemountProbe {
	rows: number;
	/** Each surviving row's "Value" column text, in DOM order. */
	values: Array<string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * How many `type`-typed listeners are LIVE on the element `expression`
 * evaluates to, via CDP's own listener introspection
 * (`DOMDebugger.getEventListeners`).
 *
 * The DOM gives no script-visible way to ask this: dispatching a synthetic
 * event and counting how many times a probe's OWN callback fires proves
 * nothing about how many OTHER listeners a node carries — every registered
 * callback fires exactly once per dispatch regardless of how many siblings it
 * has. This is the only way to see whether `CarbonDataTable.destroy()`
 * actually removed a previous instance's `bindCheckboxes`/`bindTreeToggles`/
 * `editing`/`navigation` listeners, or merely left them bound underneath
 * fresh markup — `container` itself outlives any one instance (see
 * `mountedOn` in datatable.ts).
 */
async function countListeners(page: Page, expression: string, type: string): Promise<number> {
	const objRes = await page.send("Runtime.evaluate", { expression });
	const objectId = isRecord(objRes) && isRecord(objRes["result"]) ? objRes["result"]["objectId"] : undefined;
	if (typeof objectId !== "string") {
		throw new Error(`countListeners: could not resolve an objectId for ${expression}`);
	}
	const listenersRes = await page.send("DOMDebugger.getEventListeners", { objectId });
	const list = isRecord(listenersRes) ? listenersRes["listeners"] : undefined;
	if (!Array.isArray(list)) return 0;
	return list.filter((l): boolean => isRecord(l) && l["type"] === type).length;
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
	// Any loaded desk page carries the patched `frappe.DataTable` /
	// `window.DataTable` globals (install.ts reach-points 1 and 2) — the
	// reconstruction bug is in the constructor itself, not in report_view.js's
	// or query_report.js's own call sites, so neither is needed here.
	await page.goto(`${BASE}/app/sales-order/new`);
	await page.waitFor(`!!window.cur_frm`, { timeout: 90000 });
	await assertCarbonStylesheet(page);
	await new Promise((r) => setTimeout(r, 1500));

	// --- does reconstructing replace, or stack? ------------------------------
	await page.eval(`(() => {
    window.__cfRemountA = document.createElement('div');
    document.body.appendChild(window.__cfRemountA);
    return true;
  })()`);
	for (const value of ["first", "second", "third"]) {
		await page.eval(`(() => {
      new frappe.DataTable(window.__cfRemountA, {
        columns: [{ name: 'Row' }, { name: 'Value' }],
        data: [['x', ${JSON.stringify(value)}]],
        serialNoColumn: false,
      });
      return true;
    })()`);
		await new Promise((r) => setTimeout(r, 300));
	}
	const remounted = await page.eval<RemountProbe>(`(() => {
    const dataRows = window.__cfRemountA.querySelectorAll('.dt-row[data-row-index]');
    return {
      rows: dataRows.length,
      values: Array.from(dataRows).map((row) => {
        const cells = row.querySelectorAll('.dt-cell[data-col-index]');
        return cells[1] ? cells[1].textContent.trim() : null;
      }),
    };
  })()`);
	console.log(JSON.stringify(remounted));
	ok(
		"reconstructing on the same wrapper replaces the table instead of stacking a new one",
		remounted.rows === 1,
		JSON.stringify(remounted),
	);
	ok(
		"the surviving row is the LAST table constructed, not the first",
		remounted.values.length === 1 && remounted.values[0] === "third",
		JSON.stringify(remounted.values),
	);

	// --- do listeners bound straight on the wrapper leak across instances? --
	//
	// `bindCheckboxes()`, `bindTreeToggles()`, `editing.bind()` and
	// `navigation.bind()` all delegate straight onto `container`, which
	// OUTLIVES any one instance — only its CHILDREN get cleared/replaced by a
	// reconstruction. Three reconstructions with no teardown leave three
	// copies of each bound to the same node; each stale copy still fires,
	// acting on a `rowmanager`/`cellmanager` two reconstructions out of date.
	await page.eval(`(() => {
    window.__cfRemountB = document.createElement('div');
    document.body.appendChild(window.__cfRemountB);
    return true;
  })()`);
	for (const value of ["first", "second", "third"]) {
		await page.eval(`(() => {
      new frappe.DataTable(window.__cfRemountB, {
        columns: [{ name: 'Row' }, { name: 'Value' }],
        data: [['x', ${JSON.stringify(value)}]],
        checkboxColumn: true,
        serialNoColumn: false,
      });
      return true;
    })()`);
		await new Promise((r) => setTimeout(r, 300));
	}
	const listenerCounts = {
		change: await countListeners(page, "window.__cfRemountB", "change"),
		dblclick: await countListeners(page, "window.__cfRemountB", "dblclick"),
		mousedown: await countListeners(page, "window.__cfRemountB", "mousedown"),
		keydown: await countListeners(page, "window.__cfRemountB", "keydown"),
	};
	console.log(JSON.stringify(listenerCounts));
	ok(
		"three reconstructions with no teardown leave exactly one of each container-level listener, not three",
		Object.values(listenerCounts).every((n) => n === 1),
		JSON.stringify(listenerCounts),
	);

	await page.screenshot(SHOT + "/bench-datatable-remount.png");
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
