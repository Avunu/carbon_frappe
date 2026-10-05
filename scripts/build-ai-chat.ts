#!/usr/bin/env node
/**
 * Build the lazy AI chat bundle: public/dist/ai_chat/.
 *
 *   node scripts/build-ai-chat.ts            one production build (what `yarn build` runs)
 *   node scripts/build-ai-chat.ts --watch    rebuild on change, unminified (bench watch does not run this)
 *   node scripts/build-ai-chat.ts --check    build in memory, assert the budget; writes nothing
 *
 * Why this is not a frappe `*.bundle.ts`: frappe bundles every entry as ONE IIFE with its
 * own esbuild 0.14, so the chat elements (~1 MB gzip with their per-component SCSS strings,
 * tiptap and the CodeMirror language packs) would cost twice the whole desk bundle before
 * the first click. A split ESM build defers the editor, the table runtime and every code
 * language to the moment a message needs them; the first open is the entry's static
 * closure, held under BUDGET_GZIP below. The loader (anatomy/shell/assistant.ts) reads
 * manifest.json and import()s the entry, so the output is deliberately not an assets.json
 * key and nothing in it may be named `*.bundle.*` (frappe's update_assets_obj indexes those).
 *
 * esbuild is this app's own devDependency (0.28), not frappe's. It is given NO tsconfig:
 * tsconfig.base.json maps two @carbon/ai-chat-components entry points to an empty .d.ts so
 * the type checker can pass, and esbuild honours `paths`, so handing it a tsconfig that
 * extends the base would bundle the empty module instead of the real elements. Left alone it
 * finds REPO/tsconfig.json, a solution file with no `paths`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import * as sass from "sass";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(appRoot, "carbon_frappe", "public");
const entryFile = path.join(publicDir, "js", "ai_chat", "entry.ts");
const scssFile = path.join(publicDir, "scss", "ai_chat", "chat.scss");
const outDir = path.join(publicDir, "dist", "ai_chat");
const manifestPath = path.join(outDir, "manifest.json");

/** Gzip ceiling for everything the browser fetches before the chat can open (JS and CSS). */
const BUDGET_GZIP = 400 * 1024;

/**
 * Inputs that must never reach the first-open set. react is only a peer of the package
 * (its wrappers are not imported); tiptap arrives through prompt-line/index.js, which is why
 * register.ts deep-imports the prompt-line pieces instead.
 */
const FORBIDDEN_STATIC = [
	{ pattern: /node_modules\/react\//, label: "react" },
	{ pattern: /node_modules\/react-dom\//, label: "react-dom" },
	{ pattern: /node_modules\/@tiptap\//, label: "@tiptap" },
];

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const check = args.has("--check");
const unknown = [...args].filter((a) => a !== "--watch" && a !== "--check");
if (unknown.length || (watch && check)) {
	console.error(
		`usage: build-ai-chat.ts [--watch | --check]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`,
	);
	process.exit(2);
}

const stamp = (): string => new Date().toTimeString().slice(0, 8);
const log = (msg: string): void => console.log(`[build-ai-chat] ${msg}`);

/** A failed compile, already printed in full; carries no detail of its own. */
class BuildFailure extends Error {}

interface JsBuild {
	/** Output path relative to outDir, sourcemaps included. */
	files: Map<string, Uint8Array>;
	/** `entry.<hash>.js`. */
	entry: string;
	/** The entry plus every chunk it imports statically, transitively: the first-open set. */
	closure: string[];
	/** Bundled input paths (relative to the app root) of those closure files. */
	closureInputs: string[];
	/** Absolute paths of the first-party files the bundle read. */
	sources: string[];
}

interface CssBuild {
	name: string;
	bytes: Uint8Array;
	sources: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** What esbuild.build rejects with when the bundle has errors: the same messages it would have printed. */
function isBuildFailure(value: unknown): value is Error & { errors: esbuild.Message[] } {
	return value instanceof Error && "errors" in value && Array.isArray(value.errors);
}

const gzipSize = (bytes: Uint8Array): number => zlib.gzipSync(bytes, { level: 9 }).length;

async function printMessages(messages: esbuild.Message[], kind: "error" | "warning"): Promise<void> {
	if (!messages.length) return;
	const lines = await esbuild.formatMessages(messages, {
		kind,
		color: Boolean(process.stderr.isTTY),
		terminalWidth: 100,
	});
	for (const line of lines) console.error(line.trimEnd());
}

/**
 * Turn a finished esbuild run into the maps this script works with. The metafile is the
 * source of truth for "static": an output's `import-statement` imports load with it,
 * `dynamic-import` ones are the lazy chunks.
 */
function collect(result: esbuild.BuildResult): JsBuild {
	const { outputFiles, metafile } = result;
	if (!outputFiles || !metafile)
		throw new Error("esbuild returned no outputs (write: false, metafile: true)");

	const files = new Map<string, Uint8Array>();
	for (const file of outputFiles) files.set(path.relative(outDir, file.path), file.contents);

	const relOf = (key: string): string => path.relative(outDir, path.resolve(appRoot, key));
	// Dynamic-import targets are reported with an `entryPoint` too; only ours is the module
	// the loader import()s.
	const entryKeys = Object.entries(metafile.outputs)
		.filter(
			([, output]) =>
				output.entryPoint !== undefined && path.resolve(appRoot, output.entryPoint) === entryFile,
		)
		.map(([key]) => key);
	const entryKey = entryKeys[0];
	if (entryKeys.length !== 1 || entryKey === undefined) {
		throw new Error(`expected exactly one output for ${entryFile}, got ${entryKeys.length}`);
	}

	const seen = new Set<string>();
	const visit = (key: string): void => {
		if (seen.has(key)) return;
		seen.add(key);
		for (const imported of metafile.outputs[key]?.imports ?? []) {
			if (imported.kind === "import-statement" && !imported.external) visit(imported.path);
		}
	};
	visit(entryKey);

	const closureInputs = new Set<string>();
	for (const key of seen) {
		for (const input of Object.keys(metafile.outputs[key]?.inputs ?? {})) closureInputs.add(input);
	}
	return {
		files,
		entry: relOf(entryKey),
		closure: [...seen].map(relOf),
		closureInputs: [...closureInputs],
		sources: Object.keys(metafile.inputs)
			.filter((input) => !input.includes("node_modules/"))
			.map((input) => path.resolve(appRoot, input)),
	};
}

const jsOptions: esbuild.BuildOptions = {
	absWorkingDir: appRoot,
	entryPoints: [entryFile],
	bundle: true,
	format: "esm",
	splitting: true,
	platform: "browser",
	target: "es2022",
	minify: !watch,
	sourcemap: true,
	outdir: outDir,
	entryNames: "[name].[hash]",
	chunkNames: "chunks/[name]-[hash]",
	// Lit and its dependencies branch on this; left undefined, esbuild would keep the dev paths.
	define: { "process.env.NODE_ENV": '"production"' },
	metafile: true,
	// Nothing is written by esbuild: publish() below orders the writes so a reader never sees
	// a manifest that names a file which is not there yet.
	write: false,
	logLevel: "silent",
};

async function compileJs(): Promise<JsBuild> {
	let result: esbuild.BuildResult;
	try {
		result = await esbuild.build(jsOptions);
	} catch (error) {
		if (isBuildFailure(error)) {
			await printMessages(error.errors, "error");
			throw new BuildFailure("esbuild failed");
		}
		throw error;
	}
	await printMessages(result.warnings, "warning");
	return collect(result);
}

function compileCss(): CssBuild {
	let compiled: sass.CompileResult;
	try {
		compiled = sass.compile(scssFile, {
			loadPaths: [path.join(appRoot, "node_modules"), path.join(publicDir, "scss")],
			style: "compressed",
			// @carbon/motion calls if() in the pre-1.105 spelling; that is a screenful of
			// warnings from code this app cannot change.
			silenceDeprecations: ["if-function"],
			quietDeps: true,
			sourceMap: false,
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		throw new BuildFailure("sass failed");
	}
	const bytes = Buffer.from(compiled.css);
	const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
	return {
		name: `chat.${hash}.css`,
		bytes,
		sources: compiled.loadedUrls
			.filter((url) => url.protocol === "file:")
			.map((url) => fileURLToPath(url))
			.filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`)),
	};
}

/** The loader's own acceptance test (assistant_gate.ts parseManifest), restated so the check does not import anatomy code. */
const SAFE_ASSET = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.\-/]*$/;
function isLoadableManifest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const { entry, css } = value;
	return (
		typeof entry === "string" &&
		SAFE_ASSET.test(entry) &&
		entry.endsWith(".js") &&
		typeof css === "string" &&
		SAFE_ASSET.test(css) &&
		css.endsWith(".css")
	);
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1).padStart(9);

interface Sizes {
	rows: { name: string; raw: number; gzip: number }[];
	raw: number;
	gzip: number;
	lazy: { files: number; raw: number; gzip: number };
}

function measure(js: JsBuild, css: CssBuild): Sizes {
	const rows = js.closure.map((name) => {
		const bytes = js.files.get(name) ?? new Uint8Array();
		return { name, raw: bytes.length, gzip: gzipSize(bytes) };
	});
	rows.push({ name: css.name, raw: css.bytes.length, gzip: gzipSize(css.bytes) });

	const inClosure = new Set(js.closure);
	const lazy = { files: 0, raw: 0, gzip: 0 };
	for (const [name, bytes] of js.files) {
		if (!name.endsWith(".js") || inClosure.has(name)) continue;
		lazy.files++;
		lazy.raw += bytes.length;
		lazy.gzip += gzipSize(bytes);
	}
	return {
		rows,
		raw: rows.reduce((sum, row) => sum + row.raw, 0),
		gzip: rows.reduce((sum, row) => sum + row.gzip, 0),
		lazy,
	};
}

function printSizes(sizes: Sizes): void {
	const width = Math.max(...sizes.rows.map((row) => row.name.length), 5);
	log("first open (static closure of the entry, plus the stylesheet):");
	console.log(`  ${"file".padEnd(width)}  ${"raw KB".padStart(9)}  ${"gzip KB".padStart(9)}`);
	for (const row of sizes.rows) console.log(`  ${row.name.padEnd(width)}  ${kb(row.raw)}  ${kb(row.gzip)}`);
	console.log(
		`  ${"total".padEnd(width)}  ${kb(sizes.raw)}  ${kb(sizes.gzip)}  (budget ${kb(BUDGET_GZIP).trim()} gzip)`,
	);
	console.log(
		`  ${`deferred: ${sizes.lazy.files} lazy chunks`.padEnd(width)}  ${kb(sizes.lazy.raw)}  ${kb(sizes.lazy.gzip)}`,
	);
}

function writeAtomic(file: string, bytes: Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, file);
}

/**
 * Put a finished build on disk without ever exposing a half-built directory.
 *
 * Every file but the manifest has a content hash in its name, so writing the new ones next
 * to the old ones changes nothing for a page that is mid-load. The manifest is the only
 * mutable name: it is renamed into place LAST, so a loader that reads it always finds the
 * entry and stylesheet it names. Files of earlier builds go only after that, so a rebuild
 * can never delete the entry a reader is about to fetch from a manifest it has not seen
 * replaced yet.
 */
function publish(js: JsBuild, css: CssBuild): void {
	const keep = new Set<string>([...js.files.keys(), css.name, "manifest.json"]);
	for (const [name, bytes] of js.files) {
		if (!fs.existsSync(path.join(outDir, name))) writeAtomic(path.join(outDir, name), bytes);
	}
	if (!fs.existsSync(path.join(outDir, css.name))) writeAtomic(path.join(outDir, css.name), css.bytes);

	const manifest = { entry: js.entry, css: css.name, built: new Date().toISOString() };
	writeAtomic(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`));

	const sweep = (dir: string): void => {
		for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, dirent.name);
			if (dirent.isDirectory()) {
				sweep(full);
				if (!fs.readdirSync(full).length) fs.rmdirSync(full);
			} else if (!keep.has(path.relative(outDir, full))) {
				fs.rmSync(full);
			}
		}
	};
	sweep(outDir);
}

/** Problems with the build in `js`/`css`, as a list of readable lines. */
function findProblems(js: JsBuild, css: CssBuild, sizes: Sizes): string[] {
	const problems: string[] = [];
	for (const { pattern, label } of FORBIDDEN_STATIC) {
		const hits = js.closureInputs.filter((input) => pattern.test(input));
		if (hits.length) {
			problems.push(`${label} is in the first-open set (${hits.length} input(s), e.g. ${hits[0]})`);
		}
	}
	if (sizes.gzip > BUDGET_GZIP) {
		problems.push(
			`first open is ${kb(sizes.gzip).trim()} KB gzip, over the ${kb(BUDGET_GZIP).trim()} KB budget`,
		);
	}
	for (const name of js.files.keys()) {
		if (name.includes(".bundle.")) problems.push(`output ${name} matches frappe's *.bundle.* index pattern`);
	}
	const manifest = { entry: js.entry, css: css.name };
	if (!isLoadableManifest(manifest)) {
		problems.push(`manifest ${JSON.stringify(manifest)} would be rejected by the loader (parseManifest)`);
	}
	return problems;
}

/**
 * A build already on disk that no longer matches its sources, or is broken. An absent build
 * is fine here (CI has none); audit-markup.ts reports that case for deploys.
 */
function findDistProblems(js: JsBuild, css: CssBuild): string[] {
	if (!fs.existsSync(manifestPath)) return [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		return [
			`dist/ai_chat/manifest.json is unreadable (${error instanceof Error ? error.message : String(error)})`,
		];
	}
	if (!isLoadableManifest(manifest) || !isRecord(manifest)) {
		return ["dist/ai_chat/manifest.json would be rejected by the loader (parseManifest)"];
	}
	const problems: string[] = [];
	for (const key of ["entry", "css"]) {
		const name = manifest[key];
		if (typeof name === "string" && !fs.existsSync(path.join(outDir, name))) {
			problems.push(`dist/ai_chat/manifest.json names ${key} ${name}, which does not exist`);
		}
	}
	// mtime, not hash: --watch builds unminified, so a hash comparison would call every
	// development build stale.
	const builtAt = fs.statSync(manifestPath).mtimeMs;
	const newer = [...js.sources, ...css.sources, path.join(appRoot, "yarn.lock")].filter((file) => {
		try {
			return fs.statSync(file).mtimeMs > builtAt;
		} catch {
			return false;
		}
	});
	if (newer.length) {
		problems.push(
			`dist/ai_chat is older than its sources (e.g. ${path.relative(appRoot, newer[0] ?? "")}) - run \`yarn build:chat\``,
		);
	}
	return problems;
}

async function runOnce(): Promise<number> {
	const started = Date.now();
	const js = await compileJs();
	const css = compileCss();
	const sizes = measure(js, css);
	if (check) {
		const problems = [...findProblems(js, css, sizes), ...findDistProblems(js, css)];
		printSizes(sizes);
		if (problems.length) {
			console.error(`[build-ai-chat] ${problems.length} problem(s):`);
			for (const problem of problems) console.error(`  - ${problem}`);
			return 1;
		}
		log("check passed");
		return 0;
	}
	publish(js, css);
	printSizes(sizes);
	log(`wrote ${path.relative(appRoot, outDir)}/ (${js.entry}, ${css.name}) in ${Date.now() - started} ms`);
	return 0;
}

async function runWatch(): Promise<void> {
	let js: JsBuild | null = null;
	let css: CssBuild | null = null;
	const emit = (what: string): void => {
		if (!js || !css) return;
		try {
			publish(js, css);
			log(`${stamp()} ${what}: ${js.entry}, ${css.name}`);
		} catch (error) {
			console.error(error);
		}
	};
	const rebuildCss = (): void => {
		try {
			css = compileCss();
			emit("styles rebuilt");
		} catch (error) {
			// The previous good manifest stays: a typo mid-edit must not unload the chat.
			if (!(error instanceof BuildFailure)) console.error(error);
			log(`${stamp()} styles failed, keeping the last good build`);
		}
	};

	const context = await esbuild.context({
		...jsOptions,
		plugins: [
			{
				name: "publish",
				setup(build) {
					build.onEnd(async (result) => {
						await printMessages(result.warnings, "warning");
						if (result.errors.length) {
							await printMessages(result.errors, "error");
							log(`${stamp()} script failed, keeping the last good build`);
							return;
						}
						js = collect(result);
						emit("script rebuilt");
					});
				},
			},
		],
	});
	await context.watch();
	rebuildCss();

	let timer: NodeJS.Timeout | undefined;
	const watcher = fs.watch(path.join(publicDir, "scss"), { recursive: true }, () => {
		clearTimeout(timer);
		timer = setTimeout(rebuildCss, 100);
	});

	log(`watching ${path.relative(appRoot, path.dirname(entryFile))}/ and scss/ (Ctrl+C to stop)`);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	watcher.close();
	await context.dispose();
}

try {
	if (watch) await runWatch();
	else process.exitCode = await runOnce();
} catch (error) {
	if (!(error instanceof BuildFailure)) console.error(error);
	process.exitCode = 1;
}
