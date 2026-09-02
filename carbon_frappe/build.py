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
SHADOWED_BUNDLES = ("desk", "website", "login", "email")

# This app's own JS bundles. They need healing for a different reason than the
# CSS above: frappe writes assets.json from two functions that disagree about
# the key as soon as a bundle entry is a `.ts` file.
#
#   * every build (including `bench watch`) ends in `write_assets_json`, which
#     keys by the ENTRY basename — `path.basename(info.entryPoint)`,
#     frappe/esbuild/esbuild.js:450. For us that is `carbon_desk.bundle.ts`.
#   * `bench build --using-cached` ends in `update_assets_obj`, which keys by
#     the OUTPUT basename minus the hash (esbuild.js:181-185). esbuild emits
#     `.js` whatever the entry was, so that is `carbon_desk.bundle.js`.
#
# hooks.py's `app_include_js` can only name one, and `include_script` is a bare
# dict lookup with no extension fallback (frappe/utils/jinja_globals.py:151-156).
# It names `.js`. Without this, the `.js` key keeps whatever stale hash an older
# build left behind and the desk quietly serves last month's theme — with no
# error anywhere. scripts/patch-assets.ts does the same repair, but only runs
# under `bench build` (esbuild.js:88 gates it off in watch mode), so this hook
# is what covers migrate/install.
JS_BUNDLES = ("carbon_charts", "carbon_desk", "carbon_anatomy", "carbon_tables")


def patch_assets(app_name=None):
    """Point frappe's stylesheet keys in assets.json at carbon_frappe's shadow bundles.

    esbuild's assets.json merge is ordering-dependent; this makes the shadow
    deterministic and heals reversions caused by partial builds that excluded
    this app (e.g. `bench build --apps frappe`). Also re-points this app's own
    `*.bundle.js` keys, which a `.ts` entry point leaves stale — see JS_BUNDLES.
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

    # No rtl variant: that prefix is a CSS-only convention (esbuild.js:451-453).
    json_path = os.path.join(assets_dir, "assets.json")
    dist_dir = os.path.join(assets_dir, "carbon_frappe", "dist", "js")
    if os.path.exists(json_path) and os.path.isdir(dist_dir):
        with open(json_path) as f:
            assets = json.load(f)

        changed = False
        for name in JS_BUNDLES:
            # `.js` also excludes the sourcemaps sitting next to them.
            candidates = sorted(
                glob(os.path.join(dist_dir, f"{name}.bundle.*.js")),
                key=os.path.getmtime,
            )
            if not candidates:
                continue
            target = "/" + os.path.relpath(candidates[-1], os.path.dirname(assets_dir))
            key = f"{name}.bundle.js"
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
