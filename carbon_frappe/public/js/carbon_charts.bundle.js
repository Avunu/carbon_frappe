// Thin entry for the chart shim — the code lives in ./carbon_charts.ts.
//
// The entry is `.js`, and that is the point: frappe's esbuild keys assets.json
// by the ENTRY basename (`path.basename(info.entryPoint)`,
// apps/frappe/esbuild/esbuild.js:450), while hooks.py's `app_include_js` and
// `include_script` look up the OUTPUT basename minus the hash
// (`update_assets_obj`, esbuild.js:181-185). A `.ts` entry wrote the key under
// `carbon_charts.bundle.ts`, so every watch-driven rebuild refreshed a key
// nothing loads while the served `.bundle.js` key silently kept its stale hash.
// With the entry named `.js`, both keying paths agree in every build mode.
// `resolveExtensions` is never set in esbuild's config, so the default (which
// includes `.ts`) resolves the extensionless import of the TS source.
import "./carbon_charts.ts";
