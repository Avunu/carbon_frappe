# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""The demo hook frappe-demo calls (`carbon_theme.demo.setup`)."""

import datetime
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from carbon_theme import demo
from carbon_theme.brand import DEV_INDICATOR_KEY

CTX = {"today": datetime.date(2026, 1, 15), "seed": 1, "company": None, "erpnext_demo": False}


class TestDemo(IntegrationTestCase):
	def test_setup_turns_the_dev_indicator_off(self):
		# site_config.json is not touched: the write is checked, not made.
		with (
			patch.dict(frappe.local.conf, {DEV_INDICATOR_KEY: None}),
			patch.object(demo, "update_site_config") as update,
		):
			demo.setup(CTX)
		update.assert_called_once_with(DEV_INDICATOR_KEY, 0)

	def test_setup_is_idempotent(self):
		with (
			patch.dict(frappe.local.conf, {DEV_INDICATOR_KEY: 0}),
			patch.object(demo, "update_site_config") as update,
		):
			demo.setup(CTX)
		update.assert_not_called()
