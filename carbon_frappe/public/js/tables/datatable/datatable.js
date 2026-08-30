// CarbonDataTable — a frappe-datatable-compatible facade over CarbonTable.
//
// This is the drop-in: `window.DataTable` and `frappe.DataTable` are reassigned
// to it, so Report View, Query Report, Data Import preview, the multi-select
// dialog, ERPNext's bank reconciliation and every third-party report script
// construct THIS instead of frappe-datatable, without changing a line.
//
// The compatibility target is not the library's documentation, it is what the
// bench actually calls. Options, methods, sub-managers, the `dt-*` DOM contract
// and the `getEditor` protocol are all reproduced against measured call sites;
// see ./managers.js for the sub-manager surface and ./classes.js for the DOM.
//
// Deliberately NOT reproduced, because they are inert upstream too:
//   `clusterize`        — dead since the switch from clusterize.js to HyperList
//   `dynamicRowHeight`  — read nowhere outside defaults.js
// Both are accepted and ignored so a caller passing them still works.
import CarbonTable from "../engine/table";
import { nearestRowSize } from "../engine/classes";
import { datatableProfile, nextScopeClass } from "./classes";
import CellEditing from "./editing";
import CellNavigation from "./navigation";
import {
	BASE_CELL,
	BodyRendererShim,
	CellManagerShim,
	ColumnManagerShim,
	DataManagerShim,
	KeyboardShim,
	RowManagerShim,
	StyleShim,
	rowIndexOf,
} from "./managers";

function __(str) {
	return typeof window !== "undefined" && typeof window.__ === "function" ? window.__(str) : str;
}

/** frappe-datatable's defaults (datatable/src/defaults.js), verbatim. */
function defaults() {
	return {
		columns: [],
		data: [],
		dropdownButton: null,
		headerDropdown: [],
		events: {},
		hooks: { columnTotal: null },
		sortIndicator: { asc: "↑", desc: "↓", none: "" },
		overrideComponents: {},
		filterRows: null,
		freezeMessage: "",
		getEditor: null,
		serialNoColumn: true,
		serialNoColumnLabel: "",
		checkboxColumn: false,
		clusterize: true,
		logs: false,
		layout: "fixed",
		noDataMessage: __("No Data"),
		cellHeight: 40,
		minimumColumnWidth: 30,
		inlineFilters: false,
		treeView: false,
		checkedRowStatus: true,
		dynamicRowHeight: false,
		pasteFromClipboard: false,
		showTotalRow: false,
		direction: "ltr",
		disableReorderColumn: false,
		language: "en",
		translations: {},
		saveSorting: false,
		sortingKey: null,
	};
}

let INSTANCES = 0;

export default class CarbonDataTable {
	constructor(wrapper, options = {}) {
		const el = typeof wrapper === "string" ? document.querySelector(wrapper) : wrapper;
		if (!el || !(el instanceof HTMLElement)) {
			throw new Error("Invalid argument given for `wrapper`");
		}

		CarbonDataTable.instances = ++INSTANCES;
		const scope = nextScopeClass();
		this.scopeClass = scope.scopeClass;

		this.wrapper = el;
		this.container = el;
		this.options = Object.assign(defaults(), options);
		// `events` and `hooks` are merged, not replaced — a caller passing only
		// `onCheckRow` must not wipe the other five no-ops.
		this.events = Object.assign({}, defaults().events, options.events || {});
		this.options.events = this.events;
		this.options.hooks = Object.assign({ columnTotal: null }, options.hooks || {});

		this.datamanager = new DataManagerShim(this);
		this.rowmanager = new RowManagerShim(this);
		this.columnmanager = new ColumnManagerShim(this);
		this.cellmanager = new CellManagerShim(this);
		this.bodyRenderer = new BodyRendererShim(this);
		this.keyboard = new KeyboardShim(this);
		this.editing = new CellEditing(this);
		this.navigation = new CellNavigation(this);

		this.highlighted = [];
		this.visibleOverride = null;
		this.noData = true;

		this.prepare(this.options.columns, this.options.data);
		this.buildEngine();
		this.style = new StyleShim(this);
		this.editing.bind(this.container);
		this.prepareDom();
		this.navigation.bind(this.container);

		if (this.options.data && this.options.data.length) this.render();
	}

	// -------------------------------------------------------------- normalise

	/**
	 * Column normalisation, following datamanager.prepareColumns /
	 * prepareDefaultColumns. The `_checkbox` and `_rowIndex` columns are
	 * PREPENDED and counted in every colIndex the outside world sees, because
	 * that is what `datamanager.columns` does upstream and what every
	 * `.dt-cell--{colIndex}-{rowIndex}` selector assumes.
	 */
	prepareColumns(columns) {
		const std = [];
		if (this.options.checkboxColumn) {
			std.push({
				id: "_checkbox",
				content: '<input type="checkbox" class="dt-checkbox" />',
				editable: false,
				resizable: false,
				sortable: false,
				focusable: false,
				dropdown: false,
				sticky: true,
				width: 32,
			});
		}
		if (this.options.serialNoColumn) {
			std.push({
				id: "_rowIndex",
				content: this.options.serialNoColumnLabel || "",
				align: "center",
				editable: false,
				resizable: true,
				sortable: false,
				focusable: false,
				dropdown: false,
				sticky: true,
				width: 60,
			});
		}
		this.standardColumnCount = std.length;

		const user = (columns || []).map((col) => {
			const base = typeof col === "string" ? { content: col } : Object.assign({}, col);
			const merged = Object.assign({}, BASE_CELL, base);
			merged.isHeader = 1;
			merged.content = merged.content || merged.name || "";
			merged.id = merged.id || merged.content;
			if (!merged.format) merged.format = undefined;
			return merged;
		});

		this.columns = std.concat(user).map((col, i) => {
			col.colIndex = i;
			return col;
		});
		return this.columns;
	}

	/** Row normalisation, following datamanager.prepareRows / prepareRow. */
	prepareRows(data) {
		const cols = this.columns;
		return (data || []).map((d, index) => {
			const raw = [];
			if (Array.isArray(d)) {
				if (this.options.checkboxColumn) raw.push(this.getCheckboxHTML());
				if (this.options.serialNoColumn) raw.push(String(index + 1));
				for (const cell of d) raw.push(cell);
				while (raw.length < cols.length) raw.push("");
			} else {
				for (const col of cols) {
					if (col.id === "_checkbox") raw.push(this.getCheckboxHTML());
					else if (col.id === "_rowIndex") raw.push(String(index + 1));
					else raw.push(d[col.id]);
				}
			}

			const meta = { rowIndex: index, indent: Array.isArray(d) ? 0 : d.indent || 0 };
			const row = raw.map((content, i) => {
				const cell = { content: "", sortOrder: "none", colIndex: i, column: cols[i] };
				if (content !== null && typeof content === "object") Object.assign(cell, content);
				else cell.content = content;
				if (cell.rowIndex == null) cell.rowIndex = meta.rowIndex;
				if (cell.indent == null) cell.indent = meta.indent;
				return cell;
			});
			row.meta = meta;
			return row;
		});
	}

	getCheckboxHTML() {
		return '<input type="checkbox" class="dt-checkbox" />';
	}

	prepare(columns, data) {
		this.prepareColumns(columns);
		this.data = data || [];
		this.rows = this.prepareRows(this.data);
		this.prepareTree();
	}

	/**
	 * frappe-datatable expresses a tree as a FLAT list with an `indent` field;
	 * TanStack expects nesting. Build the nesting once, keeping every row's
	 * original flat index in `meta.rowIndex` so the two addressing schemes stay
	 * reconcilable (see managers.rowIndexOf).
	 */
	prepareTree() {
		this.treeRoots = null;
		if (!this.options.treeView) return;
		const roots = [];
		const stack = [];
		for (const row of this.rows) {
			row.__children = [];
			const indent = row.meta.indent || 0;
			while (stack.length && (stack[stack.length - 1].meta.indent || 0) >= indent) stack.pop();
			if (stack.length) stack[stack.length - 1].__children.push(row);
			else roots.push(row);
			stack.push(row);
		}
		for (const row of this.rows) row.meta.isLeaf = row.__children.length === 0;
		this.treeRoots = roots;
	}

	getDescendants(parentRowIndex, immediateOnly) {
		const parent = this.rows[parentRowIndex];
		if (!parent || !parent.__children) return [];
		if (immediateOnly) return parent.__children.slice();
		const out = [];
		const walk = (node) => {
			for (const child of node.__children || []) {
				out.push(child);
				walk(child);
			}
		};
		walk(parent);
		return out;
	}

	// ----------------------------------------------------------------- engine

	engineColumnId(colIndex) {
		const col = this.columns[colIndex];
		return col ? this.engineIdFor(col, colIndex) : null;
	}

	/** Column ids must be unique and stable; `id` can repeat, colIndex cannot. */
	engineIdFor(col, colIndex) {
		return `c${colIndex}:${col.id}`;
	}

	rowIdFor(rowIndex) {
		return String(rowIndex);
	}

	buildEngine() {
		const engineColumns = this.columns.map((col, i) => this.toEngineColumn(col, i));
		this.engine = new CarbonTable(this.container, {
			columns: engineColumns,
			data: this.options.treeView ? this.treeRoots || [] : this.rows,
			getRowId: (row) => String(row.meta.rowIndex),
			getSubRows: this.options.treeView ? (row) => row.__children : null,
			rowHeight: this.options.cellHeight,
			direction: this.options.direction,
			inlineFilters: this.options.inlineFilters,
			showTotalRow: this.options.showTotalRow,
			selectable: this.options.checkboxColumn,
			resizable: true,
			emptyMessage: this.options.noDataMessage,
			// Report views scroll INSIDE the table, as frappe-datatable did
			// (`.dt-scrollable { height: 40vw }`). Without a bounded viewport a
			// 100k-row report would put every row in the DOM.
			scrollHeight: this.options.scrollHeight || "calc(100vh - 260px)",
			profile: datatableProfile(this.scopeClass),
			renderTotal: (entry, column, colIndex, host) =>
				this.renderTotalCell(entry, column, colIndex, host),
			events: {
				onSortColumn: (column) => {
					const col = this.columns[this.colIndexOfEngineColumn(column)];
					this.fireEvent("onSortColumn", col);
					if (this.options.saveSorting) this.persistSorting();
				},
			},
		});
	}

	colIndexOfEngineColumn(column) {
		const id = typeof column === "string" ? column : column.id;
		const m = /^c(\d+):/.exec(id);
		return m ? Number(m[1]) : -1;
	}

	toEngineColumn(col, i) {
		const isStandard = i < this.standardColumnCount;
		return {
			id: this.engineIdFor(col, i),
			label: col.name || col.content || "",
			header: () => col.content || col.name || "",
			size: col.width || (isStandard ? 60 : 120),
			minSize: col.minWidth || this.options.minimumColumnWidth,
			align: col.align || "left",
			sortable: col.sortable !== false && !isStandard,
			resizable: col.resizable !== false,
			filterable: col.focusable !== false && !isStandard,
			pinned: col.sticky ? "start" : undefined,
			accessor: (rowArr) => {
				const cell = rowArr[i];
				return cell ? cell.content : "";
			},
			meta: {
				colIndex: i,
				dtColumn: col,
				compareValue: col.compareValue
					? (row, keyword) => col.compareValue(row.original[i], keyword)
					: undefined,
				getFilterText: (row) => this.plainText(this.cellHTML(row.original[i], false)),
			},
			cell: (ctx) => this.cellHTML(ctx.row.original[i], false, ctx.row),
		};
	}

	plainText(html) {
		return String(html == null ? "" : html).replace(/<[^>]*>/g, "");
	}

	/**
	 * Cell HTML, following cellmanager.getCellContent: a `format` on the cell
	 * wins over one on the column, the result is memoised on `cell.html`, and
	 * treeView injects the indent and toggle into the column right after
	 * `_rowIndex` at 20px per level.
	 */
	cellHTML(cell, refreshHtml, row) {
		if (!cell) return "";
		const formatter = cell.format || (cell.column && cell.column.format) || null;
		let html;
		if (!formatter) {
			html = cell.content;
		} else if (!cell.html || refreshHtml) {
			html = formatter(
				cell.content,
				this.rows[cell.rowIndex],
				cell.column,
				this.data[cell.rowIndex]
			);
		} else {
			html = cell.html;
		}
		cell.html = html;
		html = html == null ? "" : String(html);

		if (this.options.treeView && cell.colIndex === this.treeColumnIndex()) {
			const indent = cell.indent || 0;
			const hasChildren = row && row.subRows && row.subRows.length;
			const expanded = row && row.getIsExpanded && row.getIsExpanded();
			const toggle = hasChildren
				? `<span class="dt-tree-node__toggle ${expanded ? "" : "dt-cell--tree-close"}"></span>`
				: '<span class="dt-tree-node__toggle-placeholder"></span>';
			html = `<span class="dt-tree-node" style="padding-left:${indent * 20}px">${toggle}${html}</span>`;
		}
		return html;
	}

	treeColumnIndex() {
		const i = this.datamanager.getColumnIndexById("_rowIndex");
		return i + 1;
	}

	renderTotalCell(entry, column, colIndex, host) {
		const dtColIndex = this.colIndexOfEngineColumn(column);
		const col = this.columns[dtColIndex];
		if (!col || dtColIndex < this.standardColumnCount) {
			host.applyContent(entry, entry.content, dtColIndex === 0 ? __("Total") : "");
			return;
		}
		const values = host.table.getRowModel().rows.map((r) => {
			const cell = r.original[dtColIndex];
			return cell ? cell.content : null;
		});
		const cell = { column: col, colIndex: dtColIndex };
		let total = null;
		const hook = this.options.hooks && this.options.hooks.columnTotal;
		if (typeof hook === "function") total = hook.call(this, values, cell);
		if (total === null || total === undefined) {
			let sum = 0;
			let numeric = false;
			for (const v of values) {
				const n = parseFloat(v);
				if (!isNaN(n)) {
					sum += n;
					numeric = true;
				}
			}
			total = numeric ? sum : "";
		}
		host.applyContent(entry, entry.content, total);
	}

	getTotalRow() {
		const row = [];
		for (let i = 0; i < this.columns.length; i++) {
			const entry = { content: document.createElement("div"), rendered: undefined };
			this.renderTotalCell(entry, { id: this.engineColumnId(i) }, i, this.engine);
			row.push({ content: entry.content.innerHTML, colIndex: i, column: this.columns[i] });
		}
		return row;
	}

	prepareDom() {
		// frappe-datatable exposes these handles and ERPNext styles through them
		// (`$(".${scopeClass} .dt-scrollable")`), so keep them resolvable.
		this.datatableWrapper = this.container;
		this.header = this.engine.renderer.thead;
		this.footer = this.engine.renderer.tfoot;
		this.bodyScrollable = this.engine.renderer.scroll;

		this.freezeContainer = document.createElement("div");
		this.freezeContainer.className = "dt-freeze";
		this.freezeContainer.style.display = "none";
		this.freezeContainer.innerHTML = `<span class="dt-freeze__message">${this.options.freezeMessage}</span>`;
		this.container.appendChild(this.freezeContainer);

		this.toastMessage = document.createElement("div");
		this.toastMessage.className = "dt-toast";
		this.container.appendChild(this.toastMessage);

		this.pasteTarget = document.createElement("textarea");
		this.pasteTarget.className = "dt-paste-target";
		this.container.appendChild(this.pasteTarget);

		this.bindCheckboxes();
	}

	bindCheckboxes() {
		this.container.addEventListener("change", (e) => {
			const input = e.target;
			if (!input.classList || !input.classList.contains("dt-checkbox")) return;
			const td = input.closest(".dt-cell");
			if (!td) return;
			const isHeader = !!input.closest(".dt-row-header");
			if (isHeader) {
				this.rowmanager.checkAll(input.checked);
			} else {
				const rowIndex = Number(td.getAttribute("data-row-index"));
				this.rowmanager.checkRow(rowIndex, input.checked);
			}
		});
	}

	syncSelectionToEngine() {
		const selection = {};
		this.rowmanager.checkMap.forEach((v, i) => {
			if (v) selection[this.rowIdFor(i)] = true;
		});
		this.engine.table.setRowSelection(selection);
		if (this.options.checkedRowStatus) {
			const n = this.rowmanager.getCheckedRows().length;
			if (n) this.showToastMessage(`${n} ${n === 1 ? __("row selected") : __("rows selected")}`);
			else this.clearToastMessage();
		}
	}

	// ------------------------------------------------------------ public API

	refresh(data, columns) {
		if (columns) this.options.columns = columns;
		if (data) this.options.data = data;
		this.prepare(this.options.columns, this.options.data);
		this.engine.setColumns(this.columns.map((col, i) => this.toEngineColumn(col, i)));
		this.engine.setData(this.options.treeView ? this.treeRoots || [] : this.rows);
		this.engine.options.showTotalRow = this.options.showTotalRow;
		this.engine.options.rowHeight = this.options.cellHeight;
		this.noData = !this.rows.length;
		this.engine.render();
		return this;
	}

	rebuildColumns() {
		this.engine.setColumns(this.columns.map((col, i) => this.toEngineColumn(col, i)));
		return this;
	}

	appendRows(rows) {
		this.options.data = this.data.concat(rows || []);
		return this.refresh(this.options.data);
	}

	refreshRow(row, rowIndex) {
		if (row) this.rows[rowIndex] = this.prepareRows([row])[0];
		const cells = this.rows[rowIndex] || [];
		for (const cell of cells) cell.html = null;
		this.engine.render();
		return this;
	}

	updateRow(row, rowIndex) {
		return this.refreshRow(row, rowIndex);
	}

	updateCell(colIndex, rowIndex, options, refreshHtml) {
		const cell = this.datamanager.getCell(colIndex, rowIndex);
		if (!cell) return;
		Object.assign(cell, options || {});
		if (refreshHtml !== false) cell.html = null;
		// Keep the ORIGINAL data object in step, because report scripts read it
		// back through `datamanager.getData(rowIndex)`.
		const original = this.data[rowIndex];
		const col = this.columns[colIndex];
		if (original && !Array.isArray(original) && col && options && "content" in options) {
			original[col.id] = options.content;
		}
		this.engine.render();
		return cell;
	}

	render() {
		this.noData = !this.rows.length;
		this.engine.render();
		return this;
	}
	renderHeader() {
		return this.render();
	}
	renderBody() {
		return this.render();
	}
	setDimensions() {
		return this.render();
	}

	destroy() {
		this.fireEvent("onDestroy");
		if (this.style) this.style.destroy();
		if (this.engine) this.engine.destroy();
		this.container.innerHTML = "";
		this.container.classList.remove("datatable", this.scopeClass);
	}

	getColumn(colIndex) {
		return this.datamanager.getColumn(colIndex);
	}
	getColumns(skipStandardColumns) {
		return this.datamanager.getColumns(skipStandardColumns);
	}
	getRows() {
		return this.rows;
	}
	getCell(colIndex, rowIndex) {
		return this.datamanager.getCell(colIndex, rowIndex);
	}
	getColumnHeaderElement(colIndex) {
		return this.engine.getHeaderNode(this.engineColumnId(colIndex));
	}
	getViewportHeight() {
		return this.engine.renderer.scroll.clientHeight;
	}

	sortColumn(colIndex, sortOrder = "none") {
		const id = this.engineColumnId(colIndex);
		if (!id) return;
		if (sortOrder === "none") this.engine.table.setSorting([]);
		else this.engine.table.setSorting([{ id, desc: sortOrder === "desc" }]);
		this.fireEvent("onSortColumn", this.columns[colIndex]);
	}

	persistSorting() {
		try {
			const key = this.options.sortingKey
				? `${this.options.sortingKey}::sortedColumns`
				: "sortedColumns";
			localStorage.setItem(key, JSON.stringify(this.engine.state.sorting || []));
		} catch (e) {
			/* private mode / quota — sorting simply is not remembered */
		}
	}

	saveSorting(colIndex, sortOrder) {
		this.sortColumn(colIndex, sortOrder);
		this.persistSorting();
	}

	removeColumn(colIndex) {
		const col = this.columns[colIndex];
		if (!col) return;
		this.options.columns = this.options.columns.filter(
			(c, i) => i !== colIndex - this.standardColumnCount
		);
		this.refresh(this.options.data, this.options.columns);
		this.fireEvent("onRemoveColumn", col);
	}

	switchColumn(colIndex1, colIndex2) {
		const a = colIndex1 - this.standardColumnCount;
		const b = colIndex2 - this.standardColumnCount;
		const cols = this.options.columns.slice();
		const tmp = cols[a];
		cols[a] = cols[b];
		cols[b] = tmp;
		const c1 = this.columns[colIndex1];
		const c2 = this.columns[colIndex2];
		this.refresh(this.options.data, cols);
		this.fireEvent("onSwitchColumn", c1, c2);
	}

	setColumnSticky(colIndex, sticky) {
		const col = this.columns[colIndex];
		if (!col) return;
		col.sticky = sticky;
		const id = this.engineColumnId(colIndex);
		const column = this.engine.table.getColumn(id);
		if (column) column.pin(sticky ? "start" : false);
	}

	scrollToLastColumn() {
		const scroll = this.engine.renderer.scroll;
		scroll.scrollLeft = scroll.scrollWidth;
	}

	scrollToRow(rowIndex) {
		const rows = this.engine.table.getRowModel().rows;
		const pos = rows.findIndex((r) => rowIndexOf(r) === rowIndex);
		if (pos >= 0) this.engine.scrollToRowIndex(pos, { align: "start" });
	}

	setExpanded(rowIndex, expanded) {
		const row = this.engine.table.getRow(this.rowIdFor(rowIndex));
		if (row && row.toggleExpanded) row.toggleExpanded(expanded);
	}

	setTreeDepth(depth) {
		const expanded = {};
		for (const row of this.rows) {
			if ((row.meta.indent || 0) < depth) expanded[this.rowIdFor(row.meta.rowIndex)] = true;
		}
		this.engine.table.setExpanded(expanded);
	}

	applyFilters(filters) {
		const next = [];
		for (const colIndex in filters || {}) {
			const id = this.engineColumnId(Number(colIndex));
			const value = filters[colIndex];
			if (id && value !== "" && value != null) next.push({ id, value });
		}
		this.engine.table.setColumnFilters(next);
		return Promise.resolve({ rowsToShow: this.datamanager.getFilteredRowIndices() });
	}

	freeze() {
		this.freezeContainer.style.display = "";
	}
	unfreeze() {
		this.freezeContainer.style.display = "none";
	}

	showToastMessage(message, hideAfterSecs) {
		this.toastMessage.innerHTML = `<span class="dt-toast__message">${message}</span>`;
		if (hideAfterSecs) setTimeout(() => this.clearToastMessage(), hideAfterSecs * 1000);
	}
	clearToastMessage() {
		this.toastMessage.innerHTML = "";
	}

	updateOptions(options) {
		Object.assign(this.options, options || {});
		if ("cellHeight" in (options || {})) this.engine.options.rowHeight = options.cellHeight;
		if ("treeView" in (options || {})) this.prepareTree();
		if ("showTotalRow" in (options || {}))
			this.engine.options.showTotalRow = options.showTotalRow;
		this.refresh(this.options.data, this.options.columns);
	}

	/** Upstream binds handlers with `this === datatable`. Report scripts rely on it. */
	fireEvent(name, ...args) {
		const handler = this.events && this.events[name];
		if (typeof handler !== "function") return;
		try {
			handler.apply(this, args);
		} catch (e) {
			console.error(`carbon_frappe: datatable event "${name}" failed`, e);
		}
	}

	on(event, handler) {
		const existing = this.events[event];
		this.events[event] = function (...args) {
			if (typeof handler === "function") handler.apply(this, args);
			if (typeof existing === "function") existing.apply(this, args);
		};
	}

	log(...args) {
		if (this.options.logs) console.log(...args);
	}

	translate(str) {
		const lang = this.options.language;
		const table = (this.options.translations || {})[lang] || {};
		const hit = table[str];
		if (typeof hit === "string") return hit;
		return str;
	}

	get rowHeightSize() {
		return nearestRowSize(this.options.cellHeight);
	}
}

CarbonDataTable.instances = 0;
CarbonDataTable.__version__ = "carbon_frappe";
