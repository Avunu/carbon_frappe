#!/usr/bin/env node
/**
 * Dev-time codegen: render the four @carbon/icons glyphs the UI Shell header
 * inlines — Menu 20, Close 20, Switcher 20, ChevronDown 16 — to SVG strings
 * and emit:
 *   - carbon_frappe/public/js/generated/shell-icons.ts
 * The output is committed. Run via `npm run codegen` after Carbon bumps.
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
 * The output is a `.ts` module for the same reason chart-palettes.ts is: it is
 * imported by carbon_anatomy.bundle.ts and so belongs to the browser
 * type-check program, and annotated `string` exports state the contract
 * without a hand-written `.d.ts` that could drift from what is emitted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** The descriptor shape `@carbon/icons/lib/<name>/<size>.js` exports. */
interface IconDescriptor {
	elem: string;
	attrs: Record<string, unknown>;
	content: unknown[];
	name: string;
	size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * `typeof v === "function"` narrows to `Function`, which has no call signature;
 * this narrows to one that takes anything, so the helpers stay callable and
 * their RESULTS are what gets checked (below), not their parameters.
 */
type LooseFn = (...args: unknown[]) => unknown;
function isFn(value: unknown): value is LooseFn {
	return typeof value === "function";
}

function isDescriptor(value: unknown): value is IconDescriptor {
	return (
		isRecord(value) &&
		value["elem"] === "svg" &&
		isRecord(value["attrs"]) &&
		Array.isArray(value["content"]) &&
		typeof value["name"] === "string" &&
		typeof value["size"] === "number"
	);
}

const require = createRequire(import.meta.url);

// `require()` answers `any`; taking the helpers as `unknown` and proving the
// two functions exist is what makes the calls below checked.
const helpersModule: unknown = require("@carbon/icon-helpers");
const maybeToString = isRecord(helpersModule) ? helpersModule["toString"] : undefined;
const maybeGetAttributes = isRecord(helpersModule) ? helpersModule["getAttributes"] : undefined;
if (!isFn(maybeToString) || !isFn(maybeGetAttributes)) {
	console.error("[shell-icons] @carbon/icon-helpers did not expose toString/getAttributes");
	process.exit(1);
}
// re-bound so the narrowing reaches render() below
const toString: LooseFn = maybeToString;
const getAttributes: LooseFn = maybeGetAttributes;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One glyph to emit: the export name, the icon, its size, and any extra `<svg>` attributes. */
interface Glyph {
	exportName: string;
	icon: string;
	size: number;
	attrs?: Record<string, string>;
	/** What the header uses it for — becomes the doc comment. */
	role: string;
}

const GLYPHS: readonly Glyph[] = [
	{ exportName: "menu20", icon: "menu", size: 20, role: "the hamburger (HeaderMenuButton)" },
	{ exportName: "close20", icon: "close", size: 20, role: "HeaderMenuButton's active-state glyph; kept so the swap is one line if the header ever hosts a dismissable overlay" },
	{ exportName: "switcher20", icon: "switcher", size: 20, role: "the app switcher action (HeaderGlobalAction)" },
	{
		exportName: "chevronDown16",
		icon: "chevron--down",
		size: 16,
		// HeaderMenu.tsx renders <ChevronDown className="cds--header__menu-arrow" />;
		// header/_header.scss rotates and tints it through that class.
		attrs: { class: "cds--header__menu-arrow" },
		role: "the sub-menu chevron (HeaderMenu), pre-classed `cds--header__menu-arrow`",
	},
];

function render(glyph: Glyph): string {
	const descriptor: unknown = require(`@carbon/icons/lib/${glyph.icon}/${glyph.size}`);
	if (!isDescriptor(descriptor)) {
		console.error(`[shell-icons] @carbon/icons has no ${glyph.icon}/${glyph.size} descriptor`);
		process.exit(1);
	}
	// getAttributes adds focusable="false", preserveAspectRatio, and
	// aria-hidden="true" when no label is given — the a11y attributes Carbon's
	// React icons carry. The extra attrs go on last so `class` survives.
	const attrs = getAttributes(descriptor.attrs);
	if (!isRecord(attrs)) {
		console.error(`[shell-icons] getAttributes returned a non-object for ${glyph.icon}`);
		process.exit(1);
	}
	const svg = toString({ ...descriptor, attrs: { ...attrs, ...(glyph.attrs ?? {}) } });
	if (typeof svg !== "string" || !svg.startsWith("<svg")) {
		console.error(`[shell-icons] toString did not render ${glyph.icon} as an <svg>`);
		process.exit(1);
	}
	return svg;
}

const iconsVersion: unknown = require("@carbon/icons/package.json");
const version = isRecord(iconsVersion) && typeof iconsVersion["version"] === "string" ? iconsVersion["version"] : "?";

const lines: string[] = [
	"// GENERATED by scripts/generate-shell-icons.ts — DO NOT EDIT.",
	`// @carbon/icons ${version} glyphs the UI Shell header inlines, rendered by`,
	"// @carbon/icon-helpers exactly as @carbon/icons-react would (focusable=\"false\",",
	"// aria-hidden=\"true\", fill=\"currentColor\"). Carbon icons are Apache-2.0:",
	"// https://github.com/carbon-design-system/carbon/blob/main/LICENSE",
	"//",
	"// Annotated `string` so the module states its own contract.",
];
for (const glyph of GLYPHS) {
	lines.push(`/** ${glyph.icon} ${glyph.size} — ${glyph.role}. */`);
	lines.push(`export const ${glyph.exportName}: string = ${JSON.stringify(render(glyph))};`);
}

const jsDir = path.join(appRoot, "carbon_frappe", "public", "js", "generated");
fs.mkdirSync(jsDir, { recursive: true });
fs.writeFileSync(path.join(jsDir, "shell-icons.ts"), lines.join("\n") + "\n");

console.log(`[shell-icons] ${GLYPHS.length} glyphs from @carbon/icons ${version}`);
