// Run the project's formatter over generated files, so what the codegen
// commits is what `oxfmt --check` expects and the check stays a pure check.
// `yarn -s` resolves the pinned oxfmt from node_modules/.bin.
import { execFileSync } from "node:child_process";

export function formatFiles(...paths: string[]): void {
	if (!paths.length) return;
	execFileSync("yarn", ["-s", "oxfmt", ...paths], { stdio: "inherit" });
}
