/**
 * The icon half of the drift audit (scripts/audit-tokens.ts, checks 7-9).
 *
 * Frappe v16 removes whole icon systems between point releases (octicons
 * #39836, FontAwesome #40571, leaflet's stylesheets #39421), and the failure mode
 * is quiet: a class that used to draw something draws nothing. Three questions,
 * each answerable from source:
 *
 *   7. Are the committed generated files (js/generated/*.ts,
 *      scss/generated/_legacy-icons.scss) still what scripts/lib/icon-manifest.ts
 *      and the installed @carbon/icons would produce?
 *   8. Does every frappe sprite icon the theme still references by name exist in
 *      frappe's sprite sheets?
 *   9. Does every legacy icon-font class an installed app emits have an answer —
 *      bridged to a Carbon glyph, or deliberately skipped with a reason?
 *
 * The scanners are pure functions over text so test/unit/audit-icons.test.ts
 * can pin them without a bench; only the `audit*` entry points touch the disk.
 */
import fs from "node:fs";
import path from "node:path";
import {
	CHROME_GLYPHS,
	LEGACY_GLYPHS,
	LEGACY_UNMAPPED,
	SHELL_GLYPHS,
	type GlyphSpec,
} from "./icon-manifest.ts";
import { legacyClassName } from "./icons.ts";

type Warn = (message: string) => void;

/** `fa-lock`, `octicon-file-directory` — every legacy icon-font class name in `text`. */
export function findLegacyClassNames(text: string): Set<string> {
	const names = new Set<string>();
	for (const m of text.matchAll(/\b(?:fa|octicon)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g)) names.add(m[0]);
	return names;
}

/** Sprite ids a theme source references: `#icon-heart`, `frappe.utils.icon("square-pen")`. */
export function findSpriteReferences(text: string): Set<string> {
	const ids = new Set<string>();
	for (const m of text.matchAll(/#((?:icon|es)-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) {
		if (m[1] !== undefined) ids.add(m[1]);
	}
	for (const m of text.matchAll(/\butils\??\.icon\(\s*["']([a-z0-9-]+)["']/g)) {
		const name = m[1];
		if (name !== undefined) ids.add(name.startsWith("es-") ? name : `icon-${name}`);
	}
	return ids;
}

/** The ids a frappe sprite sheet defines: `<symbol … id="icon-heart">`. */
export function findSpriteIds(svg: string): Set<string> {
	const ids = new Set<string>();
	for (const m of svg.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)) {
		if (m[1] !== undefined) ids.add(m[1]);
	}
	return ids;
}

function walk(dir: string, skip: (name: string) => boolean): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skip(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, skip));
		else out.push(full);
	}
	return out;
}

// ---- Check 7: generated files are current ---------------------------------

function checkGlyphModule(appRoot: string, file: string, specs: readonly GlyphSpec[], warn: Warn): void {
	const abs = path.join(appRoot, "carbon_frappe", "public", "js", "generated", file);
	if (!fs.existsSync(abs)) {
		warn(`js/generated/${file} is missing — run \`yarn codegen\``);
		return;
	}
	const text = fs.readFileSync(abs, "utf-8");
	const declared = new Set<string>();
	for (const m of text.matchAll(/^export const (\w+): string/gm)) {
		if (m[1] !== undefined) declared.add(m[1]);
	}
	for (const spec of specs) {
		if (!declared.has(spec.exportName)) {
			warn(
				`icon-manifest.ts names ${spec.exportName} but js/generated/${file} lacks it — run \`yarn codegen\``,
			);
		}
	}
	const wanted = new Set(specs.map((s) => s.exportName));
	for (const name of declared) {
		if (!wanted.has(name)) {
			warn(
				`js/generated/${file} still exports ${name}, which icon-manifest.ts no longer lists — run \`yarn codegen\``,
			);
		}
	}
}

export function auditGeneratedIcons(appRoot: string, warn: Warn): void {
	const carbonIcons = path.join(appRoot, "node_modules", "@carbon", "icons");
	let version: string | undefined;
	if (fs.existsSync(path.join(carbonIcons, "package.json"))) {
		const pkg: unknown = JSON.parse(fs.readFileSync(path.join(carbonIcons, "package.json"), "utf-8"));
		if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
			version = pkg.version;
		}
	}
	if (version === undefined) {
		warn("@carbon/icons is not installed — cannot verify the generated icons");
	} else {
		for (const glyph of [...SHELL_GLYPHS, ...CHROME_GLYPHS]) {
			if (!fs.existsSync(path.join(carbonIcons, "lib", glyph.icon, `${glyph.size}.js`))) {
				warn(
					`@carbon/icons ${version} has no ${glyph.icon}/${glyph.size} (${glyph.exportName}) — renamed or removed upstream`,
				);
			}
		}
		for (const glyph of LEGACY_GLYPHS) {
			if (!fs.existsSync(path.join(carbonIcons, "lib", glyph.icon, "16.js"))) {
				warn(
					`@carbon/icons ${version} has no ${glyph.icon}/16 (.${legacyClassName(glyph)}) — renamed or removed upstream`,
				);
			}
		}
	}

	checkGlyphModule(appRoot, "shell-icons.ts", SHELL_GLYPHS, warn);
	checkGlyphModule(appRoot, "icons.ts", CHROME_GLYPHS, warn);

	const legacy = path.join(appRoot, "carbon_frappe", "public", "scss", "generated", "_legacy-icons.scss");
	if (!fs.existsSync(legacy)) {
		warn("scss/generated/_legacy-icons.scss is missing — run `yarn codegen`");
		return;
	}
	const css = fs.readFileSync(legacy, "utf-8");
	for (const glyph of LEGACY_GLYPHS) {
		if (!css.includes(`.${legacyClassName(glyph)} {\n`)) {
			warn(
				`icon-manifest.ts bridges .${legacyClassName(glyph)} but scss/generated/_legacy-icons.scss lacks it — run \`yarn codegen\``,
			);
		}
	}
	if (version !== undefined && !css.includes(`@carbon/icons ${version} `)) {
		warn(
			`scss/generated/_legacy-icons.scss was generated from another @carbon/icons than the installed ${version} — run \`yarn codegen\``,
		);
	}
}

// ---- Check 8: the theme's remaining frappe sprite references resolve ------

export function auditSpriteReferences(appRoot: string, frappeRoot: string, warn: Warn): void {
	const iconsDir = path.join(frappeRoot, "frappe", "public", "icons");
	if (!fs.existsSync(iconsDir)) {
		warn(`frappe's icon sprites are missing at ${iconsDir} — frappe restructured its icon system`);
		return;
	}
	const available = new Set<string>();
	for (const file of walk(iconsDir, () => false)) {
		if (file.endsWith(".svg"))
			for (const id of findSpriteIds(fs.readFileSync(file, "utf-8"))) available.add(id);
	}
	const jsRoot = path.join(appRoot, "carbon_frappe", "public", "js");
	const wanted = new Map<string, string>();
	for (const file of walk(
		jsRoot,
		(name) => name === "generated" || name === "ai_chat" || name === "node_modules",
	)) {
		if (!file.endsWith(".ts")) continue;
		for (const id of findSpriteReferences(fs.readFileSync(file, "utf-8"))) {
			if (!wanted.has(id)) wanted.set(id, path.relative(appRoot, file));
		}
	}
	for (const [id, file] of wanted) {
		if (!available.has(id)) {
			warn(
				`${file}: references frappe sprite #${id}, which no sprite sheet in frappe defines — it would render blank`,
			);
		}
	}
}

// ---- Check 9: every legacy class an installed app emits has an answer -----

const EMITTER_EXTENSIONS = new Set([".js", ".ts", ".vue", ".html", ".py", ".jsx", ".tsx"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "lib", ".git", "fontawesome", "octicons", "locale"]);

export function auditLegacyEmitters(frappeRoot: string, warn: Warn): void {
	const appsDir = path.dirname(frappeRoot);
	if (path.basename(frappeRoot) !== "frappe" || !fs.existsSync(appsDir)) return;

	const known = new Set([...LEGACY_GLYPHS.map(legacyClassName), ...Object.keys(LEGACY_UNMAPPED)]);
	const firstSeen = new Map<string, string>();
	for (const app of fs.readdirSync(appsDir, { withFileTypes: true })) {
		// this app's own generated stylesheet is the one place the names are meant to appear
		if (!app.isDirectory() || app.name === "carbon_frappe") continue;
		const pkg = path.join(appsDir, app.name, app.name);
		if (!fs.existsSync(pkg)) continue;
		for (const file of walk(pkg, (name) => SKIPPED_DIRS.has(name))) {
			if (!EMITTER_EXTENSIONS.has(path.extname(file)) || file.endsWith(".min.js")) continue;
			for (const name of findLegacyClassNames(fs.readFileSync(file, "utf-8"))) {
				if (!known.has(name) && !firstSeen.has(name)) firstSeen.set(name, path.relative(appsDir, file));
			}
		}
	}
	for (const [name, file] of firstSeen) {
		warn(
			`${file} emits .${name}, which frappe no longer styles and the theme neither bridges (icon-manifest.ts LEGACY_GLYPHS) nor deliberately skips (LEGACY_UNMAPPED)`,
		);
	}
}
