# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Guards the Vite SPA stylesheet injection (injector.py, the after_request hook)."""

from unittest.mock import patch

from frappe.tests import UnitTestCase
from werkzeug.wrappers import Response

from carbon_theme import injector
from carbon_theme.injector import BRAND_STYLESHEET, inject_carbon_ui_css

HREF = "/assets/carbon_theme/dist/css/carbon_frappe_ui.bundle.TEST.css"
SPA = (
	b"<!doctype html><html><head><title>CRM</title>"
	b'<script type="module" crossorigin src="/assets/crm/frontend/assets/index-abc.js"></script>'
	b"</head><body><div id=app></div></body></html>"
)
DESK = (
	b'<!doctype html><html><head><script src="/assets/frappe/dist/js/desk.bundle.js"></script></head></html>'
)


def html(body, status=200, content_type="text/html; charset=utf-8"):
	return Response(body, status=status, content_type=content_type)


class TestInjectCarbonUiCss(UnitTestCase):
	def setUp(self):
		patcher = patch.object(injector, "bundled_asset", return_value=HREF)
		self.bundled_asset = patcher.start()
		self.addCleanup(patcher.stop)

	def test_vite_spa_gets_both_stylesheets_in_its_head(self):
		response = inject_carbon_ui_css(html(SPA))
		data = response.get_data()
		head, _, body = data.partition(b"</head>")
		self.assertIn(injector._SENTINEL, head)
		self.assertIn(f'href="{HREF}"'.encode(), head)
		self.assertIn(f'href="{BRAND_STYLESHEET}"'.encode(), head)
		self.assertNotIn(b"stylesheet", body)
		self.bundled_asset.assert_called_once_with(injector.CARBON_UI_BUNDLE)

	def test_injects_once(self):
		"""A response that already carries the sentinel is left alone (a second pass, a cached body)."""
		once = inject_carbon_ui_css(html(SPA)).get_data()
		twice = inject_carbon_ui_css(html(once)).get_data()
		self.assertEqual(once, twice)
		self.assertEqual(twice.count(injector._SENTINEL), 1)

	def test_desk_and_portal_pages_are_skipped(self):
		"""frappe's esbuild bundles carry no `type="module" crossorigin` entry."""
		self.assertEqual(inject_carbon_ui_css(html(DESK)).get_data(), DESK)
		self.bundled_asset.assert_not_called()

	def test_non_html_responses_are_skipped(self):
		for content_type in ("application/json", "text/css", ""):
			with self.subTest(content_type=content_type):
				response = html(SPA, content_type=content_type)
				if not content_type:
					del response.headers["Content-Type"]
				self.assertEqual(inject_carbon_ui_css(response).get_data(), SPA)

	def test_error_and_redirect_responses_are_skipped(self):
		for status in (302, 404, 500):
			with self.subTest(status=status):
				self.assertEqual(inject_carbon_ui_css(html(SPA, status=status)).get_data(), SPA)

	def test_a_document_without_a_head_is_skipped(self):
		body = b'<script type="module" crossorigin src="/x.js"></script>'
		self.assertEqual(inject_carbon_ui_css(html(body)).get_data(), body)

	def test_streamed_responses_are_not_read(self):
		response = html(SPA)
		response.direct_passthrough = True
		with patch.object(Response, "get_data") as get_data:
			self.assertIs(inject_carbon_ui_css(response), response)
		get_data.assert_not_called()

	def test_no_response_passes_through(self):
		self.assertIsNone(inject_carbon_ui_css(None))

	def test_a_failure_never_breaks_the_page(self):
		self.bundled_asset.side_effect = RuntimeError("assets.json unreadable")
		with patch.object(injector.frappe, "logger") as logger:
			response = inject_carbon_ui_css(html(SPA))
		self.assertEqual(response.get_data(), SPA)
		logger.return_value.error.assert_called_once()
