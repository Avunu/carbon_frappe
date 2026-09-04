#!/usr/bin/env node
/**
 * Markup & shadow drift audit — the companion to audit-tokens.ts.
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
 *  4b. This app's own `*.bundle.js` keys still resolve to a file that exists.
 *     Since the entry points became `.ts` those keys are no longer written by
 *     a plain build, so they can silently rot to a swept hash.
 *
 * Exit code: 0 in --warn-only, 1 in --strict when any check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SELECTORS, PATCH_TARGETS, MIRRORED_LITERALS, SHADOWED_BUNDLES, JS_BUNDLES } from "./markup-manifest.ts";

const strict = process.argv.includes("--strict");

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const benchRoot = process.env.FRAPPE_BENCH_ROOT || path.resolve(appRoot, "..", "..");

let failures = 0;
const warn = (msg: string): void => {
	console.warn(`[audit-markup] ${msg}`);
	failures++;
};

/** The frappe source at `rel`, or null when frappe no longer ships that file. */
const read = (rel: string): string | null => {
	const abs = path.join(frappeRoot, rel);
	if (!fs.existsSync(abs)) return null;
	return fs.readFileSync(abs, "utf-8");
};

/**
 * Narrow a freshly parsed JSON value to something whose keys can be read.
 * assets.json is written by frappe's build and by scripts/patch-assets.ts, and
 * `JSON.parse` answers `any`, so nothing below may assume it arrived intact.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

// ---- Check 4 first: it works without a frappe checkout ---------------------
const assetsPath = path.join(benchRoot, "sites", "assets", "assets.json");
if (fs.existsSync(assetsPath)) {
	let assets: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(assetsPath, "utf-8"));
		// Only an object can carry the bundle keys. Letting a non-object fall
		// through as an empty map would read exactly like "no bundles declared" —
		// i.e. a clean audit over a corrupt file, which is the single worst answer
		// this script can give. Report it the same way an unparseable file is.
		if (isRecord(parsed)) {
			assets = parsed;
		} else {
			warn(`assets.json is ${parsed === null ? "null" : typeof parsed}, not an object — the asset shadow cannot be verified`);
		}
	} catch (e) {
		warn(`assets.json is unreadable (${e instanceof Error ? e.message : String(e)})`);
	}
	const stolen = SHADOWED_BUNDLES.filter((name) => {
		const v = assets[`${name}.bundle.css`];
		// A missing key is not a lost shadow — that bundle simply isn't built yet.
		if (!v) return false;
		// The values are site-absolute URLs, so anything else means this file is
		// not an assets.json. The untyped version reached `.includes` here and
		// died on it; keep failing loudly rather than reporting an intact shadow
		// off garbage, which is the one reading that would be actively wrong.
		if (typeof v !== "string") {
			throw new TypeError(`assets.json: ${name}.bundle.css is ${typeof v}, not a URL string`);
		}
		return !v.includes("/carbon_frappe/");
	});
	if (stolen.length) {
		warn(
			`asset shadow lost for ${stolen.join(", ")} — assets.json points at frappe's bundles, ` +
				`so the desk is being served STOCK frappe CSS. ` +
				`Re-run \`node scripts/patch-assets.ts\`. ` +
				`Usual causes: \`bench build --apps frappe\`, or \`bench watch\` rebuilding frappe mid-session.`
		);
	}

	// Check 4b: this app's own JS keys point at a file that still exists.
	//
	// Distinct failure from the shadow above, and newer: since the bundle entry
	// points became `.ts`, every build writes the key `carbon_desk.bundle.TS`
	// while `hooks.py` asks for `carbon_desk.bundle.JS`
	// (frappe/esbuild/esbuild.js:450 keys by the ENTRY basename). Nothing errors
	// — the `.js` key simply keeps an older build's hash, that file is swept by
	// esbuild's build-cleanup, and the desk serves a 404 or a stale bundle. A
	// dangling target is therefore the exact, detectable symptom.
	const dangling = JS_BUNDLES.filter((name) => {
		const v = assets[`${name}.bundle.js`];
		// Not built yet is not drift.
		if (!v) return false;
		if (typeof v !== "string") {
			throw new TypeError(`assets.json: ${name}.bundle.js is ${typeof v}, not a URL string`);
		}
		return !fs.existsSync(path.join(benchRoot, "sites", v.replace(/^\//, "")));
	});
	if (dangling.length) {
		warn(
			`assets.json points ${dangling.map((n) => `${n}.bundle.js`).join(", ")} at a file that no longer exists — ` +
				`the desk is loading a missing or stale bundle. ` +
				`Re-run \`node scripts/patch-assets.ts\`. ` +
				`Usual cause: a build that did not run this app's build command, i.e. \`bench watch\`.`
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
