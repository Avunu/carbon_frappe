/**
 * Everything this theme depends on in frappe's MARKUP and RUNTIME, declared in
 * one place so scripts/audit-markup.ts and the code cannot drift apart.
 *
 * These are the dependencies CSS alone cannot express. A rename upstream turns
 * an override into a silent no-op: the theme keeps loading and the component
 * just quietly reverts to stock frappe styling, which is exactly the failure
 * mode that is hardest to notice.
 */

// ---------------------------------------------------------------------------
// Row shapes. Every list below is a table of heterogeneous fixed-length rows,
// not a list of values, and inference does not keep that straight: a
// `[string, string, RegExp]` row widens to `(string | RegExp)[]`, so a consumer
// that destructures `[id, file, re]` gets the union for all three and cannot
// call `re.test()` without re-narrowing what the row already states. Naming the
// shapes here keeps the contract in the manifest, where the rows are written.
// ---------------------------------------------------------------------------

/** A class frappe must still emit, and the source file that emits it today. */
export type SelectorEntry = readonly [cls: string, file: string];

/**
 * A runtime shape the theme monkey-patches: the id used in the failure
 * message, the frappe file it lives in, and the regex that proves it is still
 * there.
 */
export type PatchTarget = readonly [id: string, file: string, pattern: RegExp];

/** A frappe-side declaration we override, and the file that declares it. */
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
	["dt-cell__content", "frappe/public/js/frappe/views/reports/report_view.js"],
	["dt-filter", "frappe/public/js/frappe/views/reports/report_view.js"],
	["grid-static-col", "frappe/public/js/frappe/form/grid_row.js"],
	["grid-row-check", "frappe/public/js/frappe/form/grid.js"],
	["static-area", "frappe/public/js/frappe/form/grid_row.js"],
	["field-area", "frappe/public/js/frappe/form/grid_row.js"],
	["sortable-handle", "frappe/public/js/frappe/form/grid_row.js"],
	["column-limit-reached", "frappe/public/js/frappe/form/grid_row.js"],
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
	["list-row-col", "frappe/public/js/frappe/list/list_view.js"],
	["list-header-subject", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],

	// list view / data table
	["list-row-head", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-container", "frappe/public/js/frappe/list/list_view.js"],
	["list-row-checkbox", "frappe/public/js/frappe/list/list_view.js"],
	["checkbox-actions", "frappe/public/js/frappe/list/list_view.js"],
	["text-right", "frappe/public/js/frappe/list/list_view.js"],
	// UI Shell header — the utilities js/anatomy/shell/utilities.ts MOVES into
	// <header>. A rename here does not break the header, it silently leaves
	// search / notifications / account behind in the side nav or the landing
	// page navbar.
	["body-sidebar", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the two columns the fixed header is indented past (desk/_ui-shell.scss);
	// a rename here silently drops the header's reserved row on top of them
	["body-sidebar-container", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["main-section", "frappe/www/desk.html"],
	["standard-items-sections", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["dropdown-navbar-user", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["sidebar-user-button", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the account cell's name/email label. The rail must hide it: left visible it
	// takes a grid row of its own and pushes the avatar off the vertical centre.
	["avatar-name-email", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the notification flyout, re-anchored as the header's right panel, and the
	// host the bell toggles `hidden` on
	["dropdown-notifications", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["notifications-list", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["notification-list-header", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["notification-list-body", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the search / bell rows: TypeButton REPLACES the container class with these
	// (sidebar_item.js:414), so they, not .sidebar-item-container, are the shell's
	// handles; the count is the unread badge frappe writes into
	["navbar-search-bar", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	["navbar-modal-search", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	["sidebar-notification", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	["sidebar-notification-count", "frappe/public/js/frappe/ui/sidebar/sidebar.js"],
	["sidebar-items", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["collapse-sidebar-link", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	["sidebar-toggle-btn", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// the landing page's own navbar, which the shell harvests and then removes.
	// .desktop-wrapper is the template root, watched to catch the re-render.
	["desktop-wrapper", "frappe/desk/page/desktop/desktop.html"],
	["desktop-navbar", "frappe/desk/page/desktop/desktop.html"],
	["desktop-search-wrapper", "frappe/desk/page/desktop/desktop.html"],
	["desktop-navbar-modal-search", "frappe/desk/page/desktop/desktop.html"],
	["desktop-search-icon", "frappe/desk/page/desktop/desktop.html"],
	["desktop-keyboard-shortcut", "frappe/desk/page/desktop/desktop.html"],
	["desktop-notifications", "frappe/desk/page/desktop/desktop.html"],
	["desktop-notification-icon", "frappe/desk/page/desktop/desktop.html"],
	["desktop-avatar", "frappe/desk/page/desktop/desktop.html"],
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
	["keyboard-shortcut", "frappe/public/js/frappe/ui/sidebar/sidebar_item.js"],
	// the sidebar editor's mode marker (the nav hides while editing)
	["edit-mode", "frappe/public/js/frappe/ui/sidebar/sidebar.html"],
	// inside the notifications panel, restyled on the g100 layer
	["notifications-category", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	["recent-item", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	["list-footer", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	// frappe's unseen-notification dot, which becomes Carbon's
	["indicator", "frappe/public/js/frappe/ui/notifications/notifications.js"],
	// the avatar frappe.avatar() renders into the account cell
	["avatar-frame", "frappe/public/js/frappe/utils/common.js"],
	["standard-image", "frappe/public/js/frappe/utils/common.js"],
	// frappe's sprite icons in the harvested rows: `frappe.utils.icon()` composes
	// `icon-${size}` and the sidebar templates pass `current-color` as the svg
	// class; both are restyled onto the cell's `color`
	["es-icon", "frappe/public/js/frappe/utils/utils.js"],
	["current-color", "frappe/public/js/frappe/ui/sidebar/sidebar_item.html"],
	["icon-sm", "frappe/public/scss/common/icons.scss"],
	// the theme-switcher preview tiles — the one .navbar left in the desk
	["theme-grid", "frappe/public/js/frappe/ui/theme_switcher.js"],
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
		/frappe\.dom\.freeze\("", "dark grid-form"\)/,
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
		"Sidebar.setup ends in make_sidebar (one hook covers workspace switches)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/setup\(workspace_title\)\s*\{[\s\S]{0,900}?this\.make_sidebar\(\)/,
	],
	[
		"sidebar_setup fires BEFORE the state changes (why the header does not use it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/trigger\("sidebar_setup"[\s\S]{0,120}?this\.sidebar_title = workspace_title/,
	],
	[
		"choose_app_name's app predicate (re-applied for the name prefix and switcher)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/app\.workspaces\.includes\(this\.sidebar_title\)/,
	],
	[
		"frappe.current_app assigned only on a match (why it is not trusted)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/frappe\.current_app = app/,
	],
	[
		"is_route_in_sidebar's current-item rule (mirrored for aria-current)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/clean_path\.startsWith\(clean_href \+ "\/"\)/,
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
		"sidebar toggle button (the hamburger's fallback)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.html",
		/collapse-sidebar-link sidebar-toggle-btn/,
	],
	[
		"add_standard_items runs once (the harvested search/bell keep identity)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/if \(this\.standard_items_setup\) return/,
	],
	[
		"the bell's own toggle reads the SIDEBAR wrapper (why the header re-arms it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/this\.wrapper\.find\("\.dropdown-notifications"\)/,
	],
	[
		"Bootstrap tooltips initialised globally on collapse (why data-toggle is stripped)",
		"frappe/public/js/frappe/ui/sidebar/sidebar.js",
		/\$\('\[data-toggle="tooltip"\]'\)\.tooltip\(/,
	],
	[
		"TypeButton writes item.class onto the container (replaces .sidebar-item-container)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.js",
		/this\.wrapper\.attr\("class", this\.item\.class\)/,
	],
	[
		"Sidebar Item Group click is bound on the wrapper (a delegated .click() reaches it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.js",
		/this\.wrapper\.on\("click"/,
	],
	[
		"section-item container with its nested-container children",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.html",
		/section-item[\s\S]*?class="sidebar-child-item nested-container"/,
	],
	[
		"item-anchor gets href only when frappe computed a path (no href = an action)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_item.html",
		/\{% if \(path\) \{ %\}\s*href="\{\{ path \}\}"/,
	],
	[
		"sidebar editor marks edit mode with data-mode (the nav hides on it)",
		"frappe/public/js/frappe/ui/sidebar/sidebar_editor.js",
		/attr\("data-mode", "edit"\)/,
	],
	[
		"sidebar item labels are translated server-side (copied verbatim)",
		"frappe/boot.py",
		/"label": _\(item\.label\)/,
	],
	["app_data entries carry app_route (the switcher's hrefs)", "frappe/boot.py", /app_route=/],
	[
		'body click router skips href="#" (sub-menu titles preventDefault themselves)',
		"frappe/public/js/frappe/router.js",
		/href === "#"/,
	],
	[
		"NotificationsView resolves the badge via closest(.body-sidebar) (instance patch)",
		"frappe/public/js/frappe/ui/notifications/notifications.js",
		/\.closest\("\.body-sidebar"\)[\s\S]{0,80}?sidebar-notification-count/,
	],
	[
		"notification bell toggles `indicator blue` (becomes Carbon's dot)",
		"frappe/public/js/frappe/ui/notifications/notifications.js",
		/toggleClass\("indicator blue"/,
	],
	[
		"Notifications finds its wrapper globally (survives the move)",
		"frappe/public/js/frappe/ui/notifications/notifications.js",
		/\$\("\.standard-items-sections"\)/,
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
	// the px map behind `col-xs-N` in `.column-limit-reached` mode — the
	// overflow hack CarbonGrid replaces with real horizontal scroll, and the
	// source of the Bootstrap-span -> pixel translation in tables/grid/grid.js
	[".column-limit-reached", "frappe/public/scss/common/grid.scss"],
	// the awesomebar rule pinned to `top: 40px` — an offset measured against
	// frappe's 28px input, which crossed Carbon's 40px field. desk/_modals.scss
	// hides it; if frappe reworks it, that suppression wants revisiting.
	["modal-divider", "frappe/public/scss/desk/navbar.scss"],
	// the notification flyout desk/_ui-shell.scss re-anchors as the header's
	// right panel, and the unread badge it restyles
	[".notifications-list", "frappe/public/scss/desk/notification.scss"],
	[".sidebar-notification-count", "frappe/public/scss/desk/notification.scss"],
	// a `perspective` on .navbar would make it the containing block of a
	// fixed header; it is not an ancestor today, and this notices if it becomes one
	["perspective: 3200px", "frappe/public/scss/desk/notification.scss"],
	// the z-index contract the header's 1030 sits inside
	["z-index: 1020", "frappe/public/scss/desk/sidebar.scss"],
	["z-index: 1019", "frappe/public/scss/desk/main.scss"],
	["z-index: 1030", "frappe/public/scss/desk/menu.scss"],
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
