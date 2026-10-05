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
 *  4c. The lazy AI chat build (public/dist/ai_chat) is complete: its manifest
 *     parses, names an entry and a stylesheet that exist, and every relative
 *     import inside it resolves.
 *
 * Exit code: 0 in --warn-only, 1 in --strict when any check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	SELECTORS,
	PATCH_TARGETS,
	MIRRORED_LITERALS,
	SHADOWED_BUNDLES,
	JS_BUNDLES,
} from "./markup-manifest.ts";

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
			warn(
				`assets.json is ${parsed === null ? "null" : typeof parsed}, not an object — the asset shadow cannot be verified`,
			);
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
				`Usual causes: \`bench build --apps frappe\`, or \`bench watch\` rebuilding frappe mid-session.`,
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
				`Usual cause: a build that did not run this app's build command, i.e. \`bench watch\`.`,
		);
	}
}

// Check 4c: the lazy AI chat build is whole.
//
// Not an assets.json entry, so none of the checks above can see it, and a missing or
// half-written build fails only at the first click on the header button (the loader
// shows its "could not be loaded" notice). A tree with no build at all is normal for a
// fresh checkout and CI, so that case is a note, not a finding; a manifest that
// names something absent is one.
const chatDist = path.join(appRoot, "carbon_frappe", "public", "dist", "ai_chat");
const chatManifestPath = path.join(chatDist, "manifest.json");
if (!fs.existsSync(chatDist)) {
	console.log(
		"[audit-markup] public/dist/ai_chat not built — run `yarn build:chat` (the AI assistant cannot load without it)",
	);
} else if (!fs.existsSync(chatManifestPath)) {
	warn(
		"public/dist/ai_chat has no manifest.json — the build was interrupted or never finished. Run `yarn build:chat`.",
	);
} else {
	checkChatDist();
}

function checkChatDist(): void {
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(chatManifestPath, "utf-8"));
	} catch (e) {
		warn(`dist/ai_chat/manifest.json is unreadable (${e instanceof Error ? e.message : String(e)})`);
		return;
	}
	if (!isRecord(manifest)) {
		warn("dist/ai_chat/manifest.json is not an object — the loader will reject it");
		return;
	}
	for (const key of ["entry", "css"]) {
		const name = manifest[key];
		if (typeof name !== "string") {
			warn(`dist/ai_chat/manifest.json has no "${key}" string — the loader will reject it`);
		} else if (!fs.existsSync(path.join(chatDist, name))) {
			warn(`dist/ai_chat/manifest.json names ${key} ${name}, which does not exist. Run \`yarn build:chat\`.`);
		}
	}

	// A chunk swept out from under the entry looks like a working build until the code or
	// table that needs it renders. Minified ESM writes `from"./x.js"` and `import("./x.js")`
	// with no space, hence `\s*`.
	const relativeImport = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
	const missing = new Set<string>();
	const scan = (dir: string): void => {
		for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, dirent.name);
			if (dirent.isDirectory()) scan(full);
			else if (dirent.name.endsWith(".js")) {
				for (const match of fs.readFileSync(full, "utf-8").matchAll(relativeImport)) {
					const target = path.resolve(dir, match[1] ?? "");
					if (!fs.existsSync(target)) missing.add(path.relative(chatDist, target));
				}
			}
		}
	};
	scan(chatDist);
	if (missing.size) {
		warn(
			`dist/ai_chat imports ${missing.size} file(s) that do not exist (e.g. ${[...missing][0]}) — ` +
				`a partial or hand-edited build. Run \`yarn build:chat\`.`,
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
