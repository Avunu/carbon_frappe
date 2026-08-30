import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "./cdp.mjs";
const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });
const { proc, port } = await launch();
const page = await newPage(port);
const results = [];
const ok = (n, c, x = "") => results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
const dark = `(() => { document.documentElement.setAttribute('data-theme','dark'); return true; })()`;
try {
  await login(page, BASE);

  await page.goto(`${BASE}/app/todo`);
  await page.waitFor(`!!(window.cur_list && cur_list.carbon_table)`, { timeout: 90000 });
  // Guard: a stolen assets.json key means we would be measuring stock frappe.
  await assertCarbonStylesheet(page);
  await new Promise(r => setTimeout(r, 2000));
  await page.eval(dark);
  await new Promise(r => setTimeout(r, 700));
  const l = await page.eval(`(() => {
    const th = document.querySelector('.cf-table thead th');
    const td = document.querySelector('.cf-table tbody td');
    return { th: getComputedStyle(th).backgroundColor, td: getComputedStyle(td).color,
             bg: getComputedStyle(document.body).backgroundColor };
  })()`);
  ok("list view picks up g100 tokens", l.th !== "rgb(255, 255, 255)" && l.bg !== "rgb(255, 255, 255)", JSON.stringify(l));
  await page.screenshot(SHOT + "/dark-list.png");

  await page.goto(`${BASE}/app/query-report/Database%20Storage%20Usage%20By%20Tables`);
  await page.waitFor(`!!(window.frappe && frappe.query_report && frappe.query_report.datatable)`, { timeout: 90000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.eval(dark);
  await new Promise(r => setTimeout(r, 700));
  const q = await page.eval(`(() => {
    const th = document.querySelector('.cf-table thead th');
    const td = document.querySelector('.cf-table tbody td');
    return { th: getComputedStyle(th).backgroundColor, tdBg: getComputedStyle(td).backgroundColor,
             tdColor: getComputedStyle(td).color };
  })()`);
  ok("report view picks up g100 tokens", q.th !== "rgb(255, 255, 255)", JSON.stringify(q));
  await page.screenshot(SHOT + "/dark-report.png");

  await page.goto(`${BASE}/app/sales-order/new`);
  await page.waitFor(`!!(window.cur_frm && cur_frm.fields_dict && cur_frm.fields_dict.items && cur_frm.fields_dict.items.grid.carbon_table)`, { timeout: 90000 });
  await page.eval(`(() => { for (let i=0;i<3;i++) cur_frm.add_child('items',{qty:i+1,rate:(i+1)*100}); cur_frm.refresh_field('items'); return true; })()`);
  await new Promise(r => setTimeout(r, 1800));
  await page.eval(dark);
  await new Promise(r => setTimeout(r, 700));
  await page.eval(`document.querySelector('.form-grid').scrollIntoView({block:'center'})`);
  await new Promise(r => setTimeout(r, 500));
  const g = await page.eval(`(() => {
    const th = document.querySelector('.form-grid thead th');
    return { th: getComputedStyle(th).backgroundColor, color: getComputedStyle(th).color };
  })()`);
  ok("grid picks up g100 tokens", g.th !== "rgb(255, 255, 255)", JSON.stringify(g));
  await page.screenshot(SHOT + "/dark-grid.png");

  const errs = page.consoleErrors();
  ok("no console errors in dark theme", errs.length === 0, errs.slice(0,3).join(" | "));
} catch (e) { results.push("FAIL  harness: " + e.message); }
finally {
  console.log("\n" + results.join("\n"));
  console.log("\n" + results.filter(r=>r.startsWith("PASS")).length + " passed, " + results.filter(r=>r.startsWith("FAIL")).length + " failed");
  page.close(); proc.kill();
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
