#!/usr/bin/env node
/**
 * Drift audit — runs warn-only on every `bench build` (via the package
 * `build` script) and strict in CI (`npm run audit`). Three checks:
 *
 *  1. Carbon token references: every `var(--cds-*)` we reference (without a
 *     fallback) must exist in @carbon/themes' emitted token set.
 *  2. Frappe variable pins: every espresso/legacy var we declare should still
 *     be declared by frappe (catches upstream renames/removals).
 *  3. Shadow mirrors: the frappe SCSS entry files our shadow bundles
 *     recompile must still exist, and frappe's desk.bundle.scss import list
 *     is diffed against our mirror (catches new imports we should add).
 *
 * Exit code: 0 in --warn-only, 1 in --strict when any check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const strict = process.argv.includes("--strict");

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const scssRoot = path.join(appRoot, "carbon_frappe", "public", "scss");

let failures = 0;
const warn = (msg: string): void => {
	console.warn(`[audit] ${msg}`);
	failures++;
};

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
}

const ourScss = walk(scssRoot)
	.filter((f) => f.endsWith(".scss"))
	.map((f) => ({ file: path.relative(appRoot, f), text: fs.readFileSync(f, "utf-8") }));

// ---- Check 4: the mapping premises actually hold -------------------------
// Runs BEFORE the frappe early-exit — it only inspects our own sources, and the
// two faults it guards were false comments describing behaviour that never
// existed: (1) frappe's espresso semantic layer (--surface-*/--ink-*/--outline-*)
// was assumed to cascade from the raw-ramp remap, but it's declared as literal
// hex, so every semantic slot must be pinned to a --cds-* token explicitly;
// (2) --radius-* was documented as squared but never declared, so frappe-ui SPA
// rounding survived. Assert both premises are true in source, so a future edit
// that quietly breaks them fails the audit instead of the rendering.
const allScssText = ourScss.map((s) => s.text).join("\n");
if (!/--surface-[a-z0-9-]+\s*:\s*var\(--cds-/.test(allScssText)) {
	warn("no --surface-* var is pinned to a --cds-* token — semantic layer would keep frappe literals");
}
if (!/--ink-[a-z0-9-]+\s*:\s*var\(--cds-/.test(allScssText)) {
	warn("no --ink-* var is pinned to a --cds-* token — semantic layer would keep frappe literals");
}
if (!/--radius-\d+\s*:/.test(allScssText)) {
	warn("--radius-* is not declared — frappe-ui SPA rounding would not be squared");
}
// (3) the light theme must be g10, not White. Their token KEY sets are
// identical, so check 1 cannot tell them apart — but their values invert the
// background/layer ladder, which every surface rule in scss/desk and scss/web
// is written against. Pin the premise here so the SCSS and this script can't
// drift apart silently.
if (!/@include\s+theme\.theme\(\s*themes\.\$g10\s*\)/.test(allScssText)) {
	warn("light theme is not themes.$g10 — the background/layer ladder assumed by scss/desk would be inverted");
}

if (!fs.existsSync(path.join(frappeRoot, "frappe", "public", "scss"))) {
	console.log(`[audit] frappe not found at ${frappeRoot} — skipping frappe-drift checks (set FRAPPE_PATH)`);
	process.exit(strict ? (failures ? 1 : 0) : 0);
}

// ---- Check 5: JS hooks the theme monkey-patches still exist ---------------
// These are the only places this app reaches past CSS into frappe's runtime.
// A rename upstream makes the patch a silent no-op — the theme keeps loading,
// the styling just quietly stops applying — so assert the shapes we depend on.

/**
 * A shape that must still be present in the frappe source, paired with what
 * breaks when it is not. Written as a row rather than an object because
 * inference widens a `[RegExp, string]` row to `(string | RegExp)[]`, which
 * costs the `re.test()` below the very narrowing the row already states.
 */
type HookTest = readonly [pattern: RegExp, what: string];

/** A frappe file this theme reaches into, and the shapes it must still contain. */
interface JsHook {
	readonly file: string;
	readonly tests: readonly HookTest[];
}

const jsHooks: readonly JsHook[] = [
	{
		file: "frappe/public/js/frappe/form/formatters.js",
		tests: [
			[/_right:\s*function/, "frappe.form.formatters._right (carbon_desk.bundle.js tags its output)"],
			[/text-align:\s*right/, "_right's inline-style wrapper (the CSS fallback selector matches it literally)"],
			[/\bDate:\s*function/, "frappe.form.formatters.Date (wrapped for mono dates)"],
		],
	},
	{
		file: "frappe/public/js/frappe/list/list_view.js",
		tests: [[/is_numeric_field\(.*\)\s*\?\s*"text-right"/, ".list-row-col.text-right (numeric list cells)"]],
	},
	{
		file: "frappe/public/js/frappe/ui/theme_switcher.js",
		tests: [[/setAttribute\(\s*["']data-theme["']/, "data-theme attribute write (chart re-theme observer)"]],
	},
];
for (const { file, tests } of jsHooks) {
	const abs = path.join(frappeRoot, file);
	if (!fs.existsSync(abs)) {
		warn(`frappe js hook source missing: ${file} (frappe restructured?)`);
		continue;
	}
	const text = fs.readFileSync(abs, "utf-8");
	for (const [re, what] of tests) {
		if (!re.test(text)) warn(`${file}: no longer matches ${re} — ${what} would silently stop applying`);
	}
}

// ---- Check 1: --cds-* references exist in @carbon/themes ------------------

/**
 * The two members of @carbon/themes this check uses. `createRequire` answers
 * `any`, so the module is narrowed at the boundary rather than trusted: an
 * upgrade that drops either member then fails here, saying so, instead of
 * inside `Object.keys` with a bare "cannot convert undefined to object".
 */
interface CarbonThemes {
	/** The g10 theme — one camelCase key per token. Only the keys are read. */
	readonly g10: Readonly<Record<string, unknown>>;
	/** camelCase token key -> the suffix that follows `--cds-` in emitted CSS. */
	formatTokenName(key: string): string;
}

const isCarbonThemes = (value: unknown): value is CarbonThemes =>
	typeof value === "object" &&
	value !== null &&
	"g10" in value &&
	typeof value.g10 === "object" &&
	value.g10 !== null &&
	"formatTokenName" in value &&
	typeof value.formatTokenName === "function";

const themes: unknown = require("@carbon/themes");
if (!isCarbonThemes(themes)) {
	throw new Error("@carbon/themes no longer exports both `g10` and `formatTokenName` — check 1 cannot run");
}
const cdsTokens = new Set(Object.keys(themes.g10).map((k) => themes.formatTokenName(k)));
for (const { file, text } of ourScss) {
	// var(--cds-name) without a fallback (a fallback makes missing tokens safe)
	for (const m of text.matchAll(/var\(--cds-([a-z0-9-]+)\)/g)) {
		// The group is not optional, so a match always carries it. The guard is
		// what noUncheckedIndexedAccess asks for, not a case that can occur.
		const token = m[1];
		if (token === undefined) continue;
		if (!cdsTokens.has(token)) {
			warn(`${file}: var(--cds-${token}) is not a @carbon/themes token`);
		}
	}
}

// ---- Check 2: frappe still declares the vars we pin -----------------------
// frappe v16 declares its CSS custom properties in scss/espresso/*.scss (the
// pre-v16 compiled css/espresso/*.css copies this check used to read are gone).
const frappeVarFiles = [
	"frappe/public/scss/espresso/_colors.scss",
	"frappe/public/scss/espresso/_typography.scss",
	"frappe/public/scss/espresso/_spacing.scss",
	"frappe/public/scss/espresso/_shadows.scss",
	"frappe/public/scss/espresso/_borders.scss",
	"frappe/public/scss/common/css_variables.scss",
	"frappe/public/scss/desk/css_variables.scss",
	"frappe/public/scss/desk/sidebar.scss",
	"frappe/public/scss/desk/dark.scss",
	// --charts-* are owned by the vendored frappe-charts package, not by frappe:
	// frappe's own scss re-declares only the 10 it overrides in dark mode, so
	// reading it alone would flag every other --charts-* var as nonexistent.
	// The dist CSS is the real authority and is what desk.bundle.scss imports.
	"node_modules/frappe-charts/dist/frappe-charts.min.css",
].map((f) => path.join(frappeRoot, f));

// emitted by compiled Bootstrap ($theme-colors -> :root), not present in
// frappe's scss sources as literal declarations
const bootstrapVars = new Set(["--primary", "--secondary", "--danger", "--light", "--dark"]);

const frappeVars = new Set<string>();
for (const f of frappeVarFiles) {
	if (!fs.existsSync(f)) {
		warn(`frappe var source missing: ${path.relative(frappeRoot, f)} (frappe restructured?)`);
		continue;
	}
	for (const m of fs.readFileSync(f, "utf-8").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
		// Group 1 always participates in a match; the check is for the compiler.
		const name = m[1];
		if (name !== undefined) frappeVars.add(name);
	}
}

// vars we declare that are OURS by design, not frappe(-desk) pins:
// --carbon-/--chart-color-/--cds- are theme-minted; --radius-*/--tw-* are
// frappe-ui / Tailwind SPA tokens (squared/repointed for carbon_frappe_ui);
// --elevation-*/--font-weight-* are frappe-ui semantic tokens (frappe desk uses
// --shadow-*/--weight-*), so they never appear in the desk scss sources above.
const ownPrefixes = [
	"--carbon-",
	"--chart-color-",
	"--font-family-mono",
	"--cds-",
	"--radius-",
	"--tw-",
	"--elevation-",
	"--font-weight-",
];
// Theme-minted aliases with no shared prefix: Carbon-only focus variants frappe
// doesn't ship (frappe has --focus-{default,blue,green,yellow,red} only), the
// derived component radii declared in _radius.scss, and frappe-ui surface names.
const themeOwned = new Set([
	"--focus-outline-default",
	"--focus-outline-red",
	"--focus-outline-green",
	"--focus-outline-blue",
	"--focus-outline-amber",
	"--focus-outline-violet",
	"--focus-amber",
	"--focus-violet",
	"--surface-base",
	"--surface-sidebar",
	"--outline-elevation-1",
	"--outline-elevation-2",
	"--card-border-radius",
	"--dt-border-radius",
	"--desktop-modal-radius",
]);
const mapFiles = ourScss.filter(({ file }) => file.includes(`scss${path.sep}map${path.sep}`));
for (const { file, text } of mapFiles) {
	for (const m of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
		const name = m[1];
		if (name === undefined) continue;
		if (ownPrefixes.some((p) => name.startsWith(p)) || bootstrapVars.has(name)) continue;
		if (themeOwned.has(name)) continue;
		if (!frappeVars.has(name)) {
			warn(`${file}: pins ${name}, which frappe no longer declares`);
		}
	}
}

// ---- Check 3: shadow-mirror sources still exist; desk imports diffed ------
const mirrored = [
	"frappe/public/scss/desk/index",
	"frappe/public/scss/website/index",
	"frappe/public/scss/login.bundle",
	"frappe/public/scss/email.bundle",
];
for (const m of mirrored) {
	const base = path.join(frappeRoot, m);
	if (!fs.existsSync(`${base}.scss`) && !fs.existsSync(path.join(base, "_index.scss"))) {
		warn(`mirrored frappe source missing: ${m} (update the shadow bundle)`);
	}
}

const frappeDesk = fs.readFileSync(
	path.join(frappeRoot, "frappe", "public", "scss", "desk.bundle.scss"),
	"utf-8"
);
const ourDesk = fs.readFileSync(path.join(scssRoot, "desk.bundle.scss"), "utf-8");
for (const m of frappeDesk.matchAll(/@import\s+"([^"]+)"/g)) {
	const imp = m[1];
	if (imp === undefined) continue;
	// inter fonts are intentionally replaced by IBM Plex
	if (imp.includes("inter")) continue;
	const normalized = imp.replace(/^~/, "").replace(/^\.\//, "");
	if (!ourDesk.includes(normalized)) {
		warn(`frappe desk.bundle.scss imports "${imp}" — not present in our desk mirror`);
	}
}

if (failures) {
	console.log(`[audit] ${failures} finding(s)${strict ? "" : " (warn-only)"}`);
	process.exit(strict ? 1 : 0);
}
console.log("[audit] clean");
