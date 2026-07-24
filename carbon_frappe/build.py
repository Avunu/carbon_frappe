# Copyright (c) 2026, Avunu LLC and contributors
# For license information, please see license.txt

import json
import os
from glob import glob

import frappe
from frappe.utils.redis_wrapper import ClientCache

# Frappe bundle names this theme shadows. Each has a same-named
# public/scss/<name>.bundle.scss in this app; assets.json keys are bare
# basenames, so whichever app's entry is written last owns the key.
SHADOWED_BUNDLES = ("desk", "website", "login", "email", "print")


def patch_assets(app_name=None):
    """Point frappe's stylesheet keys in assets.json at carbon_frappe's shadow bundles.

    esbuild's assets.json merge is ordering-dependent; this makes the shadow
    deterministic and heals reversions caused by partial builds that excluded
    this app (e.g. `bench build --apps frappe`).
    """
    assets_dir = os.path.abspath(os.path.join(frappe.local.sites_path, "assets"))
    patched = False

    for json_name, css_dir, key_prefix in (
        ("assets.json", "css", ""),
        ("assets-rtl.json", "css-rtl", "rtl_"),
    ):
        json_path = os.path.join(assets_dir, json_name)
        dist_dir = os.path.join(assets_dir, "carbon_frappe", "dist", css_dir)
        if not (os.path.exists(json_path) and os.path.isdir(dist_dir)):
            continue

        with open(json_path) as f:
            assets = json.load(f)

        changed = False
        for name in SHADOWED_BUNDLES:
            candidates = sorted(
                glob(os.path.join(dist_dir, f"{name}.bundle.*.css")),
                key=os.path.getmtime,
            )
            if not candidates:
                continue
            target = "/" + os.path.relpath(candidates[-1], os.path.dirname(assets_dir))
            key = f"{key_prefix}{name}.bundle.css"
            if assets.get(key) != target:
                assets[key] = target
                changed = True

        if changed:
            with open(json_path, "w") as f:
                json.dump(assets, f, indent=4)
            patched = True

    if patched:
        assert isinstance(
            frappe.client_cache, ClientCache
        ), "frappe cache is not available"
        frappe.client_cache.delete_value("assets_json")
