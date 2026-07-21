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
const warn = (msg) => {
	console.warn(`[audit] ${msg}`);
	failures++;
};

if (!fs.existsSync(path.join(frappeRoot, "frappe", "public", "scss"))) {
	console.log(`[audit] frappe not found at ${frappeRoot} — skipping (set FRAPPE_PATH)`);
	process.exit(0);
}

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
}

const ourScss = walk(scssRoot)
	.filter((f) => f.endsWith(".scss"))
	.map((f) => ({ file: path.relative(appRoot, f), text: fs.readFileSync(f, "utf-8") }));

// ---- Check 1: --cds-* references exist in @carbon/themes ------------------
const themes = require("@carbon/themes");
const cdsTokens = new Set(Object.keys(themes.white).map((k) => themes.formatTokenName(k)));
for (const { file, text } of ourScss) {
	// var(--cds-name) without a fallback (a fallback makes missing tokens safe)
	for (const m of text.matchAll(/var\(--cds-([a-z0-9-]+)\)/g)) {
		if (!cdsTokens.has(m[1])) {
			warn(`${file}: var(--cds-${m[1]}) is not a @carbon/themes token`);
		}
	}
}

// ---- Check 2: frappe still declares the vars we pin -----------------------
const frappeVarFiles = [
	"frappe/public/css/espresso/colors.css",
	"frappe/public/css/espresso/legacy.css",
	"frappe/public/css/espresso/typography.css",
	"frappe/public/css/espresso/spacing.css",
	"frappe/public/css/espresso/effects.css",
	"frappe/public/css/espresso/radius.css",
	"frappe/public/scss/common/css_variables.scss",
	"frappe/public/scss/desk/css_variables.scss",
	"frappe/public/scss/desk/sidebar.scss",
	"frappe/public/scss/desk/dark.scss",
	"frappe/public/scss/espresso/_typography.scss",
].map((f) => path.join(frappeRoot, f));

// emitted by compiled Bootstrap ($theme-colors -> :root), not present in
// frappe's scss sources as literal declarations
const bootstrapVars = new Set(["--primary", "--secondary", "--danger", "--light", "--dark"]);

const frappeVars = new Set();
for (const f of frappeVarFiles) {
	if (!fs.existsSync(f)) {
		warn(`frappe var source missing: ${path.relative(frappeRoot, f)} (frappe restructured?)`);
		continue;
	}
	for (const m of fs.readFileSync(f, "utf-8").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
		frappeVars.add(m[1]);
	}
}

// vars we declare that are OURS by design, not frappe pins
const ownPrefixes = ["--carbon-", "--chart-color-", "--font-family-mono", "--cds-"];
const mapFiles = ourScss.filter(({ file }) => file.includes(`scss${path.sep}map${path.sep}`));
for (const { file, text } of mapFiles) {
	for (const m of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
		const name = m[1];
		if (ownPrefixes.some((p) => name.startsWith(p)) || bootstrapVars.has(name)) continue;
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
	"frappe/public/scss/print.bundle",
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
