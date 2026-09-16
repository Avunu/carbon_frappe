# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from carbon_frappe.brand import parse_hex

COLOUR_FIELDS = ("brand_light", "brand_dark", "header_bg", "header_text")


class CarbonSettings(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		brand_dark: DF.Color | None
		brand_light: DF.Color | None
		header_bg: DF.Color | None
		header_text: DF.Color | None
	# end: auto-generated types

	def validate(self):
		# brand.py degrades a malformed colour to "unset" rather than raising,
		# so a bad value would be silently ignored; catch it at the form instead.
		for fieldname in COLOUR_FIELDS:
			value = self.get(fieldname)
			if value and parse_hex(value) is None:
				frappe.throw(
					_("{0} must be a hex colour like #0f62fe").format(_(self.meta.get_label(fieldname)))
				)

	def on_update(self):
		# The single-document cache is dropped by the framework on save; this
		# clears the website page/404 caches so /carbon-brand.css and every
		# page that links it are rebuilt on the next request.
		frappe.clear_cache()
