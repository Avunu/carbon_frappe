# Development

The repo is a [frappe-nix](https://github.com/Avunu/frappe-nix) app: `direnv allow` (or `nix develop --no-pure-eval`) gives a shell with Node 24, yarn, uv, chromium and a bench — frappe, erpnext and hrms from the flake's pinned inputs, this app symlinked in — and `devenv up` + `provision-site` bring the site up. Every check below runs there, and CI runs the same commands.

```sh
yarn check            # format, lint, stylelint, types, unit tests — what `lint`/`typecheck` gate
yarn check:major      # the package major is the frappe major (also `frappe-nix compat`)
yarn format           # oxfmt: TS, JSON, SCSS, YAML, TOML, Markdown (tabs, 110 columns)
yarn lint             # oxlint
yarn lint:css         # stylelint
yarn lint:py          # ruff check + ruff format --check
yarn typecheck        # tsc --build: the browser, scripts, test and desk (checkJs) projects
yarn typecheck:py     # ty, against the bench's interpreter (where `frappe` is importable)
yarn test:unit        # node:test over the pure modules, with a 50% line-coverage floor
yarn compile          # compile all bundles against the pinned frappe (.dev-dist/)
yarn audit:drift      # strict drift audit against frappe's source, plus the chat bundle's size budget (builds in memory)
yarn build:chat       # build the lazy AI chat bundle into public/dist/ai_chat (also part of `yarn build`)
yarn watch:chat       # the same, unminified, rebuilding on save; run it next to `bench watch`, which does not build the chat
yarn codegen          # refresh vendored IBM Plex fonts, @carbon/charts palettes, and the @carbon/icons glyphs + legacy icon classes (scripts/lib/icon-manifest.ts)
yarn test:tables      # browser tests for the table engine and its adapters (needs the bench up)
yarn test:shell       # browser tests for the UI Shell header and the AI chat (needs the bench up); `yarn test:shell assistant` runs the chat suite alone
frappe-test --reuse-site           # the Python tests with coverage (fail_under 80), the hook test map, ty
bash "$(frappe-nix data-path ci/nightly.sh)"   # what nightly's `integration` job runs: the Python tests, `bench build`, then both browser suites
node scripts/dev-table.ts --serve   # the engine alone, on :8123, with no bench
```

## Conventions, and what enforces them

| Surface                              | Format             | Lint                                                                                                | Types                                        | Tests                                             |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| TypeScript (browser, scripts, tests) | oxfmt              | oxlint — `no-explicit-any` and `ban-ts-comment` are errors: no escape hatches                       | `tsc --build`, strict, `skipLibCheck: false` | `node --test` (unit), CDP suites (integration)    |
| SCSS                                 | oxfmt              | stylelint (standard-scss) + `audit-tokens`                                                          | —                                            | compiled by `nix build` and `yarn compile`        |
| Python                               | ruff format (tabs) | ruff — frappe's set at our strictest app's level + SIM/C4/PIE/PERF/T20; semgrep with frappe's rules | ty                                           | `frappe-test` (coverage ≥ 80%, every hook tested) |
| JSON / YAML / TOML / Markdown        | oxfmt              | —                                                                                                   | —                                            | —                                                 |
| Workflows                            | oxfmt              | actionlint + zizmor (third-party actions hash-pinned)                                               | —                                            | —                                                 |
| Nix                                  | nixfmt             | statix + deadnix                                                                                    | —                                            | `nix build`                                       |
| Commits                              | —                  | committed (conventional, frappe's types); no `!`/`BREAKING CHANGE` — see Releasing                  | —                                            | —                                                 |

Doctype JSON is left exactly as frappe's exporter writes it. Generated files (`public/js/generated`, `public/scss/generated`, the fonts) are formatted by their generators and CI fails if `yarn codegen` would change them.

The tool configs (`flake.nix`, `.pre-commit-config.yaml`, the oxlint/oxfmt/tsconfig files, `tools/pyproject.toml`, `committed.toml`) are managed by [frappe-nix's app standards](https://github.com/Avunu/frappe-nix/tree/main/docs/app-standards) from Avunu's profile and `[tool.frappe-nix]` in `pyproject.toml`: change them there and run `nix run .#frappe-init -- --sync`; `frappe-nix sync --check` reports drift. The git hooks are [prek](https://prek.j178.dev)'s (`uv run --frozen --project tools prek install`, once per clone; `prek run --all-files` is what CI runs). Each tool is pinned — the JS ones by `package.json`, the Python ones by `tools/uv.lock`, ssort and test_utils by their hook `rev:` — and dependabot is the only thing that moves them. This app's own hooks (tsc, the unit tests, the commit subject) sit in the file's local region. In a nix shell without a CA bundle exported, `uv sync` may need `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.

`nix/node-locks/` holds **forced fallback locks** for the nested frontends (`frappe/ui`, `erpnext/banking`, `hrms/frontend`, `hrms/roster`): upstream ships a `yarn.lock` for each that is stale against its `package.json`, so frappe-nix's offline yarn install cannot use it as is. After a frappe/erpnext/hrms bump, `nix run .#relock -- --node-locks frappe/ui erpnext/banking hrms/frontend hrms/roster` refreshes them (seeded from upstream's lock, gaps filled from the registry). A plain `nix run .#relock` is a no-op on a current tree; on Dependabot's flake bumps the managed `deps.yml` runs it and commits the result.

`docs/` is what the documentation site (https://docs.avunu.net/carbon-theme/) publishes: `docs/README.md` is its home page and links to the other pages. `README.md` is the repository's front page; the blocks between `<!-- frappe-nix:begin … -->` markers in it are rendered by `frappe-init --sync` and must not be edited by hand.

`scripts/test-shell.ts` runs the same harness over the header, against ERPNext's Projects sidebar (7 rows, two sub-menus) and its 13-row Stock sidebar, both read from the site's `module_sidebars`: the name and links, sub-menu keyboard behaviour, `aria-current` (one row, the one frappe lit), the overflow, the switcher (the apps screen, forced by taking `boot.desktop_icons` out for one block, and the icon grid when the site is set to it), the hamburger beside a pinned dock, search, the bell and its panel, the badge and the account menu, the layout beside the dock and sidebar (including a floating dock), g100 parity in both themes, the dialog z-order, the landing page and the mobile no-mount case.

The `pagehead` suite (`CF_SITE_URL=http://127.0.0.1:8889 yarn test:shell pagehead`) covers the page head under the header, on documents every site has (a Role, a Language) that it reads and never saves: the breadcrumb trail as a Carbon eyebrow and 28px heading, the status as a Carbon tag beside the heading (placement, silhouette and the red / blue / green tag colours in both themes), the editable title (Edit glyph on hover and focus, a keyboard-reachable button, frappe's Rename dialog opening from a click and from Enter, and surviving a repaint of the trail), a list's single-crumb head with no rule, the page actions as one flush set of Carbon buttons, the Menu as an `es-menu` panel above the header, the dialog footer's full-bleed pair, and the one-hamburger rule between 768 and 991px.

The `assistant` suite (`CF_SITE_URL=http://127.0.0.1:8889 yarn test:shell assistant`; `CF_SITE_URL` defaults to `http://localhost:8794`) covers the AI chat end to end against a bench that has flow installed and `yarn build:chat` run: the header action and flow takeover, that the first desk load requests none of the chat bundle, the lazy open and its loading and failure states, streaming, sanitised markdown, tool steps, approvals (approve, deny, redirect), stop, errors and Try again, scroll pinning, keyboard, both themes, RTL, narrow and reduced-motion hosts, reload restore, then the conversation list (list, search, switch, rename, delete, windowing of a 200-message conversation), feedback, message times, the error layout, Try again, the setup-mode prompt and the reduced-motion dots, then attachments (picker, drop and paste with their refusals, client validation and flow's own refusals, progress and cancel, send, restore after a reload, Try again keeping the files, an open approval) against the mock model's `FILES` reply, which names the files it was given. Flow's model is `scripts/shell/mock-llm.ts`, an OpenAI-compatible server the suite starts itself (it also runs alone: `node scripts/shell/mock-llm.ts --port 8950`), so no provider key is needed. The suite creates a `CF AI Test` Flow Model, two Flow Tools, a Flow Agent, the sessions the cases need (the chats it has through the UI, a 200-message one and a trigger-sourced one that must never be listed), the ToDos the approvals create and the `CF AI Test` `File` docs its uploads leave, and removes all of it when it ends; after a killed run, `node scripts/shell/assistant.ts --cleanup-only` does the same. Flow's own panel is part of the takeover cases, so `sites/assets/flow` must be linked to `apps/flow/flow/public` (`bench build` links it; a dev bench that has not built since flow was added or its directory renamed has no such link). Without flow the suite checks that nothing of the assistant appears and exits 0. Screenshots land in `.dev-dist/screenshots/`.

`scripts/test-tables.ts` drives headless Chromium over the DevTools Protocol (no dependencies beyond Node 24 and `chromium` on PATH) against a running bench. It covers the engine in isolation, then each adapter's frappe contract: the `dt-*` selectors, `style.setStyle`, `rowmanager.getCheckedRows`, a report script's `get_datatable_options` / `formatter` / `after_datatable_render` / `getEditor` hooks, the Grid's inherited API, its >10-column layout, frappe's pixel column widths (`df.width`, a header drag and its `GridView` persistence, Configure Columns, a short grid's last column filling the spare width), its toolbar labels and its pagination, the List view's bulk actions, editing (the Check editor, the multi-line popover, paste), and g100 parity. Most of those assertions exist because that exact thing regressed once — several are specificity guards against frappe-datatable's, Bootstrap's or Carbon's own stylesheet quietly winning.

`scripts/dev-table.ts` builds the engine and a fixture page into `.dev-dist/` with no frappe present at all, which is where engine behaviour is verified before any adapter is involved.

`yarn build:chat` is the one build step `bench watch` skips, so the panel 404s on a bench that has never run it: the loader reports "could not be loaded" and offers Flow's own panel instead (see [AI assistant](ai-assistant.md) for why that is a button and not an automatic switch). Run it once per checkout, and after a dependency bump. While working on the chat, keep `yarn watch:chat` running next to `bench watch`: it rebuilds `js/ai_chat/**` and `scss/ai_chat/**` on save and rewrites `manifest.json` last; a page picks the new build up when it is reloaded, because the entry is imported once per page. `bench watch` and `yarn watch:chat` do not touch each other's output, but two chat builds at once would race on `public/dist/ai_chat`, so run only one. It is the last step of `yarn build` so a failing chat build cannot skip `patch-assets.ts`. `public/dist/ai_chat` is gitignored and holds content-hashed files plus a `manifest.json` that is renamed into place last, so rebuilding under an open page never leaves a manifest naming a missing file.

`@carbon/ai-chat-components` (like `@carbon/styles`, `@carbon/icons` and `@carbon/web-components`) has an `ibmtelemetry` postinstall that reports which of its elements and attributes a project uses. Per `@ibm/telemetry-js`, it collects only in CI and container environments, never on a local machine, and `IBM_TELEMETRY_DISABLED=true` turns it off. Set it for any `yarn add` or `yarn install` in a CI job or container you do not want counted; the nix build installs with `--ignore-scripts`, so it never runs there.

`scripts/dev-compile.ts` replicates frappe's exact sass pipeline (legacy API, `includePaths` = app roots + node\_modules, `~` importer), so bundles can be smoke-tested without a bench. The shell exports `FRAPPE_PATH`; set it yourself outside one.

## CI

The workflows are frappe-nix's shared ones ([CI](https://github.com/Avunu/frappe-nix/blob/main/docs/app-standards/ci.md)), called from small files `frappe-init --sync` renders and owns; each gate is a command, so `frappe-nix gate <gate>` runs locally exactly what GitHub runs. On every pull request and push to `develop`:

- `ci / pr-policy`: the base branch, the title and every commit (conventional, no major bump);
- `ci / lint`: `frappe-nix sync --check`, prek over the whole tree, semgrep with frappe's rules, and the ratchets;
- `ci / typecheck`: tsc, the unit tests, `types/doctypes.d.ts` against `frappe-types gen-registry`, then this app's `yarn ci:typecheck` (`scripts/ci-typecheck.sh`): `check:major`, codegen freshness, and `yarn compile` and `yarn audit:drift` against frappe, erpnext and hrms at the revisions `flake.lock` pins, laid out side by side;
- `ci / test`: `frappe-test --ci` in the dev shell (the Python tests with coverage, the hook test map, the composition check, ty and the Nix linters), after `nix build` (the app compiled in a clean bench) when the change can affect it;
- `ci / marketplace`: the listing.

`nightly.yml` runs the site-backed browser suites (`nightly-suites` in `pyproject.toml`), the screenshots and the listing's links. `regenerate.yml` is this app's own: it re-runs `yarn codegen` on a branch and commits what changed, so a dependency bump that only moves the generated files repairs itself. `docs.yml` checks the documentation as the docs site builds it.

Dependencies are on autopilot: dependabot covers npm, `tools/uv.lock`, the pre-commit hooks, the workflows' actions and the flake inputs (frappe, erpnext and hrms), and the managed `deps.yml` relocks `nix/` after a flake bump and merges what its decision table allows once the required checks are green. A frappe bump can legitimately fail the drift audits and need a follow-up commit; auto-merge simply waits. frappe-nix and the standards profile move only with `frappe-nix repo rollout`.

## Upgrading Carbon

Bump the exact-pinned `@carbon/*` versions, then `yarn install && yarn codegen && yarn audit:drift && yarn compile`, review the diff, and do a visual pass in both themes.

## Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please). Nobody edits the version by hand, and nobody pushes to `version-16`.

1. Land conventional commits on `develop` (`fix:` → patch, `feat:` → minor; the other types are left out of the changelog). Pull requests are squash-merged, so the title is the commit subject and is linted as one.
2. release-please keeps an open **release pull request** against `develop` with the next version and the accumulated changelog. Merging it _is_ the release: `release.yml` tags `v16.x.y`, cuts the GitHub release, and fast-forwards **`version-16`** — the production branch, what `bench get-app https://github.com/Avunu/carbon_theme --branch version-16` installs — to the release commit. `develop` carries `CHANGELOG.md` and the version; `version-16` is always exactly the latest release.
3. There is no artifact to publish: a frappe app installs from git, and `bench build` compiles the assets on the target.

**The major never moves on its own.** `carbon_theme@16.x.y` means "the theme for frappe v16" — the major is the frappe major, the way erpnext, hrms and frappe-types are versioned — so a `feat!:` subject or a `BREAKING CHANGE:` footer proposing 17.0.0 is a bug, not a release. The commit-msg hook and `ci / pr-policy` refuse both; `release.yml` runs CI on the release pull request, where `ci / typecheck`'s `yarn check:major` checks the version release-please actually proposes, and refuses to move `version-16` to a tag outside `v16.`; `yarn check:major` runs on every push and also cross-checks `frappe.major` in `package.json` against the flake's frappe pin. Breaking changes ship as `feat:` on the line they belong to. Moving to frappe v17 is a new `version-17` branch: point the flake input at `version-17`, set `frappe.major`/`frappe.branch`, and land a `Release-As: 17.0.0` commit. `scripts/check-frappe-major.ts` has the full rationale and the recovery for a stray `!` (an empty commit with a `Release-As:` footer).

Repository settings this relies on are what `frappe-nix repo doctor` checks ([GitHub settings](https://github.com/Avunu/frappe-nix/blob/main/docs/app-standards/github.md)): "Allow auto-merge" and "Allow GitHub Actions to create and approve pull requests" ON; `develop` requiring `ci / pr-policy`, `ci / lint`, `ci / typecheck`, `ci / test` and `ci / marketplace`; `version-16` moved only by the release automation.
