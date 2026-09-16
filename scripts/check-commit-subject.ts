#!/usr/bin/env node
// The one rule this repo adds on top of conventional commits: the major
// never moves through a commit subject. `carbon_frappe@16.x` means "the
// theme for frappe v16" (scripts/check-frappe-major.ts), so a `feat!:` or a
// `BREAKING CHANGE:` footer — which would make release-please propose 17.0.0
// — is refused at commit time, where it is free to fix.
//
//   node scripts/check-commit-subject.ts <commit-message-file>   (the commit-msg hook)
//   node scripts/check-commit-subject.ts --subject "<subject>"   (a PR title, in CI)
import fs from "node:fs";

const args = process.argv.slice(2);
const message = args[0] === "--subject" ? (args[1] ?? "") : fs.readFileSync(args[0] ?? "", "utf8");
const subject = message.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
const problems: string[] = [];

if (/^[a-z]+(\([^)]*\))?!:/.test(subject)) problems.push(`"!" in the subject: ${subject}`);
if (/^BREAKING[ -]CHANGE:/m.test(message)) problems.push("a BREAKING CHANGE footer");

if (problems.length) {
	console.error(
		`Refusing a commit that would bump the major (${problems.join("; ")}).\n` +
			"The major is the frappe major, not this app's own: breaking changes ship as `feat:` on\n" +
			"the line they belong to. See scripts/check-frappe-major.ts.",
	);
	process.exit(1);
}
