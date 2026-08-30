/**
 * Everything this theme depends on in frappe's MARKUP and RUNTIME, declared in
 * one place so scripts/audit-markup.mjs and the code cannot drift apart.
 *
 * These are the dependencies CSS alone cannot express. A rename upstream turns
 * an override into a silent no-op: the theme keeps loading and the component
 * just quietly reverts to stock frappe styling, which is exactly the failure
 * mode that is hardest to notice.
 */

/** Classes frappe must still emit for our stylesheet to reach anything. */
export const SELECTORS = [
	// Legacy classes the Carbon table engine RE-EMITS so that app code can keep
	// targeting our cells. If frappe stops emitting one, our re-emission is
	// merely redundant — but if frappe RENAMES one, third-party CSS and jQuery
	// written against it break, and we would want to follow the rename.
	["dt-row", "frappe/public/js/frappe/views/reports/report_view.js"],
	["dt-cell__content", "frappe/public/js/frappe/views/reports/report_view.js"],
	["dt-filter", "frappe/public/js/frappe/views/reports/report_view.js"],
	["grid-static-col", "frappe/public/js/frappe/form/grid_row.js"],
	["grid-row-check", "frappe/public/js/frappe/form/grid.js"],
	["static-area", "frappe/public/js/frappe/form/grid_row.js"],
	["field-area", "frappe/public/js/frappe/form/grid_row.js"],
	["sortable-handle", "frappe/public/js/frappe/form/grid_row.js"],
	["column-limit-reached", "frappe/public/js/frappe/form/grid_row.js"],
	["list-row-col", "frappe/public/js/frappe/list/list_view.js"],
	["list-header-subject", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],

	// list view / data table
	["list-row-head", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-container", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],
	["checkbox-actions", "frappe/public/js/frappe/list/list_view.js"],
	["text-right", "frappe/public/js/frappe/list/list_view.js"],
	// UI Shell header — the utilities js/anatomy/ui_shell.js MOVES into <header>.
	// A rename here does not break the header, it silently leaves search /
	// notifications / account behind in the side nav or the landing page navbar.
	["body-sidebar", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the two columns the fixed header is indented past (desk/_page-head.scss);
	// a rename here silently drops the header's reserved row on top of them
	["body-sidebar-container", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["main-section", "frappe/www/desk.html"],
	["standard-items-sections", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["dropdown-navbar-user", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the account cell's name/email label. The rail must hide it: left visible it
	// takes a grid row of its own and pushes the avatar off the vertical centre.
	["avatar-name-email", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the landing page's own navbar, which the shell harvests and then removes.
	// .desktop-wrapper is the template root, watched to catch the re-render.
	["desktop-wrapper", "frappe/desk/page/desktop/desktop.html"],
	["desktop-navbar", "frappe/desk/page/desktop/desktop.html"],
	["desktop-search-wrapper", "frappe/desk/page/desktop/desktop.html"],
	["desktop-notifications", "frappe/desk/page/desktop/desktop.html"],
	["desktop-avatar", "frappe/desk/page/desktop/desktop.html"],
	// side nav
	["item-anchor", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["section-break", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["standard-sidebar-item", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["nested-container", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	// page chrome
	["page-actions", "frappe/public/js/frappe/ui/page.html"],
	["page-head-content", "frappe/public/js/frappe/ui/page.html"],
	["title-area", "frappe/public/js/frappe/ui/page.html"],
	["page-indicator-pill", "frappe/public/js/frappe/ui/page.html"],
	["title-text", "frappe/public/js/frappe/ui/page.js"],
	// form
	["like-disabled-input", "frappe/public/js/frappe/form/controls/base_input.js"],
	["form-message", "frappe/public/js/frappe/form/layout.js"],
	// trailing field icons — the wrapper whose --control-bg plate we clear
	["link-btn", "frappe/public/js/frappe/form/controls/link.js"],
	// awesomebar search field: the row carries the Carbon field, the icon its
	// leading inset (desk/_modals.scss)
	["awesomebar-input-row", "frappe/public/js/frappe/ui/toolbar/awesome_bar.js"],
	["awesomebar-search-icon", "frappe/public/js/frappe/ui/toolbar/awesome_bar.js"],
	// widgets
	["percentage-stat-area", "frappe/public/js/frappe/widgets/number_card_widget.js"],
	["number-widget-box", "frappe/public/js/frappe/widgets/number_card_widget.js"],
];

/**
 * Runtime shapes the theme monkey-patches. [id, file, regex]
 * If the regex stops matching, the patch silently stops applying.
 */
export const PATCH_TARGETS = [
	// --- carbon_tables.bundle.js -------------------------------------------
	// The table engine REPLACES these implementations rather than wrapping
	// them, so a rename upstream is not a cosmetic regression here: the
	// surface silently reverts to stock frappe rendering (frappe-datatable,
	// the Bootstrap 12-column grid, or div list rows).
	[
		"ReportView.setup_datatable (CarbonDataTable replaces frappe-datatable)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/setup_datatable\s*\(/,
	],
	[
		"ControlTable.make (constructs the Grid we swap for CarbonGrid)",
		"frappe/public/js/frappe/form/controls/table.js",
		/this\.grid = new Grid\(/,
	],
	[
		"Grid is an ES module default export (imported directly by tables/grid)",
		"frappe/public/js/frappe/form/grid.js",
		/export default class Grid/,
	],
	[
		"GridRow is an ES module default export (subclassed by CarbonGridRow)",
		"frappe/public/js/frappe/form/grid_row.js",
		/export default class GridRow/,
	],
	[
		"GridRow.make_column builds the .grid-static-col cell we reuse verbatim",
		"frappe/public/js/frappe/form/grid_row.js",
		/make_column\(df, colsize, txt, ci\)/,
	],
	[
		"query_report constructs from window.DataTable (reassignment reaches it)",
		"frappe/public/js/frappe/views/reports/query_report.js",
		/new window\.DataTable\(/,
	],
	[
		"frappe.DataTable global (ui/datatable.js is the only assignment)",
		"frappe/public/js/frappe/ui/datatable.js",
		/frappe\.DataTable = DataTable/,
	],
	[
		"ListView.render_list (replaced by the Carbon table renderer)",
		"frappe/public/js/frappe/list/list_view.js",
		/render_list\(\)\s*\{/,
	],
	[
		"ListView.get_column_html (reused verbatim as the cell renderer)",
		"frappe/public/js/frappe/list/list_view.js",
		/get_column_html\(col, doc, show_in_mobile\)/,
	],
	[
		"ListView.get_meta_html (reused verbatim for the meta rail column)",
		"frappe/public/js/frappe/list/list_view.js",
		/get_meta_html\(doc\)/,
	],
	[
		"ListView.apply_column_widths (neutralised; TanStack owns widths)",
		"frappe/public/js/frappe/list/list_view.js",
		/apply_column_widths\(\)/,
	],
	[
		"on_row_checked resolves its handles lazily (we pre-assign $list_head_subject)",
		"frappe/public/js/frappe/list/list_view.js",
		/this\.\$list_head_subject =\s*\n?\s*this\.\$list_head_subject \|\|/,
	],
	[
		"toolbar.setup_editable_title_click_event (clickable page title)",
		"frappe/public/js/frappe/form/toolbar.js",
		/setup_editable_title_click_event\s*\(/,
	],
	[
		"editable-title class on .title-area (marks a renameable doc)",
		"frappe/public/js/frappe/form/toolbar.js",
		/"editable-title"/,
	],
	[
		"frappe.router event emitter (editable title, UI Shell re-mount)",
		"frappe/public/js/frappe/router.js",
		/make_event_emitter\(frappe\.router\)/,
	],
	[
		"empty <header> mount point (UI Shell header)",
		"frappe/www/desk.html",
		/<header>\s*<\/header>/,
	],
	[
		"toolbar only replaces <header> conditionally",
		"frappe/public/js/frappe/ui/toolbar/toolbar.js",
		/\$\("header"\)\.replaceWith/,
	],
	[
		"sidebar toggle the shell hamburger delegates to",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/sidebar-toggle-btn|collapse-sidebar-link/,
	],
];

/**
 * frappe-side declarations we deliberately override. Their continued existence
 * proves the MECHANISM still works, not just the value.
 */
export const MIRRORED_LITERALS = [
	["--page-head-height", "frappe/public/scss/desk/css_variables.scss"],
	["--list-row-height", "frappe/public/scss/desk/css_variables.scss"],
	["--list-checkbox-padding", "frappe/public/scss/desk/css_variables.scss"],
	["--sidebar-width", "frappe/public/scss/desk/sidebar.scss"],
	// frappe-datatable's own stylesheet, which report.bundle.css pulls in and
	// which desk/_carbon-table.scss must neutralise: it lays `dt-*` out as divs
	// (`.dt-row { display: flex }`, `.dt-scrollable { height: 40vw }`), and the
	// engine emits those same class names on a real <table>.
	[".dt-row", "frappe/public/scss/desk/frappe_datatable.scss"],
	["frappe-datatable/dist/frappe-datatable", "frappe/public/scss/report.bundle.scss"],
	// the px map behind `col-xs-N` in `.column-limit-reached` mode — the
	// overflow hack CarbonGrid replaces with real horizontal scroll, and the
	// source of the Bootstrap-span -> pixel translation in tables/grid/grid.js
	[".column-limit-reached", "frappe/public/scss/common/grid.scss"],
	// the awesomebar rule pinned to `top: 40px` — an offset measured against
	// frappe's 28px input, which crossed Carbon's 40px field. desk/_modals.scss
	// hides it; if frappe reworks it, that suppression wants revisiting.
	["modal-divider", "frappe/public/scss/desk/navbar.scss"],
];

/** assets.json keys this app shadows; all must point at carbon_frappe. */
export const SHADOWED_BUNDLES = ["desk", "website", "login", "email"];
