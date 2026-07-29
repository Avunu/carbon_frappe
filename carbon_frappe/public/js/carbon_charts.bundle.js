// carbon_frappe chart shim — injects @carbon/charts categorical palettes into
// frappe.Chart (frappe-charts) whenever a caller doesn't pass explicit
// colors, and re-themes those charts when the desk theme changes.
// Loaded via app_include_js after frappe's desk bundles.
import { light, dark, heatmap } from "./generated/chart-palettes";

function carbonPalette() {
	const theme = document.documentElement.getAttribute("data-theme");
	return theme === "dark" ? dark : light;
}

// Charts whose colors WE supplied. frappe-charts bakes each series color into a
// per-element style="fill:…" at draw time, so a theme change leaves live SVGs on
// the previous palette until they are redrawn. Tracking only our own charts
// means a caller that passed explicit colors is never stomped.
const themed = new Set();

function retheme() {
	const palette = carbonPalette();
	for (const chart of themed) {
		// frappe destroys chart wrappers on route change and frappe-charts has no
		// destroy hook, so detached charts are pruned lazily here.
		if (!chart.parent || !chart.parent.isConnected) {
			themed.delete(chart);
			continue;
		}
		if (chart.type === "heatmap") continue; // sequential ramp, theme-independent
		try {
			// route through the same validator the constructor uses, so the
			// per-type DEFAULT_COLORS tail is still appended for charts with more
			// datasets than our 14-color palette
			chart.colors = chart.validateColors(palette, chart.type);
			if (chart.tip) chart.tip.colors = chart.colors;
			// no args => onlyWidthChange=false, init=false: a full redraw that does
			// not re-arm frappe-charts' 700ms init timer
			chart.draw();
		} catch (e) {
			// one dead chart must not stop the rest
			themed.delete(chart);
		}
	}
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
			if (isDefault) themed.add(this);
		}
	};
	frappe.Chart.__carbon_frappe = true;

	// frappe.ui.set_theme (ui/theme_switcher.js) only sets the data-theme
	// attribute — no event, no realtime publish — so observing the attribute is
	// the only available hook.
	new MutationObserver(retheme).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});

	return true;
}

// frappe.Chart is assigned when the desk bundle loads (before app bundles),
// but guard with a retry in case of deferred loading.
if (!patch()) {
	document.addEventListener("DOMContentLoaded", patch);
}
