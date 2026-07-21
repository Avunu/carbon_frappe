#!/usr/bin/env node
/**
 * Post-build assets.json shadow enforcement.
 *
 * Frappe keys assets.json by bare bundle basename and merges build output over
 * existing keys, so the winner of a name collision depends on build order.
 * This script runs as this app's `build` script — i.e. after `bench build` has
 * compiled all bundles and written assets.json — and deterministically points
 * the shadowed keys (desk/website/login/email/print .bundle.css and their
 * rtl_ variants) at carbon_frappe's compiled assets, then clears the
 * `assets_json` redis cache so the web workers re-read the file.
 *
 * Outside a bench (standalone checkout) it exits 0 without doing anything.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SHADOWED_BUNDLES = ["desk", "website", "login", "email", "print"];

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = process.env.FRAPPE_BENCH_ROOT || path.resolve(appRoot, "..", "..");
const assetsDir = path.join(benchRoot, "sites", "assets");

function log(msg) {
	console.log(`[carbon_frappe] ${msg}`);
}

if (!fs.existsSync(path.join(assetsDir, "assets.json"))) {
	log("no sites/assets/assets.json found (not on a bench) — skipping asset patch");
	process.exit(0);
}

let patched = false;

for (const [jsonName, cssDir, keyPrefix] of [
	["assets.json", "css", ""],
	["assets-rtl.json", "css-rtl", "rtl_"],
]) {
	const jsonPath = path.join(assetsDir, jsonName);
	const distDir = path.join(assetsDir, "carbon_frappe", "dist", cssDir);
	if (!fs.existsSync(jsonPath) || !fs.existsSync(distDir)) continue;

	const assets = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
	let changed = false;

	for (const name of SHADOWED_BUNDLES) {
		const pattern = new RegExp(`^${name}\\.bundle\\.[A-Z0-9]+\\.css$`, "i");
		const candidates = fs
			.readdirSync(distDir)
			.filter((f) => pattern.test(f))
			.map((f) => path.join(distDir, f))
			.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
		if (!candidates.length) continue;

		const target = "/" + path.relative(path.dirname(assetsDir), candidates.at(-1)).replaceAll(path.sep, "/");
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

if (patched) {
	// Clear the python-side cache the same way frappe's esbuild does.
	try {
		const require = createRequire(path.join(benchRoot, "apps", "frappe", "package.json"));
		const { get_redis_subscriber } = require("./node_utils.js");
		const client = get_redis_subscriber("redis_cache");
		await client.connect();
		await client.del("assets_json");
		await client.quit();
		log("cleared assets_json redis cache");
	} catch (e) {
		log(`could not clear redis cache (${e.message}) — run \`bench --site all clear-website-cache\` or restart workers if styles look stale`);
	}
} else {
	log("assets.json already points at carbon_frappe bundles");
}

process.exit(0);
