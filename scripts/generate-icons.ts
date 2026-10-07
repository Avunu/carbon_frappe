#!/usr/bin/env node
/**
 * Dev-time codegen: render the @carbon/icons glyphs this theme owns, as named in
 * scripts/lib/icon-manifest.ts, and emit
 *   - carbon_frappe/public/js/generated/shell-icons.ts      the UI Shell header's glyphs
 *   - carbon_frappe/public/js/generated/icons.ts            table and page chrome glyphs
 *   - carbon_frappe/public/scss/generated/_legacy-icons.scss  `.fa-*` / `.octicon-*` as masks
 * The output is committed. Run via `npm run codegen` after Carbon bumps or a
 * manifest edit.
 *
 * Why generated rather than hand-copied: every other asset in this theme is
 * sourced from an `@carbon/*` package (fonts, tokens, chart palettes), and a
 * pasted `<path d="…">` is the one thing a Carbon bump would never refresh.
 * `@carbon/icons` ships each glyph as a descriptor object; `@carbon/icon-helpers`
 * is Carbon's own renderer for it (`toString` + `getAttributes`, the same pair
 * `@carbon/icons-react`'s build uses), so the markup here is what Carbon's
 * React components would render — `focusable="false"`, `aria-hidden="true"`,
 * `fill="currentColor"`, the size attributes — not a hand-tuned lookalike.
 * Nothing from either package ships at runtime; both are devDependencies.
 *
 * Why the theme owns its icons at all: frappe v16 keeps dropping icon systems
 * from the desk (octicons #39836, FontAwesome #40571), and the theme used to
 * import whichever stylesheets frappe shipped — so each removal was a build
 * break here and blank icons everywhere else. See icon-manifest.ts.
 *
 * The TypeScript outputs are `.ts` modules for the same reason chart-palettes.ts
 * is: they are imported by the browser bundles and so belong to the browser
 * type-check program, and annotated `string` exports state the contract without
 * a hand-written `.d.ts` that could drift from what is emitted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatFiles } from "./lib/format.ts";
import { CHROME_GLYPHS, LEGACY_GLYPHS, LEGACY_UNMAPPED, SHELL_GLYPHS } from "./lib/icon-manifest.ts";
import { generatedIconFiles, legacyClassName, loadCarbonIcons } from "./lib/icons.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
	console.error(`[icons] ${message}`);
	process.exit(1);
}

/** A manifest that contradicts itself would emit a module that does not compile, or a class twice. */
function checkManifest(): void {
	const exports = new Set<string>();
	for (const glyph of [...SHELL_GLYPHS, ...CHROME_GLYPHS]) {
		if (exports.has(glyph.exportName)) fail(`duplicate export name ${glyph.exportName}`);
		exports.add(glyph.exportName);
	}
	const classes = new Set<string>();
	for (const glyph of LEGACY_GLYPHS) {
		const name = legacyClassName(glyph);
		if (classes.has(name)) fail(`duplicate legacy class .${name}`);
		if (name in LEGACY_UNMAPPED) fail(`.${name} is both bridged and listed as deliberately unmapped`);
		classes.add(name);
	}
}

checkManifest();

try {
	const carbon = loadCarbonIcons();
	const written: string[] = [];
	for (const file of generatedIconFiles(carbon)) {
		const abs = path.join(appRoot, file.path);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, file.text);
		written.push(abs);
	}
	formatFiles(...written);

	console.log(
		`[icons] ${SHELL_GLYPHS.length} shell + ${CHROME_GLYPHS.length} chrome glyphs, ` +
			`${LEGACY_GLYPHS.length} legacy classes from @carbon/icons ${carbon.version}`,
	);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
