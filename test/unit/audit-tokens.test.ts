import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
	RAMP_CHAIN_PROBES,
	SEMANTIC_ROLE_PINS,
	SHIMS,
	bundleImports,
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
	stripComments,
} from "../../scripts/lib/audit-tokens.ts";

describe("stripComments", () => {
	it("drops block comments, and line comments only when asked", () => {
		const text = "a { /* --x: 1; */ b: c; } // --y: 2;\n";
		assert.equal(stripComments(text), "a {  b: c; } // --y: 2;\n");
		assert.equal(stripComments(text, { line: true }), "a {  b: c; } \n");
	});
	it("leaves a `//` inside a url or a string alone", () => {
		const text = 'a { background: url(http://x/y.png); content: "//"; }';
		assert.equal(stripComments(text, { line: true }), text);
	});
});

describe("declaredCustomProps", () => {
	it("lists declarations, including minified ones, and not reads", () => {
		const css = ":root{--a:1;--b-c: var(--d)}\n.x { --e : 2; color: var(--f); }";
		assert.deepEqual([...declaredCustomProps(css)].sort(), ["--a", "--b-c", "--e"]);
	});
	it("does not mistake a BEM class or a commented declaration for one", () => {
		const css = ".cds--btn:hover { color: red; }\n/* --gone: 1; */\n.es-badge--x:focus {}";
		assert.equal(declaredCustomProps(css).size, 0);
	});
});

describe("readCustomProps", () => {
	it("finds reads with or without a fallback", () => {
		const css = "a { color: var(--a); b: var( --b , 1px ); c: calc(var(--c-d) * 2); }";
		assert.deepEqual([...readCustomProps(css)].sort(), ["--a", "--b", "--c-d"]);
	});
});

describe("pinnedCustomProps", () => {
	it("lists what a partial pins by name, and skips interpolated names and comments", () => {
		const scss = `
			:root {
				--surface-base: var(--cds-background);
				// --old-pin: 1;
				--surface-#{$hue}-#{$n}: red;
				--ink-gray-4: #{c.$gray-50}; // trailing
			}
		`;
		assert.deepEqual([...pinnedCustomProps(scss)].sort(), ["--ink-gray-4", "--surface-base"]);
	});
});

describe("isSemanticName", () => {
	it("recognises the three families only", () => {
		assert.equal(isSemanticName("--surface-gray-2"), true);
		assert.equal(isSemanticName("--ink-base"), true);
		assert.equal(isSemanticName("--outline-elevation-1"), true);
		assert.equal(isSemanticName("--bg-color"), false);
		assert.equal(isSemanticName("--surfaces"), false);
	});
});

describe("bundleImports", () => {
	it("resolves frappe's relative, bare and package specifiers to paths from the apps root", () => {
		const scss = `
			@import "frappe/public/css/fonts/inter/inter.scss";
			@import "~frappe-charts/dist/frappe-charts.min";
			@import "./desk/index";
			@import "common/utilities";
			// @import "./commented-out";
			@import "frappe/public/node_modules/highlight.js/styles/tomorrow.css";
		`;
		assert.deepEqual(bundleImports(scss, "frappe/public/scss"), [
			"frappe/public/css/fonts/inter/inter",
			"frappe-charts/dist/frappe-charts.min",
			"frappe/public/scss/desk/index",
			"frappe/public/scss/common/utilities",
			"frappe/public/node_modules/highlight.js/styles/tomorrow",
		]);
	});
	it("puts our own relative imports under our own directory", () => {
		assert.deepEqual(bundleImports('@import "./carbon/fonts";', "carbon_frappe/public/scss"), [
			"carbon_frappe/public/scss/carbon/fonts",
		]);
	});
});

describe("diffMirror", () => {
	const frappeWebsite = `
		@import "./website/index";
		@import "./espresso_components";
		@import "common/utilities";
	`;
	const spec = { bundle: "website", frappeEntryDir: "frappe/public/scss" } as const;

	it("reports the imports a mirror left out (the website bundle before v16.50 was mirrored)", () => {
		const ours = '@import "frappe/public/scss/website/index";\n@import "./map";';
		assert.deepEqual(diffMirror(frappeWebsite, ours, spec), [
			"frappe/public/scss/espresso_components",
			"frappe/public/scss/common/utilities",
		]);
	});
	it("is satisfied by the same imports spelled our way, in any order", () => {
		const ours = `
			@import "frappe/public/scss/common/utilities";
			@import "frappe/public/scss/espresso_components.scss";
			@import "frappe/public/scss/website/index";
		`;
		assert.deepEqual(diffMirror(frappeWebsite, ours, spec), []);
	});
	it("needs no diff when the mirror imports frappe's whole bundle", () => {
		const frappeLogin = '@import "./desk/variables";\n@import "./a-new-import";';
		const ours = '@import "frappe/public/scss/login.bundle";';
		assert.deepEqual(
			diffMirror(frappeLogin, ours, { bundle: "login", frappeEntryDir: "frappe/public/scss" }),
			[],
		);
	});
	it("skips what the mirror replaces on purpose", () => {
		const frappeDesk = '@import "frappe/public/css/fonts/inter/inter.scss";\n@import "./desk/index";';
		const ours = '@import "frappe/public/scss/desk/index";';
		const omit = /\/fonts\/inter\//;
		assert.deepEqual(
			diffMirror(frappeDesk, ours, { bundle: "desk", frappeEntryDir: "frappe/public/scss", omit }),
			[],
		);
		assert.deepEqual(diffMirror(frappeDesk, ours, { bundle: "desk", frappeEntryDir: "frappe/public/scss" }), [
			"frappe/public/css/fonts/inter/inter",
		]);
	});
});

describe("splitMirrorGaps", () => {
	it("routes what 16.50 removed to the one pin finding, and what frappe added to a finding each", () => {
		assert.deepEqual(
			splitMirrorGaps([
				"frappe/public/css/fonts/fontawesome/font-awesome.min",
				"frappe/public/scss/octicons/octicons",
				"frappe/public/js/lib/leaflet/leaflet",
				"frappe/public/scss/desk/new_thing",
			]),
			{
				added: ["frappe/public/scss/desk/new_thing"],
				predatesMirror: [
					"frappe/public/css/fonts/fontawesome/font-awesome.min",
					"frappe/public/scss/octicons/octicons",
					"frappe/public/js/lib/leaflet/leaflet",
				],
			},
		);
	});
});

describe("missingFrappeImports", () => {
	const files = new Set([
		"frappe/public/scss/desk/_index.scss",
		"frappe/public/scss/common/_utilities.scss",
		"frappe/public/scss/login.bundle.scss",
		"node_modules/plyr/dist/plyr.css",
		"node_modules/highlight.js/styles/tomorrow.css",
	]);
	const isFile = (p: string): boolean => files.has(p);

	it("resolves frappe paths the way sass does: extension, `_partial`, `_index`", () => {
		const ours = `
			@import "frappe/public/scss/desk/index";
			@import "frappe/public/scss/common/utilities";
			@import "frappe/public/scss/login.bundle";
		`;
		assert.deepEqual(missingFrappeImports(ours, isFile), []);
	});
	it("reports a frappe file that is gone", () => {
		assert.deepEqual(missingFrappeImports('@import "frappe/public/scss/octicons/octicons";', isFile), [
			"frappe/public/scss/octicons/octicons",
		]);
	});
	it("checks `~pkg` and frappe/public/node_modules imports in frappe's own node_modules", () => {
		const ours = `
			@import "~plyr/dist/plyr";
			@import "frappe/public/node_modules/highlight.js/styles/tomorrow.css";
			@import "~frappe-charts/dist/frappe-charts.min";
		`;
		assert.deepEqual(missingFrappeImports(ours, isFile), ["frappe-charts/dist/frappe-charts.min"]);
	});
	it("ignores our own partials and commented-out imports", () => {
		const ours = `
			@import "./carbon/themes";
			// @import "frappe/public/scss/gone";
			/* @import "~gone/too"; */
		`;
		assert.deepEqual(missingFrappeImports(ours, isFile), []);
	});
});

describe("the semantic layer's shape in frappe's colors.css", () => {
	const chained = `
		:root {
			--surface-gray-2: var(--gray-100);
			--ink-gray-8: var(--gray-900);
			--outline-gray-2: var(--gray-300);
			--surface-red-2: var(--red-100);
			--ink-red-8: var(--red-700);
			--ink-red-1: var(--white);
		}
	`;
	it("recognises a var() chain onto the ramps", () => {
		assert.deepEqual(literalSemanticNames(chained), []);
		for (const [name, pattern] of RAMP_CHAIN_PROBES) assert.ok(pattern.test(chained), `${name} probe`);
	});
	it("names the slots that went back to literals, which the ramp remap cannot reach", () => {
		const literal =
			":root { --surface-gray-2: #f3f3f3; --ink-gray-8: rgb(23, 23, 23); --surface-base: var(--white); }";
		assert.deepEqual(literalSemanticNames(literal), ["--surface-gray-2", "--ink-gray-8"]);
		assert.ok(RAMP_CHAIN_PROBES.some(([, pattern]) => !pattern.test(literal)));
	});
});

describe("the theme's own semantic pins", () => {
	const mapDir = path.join(import.meta.dirname, "..", "..", "carbon_frappe", "public", "scss", "map");
	// The SPA partial declares frappe-ui's names on purpose and is not held to the roles.
	const pinned = new Set<string>();
	for (const f of fs.readdirSync(mapDir).filter((n) => n.endsWith(".scss") && !n.endsWith("-spa.scss"))) {
		for (const name of pinnedCustomProps(fs.readFileSync(path.join(mapDir, f), "utf-8"))) pinned.add(name);
	}

	it("pins every neutral role", () => {
		for (const role of SEMANTIC_ROLE_PINS) assert.ok(pinned.has(role), `${role} is not pinned in scss/map`);
	});
	it("pins no other semantic name literally: the ramp remap owns them", () => {
		const stray = [...pinned].filter(
			(name) =>
				isSemanticName(name) && !SEMANTIC_ROLE_PINS.includes(name) && !SHIMS.some((s) => s.name === name),
		);
		assert.deepEqual(stray, []);
	});
	it("lists each role and shim once, and every role is a semantic name", () => {
		assert.equal(new Set(SEMANTIC_ROLE_PINS).size, SEMANTIC_ROLE_PINS.length);
		assert.equal(new Set(SHIMS.map((s) => s.name)).size, SHIMS.length);
		assert.ok(SEMANTIC_ROLE_PINS.every(isSemanticName));
	});
	it("pins the bare radius and the shims the audit tracks", () => {
		assert.ok(pinned.has("--radius"));
		for (const shim of SHIMS)
			assert.ok(pinned.has(shim.name), `${shim.name} is a shim the theme does not pin`);
	});
});

describe("semanticAliasesByTheme and diffSemanticAliases", () => {
	const frappe = semanticAliasesByTheme(`
		:root,
		[data-theme="light"] { --surface-gray-2: var(--gray-100); --ink-red-1: var(--white); --other: 1; }
		[data-theme="dark"],
		.dark { --surface-gray-2: var(--gray-700); }
		.unrelated { --surface-gray-2: nope; }
	`);

	it("splits the names by theme block and ignores what is not a theme block", () => {
		assert.deepEqual(
			[...frappe.light],
			[
				["--surface-gray-2", "var(--gray-100)"],
				["--ink-red-1", "var(--white)"],
			],
		);
		assert.deepEqual([...frappe.dark], [["--surface-gray-2", "var(--gray-700)"]]);
	});
	it("accepts a transcription that agrees, treating Carbon's on-color text as frappe's white", () => {
		const ours = semanticAliasesByTheme(
			":root { --surface-gray-2: var(--gray-100); --ink-red-1: var(--cds-text-on-color); } .cf-zone-g100 { --surface-gray-2: var(--gray-700); }",
		);
		assert.deepEqual(diffSemanticAliases(ours, frappe), []);
	});
	it("names a re-indexed step and a name frappe dropped", () => {
		const ours = semanticAliasesByTheme(
			":root { --surface-gray-2: var(--gray-200); --surface-gray-11: var(--gray-1000); }",
		);
		assert.deepEqual(diffSemanticAliases(ours, frappe), [
			"light --surface-gray-2: var(--gray-200), frappe has var(--gray-100)",
			"light --surface-gray-11: frappe does not declare it",
		]);
	});
});

describe("scss/map/_semantic-ramp.scss", () => {
	interface SassCompiler {
		compileString(
			source: string,
			options: { loadPaths: string[]; silenceDeprecations: string[] },
		): { css: string };
	}
	// `createRequire` answers `any`; the annotation is where that stops.
	const sass: SassCompiler = createRequire(import.meta.url)("sass");
	const mapDir = path.join(import.meta.dirname, "..", "..", "carbon_frappe", "public", "scss", "map");
	const compile = (call: string): string =>
		sass.compileString(`@import "semantic-ramp"; x { ${call} }`, {
			loadPaths: [mapDir],
			silenceDeprecations: ["import"],
		}).css;

	it("climbs the ramp from 50 in light, and reads it backwards in dark", () => {
		const light = compile("@include semantic-light(false);");
		for (const line of [
			"--surface-gray-1: var(--gray-50);",
			"--surface-gray-10: var(--gray-900);",
			"--ink-gray-8: var(--gray-900);",
			"--ink-gray-9: var(--gray-950);",
			"--outline-red-10: var(--red-950);",
			"--surface-blue-6: var(--blue-500);",
		]) {
			assert.ok(light.includes(line), line);
		}
		const dark = compile("@include semantic-dark(false);");
		for (const line of [
			"--surface-gray-5: var(--gray-450);",
			"--surface-red-1: var(--red-950);",
			"--surface-red-10: var(--red-100);",
			"--ink-gray-9: var(--gray-50);",
			"--outline-blue-10: var(--blue-50);",
		]) {
			assert.ok(dark.includes(line), line);
		}
	});
	it("starts frappe's chromatic ink scale at Carbon's on-color text, and frappe-ui's at the 100 tint", () => {
		const frappeInk = compile("@include semantic-light(false); @include semantic-dark(false);");
		assert.ok(frappeInk.includes("--ink-red-1: var(--cds-text-on-color);"));
		assert.ok(frappeInk.includes("--ink-red-10: var(--red-900);"));
		assert.ok(frappeInk.includes("--ink-red-10: var(--red-50);"));
		const uiInk = compile("@include semantic-light(true); @include semantic-dark(true);");
		assert.ok(uiInk.includes("--ink-red-1: var(--red-100);"));
		assert.ok(uiInk.includes("--ink-red-9: var(--red-900);"));
		assert.ok(uiInk.includes("--ink-red-1: var(--red-800);"));
		assert.ok(uiInk.includes("--ink-red-9: var(--red-50);"));
		assert.ok(!uiInk.includes("--ink-red-10:"));
	});
});
