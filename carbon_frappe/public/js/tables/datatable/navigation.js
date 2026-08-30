// Spreadsheet cell navigation for the Report / Query views.
//
// The Report view is frappe's BULK EDITING surface, not a read-only list: 7 of
// 10 columns on a stock doctype come back `editable: true`, and
// `report_view.js` hands the datatable a `getEditor` that mounts real frappe
// controls in the cell. frappe-datatable supplied the whole grid interaction
// around that — focus ring, arrow-key movement, shift-select, ctrl+C — and
// replacing it with a table that only renders left the surface looking (and
// behaving) like the List view.
//
// This reproduces frappe-datatable's keyboard contract exactly
// (datatable/src/cellmanager.js:45-160), because report users have the muscle
// memory and third-party reports document it:
//
//   click / dblclick     focus / start editing
//   ← ↑ → ↓              move focus, skipping non-focusable columns
//   tab / shift+tab      move right / left; commits an open editor first
//   ctrl + ← ↑ → ↓       jump to the edge of the row or column
//   shift + ← ↑ → ↓      extend the selection rectangle
//   enter                edit the focused cell, or commit the open one
//   esc                  cancel editing and close the filter row
//   ctrl+c               copy the selection as TSV, with a toast
//   ctrl+f               focus the inline filter for the focused column
//
// Paste is deliberately absent: `pasteFromClipboard` defaults to false and
// `report_view.js` never enables it, so frappe-datatable did not paste here
// either.
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/**
 * Anything belonging to an open cell editor, rather than to the grid.
 *
 * An open editor is a real frappe control living INSIDE the cell, and its
 * affordances — awesomplete's listbox for a Link, the date picker, a select
 * menu — are rendered within it or float above it. Treating a click on one of
 * those as a grid click did two damaging things at once: it moved DOM focus to
 * the scroll container, which closed awesomplete before it could commit the
 * highlighted option (so picking a Link value silently did nothing), and it
 * began a drag-selection, so the pointer travelling to the option swept a
 * rectangle of cells behind the dropdown.
 *
 * Listed explicitly rather than "is inside the editing cell": frappe re-parents
 * some of these (grid.js moves the awesomplete list up to `.grid-field`), so
 * they are not always descendants of the cell they belong to.
 */
const EDITOR_UI = [
	".dt-cell__edit",
	".awesomplete",
	'[role="listbox"]',
	".datepicker",
	".datepickers-container",
	".dropdown-menu",
	".modal",
	".frappe-control",
	".link-btn",
].join(", ");

export function insideEditorUI(target) {
	return !!(target && target.closest && target.closest(EDITOR_UI));
}

export default class CellNavigation {
	constructor(host) {
		this.host = host;
		this.focused = null; // { colIndex, rowIndex }
		this.cursor = null; // opposite corner of the selection rectangle
		this._highlighted = [];
	}

	// ------------------------------------------------------------- addressing

	/** Display order of data row indices, honouring sort and filter. */
	get viewOrder() {
		return this.host.datamanager.rowViewOrder;
	}

	viewPos(rowIndex) {
		return this.viewOrder.indexOf(rowIndex);
	}

	/**
	 * Columns the caret may land on. frappe marks the injected `_checkbox` and
	 * `_rowIndex` columns `focusable: false`, and a column may opt out too.
	 */
	focusableColumns() {
		const out = [];
		this.host.columns.forEach((col, i) => {
			if (col.focusable !== false) out.push(i);
		});
		return out;
	}

	nextFocusable(colIndex, step) {
		const cols = this.focusableColumns();
		const at = cols.indexOf(colIndex);
		if (at === -1) return cols.length ? cols[0] : null;
		const next = at + step;
		return next >= 0 && next < cols.length ? cols[next] : null;
	}

	// ------------------------------------------------------------------ focus

	focus(colIndex, rowIndex, { extend = false } = {}) {
		if (colIndex == null || rowIndex == null) return false;
		const col = this.host.columns[colIndex];
		if (!col || col.focusable === false) return false;
		if (this.viewPos(rowIndex) === -1) return false;

		if (extend && this.focused) {
			this.cursor = { colIndex, rowIndex };
		} else {
			this.focused = { colIndex, rowIndex };
			this.cursor = { colIndex, rowIndex };
		}
		this.scrollIntoView(rowIndex);
		this.render();
		return true;
	}

	move(direction, { extend = false, toEdge = false } = {}) {
		const from = extend ? this.cursor : this.focused;
		if (!from) return false;

		let { colIndex, rowIndex } = from;
		const order = this.viewOrder;
		const pos = this.viewPos(rowIndex);

		if (direction === "left" || direction === "right") {
			const step = direction === "right" ? 1 : -1;
			if (toEdge) {
				const cols = this.focusableColumns();
				colIndex = step > 0 ? cols[cols.length - 1] : cols[0];
			} else {
				const next = this.nextFocusable(colIndex, step);
				if (next == null) return false;
				colIndex = next;
			}
		} else {
			const step = direction === "down" ? 1 : -1;
			const nextPos = toEdge ? (step > 0 ? order.length - 1 : 0) : pos + step;
			if (nextPos < 0 || nextPos >= order.length) return false;
			rowIndex = order[nextPos];
		}
		return this.focus(colIndex, rowIndex, { extend });
	}

	/** The selection rectangle, in data coordinates. */
	bounds() {
		if (!this.focused || !this.cursor) return null;
		const a = this.viewPos(this.focused.rowIndex);
		const b = this.viewPos(this.cursor.rowIndex);
		return {
			c1: Math.min(this.focused.colIndex, this.cursor.colIndex),
			c2: Math.max(this.focused.colIndex, this.cursor.colIndex),
			p1: Math.min(a, b),
			p2: Math.max(a, b),
		};
	}

	// --------------------------------------------------------------- painting

	/**
	 * Classes are re-applied after every engine render, not just on change:
	 * rows are virtualized, so a cell that scrolls back into view is a fresh
	 * node with no state on it.
	 */
	render() {
		for (const node of this._highlighted) {
			node.classList.remove("dt-cell--focus", "dt-cell--highlight");
		}
		this._highlighted = [];
		const b = this.bounds();
		if (!b) return;

		const order = this.viewOrder;
		for (let p = b.p1; p <= b.p2; p++) {
			const rowIndex = order[p];
			for (let c = b.c1; c <= b.c2; c++) {
				const node = this.host.engine.getCellNode(
					this.host.rowIdFor(rowIndex),
					this.host.engineColumnId(c)
				);
				if (!node) continue;
				const isFocus =
					this.focused && this.focused.colIndex === c && this.focused.rowIndex === rowIndex;
				node.classList.add(isFocus ? "dt-cell--focus" : "dt-cell--highlight");
				this._highlighted.push(node);
			}
		}
	}

	scrollIntoView(rowIndex) {
		const pos = this.viewPos(rowIndex);
		if (pos >= 0) this.host.engine.scrollToRowIndex(pos, { align: "auto" });
	}

	// ------------------------------------------------------------------- copy

	/** TSV of the selection, matching frappe-datatable's `copyCellContents`. */
	copy() {
		const b = this.bounds();
		if (!b) return 0;
		const order = this.viewOrder;
		const rows = [];
		let count = 0;
		for (let p = b.p1; p <= b.p2; p++) {
			const rowIndex = order[p];
			const line = [];
			for (let c = b.c1; c <= b.c2; c++) {
				const cell = this.host.datamanager.getCell(c, rowIndex);
				line.push(cell && cell.content != null ? String(cell.content) : "");
				count++;
			}
			rows.push(line.join("\t"));
		}
		writeClipboard(rows.join("\n"));
		return count;
	}

	// ------------------------------------------------------------------- bind

	bind(container) {
		this.container = container;
		const scroll = this.host.engine.renderer.scroll;
		// The grid needs to receive keys without stealing them from the desk.
		if (!scroll.hasAttribute("tabindex")) scroll.setAttribute("tabindex", "0");

		container.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			if (insideEditorUI(e.target)) return;
			const td = e.target.closest && e.target.closest(".dt-cell");
			if (!td || td.closest("thead")) return;
			const colIndex = Number(td.getAttribute("data-col-index"));
			const rowIndex = Number(td.getAttribute("data-row-index"));
			this.focus(colIndex, rowIndex, { extend: e.shiftKey });
			scroll.focus({ preventScroll: true });

			// Begin a drag-selection. `mousedown` is NOT prevented: doing so
			// would stop links in cells from being clicked and stop an editor's
			// input from taking focus. Text selection is suppressed with a class
			// for the duration instead.
			this.dragging = true;
			container.classList.add("cf-table--selecting");
		});

		// `mouseover` rather than `mousemove`: it fires once per cell crossed,
		// so the selection updates exactly when the rectangle changes instead of
		// on every pixel. frappe-datatable had to throttle mousemove at 50ms.
		container.addEventListener("mouseover", (e) => {
			if (!this.dragging) return;
			// Self-heal a lost mouseup. The button can be released where we never
			// see it — outside the window, over a dialog that opened mid-drag, or
			// swallowed by another handler — and the grid would then keep
			// extending the selection on every later pointer move with no button
			// held. `buttons` is authoritative about what is held right now, so a
			// zero means the drag is over regardless of what we observed.
			if (!e.buttons) {
				this.endDrag();
				return;
			}
			if (insideEditorUI(e.target)) return;
			const td = e.target.closest && e.target.closest(".dt-cell");
			if (!td || td.closest("thead")) return;
			this.focus(
				Number(td.getAttribute("data-col-index")),
				Number(td.getAttribute("data-row-index")),
				{ extend: true }
			);
		});

		// On the document, so releasing outside the table still ends the drag.
		this._onMouseUp = () => this.endDrag();
		document.addEventListener("mouseup", this._onMouseUp);

		container.addEventListener("keydown", (e) => this.onKeyDown(e));

		// Rows recycle as they scroll; repaint selection on every render.
		this.host.engine.on("onRender", () => this.render());
	}

	onKeyDown(e) {
		const editing = !!this.host.editing.$editingCell;
		const key = e.key;
		const ctrl = e.ctrlKey || e.metaKey;

		if (key === "Escape") {
			if (editing) this.host.editing.deactivate(false);
			this.host.columnmanager.toggleFilter(false);
			return;
		}

		if (key === "Enter") {
			e.preventDefault();
			if (editing) this.host.editing.deactivate(true);
			else if (this.focused) this.activateFocused();
			return;
		}

		if (key === "Tab") {
			if (!this.focused) return;
			e.preventDefault();
			// tab commits an open editor first, then moves — arrows do not
			if (editing) this.host.editing.deactivate(true);
			this.move(e.shiftKey ? "left" : "right");
			return;
		}

		if (ctrl && (key === "c" || key === "C")) {
			if (editing) return;
			const n = this.copy();
			if (n) {
				this.host.showToastMessage(
					this.host.translate("{count} cells copied").replace("{count}", n),
					2
				);
			}
			return;
		}

		if (ctrl && (key === "f" || key === "F") && this.host.options.inlineFilters) {
			if (!this.focused) return;
			e.preventDefault();
			this.host.columnmanager.toggleFilter(true);
			this.host.columnmanager.focusFilter(this.focused.colIndex);
			return;
		}

		const direction = ARROWS[key];
		if (!direction) return;
		// Arrows inside an open editor belong to the editor.
		if (editing) return;
		if (!this.focused) return;
		e.preventDefault();
		this.move(direction, { extend: e.shiftKey, toEdge: ctrl });
	}

	endDrag() {
		if (!this.dragging) return;
		this.dragging = false;
		if (this.container) this.container.classList.remove("cf-table--selecting");
	}

	activateFocused() {
		const node = this.host.engine.getCellNode(
			this.host.rowIdFor(this.focused.rowIndex),
			this.host.engineColumnId(this.focused.colIndex)
		);
		if (node) this.host.editing.activate(node);
	}
}

/**
 * Clipboard write, with a fallback.
 *
 * `navigator.clipboard.writeText` REJECTS rather than throwing when the page
 * lacks clipboard permission — which is the normal state in an unfocused tab and
 * in headless Chrome. An uncaught rejection there is not harmless: it surfaces
 * as an unhandled promise rejection on the page and can abort an unrelated
 * evaluation later. Catch it and fall back to the textarea trick.
 */
function writeClipboard(text) {
	const fallback = () => {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand("copy");
		} catch (e) {
			/* clipboard genuinely unavailable */
		}
		ta.remove();
	};

	try {
		if (navigator.clipboard && window.isSecureContext) {
			const p = navigator.clipboard.writeText(text);
			if (p && typeof p.catch === "function") p.catch(fallback);
			return;
		}
	} catch (e) {
		/* fall through to the fallback */
	}
	fallback();
}
