#!/usr/bin/env node
/**
 * Markup & shadow drift audit — the companion to audit-tokens.mjs.
 *
 * audit-tokens guards what this theme says about COLOUR. This guards what it
 * assumes about frappe's MARKUP, its RUNTIME, and the asset shadow. All three
 * fail the same silent way: the theme keeps loading and a component just
 * quietly reverts to stock frappe styling.
 *
 * Four checks:
 *  1. Selectors — every class we style is still emitted by the frappe file
 *     that emits it today.
 *  2. Patch targets — every runtime shape js/anatomy/* wraps still exists.
 *  3. Mirrored literals — the frappe declarations we deliberately override
 *     still exist, proving the mechanism (not just the value) is unchanged.
 *  4. Asset shadow — sites/assets/assets.json still points the shadowed
 *     bundles at carbon_frappe. A partial `bench build --apps frappe`, and
 *     `bench watch` rebuilding frappe mid-session, both re-claim these keys,
 *     which serves stock frappe CSS with no other symptom.
 *
 * Exit code: 0 in --warn-only, 1 in --strict when any check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SELECTORS, PATCH_TARGETS, MIRRORED_LITERALS, SHADOWED_BUNDLES } from "./markup-manifest.mjs";

const strict = process.argv.includes("--strict");

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const benchRoot = process.env.FRAPPE_BENCH_ROOT || path.resolve(appRoot, "..", "..");

let failures = 0;
const warn = (msg) => {
	console.warn(`[audit-markup] ${msg}`);
	failures++;
};

const read = (rel) => {
	const abs = path.join(frappeRoot, rel);
	if (!fs.existsSync(abs)) return null;
	return fs.readFileSync(abs, "utf-8");
};

// ---- Check 4 first: it works without a frappe checkout ---------------------
const assetsPath = path.join(benchRoot, "sites", "assets", "assets.json");
if (fs.existsSync(assetsPath)) {
	let assets = {};
	try {
		assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8"));
	} catch (e) {
		warn(`assets.json is unreadable (${e.message})`);
	}
	const stolen = SHADOWED_BUNDLES.filter((name) => {
		const v = assets[`${name}.bundle.css`];
		return v && !v.includes("/carbon_frappe/");
	});
	if (stolen.length) {
		warn(
			`asset shadow lost for ${stolen.join(", ")} — assets.json points at frappe's bundles, ` +
				`so the desk is being served STOCK frappe CSS. ` +
				`Re-run \`node scripts/patch-assets.mjs\`. ` +
				`Usual causes: \`bench build --apps frappe\`, or \`bench watch\` rebuilding frappe mid-session.`
		);
	}
}

if (!fs.existsSync(path.join(frappeRoot, "frappe", "public"))) {
	console.log(`[audit-markup] frappe not found at ${frappeRoot} — skipping drift checks (set FRAPPE_PATH)`);
	process.exit(strict ? (failures ? 1 : 0) : 0);
}

// ---- Check 1: selectors still emitted --------------------------------------
for (const [cls, file] of SELECTORS) {
	const text = read(file);
	if (text === null) {
		warn(`missing source ${file} (frappe restructured?) — cannot verify .${cls}`);
		continue;
	}
	if (!text.includes(cls)) {
		warn(`.${cls} no longer appears in ${file} — the rules styling it are now dead`);
	}
}

// ---- Check 2: runtime patch targets ----------------------------------------
for (const [id, file, re] of PATCH_TARGETS) {
	const text = read(file);
	if (text === null) {
		warn(`missing source ${file} — cannot verify ${id}`);
		continue;
	}
	if (!re.test(text)) {
		warn(`${file} no longer matches ${re} — ${id} would silently stop applying`);
	}
}

// ---- Check 3: mirrored literals --------------------------------------------
for (const [literal, file] of MIRRORED_LITERALS) {
	const text = read(file);
	if (text === null) {
		warn(`missing source ${file} — cannot verify ${literal}`);
		continue;
	}
	if (!text.includes(literal)) {
		warn(`${literal} is gone from ${file} — the override that compensates for it may now be wrong`);
	}
}

if (failures) {
	console.log(`[audit-markup] ${failures} finding(s)${strict ? "" : " (warn-only)"}`);
	process.exit(strict ? 1 : 0);
}
console.log("[audit-markup] clean");
