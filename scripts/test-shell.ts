#!/usr/bin/env node
/**
 * Browser tests for the Carbon UI Shell header (js/anatomy/ui_shell.ts).
 *
 * The header is a projection of frappe's Workspace Sidebar into Carbon's UI
 * Shell markup, and everything that can go wrong with it is DOM behaviour:
 * whether the name follows the workspace, whether the links mirror the
 * sidebar's rows, whether a sub-menu opens off `aria-expanded`, whether the
 * measured overflow keeps the bar off the utilities, whether the moved bell
 * still paints its badge, and whether the g100 zone actually resolves on the
 * header in both themes. Same driver as the table suites — headless Chromium
 * over the DevTools Protocol, no dependencies beyond Node 22+.
 *
 *   node scripts/test-shell.ts
 *   CF_SITE_URL=http://localhost:8000 node scripts/test-shell.ts
 *
 * Requires: a running bench with carbon_frappe, erpnext and hrms installed and
 * built (the fixtures are the Projects and Recruitment sidebars), and
 * `chromium` on PATH. Screenshots land in .dev-dist/screenshots/.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** One suite: the basename of its file under `scripts/shell/`, and what it covers. */
type Suite = readonly [name: string, description: string];

const SUITES: readonly Suite[] = [
	["header", "name, links, sub-menus, overflow, switcher, utilities, g100 parity"],
];

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const suites = SUITES.filter(([name]) => !requested.length || requested.includes(name));

if (!suites.length) {
	console.error(`unknown suite. available: ${SUITES.map((s) => s[0]).join(", ")}`);
	process.exit(2);
}

const suiteFile = (name: string): string => path.join(here, "shell", `${name}.ts`);

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
