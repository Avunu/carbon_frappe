// carbon_frappe chart shim — puts every frappe.Chart series on an
// @carbon/charts categorical palette, and re-themes them when the desk theme
// changes. Loaded via app_include_js after frappe's desk bundles.
import { light, dark, heatmap } from "./generated/chart-palettes";
import type {
	FrappeBaseChart,
	FrappeChartColor,
	FrappeChartOptions,
	FrappeChartPresetColor,
} from "frappe-types";

function carbonPalette(): string[] {
	const theme = document.documentElement.getAttribute("data-theme");
	return theme === "dark" ? dark : light;
}

// frappe-charts' named colors (its utils/colors.js PRESET_COLOR_MAP). A caller
// may pass one of these instead of a hex, so resolve before measuring.
//
// One table, two annotations, because the two jobs want opposite key types.
// `PRESET_BY_NAME` is keyed by frappe-types' `FrappeChartPresetColor`, which is
// that upstream map's key set — so a preset renamed, dropped or invented here
// is a compile error rather than a name that silently stops resolving at
// runtime. `PRESET` re-types the same object for the actual lookup, whose key
// is arbitrary caller text and not a known preset name at all.
//
// (A `satisfies` clause would collapse the two, but frappe vendors esbuild
// 0.14, which predates that syntax and is what actually builds these bundles.)
const PRESET_BY_NAME: Record<FrappeChartPresetColor, string> = {
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
const PRESET: Record<string, string> = PRESET_BY_NAME;

/**
 * A measured color channel triple. A fixed-length tuple rather than `number[]`
 * so {@link distance} can read `[0]`/`[1]`/`[2]` as definite numbers — an array
 * would make each one `number | undefined` under `noUncheckedIndexedAccess`.
 */
type Rgb = [number, number, number];

/**
 * [r, g, b] for a hex / rgb() / frappe-charts preset name, or null.
 *
 * Takes `unknown` rather than `string`: the `typeof` guard below is a real
 * runtime check — the values reaching here are a caller's `options.colors`,
 * which frappe-charts itself only validates by regex — and narrowing the
 * parameter would turn that check into dead code the compiler complains about.
 */
function toRgb(color: unknown): Rgb | null {
	if (typeof color !== "string") return null;
	const c = PRESET[color.trim()] || color.trim();

	const rgb = c.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
	if (rgb) {
		// All three groups are mandatory in the pattern, so a match always fills
		// them; the check is what `noUncheckedIndexedAccess` asks for, and its
		// false branch falls through to the hex attempt, which cannot match an
		// `rgb(…)` string either — so it returns null exactly as before.
		const [, r, g, b] = rgb;
		if (r !== undefined && g !== undefined && b !== undefined) return [+r, +g, +b];
	}

	const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!hex) return null;
	const digits = hex[1];
	if (digits === undefined) return null; // likewise unreachable: group 1 is mandatory
	const h = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// "redmean" weighted RGB distance — a cheap approximation of perceptual
// distance, and markedly better than plain Euclidean at not reading a dark red
// as the neighbour of a dark blue. Squared: these values are only ever compared.
function distance(a: Rgb, b: Rgb): number {
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
function snap(source: FrappeChartColor[], palette: string[]): FrappeChartColor[] {
	const swatches = palette.map(toRgb);
	const taken = new Set<number>();

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
		// `swatches` is `palette.map(…)`, so any index the loop settles on is in
		// range for `palette` too — the fallback is what
		// `noUncheckedIndexedAccess` requires, not a reachable case.
		const picked = palette[best];
		return picked === undefined ? color : picked;
	});
}

/** The colors a caller asked for, or `null` when they asked for none. */
type ColorSource = FrappeChartColor[] | null;

function colorsFor(source: ColorSource, type: string | undefined): FrappeChartColor[] {
	if (type === "heatmap") return heatmap.slice(); // sequential ramp, not categorical
	const palette = carbonPalette();
	return source ? snap(source, palette) : palette.slice();
}

// chart -> the colors the CALLER asked for, or null when they asked for none.
// Holding the ORIGINAL request means a theme flip re-derives from the author's
// intent rather than drifting off whatever we mapped it to last time.
//
// Keyed by `FrappeBaseChart`, not by the `CarbonChart` subclass below, and that
// is not a widening for convenience: frappe-charts' `Chart` constructor RETURNS
// a different object (an AxisChart / PieChart / Heatmap / …), so `this` inside
// the subclass constructor already IS one of those. See FrappeChartConstructor
// in frappe-types for the full account.
const themed = new Map<FrappeBaseChart, ColorSource>();

function retheme(): void {
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

function patch(): boolean {
	// `window.frappe` is the guardable spelling (a bare missing identifier
	// throws), and pinning the result in a `const` is also what lets it stand as
	// the `extends` clause below: a construct signature, no longer `| undefined`.
	const Base = window.frappe && frappe.Chart;
	if (!Base || Base.__carbon_frappe) return false;

	frappe.Chart = class CarbonChart extends Base {
		constructor(el: string | HTMLElement, options: FrappeChartOptions = {}) {
			const opts: FrappeChartOptions = { ...options };
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
