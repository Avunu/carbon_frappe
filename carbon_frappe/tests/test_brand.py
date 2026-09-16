# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Guards the per-site brand colour configuration (brand.py)."""

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase, UnitTestCase
from frappe.utils import set_request
from frappe.website.serve import get_response

from carbon_frappe import brand
from carbon_frappe.brand import (
	CARBON_DARK,
	CARBON_LIGHT,
	CARBON_SHELL,
	DEV_SHELL,
	blend,
	header_palette,
	is_dev,
	luma,
	palette,
	parse_hex,
	readable_on,
	render_css,
	shift,
)

EMPTY = {"brand_light": None, "brand_dark": None, "header_bg": None, "header_text": None}


def config(**fields):
	return {**EMPTY, **fields}


class TestColourHelpers(UnitTestCase):
	def test_parse_hex_accepts_both_forms(self):
		self.assertEqual(parse_hex("#ffffff"), (1.0, 1.0, 1.0))
		self.assertEqual(parse_hex("#fff"), (1.0, 1.0, 1.0))
		self.assertEqual(parse_hex("000000"), (0.0, 0.0, 0.0))

	def test_parse_hex_rejects_nonsense(self):
		"""A malformed colour must not raise mid-render."""
		for value in ("", "nope", None, "#12345", 42):
			self.assertIsNone(parse_hex(value))

	def test_shift_darkens_and_lightens(self):
		self.assertLess(shift("#808080", 0.2), "#808080")  # darker hex sorts lower
		self.assertGreater(shift("#808080", -0.2), "#808080")
		# and never runs off either end
		self.assertEqual(shift("#000000", 0.5), "#000000")
		self.assertEqual(shift("#ffffff", -0.5), "#ffffff")

	def test_shift_passes_through_nonsense(self):
		self.assertEqual(shift("nope", 0.1), "nope")

	def test_blend_moves_between_two_colours(self):
		self.assertEqual(blend("#000000", "#ffffff", 0.0), "#000000")
		self.assertEqual(blend("#000000", "#ffffff", 1.0), "#ffffff")
		self.assertEqual(blend("#000000", "#ffffff", 0.5), "#808080")
		self.assertEqual(blend("nope", "#ffffff", 0.5), "nope")

	def test_readable_on_picks_contrast(self):
		self.assertEqual(readable_on("#ffffff"), "#161616")
		self.assertEqual(readable_on("#161616"), "#f4f4f4")


class TestPalette(UnitTestCase):
	def test_defaults_are_carbons_own(self):
		self.assertEqual(palette(EMPTY)["brand"], CARBON_LIGHT["brand"])
		self.assertEqual(palette(EMPTY)["brand_hover"], CARBON_LIGHT["brand_hover"])
		self.assertEqual(palette(EMPTY, dark=True)["brand"], CARBON_DARK["brand"])
		self.assertEqual(palette(EMPTY, dark=True)["link"], CARBON_DARK["link"])

	def test_dark_is_derived_from_light_when_unset(self):
		"""The reason light and dark are separate fields at all.

		Carbon lightens its interactive tone on g100 because a mid-dark colour
		does not carry against near-black. A site that sets only a light brand
		must still get a legible dark one.
		"""
		cfg = config(brand_light="#009d9a")
		light = palette(cfg)["brand"]
		dark = palette(cfg, dark=True)["brand"]
		self.assertEqual(light, "#009d9a")
		self.assertNotEqual(dark, light)
		self.assertGreater(sum(parse_hex(dark)), sum(parse_hex(light)), "dark brand should be lighter")

	def test_explicit_dark_wins_over_derivation(self):
		cfg = config(brand_light="#009d9a", brand_dark="#ff00ff")
		self.assertEqual(palette(cfg, dark=True)["brand"], "#ff00ff")

	def test_hover_moves_away_from_the_theme_background(self):
		"""Light darkens on hover, dark brightens."""
		cfg = config(brand_light="#009d9a", brand_dark="#009d9a")
		self.assertLess(luma(palette(cfg)["brand_hover"]), luma("#009d9a"))
		self.assertGreater(luma(palette(cfg, dark=True)["brand_hover"]), luma("#009d9a"))

	def test_on_brand_follows_contrast(self):
		self.assertEqual(palette(config(brand_light="#f1c21b"))["on_brand"], "#161616")  # yellow
		self.assertEqual(palette(config(brand_light="#002d9c"))["on_brand"], "#f4f4f4")  # deep blue


class TestHeaderPalette(UnitTestCase):
	def test_carbon_shell_emits_nothing(self):
		"""Carbon's own g100 shell values are hand-tuned; never write over them."""
		self.assertIsNone(header_palette(None))
		self.assertIsNone(header_palette(CARBON_SHELL["bg"]))
		self.assertIsNone(header_palette("#161616", "#ffffff"))

	def test_header_text_auto_contrasts(self):
		self.assertEqual(header_palette("#ffffff")["text"], "#161616")
		self.assertEqual(header_palette("#0f62fe")["text"], "#f4f4f4")
		self.assertEqual(header_palette("#ffffff", "#ff0000")["text"], "#ff0000")

	def test_header_hover_moves_away_from_the_background(self):
		"""Light headers must darken on hover, dark ones lighten.

		Carbon's shell lightens because it is near-black; applying that blindly
		to a light header would make "hover" mean "wash out".
		"""
		dark = header_palette("#262626")
		self.assertGreater(luma(dark["hover"]), luma("#262626"))
		self.assertGreater(luma(dark["layer"]), luma("#262626"))
		light = header_palette("#f4f4f4")
		self.assertLess(luma(light["hover"]), luma("#f4f4f4"))
		self.assertLess(luma(light["layer"]), luma("#f4f4f4"))

	def test_color_scheme_follows_polarity(self):
		self.assertEqual(header_palette("#ffffff")["color_scheme"], "light")
		self.assertEqual(header_palette("#262626")["color_scheme"], "dark")


class TestStylesheet(UnitTestCase):
	def test_untouched_site_emits_no_tokens(self):
		"""No configuration, no declarations -- the bundle's defaults stand."""
		css = render_css(EMPTY, dev=False)
		self.assertNotIn("{", css)
		self.assertNotIn("--cds-", css)

	def test_brand_reaches_every_role(self):
		css = render_css(config(brand_light="#009d9a"))
		for token in (
			"--cds-interactive",
			"--cds-focus",
			"--cds-border-interactive",
			"--cds-background-brand",
			"--cds-button-primary",
			"--btn-primary",
			"--primary",
		):
			self.assertIn(f"{token}: #009d9a", css, f"{token} did not take the brand")

	def test_blocks_are_ordered_light_then_dark(self):
		"""On <html> in dark mode both groups match; the dark one must be later."""
		css = render_css(config(brand_light="#009d9a"))
		self.assertLess(
			css.index('html:root,\nhtml[data-theme="light"]'), css.index('html[data-theme="dark"]')
		)
		self.assertIn(".cf-zone-g100", css.split('html[data-theme="dark"]')[1].split("}")[0])

	def test_outranks_the_bundles_without_important(self):
		"""login.bundle.css lands AFTER web_include_css and re-emits the g10
		tokens on :root, so the brand must beat it by specificity, not order."""
		css = render_css(config(brand_light="#009d9a", header_bg="#e8574c"), dev=True)
		for selector in ("html:root", 'html[data-theme="light"]', 'html[data-theme="dark"]', "html.dark"):
			self.assertIn(selector, css)
		self.assertNotIn("\n:root", css)
		self.assertNotIn('\n[data-theme="light"]', css)

	def test_only_dark_configured_leaves_light_alone(self):
		css = render_css(config(brand_dark="#ff00ff"))
		self.assertNotIn('html[data-theme="light"]', css)
		self.assertIn("--cds-interactive: #ff00ff", css)

	def test_dark_keeps_carbons_white_focus(self):
		"""g100 draws focus, interactive icons and the tertiary button in white."""
		css = render_css(config(brand_light="#009d9a"))
		dark_block = css.split('[data-theme="dark"]')[1]
		for token in ("--cds-focus", "--cds-icon-interactive", "--cds-button-tertiary"):
			self.assertNotIn(token, dark_block)

	def test_light_brand_gets_dark_text(self):
		css = render_css(config(brand_light="#f1c21b"))
		self.assertIn("--carbon-text-on-brand: #161616", css)
		# but the global text-on-color (danger buttons, badge) is never touched
		self.assertNotIn("--cds-text-on-color", css)

	def test_style_needs_no_important(self):
		"""We win by cascade order, not escalation."""
		css = render_css(config(brand_light="#009d9a", header_bg="#e8574c"), dev=True)
		self.assertNotIn("!important", css)

	def test_style_emits_only_literal_colours(self):
		"""No unevaluated colour functions inside custom property values."""
		css = render_css(config(brand_light="#009d9a", header_bg="#e8574c"), dev=True)
		for fn in ("darken(", "lighten(", "mix(", "hsl("):
			self.assertNotIn(fn, css)

	def test_header_block_absent_by_default(self):
		css = render_css(config(brand_light="#009d9a"))
		self.assertNotIn("--cds-background:", css)
		self.assertNotIn("--carbon-header-bg", css)

	def test_header_repoints_the_zone_and_the_aliases(self):
		"""A branded header must carry its menus, panels, text and the website
		navbar/footer with it, or they sit as g100 blocks on a coloured bar."""
		css = render_css(config(header_bg="#e8574c"))
		zone = css.split(".cf-zone-g100 {")[1].split("}")[0]
		for token in (
			"--cds-background: #e8574c",
			"--cds-background-hover",
			"--cds-layer-01",
			"--cds-layer-hover-01",
			"--cds-text-primary: #f4f4f4",
			"--cds-icon-primary",
			"--cds-border-subtle-00",
			"--cds-focus",
			"color-scheme: dark",
		):
			self.assertIn(token, zone, f"{token} is not re-pointed on the header zone")
		self.assertIn("--carbon-header-bg: #e8574c", css)
		self.assertIn("--carbon-header-layer", css)

	def test_light_header_uses_light_polarity_brand(self):
		"""Blue-60 reads on a white bar; blue-50 (the dark palette) is for g100."""
		css = render_css(config(header_bg="#ffffff"))
		zone = css.split(".cf-zone-g100 {")[1].split("}")[0]
		self.assertIn(f"--cds-border-interactive: {CARBON_LIGHT['brand']}", zone)
		self.assertIn("color-scheme: light", zone)

	def test_dev_paints_the_header_amber_and_stripes_the_page(self):
		css = render_css(config(brand_light="#009d9a", header_bg="#e8574c"), dev=True)
		self.assertIn(f"--cds-background: {DEV_SHELL['bg']}", css)
		self.assertIn("repeating-linear-gradient", css)
		# stripes on the bar alone, running under idle menu items
		self.assertNotIn(".page-container", css)
		self.assertNotIn("html,", css)
		self.assertIn(
			"a.cds--header__menu-item:not(:hover):not(:active) {\n\tbackground-color: transparent;", css
		)
		# the configured header's zone block is replaced, not stacked
		self.assertNotIn("--cds-background: #e8574c", css)
		# but the footer keeps the configured colour through the :root aliases
		self.assertIn("--carbon-header-bg: #e8574c", css)
		# and the brand is untouched by dev
		self.assertIn("--cds-interactive: #009d9a", css)

	def test_dev_alone_emits_no_brand_tokens(self):
		css = render_css(EMPTY, dev=True)
		self.assertNotIn("--cds-interactive: #0f62fe", css.split(".cf-zone-g100 {")[0])
		self.assertIn(DEV_SHELL["bg"], css)


class TestDevDetection(UnitTestCase):
	def _dev_for(self, host, cookies=None, conf=None):
		set_request(path="/carbon-brand.css", base_url=f"http://{host}", headers={"Cookie": cookies or ""})
		with patch.dict(frappe.conf, conf or {}, clear=False):
			if conf is None:
				frappe.conf.pop(brand.DEV_INDICATOR_KEY, None)
			return is_dev()

	def test_local_hostnames(self):
		for host in ("localhost:8000", "127.0.0.1:8000", "frappe.localhost:8889", "[::1]:8000"):
			self.assertTrue(self._dev_for(host), host)

	def test_public_hostnames(self):
		for host in ("erp.example.com", "localhost.example.com", "10.0.0.5:8000"):
			self.assertFalse(self._dev_for(host), host)

	def test_cookie_overrides_hostname(self):
		self.assertFalse(self._dev_for("localhost:8000", cookies="carbon_dev_indicator=0"))
		self.assertTrue(self._dev_for("erp.example.com", cookies="carbon_dev_indicator=1"))

	def test_site_config_overrides_everything(self):
		self.assertFalse(
			self._dev_for(
				"localhost:8000", cookies="carbon_dev_indicator=1", conf={"carbon_dev_indicator": 0}
			)
		)
		self.assertTrue(self._dev_for("erp.example.com", conf={"carbon_dev_indicator": 1}))


class TestBrandStylesheet(IntegrationTestCase):
	"""The stylesheet as served through frappe's website path resolver."""

	FIELDS = ("brand_light", "brand_dark", "header_bg", "header_text")

	def setUp(self):
		super().setUp()
		self.saved = {f: frappe.db.get_single_value("Carbon Settings", f) for f in self.FIELDS}
		self._set(**dict.fromkeys(self.FIELDS))

	def tearDown(self):
		self._set(**self.saved)
		super().tearDown()

	def _set(self, **values):
		for field, value in values.items():
			frappe.db.set_single_value("Carbon Settings", field, value)
		frappe.clear_document_cache("Carbon Settings", "Carbon Settings")

	def _get(self, host="erp.example.com", **headers):
		set_request(path="/carbon-brand.css", base_url=f"http://{host}", headers=headers)
		return get_response()

	def test_serves_css(self):
		response = self._get()
		self.assertEqual(response.status_code, 200)
		self.assertIn("text/css", response.headers["Content-Type"])
		self.assertIn("carbon_frappe", response.get_data(as_text=True))
		self.assertTrue(response.headers.get("ETag"))
		self.assertIn("no-cache", response.headers.get("Cache-Control", ""))

	def test_settings_reach_the_stylesheet(self):
		self._set(brand_light="#8a3ffc", header_bg="#e8574c")
		css = self._get().get_data(as_text=True)
		self.assertIn("--cds-interactive: #8a3ffc", css)
		self.assertIn("--cds-background: #e8574c", css)

	def test_etag_revalidation(self):
		etag = self._get().headers["ETag"]
		self.assertEqual(self._get(**{"If-None-Match": etag}).status_code, 304)
		self._set(brand_light="#8a3ffc")
		self.assertEqual(self._get(**{"If-None-Match": etag}).status_code, 200)

	def test_dev_indicator_on_localhost(self):
		self.assertIn(DEV_SHELL["bg"], self._get(host="frappe.localhost:8889").get_data(as_text=True))
		self.assertNotIn(DEV_SHELL["bg"], self._get(host="erp.example.com").get_data(as_text=True))
		self.assertNotIn(
			DEV_SHELL["bg"],
			self._get(host="frappe.localhost:8889", Cookie="carbon_dev_indicator=0").get_data(as_text=True),
		)

	def test_broken_palette_never_breaks_the_page(self):
		"""An HTML error page served as the stylesheet would leave the theme
		silently Carbon blue with nothing in the response to say why."""
		with patch.object(brand, "render_css", side_effect=ValueError("boom")):
			response = self._get()
		self.assertEqual(response.status_code, 200)
		self.assertIn("text/css", response.headers["Content-Type"])
		self.assertIn("unavailable", response.get_data(as_text=True))

	def test_validate_rejects_non_hex(self):
		doc = frappe.get_doc("Carbon Settings")
		# `Document.set`, not attribute assignment: frappe types the Single
		# overload of `get_doc` as a bare Document, on which the field is unknown
		doc.set("brand_light", "not-a-colour")
		self.assertRaises(frappe.ValidationError, doc.save)
