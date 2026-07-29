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
	// list view / data table
	["list-row-head", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-container", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],
	["checkbox-actions", "frappe/public/js/frappe/list/list_view.js"],
	["text-right", "frappe/public/js/frappe/list/list_view.js"],
	// side nav
	["item-anchor", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["section-break", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["standard-sidebar-item", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["nested-container", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	// page chrome
	["standard-actions", "frappe/public/js/frappe/ui/page.html"],
	["page-head-content", "frappe/public/js/frappe/ui/page.html"],
	["title-text", "frappe/public/js/frappe/ui/page.js"],
	// form
	["like-disabled-input", "frappe/public/js/frappe/form/controls/base_input.js"],
	["form-message", "frappe/public/js/frappe/form/layout.js"],
	// widgets
	["percentage-stat-area", "frappe/public/js/frappe/widgets/number_card_widget.js"],
	["number-widget-box", "frappe/public/js/frappe/widgets/number_card_widget.js"],
];

/**
 * Runtime shapes the theme monkey-patches. [id, file, regex]
 * If the regex stops matching, the patch silently stops applying.
 */
export const PATCH_TARGETS = [
	[
		"ReportView.setup_datatable (48px report rows)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/setup_datatable\s*\(/,
	],
	[
		"frappe.router event emitter (Carbon page header)",
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
	// the static 35px rule that setCellHeight() cannot beat — see
	// js/anatomy/datatable.js
	[".dt-row", "frappe/public/scss/desk/frappe_datatable.scss"],
];

/** assets.json keys this app shadows; all must point at carbon_frappe. */
export const SHADOWED_BUNDLES = ["desk", "website", "login", "email"];
