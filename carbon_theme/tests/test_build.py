# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

"""Guards the assets.json repair (build.py, the after_migrate and after_app_install hook)."""

import json
import os
import tempfile
import time
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from carbon_theme.build import JS_BUNDLES, SHADOWED_BUNDLES, patch_assets


class TestPatchAssets(IntegrationTestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.addCleanup(self.tmp.cleanup)
		self.sites = self.tmp.name
		self.assets = os.path.join(self.sites, "assets")
		os.makedirs(self.assets)
		patcher = patch.object(frappe.local, "sites_path", self.sites)
		patcher.start()
		self.addCleanup(patcher.stop)
		cache = patch.object(frappe.client_cache, "delete_value")
		self.delete_value = cache.start()
		self.addCleanup(cache.stop)

	def write_json(self, name, data):
		with open(os.path.join(self.assets, name), "w") as f:
			json.dump(data, f)

	def read_json(self, name):
		with open(os.path.join(self.assets, name)) as f:
			return json.load(f)

	def dist(self, kind, filename, age=0.0):
		"""A built file under assets/carbon_theme/dist/<kind>/, `age` seconds old."""
		directory = os.path.join(self.assets, "carbon_theme", "dist", kind)
		os.makedirs(directory, exist_ok=True)
		path = os.path.join(directory, filename)
		with open(path, "w") as f:
			f.write("/* built */")
		stamp = time.time() - age
		os.utime(path, (stamp, stamp))
		return "/assets/carbon_theme/dist/" + kind + "/" + filename

	def test_shadows_frappes_stylesheets_with_the_newest_build(self):
		self.write_json(
			"assets.json",
			{"desk.bundle.css": "/assets/frappe/dist/css/desk.bundle.AAA.css", "other.css": "/x.css"},
		)
		self.dist("css", "desk.bundle.OLD.css", age=60)
		newest = self.dist("css", "desk.bundle.NEW.css")
		patch_assets()
		assets = self.read_json("assets.json")
		self.assertEqual(assets["desk.bundle.css"], newest)
		self.assertEqual(assets["other.css"], "/x.css")
		self.delete_value.assert_called_once_with("assets_json")

	def test_rtl_keys_take_the_prefix(self):
		self.write_json("assets-rtl.json", {})
		target = self.dist("css-rtl", "login.bundle.R1.css")
		patch_assets()
		self.assertEqual(self.read_json("assets-rtl.json"), {"rtl_login.bundle.css": target})

	def test_heals_the_js_keys_a_ts_entry_leaves_stale(self):
		self.write_json("assets.json", {"carbon_desk.bundle.js": "/assets/carbon_theme/dist/js/stale.js"})
		target = self.dist("js", "carbon_desk.bundle.J1.js")
		self.dist("js", "carbon_desk.bundle.J1.js.map")
		patch_assets()
		self.assertEqual(self.read_json("assets.json")["carbon_desk.bundle.js"], target)

	def test_every_shadowed_and_own_bundle_is_handled(self):
		self.write_json("assets.json", {})
		expected = {f"{n}.bundle.css": self.dist("css", f"{n}.bundle.C.css") for n in SHADOWED_BUNDLES}
		expected |= {f"{n}.bundle.js": self.dist("js", f"{n}.bundle.J.js") for n in JS_BUNDLES}
		patch_assets()
		self.assertEqual(self.read_json("assets.json"), expected)

	def test_up_to_date_assets_are_not_rewritten(self):
		target = self.dist("css", "email.bundle.E.css")
		self.write_json("assets.json", {"email.bundle.css": target})
		before = os.path.getmtime(os.path.join(self.assets, "assets.json"))
		patch_assets()
		self.assertEqual(os.path.getmtime(os.path.join(self.assets, "assets.json")), before)
		self.delete_value.assert_not_called()

	def test_an_unbuilt_bench_is_left_alone(self):
		"""No assets.json, or no dist folder for this app: nothing to do, and no error."""
		patch_assets()
		self.write_json("assets.json", {"desk.bundle.css": "/a.css"})
		patch_assets()
		self.assertEqual(self.read_json("assets.json"), {"desk.bundle.css": "/a.css"})
		self.delete_value.assert_not_called()

	def test_accepts_the_app_name_after_app_install_passes(self):
		self.write_json("assets.json", {})
		target = self.dist("css", "website.bundle.W.css")
		patch_assets("some_app")
		self.assertEqual(self.read_json("assets.json"), {"website.bundle.css": target})
