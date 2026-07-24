# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Inject the Carbon tokens stylesheet into frappe-ui SPA pages.

CRM, Helpdesk and ERPNext Banking are Vite/Tailwind single-page apps. Their HTML
is a `www/` Jinja template that renders as a standalone document (it contains a
`</body>`, so frappe never wraps it in base.html / includes/head.html) — which is
why `web_include_css` cannot reach them and the assets.json bundle-shadow trick
(used for frappe's own desk/website bundles) does not apply: their CSS is a Vite
build artifact referenced by a hardcoded hashed path, not an assets.json key.

Instead we ride the page_renderer hook. This subclass claims only the known SPA
paths *whose providing app is installed on this bench* — so a bench without CRM
(etc.) is untouched — inherits the entire real TemplatePage pipeline (context,
boot, csrf, preload headers), and injects one `<link>` into `<head>`. The hashed
URL is resolved at request time via assets.json, so it never goes stale.

Mirrors insights.utils.InsightsPageRenderer.
"""

import frappe
from frappe.website.page_renderers.template_page import TemplatePage

# First path segment -> app that must be installed for us to theme it.
# Extend this to cover a new frappe-ui SPA served from another app's www/.
SPA_APPS = {
	"crm": "crm",
	"helpdesk": "helpdesk",
	"banking": "erpnext",
}

CARBON_UI_BUNDLE = "carbon_frappe_ui.bundle.css"


class CarbonSPARenderer(TemplatePage):
	def can_render(self):
		try:
			path = frappe.request.path
		except BaseException:
			path = self.path

		segment = (path or "").strip("/").split("/", 1)[0]
		provider = SPA_APPS.get(segment)
		if not provider or provider not in frappe.get_installed_apps():
			return False

		# Only claim it if TemplatePage actually resolves a template for this path.
		return super().can_render()

	def render(self):
		html = self.get_html()
		html = self.add_csrf_token(html)
		html = self._inject_carbon_css(html)
		return self.build_response(html)

	def _inject_carbon_css(self, html):
		if not html or "</head>" not in html:
			return html

		try:
			from frappe.utils.jinja_globals import include_style

			link = include_style(CARBON_UI_BUNDLE)
		except Exception:
			# Never let a theming asset break the app render.
			frappe.log_error("carbon_frappe: failed to resolve " + CARBON_UI_BUNDLE)
			return html

		return html.replace("</head>", f"{link}\n</head>", 1)
