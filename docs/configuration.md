# Brand colours and the dev indicator

**Desk → Carbon Settings** (System Manager). Four colours, all optional; anything left empty falls back to Carbon's own value, so a site that sets one colour still gets a coherent palette.

The brand colour is not a header tint. It sets Carbon's _interactive_ role, so one value reaches primary buttons, links, focus rings, selected rows, the sidebar selection bar and the active tab — everywhere the theme draws on `--cds-interactive` and `--cds-button-primary`. The header is configured separately, because tinting the bar and rebranding the controls are different decisions.

**Light and dark are separate fields on purpose.** Carbon does not reuse one interactive tone across themes: its own is Blue 60 `#0f62fe` on g10 and the lighter Blue 50 `#4589ff` on g100, because a mid-dark colour that reads well on `#f4f4f4` does not carry against `#161616`. Set only the light one and the dark variant is derived by lightening it; set both to control each exactly. Hover, active and text-on-brand are derived too — hover darkens in light and brightens in dark, and the button label flips to near-black on a light brand (yellow, lime). Danger stays red-with-white regardless.

A header colour re-points every token Carbon's UI Shell CSS reads on the zone element (`cf-zone-g100`) — background, hover/active, the `$layer` family behind sub-menus and the notification/switcher panels, text, icons, focus, `color-scheme` — so a light header gets light menus rather than g100 blocks sitting on a coloured bar. The website navbar, footer and the theme-switcher preview strip follow through `--carbon-header-*` aliases. Carbon's own `#161616` shell is left untouched: its values are hand-tuned and the shell parity tests assert them.

## Dev indicator

On `localhost`, `127.0.0.1`, `::1` or any `*.localhost` host (frappe-nix benches serve `<site>.localhost`) the header is painted Carbon yellow-30 `#f1c21b` with near-black text and a diagonal hazard-stripe overlay running under the menu items (idle links go transparent; hover, active and open-menu states keep their tones), so a development tab can never be mistaken for production. The stripes stay on the bar alone — across the page they never line up between header, sidebar and content column. The brand colour still applies; the configured header colour is replaced on the bar but kept on the footer. It is decided server-side from the request host, so there is no flash.

Overrides, in order of precedence: `carbon_dev_indicator` in `site_config.json` (`bench --site <site> set-config carbon_dev_indicator 0`), then a `carbon_dev_indicator` cookie (`scripts/tables/cdp.ts` sets it to `0` after login, because the shell parity tests run against localhost and assert the g100 bar), then the hostname.

## Not branded, deliberately

- Espresso's status-blue slots (`--surface-blue-*`, `--ink-blue-*`: Draft/Submitted pills, info callouts) — Carbon keeps blue as the informational colour regardless of brand.
- The dark focus ring, interactive icons and the tertiary button in dark mode — g100 draws them white.
- Email (Premailer literals; see [Email](how-it-works.md#email)) and, on website pages, Bootstrap-compiled utilities such as `.text-primary` — set Website Theme's `primary_color` as well if those matter.
- If a catch-all Website Route Redirect or a stale `website_404` cache entry ever 404s `/carbon-brand.css`, the theme silently falls back to Carbon blue; `frappe.clear_cache()` (which Carbon Settings runs on save) clears the latter.
