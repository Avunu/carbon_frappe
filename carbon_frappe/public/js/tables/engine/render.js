// Keyed, incremental DOM renderer for CarbonTable.
//
// WHY NOT A FULL RE-RENDER. The obvious vanilla approach — rebuild <tbody> from
// `table.getRowModel()` on every store change — is wrong here for two reasons
// specific to frappe:
//
//   1. Grid cells contain LIVE frappe controls (`frappe.ui.form.make_control`
//      mounts a Link/Select/Date control with an awesomplete or air-datepicker
//      instance bound to the input). Replacing the cell node destroys the
//      control, drops its handlers, and closes an open dropdown mid-keystroke.
//   2. Report-view cells are edited in place; blowing away the focused cell on
//      the very state change the edit caused loses the caret.
//
// So rows are keyed by `row.id`, cells by `column.id`, nodes are reused across
// renders, and content is written only when it differs. A cell whose columnDef
// returns a Node (the Grid's case) keeps that exact Node forever.
import { attr, el, reconcileOrder, setStyles, toggleClass } from "./dom";
import { CARBON, applyProfile } from "./classes";

/** Marker on nodes we own, so adapters can tell engine DOM from their own. */
const OWNED = "__carbon_table_node";

export default class TableRenderer {
	constructor(host) {
		this.host = host;
		this.rows = new Map(); // rowId -> { tr, cells: Map<colId, {td, content}> }
		this.headerCells = new Map(); // colId -> { th, content }
		this.filterCells = new Map(); // colId -> { td, input }
		this.footCells = new Map(); // colId -> { td, content }
		this.cols = new Map(); // colId -> <col>
		this.mounted = false;
	}

	// ---------------------------------------------------------------- scaffold

	mount(container) {
		const o = this.host.options;
		const p = this.host.profile;

		this.container = container;
		container.classList.add("cf-table", CARBON.container);
		if (o.direction === "rtl") attr(container, "dir", "rtl");
		applyProfile(p, "root", container, { host: this.host });

		this.toolbar = el("section", { className: `cf-table__toolbar ${CARBON.toolbar}` });
		this.scroll = el("div", { className: `cf-table__scroll ${CARBON.content}` });
		applyProfile(p, "scroll", this.scroll, { host: this.host });

		this.table = el("table", { className: `cf-table__table ${CARBON.table}` });
		this.colgroup = el("colgroup");
		this.thead = el("thead", { className: "cf-table__head" });
		this.tbody = el("tbody", { className: "cf-table__body" });
		this.tfoot = el("tfoot", { className: "cf-table__foot" });
		applyProfile(p, "head", this.thead, { host: this.host });
		applyProfile(p, "body", this.tbody, { host: this.host });
		applyProfile(p, "foot", this.tfoot, { host: this.host });

		this.table.appendChild(this.colgroup);
		this.table.appendChild(this.thead);
		this.table.appendChild(this.tbody);
		this.table.appendChild(this.tfoot);
		this.scroll.appendChild(this.table);

		this.empty = el("div", {
			className: "cf-table__empty",
			html: `<span>${o.emptyMessage || ""}</span>`,
		});
		applyProfile(p, "empty", this.empty, { host: this.host });
		this.empty.hidden = true;

		this.footer = el("div", { className: "cf-table__footer" });

		container.appendChild(this.toolbar);
		container.appendChild(this.scroll);
		container.appendChild(this.empty);
		container.appendChild(this.footer);

		// Spacer rows carry the virtualizer's offset. A single colspan'd cell
		// cannot disturb widths because <colgroup> owns them.
		this.spacerTop = el("tr", { className: "cf-table__spacer", children: [el("td")] });
		this.spacerBottom = el("tr", { className: "cf-table__spacer", children: [el("td")] });
		this.spacerTop.hidden = true;
		this.spacerBottom.hidden = true;

		this.mounted = true;
		return this;
	}

	destroy() {
		this.rows.clear();
		this.headerCells.clear();
		this.filterCells.clear();
		this.footCells.clear();
		this.cols.clear();
		if (this.container) {
			this.container.classList.remove("cf-table", CARBON.container);
			this.container.innerHTML = "";
		}
		this.mounted = false;
	}

	// ------------------------------------------------------------------ render

	render() {
		if (!this.mounted) return;
		const leaf = this.host.table.getVisibleLeafColumns();
		this.renderSizeClass();
		this.renderColgroup(leaf);
		this.renderHeader(leaf);
		this.renderFilterRow(leaf);
		this.renderBody(leaf);
		this.renderFoot(leaf);
		this.renderEmptyState();
	}

	renderSizeClass() {
		const cls = this.host.sizeClass;
		if (this._sizeClass === cls) return;
		if (this._sizeClass) this.table.classList.remove(this._sizeClass);
		this.table.classList.add(cls);
		this._sizeClass = cls;
	}

	/**
	 * Column widths live on <colgroup>, not on every cell. One write per column
	 * per resize instead of one per cell is what keeps
	 * `columnResizeMode: 'onChange'` smooth at report-view column counts.
	 */
	renderColgroup(leaf) {
		// A fixed-layout table only honours <colgroup> widths when its own width
		// is definite. Left to `max-content` the browser sizes the table from
		// cell CONTENT and then redistributes the surplus across the columns,
		// which silently discards every width TanStack computed (and desynced
		// the header row from the body, because they redistribute differently).
		// So the table gets an explicit px width — the same thing
		// tanstack-carbon's resizing example does with `getCenterTotalSize()`.
		setStyles(this.table, { width: `${this.host.table.getTotalSize()}px` });

		const desired = [];
		for (const column of leaf) {
			let col = this.cols.get(column.id);
			if (!col) {
				col = el("col");
				col[OWNED] = true;
				this.cols.set(column.id, col);
			}
			setStyles(col, { width: `${column.getSize()}px` });
			desired.push(col);
		}
		this.prune(this.cols, desired, (c) => c);
		reconcileOrder(this.colgroup, desired);
	}

	/** Sticky offsets for pinned columns. v9 pins logically: 'start' / 'end'. */
	applyPinning(node, column) {
		const pinned = column.getIsPinned();
		if (!pinned) {
			setStyles(node, { position: "", insetInlineStart: "", insetInlineEnd: "", zIndex: "" });
			toggleClass(node, "cf-table__cell--pinned", false);
			toggleClass(node, "cf-table__cell--pinned-start", false);
			toggleClass(node, "cf-table__cell--pinned-end", false);
			toggleClass(node, "cf-table__cell--pinned-last", false);
			toggleClass(node, "cf-table__cell--pinned-first", false);
			return;
		}
		// Offsets inline (they are computed per column); LAYERING is left to the
		// stylesheet. An inline z-index here always beat the sheet, so a pinned
		// header cell sat below the ordinary header cells and the scrolling
		// column headers painted over the frozen one.
		setStyles(node, {
			position: "sticky",
			insetInlineStart: pinned === "start" ? `${column.getStart("start")}px` : "",
			insetInlineEnd: pinned === "end" ? `${column.getAfter("end")}px` : "",
			zIndex: "",
		});
		toggleClass(node, "cf-table__cell--pinned", true);
		toggleClass(node, "cf-table__cell--pinned-start", pinned === "start");
		toggleClass(node, "cf-table__cell--pinned-end", pinned === "end");
		// The last start-pinned / first end-pinned column carries the divider
		// shadow, matching tanstack-carbon's sticky-columns example.
		toggleClass(
			node,
			"cf-table__cell--pinned-last",
			pinned === "start" && column.getIsLastColumn("start")
		);
		toggleClass(
			node,
			"cf-table__cell--pinned-first",
			pinned === "end" && column.getIsFirstColumn("end")
		);
	}

	renderHeader(leaf) {
		const o = this.host.options;
		const p = this.host.profile;
		let tr = this._headerRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__header-row" });
			applyProfile(p, "headerRow", tr, { host: this.host });
			this._headerRow = tr;
		}
		// Re-attach rather than assuming it is still mounted. Adapters put their
		// own classes on these rows and may sweep the DOM by class between
		// renders; a detached header row is otherwise invisible and permanent.
		if (tr.parentNode !== this.thead) this.thead.appendChild(tr);

		const groups = this.host.table.getHeaderGroups();
		const headers = groups.length ? groups[groups.length - 1].headers : [];
		const byId = new Map();
		for (const h of headers) byId.set(h.column.id, h);

		const desired = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			const header = byId.get(column.id);
			let entry = this.headerCells.get(column.id);
			if (!entry) {
				const th = el("th", { className: "cf-table__cell cf-table__cell--header" });
				const content = el("div", { className: "cf-table__cell-content" });
				th.appendChild(content);
				th[OWNED] = true;
				entry = { th, content, rendered: undefined, wired: false };
				this.headerCells.set(column.id, entry);
			}
			const { th, content } = entry;
			attr(th, "data-col-id", column.id);
			attr(th, "data-col-index", i);
			attr(th, "scope", "col");

			const align = this.host.columnAlign(column);
			toggleClass(th, "cf-table__cell--right", align === "right");
			toggleClass(th, "cf-table__cell--center", align === "center");

			this.host.renderHeaderContent(entry, header, column, i);
			this.applyPinning(th, column);
			applyProfile(p, "headerCell", th, {
				host: this.host,
				column,
				header,
				content,
				colIndex: i,
			});
			desired.push(th);
		}
		this.prune(this.headerCells, desired, (e) => e.th);
		reconcileOrder(tr, desired);
		if (o.stickyHeader !== false) toggleClass(this.thead, "cf-table__head--sticky", true);
	}

	/** Inline filter row — frappe's `inlineFilters`, rendered as a second <tr>. */
	renderFilterRow(leaf) {
		const show = this.host.options.inlineFilters && this.host.filtersVisible;
		if (!show) {
			if (this._filterRow) this._filterRow.hidden = true;
			return;
		}
		const p = this.host.profile;
		let tr = this._filterRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__filter-row" });
			applyProfile(p, "filterRow", tr, { host: this.host });
			this._filterRow = tr;
		}
		if (tr.parentNode !== this.thead) this.thead.appendChild(tr);
		tr.hidden = false;

		const desired = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			let entry = this.filterCells.get(column.id);
			if (!entry) {
				const td = el("td", { className: "cf-table__cell cf-table__cell--filter" });
				entry = { td, input: null };
				this.filterCells.set(column.id, entry);
				// The Grid supplies its own search inputs: frappe's GridRow
				// search row writes into `grid.filter` and re-runs
				// `grid.get_data()`, with per-fieldtype matching the engine
				// knows nothing about (Sr No, Duration, Barcode, Rating...).
				const supplied = this.host.createFilterCell(entry, column, i);
				if (!supplied) {
					entry.input = el("input", {
						className: "cf-table__filter-input",
						attrs: { type: "text", "data-col-id": column.id },
					});
					td.appendChild(entry.input);
					this.host.wireFilterInput(entry, column);
				}
			}
			attr(entry.td, "data-col-id", column.id);
			attr(entry.td, "data-col-index", i);
			if (entry.input) {
				attr(entry.input, "title", this.host.columnLabel(column));
				entry.input.disabled = this.host.columnFilterable(column) === false;
				if (document.activeElement !== entry.input) {
					const current = column.getFilterValue();
					entry.input.value = current == null ? "" : current;
				}
			}
			this.applyPinning(entry.td, column);
			applyProfile(p, "filterCell", entry.td, { host: this.host, column, colIndex: i });
			desired.push(entry.td);
		}
		this.prune(this.filterCells, desired, (e) => e.td);
		reconcileOrder(tr, desired);
	}

	renderBody(leaf) {
		const p = this.host.profile;
		const slice = this.host.getRenderRows();
		const desired = [];

		if (slice.paddingTop > 0) {
			this.spacerTop.hidden = false;
			setStyles(this.spacerTop.firstChild, { height: `${slice.paddingTop}px` });
			attr(this.spacerTop.firstChild, "colspan", leaf.length);
			desired.push(this.spacerTop);
		} else {
			this.spacerTop.hidden = true;
		}

		const seen = new Set();
		for (const row of slice.rows) {
			seen.add(row.id);
			desired.push(this.renderRow(row, leaf));
			const extra = this.host.renderRowAddendum(row, leaf);
			if (extra) desired.push(extra);
		}

		if (slice.paddingBottom > 0) {
			this.spacerBottom.hidden = false;
			setStyles(this.spacerBottom.firstChild, { height: `${slice.paddingBottom}px` });
			attr(this.spacerBottom.firstChild, "colspan", leaf.length);
			desired.push(this.spacerBottom);
		} else {
			this.spacerBottom.hidden = true;
		}

		// Recycle rows that scrolled out. `releaseRow` lets an adapter keep a
		// row's controls alive (the Grid does) rather than dropping them.
		for (const [id, entry] of this.rows) {
			if (!seen.has(id)) {
				this.host.releaseRow(id, entry);
				entry.tr.remove();
				this.rows.delete(id);
			}
		}
		reconcileOrder(this.tbody, desired);
	}

	renderRow(row, leaf) {
		const p = this.host.profile;
		// An adapter may own the row element. The Grid does: its GridRow builds
		// the <tr> so that `grid_row.wrapper` / `.row` are the very nodes frappe
		// and third-party code already hold references to, and so the live
		// controls mounted in its cells are never re-created.
		const supplied = this.host.createRowNode(row);
		let entry = this.rows.get(row.id);

		// The adapter may also REPLACE the element for a row id it has already
		// rendered — `grid.reset_grid()` (which Configure Columns triggers)
		// discards every GridRow and builds new ones for the same docnames.
		// Keeping the cached node then leaves the visible <tr> orphaned from the
		// GridRow that owns it: `grid_row.wrapper` is detached, so row indices,
		// `grid-row-open`, the checkbox delegation in `setup_check` and every
		// `.grid-row[data-name]` lookup silently address a node nobody can see.
		if (entry && supplied && entry.tr !== supplied) {
			this.host.releaseRow(row.id, entry);
			entry.tr.remove();
			this.rows.delete(row.id);
			entry = null;
		}

		if (!entry) {
			const tr = supplied || el("tr", { className: "cf-table__row" });
			if (supplied) tr.classList.add("cf-table__row");
			else tr[OWNED] = true;
			entry = { tr, cells: new Map(), adapterOwned: !!supplied };
			this.rows.set(row.id, entry);
			this.host.adoptRow(row, entry);
		}
		const { tr } = entry;
		attr(tr, "data-row-id", row.id);
		attr(tr, "data-row-index", row.index);
		attr(tr, "data-depth", row.depth || 0);
		toggleClass(tr, CARBON.selectedRow, !!(row.getIsSelected && row.getIsSelected()));
		toggleClass(tr, "cf-table__row--expanded", !!(row.getIsExpanded && row.getIsExpanded()));

		const desired = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			let cell = entry.cells.get(column.id);
			if (!cell) {
				// Same seam for cells. A Grid cell IS the `$col` element frappe's
				// GridRow created, carrying its `.static-area` / `.field-area`
				// pair, its `data-fieldname` / `data-fieldtype` (which
				// desk/_numerics.scss selects on) and its mounted control. The
				// engine positions it; it never rebuilds it.
				const supplied = this.host.createCellNode(row, column, i);
				if (supplied) {
					supplied.classList.add("cf-table__cell");
					cell = { td: supplied, content: supplied, rendered: undefined, adapterOwned: true };
				} else {
					const td = el("td", { className: "cf-table__cell" });
					const content = el("div", { className: "cf-table__cell-content" });
					td.appendChild(content);
					td[OWNED] = true;
					cell = { td, content, rendered: undefined };
				}
				entry.cells.set(column.id, cell);
			}
			attr(cell.td, "data-col-id", column.id);
			attr(cell.td, "data-col-index", i);
			attr(cell.td, "data-row-index", row.index);

			const align = this.host.columnAlign(column);
			toggleClass(cell.td, "cf-table__cell--right", align === "right");
			toggleClass(cell.td, "cf-table__cell--center", align === "center");

			if (!cell.adapterOwned) this.host.renderCellContent(cell, row, column, i);
			this.applyPinning(cell.td, column);
			applyProfile(p, "cell", cell.td, {
				host: this.host,
				row,
				column,
				colIndex: i,
				content: cell.content,
			});
			desired.push(cell.td);
		}
		this.prune(entry.cells, desired, (c) => c.td);
		reconcileOrder(tr, desired);
		applyProfile(p, "row", tr, { host: this.host, row });
		return tr;
	}

	renderFoot(leaf) {
		const p = this.host.profile;
		if (!this.host.options.showTotalRow) {
			if (this._footRow) this._footRow.hidden = true;
			return;
		}
		let tr = this._footRow;
		if (!tr) {
			tr = el("tr", { className: "cf-table__total-row" });
			applyProfile(p, "totalRow", tr, { host: this.host });
			this._footRow = tr;
		}
		if (tr.parentNode !== this.tfoot) this.tfoot.appendChild(tr);
		tr.hidden = false;

		const desired = [];
		for (let i = 0; i < leaf.length; i++) {
			const column = leaf[i];
			let entry = this.footCells.get(column.id);
			if (!entry) {
				const td = el("td", { className: "cf-table__cell cf-table__cell--total" });
				const content = el("div", { className: "cf-table__cell-content" });
				td.appendChild(content);
				entry = { td, content, rendered: undefined };
				this.footCells.set(column.id, entry);
			}
			attr(entry.td, "data-col-id", column.id);
			attr(entry.td, "data-col-index", i);
			const align = this.host.columnAlign(column);
			toggleClass(entry.td, "cf-table__cell--right", align === "right");
			this.host.renderTotalContent(entry, column, i);
			this.applyPinning(entry.td, column);
			applyProfile(p, "totalCell", entry.td, { host: this.host, column, colIndex: i });
			desired.push(entry.td);
		}
		this.prune(this.footCells, desired, (e) => e.td);
		reconcileOrder(tr, desired);
	}

	renderEmptyState() {
		const empty = this.host.table.getRowModel().rows.length === 0;
		this.empty.hidden = !empty;
		toggleClass(this.scroll, "cf-table__scroll--empty", empty);
	}

	/** Drop map entries whose node is no longer wanted. */
	prune(map, desired, pick) {
		for (const [key, entry] of map) {
			const node = pick(entry);
			if (desired.indexOf(node) === -1) {
				node.remove();
				map.delete(key);
			}
		}
	}

	// ------------------------------------------------------------------ lookup

	getRowNode(rowId) {
		const entry = this.rows.get(String(rowId));
		return entry ? entry.tr : null;
	}

	getCellNode(rowId, colId) {
		const entry = this.rows.get(String(rowId));
		if (!entry) return null;
		const cell = entry.cells.get(String(colId));
		return cell ? cell.td : null;
	}

	getHeaderNode(colId) {
		const entry = this.headerCells.get(String(colId));
		return entry ? entry.th : null;
	}
}
