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
 *      and the installed @carbon/icons would produce? They are regenerated in
 *      memory and compared, formatting aside.
 *   8. Does every frappe sprite icon the theme still references by name exist in
 *      frappe's sprite sheets?
 *   9. Does every legacy icon-font class an installed app emits have an answer —
 *      bridged to a Carbon glyph, or deliberately skipped with a reason — and
 *      does every answer still have an emitter?
 *
 * The scanners and the comparisons are pure functions so
 * test/unit/audit-icons.test.ts can pin them without a bench; only the `audit*`
 * entry points and `scanLegacyEmitters` touch the disk.
 */
import fs from "node:fs";
import path from "node:path";
import {
	CHROME_GLYPHS,
	LEGACY_GLYPHS,
	LEGACY_MODIFIERS,
	LEGACY_UNMAPPED,
	SHELL_GLYPHS,
} from "./icon-manifest.ts";
import { generatedIconFiles, legacyClassName, loadCarbonIcons, type CarbonIcons } from "./icons.ts";

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

/** A generated glyph module, reduced to what it states: formatting is the formatter's. */
export interface ParsedGlyphModule {
	/** The `//` comment lines that head the module. */
	header: string[];
	exports: { doc: string; name: string; value: string }[];
	/**
	 * Whatever is left once the header and the entries are taken out, minus
	 * whitespace: code the generator never writes, which the entries alone
	 * would not show.
	 */
	rest: string;
}

/** A JS string literal's value. The literals compared here are generator- or formatter-written. */
function decodeLiteral(quote: string, body: string): string {
	if (quote === '"') return JSON.parse(`"${body}"`) as string;
	return JSON.parse(`"${body.replaceAll("\\'", "'").replaceAll('"', '\\"')}"`) as string;
}

/**
 * The header comments and the `/** doc *\/ export const X: string = "…";`
 * entries of a generated glyph module. The formatter may rewrap an entry and
 * swap its quotes; neither changes what this returns.
 */
export function parseGlyphModule(text: string): ParsedGlyphModule {
	const header: string[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		if (!line.startsWith("//")) break;
		header.push(line);
	}
	const body = lines.slice(header.length).join("\n");
	const exports: ParsedGlyphModule["exports"] = [];
	// the doc comment cannot run past its own `*/`, so code wedged between two
	// entries is left over rather than swallowed into the next entry's doc
	const entry =
		/\/\*\*\s*((?:(?!\*\/)[\s\S])*?)\s*\*\/\s*export const (\w+): string =\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)');/g;
	for (const m of body.matchAll(entry)) {
		const [, doc = "", name = "", double, single] = m;
		const value = double !== undefined ? decodeLiteral('"', double) : decodeLiteral("'", single ?? "");
		exports.push({ doc, name, value });
	}
	const rest = body.replace(entry, "").replace(/\s+/g, " ").trim();
	return { header, exports, rest };
}

/** A stylesheet with every run of whitespace collapsed: what it says, not how it is laid out. */
export function normalizeStylesheet(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * How a committed generated file differs from what the generator would write
 * now, or `[]`. TypeScript modules are compared entry by entry, and anything
 * outside the header and the entries must match too; the stylesheet whole,
 * whitespace aside.
 */
export function diffGeneratedFile(file: string, expected: string, committed: string): string[] {
	if (file.endsWith(".ts")) {
		const want = parseGlyphModule(expected);
		const have = parseGlyphModule(committed);
		const problems: string[] = [];
		if (want.header.join("\n") !== have.header.join("\n")) {
			problems.push("its header (generator or @carbon/icons version) differs");
		}
		const haveByName = new Map(have.exports.map((e) => [e.name, e]));
		const wantNames = new Set(want.exports.map((e) => e.name));
		for (const e of want.exports) {
			const got = haveByName.get(e.name);
			if (got === undefined) problems.push(`${e.name} is missing`);
			else if (got.value !== e.value) problems.push(`${e.name}'s markup differs`);
			else if (got.doc !== e.doc) problems.push(`${e.name}'s doc comment differs`);
		}
		for (const e of have.exports) if (!wantNames.has(e.name)) problems.push(`${e.name} is no longer listed`);
		if (have.rest !== want.rest) {
			problems.push(`it has text the generator does not write: ${JSON.stringify(have.rest.slice(0, 60))}`);
		}
		if (
			!problems.length &&
			want.exports.map((e) => e.name).join() !== have.exports.map((e) => e.name).join()
		) {
			problems.push("its exports are in another order");
		}
		return problems;
	}
	return normalizeStylesheet(expected) === normalizeStylesheet(committed) ? [] : ["its rules differ"];
}

export function auditGeneratedIcons(appRoot: string, warn: Warn): void {
	let carbon: CarbonIcons;
	try {
		carbon = loadCarbonIcons();
	} catch (error) {
		warn(
			`@carbon/icons is not usable (${error instanceof Error ? error.message : String(error)}) — cannot verify the generated icons`,
		);
		return;
	}
	// Every glyph the manifest names must exist before the files can be rebuilt;
	// a Carbon rename is reported by name rather than as a stale file.
	let renderable = true;
	const specs = [
		...[...SHELL_GLYPHS, ...CHROME_GLYPHS].map((g) => ({ spec: g, label: g.exportName })),
		...LEGACY_GLYPHS.map((g) => ({
			spec: { icon: g.icon, size: 16 as const },
			label: `.${legacyClassName(g)}`,
		})),
	];
	for (const { spec, label } of specs) {
		try {
			carbon.render(spec);
		} catch {
			renderable = false;
			warn(
				`@carbon/icons ${carbon.version} has no ${spec.icon}/${spec.size} (${label}) — renamed or removed upstream`,
			);
		}
	}
	if (!renderable) return;

	for (const file of generatedIconFiles(carbon)) {
		const abs = path.join(appRoot, file.path);
		const shown = path.relative(path.join(appRoot, "carbon_frappe", "public"), abs);
		if (!fs.existsSync(abs)) {
			warn(`${shown} is missing — run \`yarn codegen\``);
			continue;
		}
		const problems = diffGeneratedFile(file.path, file.text, fs.readFileSync(abs, "utf-8"));
		if (problems.length) {
			warn(
				`${shown} is not what icon-manifest.ts and @carbon/icons ${carbon.version} generate (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""}) — run \`yarn codegen\``,
			);
		}
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
/**
 * Directories that hold no source an app runs. Not `lib`: frappe's
 * public/js/lib is vendored, but the desk runs it (the Geolocation field's
 * locate control emits `fa fa-map-marker` from there). Minified files are
 * skipped by name instead.
 */
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", "fontawesome", "octicons", "locale"]);

/** An installed app: its name, and the checkout that holds its `<name>/` package. */
export interface AppCheckout {
	name: string;
	root: string;
}

/** What check 9 found: the apps it read, and per class, the first file in each app that emits it. */
export interface LegacyScan {
	scanned: string[];
	emitted: Map<string, Map<string, string>>;
}

/**
 * Read every app's package for legacy class names. `shownFrom` is the directory
 * file paths are reported relative to.
 */
export function scanLegacyEmitters(apps: readonly AppCheckout[], shownFrom: string): LegacyScan {
	const emitted = new Map<string, Map<string, string>>();
	const scanned: string[] = [];
	for (const app of apps) {
		const pkg = path.join(app.root, app.name);
		if (!fs.existsSync(pkg)) continue;
		scanned.push(app.name);
		for (const file of walk(pkg, (name) => SKIPPED_DIRS.has(name))) {
			if (!EMITTER_EXTENSIONS.has(path.extname(file)) || file.endsWith(".min.js")) continue;
			for (const name of findLegacyClassNames(fs.readFileSync(file, "utf-8"))) {
				let byApp = emitted.get(name);
				if (byApp === undefined) emitted.set(name, (byApp = new Map()));
				if (!byApp.has(app.name)) byApp.set(app.name, path.relative(shownFrom, file));
			}
		}
	}
	return { scanned, emitted };
}

/** The manifest's answer for each class: the apps it says emit it. */
export function legacyAnswers(): Map<string, readonly string[]> {
	return new Map<string, readonly string[]>([
		...LEGACY_GLYPHS.map((g): [string, readonly string[]] => [legacyClassName(g), g.apps]),
		...Object.entries(LEGACY_UNMAPPED).map(([name, u]): [string, readonly string[]] => [name, u.apps]),
	]);
}

/**
 * Everything wrong between a scan and the manifest, for the apps the scan read:
 * a class with no answer, an emitter its entry does not name, and an entry (or
 * one app of it) that nothing emits any more. Apps the scan did not read are
 * neither confirmed nor refuted.
 */
export function legacyEmitterFindings(
	scan: LegacyScan,
	answers: ReadonlyMap<string, readonly string[]> = legacyAnswers(),
	modifiers: readonly string[] = LEGACY_MODIFIERS,
): string[] {
	const findings: string[] = [];
	const scanned = new Set(scan.scanned);
	for (const [name, byApp] of scan.emitted) {
		if (modifiers.includes(name)) continue;
		const apps = answers.get(name);
		for (const [app, file] of byApp) {
			if (apps === undefined) {
				findings.push(
					`${file} emits .${name}, which frappe no longer styles and the theme neither bridges (icon-manifest.ts LEGACY_GLYPHS) nor deliberately skips (LEGACY_UNMAPPED)`,
				);
			} else if (!apps.includes(app)) {
				findings.push(
					`${file} emits .${name}, but its icon-manifest.ts entry names only ${apps.join(", ")} — add ${app} to its apps`,
				);
			}
		}
	}
	for (const [name, apps] of answers) {
		const byApp = scan.emitted.get(name);
		for (const app of apps) {
			if (scanned.has(app) && !byApp?.has(app)) {
				findings.push(
					`icon-manifest.ts says ${app} emits .${name}, but nothing in ${app} does any more — drop ${app} from its apps (and the entry, once no app is left)`,
				);
			}
		}
	}
	return findings;
}

/**
 * The frappe apps flake.lock pins (frappe, erpnext, hrms): the ones CI checks
 * out, so the ones check 9 must always see.
 */
export function pinnedFrappeApps(flakeLock: unknown): string[] {
	if (typeof flakeLock !== "object" || flakeLock === null || !("nodes" in flakeLock)) return [];
	const nodes = flakeLock.nodes;
	if (typeof nodes !== "object" || nodes === null) return [];
	const apps: string[] = [];
	for (const node of Object.values(nodes)) {
		if (typeof node !== "object" || node === null || !("locked" in node)) continue;
		const locked = node.locked;
		if (
			typeof locked === "object" &&
			locked !== null &&
			"owner" in locked &&
			locked.owner === "frappe" &&
			"repo" in locked &&
			typeof locked.repo === "string"
		) {
			apps.push(locked.repo);
		}
	}
	return apps.sort();
}

/**
 * Check 9 against the apps installed next to frappe. When FRAPPE_PATH is not an
 * `apps/frappe` checkout there is no apps directory to read, so only frappe is
 * scanned; either way the audit says what it read, and fails if an app in
 * `pinnedApps` is not among it. The caller passes flake.lock's apps only under
 * --strict: a frappe-only bench is a valid install, not drift.
 */
export function auditLegacyEmitters(
	frappeRoot: string,
	pinnedApps: readonly string[],
	warn: Warn,
	log: (message: string) => void = console.log,
): void {
	const appsDir = path.dirname(frappeRoot);
	let apps: AppCheckout[];
	if (path.basename(frappeRoot) === "frappe") {
		apps = fs
			.readdirSync(appsDir)
			// this app's own generated stylesheet is the one place the names are meant to appear;
			// an entry that is not an app (no `<name>/<name>/` package) is skipped by the scan
			.filter((name) => name !== "carbon_frappe")
			.map((name) => ({ name, root: path.join(appsDir, name) }));
	} else {
		log(
			`[audit] check 9: ${frappeRoot} is not an apps/frappe checkout, so no sibling apps can be found — scanning frappe alone`,
		);
		apps = [{ name: "frappe", root: frappeRoot }];
	}
	const scan = scanLegacyEmitters(apps, appsDir);
	for (const app of pinnedApps) {
		if (!scan.scanned.includes(app)) {
			warn(
				`check 9 cannot read ${app}, which flake.lock pins: no ${app} checkout next to frappe in ${appsDir} — the icon-manifest.ts entries it emits go unchecked`,
			);
		}
	}
	const named = new Set([...legacyAnswers().values()].flat());
	const unverified = [...named].filter((a) => !scan.scanned.includes(a)).sort();
	log(
		`[audit] check 9 scanned ${scan.scanned.sort().join(", ") || "nothing"}` +
			(unverified.length ? `; not installed here, so unverified: ${unverified.join(", ")}` : ""),
	);
	for (const finding of legacyEmitterFindings(scan)) warn(finding);
}
