#!/usr/bin/env node
/**
 * Post-build assets.json shadow enforcement.
 *
 * Frappe keys assets.json by bare bundle basename and merges build output over
 * existing keys, so the winner of a name collision depends on build order.
 * This script runs as this app's `build` script — i.e. after `bench build` has
 * compiled all bundles and written assets.json — and deterministically points
 * the shadowed keys (desk/website/login/email .bundle.css and their
 * rtl_ variants) at carbon_frappe's compiled assets, then clears the
 * `assets_json` redis cache so the web workers re-read the file.
 *
 * Outside a bench (standalone checkout) it exits 0 without doing anything.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { JS_BUNDLES, SHADOWED_BUNDLES } from "./markup-manifest.ts";

// The same four basenames the manifest lists; typed against its union so a
// typo here is a compile error rather than a key that silently never matches.

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = process.env.FRAPPE_BENCH_ROOT || path.resolve(appRoot, "..", "..");
const assetsDir = path.join(benchRoot, "sites", "assets");

function log(msg: string): void {
	console.log(`[carbon_frappe] ${msg}`);
}

/**
 * Narrow a freshly parsed JSON value to something whose keys can be read and
 * written. `JSON.parse` hands back `any`, and everything this script does to
 * assets.json is a keyed read or write, so the file passes through here first.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

if (!fs.existsSync(path.join(assetsDir, "assets.json"))) {
	log("no sites/assets/assets.json found (not on a bench) — skipping asset patch");
	process.exit(0);
}

let patched = false;

/**
 * One assets.json variant: the file to rewrite, the dist subdirectory its
 * bundles compile into, and the prefix frappe puts on its keys. Named because
 * the rows are heterogeneous — an unannotated table of them destructures as
 * three `string | undefined`s, the checker having seen a list of strings
 * rather than a row of three.
 */
type AssetsVariant = readonly [jsonName: string, cssDir: string, keyPrefix: string];

for (const [jsonName, cssDir, keyPrefix] of [
	["assets.json", "css", ""],
	["assets-rtl.json", "css-rtl", "rtl_"],
] satisfies readonly AssetsVariant[]) {
	const jsonPath = path.join(assetsDir, jsonName);
	const distDir = path.join(assetsDir, "carbon_frappe", "dist", cssDir);
	if (!fs.existsSync(jsonPath) || !fs.existsSync(distDir)) continue;

	// A flat basename -> site-absolute-URL map. The values stay `unknown`:
	// nothing here looks inside one, it only compares and replaces them.
	const assets: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
	if (!isRecord(assets)) throw new Error(`${jsonPath} is not a JSON object`);
	let changed = false;

	for (const name of SHADOWED_BUNDLES) {
		const pattern = new RegExp(`^${name}\\.bundle\\.[A-Z0-9]+\\.css$`, "i");
		const candidates = fs
			.readdirSync(distDir)
			.filter((f) => pattern.test(f))
			.map((f) => path.join(distDir, f))
			.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
		// `at(-1)` is `string | undefined` at any length, so the emptiness check
		// is spelled as the narrowing it always was: no last entry, nothing to
		// point at.
		const newest = candidates.at(-1);
		if (newest === undefined) continue;

		const target = "/" + path.relative(path.dirname(assetsDir), newest).replaceAll(path.sep, "/");
		const key = `${keyPrefix}${name}.bundle.css`;
		if (assets[key] !== target) {
			assets[key] = target;
			changed = true;
			log(`${jsonName}: ${key} -> ${target}`);
		}
	}

	if (changed) {
		fs.writeFileSync(jsonPath, JSON.stringify(assets, null, 4));
		patched = true;
	}
}

/**
 * The four JS bundle entries, named as hooks.py's `app_include_js` asks for
 * them. A literal list rather than a scan of `public/js`, so that a bundle
 * added on one side and not the other is a diff you can see.
 */

// Re-point the `.js` bundle keys at the freshly built files.
//
// frappe writes assets.json from TWO functions that disagree about the key the
// moment a bundle entry is a `.ts` file:
//
//   * a normal `bench build` ends in `write_assets_json`, which keys by the
//     ENTRY basename — `path.basename(info.entryPoint)`
//     (frappe/esbuild/esbuild.js:450). That is `carbon_desk.bundle.ts`.
//   * `bench build --using-cached` ends in `update_assets_obj`, which keys by
//     the OUTPUT basename with the hash segment dropped (esbuild.js:181-185).
//     esbuild emits `.js` whatever the entry was, so that is
//     `carbon_desk.bundle.js`.
//
// hooks.py can only name one, and `include_script` is a bare dict lookup with
// no extension fallback (frappe/utils/jinja_globals.py:151-156). It names
// `.js`, which the cached path and every pre-migration build already produce;
// this loop supplies it on the normal path. Skipping it does not fail loudly —
// the `.js` key keeps whatever stale hash an older build left behind, and the
// desk quietly runs last month's theme.
//
// No rtl variant: that prefix is a CSS-only convention (esbuild.js:451-453).
const jsAssetsPath = path.join(assetsDir, "assets.json");
const jsDistDir = path.join(assetsDir, "carbon_frappe", "dist", "js");
if (fs.existsSync(jsAssetsPath) && fs.existsSync(jsDistDir)) {
	const assets: unknown = JSON.parse(fs.readFileSync(jsAssetsPath, "utf-8"));
	if (!isRecord(assets)) throw new Error(`${jsAssetsPath} is not a JSON object`);
	let changed = false;

	for (const name of JS_BUNDLES) {
		// `.js$` also excludes the sourcemaps sitting next to them.
		const pattern = new RegExp(`^${name}\\.bundle\\.[A-Z0-9]+\\.js$`, "i");
		const candidates = fs
			.readdirSync(jsDistDir)
			.filter((f) => pattern.test(f))
			.map((f) => path.join(jsDistDir, f))
			.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
		const newest = candidates.at(-1);
		if (newest === undefined) continue;

		const target = "/" + path.relative(path.dirname(assetsDir), newest).replaceAll(path.sep, "/");
		const key = `${name}.bundle.js`;
		if (assets[key] !== target) {
			assets[key] = target;
			changed = true;
			log(`assets.json: ${key} -> ${target}`);
		}
	}

	if (changed) {
		fs.writeFileSync(jsAssetsPath, JSON.stringify(assets, null, 4));
		patched = true;
	}
}

/** The one export of frappe's `node_utils.js` this script reaches for. */
interface NodeUtils {
	get_redis_subscriber(kind: string): unknown;
}

/**
 * A `require()` out of another app's package root returns `any`. These two
 * guards are what the untyped code found out by calling: if frappe's tooling
 * ever stops exporting the factory, or the factory stops returning a client,
 * the throw lands in the same catch a `TypeError` used to.
 */
function isNodeUtils(value: unknown): value is NodeUtils {
	return isRecord(value) && typeof value["get_redis_subscriber"] === "function";
}

/** The three calls this script makes against the redis cache client. */
interface RedisCacheClient {
	connect(): Promise<unknown>;
	del(key: string): Promise<unknown>;
	quit(): Promise<unknown>;
}

function isRedisCacheClient(value: unknown): value is RedisCacheClient {
	return (
		isRecord(value) &&
		typeof value["connect"] === "function" &&
		typeof value["del"] === "function" &&
		typeof value["quit"] === "function"
	);
}

if (patched) {
	// Clear the python-side cache the same way frappe's esbuild does.
	try {
		const require = createRequire(path.join(benchRoot, "apps", "frappe", "package.json"));
		const nodeUtils: unknown = require("./node_utils.js");
		if (!isNodeUtils(nodeUtils)) throw new Error("frappe's node_utils.js does not export get_redis_subscriber");
		const client: unknown = nodeUtils.get_redis_subscriber("redis_cache");
		if (!isRedisCacheClient(client)) throw new Error("get_redis_subscriber('redis_cache') returned no redis client");
		await client.connect();
		await client.del("assets_json");
		await client.quit();
		log("cleared assets_json redis cache");
	} catch (e) {
		log(
			`could not clear redis cache (${e instanceof Error ? e.message : String(e)}) — run \`bench --site all clear-website-cache\` or restart workers if styles look stale`
		);
	}
} else {
	log("assets.json already points at carbon_frappe bundles");
}

process.exit(0);
