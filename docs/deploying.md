# Deploying

## Install

```sh
bench get-app https://github.com/Avunu/carbon_theme
bench --site <site> install-app carbon_theme
bench build
```

`bench get-app` installs the npm dependencies (the app-root `package.json`); the SCSS imports `@carbon/styles` straight from the app's `node_modules`. If the first build fails with a missing-import error, run `bench setup requirements` (or simply re-run `bench build`) and build again.

## Verifying

- `sites/assets/assets.json` → `"desk.bundle.css"` should point at `/assets/carbon_theme/dist/css/…`
- DevTools on `/app`: `--cds-background` present on `:root`; `--bg-color` resolves through the `--cds-*` chain; toggling the theme (Settings → Toggle Theme) flips token values and `color-scheme`.
- Fonts: IBM Plex woff2 requests from `/assets/carbon_theme/fonts/`; no Inter requests.
- With flow installed: `/assets/carbon_theme/dist/ai_chat/manifest.json` answers 200 and names an `entry.<hash>.js` and a `chat.<hash>.css` that exist next to it (`yarn audit:drift` checks the same, and fails when the build on disk is older than its sources). It is requested only when the assistant panel is first opened.

## Caveats

- **Bench-global**: assets.json is shared by every site on the bench, so the theme applies to sites that don't have the app installed. Run carbon\_theme on a dedicated bench.
- **Partial builds**: `bench build --apps frappe` re-points the shadowed keys at frappe's assets until the next full `bench build` or `bench migrate`. Prefer plain `bench build`.
- **`bench watch`**: rebuilds of frappe's own bundles re-claim the keys mid-session. This is the most common way to lose the theme, and it has **no symptom other than stock frappe styling reappearing** — nothing errors. `yarn audit:drift` now checks for it explicitly; the fix is `node scripts/patch-assets.ts`.
- **TypeScript bundle entries**: the four `carbon_*.bundle.ts` entry points are compiled by frappe's own esbuild, but frappe keys `assets.json` by the _entry_ basename (`esbuild.js:450`), so a build writes `carbon_desk.bundle.**ts**` while `hooks.py` and `include_script` look up `carbon_desk.bundle.**js**` with no extension fallback. The `.js` key then keeps an older build's hash and the desk serves a swept or stale bundle — silently. `scripts/patch-assets.ts` repairs it on every `bench build`, `carbon_theme/build.py` repairs it on migrate/install, and `yarn audit:drift` detects it; but **`bench watch` runs none of those**, so re-run `node scripts/patch-assets.ts` after a watch session.
- The shadowing relies on frappe's (undocumented) basename keying and merge semantics of `assets.json`. The orthodox fallback — `app_include_css`/`web_include_css` hooks — remains structurally compatible with this app's bundles if the shadow mechanism ever breaks.

## Drift guards

Both run warn-only on every `bench build` and strict via `yarn audit:drift`.

- **`scripts/audit-tokens.ts`** — Carbon token renames; every custom property `scss/map` pins still declared by frappe (read from `css/espresso/*.css` and its SCSS), and each theme-owned shim still needed; frappe's semantic layer still a `var()` chain onto the ramps (the premise the ramp-primary colour mapping rests on); `scss/map` still pinning every neutral role and no chromatic slot; each of frappe's four bundles (desk, website, login, email) still mirrored by the shadow bundle that replaces it, in both directions, and every file our bundles import from frappe (its source, or a package in its `node_modules` such as `~plyr`) still there; the g10 and g100-zone premises; the frappe runtime shapes the theme patches; every `cds--*` class the theme emits or targets still existing in `@carbon/styles`; the generated icon files still what `scripts/lib/icon-manifest.ts` and the installed `@carbon/icons` generate (rebuilt in memory and compared); every frappe sprite icon the theme still names still defined; and every legacy `fa-*` / `octicon-*` class an installed app emits bridged or deliberately skipped, with each manifest entry still emitted by the apps it names. That last check reads every app installed next to frappe, says which, and fails if an app `flake.lock` pins (frappe, erpnext, hrms) is not among them; CI checks out all three, so entries for other apps (print_designer, helpdesk, wiki, webshop) are verified only on a bench that has them.
- **`scripts/audit-markup.ts`** — every frappe class the stylesheet targets, every runtime shape `js/anatomy/*` wraps, the frappe declarations we deliberately override, and the asset shadow itself. Declared in `scripts/markup-manifest.ts` so the guard and the code cannot drift apart.

These exist because all of these failures are silent: the theme keeps loading and a component quietly reverts to stock frappe styling.

`yarn audit:drift` also runs **`scripts/build-ai-chat.ts --check`**, which builds the AI chat in memory and fails when react, react-dom or tiptap reach the first-open set, when that set (JavaScript and stylesheet) exceeds 400 KB gzip, when an output would match frappe's `*.bundle.*` pattern, or when a `public/dist/ai_chat` on disk is broken or older than its sources. It is the guard behind the size numbers in [Deliberate deviations from Carbon](how-it-works.md#deliberate-deviations-from-carbon).
