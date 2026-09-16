#!/usr/bin/env node
// The package major must equal `frappe.major` in package.json, and both must
// be the frappe line this repo pins. Nothing else in the toolchain enforces
// that, and a conventional-commit release process breaks it on its own.
//
//   node scripts/check-frappe-major.ts                    (the prek hook, CI)
//   node scripts/check-frappe-major.ts some/package.json  (release-please's release branch)
//
// WHY. `carbon_frappe@16.x.y` means "the theme for frappe v16", the way
// erpnext, hrms and frappe-types version themselves; minor and patch are ours.
// One `feat!:` and release-please proposes 17.0.0 — a "v17 theme" that is the
// v16 code. scripts/check-commit-subject.ts refuses that at commit time; this
// is the check that runs on the version release-please actually proposes
// (release-please.yml's `guard-major`, against the release branch's
// package.json), and on every push, against three facts that must agree:
//
//   package.json  version major == frappe.major
//   flake.lock    inputs.frappe.original.ref == version-<frappe.major>
//   flake.nix     frappeVersion = "version-<frappe.major>"
//
// A genuine frappe-major bump is a deliberate act on a new version-<N>
// branch: move the flake input, set frappe.major/frappe.branch, land a
// `Release-As: N.0.0` commit. This passes once the four agree.
//
// FIXING A FAILURE from a stray `!`: land an empty commit with a
// `Release-As: 16.x.y` footer; release-please rewrites its release branch on
// the next run. Nothing needs deleting.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "package.json");

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const pkg: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
if (!isRecord(pkg)) {
	console.error(`${target} is not a JSON object`);
	process.exit(1);
}
const version = typeof pkg["version"] === "string" ? pkg["version"] : "";
const versionMajor = version.split(".")[0] ?? "";
const frappe = isRecord(pkg["frappe"]) ? pkg["frappe"] : {};
const major = String(frappe["major"] ?? "");
const branch = typeof frappe["branch"] === "string" ? frappe["branch"] : "";
const problems: string[] = [];

if (!/^\d+$/.test(versionMajor)) problems.push(`version "${version}" has no numeric major`);
if (!/^\d+$/.test(major)) problems.push(`frappe.major "${major}" is missing or not numeric`);
if (!problems.length && versionMajor !== major) {
	problems.push(`version ${version} claims to be the frappe v${versionMajor} theme, but frappe.major says v${major}`);
}
if (branch && branch !== `version-${major}`) {
	problems.push(`frappe.branch "${branch}" does not match frappe.major "${major}"`);
}

// The pin. flake.lock is not something release-please rewrites, so it is read
// from the workspace, never from the release branch's tree.
const lockPath = path.join(ROOT, "flake.lock");
if (fs.existsSync(lockPath)) {
	const lock: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	const nodes = isRecord(lock) && isRecord(lock["nodes"]) ? lock["nodes"] : {};
	const node = isRecord(nodes["frappe"]) ? nodes["frappe"] : {};
	const original = isRecord(node["original"]) ? node["original"] : {};
	const ref = typeof original["ref"] === "string" ? original["ref"] : "";
	if (ref !== `version-${major}`) {
		problems.push(`flake.lock pins frappe at "${ref}", but frappe.major is "${major}"`);
	}
}
const flakePath = path.join(ROOT, "flake.nix");
if (fs.existsSync(flakePath)) {
	const m = /frappeVersion\s*=\s*"([^"]+)"/.exec(fs.readFileSync(flakePath, "utf8"));
	if (m && m[1] !== `version-${major}`) {
		problems.push(`flake.nix says frappeVersion = "${m[1]}", but frappe.major is "${major}"`);
	}
}

if (problems.length) {
	console.error(`The package major must be the frappe major. Checked ${target}\n`);
	for (const p of problems) console.error(`  - ${p}`);
	console.error(
		"\ncarbon_frappe@X.y.z means 'the theme for frappe vX'. If release-please proposed this," +
			"\na commit carried a `!` or a `BREAKING CHANGE:` footer: land an empty commit with a" +
			"\n`Release-As: <version>` footer and it rewrites its pull request on the next run." +
			"\nMoving to a new frappe major is a new version-<N> branch; see this script's header.",
	);
	process.exit(1);
}
console.log(`ok: ${String(pkg["name"])}@${version} is the frappe v${major} theme`);
