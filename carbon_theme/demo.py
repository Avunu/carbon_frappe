# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Demo data for frappe-demo and the screenshots in docs/screenshots/.

The theme has no records of its own to show: what the screenshots need is
ERPNext's demo transactions (the screenshot spec asks frappe-demo for them),
so the lists, reports and forms are populated. This hook does the one thing
the theme needs on top: the demo site is served from `<site>.localhost`, where
the header would otherwise carry the dev indicator, so it turns that off and
the screenshots show Carbon's own header.
"""

from typing import Any

import frappe
from frappe.installer import update_site_config

from carbon_theme.brand import DEV_INDICATOR_KEY


def setup(_ctx: dict[str, Any]) -> None:
	"""Turn the dev indicator off for the demo site; a second run changes nothing.

	The context (the demo's date and seed) is not needed: nothing here is dated.
	"""
	if frappe.conf.get(DEV_INDICATOR_KEY) == 0:
		return
	update_site_config(DEV_INDICATOR_KEY, 0)
