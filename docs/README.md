# Carbon Theme for Frappe

IBM Carbon Design System theme for the Frappe desk, website, login and email

This app restyles Frappe and ERPNext as if they had been designed with IBM's [Carbon Design System](https://carbondesignsystem.com) (v11): IBM Plex type, square corners, Carbon's colour tokens and focus rings, the Carbon UI Shell header and Carbon's chart palettes. It replaces Frappe's own stylesheets rather than layering on top of them, so each surface loads one stylesheet. It targets Frappe v16 (16.50 or later).

## What you get

- Every surface themed: the desk, the website and portal, the login page, e-mail, charts, and the frappe-ui apps. Light mode is Carbon's g10 theme, dark mode its g100 theme.
- The Carbon UI Shell header, built from Frappe's module sidebar, with search, notifications, the account menu and an app switcher.
- One TanStack-driven Carbon table engine behind child tables, the List view and the Report and Query views.
- Brand colours for light and dark, and a striped yellow header on local development sites.
- An AI assistant panel built from Carbon AI Chat, when the flow app is installed.
- Drift audits that catch the silent breakage a Frappe or Carbon upgrade can cause.

## Installation

```bash
bench get-app https://github.com/Avunu/carbon_theme --branch develop
bench --site <site> install-app carbon_theme
bench build
```

The theme applies to every site on the bench, so install it on a bench of its own. [Deploying](deploying.md) explains how to check that it is being served and what can undo it.

## Pages

- [Deploying](deploying.md): installing, verifying, the caveats and the drift guards.
- [Configuration](configuration.md): brand colours in Carbon Settings and the dev indicator.
- [How it works](how-it-works.md): stylesheet shadowing, the token mapping, frappe-ui apps, e-mail and the deliberate deviations from Carbon.
- [UI Shell header](ui-shell.md): what the header shows and how it follows Frappe's sidebar.
- [Tables](tables.md): the table engine, what it changes and what stays compatible.
- [AI assistant](ai-assistant.md): the chat panel for flow, its behaviour and its integration seams.
- [Development](development.md): the dev shell, the checks, the browser suites, CI and releasing.

## License

[MIT](https://github.com/Avunu/carbon_theme/blob/develop/license.txt), Copyright (c) 2026–present Avunu LLC. IBM Plex is included under the SIL Open Font License.
