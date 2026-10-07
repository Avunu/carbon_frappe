/**
 * Rendering and emitting for scripts/generate-icons.ts, kept apart from the
 * script so the pure parts (data URIs, the stylesheet, the module text) are unit
 * tested without @carbon/icons installed.
 *
 * Errors are thrown, never `process.exit`ed, so a test can assert on them; the
 * script is what turns one into an exit code.
 */
import { createRequire } from "node:module";
import type { GlyphSpec, LegacyGlyph } from "./icon-manifest.ts";

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
 * their RESULTS are what gets checked, not their parameters.
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

/** @carbon/icons, ready to render glyphs the way `@carbon/icons-react` would. */
export interface CarbonIcons {
	/** The installed `@carbon/icons` version, for the generated files' headers. */
	version: string;
	/** One glyph as an `<svg>` string. Throws if Carbon has no such descriptor. */
	render(spec: Pick<GlyphSpec, "icon" | "size" | "attrs">): string;
}

export function loadCarbonIcons(): CarbonIcons {
	const require = createRequire(import.meta.url);

	// `require()` answers `any`; taking the helpers as `unknown` and proving the
	// two functions exist is what makes the calls below checked.
	const helpersModule: unknown = require("@carbon/icon-helpers");
	const maybeToString = isRecord(helpersModule) ? helpersModule["toString"] : undefined;
	const maybeGetAttributes = isRecord(helpersModule) ? helpersModule["getAttributes"] : undefined;
	if (!isFn(maybeToString) || !isFn(maybeGetAttributes)) {
		throw new Error("@carbon/icon-helpers did not expose toString/getAttributes");
	}
	// re-bound so the narrowing reaches render() below
	const toString: LooseFn = maybeToString;
	const getAttributes: LooseFn = maybeGetAttributes;

	const pkg: unknown = require("@carbon/icons/package.json");
	const version = isRecord(pkg) && typeof pkg["version"] === "string" ? pkg["version"] : "?";

	return {
		version,
		render(spec) {
			let descriptor: unknown;
			try {
				descriptor = require(`@carbon/icons/lib/${spec.icon}/${spec.size}`);
			} catch {
				throw new Error(`@carbon/icons ${version} has no ${spec.icon}/${spec.size} descriptor`);
			}
			if (!isDescriptor(descriptor)) {
				throw new Error(`@carbon/icons ${spec.icon}/${spec.size} is not an icon descriptor`);
			}
			// getAttributes adds focusable="false", preserveAspectRatio, and
			// aria-hidden="true" when no label is given — the a11y attributes Carbon's
			// React icons carry. The extra attrs go on last so `class` survives.
			const attrs = getAttributes(descriptor.attrs);
			if (!isRecord(attrs)) throw new Error(`getAttributes returned a non-object for ${spec.icon}`);
			const svg = toString({ ...descriptor, attrs: { ...attrs, ...spec.attrs } });
			if (typeof svg !== "string" || !svg.startsWith("<svg")) {
				throw new Error(`toString did not render ${spec.icon} as an <svg>`);
			}
			return svg;
		},
	};
}

/**
 * An `<svg>` as a `data:` URI usable inside a double-quoted CSS `url("…")`.
 *
 * Only the characters that would end the URL or the document are escaped, so the
 * committed stylesheet stays readable and small; the double quotes swap to single
 * quotes, which is only safe when the markup has none of its own and no newlines.
 * Carbon's descriptors have neither, and a future one that did would throw here
 * rather than emit a corrupt URI.
 */
export function svgDataUri(svg: string): string {
	if (svg.includes("'") || svg.includes("\n")) {
		throw new Error("svgDataUri: the SVG contains a single quote or a newline");
	}
	const body = svg
		.replaceAll("%", "%25")
		.replaceAll("#", "%23")
		.replaceAll("<", "%3C")
		.replaceAll(">", "%3E")
		.replaceAll('"', "'");
	return `data:image/svg+xml,${body}`;
}

/** `fa-lock`, `octicon-file-directory`. */
export function legacyClassName(glyph: Pick<LegacyGlyph, "family" | "name">): string {
	return `${glyph.family}-${glyph.name}`;
}

/** A generated TypeScript module of `<svg>` string constants. */
export function glyphModule(opts: {
	generator: string;
	version: string;
	summary: string;
	glyphs: readonly GlyphSpec[];
	render: (spec: GlyphSpec) => string;
}): string {
	const lines: string[] = [
		`// GENERATED by ${opts.generator} — DO NOT EDIT.`,
		`// @carbon/icons ${opts.version} glyphs ${opts.summary}, rendered by`,
		'// @carbon/icon-helpers exactly as @carbon/icons-react would (focusable="false",',
		'// aria-hidden="true", fill="currentColor"). Carbon icons are Apache-2.0:',
		"// https://github.com/carbon-design-system/carbon/blob/main/LICENSE",
		"//",
		"// Annotated `string` so the module states its own contract.",
	];
	for (const glyph of opts.glyphs) {
		lines.push(`/** ${glyph.icon} ${glyph.size} — ${glyph.role}. */`);
		lines.push(`export const ${glyph.exportName}: string = ${JSON.stringify(opts.render(glyph))};`);
	}
	return lines.join("\n") + "\n";
}

/**
 * The stylesheet that keeps `<i class="fa fa-lock">` and
 * `<span class="octicon octicon-file-directory">` drawing something.
 *
 * A mask rather than a background image so the glyph takes the element's
 * `color` (`text-warning`, a button's hover colour) the way the icon font did.
 * The mask is set per class, and the shared box only on the classes that have
 * one: an unmapped `.fa-whatever` must render nothing, not a solid 1em square.
 */
export function legacyStylesheet(opts: {
	generator: string;
	version: string;
	glyphs: readonly LegacyGlyph[];
	render: (glyph: LegacyGlyph) => string;
}): string {
	const selectors = opts.glyphs.map((g) => `.${legacyClassName(g)}`);
	const out: string[] = [
		`// GENERATED by ${opts.generator} — DO NOT EDIT.`,
		"// Legacy icon-font classes, drawn with @carbon/icons " + opts.version + " glyphs. Frappe v16.50",
		"// stopped shipping the FontAwesome (#40571) and octicons (#39836) stylesheets,",
		"// but its own code and installed apps still emit these classes, so on a stock",
		"// desk they render as nothing. Each class below is a CSS mask of a Carbon",
		"// glyph, so it takes the element's `color`. The list is scripts/lib/icon-manifest.ts's",
		"// LEGACY_GLYPHS; what is deliberately absent is its LEGACY_UNMAPPED.",
		"// Carbon icons are Apache-2.0: https://github.com/carbon-design-system/carbon/blob/main/LICENSE",
		"",
		`${selectors.join(",\n")} {`,
		"\tdisplay: inline-block;",
		"\tinline-size: 1em;",
		"\tblock-size: 1em;",
		"\tvertical-align: -0.125em;",
		"\tbackground-color: currentcolor;",
		"\t-webkit-mask: var(--cf-legacy-icon) center / contain no-repeat;",
		"\tmask: var(--cf-legacy-icon) center / contain no-repeat;",
		"}",
		"",
		"// FontAwesome's fixed-width modifier (and webshop's misspelling of it).",
		".fa-fw,",
		".fa-fixed-width {",
		"\tinline-size: 1.28571429em;",
		"}",
		"",
		".fa-spin {",
		"\tanimation: cf-legacy-icon-spin 2s infinite linear;",
		"}",
		"",
		"@keyframes cf-legacy-icon-spin {",
		"\tto {",
		"\t\ttransform: rotate(360deg);",
		"\t}",
		"}",
	];
	for (const glyph of opts.glyphs) {
		out.push("", `.${legacyClassName(glyph)} {`);
		out.push(`\t// ${glyph.icon}`);
		out.push(`\t--cf-legacy-icon: url("${svgDataUri(opts.render(glyph))}");`);
		out.push("}");
	}
	return out.join("\n") + "\n";
}
