// Carbon class vocabulary, and the seam for legacy class emission.
//
// DUAL EMISSION is the compatibility contract of this whole effort. Every
// element the engine renders carries its Carbon class AND the legacy class the
// frappe ecosystem already targets, so that:
//
//   - `datatable.style.setStyle(".dt-cell--0-3", {...})` keeps working (13 call
//     sites across frappe / erpnext / avunu),
//   - third-party report and doctype stylesheets keep matching,
//   - frappe's own jQuery reaches into rows it did not render
//     (`report_view.js` queries `.dt-row[data-row-index]` and `.dt-filter`;
//     `controls/table.js` queries `.grid-row[data-name]` and `.form-in-grid`).
//
// The engine itself knows only the Carbon half. Each adapter supplies a
// "legacy profile" — a bag of hooks that decorate the nodes the engine builds —
// so all of an adapter's legacy naming lives in one readable file next to that
// adapter, and the engine never accumulates per-surface special cases.

export const CARBON = {
	container: "cds--data-table-container",
	content: "cds--data-table-content",
	table: "cds--data-table",
	toolbar: "cds--table-toolbar",
	toolbarContent: "cds--toolbar-content",
	batchActions: "cds--batch-actions",
	batchActionsActive: "cds--batch-actions--active",
	batchSummary: "cds--batch-summary",
	sortHeader: "cds--table-sort",
	sortActive: "cds--table-sort--active",
	sortDescending: "cds--table-sort--descending",
	sortFlex: "cds--table-sort__flex",
	sortIcon: "cds--table-sort__icon",
	sortIconUnsorted: "cds--table-sort__icon-unsorted",
	sortHeaderCell: "cds--table-sort__header",
	headerLabel: "cds--table-header-label",
	sortableTable: "cds--data-table--sort",
	// `cds--data-table--sticky-header` is deliberately NOT used — see the note
	// in table.js#render. Sticky is done with position:sticky on the <th>s.
	expandableRow: "cds--expandable-row",
	parentRow: "cds--parent-row",
	childRow: "cds--child-row",
	expandRow: "cds--table-expand__button",
	selectedRow: "cds--data-table--selected",
	pagination: "cds--pagination",
	skeleton: "cds--skeleton",
};

/** Carbon's five data-table row sizes. The header row always matches the body. */
export const ROW_SIZES = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64 };

/** Carbon modifier class for a row size, e.g. lg -> cds--data-table--lg. */
export function sizeClass(size) {
	return `${CARBON.table}--${size}`;
}

/**
 * Nearest Carbon row size for an arbitrary pixel height. Frappe hands us 33px
 * (query report), 35px (report view) and 40px (datatable default); Carbon has
 * no 33/35, so we snap rather than emit an off-ramp height that would break the
 * "header row matches body row" rule.
 */
export function nearestRowSize(px) {
	let best = "lg";
	let delta = Infinity;
	for (const name in ROW_SIZES) {
		const d = Math.abs(ROW_SIZES[name] - px);
		if (d < delta) {
			delta = d;
			best = name;
		}
	}
	return best;
}

/**
 * The hook surface an adapter implements to add its legacy classes/attributes.
 * Every hook is optional and receives (node, context). Contexts carry whatever
 * the engine knows at that point — see render.js for the exact shapes.
 */
export const NOOP_PROFILE = {
	root: null,
	scroll: null,
	head: null,
	body: null,
	foot: null,
	headerRow: null,
	headerCell: null,
	filterRow: null,
	filterCell: null,
	row: null,
	cell: null,
	totalRow: null,
	totalCell: null,
	empty: null,
};

/** Merge an adapter profile over the no-op defaults. */
export function makeProfile(profile) {
	return Object.assign({}, NOOP_PROFILE, profile || {});
}

/** Invoke a profile hook if the adapter defined one. Never throws upward. */
export function applyProfile(profile, hook, node, ctx) {
	const fn = profile && profile[hook];
	if (typeof fn !== "function") return;
	try {
		fn(node, ctx);
	} catch (e) {
		// A legacy-class hook must never take the table down with it; the
		// component degrades to Carbon-only classes and says so.
		console.error(`carbon_frappe: table class profile hook "${hook}" failed`, e);
	}
}
