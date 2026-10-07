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
// row virtualization, instead of a stack of flex divs.
//
// What reaches `render_list()` (v16.50.0): `ListView` itself, `InboxView` (its
// `render()` calls it, inbox_view.js:92-95) and `FileView` in list mode
// (`super.render()`, file_view.js:242-261). ReportView, Image, Map, Calendar,
// Gantt and Dashboard override `render()` and never get there; Kanban overrides
// `render_list()` itself. FileView is the one that matters: it has NO column
// model (`setup_view` never runs `setup_columns`, file_view.js:15-23) and
// renders its own rows through `get_left_html()`, so every patch below hands it
// back to frappe's original.
import { safePatch } from "../../anatomy/patch.ts";
import CarbonTable, { isColumnResize } from "../engine/table.ts";
import { listProfile } from "./classes.ts";
import { MAX_WIDTH, MIN_WIDTH, clampWidth, estimateWidth, metaWidth } from "../widths.ts";
import type { CarbonColumnSpec } from "../engine/table.ts";
import type { FrappeListDoc, ListColumn, ListView } from "frappe-types";

// `carbon_table` is this app's, not frappe's, so it is merged onto frappe-types'
// `ListView` rather than declared here — that is what the empty
// `export interface ListView<TColumn = ListColumn> {}` in the typeset's
// views.d.ts exists for, and it is what keeps `this.carbon_table` a real
// property on the instance the patches below run against.
//
// The specifier is the package ROOT, not the `frappe-types/views` its own doc
// comment suggests: the package's `exports` map publishes only `.`, `./global`,
// `./modules` and `./deep-modules`, so `"frappe-types/views"` does not resolve
// and the augmentation is TS2664. Augmenting the root reaches the same
// declaration through its `export { ListView } from "./views"`.
declare module "frappe-types" {
	interface ListView<TColumn = ListColumn> {
		/**
		 * The engine instance backing this view, created on the first
		 * `render_list()` and reused (`setColumns`/`setData`/`render`) after.
		 */
		carbon_table?: CarbonTable<FrappeListDoc>;
	}
}

/** How many rows `estimateWidth` reads. Enough to see the long values, cheap enough to run on every render. */
const SAMPLE_ROWS = 25;

/** Stable engine column id for a frappe list column descriptor. */
function columnId(col: ListColumn, index: number): string {
	const fieldname = col.df && col.df.fieldname;
	return fieldname ? `${col.type}:${fieldname}` : `${col.type}:${index}`;
}

/**
 * The key frappe files a column's width under: `status_field` for the Status
 * column, the docfield name for the rest (list_view.js:1410, 1282), and none
 * for Tag, which has no width of its own to persist.
 */
function widthKey(col: ListColumn): string | undefined {
	if (col.type === "Status") return "status_field";
	if (col.type === "Tag") return undefined;
	return col.df.fieldname || undefined;
}

/** The header label frappe renders for a column (`get_header_html`, list_view.js:1252-1280). */
function headerLabel(col: ListColumn): string {
	if (col.type === "Subject") return __(col.df.label || col.df.fieldname);
	return __((col.df && col.df.label) || col.type, null, col.df && col.df.parent);
}

/** The header cell markup frappe emits, so `[data-sort-by]` keeps working. */
function headerHtml(col: ListColumn): string {
	const label = headerLabel(col);
	if (col.type === "Subject") {
		const df = col.df;
		return `
			<span class="level-item select-like">
				<input class="list-header-checkbox list-check-all" type="checkbox" title="${__("Select All")}">
			</span>
			<span class="level-item" data-sort-by="${df.fieldname}"
				title="${__("Click to sort by {0}", [df.label])}">${label}</span>`;
	}
	// A Status column that carries a saved width has a `df` of `{ fieldname:
	// "status_field", width }` (list_view.js:653-655, 694-695). frappe's own
	// header then wires `data-sort-by="status_field"` to a field that does not
	// exist (list_view.js:1275-1280); the page's sort selector would be handed
	// it. The column has never been sortable, so it is not wired here.
	const fieldname = col.type === "Status" ? undefined : col.df && col.df.fieldname;
	if (!fieldname) return `<span>${label}</span>`;
	return `<span data-sort-by="${fieldname}" title="${__("Click to sort by {0}", [label])}">${label}</span>`;
}

/**
 * What a list view remembers between renders about the widths of its columns.
 *
 * Keyed by the `columns` array itself: `setup_columns()` (a saved layout, the
 * settings dialog, a tag toggle) always builds a new one, which is the signal
 * that everything below is stale.
 */
interface ListSizing {
	columns: readonly ListColumn[];
	/** The widest estimate seen per engine column id, so paging does not make columns jump. */
	estimated: Map<string, number>;
	/** engine column id -> frappe column, for the resize handler. */
	byId: Map<string, ListColumn>;
}

const sizings = new WeakMap<ListView, ListSizing>();

function sizingFor(listview: ListView): ListSizing {
	const existing = sizings.get(listview);
	if (existing && existing.columns === listview.columns) return existing;
	// A new column model: widths the user dragged under the old one live in the
	// engine's column-sizing state, keyed by column id, and would otherwise
	// override whatever the new layout says for a column with the same id.
	if (existing && listview.carbon_table) listview.carbon_table.table.setColumnSizing({});
	const fresh: ListSizing = { columns: listview.columns, estimated: new Map(), byId: new Map() };
	sizings.set(listview, fresh);
	return fresh;
}

/** A width somebody chose: a saved layout or settings `fields` JSON (`df.width`), or a header drag. */
function explicitWidth(col: ListColumn): number {
	const saved = cint(col.df && col.df.width);
	return saved > 0 ? clampWidth(saved) : 0;
}

/** The rendered HTML of a column's cells for the first rows, which is what the estimate reads. */
function sampleCells(listview: ListView, render: (doc: FrappeListDoc) => string): string[] {
	const cells: string[] = [];
	for (const doc of listview.data.slice(0, SAMPLE_ROWS)) {
		try {
			cells.push(render(doc));
		} catch {
			/* a formatter that needs a full render simply does not contribute */
		}
	}
	return cells;
}

/**
 * A column's pixel width.
 *
 * v16.50.0 sizes a list column only when a width was chosen (`df.width`) and
 * leaves the rest to CSS flex, which shares the free space out by itself
 * (list_view.js:1408-1415, 1559-1563; the v16.36.1 text-length estimator is
 * gone). A <table> cannot do that, so an unsized column gets
 * {@link estimateWidth} instead.
 */
function columnWidth(
	listview: ListView,
	sizing: ListSizing,
	id: string,
	col: ListColumn,
	render: (doc: FrappeListDoc) => string,
): number {
	const explicit = explicitWidth(col);
	if (explicit) return explicit;
	const label = col.type === "Tag" ? "" : headerLabel(col);
	const wanted = estimateWidth({ label, subject: col.type === "Subject" }, sampleCells(listview, render));
	const seen = Math.max(sizing.estimated.get(id) ?? 0, wanted);
	sizing.estimated.set(id, seen);
	return seen;
}

function buildColumns(listview: ListView, assignCount: number): CarbonColumnSpec<FrappeListDoc>[] {
	const sizing = sizingFor(listview);
	sizing.byId.clear();

	const columns: CarbonColumnSpec<FrappeListDoc>[] = listview.columns.map((col, i) => {
		const id = columnId(col, i);
		sizing.byId.set(id, col);
		const render = (doc: FrappeListDoc): string => listview.get_column_html(col, doc, false);
		// Tag has no resize handle in frappe's header (list_view.js:1283-1286), so
		// it has none here; every other column is bounded by frappe's own 50..400.
		const resizable = col.type !== "Tag";
		const spec: CarbonColumnSpec<FrappeListDoc> = {
			id,
			label: (col.df && col.df.label) || col.type,
			size: columnWidth(listview, sizing, id, col, render),
			minSize: col.type === "Tag" ? 40 : MIN_WIDTH,
			maxSize: MAX_WIDTH,
			resizable,
			align: frappe.model.is_numeric_field(col.df) ? "right" : "left",
			sortable: false, // sorting is the page's sort selector, via [data-sort-by]
			filterable: false,
			hidden: col.type === "Tag" && !listview.tags_shown,
			meta: { listCol: col },
			header: () => headerHtml(col),
			cell: (ctx) => render(ctx.row.original),
		};
		if (col.type === "Subject") spec.pinned = "start";
		return spec;
	});

	if (listview.settings.button) {
		const render = (doc: FrappeListDoc): string => listview.generate_button_html(doc);
		columns.push({
			id: "_button",
			label: "",
			size: estimateWidth({ label: "" }, sampleCells(listview, render)),
			resizable: false,
			sortable: false,
			filterable: false,
			header: () => "",
			cell: (ctx) => render(ctx.row.original),
		});
	}
	if (listview.settings.dropdown_button) {
		const render = (doc: FrappeListDoc): string => listview.generate_dropdown_html(doc);
		columns.push({
			id: "_dropdown_button",
			label: "",
			size: estimateWidth({ label: "" }, sampleCells(listview, render)),
			resizable: false,
			sortable: false,
			filterable: false,
			header: () => "",
			cell: (ctx) => render(ctx.row.original),
		});
	}

	// The right-hand meta rail: assignment avatars, comment count, like, and
	// "modified" — `get_meta_html` unchanged.
	columns.push({
		id: "_meta",
		label: "",
		size: metaWidth(assignCount),
		pinned: "end",
		resizable: false,
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

/**
 * Pinning and visibility, re-asserted on a view that already has an engine.
 *
 * The engine builds both from the `columns` it is constructed with and never
 * revisits them (engine/table.ts `initialState`), so a saved layout whose
 * Subject column has a different id — or the tag toggle in the settings dialog
 * — would leave the engine pinning a column that is gone and the Tag column in
 * whatever state it started in. Written only when it differs, so a render that
 * changes nothing does not queue a second one.
 */
function syncColumnState(
	table: CarbonTable<FrappeListDoc>,
	specs: readonly CarbonColumnSpec<FrappeListDoc>[],
): void {
	const start: string[] = [];
	const end: string[] = [];
	const visibility: Record<string, boolean> = {};
	for (const spec of specs) {
		if (spec.pinned === "start") start.push(spec.id);
		else if (spec.pinned === "end") end.push(spec.id);
		if (spec.hidden) visibility[spec.id] = false;
	}
	const pinning = table.state.columnPinning;
	const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
		!!a && a.length === b.length && a.every((id, i) => id === b[i]);
	if (!sameList(pinning && pinning.start, start) || !sameList(pinning && pinning.end, end)) {
		table.table.setColumnPinning({ start, end });
	}
	const shown = table.state.columnVisibility;
	const hidden = Object.keys(visibility).sort().join("|");
	const current = Object.keys(shown || {})
		.filter((id) => shown && shown[id] === false)
		.sort()
		.join("|");
	if (hidden !== current) table.table.setColumnVisibility(visibility);
}

/**
 * Write the engine's real column widths into `column_max_widths`.
 *
 * That map is what the saved-layout code reads to persist widths
 * (`get_current_columns_state`, list_filter_menu.js:362-387) and what the layout
 * field picker shows (layout_field_selector.js:48). frappe fills it from the
 * rendered header (`capture_column_widths_from_dom`, list_view.js:1087-1109);
 * this view has no such header, so the engine's own sizes stand in.
 */
function recordWidths(listview: ListView, table: CarbonTable<FrappeListDoc>, sizing: ListSizing): void {
	for (const [id, col] of sizing.byId) {
		const key = widthKey(col);
		const px = table.getColumnSize(id);
		if (key && px) listview.column_max_widths[key] = Math.round(px);
	}
}

/**
 * Persist a header drag the way frappe's own handle does
 * (`setup_column_resize`, list_view.js:862-917): remember it in
 * `column_max_widths`, then `save_column_width`, which writes the saved layout
 * or List View Settings. The column's own `df.width` is updated too, because
 * `get_column_html` raises `column_max_widths` back to `df.width` on every call
 * (list_view.js:1559-1563) and an older, wider saved value would otherwise win
 * on the next render. `df` is replaced with a copy: the default column model
 * hands out the doctype meta's own docfields.
 */
function persistResize(listview: ListView, payload: unknown): void {
	if (!isColumnResize(payload)) return;
	const sizing = sizings.get(listview);
	const col = sizing && sizing.byId.get(payload.columnId);
	if (!col || col.type === "Tag") return;
	const key = widthKey(col);
	if (!key) return;
	const width = Math.round(clampWidth(payload.width));
	col.df = { fieldname: key, ...col.df, width };
	listview.column_max_widths[key] = width;
	listview.save_column_width(key, width);
}

/**
 * Re-tick the row checkboxes the engine has just written.
 *
 * Selection lives in `checked_docnames` since v16.50.0 and a checkbox is only
 * its mirror (list_view.js:1180-1192). With virtualization the engine recycles
 * `<tr>`s as the window moves, and a recycled row's cell is rewritten with a
 * fresh, unticked `<input>`, so the mirror has to be repainted after every
 * render — frappe does the same from `finalize_virtual_rows`
 * (list_view_virtualization.js:287-290). Only the DOM is touched: going through
 * `set_rows_as_checked()` here would also run `on_row_checked()`, which asks the
 * server for workflow actions on every scroll frame.
 */
function repaintChecks(listview: ListView): void {
	const table = listview.carbon_table;
	if (!table || !table.virtualizer.enabled || !listview.checked_docnames.size) return;
	listview.$result.find(".list-row-checkbox").each((_i, el) => {
		const box = $(el);
		const want = listview.checked_docnames.has(listview.get_checkbox_docname(box));
		if (box.prop("checked") !== want) box.prop("checked", want);
	});
}

export default function installListView(): void {
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
		// The `X && X.prototype` spelling, rather than the bare
		// `frappe.views.ListView.prototype` this used to be: `getOwner` is a
		// closure, so the guard four lines up does not narrow inside it, and
		// `frappe.views.ListView` really is optional (frappe grows
		// `frappe.views` lazily, one route bundle at a time). A short-circuit
		// yields `undefined`, which is one of the "no owner" results safePatch
		// already handles.
		() => frappe.views.ListView && frappe.views.ListView.prototype,
		"render_header",
		(orig) =>
			function (this: ListView, refresh_header?: boolean) {
				// FileView (see the header of this file) has its own header markup.
				if (!this.columns) {
					orig.call(this, refresh_header);
					return;
				}
				// `refresh_header` is ignored on purpose: frappe uses it to drop and
				// rebuild `.list-row-head` when the columns change, and this header
				// is the engine's <thead>, which `setColumns` already rebuilds. What
				// is left is the bulk-action overlay, and it never changes.
				if (this.$result.find("header.list-row-head").length === 0) {
					this.$result.prepend(`
						<div class="list-carbon-header">
							<header class="level list-row-head text-muted">
								<div class="level-left checkbox-actions" style="display:none">
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
		"frappe.views.ListView.prototype.render_header (Carbon batch-actions overlay)",
	);

	safePatch(
		() => frappe.views.ListView && frappe.views.ListView.prototype,
		"render_list",
		(orig) =>
			function (this: ListView) {
				// FileView in list mode: frappe's own rows, see the header of this file.
				if (!this.columns) {
					orig.call(this);
					return;
				}

				// frappe's contract for this method (list_view.js:1003-1084), which
				// the callers rely on: `render()` (:999) and the realtime path
				// (`process_document_refreshes`, :2403) both call it directly.
				//
				// 1. Prune the selection against the NEW data first (:1031). The
				//    selection is the `checked_docnames` Set, not the DOM, so after
				//    a filter or a page change it would otherwise keep names that are
				//    no longer in the list: "N items selected" would count them, and
				//    `get_checked_items(true)` — which bulk delete, export and every
				//    other bulk action read — would return documents the user cannot
				//    see.
				const selectedBefore = this.checked_docnames.size;
				this.prune_checked_docnames();

				// 2. Clear the rows. frappe's render_list starts by clearing
				//    `.list-row-container`; without it the loading skeleton row
				//    (render_skeleton) stays behind as an empty 48px band above the
				//    table.
				//
				//    `children`, NOT `find`: the engine's own header and body rows
				//    carry `.list-row-container` too (that is the point — app CSS
				//    targets it), so a descendant sweep tore the <thead> row out of
				//    the table on every re-render. The engine appends that row once,
				//    so it never came back and the whole header vanished. frappe's
				//    skeleton rows are direct children of `$result`; the engine's
				//    live inside `.list-carbon-mount`.
				this.$result.children(".list-row-container").remove();
				this.parent.page.main.parent().addClass("list-view");
				// `render_header` is the overlay only; `_pending_initial_header` and
				// `_header_rendered_in_list` (:1038-1044) are frappe's bookkeeping
				// for rebuilding a header this view does not have, and `refresh()`'s
				// fallback (`render_header(true)`, :448-451) lands on the same no-op.
				this.render_header();

				// `doc._idx` is what `generate_button_html` writes into `data-idx`
				// and `setup_action_handler` reads back (:2157-2162).
				this.data.forEach((doc, i) => {
					doc._idx = i;
				});
				const { has_assignto, assign_to_count } = this.get_assignment_stats();

				// frappe virtualizes at `virtualization_threshold` rows (2000, :46),
				// through a lazy bundle that windows its own flex rows
				// (list_view_virtualization.js). The engine windows its own <tr>s,
				// so the gate is frappe's number and the bundle is never used: it is
				// only ever preloaded, by `refresh()` and the page-size buttons
				// (:438-441, :190-200) — one small request, once, that this view
				// does not need. `should_use_virtualization()` itself is not asked,
				// because it goes false the moment that preload fails.
				const virtualize = this.data.length >= this.virtualization_threshold;
				const specs = buildColumns(this, assign_to_count);

				if (!this.carbon_table) {
					const mount = $('<div class="list-carbon-mount"></div>').appendTo(this.$result);
					// `mount.get(0)` is `HTMLElement | undefined` and stays that
					// way: CarbonTable's own constructor takes
					// `string | Element | null | undefined` and throws on a
					// miss, so the nullability is the engine's to reject, not
					// something to assert away here.
					this.carbon_table = new CarbonTable<FrappeListDoc>(mount.get(0), {
						columns: specs,
						data: this.data,
						getRowId: (doc) => doc.name,
						rowHeight: 48,
						profile: listProfile(),
						sortable: false,
						resizable: true,
						inlineFilters: false,
						emptyMessage: "",
						// The engine scrolls INSIDE `.result-container` (desk/
						// _carbon-table.scss gives the list a bounded scroller), so
						// it can window rows. Off below frappe's threshold: a list
						// page is at most 500 rows until the 2500 page size, and a
						// <tr> per row keeps `Ctrl+F` and shift-select simple.
						virtualize,
						events: {
							onColumnResize: (payload) => persistResize(this, payload),
							onRender: () => repaintChecks(this),
						},
						onRowAdopt: (row, entry) => {
							entry.tr.setAttribute("data-name", row.original.name);
							entry.tr.setAttribute("tabindex", "1");
						},
					});
				} else {
					this.carbon_table.options.virtualize = virtualize;
					this.carbon_table.setColumns(specs);
					syncColumnState(this.carbon_table, specs);
					this.carbon_table.setData(this.data);
					this.carbon_table.render();
				}

				// The <thead> stands in for frappe's `.list-header-subject`.
				// Safe to pre-assign (unlike `$checkbox_actions`): nothing reads
				// it before `on_row_checked` runs.
				this.$list_head_subject = $(this.carbon_table.renderer.thead);

				recordWidths(this, this.carbon_table, sizingFor(this));
				this.update_listview_classes(has_assignto, assign_to_count);

				// 3. Restore the selection (:1081-1083). `set_rows_as_checked()`
				//    returns early on an empty Set, so a selection that the prune
				//    above emptied would leave the overlay still reading "N items
				//    selected": repaint it from the (now empty) Set instead.
				if (this.checked_docnames.size) this.set_rows_as_checked();
				else if (selectedBefore) this.on_row_checked();
			},
		"frappe.views.ListView.prototype.render_list (CarbonTable)",
	);

	/**
	 * A realtime update that removes a document filters `this.data` and then calls
	 * this (`process_document_refreshes`, list_view.js:2359-2365), which takes the
	 * row's `.list-row-container` out of the DOM and nothing else. Here that node
	 * is the engine's own `<tr>`, and the engine still holds it: the next render
	 * of any kind (a column drag, the window moving) would put the row back.
	 * Handing the engine the shorter data lets it let go of the row itself.
	 */
	safePatch(
		() => frappe.views.ListView && frappe.views.ListView.prototype,
		"remove_list_items",
		(orig) =>
			function (this: ListView, names: string[]) {
				orig.call(this, names);
				if (this.carbon_table) this.carbon_table.setData(this.data);
			},
		"frappe.views.ListView.prototype.remove_list_items (engine data follows)",
	);

	/**
	 * Widths are the engine's now. frappe's implementation walked every rendered
	 * cell and wrote inline `width`/`flex` onto the flex columns
	 * (list_view.js:1577-1588); that would fight `<colgroup>`.
	 */
	safePatch(
		() => frappe.views.ListView && frappe.views.ListView.prototype,
		"apply_column_widths",
		(orig) =>
			function (this: ListView) {
				if (!this.columns) orig.call(this);
			},
		"frappe.views.ListView.prototype.apply_column_widths (no-op; the engine owns widths)",
	);
}
