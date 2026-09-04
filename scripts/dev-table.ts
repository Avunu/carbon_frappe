#!/usr/bin/env node
/**
 * Standalone build + page for the CarbonTable engine, for development outside a
 * bench — the JS twin of scripts/dev-compile.ts.
 *
 * The engine has no frappe dependency by design, so it can be exercised in a
 * plain browser page. That is where engine behaviour (virtualization, resize,
 * pinning, sort, filter, selection) gets verified before any adapter exists,
 * because a failure there is unambiguous: there is no desk bundle, no jQuery
 * and no frappe-datatable in the page to have caused it.
 *
 *   node scripts/dev-table.ts           # build .dev-dist/table-demo.{js,css,html}
 *   node scripts/dev-table.ts --serve   # ...and serve it on :8123
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// The two packages this script borrows, as it uses them. Both arrive through
// `createRequire`, which answers `any`: esbuild because it is required out of
// FRAPPE's node_modules by absolute path (no specifier a resolver could follow),
// sass because it is CommonJS. Naming the surface here is the only thing that
// keeps the build options and the render result checked.
// ---------------------------------------------------------------------------

/** The build options below, and nothing else esbuild accepts. */
interface EsbuildBuildOptions {
	entryPoints: string[];
	outfile: string;
	target: string[];
	bundle: boolean;
	sourcemap: boolean;
	define: Record<string, string>;
}

interface EsbuildModule {
	/** Resolves once the bundle is written; the result itself is not read. */
	build(options: EsbuildBuildOptions): Promise<unknown>;
}

/** What a sync legacy importer answers with: the path to load instead. */
interface LegacyImporterResult {
	file: string;
}

/** The string form of the legacy render API — the demo's SCSS is inline. */
interface LegacyStringOptions {
	data: string;
	includePaths: string[];
	quietDeps: boolean;
	importer: (url: string) => LegacyImporterResult;
}

/** `css` is a Buffer, which is why it can be written out directly. */
interface LegacyRenderResult {
	css: Buffer;
}

interface SassModule {
	renderSync(options: LegacyStringOptions): LegacyRenderResult;
}

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const outDir = path.join(appRoot, ".dev-dist");
// The annotations are where `NodeRequire`'s `any` stops.
const esbuild: EsbuildModule = require(path.join(frappeRoot, "node_modules", "esbuild"));
const sass: SassModule = require("sass");

fs.mkdirSync(outDir, { recursive: true });

// Same target frappe's pipeline uses (esbuild/esbuild.js: ESBUILD_TARGET).
await esbuild.build({
	// `.ts` in, `.js` out — esbuild strips the types; the served page and the
	// CDP drivers still ask for `table-demo.js`.
	entryPoints: [path.join(appRoot, "dev", "table-demo.ts")],
	outfile: path.join(outDir, "table-demo.js"),
	target: ["es2017"],
	bundle: true,
	sourcemap: true,
	define: { "process.env.NODE_ENV": JSON.stringify("development") },
});

// Only the Carbon tokens + the table layer: the demo deliberately does NOT load
// frappe's desk styles, so anything that looks right here is the engine's own.
const scss = `
@use "@carbon/styles/scss/theme";
@use "@carbon/styles/scss/themes";
:root { @include theme.theme(themes.$g10); }
[data-theme="dark"] { @include theme.theme(themes.$g100); }
:root { --carbon-border-subtle: var(--cds-border-subtle-01); }
[data-theme="dark"] { --carbon-border-subtle: var(--cds-border-subtle-00); }
@import "carbon_frappe/public/scss/desk/carbon-table";
html, body { margin: 0; height: 100%; font-family: "IBM Plex Sans", system-ui, sans-serif;
  background: var(--cds-background); color: var(--cds-text-primary); }
#host { height: calc(100vh - 60px); }
.toolbar { display: flex; gap: .5rem; padding: .75rem; align-items: center; }
.pill { padding: 0 .5rem; border: 1px solid var(--carbon-border-subtle); }
`;
const css = sass.renderSync({
	data: scss,
	includePaths: [path.join(appRoot, "node_modules"), path.join(frappeRoot, "node_modules"), appRoot, frappeRoot],
	quietDeps: true,
	importer: (url) => ({ file: url.startsWith("~") ? url.slice(1) : url }),
});
fs.writeFileSync(path.join(outDir, "table-demo.css"), css.css);

fs.writeFileSync(
	path.join(outDir, "table-demo.html"),
	`<!doctype html><html><head><meta charset="utf-8">
<title>CarbonTable engine</title><link rel="stylesheet" href="./table-demo.css"></head>
<body>
<div class="toolbar">
  <button id="theme">Toggle theme</button>
  <button id="filters">Toggle filters</button>
  <span id="count"></span>
</div>
<div id="host"></div>
<script src="./table-demo.js"></script>
<script>
  document.getElementById('theme').onclick = () => {
    const d = document.documentElement;
    d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
  };
  document.getElementById('filters').onclick = () => window.demo.table.toggleFilters();
</script>
</body></html>`
);

console.log(`✓ .dev-dist/table-demo.html (${(fs.statSync(path.join(outDir, "table-demo.js")).size / 1024).toFixed(0)} KB js)`);

if (process.argv.includes("--serve")) {
	const port = Number(process.env.PORT || 8123);
	const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
	http
		.createServer((req, res) => {
			// `split` always yields at least one element, but an index into it is
			// typed as possibly missing; the fallback is the path a bare "/"
			// already takes below.
			const rel = (req.url || "/").split("?")[0] ?? "/";
			const file = path.join(outDir, rel === "/" ? "table-demo.html" : rel);
			if (!file.startsWith(outDir) || !fs.existsSync(file)) {
				res.writeHead(404).end("not found");
				return;
			}
			res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
			fs.createReadStream(file).pipe(res);
		})
		.listen(port, () => console.log(`serving http://127.0.0.1:${port}/`));
}
