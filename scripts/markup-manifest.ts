/**
 * Everything this theme depends on in frappe's MARKUP and RUNTIME, declared in
 * one place so scripts/audit-markup.ts and the code cannot drift apart.
 *
 * These are the dependencies CSS alone cannot express. A rename upstream turns
 * an override into a silent no-op: the theme keeps loading and the component
 * just quietly reverts to stock frappe styling, which is exactly the failure
 * mode that is hardest to notice.
 *
 * Written against frappe v16.50.0. When a row's frappe-side shape changes the
 * row is re-pointed or removed in the same commit as the theme code that read
 * it; a row nothing reads any more is deleted, not left to pass, because a
 * guard that outlives its reader teaches people to ignore the audit.
 */

// ---------------------------------------------------------------------------
// Row shapes. Every list below is a table of heterogeneous fixed-length rows,
// not a list of values, and inference does not keep that straight: a
// `[string, string, RegExp]` row widens to `(string | RegExp)[]`, so a consumer
// that destructures `[id, file, re]` gets the union for all three and cannot
// call `re.test()` without re-narrowing what the row already states. Naming the
// shapes here keeps the contract in the manifest, where the rows are written.
// ---------------------------------------------------------------------------

/**
 * A class frappe must still emit, and the source file that emits it today.
 *
 * Matched as a whole class token (not preceded or followed by a word character
 * or a hyphen), so `navbar-modal-search` is NOT satisfied by a file that only
 * carries `navbar-modal-search-mobile`: a rename that extends the name is the
 * commonest rename there is, and a plain substring test passes straight over it.
 */
export type SelectorEntry = readonly [cls: string, file: string];

/**
 * A runtime shape the theme monkey-patches: the id used in the failure
 * message, the frappe file it lives in, and the regex that proves it is still
 * there.
 *
 * Also the vehicle for any other shape a plain class name cannot say — the
 * nesting of a rendered tree, a key the server writes into the boot payload, a
 * rule frappe's own stylesheet declares — so the file need not be JavaScript.
 */
export type PatchTarget = readonly [id: string, file: string, pattern: RegExp];

/**
 * A frappe-side declaration we override, and the file that declares it. A literal
 * that is only a class or a custom property is matched as a whole token (as for
 * SELECTORS); one with punctuation in it, like `z-index: 1020`, as a substring.
 */
export type MirroredLiteral = readonly [literal: string, file: string];

/** An assets.json bundle basename this app shadows. */
export type ShadowedBundle = "desk" | "website" | "login" | "email";

/** Classes frappe must still emit for our stylesheet to reach anything. */
export const SELECTORS: readonly SelectorEntry[] = [
	// Legacy classes the Carbon table engine RE-EMITS so that app code can keep
	// targeting our cells. If frappe stops emitting one, our re-emission is
	// merely redundant — but if frappe RENAMES one, third-party CSS and jQuery
	// written against it break, and we would want to follow the rename.
	["dt-row", "frappe/public/js/frappe/views/reports/report_view.js"],
	// report_view.js no longer names it (16.50); frappe's datatable stylesheet
	// still styles it, and ERPNext's asset.js and the data-import preview write
	// rules against it.
	["dt-cell__content", "frappe/public/scss/desk/frappe_datatable.scss"],
	["dt-filter", "frappe/public/js/frappe/views/reports/report_view.js"],
	["grid-static-col", "frappe/public/js/frappe/form/grid_row.js"],
	["grid-row-check", "frappe/public/js/frappe/form/grid.js"],
	["static-area", "frappe/public/js/frappe/form/grid_row.js"],
	["field-area", "frappe/public/js/frappe/form/grid_row.js"],
	["sortable-handle", "frappe/public/js/frappe/form/grid_row.js"],
	// The last data column fills spare width (grid_row.js `grid-data-last`); the
	// engine reproduces it as `fill` on the last column (tables/grid/grid.ts), and
	// frappe's drag handle on the header is the one the engine's own replaces
	// (desk/_carbon-table.scss).
	["grid-data-last", "frappe/public/js/frappe/form/grid_row.js"],
	["grid-col-resize-handle", "frappe/public/js/frappe/form/grid_row.js"],
	// The child-table detail panel. The Carbon expandable row RE-HOMES frappe's
	// `.form-in-grid` into a child <tr> and restyles its chrome; a rename here
	// leaves the panel unstyled inside an otherwise correct expandable row.
	["form-in-grid", "frappe/public/js/frappe/form/grid_row_form.js"],
	["grid-form-heading", "frappe/public/js/frappe/form/grid_row_form.js"],
	["grid-form-body", "frappe/public/js/frappe/form/grid_row_form.js"],
	["grid-header-toolbar", "frappe/public/js/frappe/form/grid_row_form.js"],
	["grid-footer-toolbar", "frappe/public/js/frappe/form/grid_row_form.js"],
	["grid-shortcuts", "frappe/public/js/frappe/form/grid_row_form.js"],
	["btn-open-row", "frappe/public/js/frappe/form/grid_row.js"],
	// Footer buttons the Carbon toolbar MOVES rather than rebuilds. A rename
	// means the toolbar silently comes up missing that action while the button
	// stays behind in the (hidden) footer.
	["grid-footer", "frappe/public/js/frappe/form/grid.js"],
	["grid-buttons", "frappe/public/js/frappe/form/grid.js"],
	["grid-custom-buttons", "frappe/public/js/frappe/form/grid.js"],
	["grid-add-row", "frappe/public/js/frappe/form/grid.js"],
	["grid-add-multiple-rows", "frappe/public/js/frappe/form/grid.js"],
	["grid-remove-rows", "frappe/public/js/frappe/form/grid.js"],
	["grid-remove-all-rows", "frappe/public/js/frappe/form/grid.js"],
	["grid-edit-rows", "frappe/public/js/frappe/form/grid.js"],
	["grid-duplicate-rows", "frappe/public/js/frappe/form/grid.js"],
	["grid-download", "frappe/public/js/frappe/form/grid.js"],
	["grid-upload", "frappe/public/js/frappe/form/grid.js"],
	["grid-pagination", "frappe/public/js/frappe/form/grid.js"],

	// list view / data table
	["list-row-col", "frappe/public/js/frappe/list/list_view.js"],
	["list-header-subject", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-head", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-container", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],
	["checkbox-actions", "frappe/public/js/frappe/list/list_view.js"],
	["text-right", "frappe/public/js/frappe/list/list_view.js"],
	// the boxes desk/_carbon-table.scss turns into the list's bounded scroller
	// (`.layout-main-section-wrapper .frappe-list .result-container .result`); the
	// `.result` div and the rules it must outrank are PATCH_TARGETS below
	["layout-main-section-wrapper", "frappe/public/js/frappe/ui/page.js"],
	["frappe-list", "frappe/public/js/frappe/list/base_list.js"],
	["result-container", "frappe/public/js/frappe/list/base_list.js"],
	// the page-size switch and Load More row desk/_list.scss sizes
	["list-paging-area", "frappe/public/js/frappe/list/base_list.js"],

	// UI Shell header — what js/anatomy/shell/* reads, or hides because it
	// replaces it. The header no longer MOVES frappe's search / bell / account
	// nodes (it builds its own cells), so these are what it hides and what it
	// anchors to, not what it harvests.
	["body-sidebar", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the two columns the fixed header is indented past (desk/_ui-shell.scss);
	// a rename here silently drops the header's reserved row on top of them
	["body-sidebar-container", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["main-section", "frappe/www/desk.html"],
	// the band of Search / Notification rows the header's global bar replaces;
	// hidden, not removed, because frappe keeps `$standard_items_band`
	["standard-items-band", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the user chip at the foot of the panel, hidden for the same reason
	["dropdown-navbar-user", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["sidebar-items", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// frappe's hamburger lives in the page head now, not in the sidebar template;
	// the header hides it so there is one
	["sidebar-toggle-btn", "frappe/public/js/frappe/ui/page.html"],
	// the bell cell keeps this class because it is the notifications panel's
	// `trigger_selector` (PATCH_TARGETS below)
	["sidebar-notification", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	// the search cell keeps this class because AwesomeBar.setup delegates its
	// click on `document` to exactly this selector (page.js:79)
	["navbar-modal-search-mobile", "frappe/public/js/frappe/ui/page.js"],
	// the one row frappe lights as current; the header's links follow it
	["active-sidebar", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	// the user menu's open marker, which styles the header's account cell
	["user-menu-active", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	// the unread badge frappe writes into (`update_count_badge`), anywhere in the document
	["notification-count", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	// the landing page's own navbar, which the header hides. .desktop-wrapper is
	// its template root.
	["desktop-wrapper", "frappe/desk/page/desktop/desktop.html"],
	["desktop-navbar", "frappe/desk/page/desktop/desktop.html"],
	// the dock — the module switcher inside an app, which the header sits beside,
	// and whose avatar duplicates the header's account cell
	["dock", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	["dock-logo", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	["shell-header", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	["header-logo", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	["dock-item", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	["dock-user", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	// on <body> while the dock is a column rather than a floating tray
	["dock-pinned", "frappe/public/js/frappe/ui/sidebar/dock.js"],
	// the panel the bell opens, which the header re-hosts on <body>
	["sidebar-panel", "frappe/public/js/frappe/ui/sidebar/sidebar_panel.js"],
	["panel-header", "frappe/public/js/frappe/ui/components/panel_header.js"],
	["panel-title", "frappe/public/js/frappe/ui/components/panel_header.js"],
	["panel-header-actions", "frappe/public/js/frappe/ui/components/panel_header.js"],
	// side nav — the rows js/anatomy/shell/model.ts projects into the header's
	// links and sub-menus. A rename here empties the header nav silently.
	["sidebar-item-container", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["section-item", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["item-anchor", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["section-break", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["standard-sidebar-item", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["nested-container", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["sidebar-item-label", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["sidebar-item-icon", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["sidebar-item-suffix", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["sidebar-item-control", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	// inside the notifications panel, restyled on the g100 layer
	["recent-item", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	// the avatar frappe.avatar() renders into the account cell
	["avatar-frame", "frappe/public/js/frappe/utils/common.js"],
	["standard-image", "frappe/public/js/frappe/utils/common.js"],
	// `frappe.utils.icon()` composes `es-icon` onto every sprite icon it draws,
	// and the website bundle ships the same helper, so the website navbar
	// recolours it onto the bar's text colour (web/_navbar.scss)
	["es-icon", "frappe/public/js/frappe/utils/utils.js"],
	// the like heart in the list's meta header is written by the theme with
	// `icon icon-sm`, which frappe's sprite stylesheet is what sizes
	["icon-sm", "frappe/public/scss/common/icons.scss"],
	// the theme-switcher preview tiles — the one .navbar left in the desk
	["theme-grid", "frappe/public/js/frappe/ui/theme_switcher.js"],

	// page chrome
	["page-actions", "frappe/public/js/frappe/ui/page.html"],
	["page-head-content", "frappe/public/js/frappe/ui/page.html"],
	["title-area", "frappe/public/js/frappe/ui/page.html"],
	// 16.50 draws the title as the last crumb of `nav.es-breadcrumbs.navbar-breadcrumbs`
	// and the status as a SIBLING `span.es-badge.page-indicator-pill`
	// (desk/_page-head.scss, js/anatomy/editable_title.ts, page_head_metrics.ts)
	["es-breadcrumbs", "frappe/public/js/frappe/ui/page.html"],
	["navbar-breadcrumbs", "frappe/public/js/frappe/ui/page.html"],
	["page-indicator-pill", "frappe/public/js/frappe/ui/page.html"],
	["es-breadcrumbs__item", "frappe/public/js/frappe/ui/components/breadcrumbs.js"],
	["es-breadcrumbs__label", "frappe/public/js/frappe/ui/components/breadcrumbs.js"],
	// frappe marks a renameable document with this on .title-area
	["editable-title", "frappe/public/js/frappe/form/toolbar.js"],

	// espresso components the theme restyles onto Carbon (desk/_buttons.scss,
	// _modals.scss, _misc.scss, _widgets.scss, _ai-chat.scss) — frappe's own
	// markup, so a rename is a silent revert to the espresso look
	["es-button", "frappe/public/js/frappe/ui/components/button.js"],
	["es-button__label", "frappe/public/js/frappe/ui/components/button.js"],
	["es-badge", "frappe/public/js/frappe/ui/components/badge.js"],
	["es-tab-buttons", "frappe/public/js/frappe/ui/components/tab_buttons.js"],
	["es-pill", "frappe/public/js/frappe/ui/components/tab_buttons.js"],
	["es-tabs", "frappe/public/js/frappe/ui/components/tabs.js"],
	["es-tabs__tab", "frappe/public/js/frappe/ui/components/tabs.js"],
	["es-tabs__indicator", "frappe/public/js/frappe/ui/components/tabs.js"],
	["es-menu", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__item", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__group", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__group-label", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__shortcut", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__chevron", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-menu__description", "frappe/public/js/frappe/ui/components/menu.js"],
	["es-tooltip", "frappe/public/js/frappe/ui/components/tooltip.js"],
	["es-tooltip__arrow", "frappe/public/js/frappe/ui/components/tooltip.js"],
	["es-tooltip__shortcut", "frappe/public/js/frappe/ui/components/tooltip.js"],
	["es-popover", "frappe/public/js/frappe/ui/components/popover.js"],
	["es-hover-card", "frappe/public/js/frappe/ui/components/hover_card.js"],
	["es-avatar", "frappe/public/js/frappe/ui/components/avatar.js"],
	["es-skeleton", "frappe/public/js/frappe/ui/components/skeleton.js"],
	// toasts: `frappe.ui.toast` replaced show_alert's markup, and the AI panel
	// moves the container aside while it is open (desk/_ai-chat.scss)
	["es-toast", "frappe/public/js/frappe/ui/components/toast.js"],
	["es-toast-container", "frappe/public/js/frappe/ui/components/toast.js"],
	// the dialog footer's two standard buttons, each `.hide` until a dialog
	// labels it; desk/_modals.scss lays the pair out edge to edge (dom.js)
	["btn-modal-primary", "frappe/public/js/frappe/dom.js"],
	["btn-modal-secondary", "frappe/public/js/frappe/dom.js"],

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
 * Runtime shapes the theme monkey-patches, calls, or reads. [id, file, regex]
 * If the regex stops matching, the patch silently stops applying.
 */
export const PATCH_TARGETS: readonly PatchTarget[] = [
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
	// The replacement RESTATES the original's body (tables/datatable/install.ts), so
	// everything the original does after `new DataTable(...)` must still be what it
	// repeats: the two hooks it ends on, and the members it calls on the view.
	[
		"ReportView.setup_datatable still ends on the two hooks the restated copy repeats",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/setup_datatable\(values\)\s*\{[\s\S]{0,4000}?this\.setup_inline_filter_observer\(\);\s*this\.setup_link_side_panel\(\);\s*\}/,
	],
	[
		"ReportView.setup_link_side_panel (the restated setup_datatable calls it)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/setup_link_side_panel\(\)\s*\{/,
	],
	[
		"ReportView.setup_inline_filter_observer (the restated setup_datatable calls it)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/setup_inline_filter_observer\(\)\s*\{/,
	],
	[
		"frappe.ui.handle_link_cell_click (the link-preview click both report surfaces route through)",
		"frappe/public/js/frappe/views/reports/link_side_panel.js",
		/frappe\.ui\.handle_link_cell_click = function \(e, datatable\)/,
	],
	[
		"ReportView.get_columns_for_picker (the Add Column dialog's source list)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/get_columns_for_picker\(\)\s*\{/,
	],
	[
		"ReportView.is_column_added (the Add Column dialog's filter)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/is_column_added\(df\)\s*\{/,
	],
	[
		"ReportView.add_column_to_datatable (what the Add Column dialog calls)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/add_column_to_datatable\(fieldname, doctype, col_index\)\s*\{/,
	],
	[
		"ReportView.remove_column_from_datatable (the restated setup_datatable's onRemoveColumn)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/remove_column_from_datatable\(column\)\s*\{/,
	],
	[
		"ReportView.switch_column (the restated setup_datatable's onSwitchColumn)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/switch_column\(col1, col2\)\s*\{/,
	],
	[
		"ReportView.get_editing_object (the restated setup_datatable's getEditor)",
		"frappe/public/js/frappe/views/reports/report_view.js",
		/get_editing_object\(colIndex, rowIndex, value, parent\)\s*\{/,
	],
	[
		"ListView.debounced_toggle_workflow_actions (inherited by ReportView; the selection event calls it)",
		"frappe/public/js/frappe/list/list_view.js",
		/debounced_toggle_workflow_actions\(\)\s*\{/,
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
		"Grid exports its column bounds by name (tables/grid imports both; a rename is a build error)",
		"frappe/public/js/frappe/form/grid.js",
		/export const GRID_MIN_COLUMN_WIDTH = \d+;\s*export const GRID_MAX_COLUMN_WIDTH = \d+;/,
	],
	[
		"GridRow is an ES module default export (subclassed by CarbonGridRow)",
		"frappe/public/js/frappe/form/grid_row.js",
		/export default class GridRow/,
	],
	[
		"GridRow.make_column builds the .grid-static-col cell we reuse verbatim",
		"frappe/public/js/frappe/form/grid_row.js",
		/make_column\(df, width, txt, ci\)/,
	],
	[
		"GridRow marks the last data column .grid-data-last (the engine's `fill` mirrors it)",
		"frappe/public/js/frappe/form/grid_row.js",
		/removeClass\("grid-data-last"\)\);\s*this\.columns_list\[this\.columns_list\.length - 1\]\?\.addClass\("grid-data-last"\)/,
	],
	[
		"GridRowForm appends .form-in-grid to the ROW (we re-home it to the child row)",
		"frappe/public/js/frappe/form/grid_row_form.js",
		/\$\('<div class="form-in-grid"><\/div>'\)\.appendTo\(this\.row\.wrapper\)/,
	],
	[
		"GridRow.show_form hides the data row (Carbon keeps the parent row visible)",
		"frappe/public/js/frappe/form/grid_row.js",
		/show_form\(\)\s*\{[\s\S]{0,1200}?this\.row\.toggle\(false\)/,
	],
	[
		"GridRow.show_form raises a modal backdrop (inline mode balances the count)",
		"frappe/public/js/frappe/form/grid_row.js",
		/frappe\.dom\.freeze\("", "grid-form"\)/,
	],
	[
		"GridRow.hide_form unfreezes unconditionally (the counterweight depends on it)",
		"frappe/public/js/frappe/form/grid_row.js",
		/hide_form\(\)\s*\{[\s\S]{0,600}?frappe\.dom\.unfreeze\(\)/,
	],
	[
		"frappe.dom.freeze is reference-counted (show/hide must balance, not skip)",
		"frappe/public/js/frappe/dom.js",
		/frappe\.dom\.freeze_count\+\+/,
	],
	[
		"Grid.make binds data-action handlers onto the button ELEMENTS (so moving them is safe)",
		"frappe/public/js/frappe/form/grid.js",
		/frappe\.utils\.bind_actions_with_object\(this\.wrapper, this\)/,
	],
	[
		"Grid.refresh_remove_rows_button (the hook the Carbon batch bar rides on)",
		"frappe/public/js/frappe/form/grid.js",
		/refresh_remove_rows_button\(\)\s*\{/,
	],
	// CarbonGrid and CarbonGridRow subclass these and override them (tables/grid), so
	// each name is a seam: a rename leaves the override as a method nobody calls.
	[
		"Grid.make's scaffolding: .form-grid-container > .form-grid > (.grid-heading-row, .grid-body > (.rows, .grid-empty)) (the engine replaces it; inherited refresh() still finds those nodes)",
		"frappe/public/js/frappe/form/grid.js",
		/<div class="form-grid-container">\s*<div class="form-grid">\s*<div class="grid-heading-row"><\/div>\s*<div class="grid-body">\s*<div class="rows"><\/div>\s*<div class="grid-empty/,
	],
	[
		"Grid.make_head bails on prevent_build (CarbonGrid.make_head mirrors the guard)",
		"frappe/public/js/frappe/form/grid.js",
		/make_head\(\)\s*\{\s*if \(this\.prevent_build\) return;/,
	],
	[
		"Grid.render_result_rows (CarbonGrid draws the page of rows into the engine instead)",
		"frappe/public/js/frappe/form/grid.js",
		/render_result_rows\(\$rows\)\s*\{/,
	],
	[
		"GridRow.make builds .grid-row > .data-row.row (CarbonGridRow moves both class sets onto one <tr>)",
		"frappe/public/js/frappe/form/grid_row.js",
		/this\.wrapper = \$\('<div class="grid-row"><\/div>'\);\s*this\.row = \$\('<div class="data-row row m-0"><\/div>'\)/,
	],
	[
		"GridRow.set_row_index (CarbonGridRow extends it to fill the child row's heading)",
		"frappe/public/js/frappe/form/grid_row.js",
		/set_row_index\(\)\s*\{\s*if \(this\.doc\) \{/,
	],
	[
		"GridRow.toggle_view(show, callback) (CarbonGridRow widens it with a `modal` option)",
		"frappe/public/js/frappe/form/grid_row.js",
		/toggle_view\(show, callback\)\s*\{/,
	],
	[
		"GridRow.add_open_form_button nests .btn-open-row in a .col cell (the engine needs the cell, super hands back the inner node)",
		"frappe/public/js/frappe/form/grid_row.js",
		/this\.open_form_button = \$\('<div class="col"><\/div>'\)\.appendTo\(this\.row\);[\s\S]{0,600}?<div class="btn-open-row"/,
	],
	[
		"Grid.get_column_width (inherited: frappe's pixel width seeds the engine) and clamp_column_width (the drag is held to it)",
		"frappe/public/js/frappe/form/grid.js",
		/clamp_column_width\(width\)\s*\{[\s\S]{0,200}?get_column_width\(df\)\s*\{/,
	],
	[
		"Grid.save_column_width (a dragged width is handed back to it to persist)",
		"frappe/public/js/frappe/form/grid.js",
		/save_column_width\(fieldname, width\)\s*\{/,
	],
	[
		"Grid.set_button_label writes into .es-button__label (the Carbon toolbar relabels the same node)",
		"frappe/public/js/frappe/form/grid.js",
		/set_button_label\(\$btn, label\)\s*\{[\s\S]{0,300}?\$btn\.find\("\.es-button__label"\)\.text\(label\)/,
	],
	[
		"Grid._teardown_column_layout (CarbonGrid overrides it to reach the engine)",
		"frappe/public/js/frappe/form/grid.js",
		/_teardown_column_layout\(\)\s*\{/,
	],
	[
		"GridRow.show_search_row removes the filter row below the threshold (we override it)",
		"frappe/public/js/frappe/form/grid_row.js",
		/!this\.show_search && this\.wrapper\.remove\(\)/,
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
		"ListView.render_header (patched down to the bulk-action overlay)",
		"frappe/public/js/frappe/list/list_view.js",
		/render_header\(refresh_header = false\)\s*\{/,
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
	// Selection moved off the DOM and into a Set in 16.50. The replacement
	// render_list restates the contract frappe's own keeps (list_view.js
	// 1031-1083): prune the Set against the new data, redraw, repaint the ticks.
	[
		"ListView.checked_docnames is a Set (selection lives there, a checkbox is its mirror)",
		"frappe/public/js/frappe/list/list_view.js",
		/this\.checked_docnames = new Set\(\)/,
	],
	[
		"ListView.prune_checked_docnames (render_list calls it first, on the NEW data)",
		"frappe/public/js/frappe/list/list_view.js",
		/prune_checked_docnames\(\)\s*\{[\s\S]{0,300}?this\.checked_docnames\.delete\(name\)/,
	],
	[
		"ListView.get_checkbox_docname (reads data-name; the repaint after a virtual scroll calls it)",
		"frappe/public/js/frappe/list/list_view.js",
		/get_checkbox_docname\(\$checkbox\)\s*\{/,
	],
	[
		"ListView.remove_list_items removes the row's .list-row-container and nothing else (the engine's data follows)",
		"frappe/public/js/frappe/list/list_view.js",
		/remove_list_items\(names\)\s*\{[\s\S]{0,400}?\.closest\("\.list-row-container"\)\s*\.remove\(\)/,
	],
	[
		"ListView.get_assignment_stats returns the pair render_list hands update_listview_classes",
		"frappe/public/js/frappe/list/list_view.js",
		/get_assignment_stats\(\)\s*\{[\s\S]{0,900}?return \{ has_assignto, assign_to_count \}/,
	],
	[
		"ListView.update_listview_classes (render_list ends on it)",
		"frappe/public/js/frappe/list/list_view.js",
		/update_listview_classes\(has_assignto, assign_to_count\)\s*\{/,
	],
	[
		"ListView.virtualization_threshold (the engine virtualizes at frappe's own row count)",
		"frappe/public/js/frappe/list/list_view.js",
		/this\.virtualization_threshold = \d+/,
	],
	[
		"ListView.save_column_width (a dragged list column is persisted through it)",
		"frappe/public/js/frappe/list/list_view.js",
		/save_column_width\(fieldname, width\)\s*\{/,
	],
	[
		"ListView.column_max_widths (the drag writes the width here before persisting it)",
		"frappe/public/js/frappe/list/list_view.js",
		/this\.column_max_widths = \{\}/,
	],
	// The list's DOM, which desk/_carbon-table.scss outranks by selector. The
	// bounded scroller needs `.result` to sit directly in `.result-container`
	// (a List view only), and two frappe rules on it to be the two it out-scores.
	[
		"the List view builds .result-container, then .result inside it (the bounded-scroller selector)",
		"frappe/public/js/frappe/list/base_list.js",
		/setup_result_container_area\(\)\s*\{[\s\S]{0,200}?<div class="result-container">[\s\S]{0,300}?setup_result_area\(\)\s*\{\s*this\.\$result = \$\(`<div class="result">`\);[\s\S]{0,200}?find\("\.result-container"\)/,
	],
	[
		"desk/list.scss: `.layout-main-section-wrapper:not(.disable-scrolling) .frappe-list .result-container .result` (specificity 0,5,0 — the theme's doubled .result must beat it)",
		"frappe/public/scss/desk/list.scss",
		/\.layout-main-section-wrapper:not\(\.disable-scrolling\) \{\s*\.frappe-list \{\s*\.result-container \{\s*\.result \{/,
	],
	[
		"desk/list.scss: `.list-view .frappe-list .result-container .result { display: table }` (the other .result rule)",
		"frappe/public/scss/desk/list.scss",
		/\.list-view \{\s*\.frappe-list \{\s*\.result-container \{[\s\S]{0,80}?\.result \{[\s\S]{0,80}?display: table;/,
	],
	[
		"desk/list.scss: `.list-row-container:first-child` is sticky (the engine's first body row must un-stick it)",
		"frappe/public/scss/desk/list.scss",
		/\.list-row-container \{[\s\S]{0,200}?&:first-child \{\s*padding: 0;\s*position: sticky;/,
	],
	[
		"the paging row holds a TabButtons page-size switch (desk/_list.scss sizes its pills)",
		"frappe/public/js/frappe/list/base_list.js",
		/this\.paging_button_group = new frappe\.ui\.TabButtons\(\{[\s\S]{0,900}?this\.\$paging_area\.find\("\.level-left"\)\.append\(this\.paging_button_group\.\$el\)/,
	],
	[
		"toolbar.setup_editable_title_click_event (clickable page title)",
		"frappe/public/js/frappe/form/toolbar.js",
		/setup_editable_title_click_event\s*\(/,
	],
	[
		"editable-title class on .title-area (marks a renameable doc)",
		"frappe/public/js/frappe/form/toolbar.js",
		/\$title_area\.toggleClass\(\s*"editable-title"/,
	],
	[
		"Page.$title_area is the .title-area node (editable_title.ts reads the class off it)",
		"frappe/public/js/frappe/ui/page.js",
		/this\.\$title_area = this\.wrapper\.find\("\.title-area"\)/,
	],
	[
		"Page.indicator resolves via .title-area .page-indicator-pill (a sibling of the trail, not inside it)",
		"frappe/public/js/frappe/ui/page.js",
		/this\.indicator = this\.wrapper\.find\("\.title-area \.page-indicator-pill"\)/,
	],
	// editable_title.ts wraps render_breadcrumbs: the title is the LAST crumb and the
	// trail is emptied and rebuilt on every paint, so only a hook on the painter
	// survives to dress it.
	[
		"Page.render_breadcrumbs empties the trail and redraws every crumb on each paint (editable title wraps it)",
		"frappe/public/js/frappe/ui/page.js",
		/render_breadcrumbs\(\)\s*\{[\s\S]{0,900}?\.empty\(\)/,
	],
	[
		"Form.refresh_header paints the trail once more AFTER toolbar.refresh (the paint with the settled editable-title class)",
		"frappe/public/js/frappe/form/form.js",
		/this\.toolbar\.refresh\(\);[\s\S]{0,300}?this\.page\.set_breadcrumbs\(/,
	],
	[
		"frappe.router event emitter (editable title, UI Shell re-mount)",
		"frappe/public/js/frappe/router.js",
		/make_event_emitter\(frappe\.router\)/,
	],
	[
		"the dialog footer is an empty .custom-actions plus a .standard-actions of two es-buttons (the flush Carbon footer keys off it)",
		"frappe/public/js/frappe/dom.js",
		/<div class="modal-footer hide">\s*<div class="custom-actions"><\/div>\s*<div class="standard-actions">[\s\S]{0,200}?btn-modal-secondary hide[\s\S]{0,200}?btn-modal-primary hide/,
	],

	// --- UI Shell header (js/anatomy/ui_shell.ts + shell/*) ----------------
	["empty <header> mount point (UI Shell header)", "frappe/www/desk.html", /<header>\s*<\/header>/],
	["#body content column (the skip link's target)", "frappe/www/desk.html", /<div id="body">/],
	[
		"toolbar only replaces <header> conditionally",
		"frappe/public/js/frappe/ui/toolbar/toolbar.js",
		/\$\("header"\)\.replaceWith/,
	],
	[
		"Application: make_nav_bar before make_sidebar (the mount gate's premise)",
		"frappe/public/js/frappe/desk.js",
		/this\.make_nav_bar\(\);\s*this\.make_sidebar\(\);/,
	],
	[
		"frappe.app assigned after construction (`{}` until then)",
		"frappe/public/js/frappe/desk.js",
		/frappe\.app = new frappe\.Application\(\)/,
	],
	[
		"frappe.ui.Sidebar class (the header projects its state)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/frappe\.ui\.Sidebar = class/,
	],
	[
		"Sidebar.make_sidebar (the header re-projects after it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/make_sidebar\(\)\s*\{/,
	],
	[
		"Sidebar.setup renders through make_sidebar (one hook covers shell switches and a saved Edit Sidebar)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/setup\(current_module\)\s*\{[\s\S]{0,600}?this\.make_sidebar\(\)/,
	],
	[
		"sidebar_setup fires BEFORE current_module changes (why the header does not use it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/trigger\("sidebar_setup"[\s\S]{0,120}?this\.current_module = current_module/,
	],
	[
		"Sidebar.sidebar_data is the shell's boot entry (the header name reads its .label)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/this\.sidebar_data = frappe\.boot\.module_sidebars\[this\.current_module\]/,
	],
	[
		"Sidebar.get_sidebar_app resolves the shell's app through app_data and the rail host (the name prefix and the switcher's selected row)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/get_sidebar_app\(\)\s*\{[\s\S]{0,400}?app_data\.find\([\s\S]{0,80}?rail_host_for\(app_name\)/,
	],
	[
		"Sidebar.highlight_active_item writes .active-sidebar (the header's current link follows it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/highlight_active_item\(\)\s*\{[\s\S]{0,200}?this\.active_item\.addClass\("active-sidebar"\)/,
	],
	[
		"Sidebar.find_active_item scans every .item-anchor[href] and lights the anchor's PARENT (activeHref reads `.active-sidebar > a.item-anchor`)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/\$\("\.item-anchor\[href\]"\)\.each\(function \(\) \{[\s\S]{0,400}?best = \$\(this\)\.parent\(\)/,
	],
	[
		"Sidebar.page_allows_sidebar reads the page's hide_sidebar (model.ts's launcher test)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/page_allows_sidebar\(\)\s*\{[\s\S]{0,200}?!page\.hide_sidebar/,
	],
	[
		"Sidebar.page_allows_dock reads the page's hide_dock (model.ts's launcher test)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/page_allows_dock\(\)\s*\{[\s\S]{0,200}?!page\.hide_dock/,
	],
	[
		"the Desktop page opts out of both shells (hide_sidebar + hide_dock are what make /desk the launcher)",
		"frappe/desk/page/desktop/desktop.js",
		/hide_sidebar: true,\s*hide_dock: true/,
	],
	[
		"Sidebar.apply_page_visibility hides the wrapper with an inline display:none (model.ts reads the computed display)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/apply_page_visibility\(\)\s*\{[\s\S]{0,600}?this\.wrapper\.toggle\(allowed\)/,
	],
	[
		"the sidebar wrapper is built hidden and prepended to <body> (the AI takeover and the shell's column math rely on it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/\.hide\(\)\s*\.prependTo\("body"\)/,
	],
	[
		"Sidebar.apply_expanded_state toggles .expanded on the wrapper (the rail/expanded rules in desk/_sidebar.scss ride on it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/apply_expanded_state\(\)\s*\{[\s\S]{0,500}?this\.wrapper\.addClass\("expanded"\)[\s\S]{0,300}?this\.wrapper\.removeClass\("expanded"\)/,
	],
	[
		"Sidebar.close/open set sidebar_expanded BEFORE the event (the hamburger's aria state is read from it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/close\(\)\s*\{\s*this\.sidebar_expanded = false;[\s\S]{0,200}?open\(\)\s*\{\s*this\.sidebar_expanded = true;/,
	],
	[
		"sidebar-expand event (hamburger aria state)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/trigger\("sidebar-expand",\s*\{\s*sidebar_expand:/,
	],
	[
		"toggle_width (the hamburger's delegate)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/toggle_width\(\)\s*\{/,
	],
	[
		"Sidebar.module_landing_route (the header name's link, the dock tile and the icon grid all use it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/module_landing_route\(module\)\s*\{\s*const sidebar = frappe\.boot\.module_sidebars\[module\]/,
	],
	[
		"Sidebar.app_landing_route (the switcher tile's destination: declared route, then rail, then first module)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/app_landing_route\(app\)\s*\{[\s\S]{0,200}?app\.app_route/,
	],
	[
		"Sidebar.create_user_menu (the header's account cell is a second host of the one menu)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/create_user_menu\(\{ parent, button, side = "top", align = "start" \}\)/,
	],
	[
		"create_user_menu binds the menu to `parent` and marks `button` while it is open",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/trigger: \$container,\s*side,\s*align,[\s\S]{0,3500}?on_open: \(\) => \$btn\.addClass\("user-menu-active"\)/,
	],
	[
		"Sidebar.setup_notifications builds frappe.ui.Notifications only when the desk setting is on (the bell's visibility reads sidebar.notifications)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/setup_notifications\(\)\s*\{\s*if \(frappe\.boot\.desk_settings\.notifications && frappe\.session\.user !== "Guest"\) \{\s*this\.notifications = new frappe\.ui\.Notifications\(\)/,
	],
	[
		"the Search row's condition: the header's search cell is built only when this setting is on",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/class: "navbar-modal-search-mobile",\s*condition: \(\) => !!frappe\.boot\.desk_settings\.search_bar/,
	],
	[
		"the bell row's click is frappe.ui.sidebar_panels.toggle(\"notifications\") (the header's bell calls the same)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/onClick: \(\) => frappe\.ui\.sidebar_panels\.toggle\("notifications"\)/,
	],
	[
		"AwesomeBar.setup delegates the search click on `document` to the selector it is given",
		"frappe/public/js/frappe/ui/toolbar/awesome_bar.js",
		/\$\(document\)\.on\("click", element/,
	],
	[
		"Page.setup_awesomebar hands AwesomeBar the .navbar-modal-search-mobile class (the header's search cell carries it)",
		"frappe/public/js/frappe/ui/page.js",
		/awesome_bar\.setup\("\.navbar-modal-search-mobile"\)/,
	],
	[
		'the notifications panel is registered under "notifications" with .sidebar-notification as its trigger (the bell cell keeps that class)',
		"frappe/public/js/frappe/ui/notifications/notifications.js",
		/name: "notifications",[\s\S]{0,120}?trigger_selector: "\.sidebar-notification"/,
	],
	[
		"update_count_badge writes into EVERY .notification-count in the document (the header's badge is kept by frappe)",
		"frappe/public/js/frappe/ui/notifications/notifications.js",
		/const \$count = \$\("\.notification-count"\)/,
	],
	[
		"SidebarPanel mounts into .body-sidebar-container (the header re-hosts the element on <body>)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_panel.js",
		/MOUNT_SELECTOR = "\.body-sidebar-container"/,
	],
	[
		"SidebarPanel's element carries .sidebar-panel and a per-name class (the notifications panel's `.sidebar-panel-notifications`)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_panel.js",
		/<div class="sidebar-panel hidden"><\/div>`\)\s*\.addClass\(`sidebar-panel-\$\{this\.name\}`\)/,
	],
	[
		"the panel registry's get/toggle by name (the bell reads the panel, then toggles it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_panel.js",
		/get\(name\)\s*\{\s*return this\.panels\[name\];\s*\}[\s\S]{0,2500}?toggle\(name\)\s*\{\s*if \(this\.get\(name\)\?\.is_open\)/,
	],
	[
		"a click on the panel's trigger_selector is not an outside click, and aria-expanded is mirrored onto every match",
		"frappe/public/js/frappe/ui/sidebar/sidebar_panel.js",
		/\$\(this\.opts\.trigger_selector\)\.attr\("aria-expanded", String\(this\.is_open\)\)[\s\S]{0,500}?\$target\.closest\(this\.opts\.trigger_selector\)/,
	],
	[
		"Dock mounts as a direct child of <body>, beside the sidebar container (the assistant covers it as `body > .dock`)",
		"frappe/public/js/frappe/ui/sidebar/dock.js",
		/\$container = \$\("\.body-sidebar-container"\);\s*if \(\$container\.length\) \{\s*this\.\$dock\.insertBefore\(\$container\);\s*\} else \{\s*this\.\$dock\.prependTo\("body"\)/,
	],
	[
		"a Section Break's click is bound on its .standard-sidebar-item (a delegated .click() on the anchor reaches it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.js",
		/setup_event_listner\(\)\s*\{[\s\S]{0,80}?\$\(this\.wrapper\.find\("\.standard-sidebar-item"\)\[0\]\)\.on\("click"/,
	],
	[
		"section-item container with its nested-container children",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.html",
		/section-item[\s\S]*?class="sidebar-child-item nested-container"/,
	],
	[
		"an indented row's .standard-sidebar-item carries `indent`, which the `.indent + .nested-container` rule keys off",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.html",
		/class="standard-sidebar-item \{%= item\.indent \? 'indent' : '' %\}"/,
	],
	[
		"item-anchor gets href only when frappe computed a path (no href = an action)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.html",
		/\{% if \(path\) \{ %\}\s*href="\{\{ path \}\}"/,
	],
	[
		"sidebar item labels are translated server-side (copied verbatim)",
		"frappe/desk/doctype/sidebar/sidebar.py",
		/"label": _\(item\.label\)/,
	],
	[
		'body click router skips href="#" (sub-menu titles preventDefault themselves)',
		"frappe/public/js/frappe/router.js",
		/href === "#"/,
	],

	// --- Boot payload the shell reads (js/anatomy/shell/model.ts, desktop.ts,
	// switcher.ts, utilities.ts). Server-side shapes: a JS test cannot see them,
	// and a renamed key reads as `undefined` — an empty header, an empty switcher.
	[
		"boot.module_sidebars (the shell map: current_module indexes it, the switcher resolves icons through it)",
		"frappe/boot.py",
		/bootinfo\.module_sidebars = get_module_sidebars\(\)/,
	],
	[
		"a module_sidebars entry carries name, module, label and app (header name, switcher's shellFor, get_sidebar_app)",
		"frappe/desk/doctype/sidebar/sidebar.py",
		/def as_boot_entry\(self\)[\s\S]{0,400}?"name": self\.name,\s*"module": self\.module,\s*"label": self\.label,\s*"app": self\.app,/,
	],
	[
		"boot.app_data entries carry app_name and app_title (the header prefix, the switcher's rows)",
		"frappe/boot.py",
		/app_name=app_info\.get\("name"\) or app_name,\s*app_title=app_info\.get\("title"\)/,
	],
	[
		"app_data entries carry app_route (the switcher's hrefs)",
		"frappe/boot.py",
		/app_route=app_info\.get\("route"\)/,
	],
	[
		"app_data.on_apps_screen opts an app into the Apps screen (the switcher's filter)",
		"frappe/boot.py",
		/on_apps_screen=bool\(apps\) and app_name not in app_rail_host/,
	],
	[
		"app_data.sequence_id orders the Apps screen (the switcher's sort)",
		"frappe/boot.py",
		/sequence_id=app_info\.get\("sequence_id"\) or DEFAULT_APP_SEQUENCE_ID/,
	],
	[
		"boot.desktop_icons exists ONLY when Desktop Settings picks the icon grid (the switcher's mode switch)",
		"frappe/boot.py",
		/if is_desktop_icons_page\(\):\s*from frappe\.desk\.doctype\.desktop_icon\.desktop_icon import get_desktop_icons\s*\n\s*bootinfo\.desktop_icons = get_desktop_icons\(bootinfo=bootinfo\)/,
	],
	[
		"desktop icons carry label, link, link_type, icon_type, parent_icon, idx and hidden (the switcher re-applies the grid's rules over them)",
		"frappe/desk/doctype/desktop_icon/desktop_icon.py",
		/fields = \[\s*"label",\s*"bg_color",\s*"link",\s*"link_type",\s*"app",\s*"icon_type",\s*"parent_icon",\s*"icon",\s*"link_to",\s*"idx",[\s\S]{0,80}?"hidden",/,
	],
	[
		"desktop icons carry `module`, the shell key the switcher marks selected",
		"frappe/desk/doctype/desktop_icon/desktop_icon.py",
		/s\.module = icon_module/,
	],
	[
		"boot.desk_settings carries search_bar and notifications (the header builds its cells from them)",
		"frappe/core/doctype/user/user.py",
		/desk_properties = \(\s*"search_bar",\s*"notifications",/,
	],

	// --- The desktop's two renderers, which the switcher mirrors --------------
	// (js/anatomy/shell/desktop.ts: one list, whichever the site renders)
	[
		"Apps screen: only apps with on_apps_screen get a tile",
		"frappe/desk/page/desktop/desktop.js",
		/\.filter\(\(app\) => app\.on_apps_screen\)/,
	],
	[
		"Apps screen: tiles sort by sequence_id (default 100), ties in installed-apps order",
		"frappe/desk/page/desktop/desktop.js",
		/\(a\.sequence_id \?\? 100\) - \(b\.sequence_id \?\? 100\)/,
	],
	[
		"Apps screen: a tile leads to app_landing_route, then the app's route, then /desk",
		"frappe/desk/page/desktop/desktop.js",
		/app_landing_route\(app\) \|\| app\.app_route \|\| "\/desk"/,
	],
	[
		"Desktop Icons grid: a hidden icon is dropped, and an icon whose parent is visible nests under it",
		"frappe/public/js/desktop_icons.bundle.js",
		/prepare\(\) \{\s*this\.apps_icons = \[\];[\s\S]{0,400}?icon\.hidden != 1[\s\S]{0,900}?icon\.parent_icon && icon_map\[icon\.parent_icon\]/,
	],
	[
		"Desktop Icons grid: every grid sorts by idx, then by label (localeCompare, no locale argument)",
		"frappe/public/js/desktop_icons.bundle.js",
		/a\.idx === b\.idx\) \{\s*return a\.label\.localeCompare\(b\.label\);[\s\S]{0,120}?return a\.idx - b\.idx;/,
	],
	[
		"Desktop Icons grid: a Folder with no visible children is not rendered",
		"frappe/public/js/desktop_icons.bundle.js",
		/validate_icon\(\)\s*\{\s*if \(this\.icon_type == "Folder"\) \{\s*if \(this\.icon_data\.child_icons\.length == 0\) return false;/,
	],
	[
		"Desktop Icons grid: an App or Folder with children opens them instead of navigating",
		"frappe/public/js/desktop_icons.bundle.js",
		/this\.child_icons\?\.length && \(this\.icon_type == "App" \|\| this\.icon_type == "Folder"\)/,
	],
	[
		"Desktop Icons grid: a Workspace Sidebar icon opens its shell's module_landing_route; an External link is absolute",
		"frappe/public/js/desktop_icons.bundle.js",
		/function get_route\(desktop_icon\)\s*\{[\s\S]{0,300}?link_type == "External"[\s\S]{0,300}?link_type == "Workspace Sidebar"[\s\S]{0,300}?module_landing_route\(sidebar\.name\)/,
	],
	[
		"frappe.utils.sidebar_for_module: the shell is its module's own key, else the one whose `module` it is (the switcher's shellFor)",
		"frappe/public/js/frappe/utils/utils.js",
		/sidebar_for_module\(module\)\s*\{\s*if \(!module\) return undefined;\s*const all = frappe\.boot\.module_sidebars \|\| \{\};\s*return all\[module\] \|\| Object\.values\(all\)\.find\(\(entry\) => entry\.module === module\)/,
	],

	// --- AI assistant takeover (js/anatomy/shell/assistant.ts) --------------
	// apps/flow is not frappe's, and CI checks frappe out alone, so its panel
	// (#flow-root, frappe.flow.panel.{show,hide,toggle,visible}) cannot be listed
	// here; the runtime guard for it is `isFlowPanel` and the drift record
	// "Carbon AI assistant (flow takeover)". What the takeover leans on in frappe is:
	[
		"keys.add_shortcut drops the key's existing handlers first (registering Ctrl+I replaces flow's)",
		"frappe/public/js/frappe/ui/keyboard.js",
		/frappe\.ui\.keys\.off\(shortcut, page\);\s*\/\/ attach new handler\s*frappe\.ui\.keys\.on\(shortcut, handler\)/,
	],
	[
		"keys.off without a page removes EVERY handler for the key (flow's included)",
		"frappe/public/js/frappe/ui/keyboard.js",
		/frappe\.ui\.keys\.off = function \(key, page\)[\s\S]{0,200}?if \(!page\) return false/,
	],
	[
		"an action that returns nothing gets preventDefault (Ctrl+I is the browser's own binding)",
		"frappe/public/js/frappe/ui/keyboard.js",
		/prevent_default \|\| prevent_default === undefined/,
	],
	[
		"app_ready fires inside startup(), after make_sidebar (why the takeover runs when the header mounts)",
		"frappe/public/js/frappe/desk.js",
		/this\.make_sidebar\(\);[\s\S]{0,1200}?trigger\("app_ready"\)/,
	],
	[
		"the window-level Escape handler blurs the active element (the failed-load panel stops the event first)",
		"frappe/public/js/frappe/ui/keyboard.js",
		/function handle_escape_key\(\) \{\s*close_grid_and_dialog\(\);\s*document\.activeElement\?\.blur\(\);/,
	],
	[
		"frappe.is_mobile threshold (the shell never mounts below it)",
		"frappe/public/js/frappe/utils/common.js",
		/innerWidth < 768/,
	],
];

/**
 * frappe-side declarations we deliberately override. Their continued existence
 * proves the MECHANISM still works, not just the value.
 */
export const MIRRORED_LITERALS: readonly MirroredLiteral[] = [
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
	// the awesomebar rule pinned to `top: 40px` — an offset measured against
	// frappe's 28px input, which crossed Carbon's 40px field. desk/_modals.scss
	// hides it; if frappe reworks it, that suppression wants revisiting.
	["modal-divider", "frappe/public/scss/desk/navbar.scss"],
	// the notifications panel's frame (position, 360px, a 480px floor) which
	// desk/_ui-shell.scss re-anchors as the header's right panel, and the unread
	// badge it restyles; both are overridden by selector, so each must still be
	// frappe's rule for the override to be the one that wins
	[".sidebar-panel", "frappe/public/scss/desk/sidebar_panel.scss"],
	["min-height: 480px", "frappe/public/scss/desk/sidebar_panel.scss"],
	[".notification-count", "frappe/public/scss/desk/notification.scss"],
	// the z-index contract the header's 1030 sits inside: above the sidebar (1020),
	// its overlay (1021) and frappe's .sticky-top (1019); the dock's own 1030 is
	// what the theme lowers to 1022 so the header does not cover its logo
	["z-index: 1020", "frappe/public/scss/desk/sidebar.scss"],
	["z-index: 1021", "frappe/public/scss/desk/sidebar.scss"],
	["z-index: 1019", "frappe/public/scss/desk/main.scss"],
	["z-index: 1030", "frappe/public/scss/desk/dock.scss"],
	// ...and the espresso menus it must stay under: they sit at 1060, above the shell's
	// 1030 and Bootstrap's modals (1050), so a menu opened from a header cell paints
	// over the header. Bootstrap's own numbers live in node_modules, which this audit
	// does not read, so the contract's upper half is guarded by this one literal.
	["z-index: 1060", "frappe/public/css/espresso/components/menu.css"],
];

/** assets.json keys this app shadows; all must point at carbon_frappe. */
export const SHADOWED_BUNDLES: readonly ShadowedBundle[] = ["desk", "website", "login", "email"];

/** This app's own esbuild entry points, by bare bundle name. */
export type JsBundle = "carbon_charts" | "carbon_desk" | "carbon_anatomy" | "carbon_tables";

/**
 * The four bundles `hooks.py` lists in `app_include_js`.
 *
 * They need their own assets.json repair, for a different reason than the CSS
 * shadow above: frappe's `write_assets_json` keys by the ENTRY basename
 * (frappe/esbuild/esbuild.js:450), so a `.ts` entry writes
 * `carbon_desk.bundle.ts` while `include_script` looks up
 * `carbon_desk.bundle.js` and has no extension fallback
 * (frappe/utils/jinja_globals.py:151-156). Nothing errors; the `.js` key just
 * keeps an older build's hash. Declared here so patch-assets (the repair),
 * audit-markup (the guard) and carbon_frappe/build.py cannot drift apart.
 */
export const JS_BUNDLES: readonly JsBundle[] = [
	"carbon_charts",
	"carbon_desk",
	"carbon_anatomy",
	"carbon_tables",
];
