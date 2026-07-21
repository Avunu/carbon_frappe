// carbon_frappe chart shim — injects @carbon/charts categorical palettes into
// frappe.Chart (frappe-charts) whenever a caller doesn't pass explicit
// colors. Loaded via app_include_js after frappe's desk bundles.
import { light, dark, heatmap } from "./generated/chart-palettes";

function carbonPalette() {
	const theme = document.documentElement.getAttribute("data-theme");
	return theme === "dark" ? dark : light;
}

function patch() {
	const Base = window.frappe && frappe.Chart;
	if (!Base || Base.__carbon_frappe) return false;

	frappe.Chart = class CarbonChart extends Base {
		constructor(el, options = {}) {
			const opts = { ...options };
			const colors = (opts.colors || []).filter(Boolean);
			// frappe.utils.make_chart hardcodes ["light-blue"]; treat it as unset
			const isDefault = !colors.length || (colors.length === 1 && colors[0] === "light-blue");
			if (isDefault) {
				opts.colors = opts.type === "heatmap" ? heatmap.slice() : carbonPalette().slice();
			}
			super(el, opts);
		}
	};
	frappe.Chart.__carbon_frappe = true;
	return true;
}

// frappe.Chart is assigned when the desk bundle loads (before app bundles),
// but guard with a retry in case of deferred loading.
if (!patch()) {
	document.addEventListener("DOMContentLoaded", patch);
}
