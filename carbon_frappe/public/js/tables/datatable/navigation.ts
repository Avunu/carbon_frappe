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
//
// The only import is a TYPE: `CarbonDataTableHost` describes the
// `CarbonDataTable` this object steers, and lives in ./managers because that is
// where the sub-managers it reaches through are defined. It erases completely,
// so this module still has no runtime dependency on anything.
import type { CarbonDataTableHost } from "./managers";
import type {
	DataTableColIndex,
	DataTableFocusedCell,
	DataTableRowIndex,
	DataTableSelectionBounds,
} from "frappe-types";

/** The four directions {@link CellNavigation.move} understands. */
export type CellNavigationDirection = "left" | "right" | "up" | "down";

/** Options for {@link CellNavigation.focus} — `extend` is shift+click / shift+arrow. */
export interface CellFocusOptions {
	extend?: boolean;
}

/** Options for {@link CellNavigation.move} — `toEdge` is ctrl+arrow. */
export interface CellMoveOptions extends CellFocusOptions {
	toEdge?: boolean;
}

const ARROWS: Record<string, CellNavigationDirection> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
};

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

/**
 * Narrow a delegated event's `target` to something `closest()` can be called on.
 *
 * Duck-typed rather than `instanceof Element`, exactly as the JS was: an
 * `EventTarget` here can be a `Document`, a `Window`, or an element from
 * another realm — a control frappe rendered into an iframe — and only the
 * first two genuinely lack `closest`.
 */
function isElement(target: EventTarget | null | undefined): target is Element {
	return !!target && "closest" in target && typeof target.closest === "function";
}

export function insideEditorUI(target: EventTarget | null | undefined): boolean {
	return !!(isElement(target) && target.closest(EDITOR_UI));
}

export default class CellNavigation {
	host: CarbonDataTableHost;
	/** The anchor cell of the selection, or `null` when nothing is focused. */
	focused: DataTableFocusedCell | null;
	/** The opposite corner of the selection rectangle. */
	cursor: DataTableFocusedCell | null;
	/** Cells currently carrying a focus/highlight class, so they can be cleared. */
	_highlighted: HTMLElement[];
	/** `true` between mousedown on a cell and the document-level mouseup. */
	dragging?: boolean;
	/** The bound container, set by {@link bind}. */
	container?: HTMLElement;
	/** The document-level `mouseup` handler, kept so it stays identifiable. */
	_onMouseUp?: () => void;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.focused = null; // { colIndex, rowIndex }
		this.cursor = null; // opposite corner of the selection rectangle
		this._highlighted = [];
	}

	// ------------------------------------------------------------- addressing

	/** Display order of data row indices, honouring sort and filter. */
	get viewOrder(): DataTableRowIndex[] {
		return this.host.datamanager.rowViewOrder;
	}

	viewPos(rowIndex: DataTableRowIndex): number {
		return this.viewOrder.indexOf(rowIndex);
	}

	/**
	 * Columns the caret may land on. frappe marks the injected `_checkbox` and
	 * `_rowIndex` columns `focusable: false`, and a column may opt out too.
	 */
	focusableColumns(): DataTableColIndex[] {
		const out: DataTableColIndex[] = [];
		this.host.columns.forEach((col, i) => {
			if (col.focusable !== false) out.push(i);
		});
		return out;
	}

	nextFocusable(colIndex: DataTableColIndex, step: number): DataTableColIndex | null {
		const cols = this.focusableColumns();
		const at = cols.indexOf(colIndex);
		if (at === -1) return cols.length ? cols[0] ?? null : null;
		const next = at + step;
		return next >= 0 && next < cols.length ? cols[next] ?? null : null;
	}

	// ------------------------------------------------------------------ focus

	focus(
		colIndex: DataTableColIndex,
		rowIndex: DataTableRowIndex,
		{ extend = false }: CellFocusOptions = {}
	): boolean {
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

	move(
		direction: CellNavigationDirection,
		{ extend = false, toEdge = false }: CellMoveOptions = {}
	): boolean {
		const from = extend ? this.cursor : this.focused;
		if (!from) return false;

		let { colIndex, rowIndex } = from;
		const order = this.viewOrder;
		const pos = this.viewPos(rowIndex);

		if (direction === "left" || direction === "right") {
			const step = direction === "right" ? 1 : -1;
			if (toEdge) {
				const cols = this.focusableColumns();
				// An empty `cols` used to fall through to `focus(undefined, …)`,
				// which bailed on its own null check — same answer, one step
				// earlier and with no undefined in flight.
				const edge = step > 0 ? cols[cols.length - 1] : cols[0];
				if (edge === undefined) return false;
				colIndex = edge;
			} else {
				const next = this.nextFocusable(colIndex, step);
				if (next == null) return false;
				colIndex = next;
			}
		} else {
			const step = direction === "down" ? 1 : -1;
			const nextPos = toEdge ? (step > 0 ? order.length - 1 : 0) : pos + step;
			if (nextPos < 0 || nextPos >= order.length) return false;
			const nextRowIndex = order[nextPos];
			if (nextRowIndex === undefined) return false;
			rowIndex = nextRowIndex;
		}
		return this.focus(colIndex, rowIndex, { extend });
	}

	/** The selection rectangle, in data coordinates. */
	bounds(): DataTableSelectionBounds | null {
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
	render(): void {
		for (const node of this._highlighted) {
			node.classList.remove("dt-cell--focus", "dt-cell--highlight");
		}
		this._highlighted = [];
		const b = this.bounds();
		if (!b) return;

		const order = this.viewOrder;
		for (let p = b.p1; p <= b.p2; p++) {
			// `bounds()` yields POSITIONS, and a position is `-1` once the
			// focused row has been filtered out from under the selection. Both
			// `-1` and the `undefined` the JS read here miss every row id, so
			// the loop body simply finds no node.
			const rowIndex = order[p] ?? -1;
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

	scrollIntoView(rowIndex: DataTableRowIndex): void {
		const pos = this.viewPos(rowIndex);
		if (pos >= 0) this.host.engine.scrollToRowIndex(pos, { align: "auto" });
	}

	// ------------------------------------------------------------------- copy

	/** TSV of the selection, matching frappe-datatable's `copyCellContents`. */
	copy(): number {
		const b = this.bounds();
		if (!b) return 0;
		const order = this.viewOrder;
		const rows: string[] = [];
		let count = 0;
		for (let p = b.p1; p <= b.p2; p++) {
			// See `render()`: `-1` is the same miss as the JS's `undefined`,
			// so a stale selection still copies its rectangle of blanks.
			const rowIndex = order[p] ?? -1;
			const line: string[] = [];
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

	bind(container: HTMLElement): void {
		this.container = container;
		const scroll = this.host.engine.renderer.scroll;
		// The grid needs to receive keys without stealing them from the desk.
		if (!scroll.hasAttribute("tabindex")) scroll.setAttribute("tabindex", "0");

		container.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			if (insideEditorUI(e.target)) return;
			const td = isElement(e.target) && e.target.closest(".dt-cell");
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
			const td = isElement(e.target) && e.target.closest(".dt-cell");
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

	onKeyDown(e: KeyboardEvent): void {
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
					this.host.translate("{count} cells copied").replace("{count}", String(n)),
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

	endDrag(): void {
		if (!this.dragging) return;
		this.dragging = false;
		if (this.container) this.container.classList.remove("cf-table--selecting");
	}

	activateFocused(): void {
		// Its only caller checks `this.focused` first; the JS would have thrown
		// on a null here, and "nothing is focused" plainly means "nothing to
		// open".
		const focused = this.focused;
		if (!focused) return;
		const node = this.host.engine.getCellNode(
			this.host.rowIdFor(focused.rowIndex),
			this.host.engineColumnId(focused.colIndex)
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
function writeClipboard(text: string): void {
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
