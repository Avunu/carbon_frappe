# Carbon Frappe

A comprehensive [Carbon Design System](https://carbondesignsystem.com) (v11) theme for [Frappe](https://frappeframework.com) sites. Every surface — desk, website/portal, login, email, charts, and frappe-ui/Espresso components — is restyled to look as though it was designed with Carbon: IBM Plex type, square geometry, Carbon color tokens, 2px focus rings, the g100 UI Shell header, and Carbon's categorical chart palettes, all sourced from the official `@carbon/*` npm packages.

## How it works

Frappe resolves every stylesheet through `sites/assets/assets.json`, keyed by bare bundle basename. This app **shadows** frappe's own bundles: it ships same-named entries (`desk.bundle.scss`, `website.bundle.scss`, `login.bundle.scss`, `email.bundle.scss`) that _recompile frappe's SCSS sources_ with Carbon values injected at compile time, then layer Carbon tokens and component overrides on top. The server is thereby forced to serve the Carbon stylesheets **instead of** frappe's — one stylesheet per surface, no double download, no cascade fights.

Three mechanisms keep the shadow deterministic:

1.  **Name collision** — this app builds after frappe, so its entries win the assets.json merge.
2.  **`scripts/patch-assets.ts`** — runs as the app's `build` script after every full `bench build`; re-points the shadowed keys (and `rtl_` variants) at this app's compiled assets and clears the redis `assets_json` cache.
3.  **`after_migrate` hook** (`carbon_frappe.build.patch_assets`) — re-asserts the shadow after migrations, healing partial `bench build --apps frappe` runs.

Inside each bundle, the styling itself is a three-layer transposition:

- **`scss/carbon/`** — emits Carbon's ~240 design tokens as `--cds-*` custom properties (Light → Carbon **g10**, Dark → Carbon **g100**, keyed to frappe's `data-theme`), plus self-hosted IBM Plex `@font-face` rules.
- **`scss/map/`** — transposes frappe's variable system onto Carbon: the espresso raw color ramps (`--gray-*`, `--blue-*`, …) snap to `@carbon/colors` scales (which cascades through frappe's semantic `--surface-*`/`--ink-*`/`--outline-*` layer _and_ frappe-ui's identical token names), with exact-token pins for the slots that must land on Carbon theme tokens (`--bg-color → --cds-background`, `--control-bg → --cds-field-02`, `--btn-primary → blue-60`, radii → 0, focus → 2px `$focus`, elevations → Carbon's single menu shadow, type → IBM Plex).
- **`scss/desk/` + `scss/web/`** — Carbon component anatomy: bottom-border fields, Carbon button ramps, the UI Shell header on Carbon's own `cds--header` classes (see _UI Shell header_ below), page actions flush on the title row, side-nav selection bars, 48px data tables, Carbon modals/menus/toasts/tags/tiles, and Carbon read-only states. Carbon's component CSS itself (data-table family, pagination, overflow-menu, header, header-panel, switcher, badge-indicator) is pulled in as mixins by `scss/desk/_carbon-components.scss` — one partial, because the desk bundle is assembled with `@import` and Sass re-emits a `@use`d module's CSS for every importing file.

> **Why g10 and not White.** Carbon's product UIs put the page canvas on `$background` and lift cards, tiles and the side nav to `$layer-01`. The **White** theme inverts that ladder (`$background` `#ffffff` / `$layer-01` `#f4f4f4`), which renders as a white page with gray cards — the opposite of every Carbon reference product. **g10** gives `#f4f4f4` / `#ffffff`. The two themes differ in only 17 of 306 tokens, all in the `background` / `layer` / `field` / `border-subtle` family. Note `border-subtle-00`/`-01` **invert** between g10 and g100, so all subtle hairlines resolve through an app-level `--carbon-border-subtle` alias rather than a Carbon token directly.

Charts get `--charts-*` theming plus `carbon_charts.bundle.js`, which wraps `frappe.Chart` and injects the authentic `@carbon/charts` 14-color categorical palettes whenever a caller doesn't pass explicit colors, and re-themes those charts when `data-theme` changes (frappe fires no theme event, so this observes the attribute). Chart chrome follows Carbon rather than the concept mockup: gridlines stay (Carbon names the grid as comprehension anatomy) and both axes are IBM Plex **Sans**.

### Beyond CSS

Small JS bundles cover what stylesheets cannot reach. Every theme patch delegates to the original, never throws and never half-applies — a missing target degrades to stock frappe styling and reports itself, rather than throwing inside `desk.bundle.js`.

- **`carbon_desk.bundle.js`** — tags formatter output with `carbon-num` so numerics and dates get IBM Plex Mono.
- **`carbon_anatomy.bundle.js`** — the Carbon UI Shell header (mounted into the empty `<header>` frappe leaves in `www/desk.html`; see _UI Shell header_) and the page header (eyebrow + `heading-04` title, which has no host element in frappe).
- **`carbon_tables.bundle.js`** — not a theme patch but a functional replacement: one Carbon-styled, TanStack-driven table engine behind frappe's child-table Grid, List view and Report/Query views. See _Tables_ below.
- **`scripts/audit-markup.ts`** — guards every selector, runtime shape and asset-shadow assumption the above depends on. See _Caveats_.

## UI Shell header

The header is Carbon's UI Shell, class for class — `cds--header`, `HeaderMenuButton`, `HeaderName`, `HeaderNavigation` + `HeaderMenu`, `HeaderGlobalBar`, `HeaderPanel` + `Switcher` — mounted as light DOM by `js/anatomy/ui_shell.ts` and styled by `@carbon/styles`' own header, header-panel and switcher mixins. It runs Carbon's **g100** theme in both desk themes through a zone class (`cf-zone-g100`) that shares the dark theme's token emission.

Everything it shows is a projection of frappe v16's **Workspace Sidebar** (`frappe.app.sidebar`), which is what resolves a route to a workspace and names the app that owns it:

- **Header name** — `<app title> <workspace title>`, e.g. "ERPNext Projects" at `/desk/projects`; "Desktop" on the launcher. Links to the sidebar's first link.
- **Header links and sub-menus** — the sidebar's top-level rows: a `Link` is a header link, a `Section Break` with children is a sub-menu. They are read from the sidebar's rendered DOM rather than from `boot.workspace_sidebar_item`, so frappe's own routing (`TypeLink.get_path()`, six branches) and render decisions are inherited, never re-derived. `aria-current` follows frappe's own current-item rule. Carbon's header has no overflow behaviour, and a Workspace Sidebar carries 3–13 top-level rows, so the bar is measured and the tail folds into a **More ▾** sub-menu; below Carbon's `lg` breakpoint (66rem) the nav hides and the sidebar carries every link, as Carbon's guidance says it should.
- **Utilities** — frappe's own search, notification bell and account button, MOVED into the global bar (handlers intact) and presented as `cds--header__action` cells; the notification flyout becomes a right header panel. Moving the bell breaks frappe's unread badge (`NotificationsView` resolves it via `closest(".body-sidebar")`), so the theme re-homes that lookup on the instance — the one place it re-states frappe logic.
- **Switcher** — the far-right action opens a right panel that mirrors the `/desk` desktop: `boot.desktop_icons` with the desktop page's own visibility and nesting rules re-applied (hidden icons dropped, orphans promoted, a Folder or an App with workspaces under it as an expandable row), the current workspace selected, and the Desktop launcher below a divider.
- **Hamburger** — delegates to frappe's sidebar toggle and mirrors its state in `aria-expanded`. It keeps the Menu glyph: Carbon's ✕ means "an overlay is open", and frappe's sidebar collapses to a rail rather than going away.

The header re-renders after `Sidebar.prototype.make_sidebar` (the one place frappe rebuilds the sidebar DOM; `sidebar_setup` fires _before_ the state changes and is deliberately unused) and re-marks the current link on every route change. It never mounts where frappe fills `<header>` itself (read-only, impersonation, announcement widget, mobile).

## Brand colours and the dev indicator

**Desk → Carbon Settings** (System Manager). Four colours, all optional; anything left empty falls back to Carbon's own value, so a site that sets one colour still gets a coherent palette.

The brand colour is not a header tint. It sets Carbon's _interactive_ role, so one value reaches primary buttons, links, focus rings, selected rows, the sidebar selection bar and the active tab — everywhere the theme draws on `--cds-interactive` and `--cds-button-primary`. The header is configured separately, because tinting the bar and rebranding the controls are different decisions.

**Light and dark are separate fields on purpose.** Carbon does not reuse one interactive tone across themes: its own is Blue 60 `#0f62fe` on g10 and the lighter Blue 50 `#4589ff` on g100, because a mid-dark colour that reads well on `#f4f4f4` does not carry against `#161616`. Set only the light one and the dark variant is derived by lightening it; set both to control each exactly. Hover, active and text-on-brand are derived too — hover darkens in light and brightens in dark, and the button label flips to near-black on a light brand (yellow, lime). Danger stays red-with-white regardless.

A header colour re-points every token Carbon's UI Shell CSS reads on the zone element (`cf-zone-g100`) — background, hover/active, the `$layer` family behind sub-menus and the notification/switcher panels, text, icons, focus, `color-scheme` — so a light header gets light menus rather than g100 blocks sitting on a coloured bar. The website navbar, footer and the theme-switcher preview strip follow through `--carbon-header-*` aliases. Carbon's own `#161616` shell is left untouched: its values are hand-tuned and the shell parity tests assert them.

### How it is delivered

`/carbon-brand.css`, rendered per request by a `page_renderer` (`brand.py`) and linked **after** the bundles by `app_include_css` (desk), `web_include_css` (website and login) and `injector.py` (frappe-ui SPAs). Every value is a CSS custom property declared on the same elements the bundles use (`html:root` / `html[data-theme=…]`, one specificity notch above the bundles' own `:root` / `[data-theme=…]`, and the `.cf-zone-g100` header zone), so it wins with no `!important` wherever the link lands — the login page renders `login.bundle.css` after `web_include_css`, and the theme's own Sass reads the same tokens with the stock value as the `var()` fallback (`desk/_buttons.scss`, `map/_colors-legacy.scss`, `web/_navbar.scss`). Shades are computed in Python rather than emitted as colour functions, since a function inside a custom property value the browser cannot evaluate is silently ignored. Nothing is emitted until something is set — an untouched site is byte-for-byte stock Carbon. Revalidated by ETag; a settings save is live on the next page load.

### Dev indicator

On `localhost`, `127.0.0.1`, `::1` or any `*.localhost` host (frappe-nix benches serve `<site>.localhost`) the header is painted Carbon yellow-30 `#f1c21b` with near-black text and a diagonal hazard-stripe overlay running under the menu items (idle links go transparent; hover, active and open-menu states keep their tones), so a development tab can never be mistaken for production. The stripes stay on the bar alone — across the page they never line up between header, sidebar and content column. The brand colour still applies; the configured header colour is replaced on the bar but kept on the footer. It is decided server-side from the request host, so there is no flash.

Overrides, in order of precedence: `carbon_dev_indicator` in `site_config.json` (`bench --site <site> set-config carbon_dev_indicator 0`), then a `carbon_dev_indicator` cookie (`scripts/tables/cdp.ts` sets it to `0` after login, because the shell parity tests run against localhost and assert the g100 bar), then the hostname.

### Not branded, deliberately

- Espresso's status-blue slots (`--surface-blue-*`, `--ink-blue-*`: Draft/Submitted pills, info callouts) — Carbon keeps blue as the informational colour regardless of brand.
- The dark focus ring, interactive icons and the tertiary button in dark mode — g100 draws them white.
- Email (Premailer literals; see below) and, on website pages, Bootstrap-compiled utilities such as `.text-primary` — set Website Theme's `primary_color` as well if those matter.
- If a catch-all Website Route Redirect or a stale `website_404` cache entry ever 404s `/carbon-brand.css`, the theme silently falls back to Carbon blue; `frappe.clear_cache()` (which Carbon Settings runs on save) clears the latter.

## Tables

`carbon_tables.bundle.js` replaces frappe's three unrelated table renderers — a Bootstrap 12-column grid, hand-built flex-div list rows, and the separate **frappe-datatable** library — with a single engine built on [TanStack Table](https://tanstack.com/table) v9 and rendered as Carbon's light-DOM `cds--data-table`.

**What it unlocks**

- **Child-table grids past 10 columns.** frappe sizes grid fields as Bootstrap spans and stops redistributing once the total passes 10 (`grid.js:1357-1380`), then latches `.column-limit-reached` and swaps in a hand-rolled horizontal-scroll hack driven by a px map duplicated in JS and SCSS. Columns now carry real pixel widths owned by TanStack's column-sizing feature, the table scrolls horizontally like any table, and `df.sticky` becomes real column pinning. There is no cap.
- **Virtualized report rows.** A 742-row report keeps ~32 rows in the DOM; the engine measured 50 000 rows rendering in ~400 ms.
- **Column resizing, reordering, pinning and Carbon sort headers** on every surface, plus a spreadsheet-style cell-selection primitive (`cellSelectionFeature`) that frappe-datatable had and Carbon's own Datagrid does not.
- **One row-size vocabulary.** Carbon has five row sizes and one rule — the header row matches the body row — so an arbitrary `cellHeight` (frappe asks for 33 and 35) snaps to the nearest and the header follows.
- **Child-table rows that expand into their form.** frappe's row form is a centered pseudo-modal — `GridRowForm` renders inline but `.grid-row-open .form-in-grid` is `position: fixed; top: 5%; left: 50%; width: 80%` over a `frappe.dom.freeze()` backdrop. It is now Carbon's expandable row instead: a chevron in a leading `cds--table-expand` gutter unfolds a `cds--child-row-inner-container` beneath the row, which stays visible above it. The panel is the same `GridRowForm` and the same `frappe.ui.form.Layout`, so every field, tab, `depends_on` and `get_query` behaves as before. One row opens at a time, matching frappe's own `toggle_view()` accordion and the single-slot globals (`cur_frm.cur_grid`, `grid.open_grid_row`, `$('.grid-row-open')`) that the rest of the desk reads. Because the table scrolls horizontally, the panel is `position: sticky` and sized to the scroll viewport, so it stays where the reader is while the columns move behind it. A `⋮` overflow menu in a trailing gutter carries the row actions (Insert Above/Below, Duplicate, Move, Delete) plus **Open in dialog**, which restores the old centered form for child doctypes too tall to read inside a row.
- **A Carbon table toolbar instead of a footer button strip.** frappe's `.grid-footer` becomes `cds--table-toolbar`: Add row as the primary action, Add multiple beside it, Download / Upload / Configure Columns as `cds--toolbar-action` icons, and a magnifier that toggles frappe's per-column filter row (upstream that row only appears past `rows_threshold_for_grid_search`, 20). Selecting rows raises Carbon's `cds--batch-actions` bar over the toolbar with the selection count and Delete / Duplicate / Cancel. Pagination moves below the table as `cds--pagination`. Every button is frappe's original element **moved**, never rebuilt — the `data-action` handlers `bind_actions_with_object` wired onto them, the cached `grid.*_button` handles, and the `.hidden` / `.d-none` toggles in `setup_toolbar()` all keep working.

**What does not change**

Compatibility is the point. Nothing here alters a public frappe API:

- **Grid** — `CarbonGrid extends Grid` and `CarbonGridRow extends GridRow`, overriding only the methods that produce or size DOM, plus `show_form()` / `hide_form()` for the expandable row. `refresh()`, `add_new_row()`, `update_docfield_property()`, `get_field()`, `toggle_view()`, `insert()`, `move()`, `remove()`, bulk edit, CSV upload, Sortable row dragging, the Configure Columns dialog and `GridRowForm` itself are all frappe's own implementations running against new DOM. Cells are still the `div.grid-static-col` elements `GridRow.make_column()` builds, complete with their `.static-area` / `.field-area` pair and their mounted controls — the engine positions them, it never rebuilds them.
- **Report and Query views** — `window.DataTable` and `frappe.DataTable` become a frappe-datatable-compatible facade. The option surface, the `getEditor` protocol, `events`, `hooks.columnTotal`, and the `datamanager` / `rowmanager` / `columnmanager` / `cellmanager` / `bodyRenderer` / `style` sub-managers are reproduced against measured call sites — including `style.setStyle()`, which 13 places across frappe, ERPNext and app reports use to paint individual cells.
- **Report-view editing** — frappe-datatable's grid interaction is reproduced (focus ring, arrows, shift-range, ctrl+C as TSV, Enter to edit) and extended: **ctrl+V** pastes a TSV block over the selection (a single value fills a range) with each value coerced to the target fieldtype or refused — numbers in the user's number format, dates in the system or user format, Selects by option, Links validated by the server — and every write goes through the report view's own `getEditor().setValue`, so the server, `report_view.data` and the charts stay in step and a rejected value reverts. **Space** toggles a focused Check cell in place. A multi-line editor (Small Text / Text) is a framed popover that grows below the cell; Enter is a newline there and ctrl+Enter commits.
- **List view** — `get_column_html()` and `get_meta_html()` are reused verbatim as the cell renderers, so `listview_settings` (`formatters`, `get_indicator`, `button`, `dropdown_button`, `hide_name_column`) behaves exactly as before.
- **The legacy DOM contract is re-emitted alongside Carbon's.** Every row and cell carries its `dt-*`, `grid-*` or `list-row-*` class as well, so existing app CSS, jQuery and `setStyle` selectors keep resolving. The mapping lives in one file per adapter (`tables/*/classes.js`).

**Known limits**

- `frappe/data_import/import_preview.js` and `system_console.js` hold module-local `frappe-datatable` imports that a global reassignment cannot reach. They keep using the stock library, which remains installed and themed.
- The child-table panel keeps `frappe.dom.freeze_count` balanced by hand: `GridRow.show_form()` freezes and `hide_form()` unfreezes unconditionally, so inline mode counterweights both rather than skipping them. If frappe ever makes that pairing conditional, the guard in `scripts/markup-manifest.ts` will catch it.
- Column pinning is declared but inert on child tables. The engine builds its `columnPinning` state once, in the constructor, from the `columns` it was handed — and the Grid constructs the engine with an empty column list, filling it later through `setColumns()`, which does not revisit pinning. So `df.sticky` and the `_expand` / `_check` / `_index` gutters do not actually freeze on a horizontally scrolled child table. The List and Report adapters pass their columns up front and are unaffected. The expanded panel does not rely on this — it sticks on its own.
- List-view rows are not virtualized: the list scrolls the page rather than an inner box, which is what frappe's paging buttons and `.disable-scrolling` assume. `page_length` (20/100/500/2500) remains the bound on row count.

## Install

```sh
bench get-app https://github.com/Avunu/carbon-frappe
bench --site <site> install-app carbon_frappe
bench build
```

`bench get-app` installs the npm dependencies (the app-root `package.json`); the SCSS imports `@carbon/styles` straight from the app's `node_modules`. If the first build fails with a missing-import error, run `bench setup requirements` (or simply re-run `bench build`) and build again.

### Verifying

- `sites/assets/assets.json` → `"desk.bundle.css"` should point at `/assets/carbon_frappe/dist/css/…`
- DevTools on `/app`: `--cds-background` present on `:root`; `--bg-color` resolves through the `--cds-*` chain; toggling the theme (Settings → Toggle Theme) flips token values and `color-scheme`.
- Fonts: IBM Plex woff2 requests from `/assets/carbon_frappe/fonts/`; no Inter requests.

## Caveats (read before deploying)

- **Bench-global**: assets.json is shared by every site on the bench, so the theme applies to sites that don't have the app installed. Run carbon\_frappe on a dedicated bench.
- **Partial builds**: `bench build --apps frappe` re-points the shadowed keys at frappe's assets until the next full `bench build` or `bench migrate`. Prefer plain `bench build`.
- **`bench watch`**: rebuilds of frappe's own bundles re-claim the keys mid-session. This is the most common way to lose the theme, and it has **no symptom other than stock frappe styling reappearing** — nothing errors. `npm run audit` now checks for it explicitly; the fix is `node scripts/patch-assets.ts`.
- **TypeScript bundle entries**: the four `carbon_*.bundle.ts` entry points are compiled by frappe's own esbuild, but frappe keys `assets.json` by the _entry_ basename (`esbuild.js:450`), so a build writes `carbon_desk.bundle.**ts**` while `hooks.py` and `include_script` look up `carbon_desk.bundle.**js**` with no extension fallback. The `.js` key then keeps an older build's hash and the desk serves a swept or stale bundle — silently. `scripts/patch-assets.ts` repairs it on every `bench build`, `carbon_frappe/build.py` repairs it on migrate/install, and `npm run audit` detects it; but **`bench watch` runs none of those**, so re-run `node scripts/patch-assets.ts` after a watch session.
- The shadowing relies on frappe's (undocumented) basename keying and merge semantics of `assets.json`. The orthodox fallback — `app_include_css`/`web_include_css` hooks — remains structurally compatible with this app's bundles if the shadow mechanism ever breaks.

### Drift guards

Both run warn-only on every `bench build` and strict via `npm run audit`.

- **`scripts/audit-tokens.ts`** — Carbon token renames, removed frappe variables, changes to frappe's bundle entry imports, the g10 and g100-zone premises, the frappe runtime shapes the theme patches, and every `cds--*` class the theme emits or targets still existing in `@carbon/styles`.
- **`scripts/audit-markup.ts`** — every frappe class the stylesheet targets, every runtime shape `js/anatomy/*` wraps, the frappe declarations we deliberately override, and the asset shadow itself. Declared in `scripts/markup-manifest.ts` so the guard and the code cannot drift apart.

These exist because all of these failures are silent: the theme keeps loading and a component quietly reverts to stock frappe styling.

### Deliberate deviations from Carbon

Recorded rather than claimed as conformance:

- **IBM Plex Mono on tabular data.** Carbon is silent on numeric font and alignment in data tables. Monospaced tabular figures are a project choice for financial data; charts deliberately stay Plex Sans, matching Carbon's data-viz references.
- **Light-DOM tables rather than `@carbon/web-components`.** Carbon's own TanStack transition ships React and Web Component examples, and the Web Component set would have been the closer fit for an app that uses no framework. It was rejected for three reasons: `@tanstack/lit-table` is pinned to TanStack v8, which has no `cellSelectionFeature` (the primitive that reproduces frappe-datatable's range selection and `ctrl+C`); `@carbon/web-components` compiles its own copy of Carbon's SCSS into each component's shadow root, which is a second Carbon delivery channel alongside the pinned `@carbon/styles`; and shadow roots would put row and cell internals out of reach of `datatable.style.setStyle()` and of every third-party report stylesheet. `@carbon/styles/scss/components/data-table` gives the identical appearance in the light DOM — it is what `@carbon/react` renders.

## frappe-ui SPA apps

Apps that build their own bundles (CRM, Helpdesk, custom portals) can't be reached by the bench pipeline. For those, this app publishes a standalone tokens-only stylesheet — `carbon_frappe_ui.bundle.css` — that re-themes frappe-ui's semantic variables (unlayered, so it beats Tailwind's `@layer base` regardless of order) and covers frappe-ui's hardcoded utility classes. Resolve the hashed path via the `"carbon_frappe_ui.bundle.css"` key in `sites/assets/assets.json` and include it after the app's own CSS.

## Email

- The `email.bundle` shadow is Premailer-inlined into outgoing mail — literal values only (no CSS-variable support in that pipeline).

## Development

The repo is a [frappe-nix](https://github.com/Avunu/frappe-nix) app: `direnv allow` (or `nix develop --no-pure-eval`) gives a shell with Node 24, yarn, uv, chromium and a bench — frappe, erpnext and hrms from the flake's pinned inputs, this app symlinked in — and `devenv up` + `provision-site` bring the site up. Every check below runs there, and CI runs the same commands.

```sh
yarn check            # format, lint, types, the frappe-major guard, unit tests — what `lint`/`typecheck` gate
yarn format           # oxfmt: TS, JSON, SCSS, YAML, TOML, Markdown (tabs, 110 columns)
yarn lint             # oxlint + stylelint
yarn lint:py          # ruff check + ruff format --check
yarn typecheck        # tsc --build, all three projects
yarn typecheck:py     # ty, against the bench's interpreter (where `frappe` is importable)
yarn test:unit        # node:test over the pure modules, with a 50% line-coverage floor
yarn compile          # compile all bundles against the pinned frappe (.dev-dist/)
yarn audit            # strict drift audit against frappe's source
yarn codegen          # refresh vendored IBM Plex fonts, @carbon/charts palettes, @carbon/icons shell glyphs
yarn test:tables      # browser tests for the table engine and its adapters (needs the bench up)
yarn test:shell       # browser tests for the UI Shell header (needs the bench up)
bash ci/integration.sh              # what CI's `integration` job runs: the site-backed suites end to end
node scripts/dev-table.ts --serve   # the engine alone, on :8123, with no bench
```

### Conventions, and what enforces them

| Surface                              | Format             | Lint                                                                                          | Types                                        | Tests                                          |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| TypeScript (browser, scripts, tests) | oxfmt              | oxlint — `no-explicit-any` and `ban-ts-comment` are errors: no escape hatches                 | `tsc --build`, strict, `skipLibCheck: false` | `node --test` (unit), CDP suites (integration) |
| SCSS                                 | oxfmt              | stylelint (standard-scss) + `audit-tokens`                                                    | —                                            | compiled by `nix build` and `yarn compile`     |
| Python                               | ruff format (tabs) | ruff — frappe's set at pequea's strictness + SIM/C4/PIE/PERF/T20; semgrep with frappe's rules | ty                                           | `bench run-tests --app carbon_frappe`          |
| JSON / YAML / TOML / Markdown        | oxfmt              | —                                                                                             | —                                            | —                                              |
| Workflows                            | oxfmt              | actionlint + zizmor (third-party actions hash-pinned)                                         | —                                            | —                                              |
| Nix                                  | `nix fmt`          | statix + deadnix, `nix flake check`                                                           | —                                            | `nix build`                                    |
| Commits                              | —                  | committed (conventional, frappe's types); no `!`/`BREAKING CHANGE` — see Releasing            | —                                            | —                                              |

Doctype JSON is left exactly as frappe's exporter writes it. Generated files (`public/js/generated`, `public/scss/generated`, the fonts) are formatted by their generators and CI fails if `yarn codegen` would change them.

The git hooks are [prek](https://prek.j178.dev)'s (`uv run --frozen --project tools prek install`, once per clone; `prek run --all-files` is what CI runs). Every hook calls a binary this repo pins — the JS tools through `package.json`, the Python ones through `tools/pyproject.toml` — so a developer's shell, the hook and CI run one version, and dependabot is the only thing that moves it. In a nix shell without a CA bundle exported, `uv sync` may need `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.

`nix/node-locks/` holds **forced fallback locks** for the nested frontends (`frappe/ui`, `erpnext/banking`, `hrms/frontend`, `hrms/roster`): upstream ships a `yarn.lock` for each that is stale against its `package.json`, so frappe-nix's offline yarn install cannot use it as is. After a frappe/erpnext/hrms bump, `nix run .#relock -- --node-locks frappe/ui erpnext/banking hrms/frontend hrms/roster` refreshes them (seeded from upstream's lock, gaps filled from the registry).

`scripts/test-shell.ts` runs the same harness over the header: the name and links against the Projects sidebar, sub-menu keyboard behaviour, `aria-current`, the overflow against the 13-row Recruitment sidebar, the switcher, the hamburger, the moved bell and its badge, g100 parity in both themes, the dialog z-order, the landing page, and the mobile no-mount case.

`scripts/test-tables.ts` drives headless Chromium over the DevTools Protocol (no dependencies beyond Node 24 and `chromium` on PATH) against a running bench. It covers the engine in isolation, then each adapter's frappe contract: the `dt-*` selectors, `style.setStyle`, `rowmanager.getCheckedRows`, a report script's `get_datatable_options` / `formatter` / `after_datatable_render` / `getEditor` hooks, the Grid's inherited API and its >10-column layout, the List view's bulk actions, editing (the Check editor, the multi-line popover, paste), and g100 parity. Most of those assertions exist because that exact thing regressed once — several are specificity guards against frappe-datatable's, Bootstrap's or Carbon's own stylesheet quietly winning.

`scripts/dev-table.ts` builds the engine and a fixture page into `.dev-dist/` with no frappe present at all, which is where engine behaviour is verified before any adapter is involved.

`scripts/dev-compile.ts` replicates frappe's exact sass pipeline (legacy API, `includePaths` = app roots + node\_modules, `~` importer), so bundles can be smoke-tested without a bench. The shell exports `FRAPPE_PATH`; set it yourself outside one.

### CI

`.github/workflows/check.yml`, on every pull request and push to `develop`: `lint` (prek over the whole tree, commit subjects, semgrep, the tools lock), `typecheck` (tsc, unit tests, codegen freshness, then `yarn compile` and `yarn audit` against frappe at the revision `flake.lock` pins — checked out with git, no nix), `bench` (`nix fmt`, statix/deadnix, `nix flake check`, `nix build` — the app compiled in a clean bench — and ty). Those three are the required checks on `develop`. `integration` runs `ci/integration.sh` on push, nightly and on demand — a whole bench closure through the Actions cache is a daily cost, not a per-commit one.

Dependencies are on autopilot: dependabot covers npm, `tools/uv.lock`, the workflows' actions and the flake inputs (frappe, erpnext, hrms and frappe-nix themselves), and `dependabot-auto-merge.yml` merges each pull request once the required checks are green. A frappe bump can legitimately fail the drift audits and need a follow-up commit; auto-merge simply waits.

### Upgrading Carbon

Bump the exact-pinned `@carbon/*` versions, then `yarn install && yarn codegen && yarn audit && yarn compile`, review the diff, and do a visual pass in both themes.

## Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please). Nobody edits the version by hand, and nobody pushes to `version-16`.

1. Land conventional commits on `develop` (`fix:` → patch, `feat:` → minor; the other types are left out of the changelog). Pull requests are squash-merged, so the title is the commit subject and is linted as one.
2. release-please keeps an open **release pull request** against `develop` with the next version and the accumulated changelog. Merging it _is_ the release: `release-please.yml` tags `v16.x.y`, cuts the GitHub release, and fast-forwards **`version-16`** — the production branch, what `bench get-app https://github.com/Avunu/carbon_frappe --branch version-16` installs — to the release commit. `develop` carries `CHANGELOG.md` and the version; `version-16` is always exactly the latest release.
3. There is no artifact to publish: a frappe app installs from git, and `bench build` compiles the assets on the target.

**The major never moves on its own.** `carbon_frappe@16.x.y` means "the theme for frappe v16" — the major is the frappe major, the way erpnext, hrms and frappe-types are versioned — so a `feat!:` subject or a `BREAKING CHANGE:` footer proposing 17.0.0 is a bug, not a release. The commit-msg hook refuses both; `release-please.yml`'s `guard-major` job checks the version release-please actually proposes, on the release branch it writes, and posts a `frappe-major (release PR)` status on the pull request; `yarn check:major` runs on every push and also cross-checks `frappe.major` in `package.json` against the flake's frappe pin. Breaking changes ship as `feat:` on the line they belong to. Moving to frappe v17 is a new `version-17` branch: point the flake input at `version-17`, set `frappe.major`/`frappe.branch`, and land a `Release-As: 17.0.0` commit. `scripts/check-frappe-major.ts` has the full rationale and the recovery for a stray `!` (an empty commit with a `Release-As:` footer).

Repository settings this relies on: "Allow auto-merge" and "Allow GitHub Actions to create and approve pull requests" ON; `develop` protected with `lint`, `typecheck` and `bench` required; `version-16` protected against force-pushes and deletion only — a "require pull request" rule there would block the token's fast-forward, and `github-actions[bot]` cannot be a ruleset bypass actor. `check.yml`'s `version-16` job is the alarm: the token's ref updates raise no workflow runs, so any run on that branch is a human push, and it fails unless the head is the newest `v*` tag.

## License

MIT — see `license.txt`. IBM Plex is vendored under the OFL (see `carbon_frappe/public/fonts/LICENSE-*.txt`).
