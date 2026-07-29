# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

app_name = "carbon_frappe"
app_title = "Carbon Frappe"
app_publisher = "Avunu LLC"
app_description = "Carbon Design System theme for Frappe."
app_email = "mail@avu.nu"
app_license = "MIT"

# Theme CSS is delivered by shadowing frappe's own bundle names in assets.json
# (desk/website/login/email .bundle.css), not via *_include_css hooks.
# See build.py and scripts/patch-assets.mjs.

# carbon_charts: injects Carbon categorical colors into frappe.Chart and
#   re-themes those charts on theme change.
# carbon_desk: tags formatted numeric/date output with `carbon-num` so the
#   stylesheet can set IBM Plex Mono on it (reaches frappe-datatable, which
#   emits no fieldtype or alignment class of its own).
# carbon_anatomy: the only places the theme reaches past CSS — 48px datatable
#   rows, the Carbon page header, and the UI Shell header. Every patch
#   delegates to the original and fails soft; see js/anatomy/patch.js.
app_include_js = [
    "carbon_charts.bundle.js",
    "carbon_desk.bundle.js",
    "carbon_anatomy.bundle.js",
]

# frappe-ui / Vite SPA pages (CRM, Helpdesk, Banking, Builder, Insights, Wiki,
# HRMS, and any future app) bypass base.html, so *_include_css can't reach them
# and the assets.json bundle-shadow doesn't apply. This after_request hook injects
# carbon_frappe_ui.bundle.css into any HTML response carrying Vite's ES-module
# entry signature — covering all such apps generically. See injector.py.
after_request = ["carbon_frappe.injector.inject_carbon_ui_css"]

# Re-assert the assets.json shadow after migrations (heals partial
# `bench build --apps frappe` runs that re-point the keys at frappe's assets).
after_migrate = ["carbon_frappe.build.patch_assets"]
after_app_install = ["carbon_frappe.build.patch_assets"]
