// carbon_frappe desk shim — tags formatted data values with `carbon-num` so the
// stylesheet can set IBM Plex Mono on them.
//
// Why JS at all: most numerics are reachable from CSS (list rows carry
// .text-right, grid cells carry [data-fieldtype]), but frappe-datatable — the
// report view, query reports, data import preview — emits only positional
// classes (.dt-cell--col-N) with no fieldtype or alignment hook. Alignment there
// comes from a stylesheet frappe injects at runtime, which CSS cannot read. The
// one thing every numeric render path DOES share is frappe.form.formatters, so
// tagging at the formatter reaches all of them at once.
//
// Both patches delegate to the original, so upstream behaviour changes carry
// through and re-applying is a no-op.
//
// The bundle entry is `.ts`, and that MOVES the assets.json key — the output
// name is unchanged, the key is not. frappe's esbuild globs
// `*.bundle.{js,ts,…}` (esbuild/esbuild.js:258) and emits
// `dist/js/carbon_desk.bundle.<hash>.js` whatever the entry extension was, but
// it keys assets.json by the ENTRY basename —
// `path.basename(info.entryPoint)` (esbuild.js:450) — so a normal
// `bench build` files this under `carbon_desk.bundle.ts`. Only the
// `--using-cached` path keys off the OUTPUT name (`update_assets_obj`,
// esbuild.js:181-185) and still writes `carbon_desk.bundle.js`.
//
// hooks.py keeps asking for `.js`, the one name BOTH paths can be made to
// answer, and scripts/patch-assets.ts re-points that key at the freshly built
// file after a normal build. Verified by building: `include_script` does a bare
// dict lookup with no extension fallback (frappe/utils/jinja_globals.py:151-156),
// so without that step the `.js` key silently keeps whatever stale hash an
// older build left in assets.json.

import type { FrappeFormatters } from "frappe-types";

function patchFormatters(): boolean {
	const f = window.frappe && frappe.form && frappe.form.formatters;
	if (!f || f.__carbon_frappe) return false;

	// _right() wraps every Currency / Float / Int / Percent / Duration value in
	// <div style='text-align: right'>. Give that wrapper a class so the CSS hook
	// is a class rather than an inline-style substring match.
	const _right = f._right;
	if (typeof _right === "function") {
		// `this: FrappeFormatters` is spelled out because a bare `function`
		// expression has no `this` to infer under `noImplicitThis`, and the
		// delegation below passes it straight back to the original. frappe calls
		// every formatter as `frappe.form.formatters[type](…)`, so that IS the
		// receiver at runtime.
		f._right = function (this: FrappeFormatters, value, options) {
			const out = _right.call(this, value, options);
			return typeof out === "string" && out.startsWith("<div ")
				? out.replace("<div ", '<div class="carbon-num" ')
				: out;
		};
	}

	// Dates are the gap CSS can't cover: formatters.Date returns a bare string,
	// so datatable date cells have no hook at all. Wrap them.
	//
	// `as const` (erased at build) is what keeps `type` a union of the three
	// literal keys instead of widening to `string`: on `string` the lookup falls
	// through to FrappeFormatters' open index signature and both `orig` and the
	// wrapper's arguments go untyped. frappe-types gives Date/Datetime/Time one
	// SHARED signature for exactly this loop, so the union collapses to a single
	// function type rather than an unusable three-way one.
	for (const type of ["Date", "Datetime", "Time"] as const) {
		const orig = f[type];
		if (typeof orig !== "function") continue;
		f[type] = function (this: FrappeFormatters, ...args: Parameters<typeof orig>) {
			const out = orig.apply(this, args);
			return typeof out === "string" && out
				? `<span class="carbon-num">${out}</span>`
				: out;
		};
	}

	f.__carbon_frappe = true;
	return true;
}

if (!patchFormatters()) {
	document.addEventListener("DOMContentLoaded", patchFormatters);
}
