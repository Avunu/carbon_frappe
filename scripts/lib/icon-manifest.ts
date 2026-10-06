/**
 * The one list of Carbon glyphs this theme owns.
 *
 * Frappe v16 keeps removing icon systems from the desk — octicons (#39836),
 * FontAwesome (#40571) — and a theme that re-imports whatever frappe happens to
 * ship inherits every one of those removals as a build break or, worse, as icons
 * that silently stop rendering. So the icons this theme draws, and the legacy
 * icon-font classes it keeps alive for other apps, come from @carbon/icons and
 * are named here, in one place:
 *
 *   scripts/generate-icons.ts reads this file and emits
 *     - public/js/generated/shell-icons.ts   SHELL_GLYPHS, for the UI Shell header
 *     - public/js/generated/icons.ts         CHROME_GLYPHS, for table/page chrome
 *     - public/scss/generated/_legacy-icons.scss   LEGACY_GLYPHS, as `.fa-*` /
 *       `.octicon-*` classes backed by a CSS mask
 *   scripts/audit-tokens.ts reads it to prove every emitter in the installed
 *   apps is either bridged or deliberately not (LEGACY_UNMAPPED), so a new
 *   `fa-foo` in an app, or a Carbon rename, fails `yarn audit:drift` instead of
 *   rendering as a blank box in production.
 *
 * Nothing from @carbon/icons ships at runtime; the generated output is committed.
 */

/** A glyph inlined as an `<svg>` string into a generated TypeScript module. */
export interface GlyphSpec {
	/** The export's name in the generated module. */
	exportName: string;
	/** `@carbon/icons` icon name, e.g. `chevron--down`. */
	icon: string;
	/** `@carbon/icons` size variant; 2691 of its icons only have 32px art, which `16` scales. */
	size: 16 | 20 | 24 | 32;
	/** Extra `<svg>` attributes, merged after Carbon's own so `class` survives. */
	attrs?: Record<string, string>;
	/** What the theme uses it for — becomes the doc comment. */
	role: string;
}

export const SHELL_GLYPHS: readonly GlyphSpec[] = [
	{ exportName: "menu20", icon: "menu", size: 20, role: "the hamburger (HeaderMenuButton)" },
	{
		exportName: "close20",
		icon: "close",
		size: 20,
		role: "HeaderMenuButton's active-state glyph; kept so the swap is one line if the header ever hosts a dismissable overlay",
	},
	{
		exportName: "switcher20",
		icon: "switcher",
		size: 20,
		role: "the app switcher action (HeaderGlobalAction)",
	},
	{
		exportName: "aiLaunch20",
		icon: "ai-launch",
		size: 20,
		role: "the AI assistant action (HeaderGlobalAction)",
	},
	{
		exportName: "errorFilled20",
		icon: "error--filled",
		size: 20,
		// InlineNotification's NotificationIcon (Notification.tsx): the assistant's
		// load-failure message renders before any Carbon component can.
		attrs: { class: "cds--inline-notification__icon" },
		role: "the error inline notification's status icon, pre-classed `cds--inline-notification__icon`",
	},
	{
		exportName: "chevronDown16",
		icon: "chevron--down",
		size: 16,
		// HeaderMenu.tsx renders <ChevronDown className="cds--header__menu-arrow" />;
		// header/_header.scss rotates and tints it through that class.
		attrs: { class: "cds--header__menu-arrow" },
		role: "the sub-menu chevron (HeaderMenu), pre-classed `cds--header__menu-arrow`",
	},
	{
		exportName: "chevronDown16Switcher",
		icon: "chevron--down",
		size: 16,
		// The switcher's expandable rows (shell/switcher.ts) rotate it through
		// their own class; header/_header.scss's rules must not reach it.
		attrs: { class: "cf-switcher__arrow" },
		role: "the expandable-row chevron in the switcher panel, pre-classed `cf-switcher__arrow`",
	},
];

/**
 * Table and page chrome. These used to come from frappe's sprite sheets through
 * `frappe.utils.icon`, which meant two things: they were frappe's drawing, not
 * Carbon's, and they were painted by STROKE under `.icon`'s `stroke-width: 1.5px`
 * rule, so the theme carried per-glyph workarounds (the download glyph rendered
 * as a solid dot) and an inline fallback table for the dev harness. Carbon's own
 * glyphs paint by fill and need none of it.
 */
export const CHROME_GLYPHS: readonly GlyphSpec[] = [
	{
		exportName: "arrowUp16",
		icon: "arrow--up",
		size: 16,
		attrs: { class: "cf-table__sort-glyph" },
		role: "the column header's ascending-sort glyph",
	},
	{
		exportName: "arrowDown16",
		icon: "arrow--down",
		size: 16,
		attrs: { class: "cf-table__sort-glyph" },
		role: "the column header's descending-sort glyph",
	},
	{
		exportName: "arrowsVertical16",
		icon: "arrows--vertical",
		size: 16,
		attrs: { class: "cf-table__sort-glyph" },
		role: "the column header's unsorted glyph (Carbon's `table-sort__icon-unsorted`)",
	},
	{
		exportName: "search16",
		icon: "search",
		size: 16,
		attrs: { class: "cds--toolbar-action__icon" },
		role: "the grid toolbar's search action, pre-classed `cds--toolbar-action__icon`",
	},
	{
		exportName: "download16",
		icon: "download",
		size: 16,
		attrs: { class: "cds--toolbar-action__icon" },
		role: "the grid toolbar's Download action, pre-classed `cds--toolbar-action__icon`",
	},
	{
		exportName: "upload16",
		icon: "upload",
		size: 16,
		attrs: { class: "cds--toolbar-action__icon" },
		role: "the grid toolbar's Upload action, pre-classed `cds--toolbar-action__icon`",
	},
	{
		exportName: "chevronRight16",
		icon: "chevron--right",
		size: 16,
		// Must equal CARBON.expandSvg in js/tables/engine/classes.ts; the unit test
		// (test/unit/icon-manifest.test.ts) fails if the two drift apart.
		attrs: { class: "cds--table-expand__svg" },
		role: "the row-expand chevron (Carbon's `table-expand__svg`)",
	},
	{
		exportName: "edit16",
		icon: "edit",
		size: 16,
		role: "the page title's edit affordance (Carbon's Editable text)",
	},
];

/** Which icon font a legacy class came from. */
export type LegacyFamily = "fa" | "octicon";

/**
 * A legacy icon-font class that installed apps still emit and frappe no longer
 * styles: `<i class="fa fa-lock">` renders as nothing at all on stock v16.50.
 * The class is `.${family}-${name}`; `icon` is the Carbon glyph drawn for it.
 */
export interface LegacyGlyph {
	family: LegacyFamily;
	/** The class suffix, e.g. `lock` for `.fa-lock`. */
	name: string;
	/** `@carbon/icons` icon name (16px). */
	icon: string;
	/** Who emits it, so the next person can tell a live mapping from a dead one. */
	emitters: string;
}

export const LEGACY_GLYPHS: readonly LegacyGlyph[] = [
	{
		family: "fa",
		name: "lock",
		icon: "locked",
		emitters: "frappe: core/doctype/file/file.py, utils/file_manager.py (private-file link)",
	},
	{
		family: "fa",
		name: "spinner",
		icon: "circle-dash",
		emitters: "frappe: file_uploader/FileUploader.vue (upload button), with fa-spin",
	},
	{
		family: "fa",
		name: "level-down",
		icon: "arrow--down-right",
		emitters: "hrms: templates/node_card.html; print_designer: Barcode/Dynamic preview modals",
	},
	{
		family: "fa",
		name: "check-circle",
		icon: "checkmark--filled",
		emitters: "print_designer: AppBarcodeModal, AppImageModal",
	},
	{ family: "fa", name: "code", icon: "code", emitters: "print_designer: preview modals (jinja-toggle)" },
	{ family: "fa", name: "tag", icon: "tag", emitters: "print_designer: AppDynamicPreviewModal" },
	{
		family: "fa",
		name: "angle-double-right",
		icon: "double-chevron--right",
		emitters: "print_designer: AppDynamicPreviewModal",
	},
	{
		family: "fa",
		name: "trash",
		icon: "trash-can",
		emitters: "print_designer: AppDynamicPreviewModal",
	},
	{ family: "fa", name: "font", icon: "text--font", emitters: "print_designer: AppLayer, LayersPanel" },
	{ family: "fa", name: "image", icon: "image", emitters: "print_designer: AppLayer, LayersPanel" },
	{ family: "fa", name: "table", icon: "table", emitters: "print_designer: AppLayer, LayersPanel" },
	{
		family: "fa",
		name: "square-o",
		icon: "square--outline",
		emitters: "print_designer: AppLayer, LayersPanel",
	},
	{ family: "fa", name: "columns", icon: "column", emitters: "print_designer: AppTableContextMenu" },
	{ family: "fa", name: "file-o", icon: "document", emitters: "print_designer: LayersPanel" },
	{
		family: "octicon",
		name: "file-directory",
		icon: "folder",
		emitters: "helpdesk, wiki: hooks.py app_icon, config/desktop.py",
	},
];

/**
 * Legacy class names found in the installed apps that are deliberately NOT
 * bridged, each with the reason. `audit-tokens.ts` fails on any emitter that is
 * in neither this table nor LEGACY_GLYPHS, so a new one is a decision, not an
 * accident. Reasons were checked against frappe v16.50.0's source.
 */
export const LEGACY_UNMAPPED: Readonly<Record<string, string>> = {
	"fa-windows": "Social Login Key provider icon: website login page only; a brand mark",
	"fa-github": "Social Login Key provider icon: website login page only; a brand mark",
	"fa-google": "Social Login Key provider icon: website login page only; a brand mark",
	"fa-facebook": "Social Login Key provider icon: website login page only; a brand mark",
	"fa-cloud": "Social Login Key provider icon: website login page only",
	"fa-key": "Social Login Key provider icon: website login page only",
	"fa-user": "webshop: shopping_cart.js renders on website pages, which this desk bundle never reaches",
	"fa-close": "webshop: product_page.js renders on website pages, which this desk bundle never reaches",
	"fa-check": "webshop: product_page.js renders on website pages, which this desk bundle never reaches",
	"fa-th": "hooks.py `app_icon`: no consumer in frappe v16.50 (desk icons come from Desktop Icon records)",
	"fa-star": "erpnext config/projects.py module config: no consumer in frappe v16.50",
	"fa-list": "erpnext config/projects.py module config: no consumer in frappe v16.50",
	"fa-cube": "print_designer MainStore.js: inside a comment",
	"fa-sort": "frappe's report.scss styles a `.fa-sort` that nothing emits",
	"fa-fw": "a modifier, implemented by the generated stylesheet itself",
	"fa-fixed-width": "a webshop typo for fa-fw, implemented by the generated stylesheet itself",
	"fa-spin": "a modifier, implemented by the generated stylesheet itself",
	"octicon-plus": "frappe's kanban.scss styles an `.octicon-plus` that nothing emits",
};
