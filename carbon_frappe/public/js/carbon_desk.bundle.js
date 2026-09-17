// Thin entry for the desk shim — the code lives in ./carbon_desk.ts.
//
// The entry is `.js` for the same reason the other three bundles name their
// entries `.js`: frappe's esbuild keys assets.json by the ENTRY basename
// (`path.basename(info.entryPoint)`, apps/frappe/esbuild/esbuild.js:450), and
// hooks.py looks up the OUTPUT basename minus the hash (`update_assets_obj`,
// esbuild.js:181-185). With the entry named `.js`, both keying paths agree in
// every build mode — watch, full build, `--using-cached` — so the served key is
// always fresh. `resolveExtensions` is never set in esbuild's config, so the
// default (which includes `.ts`) resolves the extensionless import of the TS
// source.
import "./carbon_desk.ts";
