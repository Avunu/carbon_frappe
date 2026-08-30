// The List view, rendered by the Carbon table engine.
//
// This is the lightest of the three adapters on purpose. frappe's List view is
// already a data table in everything but markup, and its per-cell rendering is
// where all the third-party extensibility lives:
//
//   settings.formatters[fieldname](value, df, doc)   6 call sites in the bench
//   settings.get_indicator(doc)                      94
//   settings.button / dropdown_button                4
//   frappe.format + the Link/Select/Percent/Image branches
//
// All of that lives in `get_column_html(col, doc)` and `get_meta_html(doc)`,
// which are REUSED VERBATIM as the engine's cell renderers. The adapter only
// replaces the container: a real <table> with TanStack-owned column widths and
// row virtualization, instead of a stack of flex divs sized by
// `apply_column_widths()`'s text-length heuristic.
//
// Subclasses are safe by construction: ReportView, KanbanView, CalendarView,
// GanttView, ImageView, MapView, InboxView and FileView all override `render()`
// and never reach `render_list()`.
import { safePatch } from "../../anatomy/patch";
import CarbonTable from "../engine/table";
import { listProfile } from "./classes";

/** Stable engine column id for a frappe list column descriptor. */
function columnId(col, index) {
	const fieldname = col.df && col.df.fieldname;
	return fieldname ? `${col.type}:${fieldname}` : `${col.type}:${index}`;
}

/** The header cell markup frappe emits, so `[data-sort-by]` keeps working. */
function headerHtml(listview, col) {
	if (col.type === "Subject") {
		const df = col.df;
		return `
			<span class="level-item select-like">
				<input class="list-header-checkbox list-check-all" type="checkbox" title="${__("Select All")}">
			</span>
			<span class="level-item" data-sort-by="${df.fieldname}"
				title="${__("Click to sort by {0}", [df.label])}">${__(df.label)}</span>`;
	}
	const fieldname = col.df && col.df.fieldname;
	const label = __((col.df && col.df.label) || col.type, null, col.df && col.df.parent);
	if (!fieldname) return `<span>${label}</span>`;
	return `<span data-sort-by="${fieldname}" title="${__("Click to sort by {0}", [label])}">${label}</span>`;
}

/**
 * Seed `column_max_widths` using frappe's own heuristic before sizing columns.
 *
 * `get_column_html` accumulates a per-fieldname width estimate as a SIDE EFFECT
 * (list_view.js:1055-1071, roughly `textLength * 10 / 1.3`). frappe could rely on
 * that because it measured while appending; we need the numbers before TanStack
 * builds the column model, so run the estimator over a bounded sample first.
 * Cost is string building only, and it is what makes a Description column come
 * out wider than a Status column on the first paint rather than the second.
 */
function seedColumnWidths(listview) {
	listview.column_max_widths = {};
	const sample = listview.data.slice(0, 25);
	for (const doc of sample) {
		for (const col of listview.columns) {
			try {
				listview.get_column_html(col, doc, false);
			} catch (e) {
				/* a formatter that needs a full render can simply not contribute */
			}
		}
	}
}

function buildColumns(listview) {
	const columns = listview.columns.map((col, i) => ({
		id: columnId(col, i),
		label: (col.df && col.df.label) || col.type,
		size: Math.min(
			Math.max(
				listview.column_max_widths[col.df && col.df.fieldname] ||
					(col.type === "Subject" ? 280 : 160),
				col.type === "Tag" ? 40 : 110
			),
			560
		),
		align: frappe.model.is_numeric_field(col.df) ? "right" : "left",
		sortable: false, // sorting is the page's sort selector, via [data-sort-by]
		filterable: false,
		pinned: col.type === "Subject" ? "start" : undefined,
		hidden: col.type === "Tag" && !listview.tags_shown,
		meta: { listCol: col },
		header: () => headerHtml(listview, col),
		cell: (ctx) => listview.get_column_html(col, ctx.row.original, false),
	}));

	if (listview.settings.button) {
		columns.push({
			id: "_button",
			label: "",
			size: 100,
			sortable: false,
			filterable: false,
			header: () => "",
			cell: (ctx) => listview.generate_button_html(ctx.row.original),
		});
	}
	if (listview.settings.dropdown_button) {
		columns.push({
			id: "_dropdown_button",
			label: "",
			size: 100,
			sortable: false,
			filterable: false,
			header: () => "",
			cell: (ctx) => listview.generate_dropdown_html(ctx.row.original),
		});
	}

	// The right-hand meta rail: assignment avatars, comment count, like, and
	// "modified" — `get_meta_html` unchanged.
	columns.push({
		id: "_meta",
		label: "",
		size: 260,
		pinned: "end",
		sortable: false,
		filterable: false,
		align: "right",
		meta: { listMeta: true },
		header: () =>
			`<span class="list-count"></span>
			 <span class="level-item list-liked-by-me hidden-xs">
				<span title="${__("Liked by me")}">
					<svg class="icon icon-sm like-icon"><use href="#icon-heart"></use></svg>
				</span>
			 </span>`,
		cell: (ctx) => listview.get_meta_html(ctx.row.original),
	});

	return columns;
}

export default function installListView() {
	if (!window.frappe || !frappe.views || !frappe.views.ListView) return;

	/**
	 * Only the bulk-action overlay survives from frappe's header; the aligned
	 * column header is the engine's <thead>.
	 *
	 * `on_row_checked` reads `this.$list_head_subject` and
	 * `this.$checkbox_actions` through `x = x || this.$result.find(...)`, so
	 * pre-assigning both lets that method — and `set_rows_as_checked`,
	 * `clear_checked_items`, `get_checked_items` — run completely unmodified.
	 * Toggling the <thead> off while the overlay is shown is also exactly
	 * Carbon's `cds--batch-actions--active` behaviour.
	 */
	safePatch(
		() => frappe.views.ListView.prototype,
		"render_header",
		() =>
			function () {
				if (this.$result.find("header.list-row-head").length === 0) {
					this.$result.prepend(`
						<div class="list-carbon-header">
							<header class="level list-row-head text-muted">
								<div class="level-left checkbox-actions cds--batch-actions" style="display:none">
									<div class="level list-subject">
										<span class="level-item select-like">
											<input class="list-header-checkbox list-check-all" type="checkbox"
												title="${__("Select All")}">
										</span>
										<span class="level-item list-header-meta"></span>
									</div>
								</div>
							</header>
						</div>`);
				}
				// Deliberately NOT assigning `this.$checkbox_actions` here.
				// `update_checkbox()` uses `if (!this.$checkbox_actions) return`
				// as its guard for `this.$checks` not existing yet, and the
				// click handler calls it before the first `on_row_checked()`.
				// Setting it early turns the first checkbox click into a
				// TypeError on `this.$checks.length`. `on_row_checked` resolves
				// it lazily from the overlay's `<header>` ancestor anyway.
			},
		"frappe.views.ListView.prototype.render_header (Carbon batch-actions overlay)"
	);

	safePatch(
		() => frappe.views.ListView.prototype,
		"render_list",
		() =>
			function () {
				// frappe's render_list starts by clearing `.list-row-container`;
				// without it the loading skeleton row (render_skeleton) stays
				// behind as an empty 48px band above the table.
				//
				// `children`, NOT `find`: the engine's own header and body rows
				// carry `.list-row-container` too (that is the point — app CSS
				// targets it), so a descendant sweep tore the <thead> row out of
				// the table on every re-render. The engine appends that row once,
				// so it never came back and the whole header vanished. frappe's
				// skeleton rows are direct children of `$result`; the engine's
				// live inside `.list-carbon-mount`.
				this.$result.children(".list-row-container").remove();
				this.parent.page.main.parent().addClass("list-view");
				this.render_header();

				// `column_max_widths` is populated as a side effect of
				// `get_column_html`, so it is only meaningful after a pass over
				// the data. Seed it here, then let TanStack own widths.
				seedColumnWidths(this);

				let has_assignto = false;
				let assign_to_count = 0;
				let idx = 0;
				for (const doc of this.data) {
					doc._idx = idx++;
					if (doc._assign) {
						const len = JSON.parse(doc._assign)?.length || 0;
						assign_to_count = Math.max(
							assign_to_count,
							len > this.max_number_of_avatars ? this.max_number_of_avatars : len
						);
						has_assignto = true;
					}
				}

				if (!this.carbon_table) {
					const mount = $('<div class="list-carbon-mount"></div>').appendTo(this.$result);
					this.carbon_table = new CarbonTable(mount.get(0), {
						columns: buildColumns(this),
						data: this.data,
						getRowId: (doc) => doc.name,
						rowHeight: 48,
						profile: listProfile(),
						sortable: false,
						resizable: true,
						inlineFilters: false,
						emptyMessage: "",
						// The list view scrolls the PAGE, not an inner box —
						// that is frappe's behaviour and what `.disable-scrolling`
						// and the paging buttons assume. Row virtualization needs
						// a bounded viewport, so it stays off here; page_length
						// (20/100/500/2500) is the existing bound on row count.
						virtualize: false,
						onRowAdopt: (row, entry) => {
							entry.tr.setAttribute("data-name", row.original.name);
							entry.tr.setAttribute("tabindex", "1");
						},
					});
				} else {
					this.carbon_table.setColumns(buildColumns(this));
					this.carbon_table.setData(this.data);
					this.carbon_table.render();
				}

				// The <thead> stands in for frappe's `.list-header-subject`.
				// Safe to pre-assign (unlike `$checkbox_actions`): nothing reads
				// it before `on_row_checked` runs.
				this.$list_head_subject = $(this.carbon_table.renderer.thead);

				this.update_listview_classes(has_assignto, assign_to_count);
			},
		"frappe.views.ListView.prototype.render_list (CarbonTable)"
	);

	/**
	 * Widths are TanStack's now. frappe's implementation walked every rendered
	 * cell and wrote inline `width`/`flex` onto the flex columns; that would
	 * fight `<colgroup>`.
	 */
	safePatch(
		() => frappe.views.ListView.prototype,
		"apply_column_widths",
		() => function () {},
		"frappe.views.ListView.prototype.apply_column_widths (no-op; TanStack owns widths)"
	);
}
