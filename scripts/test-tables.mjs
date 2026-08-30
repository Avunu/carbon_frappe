#!/usr/bin/env node
/**
 * Browser tests for the Carbon table engine and its three frappe adapters.
 *
 * These exist because the thing being replaced is DOM behaviour that no unit
 * test can see: whether frappe's `.dt-*` / `.grid-*` / `.list-row-*` contract
 * still resolves, whether `datatable.style.setStyle()` still paints a cell,
 * whether a report's `getEditor` still mounts into the right element, and
 * whether a stylesheet three layers down (frappe-datatable's, Bootstrap's,
 * Carbon's) has quietly won a specificity fight. Every one of those regressed at
 * least once during development; each suite carries the guard that caught it.
 *
 * They drive headless Chromium over the DevTools Protocol with no dependencies
 * beyond Node 22+ (which ships a global WebSocket) — see scripts/tables/cdp.mjs.
 *
 *   node scripts/test-tables.mjs                # every suite
 *   node scripts/test-tables.mjs grid list      # named suites
 *   CF_SITE_URL=http://localhost:8000 node scripts/test-tables.mjs
 *
 * Requires: a running bench with carbon_frappe installed and built, and
 * `chromium` on PATH. Screenshots land in .dev-dist/screenshots/.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
	["engine", "the engine alone, in a plain page with no frappe present"],
	["report", "Report View — CarbonDataTable and the dt-* contract"],
	["grid", "child-table Grid — >10 columns, live controls, inherited API"],
	["list", "List view — cell reuse, bulk actions, subclass safety"],
	["query-report", "Query Report — the third-party report-script hook surface"],
	["dark", "g100 parity across all three surfaces"],
];

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const suites = SUITES.filter(([name]) => !requested.length || requested.includes(name));

if (!suites.length) {
	console.error(`unknown suite. available: ${SUITES.map((s) => s[0]).join(", ")}`);
	process.exit(2);
}

// Syntax-check every suite first. The suites embed browser code in template
// literals, and a stray backtick in a comment inside one of those turns into a
// module-level SyntaxError that only surfaces as an unhelpful stack halfway
// through a long run.
for (const [name] of suites) {
	const file = path.join(here, "tables", `${name}.mjs`);
	const code = await new Promise((resolve) => {
		spawn(process.execPath, ["--check", file], { stdio: "inherit" }).on("close", resolve);
	});
	if (code !== 0) {
		console.error(`\nsuite "${name}" does not parse — fix the syntax error above`);
		process.exit(2);
	}
}

let failed = 0;
for (const [name, description] of suites) {
	console.log(`\n===== ${name} ===== ${description}`);
	const code = await new Promise((resolve) => {
		const proc = spawn(process.execPath, [path.join(here, "tables", `${name}.mjs`)], {
			stdio: "inherit",
		});
		proc.on("close", resolve);
	});
	if (code !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
