/**
 * The scanners behind scripts/audit-tokens.ts checks 2 to 4.
 *
 * Frappe v16.50 moved its tokens out of SCSS into plain CSS (css/espresso/*.css)
 * and made its semantic layer a chain of `var()` aliases onto the raw ramps. The
 * theme's mapping (scss/map) is written against exactly that shape, so what these
 * functions answer is "is the shape still there, and does every name we pin still
 * exist in it". They are pure functions over text so test/unit/audit-tokens.test.ts
 * can pin them without a frappe checkout; only audit-tokens.ts touches the disk.
 */
import path from "node:path";

/** Block comments, and with `line` set `//` comments too (SCSS only: CSS has no line comments). */
export function stripComments(text: string, { line = false }: { line?: boolean } = {}): string {
	const blocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
	// `(?<![:"'(])` keeps `http://`, `url(//cdn…)` and a `//` inside a string whole.
	return line ? blocks.replace(/(?<![:"'(])\/\/[^\n]*/g, "") : blocks;
}

/**
 * Every custom property DECLARED in a stylesheet: `--x: value`. A property that is
 * only read (`var(--x)`) is not, and neither is a BEM class such as `.cds--btn:hover`,
 * which is why the name has to start a declaration.
 */
export function declaredCustomProps(css: string): Set<string> {
	const names = new Set<string>();
	for (const m of stripComments(css).matchAll(/(?:^|[\s;{])(--[a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)) {
		if (m[1] !== undefined) names.add(m[1]);
	}
	return names;
}

/** Every custom property READ with `var(--x`, fallback or not. */
export function readCustomProps(text: string): Set<string> {
	const names = new Set<string>();
	for (const m of text.matchAll(/var\(\s*(--[a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
		if (m[1] !== undefined) names.add(m[1]);
	}
	return names;
}

/**
 * The custom properties a theme partial pins by name: a declaration that opens a
 * line. A property built by interpolation (`--surface-#{$hue}-#{$n}`, the SPA and
 * zone mixins) has no literal name to pin and is not listed, by design.
 */
export function pinnedCustomProps(scss: string): Set<string> {
	const names = new Set<string>();
	for (const m of stripComments(scss, { line: true }).matchAll(
		/^[ \t]*(--[a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*:/gm,
	)) {
		if (m[1] !== undefined) names.add(m[1]);
	}
	return names;
}

/** A semantic-layer name: `--surface-*`, `--ink-*` or `--outline-*`. */
export const isSemanticName = (name: string): boolean => /^--(?:surface|ink|outline)-/.test(name);

/**
 * The `@import "…"` targets of a bundle entry, as paths from the apps root, so
 * frappe's `./desk/index` and our `frappe/public/scss/desk/index` compare equal.
 *
 * Specifiers are resolved the way sass does for these bundles: `~pkg/x` is a
 * package, `frappe/…` is an app-root path, and anything else is relative to the
 * entry's own directory (`frappe/public/scss`). Extensions are dropped, since
 * `tomorrow.css` and `tomorrow` name the same file to the importer.
 */
export function bundleImports(scss: string, entryDir: string): string[] {
	const specs: string[] = [];
	for (const m of stripComments(scss, { line: true }).matchAll(/@import\s+"([^"]+)"/g)) {
		const spec = m[1];
		if (spec === undefined) continue;
		const bare = spec.replace(/^~/, "");
		const rooted =
			spec.startsWith("~") || bare.startsWith("frappe/") ? bare : path.posix.join(entryDir, bare);
		specs.push(rooted.replace(/\.(?:scss|css)$/, ""));
	}
	return specs;
}

/** What `diffMirror` needs to know about the pair of bundles it compares. */
export interface MirrorSpec {
	/** The bundle's name: `desk`, `website`, `login`, `email`. */
	readonly bundle: string;
	/** Where frappe's entry file lives, from the apps root. */
	readonly frappeEntryDir: string;
	/** Imports the mirror leaves out on purpose (Inter, replaced by IBM Plex). */
	readonly omit?: RegExp;
}

/**
 * The imports frappe's bundle makes that ours does not.
 *
 * A mirror can be complete in two ways. It lists frappe's imports itself (desk and
 * website do, so it can add Carbon's layers between them), or it imports frappe's
 * whole bundle (login and email recompile `frappe/public/scss/<bundle>.bundle`, so
 * every import frappe adds to it arrives with it). The second needs no diff, and
 * diffing it would report every import frappe's bundle makes as "missing".
 */
export function diffMirror(frappeBundle: string, ours: string, spec: MirrorSpec): string[] {
	const ourImports = new Set(bundleImports(ours, "carbon_frappe/public/scss"));
	if (ourImports.has(`${spec.frappeEntryDir}/${spec.bundle}.bundle`)) return [];
	const missing: string[] = [];
	for (const imp of bundleImports(frappeBundle, spec.frappeEntryDir)) {
		if (spec.omit?.test(imp) || ourImports.has(imp)) continue;
		missing.push(imp);
	}
	return missing;
}

/**
 * What frappe v16.50.0 stopped importing into its desk bundle — octicons
 * (#39836), leaflet's stylesheets, now lazy-loaded (#39421), and FontAwesome
 * (#40571). Our mirror follows 16.50, so a frappe that still imports these
 * PREDATES the mirror: the cause is the pin, not N missing imports.
 */
export const REMOVED_IN_16_50 = /\/(?:fontawesome|octicons)\/|\/lib\/leaflet/;

/**
 * `diffMirror`'s findings, split into the imports frappe ADDED (each a finding)
 * and the ones it still has only because it is older than the mirror (one
 * finding about the pin, however many there are).
 */
export function splitMirrorGaps(missing: readonly string[]): { added: string[]; predatesMirror: string[] } {
	const added: string[] = [];
	const predatesMirror: string[] = [];
	for (const imp of missing) (REMOVED_IN_16_50.test(imp) ? predatesMirror : added).push(imp);
	return { added, predatesMirror };
}

/** The files sass would try for an `@import` target, extension dropped. */
export function sassImportCandidates(target: string): string[] {
	const dir = path.posix.dirname(target);
	const base = path.posix.basename(target);
	return [
		target,
		`${target}.scss`,
		`${target}.css`,
		path.posix.join(dir, `_${base}.scss`),
		path.posix.join(target, "_index.scss"),
		path.posix.join(target, "index.scss"),
	];
}

/**
 * Where one of our bundle's imports lives in a frappe checkout, from its root,
 * or `undefined` for our own partials. `~pkg/…` resolves from frappe's
 * node_modules (the sass pipeline compiling our bundles is frappe's), and so
 * does `frappe/public/node_modules/…`, a symlink to it that only `bench build`
 * creates.
 */
export function frappeImportTarget(imp: string): string | undefined {
	if (imp.startsWith("carbon_frappe/")) return undefined;
	if (imp.startsWith("frappe/public/node_modules/")) {
		return `node_modules/${imp.slice("frappe/public/node_modules/".length)}`;
	}
	return imp.startsWith("frappe/") ? imp : `node_modules/${imp}`;
}

/**
 * The imports a bundle of ours makes that a frappe checkout cannot satisfy:
 * the reverse of `diffMirror`, which only asks what frappe added. `isFile`
 * answers for a path from the checkout's root. Commented-out imports are not
 * imports.
 */
export function missingFrappeImports(ours: string, isFile: (fromFrappeRoot: string) => boolean): string[] {
	const missing: string[] = [];
	for (const imp of bundleImports(ours, "carbon_frappe/public/scss")) {
		const target = frappeImportTarget(imp);
		if (target !== undefined && !sassImportCandidates(target).some(isFile)) missing.push(imp);
	}
	return missing;
}

/**
 * Whether the semantic layer is still a chain of aliases onto the ramps.
 *
 * Returns the semantic names frappe declares as something other than `var(…)`
 * (a hex, an `rgb()`), which are the ones the ramp remap cannot reach. An empty
 * list is the premise the theme's map layer is built on; before v16.50 every
 * semantic name was a literal and each had to be pinned by hand.
 */
export function literalSemanticNames(colorsCss: string): string[] {
	const literals: string[] = [];
	for (const m of stripComments(colorsCss).matchAll(
		/(?:^|[\s;{])(--(?:surface|ink|outline)-[a-z0-9-]+)\s*:\s*([^;}]+)/g,
	)) {
		const [, name, value] = m;
		if (name !== undefined && value !== undefined && !/^\s*var\(/.test(value)) literals.push(name);
	}
	return literals;
}

/** The semantic names that must read as `var(--<hue>-<step>)` for the remap to reach them. */
export const RAMP_CHAIN_PROBES: readonly (readonly [name: string, pattern: RegExp])[] = [
	["--surface-gray-2", /--surface-gray-2\s*:\s*var\(--gray-\d+\)/],
	["--ink-gray-8", /--ink-gray-8\s*:\s*var\(--gray-\d+\)/],
	["--outline-gray-2", /--outline-gray-2\s*:\s*var\(--gray-\d+\)/],
	["--surface-red-2", /--surface-red-2\s*:\s*var\(--red-\d+\)/],
	["--ink-red-8", /--ink-red-8\s*:\s*var\(--red-\d+\)/],
];

/**
 * The semantic names scss/map pins, and the only ones it may. These are the neutral
 * ROLES that must land on an exact Carbon token; everything else in the semantic
 * layer (every chromatic slot, the other gray steps) is the ramp remap's job, and
 * a literal pin there would shadow it. See scss/map/_colors-semantic.scss.
 */
export const SEMANTIC_ROLE_PINS: readonly string[] = [
	"--surface-base",
	"--surface-gray-1",
	"--surface-sidebar",
	"--surface-elevation-1",
	"--surface-elevation-2",
	"--surface-elevation-3",
	"--ink-base",
	"--ink-gray-9",
	"--ink-gray-8",
	"--ink-gray-7",
	"--ink-gray-6",
	"--ink-gray-5",
	"--ink-gray-4",
	"--ink-gray-3",
	"--ink-blue-link",
	"--outline-base",
	"--outline-gray-1",
	"--outline-gray-2",
	"--outline-gray-3",
	"--outline-gray-4",
	"--outline-elevation-1",
	"--outline-elevation-2",
];

/** A name the theme declares that frappe v16.50 still READS but no longer declares. */
export interface Shim {
	readonly name: string;
	/** Who reads it, so the next person can tell whether the shim is still needed. */
	readonly readBy: string;
}

/**
 * The theme-owned shims. Each is consumed by frappe's own stylesheets, so dropping
 * the pin would not drop the consumer; it would leave a `var()` that resolves to
 * nothing. The audit says so when frappe starts declaring one again, and when
 * nothing reads one any more.
 */
export const SHIMS: readonly Shim[] = [
	{ name: "--invert-neutral", readBy: "buttons, icons, desktop, form (renamed --neutral-invert upstream)" },
	{ name: "--ink-white", readBy: "css/espresso/components/button.css `.es-button.btn-danger`" },
	{ name: "--surface-modal", readBy: "scss/desk/card.scss `.frappe-card`" },
	{
		name: "--border-radius",
		readBy: "frappe's controls, card, search widget, form sidebar; erpnext, hrms, print_designer",
	},
	{ name: "--border-radius-sm", readBy: "frappe's controls and form sidebar" },
	{ name: "--border-radius-md", readBy: "frappe's controls, card, arrangement editor" },
	{ name: "--border-radius-lg", readBy: "frappe's controls" },
];

/** The semantic declarations of a stylesheet, name -> value, split by which theme block carries them. */
export interface SemanticAliases {
	readonly light: ReadonlyMap<string, string>;
	readonly dark: ReadonlyMap<string, string>;
}

/**
 * Read `--surface-*` / `--ink-*` / `--outline-*` declarations out of a stylesheet.
 * A block whose selector names `[data-theme="dark"]`, `.dark` or `.cf-zone-g100` is
 * dark; one that names `:root` or `[data-theme="light"]` is light. Anything else is
 * not a theme block and is skipped. Later declarations of a name win, as they do in
 * the cascade.
 */
export function semanticAliasesByTheme(css: string): SemanticAliases {
	const light = new Map<string, string>();
	const dark = new Map<string, string>();
	for (const block of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const [, selector = "", body = ""] = block;
		const into = /\[data-theme=["']?dark["']?\]|\.dark\b|\.cf-zone-g100/.test(selector)
			? dark
			: /:root|\[data-theme=["']?light["']?\]/.test(selector)
				? light
				: undefined;
		if (into === undefined) continue;
		for (const decl of body.matchAll(/(--(?:surface|ink|outline)-[a-z0-9-]+)\s*:\s*([^;]+)/g)) {
			const [, name, value] = decl;
			if (name !== undefined && value !== undefined) into.set(name, value.trim());
		}
	}
	return { light, dark };
}

/**
 * Where `ours` (scss/map/_semantic-ramp.scss, compiled) disagrees with frappe's
 * colors.css on a name `ours` declares. The one intended difference is the "white"
 * step of the chromatic ink scale: frappe says `var(--white)`, the theme says
 * Carbon's on-color text, which is white in every theme.
 *
 * The mixins transcribe colors.css's step arithmetic, so this is what notices the
 * day frappe re-indexes the layer (as v16.50 did, and as frappe-ui's ink shift will
 * when frappe takes it) while it is still a perfectly good chain of aliases.
 */
export function diffSemanticAliases(ours: SemanticAliases, frappe: SemanticAliases): string[] {
	const differences: string[] = [];
	for (const mode of ["light", "dark"] as const) {
		for (const [name, value] of ours[mode]) {
			const theirs = frappe[mode].get(name);
			const ourValue = value.replace("var(--cds-text-on-color)", "var(--white)");
			if (theirs === undefined) differences.push(`${mode} ${name}: frappe does not declare it`);
			else if (theirs !== ourValue) differences.push(`${mode} ${name}: ${value}, frappe has ${theirs}`);
		}
	}
	return differences;
}
