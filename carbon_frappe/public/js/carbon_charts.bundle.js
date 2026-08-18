// carbon_frappe chart shim — puts every frappe.Chart series on an
// @carbon/charts categorical palette, and re-themes them when the desk theme
// changes. Loaded via app_include_js after frappe's desk bundles.
import { light, dark, heatmap } from "./generated/chart-palettes";

function carbonPalette() {
	const theme = document.documentElement.getAttribute("data-theme");
	return theme === "dark" ? dark : light;
}

// frappe-charts' named colors (its utils/colors.js PRESET_COLOR_MAP). A caller
// may pass one of these instead of a hex, so resolve before measuring.
const PRESET = {
	pink: "#F683AE",
	blue: "#318AD8",
	green: "#48BB74",
	grey: "#A6B1B9",
	red: "#F56B6B",
	yellow: "#FACF7A",
	purple: "#44427B",
	teal: "#5FD8C4",
	cyan: "#15CCEF",
	orange: "#F8814F",
	"light-pink": "#FED7E5",
	"light-blue": "#BFDDF7",
	"light-green": "#48BB74",
	"light-grey": "#F4F5F6",
	"light-red": "#F6DFDF",
	"light-yellow": "#FEE9BF",
	"light-purple": "#E8E8F7",
	"light-teal": "#D3FDF6",
	"light-cyan": "#DDF8FD",
	"light-orange": "#FECDB8",
};

/** [r, g, b] for a hex / rgb() / frappe-charts preset name, or null. */
function toRgb(color) {
	if (typeof color !== "string") return null;
	const c = PRESET[color.trim()] || color.trim();

	const rgb = c.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
	if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];

	const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!hex) return null;
	const h = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// "redmean" weighted RGB distance — a cheap approximation of perceptual
// distance, and markedly better than plain Euclidean at not reading a dark red
// as the neighbour of a dark blue. Squared: these values are only ever compared.
function distance(a, b) {
	const rbar = (a[0] + b[0]) / 2;
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return (2 + rbar / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rbar) / 256) * db * db;
}

/**
 * Snap author-chosen colors onto the Carbon ramp.
 *
 * A Dashboard Chart carries its own `color` field and frappe passes it straight
 * through to frappe.Chart. Honouring those verbatim was the old behaviour, and
 * it left ERPNext's stock charts (#a83333, #7b933d) sitting visibly off-palette
 * beside the ones we colored. Snapping keeps the author's INTENT — a red stays
 * the reddest thing on the ramp — while what actually renders stays Carbon.
 *
 * Greedy, and never reuses an entry: two source colors that both land nearest
 * the same Carbon color would otherwise draw as one indistinguishable series.
 */
function snap(source, palette) {
	const swatches = palette.map(toRgb);
	const taken = new Set();

	return source.map((color) => {
		const rgb = toRgb(color);
		if (!rgb) return color; // unparseable — leave the caller's value alone

		let best = -1;
		let bestDistance = Infinity;
		swatches.forEach((swatch, i) => {
			if (taken.has(i) || !swatch) return;
			const d = distance(rgb, swatch);
			if (d < bestDistance) {
				bestDistance = d;
				best = i;
			}
		});

		if (best < 0) return color; // more series than the palette can separate
		taken.add(best);
		return palette[best];
	});
}

function colorsFor(source, type) {
	if (type === "heatmap") return heatmap.slice(); // sequential ramp, not categorical
	const palette = carbonPalette();
	return source ? snap(source, palette) : palette.slice();
}

// chart -> the colors the CALLER asked for, or null when they asked for none.
// Holding the ORIGINAL request means a theme flip re-derives from the author's
// intent rather than drifting off whatever we mapped it to last time.
const themed = new Map();

function retheme() {
	for (const [chart, source] of themed) {
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
			chart.colors = chart.validateColors(colorsFor(source, chart.type), chart.type);
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
			const source = isDefault ? null : colors;
			opts.colors = colorsFor(source, opts.type);
			super(el, opts);
			themed.set(this, source);
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
