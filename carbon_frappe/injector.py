# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Inject the Carbon tokens stylesheet into every frappe-ui / Vite SPA page.

CRM, Helpdesk, Banking, Builder, Insights, Wiki, HRMS — and any future frappe-ui
app — serve a standalone www/ document that bypasses base.html, so *_include_css
can't reach them and the assets.json bundle-shadow (used for frappe's own
desk/website bundles) doesn't apply: their CSS is a Vite build artifact at a
hardcoded hashed path, not an assets.json key.

Rather than enumerate each app's route, this rides frappe's `after_request` hook
(run for every response, just before process_response — see
frappe/app.py:run_after_request_hooks) and injects one <link> into any HTML
response that is a Vite SPA. The detector is Vite's ES-module entry signature
(`<script type="module" ... crossorigin ...>`), which frappe's own esbuild
desk/website bundles and portal pages never emit — so desk (/app), website, and
JSON / asset responses are all skipped. The hashed URL is resolved at request
time via assets.json, so it never goes stale. New frappe-ui apps are covered
automatically, with no per-app registration.
"""

import frappe
from frappe.utils.jinja_globals import bundled_asset

CARBON_UI_BUNDLE = "carbon_frappe_ui.bundle.css"
# Our own dedup sentinel — NOT the asset name. Several SPA boots embed the
# assets.json (which lists carbon_frappe_ui.bundle.css) in the page body, so a
# bare-name substring check would false-positive and skip injection.
_SENTINEL = b"<!--carbon-frappe-ui-->"


def inject_carbon_ui_css(response=None, request=None):
	"""after_request hook: add carbon_frappe_ui.bundle.css to Vite SPA <head>s."""
	try:
		if response is None or getattr(response, "status_code", None) != 200:
			return response
		# file / streamed responses expose no in-memory body
		if getattr(response, "direct_passthrough", False):
			return response
		if "text/html" not in (response.headers.get("Content-Type") or ""):
			return response

		data = response.get_data()
		if b"</head>" not in data or _SENTINEL in data:
			return response
		# Vite SPA entry signature; frappe's esbuild bundles & portal pages lack it.
		if b'type="module"' not in data or b"crossorigin" not in data:
			return response

		# bundled_asset resolves the hashed path and auto-selects the rtl_ variant
		# for RTL sites (it calls is_rtl() internally).
		href = bundled_asset(CARBON_UI_BUNDLE)
		link = _SENTINEL + f'<link rel="stylesheet" type="text/css" href="{href}">'.encode()
		response.set_data(data.replace(b"</head>", link + b"</head>", 1))
	except Exception:
		# a theming asset must never break the app render
		frappe.logger("carbon_frappe").error("SPA CSS injection failed", exc_info=True)
	return response
