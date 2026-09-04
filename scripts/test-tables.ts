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
 * beyond Node 22+ (which ships a global WebSocket) — see scripts/tables/cdp.ts.
 *
 *   node scripts/test-tables.ts                # every suite
 *   node scripts/test-tables.ts grid list      # named suites
 *   CF_SITE_URL=http://localhost:8000 node scripts/test-tables.ts
 *
 * Requires: a running bench with carbon_frappe installed and built, and
 * `chromium` on PATH. Screenshots land in .dev-dist/screenshots/.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** One suite: the basename of its file under `scripts/tables/`, and what it covers. */
type Suite = readonly [name: string, description: string];

const SUITES: readonly Suite[] = [
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

const suiteFile = (name: string): string => path.join(here, "tables", `${name}.ts`);

// `node --check` parses without stripping types, so it rejects a .ts suite on
// its first annotation. Node's own stripper is the parser its loader uses, so
// running that over the source raises exactly the SyntaxError this check is
// after — and nothing in the suite itself executes.
const CHECK_TS =
	"import { stripTypeScriptTypes } from 'node:module';" +
	"import { readFileSync } from 'node:fs';" +
	"stripTypeScriptTypes(readFileSync(process.argv[1], 'utf-8'), { mode: 'strip' });";

const checkArgv = (file: string): string[] =>
	file.endsWith(".ts")
		? ["--no-warnings", "--input-type=module", "--eval", CHECK_TS, file]
		: ["--check", file];

// Syntax-check every suite first. The suites embed browser code in template
// literals, and a stray backtick in a comment inside one of those turns into a
// module-level SyntaxError that only surfaces as an unhelpful stack halfway
// through a long run.
for (const [name] of suites) {
	const file = suiteFile(name);
	const code = await new Promise<number | null>((resolve) => {
		spawn(process.execPath, checkArgv(file), { stdio: "inherit" }).on("close", resolve);
	});
	if (code !== 0) {
		console.error(`\nsuite "${name}" does not parse — fix the syntax error above`);
		process.exit(2);
	}
}

let failed = 0;
for (const [name, description] of suites) {
	console.log(`\n===== ${name} ===== ${description}`);
	const code = await new Promise<number | null>((resolve) => {
		const proc = spawn(process.execPath, [suiteFile(name)], {
			stdio: "inherit",
		});
		proc.on("close", resolve);
	});
	if (code !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
