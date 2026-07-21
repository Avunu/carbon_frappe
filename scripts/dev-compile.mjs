#!/usr/bin/env node
/**
 * Standalone bundle compiler for development outside a bench.
 *
 * Replicates frappe's sass setup (legacy render API, includePaths = every
 * app root + every app's node_modules, `~` importer) so bundles can be
 * smoke-tested against a frappe checkout without `bench build`.
 *
 *   node scripts/dev-compile.mjs [bundle ...]        # default: all bundles
 *   FRAPPE_PATH=/path/to/frappe node scripts/dev-compile.mjs desk
 *
 * Output goes to .dev-dist/ (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sass = require("sass");

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const scssDir = path.join(appRoot, "carbon_frappe", "public", "scss");
const outDir = path.join(appRoot, ".dev-dist");

if (!fs.existsSync(path.join(frappeRoot, "frappe", "public", "scss"))) {
	console.error(`frappe checkout not found at ${frappeRoot} (set FRAPPE_PATH)`);
	process.exit(1);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const bundles = fs
	.readdirSync(scssDir)
	.filter((f) => f.endsWith(".bundle.scss"))
	.filter((f) => !requested.length || requested.includes(f.replace(".bundle.scss", "")));

fs.mkdirSync(outDir, { recursive: true });

// mirror of frappe/esbuild/sass_options.js
const sassOptions = {
	includePaths: [
		path.join(frappeRoot, "node_modules"),
		path.join(appRoot, "node_modules"),
		frappeRoot,
		appRoot,
	],
	quietDeps: true,
	importer: function (url) {
		if (url.startsWith("~")) url = url.slice(1);
		if (url.endsWith(".css")) url = url.slice(0, -4);
		return { file: url };
	},
};

let failed = false;
for (const bundle of bundles) {
	const file = path.join(scssDir, bundle);
	const outFile = path.join(outDir, bundle.replace(".scss", ".css"));
	const started = Date.now();
	try {
		const result = sass.renderSync({ ...sassOptions, file, outFile });
		fs.writeFileSync(outFile, result.css);
		const kb = (result.css.length / 1024).toFixed(0);
		console.log(`✓ ${bundle} → ${path.relative(appRoot, outFile)} (${kb} KB, ${Date.now() - started}ms)`);
	} catch (e) {
		failed = true;
		console.error(`✗ ${bundle}: ${e.formatted || e.message}`);
	}
}
process.exit(failed ? 1 : 0);
