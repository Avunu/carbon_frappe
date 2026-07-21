# Carbon Frappe

A comprehensive [Carbon Design System](https://carbondesignsystem.com) (v11) theme for [Frappe](https://frappeframework.com) sites. Every surface — desk, website/portal, login, print, email, charts, and frappe-ui/Espresso components — is restyled to look as though it was designed with Carbon: IBM Plex type, square geometry, Carbon color tokens, 2px focus rings, the g100 UI Shell header, and Carbon's categorical chart palettes, all sourced from the official `@carbon/*` npm packages.

## How it works

Frappe resolves every stylesheet through `sites/assets/assets.json`, keyed by bare bundle basename. This app **shadows** frappe's own bundles: it ships same-named entries (`desk.bundle.scss`, `website.bundle.scss`, `login.bundle.scss`, `email.bundle.scss`, `print.bundle.scss`) that _recompile frappe's SCSS sources_ with Carbon values injected at compile time, then layer Carbon tokens and component overrides on top. The server is thereby forced to serve the Carbon stylesheets **instead of** frappe's — one stylesheet per surface, no double download, no cascade fights.

Three mechanisms keep the shadow deterministic:

1.  **Name collision** — this app builds after frappe, so its entries win the assets.json merge.
2.  **`scripts/patch-assets.mjs`** — runs as the app's `build` script after every full `bench build`; re-points the shadowed keys (and `rtl_` variants) at this app's compiled assets and clears the redis `assets_json` cache.
3.  **`after_migrate` hook** (`carbon_frappe.build.patch_assets`) — re-asserts the shadow after migrations, healing partial `bench build --apps frappe` runs.

Inside each bundle, the styling itself is a three-layer transposition:

-   **`scss/carbon/`** — emits Carbon's ~240 design tokens as `--cds-*` custom properties (Light → Carbon **White**, Dark → Carbon **g100**, keyed to frappe's `data-theme`), plus self-hosted IBM Plex `@font-face` rules.
-   **`scss/map/`** — transposes frappe's variable system onto Carbon: the espresso raw color ramps (`--gray-*`, `--blue-*`, …) snap to `@carbon/colors` scales (which cascades through frappe's semantic `--surface-*`/`--ink-*`/`--outline-*` layer _and_ frappe-ui's identical token names), with exact-token pins for the slots that must land on Carbon theme tokens (`--bg-color → --cds-background`, `--control-bg → --cds-field-01`, `--btn-primary → blue-60`, radii → 0, focus → 2px `$focus`, elevations → Carbon's single menu shadow, type → IBM Plex).
-   **`scss/desk/` + `scss/web/`** — Carbon component anatomy: bottom-border fields, Carbon button ramps, the black UI Shell header, side-nav selection bars, data-table headers, Carbon modals/menus/toasts/tags/tiles.

Charts get `--charts-*` theming plus `carbon_charts.bundle.js`, which wraps `frappe.Chart` and injects the authentic `@carbon/charts` 14-color categorical palettes (theme-aware, with Carbon's sequential blue ramp for heatmaps) whenever a caller doesn't pass explicit colors.

## Install

```sh
bench get-app https://github.com/Avunu/carbon-frappe
bench --site <site> install-app carbon_frappe
bench build
```

`bench get-app` installs the npm dependencies (the app-root `package.json`); the SCSS imports `@carbon/styles` straight from the app's `node_modules`. If the first build fails with a missing-import error, run `bench setup requirements` (or simply re-run `bench build`) and build again.

### Verifying

-   `sites/assets/assets.json` → `"desk.bundle.css"` should point at `/assets/carbon_frappe/dist/css/…`
-   DevTools on `/app`: `--cds-background` present on `:root`; `--bg-color` resolves through the `--cds-*` chain; toggling the theme (Settings → Toggle Theme) flips token values and `color-scheme`.
-   Fonts: IBM Plex woff2 requests from `/assets/carbon_frappe/fonts/`; no Inter requests.

## Caveats (read before deploying)

-   **Bench-global**: assets.json is shared by every site on the bench, so the theme applies to sites that don't have the app installed. Run carbon\_frappe on a dedicated bench.
-   **Partial builds**: `bench build --apps frappe` re-points the shadowed keys at frappe's assets until the next full `bench build` or `bench migrate`. Prefer plain `bench build`.
-   **`bench watch`**: rebuilds of frappe's own bundles can re-claim keys mid-session; re-run `node scripts/patch-assets.mjs` (or a full build) if stock styling reappears.
-   The shadowing relies on frappe's (undocumented) basename keying and merge semantics of `assets.json`. `scripts/audit-tokens.mjs` (run warn-only on every build, strict via `npm run audit`) watches for upstream drift: Carbon token renames, removed frappe variables, and changes to frappe's bundle entry imports. The orthodox fallback — `app_include_css`/`web_include_css` hooks — remains structurally compatible with this app's bundles if the shadow mechanism ever breaks.

## frappe-ui SPA apps

Apps that build their own bundles (CRM, Helpdesk, custom portals) can't be reached by the bench pipeline. For those, this app publishes a standalone tokens-only stylesheet — `carbon_frappe_ui.bundle.css` — that re-themes frappe-ui's semantic variables (unlayered, so it beats Tailwind's `@layer base` regardless of order) and covers frappe-ui's hardcoded utility classes. Resolve the hashed path via the `"carbon_frappe_ui.bundle.css"` key in `sites/assets/assets.json` and include it after the app's own CSS.

## Print & email

-   A **"Carbon" Print Style** record is installed as a fixture (select it in Print Settings). The `print.bundle` shadow restyles print preview; both use literal values (wkhtmltopdf has no CSS-variable support). For exact PDF fidelity install the IBM Plex system fonts on the server; the stack falls back cleanly otherwise.
-   The `email.bundle` shadow is Premailer-inlined into outgoing mail — also literals only.

## Development

```sh
yarn run compile   # compile all bundles against a sibling ../frappe checkout (.dev-dist/)
yarn run codegen   # refresh vendored IBM Plex fonts + @carbon/charts palettes
yarn run audit     # strict drift audit (CI)
```

`scripts/dev-compile.mjs` replicates frappe's exact sass pipeline (legacy API, `includePaths` = app roots + node\_modules, `~` importer), so bundles can be smoke-tested without a bench. Set `FRAPPE_PATH` if frappe isn't at `../frappe`.

### Upgrading Carbon

Bump the exact-pinned `@carbon/*` versions, then `npm install && npm run codegen && npm run audit && npm run compile`, review the diff, and do a visual pass in both themes.

## License

MIT — see `license.txt`. IBM Plex is vendored under the OFL (see `carbon_frappe/public/fonts/LICENSE-*.txt`).
