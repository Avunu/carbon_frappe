// Run the project's formatter over generated files, so what the codegen
// commits is what the check expects and the check stays a pure check.
// `yarn -s` resolves the pinned oxfmt from node_modules/.bin.
//
// The generated files are in [tool.frappe-nix] `generated`, so .oxfmtrc.jsonc
// ignores them, and oxfmt skips an ignored path even when it is named on the
// command line. Each file goes through stdin instead, under its bare name: the
// root config's options apply and no ignore pattern matches.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function formatFiles(...paths: string[]): void {
	for (const file of paths) {
		const formatted = execFileSync("yarn", ["-s", "oxfmt", `--stdin-filepath=${path.basename(file)}`], {
			input: readFileSync(file),
			stdio: ["pipe", "pipe", "inherit"],
		});
		writeFileSync(file, formatted);
	}
}
