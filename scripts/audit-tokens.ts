#!/usr/bin/env node
/**
 * Drift audit — runs warn-only on every `bench build` (via the package
 * `build` script) and strict in CI (`yarn audit:drift`). Nine checks:
 *
 *  1. Carbon token references: every `var(--cds-*)` we reference (without a
 *     fallback) must exist in @carbon/themes' emitted token set.
 *  2. Frappe variable pins: every custom property scss/map pins should still be
 *     declared by frappe (css/espresso/*.css and the SCSS partials), or be a
 *     documented shim of a name frappe still READS but no longer declares.
 *  3. Shadow mirrors: the frappe SCSS entry files our shadow bundles
 *     recompile must still exist; the import list of each of frappe's four
 *     bundles (desk, website, login, email) is diffed against our mirror
 *     (catches new imports we should add), and every file our bundles import
 *     from frappe — its source, or a package in its node_modules — must still
 *     exist (catches imports frappe REMOVED — the octicons/FontAwesome/leaflet
 *     break).
 *  4. Mapping premises: the g10 light theme, the semantic role pins and the
 *     ramp-primary colour mechanism, bare `--radius`, the g100 zone.
 *  5. JS hooks: the frappe runtime shapes the theme monkey-patches.
 *  6. Carbon class names: every `cds--*` class the theme's SCSS or JS emits or
 *     targets still exists in @carbon/styles (catches Carbon renames).
 *  7. Generated icons: js/generated/{shell-icons,icons}.ts and
 *     scss/generated/_legacy-icons.scss are what scripts/lib/icon-manifest.ts
 *     and the installed @carbon/icons generate (rebuilt in memory, compared
 *     formatting aside).
 *  8. Sprite references: the frappe sprite icons the theme still names exist.
 *  9. Legacy icon classes: every `fa-*` / `octicon-*` an installed app emits is
 *     bridged to a Carbon glyph or deliberately skipped (icon-manifest.ts), and
 *     every entry there still has the emitters it names. Every app flake.lock
 *     pins must be installed next to frappe for this check to pass.
 *
 * Exit code: 0 in --warn-only, 1 in --strict when any check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
	auditGeneratedIcons,
	auditLegacyEmitters,
	auditSpriteReferences,
	pinnedFrappeApps,
} from "./lib/audit-icons.ts";
import {
	RAMP_CHAIN_PROBES,
	SEMANTIC_ROLE_PINS,
	SHIMS,
	declaredCustomProps,
	diffMirror,
	diffSemanticAliases,
	isSemanticName,
	literalSemanticNames,
	missingFrappeImports,
	pinnedCustomProps,
	readCustomProps,
	semanticAliasesByTheme,
	splitMirrorGaps,
} from "./lib/audit-tokens.ts";

const require = createRequire(import.meta.url);
const strict = process.argv.includes("--strict");

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frappeRoot = process.env.FRAPPE_PATH || path.resolve(appRoot, "..", "frappe");
const scssRoot = path.join(appRoot, "carbon_frappe", "public", "scss");

let failures = 0;
const warn = (msg: string): void => {
	console.warn(`[audit] ${msg}`);
	failures++;
};

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
}

const ourScss = walk(scssRoot)
	.filter((f) => f.endsWith(".scss"))
	.map((f) => ({ file: path.relative(appRoot, f), text: fs.readFileSync(f, "utf-8") }));

// ---- Check 4: the mapping premises actually hold -------------------------
// Runs BEFORE the frappe early-exit — it only inspects our own sources. (4b, further
// down, asks frappe the same premises' other half.) Each premise is a fault this
// theme has already had once, written down as a comment that was false:
//
// (1) Colour is RAMP-PRIMARY. Since v16.50 frappe's semantic layer
//     (--surface-*/--ink-*/--outline-*) is a chain of var() aliases onto the raw
//     ramps, so the ramp remap reaches every chromatic slot and legacy tint, and
//     scss/map pins only the neutral ROLES that need an exact Carbon token
//     (SEMANTIC_ROLE_PINS). Before v16.50 the layer was literal hex and every slot
//     was pinned by hand, against indices that v16.50 then re-numbered, which left
//     the old pins mis-targeted (`--surface-gray-5` meant another colour) without
//     any error. So a role pin that disappears (the neutral ladder falls back to
//     the ramp, wrong in dark) and a chromatic pin that appears (it shadows the
//     remap and drifts from it) both fail here. The SPA partial is exempt: it
//     declares frappe-ui's literal names on purpose.
// (2) Radii are squared at the names frappe reads. Bare `--radius` is Bootstrap's
//     `$border-radius`, `$input-border-radius` and 178 rules; the numbered
//     `--radius-N` scale is the es-* components' and frappe-ui's.
const allScssText = ourScss.map((s) => s.text).join("\n");
const mapPartials = ourScss.filter(
	({ file }) => file.includes(`scss${path.sep}map${path.sep}`) && !file.endsWith("-spa.scss"),
);
const mapPins = new Set<string>();
for (const { text } of mapPartials) {
	for (const name of pinnedCustomProps(text)) mapPins.add(name);
}
for (const role of SEMANTIC_ROLE_PINS) {
	if (!mapPins.has(role)) {
		warn(
			`scss/map no longer pins ${role} — that neutral role would fall back to the ramp, which is wrong on g100`,
		);
	}
}
for (const pin of mapPins) {
	if (isSemanticName(pin) && !SEMANTIC_ROLE_PINS.includes(pin) && !SHIMS.some((s) => s.name === pin)) {
		warn(
			`scss/map pins ${pin}, which is not a neutral role in SEMANTIC_ROLE_PINS — frappe aliases the semantic layer onto the ramp, so the ramp remap colours it, and a literal pin shadows the remap; add it there only if Carbon names a role for it`,
		);
	}
}
if (!/--radius-\d+\s*:/.test(allScssText)) {
	warn("--radius-* is not declared — frappe-ui SPA and es-* component rounding would not be squared");
}
if (!/^\s*--radius\s*:/m.test(allScssText)) {
	warn(
		"bare --radius is not pinned — Bootstrap's $border-radius and ~180 frappe rules keep the 8px rounding",
	);
}
// (3) the light theme must be g10, not White. Their token KEY sets are
// identical, so check 1 cannot tell them apart — but their values invert the
// background/layer ladder, which every surface rule in scss/desk and scss/web
// is written against. Pin the premise here so the SCSS and this script can't
// drift apart silently.
if (!/@include\s+theme\.theme\(\s*themes\.\$g10\s*\)/.test(allScssText)) {
	warn("light theme is not themes.$g10 — the background/layer ladder assumed by scss/desk would be inverted");
}
// (4) the UI Shell zone must SHARE the g100 emission. desk/_ui-shell.scss and
// js/anatomy/ui_shell.ts both assume `.cf-zone-g100` carries every g100 token;
// a second `theme.theme()` emission would also cost ~20 KB, and a dropped
// selector would leave the header on the page theme with no error anywhere.
if (!/\.cf-zone-g100\s*\{\s*@include\s+theme\.theme\(\s*themes\.\$g100\s*\)/.test(allScssText)) {
	warn(
		"`.cf-zone-g100` does not share the themes.$g100 emission in scss/carbon/_themes.scss — the UI Shell header would render in the page theme",
	);
}

// ---- Check 6: Carbon class names still exist in @carbon/styles -----------
// The theme emits Carbon's own light-DOM markup (the table engine, the UI
// Shell header) and targets those classes from SCSS. Carbon writes every class
// as `.#{$prefix}--<suffix>`, so the suffix appears literally in its sources;
// if a rename drops one, the component silently reverts to unstyled markup.
// Both the SCSS and the browser JS are scanned, because the JS is where most
// of the shell's classes are written.
{
	const stylesRoot = path.join(appRoot, "node_modules", "@carbon", "styles", "scss");
	const jsRoot = path.join(appRoot, "carbon_frappe", "public", "js");
	if (!fs.existsSync(stylesRoot)) {
		warn("@carbon/styles is not installed — cannot verify Carbon class names");
	} else {
		const carbonScss = walk(stylesRoot)
			.filter((f) => f.endsWith(".scss"))
			.map((f) => fs.readFileSync(f, "utf-8"))
			.join("\n");
		const ours = [
			...ourScss.map((s) => s.text),
			...walk(jsRoot)
				.filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
				.map((f) => fs.readFileSync(f, "utf-8")),
		].join("\n");
		// Classes @carbon/react renders that @carbon/styles never emits (the
		// mixin exists; the class does not), and the interpolated layer classes.
		const allow = new Set(["text-truncate--end", "layer-one", "layer-two", "layer-three"]);
		const seen = new Set<string>();
		for (const m of ours.matchAll(/\bcds--([a-z0-9]+(?:[-_]+[a-z0-9]+)*)/g)) {
			const suffix = m[1];
			if (suffix === undefined || seen.has(suffix) || allow.has(suffix)) continue;
			seen.add(suffix);
			if (!carbonScss.includes(`--${suffix}`)) {
				warn(
					`cds--${suffix} is not emitted by @carbon/styles — Carbon renamed or removed it; the markup that carries it is now unstyled`,
				);
			}
		}
	}
}

// ---- Check 7: the generated icon files are current ------------------------
// Runs before the frappe early-exit: it only needs this app and @carbon/icons.
auditGeneratedIcons(appRoot, warn);

if (!fs.existsSync(path.join(frappeRoot, "frappe", "public", "scss"))) {
	console.log(`[audit] frappe not found at ${frappeRoot} — skipping frappe-drift checks (set FRAPPE_PATH)`);
	process.exit(strict ? (failures ? 1 : 0) : 0);
}

// ---- Check 5: JS hooks the theme monkey-patches still exist ---------------
// These are the only places this app reaches past CSS into frappe's runtime.
// A rename upstream makes the patch a silent no-op — the theme keeps loading,
// the styling just quietly stops applying — so assert the shapes we depend on.

/**
 * A shape that must still be present in the frappe source, paired with what
 * breaks when it is not. Written as a row rather than an object because
 * inference widens a `[RegExp, string]` row to `(string | RegExp)[]`, which
 * costs the `re.test()` below the very narrowing the row already states.
 */
type HookTest = readonly [pattern: RegExp, what: string];

/** A frappe file this theme reaches into, and the shapes it must still contain. */
interface JsHook {
	readonly file: string;
	readonly tests: readonly HookTest[];
}

const jsHooks: readonly JsHook[] = [
	{
		file: "frappe/public/js/frappe/form/formatters.js",
		tests: [
			[/_right:\s*function/, "frappe.form.formatters._right (carbon_desk.bundle.js tags its output)"],
			[
				/text-align:\s*right/,
				"_right's inline-style wrapper (the CSS fallback selector matches it literally)",
			],
			[/\bDate:\s*function/, "frappe.form.formatters.Date (wrapped for mono dates)"],
		],
	},
	{
		file: "frappe/public/js/frappe/list/list_view.js",
		tests: [[/is_numeric_field\(.*\)\s*\?\s*"text-right"/, ".list-row-col.text-right (numeric list cells)"]],
	},
	{
		file: "frappe/public/js/frappe/ui/theme_switcher.js",
		tests: [[/setAttribute\(\s*["']data-theme["']/, "data-theme attribute write (chart re-theme observer)"]],
	},
];
for (const { file, tests } of jsHooks) {
	const abs = path.join(frappeRoot, file);
	if (!fs.existsSync(abs)) {
		warn(`frappe js hook source missing: ${file} (frappe restructured?)`);
		continue;
	}
	const text = fs.readFileSync(abs, "utf-8");
	for (const [re, what] of tests) {
		if (!re.test(text)) warn(`${file}: no longer matches ${re} — ${what} would silently stop applying`);
	}
}

// ---- Check 1: --cds-* references exist in @carbon/themes ------------------

/**
 * The two members of @carbon/themes this check uses. `createRequire` answers
 * `any`, so the module is narrowed at the boundary rather than trusted: an
 * upgrade that drops either member then fails here, saying so, instead of
 * inside `Object.keys` with a bare "cannot convert undefined to object".
 */
interface CarbonThemes {
	/** The g10 theme — one camelCase key per token. Only the keys are read. */
	readonly g10: Readonly<Record<string, unknown>>;
	/** camelCase token key -> the suffix that follows `--cds-` in emitted CSS. */
	formatTokenName(key: string): string;
}

const isCarbonThemes = (value: unknown): value is CarbonThemes =>
	typeof value === "object" &&
	value !== null &&
	"g10" in value &&
	typeof value.g10 === "object" &&
	value.g10 !== null &&
	"formatTokenName" in value &&
	typeof value.formatTokenName === "function";

const themes: unknown = require("@carbon/themes");
if (!isCarbonThemes(themes)) {
	throw new Error("@carbon/themes no longer exports both `g10` and `formatTokenName` — check 1 cannot run");
}
const cdsTokens = new Set(Object.keys(themes.g10).map((k) => themes.formatTokenName(k)));
for (const { file, text } of ourScss) {
	// var(--cds-name) without a fallback (a fallback makes missing tokens safe)
	for (const m of text.matchAll(/var\(--cds-([a-z0-9-]+)\)/g)) {
		// The group is not optional, so a match always carries it. The guard is
		// what noUncheckedIndexedAccess asks for, not a case that can occur.
		const token = m[1];
		if (token === undefined) continue;
		if (!cdsTokens.has(token)) {
			warn(`${file}: var(--cds-${token}) is not a @carbon/themes token`);
		}
	}
}

// ---- Is this a frappe the token mapping can be checked against? -----------
// The map layer targets the Espresso v2 tokens frappe shipped in v16.50: plain CSS
// under public/css/espresso, a semantic layer that is a chain of var() aliases onto
// the raw ramps. An older frappe has neither, and every per-token finding against
// it would be one more way of saying "the pin is old" — so checks 2 and 4b are
// skipped for it, and the pin is reported once, with check 3's.
const frappePublic = path.join(frappeRoot, "frappe", "public");
const espressoDir = path.join(frappePublic, "css", "espresso");
const hasEspressoV2 = fs.existsSync(path.join(espressoDir, "colors.css"));

// ---- Check 2: frappe still declares the vars we pin -----------------------
// Frappe v16.50 declares its custom properties in TWO places: plain CSS under
// public/css (css/espresso/*.css is the source of truth for the colour, effect,
// radius, spacing and typography scales and for the legacy aliases) and the SCSS
// partials under public/scss that own the component-level ones (css_variables,
// dark, sidebar, dock, frappe_datatable, ...). Both are read, recursively. This
// check used to read only scss/espresso/_*.scss, which now do nothing but `@import`
// the CSS files, so it reported every Espresso token as removed.
const bootstrapVarNames = new Set(["--primary", "--secondary", "--danger", "--light", "--dark"]);
const frappeVars = new Set<string>(bootstrapVarNames);
// What frappe's own sources READ, for the shim bookkeeping below.
const frappeReads = new Set<string>();
if (hasEspressoV2) {
	const sourceFiles = (dir: string, ext: RegExp): string[] =>
		fs.existsSync(dir)
			? walk(dir).filter((f) => ext.test(f) && !f.includes(`${path.sep}node_modules${path.sep}`))
			: [];
	const declaring = [
		...sourceFiles(path.join(frappePublic, "css"), /\.css$/),
		...sourceFiles(path.join(frappePublic, "scss"), /\.scss$/),
		// --charts-* are owned by the vendored frappe-charts package, not by frappe:
		// frappe's own scss re-declares only the 10 it overrides in dark mode, so
		// reading it alone would flag every other --charts-* var as nonexistent.
		// The dist CSS is the real authority and is what desk.bundle.scss imports.
		// Read it from frappe's own node_modules: public/node_modules is only a
		// symlink to it that `bench build` creates, so a bare checkout (CI) lacks it.
		path.join(frappeRoot, "node_modules", "frappe-charts", "dist", "frappe-charts.min.css"),
	];
	for (const f of declaring) {
		if (!fs.existsSync(f)) {
			warn(`frappe var source missing: ${path.relative(frappeRoot, f)} (frappe restructured?)`);
			continue;
		}
		const text = fs.readFileSync(f, "utf-8");
		for (const name of declaredCustomProps(text)) frappeVars.add(name);
		for (const name of readCustomProps(text)) frappeReads.add(name);
	}
	// Components in .vue files carry styles that read tokens too.
	for (const f of sourceFiles(path.join(frappePublic, "js"), /\.(?:js|vue|css)$/)) {
		for (const name of readCustomProps(fs.readFileSync(f, "utf-8"))) frappeReads.add(name);
	}
}

// vars we declare that are OURS by design, not pins of a frappe name:
// --carbon-/--chart-color-/--cds-/--font-family-mono are theme-minted (frappe has no
// mono-font token), --tw-* are Tailwind's, repointed for carbon_frappe_ui.
const ownPrefixes = ["--carbon-", "--chart-color-", "--cds-", "--font-family-mono", "--tw-"];
const isShim = (name: string): boolean => SHIMS.some((s) => s.name === name);
const semanticDeclared = hasEspressoV2
	? new Set([
			...declaredCustomProps(fs.readFileSync(path.join(espressoDir, "colors.css"), "utf-8")),
			...declaredCustomProps(fs.readFileSync(path.join(espressoDir, "legacy.css"), "utf-8")),
		])
	: new Set<string>();
if (hasEspressoV2) {
	for (const { file, text } of mapPartials) {
		for (const name of pinnedCustomProps(text)) {
			if (ownPrefixes.some((p) => name.startsWith(p)) || isShim(name)) continue;
			// The semantic layer lives in colors.css and legacy.css; a name that
			// only some SCSS partial declares is not the one the theme meant.
			if (isSemanticName(name)) {
				if (!semanticDeclared.has(name)) {
					warn(
						`${file}: pins ${name}, which css/espresso/colors.css and legacy.css no longer declare — a dead pin (if frappe still reads it, it is a shim: add it to SHIMS in scripts/lib/audit-tokens.ts)`,
					);
				}
			} else if (!frappeVars.has(name)) {
				warn(`${file}: pins ${name}, which frappe no longer declares`);
			}
		}
	}
	// A shim is a name frappe READS but no longer DECLARES. It stops being one the day
	// frappe declares the name again (the pin is then redundant, and may shadow
	// frappe's own value) or stops reading it (nothing is left to serve).
	for (const shim of SHIMS) {
		if (frappeVars.has(shim.name)) {
			warn(`${shim.name} is a theme shim but frappe declares it again — drop the shim from scss/map`);
		} else if (!frappeReads.has(shim.name)) {
			warn(
				`${shim.name} is a theme shim but frappe no longer reads it (was: ${shim.readBy}) — drop the shim`,
			);
		}
	}
}

// ---- Check 4b: frappe still has the shape check 4's premises assume --------
// The semantic layer must still be a chain of aliases onto the ramps. If frappe
// goes back to literal values the ramp remap cannot reach them, and the chromatic
// slots the map layer deliberately does not pin would silently keep Espresso's own
// colours — in both themes, with no error anywhere.
if (hasEspressoV2) {
	const colorsCss = fs.readFileSync(path.join(espressoDir, "colors.css"), "utf-8");
	for (const [name, pattern] of RAMP_CHAIN_PROBES) {
		if (!pattern.test(colorsCss)) {
			warn(
				`css/espresso/colors.css no longer declares ${name} as an alias onto the ramp — the ramp remap would not reach it`,
			);
		}
	}
	const literals = literalSemanticNames(colorsCss);
	if (literals.length) {
		warn(
			`css/espresso/colors.css declares ${literals.length} semantic name(s) as literal values (${literals.slice(0, 3).join(", ")}${literals.length > 3 ? ", …" : ""}) — the ramp remap cannot reach them; pin them in scss/map/_colors-semantic.scss`,
		);
	}
}

// ---- Check 4c: the ramp-alias transcription still equals frappe's colors.css
// scss/map/_semantic-ramp.scss rebuilds the semantic layer as aliases onto the ramps
// for the two places that cannot inherit frappe's (the SPA bundle and the UI Shell
// zone). It is colors.css's step arithmetic written as Sass, so it goes stale
// without a sound when frappe re-indexes the layer, which v16.50 did to the v16.36
// one. Compile the mixins and compare every name they declare, both themes.
/** The one member of `sass` this check uses; `createRequire` answers `any`. */
interface SassCompiler {
	compileString(
		source: string,
		options: { loadPaths: string[]; silenceDeprecations: string[] },
	): { css: string };
}
const isSassCompiler = (value: unknown): value is SassCompiler =>
	typeof value === "object" &&
	value !== null &&
	"compileString" in value &&
	typeof value.compileString === "function";
if (hasEspressoV2) {
	const sassModule: unknown = (() => {
		try {
			return require("sass");
		} catch {
			return undefined;
		}
	})();
	if (!isSassCompiler(sassModule)) {
		// sass is a pinned devDependency, so in --strict a missing one is a broken
		// install, not a reason to pass without the comparison.
		const message = "sass is not installed — cannot compare the semantic ramp aliases (check 4c)";
		if (strict) warn(message);
		else console.log(`[audit] ${message}, skipping`);
	} else {
		const compiled = sassModule.compileString(
			'@import "semantic-ramp"; :root { @include semantic-light(false); } [data-theme="dark"] { @include semantic-dark(false); }',
			{ loadPaths: [path.join(scssRoot, "map")], silenceDeprecations: ["import"] },
		).css;
		const differences = diffSemanticAliases(
			semanticAliasesByTheme(compiled),
			semanticAliasesByTheme(fs.readFileSync(path.join(espressoDir, "colors.css"), "utf-8")),
		);
		if (differences.length) {
			warn(
				`scss/map/_semantic-ramp.scss no longer matches css/espresso/colors.css on ${differences.length} name(s) (${differences.slice(0, 3).join("; ")}) — frappe re-indexed its semantic layer; update the step functions and tables there`,
			);
		}
	}
}

// ---- Check 3: shadow-mirror sources still exist; every bundle's imports diffed
const mirrored = [
	"frappe/public/scss/desk/index",
	"frappe/public/scss/website/index",
	"frappe/public/scss/login.bundle",
	"frappe/public/scss/email.bundle",
];
for (const m of mirrored) {
	const base = path.join(frappeRoot, m);
	if (!fs.existsSync(`${base}.scss`) && !fs.existsSync(path.join(base, "_index.scss"))) {
		warn(`mirrored frappe source missing: ${m} (update the shadow bundle)`);
	}
}

const predatesMirror: string[] = [];
// Each of the four shadow bundles against the frappe bundle it replaces. Desk and
// website list frappe's imports themselves, so Carbon's layers can sit between
// them; login and email import frappe's whole bundle, which carries every import
// frappe adds to it (see diffMirror). Inter is replaced by IBM Plex on purpose.
for (const bundle of ["desk", "website", "login", "email"]) {
	const frappeEntry = path.join(frappePublic, "scss", `${bundle}.bundle.scss`);
	if (!fs.existsSync(frappeEntry)) {
		warn(`frappe ${bundle}.bundle.scss is gone — the ${bundle} shadow bundle has nothing to mirror`);
		continue;
	}
	const missing = diffMirror(
		fs.readFileSync(frappeEntry, "utf-8"),
		fs.readFileSync(path.join(scssRoot, `${bundle}.bundle.scss`), "utf-8"),
		{ bundle, frappeEntryDir: "frappe/public/scss", omit: /\/fonts\/inter\// },
	);
	const gaps = splitMirrorGaps(missing);
	predatesMirror.push(...gaps.predatesMirror);
	for (const imp of gaps.added) {
		warn(`frappe ${bundle}.bundle.scss imports "${imp}" — not present in our ${bundle} mirror`);
	}
}
// One finding for "this frappe is older than the mirror", however many ways it shows.
if (predatesMirror.length || !hasEspressoV2) {
	const evidence = [
		...(predatesMirror.length
			? [
					`still imports ${predatesMirror.length} stylesheet(s) our desk mirror dropped (${predatesMirror.map((i) => path.basename(i)).join(", ")})`,
				]
			: []),
		...(hasEspressoV2 ? [] : ["has no css/espresso/colors.css (the Espresso v2 tokens)"]),
	].join(" and ");
	warn(
		`the frappe at ${frappeRoot} ${evidence}: it predates frappe v16.50.0, and the mirror and the token mapping target ≥ 16.50 — move the pin (\`nix flake update frappe\`); per-token checks are skipped for it`,
	);
}

// The reverse of the loop above: imports WE make that frappe no longer has.
// Check 3's diff only ever asked "what did frappe add"; frappe deleting a file
// (octicons #39836, FontAwesome #40571) left our mirror importing nothing, and
// the first anyone heard of it was `bench build` failing on a path the
// postcss plugin had rebased into /tmp. The packages we import through frappe
// (`~plyr`, `~frappe-charts`, highlight.js) are checked in frappe's own
// node_modules, which is where its sass pipeline finds them.
// A frappe older than the mirror lacks files the mirror imports because it has not
// got them YET (espresso_components, common/utilities): that is the pin, reported
// once above, not "removed upstream".
const isFrappeFile = (fromFrappeRoot: string): boolean => {
	const abs = path.join(frappeRoot, fromFrappeRoot);
	return fs.existsSync(abs) && fs.statSync(abs).isFile();
};
for (const file of hasEspressoV2 ? fs.readdirSync(scssRoot).filter((f) => f.endsWith(".bundle.scss")) : []) {
	for (const imp of missingFrappeImports(fs.readFileSync(path.join(scssRoot, file), "utf-8"), isFrappeFile)) {
		warn(
			imp.startsWith("frappe/") && !imp.startsWith("frappe/public/node_modules/")
				? `${file} imports "${imp}", which frappe no longer has — the bundle will not compile (removed upstream; drop the import or vendor the asset)`
				: `${file} imports "${imp}", which frappe's node_modules does not have — frappe dropped the package, or its node_modules is not installed (\`yarn --cwd ${frappeRoot} install\`); the bundle will not compile`,
		);
	}
}

// ---- Checks 8 and 9: icons the theme names, and icon classes apps emit -------
auditSpriteReferences(appRoot, frappeRoot, warn);
// A pre-16.50 frappe is already reported once above; per-class findings would
// only repeat that cause, for classes its own desk still styled.
if (predatesMirror.length === 0 && hasEspressoV2) {
	const flakeLock: unknown = JSON.parse(fs.readFileSync(path.join(appRoot, "flake.lock"), "utf-8"));
	auditLegacyEmitters(frappeRoot, pinnedFrappeApps(flakeLock), warn);
}

if (failures) {
	console.log(`[audit] ${failures} finding(s)${strict ? "" : " (warn-only)"}`);
	process.exit(strict ? 1 : 0);
}
console.log("[audit] clean");
