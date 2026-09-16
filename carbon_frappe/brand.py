# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Per-site brand colours, expressed as Carbon design tokens.

A brand colour is set once (Carbon Settings) and reaches everything the theme
draws from Carbon's interactive family: primary buttons, links, focus rings,
selected rows, the sidebar selection bar, the current-tab underline. It is not
a header tint — the header is a separate setting precisely because the two are
different decisions.

Light and dark are separate colours on purpose. Carbon does not reuse one
interactive tone across themes: its own is Blue 60 (#0f62fe) on g10 and the
lighter Blue 50 (#4589ff) on g100, because a mid-dark blue that reads well on
#f4f4f4 does not carry against #161616. A dark variant is either given or
derived by lightening.

Delivery is a stylesheet served at /carbon-brand.css (page_renderer hook,
BrandStylesheet below) and linked after the theme bundles by app_include_css,
web_include_css and injector.py. Every value is a CSS custom property declared
on the same elements the bundles use (`html:root` / `html[data-theme=…]`,
one specificity notch above the bundles' `:root` / `[data-theme=…]`, and the
`.cf-zone-g100` header zone), so it wins without !important wherever the link
lands in the head. Frappe flips theme client-side via data-theme, so both
variants are emitted and the cascade picks. Nothing at all is emitted until
something is configured, so an untouched site is byte-for-byte stock Carbon.

Shades are computed here rather than emitted as CSS colour functions: these
are custom property values, and a function inside one that the browser does
not understand is silently ignored.

The dev indicator (amber, striped header) is decided per request
from the hostname, so a developer's localhost bench is unmistakable next to
the production tab. See is_dev() for the override order.
"""

import hashlib
from colorsys import hls_to_rgb, rgb_to_hls
from urllib.parse import urlsplit

import frappe
from frappe.utils import cint
from frappe.website.page_renderers.base_renderer import BaseRenderer

STYLESHEET_PATH = "carbon-brand.css"
DEV_INDICATOR_KEY = "carbon_dev_indicator"

# Carbon's own values, mirrored from @carbon/themes g10 / g100 and the
# button-tokens. They are the fallback for every unset field, so a site that
# sets one colour still gets a coherent Carbon palette rather than a
# half-branded one.
CARBON_LIGHT = {
	"brand": "#0f62fe",  # Blue 60 -- interactive / button-primary
	"brand_hover": "#0050e6",
	"brand_active": "#002d9c",
	"link": "#0f62fe",
	"link_hover": "#0043ce",
	"on_brand": "#ffffff",
	"highlight": "#d0e2ff",
}
CARBON_DARK = {
	"brand": "#4589ff",  # Blue 50 -- Carbon lightens interactive on g100
	"brand_hover": "#5e94ff",
	"brand_active": "#95baff",
	"link": "#78a9ff",  # Blue 40
	"link_hover": "#a6c8ff",
	"on_brand": "#ffffff",
	"highlight": "#001d6c",
}
CARBON_SHELL = {
	"bg": "#161616",  # the UI Shell header is g100 in every Carbon theme
	"border": "#393939",
	"text": "#f4f4f4",
	"text_secondary": "#c6c6c6",
	"hover": "#353535",
	"active": "#393939",
}
# Carbon yellow-30 ($support-warning): the hazard colour, on the header, with
# near-black text. Unmistakable next to a production tab.
DEV_SHELL = {"bg": "#f1c21b", "text": "#161616"}

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


# -- colour helpers ----------------------------------------------------------


def parse_hex(value):
	"""``#abc`` / ``#aabbcc`` -> (r, g, b) floats, or None if not a hex colour.

	These arrive from a Color field and are normally well formed, but nothing
	stops a value being written another way. A malformed colour degrades to
	"leave it alone" rather than raising in the middle of a page render.
	"""
	if not isinstance(value, str):
		return None
	text = value.strip().lstrip("#")
	if len(text) == 3:
		text = "".join(c * 2 for c in text)
	if len(text) != 6:
		return None
	try:
		return tuple(int(text[i : i + 2], 16) / 255 for i in (0, 2, 4))
	except ValueError:
		return None


def normalize_hex(value):
	"""A parseable colour as lowercase ``#rrggbb``, else None."""
	rgb = parse_hex(value)
	if rgb is None:
		return None
	return "#{:02x}{:02x}{:02x}".format(*tuple(round(c * 255) for c in rgb))


def shift(value, amount):
	"""Shift a hex colour's lightness. Positive darkens, negative lightens."""
	rgb = parse_hex(value)
	if rgb is None:
		return value
	hue, lightness, saturation = rgb_to_hls(*rgb)
	lightness = min(1.0, max(0.0, lightness - amount))
	red, green, blue = hls_to_rgb(hue, lightness, saturation)
	return f"#{int(red * 255):02x}{int(green * 255):02x}{int(blue * 255):02x}"


def blend(colour, towards, amount):
	"""Mix `colour` `amount` of the way towards `towards`. Both hex, result hex."""
	a, b = parse_hex(colour), parse_hex(towards)
	if a is None or b is None:
		return colour
	mixed = [a[i] + (b[i] - a[i]) * amount for i in range(3)]
	return "#{:02x}{:02x}{:02x}".format(*tuple(round(c * 255) for c in mixed))


def luma(colour):
	"""Rec. 709 relative luminance, 0..1. Returns None for a bad colour."""
	rgb = parse_hex(colour)
	if rgb is None:
		return None
	return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def is_light(colour):
	return (luma(colour) or 0) > 0.5


def readable_on(background):
	"""Near-black or near-white, whichever reads better on `background`."""
	value = luma(background)
	if value is None:
		return CARBON_SHELL["text"]
	return "#161616" if value > 0.5 else "#f4f4f4"


# -- configuration -----------------------------------------------------------


def read_config(doc=None):
	"""Carbon Settings as a dict of normalised hex colours (None when unset)."""
	doc = doc or frappe.get_cached_doc("Carbon Settings")
	return {
		field: normalize_hex(doc.get(field))
		for field in ("brand_light", "brand_dark", "header_bg", "header_text")
	}


def is_dev():
	"""Whether this request should get the dev-environment coloration.

	Override order: site config `carbon_dev_indicator` (0/1), then a cookie of
	the same name (so the shell tests can switch it off against localhost),
	then the request hostname — localhost, loopback, or anything under
	`.localhost` (frappe-nix benches serve `<site>.localhost`).
	"""
	configured = frappe.conf.get(DEV_INDICATOR_KEY)
	if configured is not None:
		return bool(cint(configured))

	request = getattr(frappe.local, "request", None)
	if request is None:
		return False

	cookie = request.cookies.get(DEV_INDICATOR_KEY)
	if cookie is not None:
		return bool(cint(cookie))

	# request.host carries the port; urlsplit strips it (and brackets on IPv6)
	hostname = urlsplit("//" + (request.host or "")).hostname or ""
	return hostname in LOCAL_HOSTS or hostname.endswith(".localhost")


# -- palette derivation ------------------------------------------------------


def palette(config, dark=False):
	"""Resolve the brand fields into a full Carbon interactive palette."""
	base = CARBON_DARK if dark else CARBON_LIGHT
	brand_light = config.get("brand_light")

	if dark:
		# An explicit dark brand wins; otherwise lighten the light one, which is
		# what Carbon does between g10 and g100. Only if neither is set do we
		# fall back to Carbon's own dark interactive tone.
		brand = config.get("brand_dark") or (shift(brand_light, -0.12) if brand_light else base["brand"])
	else:
		brand = brand_light or base["brand"]

	is_carbon_default = brand == base["brand"]
	# Carbon's own hover/active steps are hand-tuned, so they are used verbatim
	# when the colour is unchanged; a custom brand gets the same relative
	# treatment. Dark themes brighten on hover instead of darkening.
	direction = -1 if dark else 1
	link_hover = base["link_hover"] if is_carbon_default else shift(brand, 0.10 * direction)

	return {
		"brand": brand,
		"brand_hover": base["brand_hover"] if is_carbon_default else shift(brand, 0.06 * direction),
		"brand_active": base["brand_active"] if is_carbon_default else shift(brand, 0.16 * direction),
		"on_brand": base["on_brand"] if is_carbon_default else readable_on(brand),
		"link": base["link"] if is_carbon_default else brand,
		"link_hover": link_hover,
		# $highlight: the selected-text / marked-row tint, a pale wash of the
		# brand in light and a deep one in dark.
		"highlight": (
			base["highlight"]
			if is_carbon_default
			else (blend(brand, "#161616", 0.7) if dark else blend(brand, "#ffffff", 0.8))
		),
	}


def header_palette(bg, text=None):
	"""Resolve a header background (and optional text) into shell tokens.

	Returns None for Carbon's own shell colour, so the g100 emission's
	hand-tuned values stand and nothing is written over them.
	"""
	bg = normalize_hex(bg)
	if not bg or bg == CARBON_SHELL["bg"]:
		return None

	light = is_light(bg)
	text = normalize_hex(text) or readable_on(bg)
	# Carbon's shell lightens on hover because it is near-black. A mid-tone or
	# light header has to go the other way, or "hover" would mean "wash out".
	away = 1 if light else -1
	hover = shift(bg, 0.06 * away)
	active = shift(bg, 0.10 * away)
	# The brand family of the header's own polarity, for the current-link bar
	# and any link inside the header's panels: blue-60 reads on a light bar,
	# blue-50 on a dark one, and a configured brand follows the same rule.
	return {
		"bg": bg,
		"text": text,
		# The de-emphasised label colour. Carbon uses gray-30 on its own shell;
		# on a branded header the equivalent is the text pulled a little way
		# back towards the header itself.
		"text_secondary": blend(text, bg, 0.25),
		"placeholder": blend(text, bg, 0.5),
		"border": shift(bg, 0.08 * away),
		"border_strong": blend(text, bg, 0.5),
		"hover": hover,
		"active": active,
		# Menus and panels sit on $layer; step them like Carbon's g100 shell does
		# (#161616 bar, #262626 menu, #333333 hover, #393939 selected).
		"layer": hover,
		"layer_hover": active,
		"layer_active": shift(bg, 0.14 * away),
		# Carbon's g100 shell uses white for focus; the mirror on a light bar is
		# the text colour, the one tone guaranteed to contrast with everything.
		"focus": text,
		"color_scheme": "light" if light else "dark",
		"light": light,
	}


# -- stylesheet --------------------------------------------------------------

# The bundles declare their tokens on `:root, [data-theme="light"]` and
# `[data-theme="dark"], .dark, .cf-zone-g100` (0,1,0). These are the same
# elements one notch more specific (0,1,1): the login page renders
# login.bundle.css AFTER web_include_css and re-emits the g10 tokens, so
# winning by source order alone is not guaranteed everywhere the link lands.
# `.dark` stays bare for frappe-ui SPAs that put the class below <html>.
LIGHT_SELECTOR = 'html:root,\nhtml[data-theme="light"]'
DARK_SELECTOR = 'html[data-theme="dark"],\nhtml.dark,\n.dark,\n.cf-zone-g100'
ROOT_SELECTOR = "html:root"
ZONE_SELECTOR = ".cf-zone-g100"
HEADER_ALIAS_SELECTOR = ".cf-zone-g100,\n.navbar"
# Carbon paints every header link on $background (a.cds--header__menu-item),
# which would sit as solid amber blocks on the striped bar. Idle links go
# transparent so the stripes run under them; hover, active and an open
# sub-menu title keep their own tones (declared by Carbon on :hover / :active /
# [aria-expanded]), so the states still read.
STRIPED_CELL_SELECTOR = ".cf-zone-g100 a.cds--header__menu-item:not(:hover):not(:active)"


def _block(selector, declarations):
	body = "\n".join(f"\t{prop}: {value};" for prop, value in declarations)
	return f"{selector} {{\n{body}\n}}\n"


def _brand_declarations(p, dark):
	decls = [
		("--cds-interactive", p["brand"]),
		("--cds-border-interactive", p["brand"]),
		("--cds-background-brand", p["brand"]),
		("--cds-link-primary", p["link"]),
		("--cds-link-primary-hover", p["link_hover"]),
		("--cds-highlight", p["highlight"]),
		# component tokens: not emitted by theme.theme(), read by Carbon's own
		# components and the theme's $button-* as var(--cds-button-*, fallback)
		("--cds-button-primary", p["brand"]),
		("--cds-button-primary-hover", p["brand_hover"]),
		("--cds-button-primary-active", p["brand_active"]),
		("--carbon-text-on-brand", p["on_brand"]),
		# frappe's own variables, as literals: a custom Website Theme's compiled
		# CSS ends with `:root { --primary: <literal> }` after the carbon bundle,
		# so a var() alone would lose on website pages.
		("--btn-primary", p["brand"]),
		("--primary", p["brand"]),
		("--primary-color", p["brand"]),
	]
	if not dark:
		# Carbon g100 keeps focus, interactive icons and the tertiary button
		# white; only g10 draws them in the interactive colour.
		decls += [
			("--cds-focus", p["brand"]),
			("--cds-icon-interactive", p["brand"]),
			("--cds-button-tertiary", p["brand"]),
		]
	return decls


def _header_declarations(h, brand):
	"""Tokens Carbon's UI Shell header/panel/switcher CSS and the theme's zone
	residue (desk/_ui-shell.scss §3) read, re-pointed on the zone element."""
	return [
		("--cds-background", h["bg"]),
		("--cds-background-hover", h["hover"]),
		("--cds-background-active", h["active"]),
		("--cds-background-selected", h["active"]),
		("--cds-layer-01", h["layer"]),
		("--cds-layer-hover-01", h["layer_hover"]),
		("--cds-layer-active-01", h["layer_active"]),
		("--cds-layer-selected-01", h["layer_hover"]),
		("--cds-layer-selected-hover-01", h["layer_active"]),
		("--cds-layer-accent-01", h["layer_hover"]),
		("--cds-field-01", h["layer"]),
		("--cds-field-02", h["layer"]),
		("--cds-border-subtle-00", h["border"]),
		("--cds-border-subtle-01", h["border"]),
		("--cds-border-strong-01", h["border_strong"]),
		("--cds-text-primary", h["text"]),
		("--cds-text-secondary", h["text_secondary"]),
		("--cds-text-placeholder", h["placeholder"]),
		("--cds-icon-primary", h["text"]),
		("--cds-icon-secondary", h["text_secondary"]),
		("--cds-focus", h["focus"]),
		("--cds-interactive", brand["brand"]),
		("--cds-border-interactive", brand["brand"]),
		("--cds-link-primary", brand["link"]),
		("--cds-link-primary-hover", brand["link_hover"]),
		("color-scheme", h["color_scheme"]),
	]


def _header_aliases(h):
	"""The --carbon-header-* aliases the website navbar, footer and the desk
	theme-switcher preview strip read (web/_navbar.scss, web/_index.scss,
	desk/_ui-shell.scss)."""
	return [
		("--carbon-header-bg", h["bg"]),
		("--carbon-header-hover", h["hover"]),
		("--carbon-header-active", h["active"]),
		("--carbon-header-border", h["border"]),
		("--carbon-header-text", h["text"]),
		("--carbon-header-text-secondary", h["text_secondary"]),
		("--carbon-header-layer", h["layer"]),
		("--carbon-header-focus", h["focus"]),
	]


def _stripes(alpha):
	return f"repeating-linear-gradient(135deg, transparent, transparent 10px, {alpha} 10px, {alpha} 20px)"


def render_css(config, dev=False):
	"""The stylesheet body for a config dict (see read_config) and dev flag.

	Blocks are emitted in a fixed order so that, on the one element that
	matches several of them (<html> in dark: :root and [data-theme=dark]; the
	header: [data-theme=dark]'s group and .cf-zone-g100), the later, more
	specific intent wins by source order.
	"""
	light = palette(config, dark=False)
	dark = palette(config, dark=True)
	out = ["/* carbon_frappe: brand colours as Carbon tokens. Generated; see brand.py. */\n"]

	if config.get("brand_light"):
		out.append(_block(LIGHT_SELECTOR, _brand_declarations(light, dark=False)))
	if config.get("brand_light") or config.get("brand_dark"):
		out.append(_block(DARK_SELECTOR, _brand_declarations(dark, dark=True)))

	header = header_palette(config.get("header_bg"), config.get("header_text"))
	if header:
		if not dev:
			out.append(
				_block(ZONE_SELECTOR, _header_declarations(header, light if header["light"] else dark))
			)
		# on :root so the website navbar, footer and the theme-switcher preview
		# strip all follow (they read the aliases through inheritance); in dev
		# the header and navbar are re-declared below and the footer keeps this
		out.append(_block(ROOT_SELECTOR, _header_aliases(header)))

	if dev:
		shell = header_palette(DEV_SHELL["bg"], DEV_SHELL["text"])
		out.append("/* dev environment */\n")
		out.append(_block(ZONE_SELECTOR, _header_declarations(shell, light)))
		# on the header and navbar only: the footer keeps the configured colour
		out.append(_block(HEADER_ALIAS_SELECTOR, _header_aliases(shell)))
		# hazard tape on the bar alone: stripes across the page never line up
		# between the header, sidebar and content column, and the bar is enough
		out.append(_block(HEADER_ALIAS_SELECTOR, [("background-image", _stripes("rgba(0, 0, 0, 0.08)"))]))
		out.append(_block(STRIPED_CELL_SELECTOR, [("background-color", "transparent")]))

	return "".join(out)


def is_customised(config):
	return any(config.values())


class BrandStylesheet(BaseRenderer):
	"""page_renderer for /carbon-brand.css.

	Instantiated (and can_render'd) for every website request, so the check is
	a string compare and nothing else. The body is cheap (one cached single,
	string formatting) and revalidated by ETag, so no server-side cache is kept
	— a settings save is live on the next page load.
	"""

	def can_render(self):
		return self.path == STYLESHEET_PATH

	def render(self):
		try:
			css = render_css(read_config(), is_dev())
		except Exception:
			# A raise here would serve an HTML error page as the stylesheet and
			# the theme would silently fall back to Carbon blue with no trace.
			frappe.log_error("carbon_frappe: could not build the brand stylesheet")
			css = "/* carbon_frappe: brand stylesheet unavailable; see Error Log. */\n"

		response = self.build_response(css, 200, {"Cache-Control": "private, no-cache"})
		response.set_etag(hashlib.sha1(css.encode()).hexdigest()[:16])
		return response.make_conditional(frappe.local.request)
