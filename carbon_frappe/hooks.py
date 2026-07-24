# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

app_name = "carbon_frappe"
app_title = "Carbon Frappe"
app_publisher = "Avunu LLC"
app_description = "Carbon Design System theme for Frappe."
app_email = "mail@avu.nu"
app_license = "MIT"

# Theme CSS is delivered by shadowing frappe's own bundle names in assets.json
# (desk/website/login/email/print .bundle.css), not via *_include_css hooks.
# See build.py and scripts/patch-assets.mjs.

# Chart palette shim: injects Carbon categorical colors into frappe.Chart
app_include_js = ["carbon_charts.bundle.js"]

# frappe-ui SPA pages (CRM/Helpdesk/Banking) bypass base.html, so *_include_css
# can't reach them. This renderer injects carbon_frappe_ui.bundle.css into their
# <head>, but only for SPAs whose app is installed on the bench. See renderer.py.
page_renderer = ["carbon_frappe.renderer.CarbonSPARenderer"]

# Re-assert the assets.json shadow after migrations (heals partial
# `bench build --apps frappe` runs that re-point the keys at frappe's assets).
after_migrate = ["carbon_frappe.build.patch_assets"]
after_app_install = ["carbon_frappe.build.patch_assets"]

fixtures = [{"dt": "Print Style", "filters": [["name", "in", ["Carbon"]]]}]
