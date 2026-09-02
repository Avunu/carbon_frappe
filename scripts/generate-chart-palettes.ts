#!/usr/bin/env node
/**
 * Dev-time codegen: extract @carbon/charts' 14-series categorical palettes
 * (white + dark theme) from its scss/_color-palette.scss, resolve values via
 * @carbon/colors, and emit:
 *   - carbon_frappe/public/scss/generated/_chart-palettes.scss  ($chart-colors-light/dark)
 *   - carbon_frappe/public/js/generated/chart-palettes.ts       (ESM light/dark/heatmap)
 * Both outputs are committed. Run via `npm run codegen` after Carbon bumps.
 *
 * The JS output is a `.ts` module, not a `.js` one, because it is imported by
 * carbon_charts.bundle.ts and therefore has to be part of the browser
 * type-check program. Emitting `.js` meant either excluding `generated/` from
 * tsconfig.browser.json — which makes the import unresolvable — or shipping a
 * hand-written sibling `.d.ts` that could drift from what is actually emitted.
 * A generated `.ts` with explicit `string[]` annotations is checked like any
 * other source file, and esbuild resolves the extensionless import to it
 * unchanged (`.ts` precedes `.js` in esbuild's default resolve extensions).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Narrow a value whose properties can then be read by a key the code does not
 * know in advance. Both the @carbon/colors namespace and the scales inside it
 * are reached that way — through names captured out of the SCSS — so both pass
 * through here before they are indexed.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const require = createRequire(import.meta.url);
// `require()` answers `any`; taking it as `unknown` is what makes the lookups
// below checked. The namespace mixes the scale objects (`blue`, `blueHover`,
// …) with the flattened constants (`blue10`), and only the scales are read.
const colorsModule: unknown = require("@carbon/colors");
if (!isRecord(colorsModule)) {
	console.error("[chart-palettes] @carbon/colors did not load as an object");
	process.exit(1);
}
const colors: Record<string, unknown> = colorsModule;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(
	path.join(appRoot, "node_modules", "@carbon", "charts", "scss", "_color-palette.scss"),
	"utf-8"
);

// The two `'14': (` groups are the white-theme and dark-theme 14-series
// palettes (in source order). Take option '1' of each and resolve entries.
const groups = [...src.matchAll(/'14':\s*\(\s*'1':\s*\(([\s\S]*?)\n\t\t\)/g)].map((m) => m[1]);
// `groups.length < 2` and "either of the first two entries is missing" are the
// same condition — capture 1 is mandatory, so an entry exists exactly when a
// block was found. Checking the entries instead of the length is what tells the
// checker the two blocks handed to `resolve()` below are strings.
const [lightBlock, darkBlock] = groups;
if (lightBlock === undefined || darkBlock === undefined) {
	console.error("[chart-palettes] could not locate the two 14-series palette blocks");
	process.exit(1);
}

function resolve(block: string): string[] {
	const out: string[] = [];
	const entry = /getColorValue\((\w+),\s*(\d+)\)|(#[0-9a-fA-F]{3,8})/g;
	for (const m of block.matchAll(entry)) {
		const literal = m[3];
		if (literal) out.push(literal);
		else {
			// Every step of the lookup is open — the scale name and the shade
			// are both captured text — so each one is checked instead of
			// assumed. Anything that does not end in a hex string falls into
			// the same failure the untyped `scale?.[m[2]]` reached by
			// evaluating to `undefined`.
			const name = m[1];
			const shade = m[2];
			const scale = name === undefined ? undefined : colors[name] || colors[`${name}Hover`];
			const swatch = shade !== undefined && isRecord(scale) ? scale[shade] : undefined;
			const value = typeof swatch === "string" ? swatch : undefined;
			if (!value) {
				console.error(`[chart-palettes] cannot resolve ${name} ${shade} via @carbon/colors`);
				process.exit(1);
			}
			out.push(value);
		}
	}
	return out;
}

const light = resolve(lightBlock);
const dark = resolve(darkBlock);
// Carbon's sequential blue ramp, for heatmaps
const blue = colors["blue"];
if (!isRecord(blue)) {
	console.error("[chart-palettes] @carbon/colors has no blue scale");
	process.exit(1);
}
// The steps are read off an open record, so each one is checked here rather
// than assumed — the emitted module annotates `heatmap` as `string[]`, and this
// is what makes that annotation true of whatever @carbon/colors hands back.
const heatmap = [10, 30, 50, 60, 80].map((step) => {
	const swatch = blue[step];
	if (typeof swatch !== "string") {
		console.error(`[chart-palettes] @carbon/colors blue has no step ${step}`);
		process.exit(1);
	}
	return swatch;
});

const scssDir = path.join(appRoot, "carbon_frappe", "public", "scss", "generated");
const jsDir = path.join(appRoot, "carbon_frappe", "public", "js", "generated");
fs.mkdirSync(scssDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });

fs.writeFileSync(
	path.join(scssDir, "_chart-palettes.scss"),
	`// GENERATED by scripts/generate-chart-palettes.ts — DO NOT EDIT.
// @carbon/charts 14-series categorical palettes.
$chart-colors-light: (${light.join(", ")});
$chart-colors-dark: (${dark.join(", ")});
`
);

fs.writeFileSync(
	path.join(jsDir, "chart-palettes.ts"),
	`// GENERATED by scripts/generate-chart-palettes.ts — DO NOT EDIT.
// @carbon/charts' 14-series categorical palettes plus a 5-step sequential blue
// ramp. Annotated rather than inferred so the emitted module states its own
// contract: consumers get \`string[]\`, not a widened array of hex literals.
export const light: string[] = ${JSON.stringify(light)};
export const dark: string[] = ${JSON.stringify(dark)};
export const heatmap: string[] = ${JSON.stringify(heatmap)};
`
);

console.log(`[chart-palettes] light: ${light.length} colors, dark: ${dark.length} colors`);
