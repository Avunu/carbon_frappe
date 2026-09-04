#!/usr/bin/env node
/**
 * Standalone bundle compiler for development outside a bench.
 *
 * Replicates frappe's sass setup (legacy render API, includePaths = every
 * app root + every app's node_modules, `~` importer) so bundles can be
 * smoke-tested against a frappe checkout without `bench build`.
 *
 *   node scripts/dev-compile.ts [bundle ...]        # default: all bundles
 *   FRAPPE_PATH=/path/to/frappe node scripts/dev-compile.ts desk
 *
 * Output goes to .dev-dist/ (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// sass, as this script uses it. The package ships its own declarations, but
// they are unreachable from here: `createRequire` loads it as CommonJS and
// `NodeRequire` answers `any`, so without naming the surface nothing below —
// the option shape frappe's pipeline dictates, the importer's argument, the
// Buffer that comes back — would be checked at all. Only the legacy render API
// is described, because that is the one frappe uses and the one we mirror.
// ---------------------------------------------------------------------------

/** What a sync legacy importer answers with: the path to load instead. */
interface LegacyImporterResult {
	file: string;
}

/** The options that are the same for every bundle. */
interface LegacySharedOptions {
	includePaths: string[];
	quietDeps: boolean;
	importer: (url: string) => LegacyImporterResult;
}

/** One bundle's compile: the shared options plus where it reads and writes. */
interface LegacyRenderOptions extends LegacySharedOptions {
	file: string;
	outFile: string;
}

/** `css` is a Buffer, which is why it can be written and measured directly. */
interface LegacyRenderResult {
	css: Buffer;
}

interface SassModule {
	renderSync(options: LegacyRenderOptions): LegacyRenderResult;
}

const require = createRequire(import.meta.url);
// The annotation is where `NodeRequire`'s `any` stops.
const sass: SassModule = require("sass");

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
const sassOptions: LegacySharedOptions = {
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

/** Anything with readable properties — what `catch` binds before narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The text the failure line reports. sass's legacy renderer throws a
 * `LegacyException`, whose `formatted` is the message with the offending source
 * lines under it; anything else that escapes a compile carries only `message`.
 * `catch` binds `unknown`, so both reads are proven here rather than assumed.
 */
function sassErrorText(error: unknown): string {
	const source: Record<string, unknown> = isRecord(error) ? error : {};
	const formatted = source["formatted"];
	const message = source["message"];
	return `${formatted || message}`;
}

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
		console.error(`✗ ${bundle}: ${sassErrorText(e)}`);
	}
}
process.exit(failed ? 1 : 0);
