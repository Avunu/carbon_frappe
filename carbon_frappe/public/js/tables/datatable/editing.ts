// Inline cell editing, to frappe-datatable's `getEditor` contract.
//
// The contract (datatable/src/cellmanager.js `getEditor` / `submitEditing`):
//
//   options.getEditor(colIndex, rowIndex, value, parent, column, row, data)
//     -> false      editing is suppressed for this cell
//     -> undefined  fall back to a plain <input class="dt-input">
//     -> { initValue(value, rowIndex, column),
//          getValue() -> value | Promise,
//          setValue(value, rowIndex, column) -> void | Promise }
//
// Two details that look incidental but are load-bearing for real reports:
//
//   * `parent` must be a child of the `.dt-cell` element, because callers do
//     `parent.closest('.dt-cell')` (avunu's timesheet_review dims non-editable
//     cells that way) and mount frappe controls into it with
//     `frappe.ui.form.make_control({ parent })`.
//   * `submitEditing` is OPTIMISTIC: it writes the new value into the cell
//     immediately and reverts only if `setValue` returns a rejected promise.
//     report_view.js relies on that to keep the grid responsive while
//     `frappe.db.set_value` is in flight. That write-then-revert is
//     `commitValue()` below, exported so ./paste.ts can persist a value
//     through the same editor contract without ever showing an editor.
//
// Two things this adds on top of the contract:
//
//   * A MULTI-LINE editor (frappe's ControlText / ControlSmallText mount a
//     <textarea> with an inline `height: 150px`/`300px`, form/controls/text.js
//     :15, :25) is marked `dt-cell__edit--multiline` and has that inline
//     height cleared, so the stylesheet can grow the mount below the cell as
//     a framed popover instead of letting a 150px control spill out of a 48px
//     cell with no backdrop.
//   * Enter inside that textarea inserts a newline; Ctrl/Cmd+Enter commits.
//     Single-line editors keep frappe-datatable's Enter = commit.

import { insideEditorUI } from "./navigation";
import type { CarbonDataTableHost } from "./managers";
import type {
	DataTableCell,
	DataTableCellValue,
	DataTableColIndex,
	DataTableColumn,
	DataTableEditor,
	DataTableRowIndex,
} from "frappe-types";

/** The cell an open editor belongs to — everything `submit()` needs to commit. */
export interface CellEditingContext {
	colIndex: DataTableColIndex;
	rowIndex: DataTableRowIndex;
	column: DataTableColumn;
	cell: DataTableCell;
}

/**
 * Narrow a delegated event's `target` to something `closest()` can be called on.
 *
 * Duck-typed rather than `instanceof Element`, exactly as the JS was
 * (`e.target.closest && e.target.closest(".dt-cell")`): an `EventTarget` here
 * can be a `Document`, a `Window`, or an element from another realm — a control
 * frappe rendered into an iframe — and only the first two genuinely lack
 * `closest`. ./navigation.ts needs the same guard for the same delegated
 * handlers and keeps its own copy private; duplicating four tokens is cheaper
 * than widening that module's exported surface for a helper neither file wants
 * to publish.
 */
function isElement(target: EventTarget | null | undefined): target is Element {
	return !!target && "closest" in target && typeof target.closest === "function";
}

/** `true` when the event target is the textarea of an open multi-line editor. */
export function inMultilineEditor(target: EventTarget | null | undefined): boolean {
	return isElement(target) && target.matches(".dt-cell__edit--multiline textarea");
}

/**
 * frappe-datatable's optimistic commit, as one reusable step: write `value`
 * into the cell now, hand it to the editor's `setValue`, and put `oldValue`
 * back if that rejects. Resolves `true` when the write stuck.
 *
 * The editor object comes from a THIRD PARTY's `getEditor`, so `setValue` is
 * read through a binding that admits `undefined` even though the declared
 * contract makes it required — the JS guarded the call for exactly that
 * reason, and the declaration must not talk the compiler out of it.
 */
export function commitValue(
	host: CarbonDataTableHost,
	colIndex: DataTableColIndex,
	rowIndex: DataTableRowIndex,
	column: DataTableColumn,
	editor: DataTableEditor,
	value: DataTableCellValue,
	oldValue: DataTableCellValue
): Promise<boolean> {
	const setValue: DataTableEditor["setValue"] | undefined = editor.setValue;
	host.updateCell(colIndex, rowIndex, { content: value }, true);
	let result: unknown;
	try {
		result = setValue ? setValue.call(editor, value, rowIndex, column) : undefined;
	} catch (e) {
		result = Promise.reject(e);
	}
	return Promise.resolve(result).then(
		() => true,
		() => {
			host.updateCell(colIndex, rowIndex, { content: oldValue }, true);
			return false;
		}
	);
}

export default class CellEditing {
	host: CarbonDataTableHost;
	/** The `.dt-cell` with an open editor, or `null`. */
	$editingCell: HTMLElement | null;
	editor: DataTableEditor | null;
	/** The `.dt-cell__edit` mount point of the open editor. */
	editParent: HTMLElement | null;
	/** The value the editor opened with; restored if `setValue` rejects. */
	oldValue: DataTableCellValue;
	context: CellEditingContext | null;
	/**
	 * The cell carrying `dt-cell--focus`.
	 *
	 * Optional, not `| null`, because the JS never initialises it in the
	 * constructor: it is `undefined` until the first click and `null` after
	 * {@link unfocus}, and `bind`'s Enter branch tests it for truthiness either
	 * way.
	 */
	focused?: HTMLElement | null;
	/** Aborts every listener {@link bind} added; see {@link unbind}. */
	_abort: AbortController | null;

	constructor(host: CarbonDataTableHost) {
		this.host = host;
		this.$editingCell = null;
		this.editor = null;
		this.editParent = null;
		this.oldValue = undefined;
		this.context = null;
		this._abort = null;
	}

	/** The `.dt-cell__edit` mount point, created on demand inside the cell. */
	ensureEditParent(td: HTMLElement, colIndex: DataTableColIndex): HTMLElement {
		let parent = td.querySelector<HTMLElement>(":scope > .dt-cell__edit");
		if (!parent) {
			parent = document.createElement("div");
			parent.className = `dt-cell__edit dt-cell__edit--col-${colIndex}`;
			td.appendChild(parent);
		}
		parent.innerHTML = "";
		return parent;
	}

	activate(td: HTMLElement | null): boolean {
		if (!td) return false;
		if (this.$editingCell === td) return true;
		this.deactivate(true);

		const colIndex = Number(td.getAttribute("data-col-index"));
		const rowIndex = Number(td.getAttribute("data-row-index"));
		const host = this.host;
		const column = host.datamanager.getColumn(colIndex);
		const cell = host.datamanager.getCell(colIndex, rowIndex);
		if (!column || !cell) return false;
		if (cell.editable === false || column.editable === false) return false;
		if (colIndex < host.standardColumnCount) return false;

		const parent = this.ensureEditParent(td, colIndex);
		const row = host.datamanager.getRow(rowIndex);
		const data = host.datamanager.getData(rowIndex);
		const value = cell.content;

		// `void` is in `getEditor`'s declared return type for a hook that falls
		// off the end; it is falsy at runtime and is treated exactly as the
		// `undefined` case below, which is what the JS did.
		let editor: DataTableEditor | false | undefined | void;
		if (typeof host.options.getEditor === "function") {
			editor = host.options.getEditor(colIndex, rowIndex, value, parent, column, row, data);
			if (editor === false) {
				parent.remove();
				return false;
			}
		}
		if (!editor) editor = this.defaultEditor(parent);

		const textarea = parent.querySelector<HTMLTextAreaElement>("textarea");
		if (textarea) {
			parent.classList.add("dt-cell__edit--multiline");
			// the control's inline height; the stylesheet owns the geometry
			textarea.style.height = "";
		}

		this.$editingCell = td;
		this.editor = editor;
		this.editParent = parent;
		this.oldValue = value;
		this.context = { colIndex, rowIndex, column, cell };
		td.classList.add("dt-cell--editing");
		if (typeof editor.initValue === "function") editor.initValue(value, rowIndex, column);
		return true;
	}

	defaultEditor(parent: HTMLElement): DataTableEditor {
		const input = document.createElement("input");
		input.className = "dt-input";
		input.type = "text";
		parent.appendChild(input);
		return {
			initValue(value) {
				// `String()` is what the DOM does to this assignment anyway —
				// `HTMLInputElement.value` is an IDL string attribute, so a
				// number or a boolean was already being stringified here.
				input.value = value == null ? "" : String(value);
				input.focus();
				input.select();
			},
			getValue() {
				return input.value;
			},
			setValue(value) {
				input.value = value == null ? "" : String(value);
			},
		};
	}

	/** Commit (or abandon) the open editor. Mirrors `deactivateEditing`. */
	deactivate(submitValue = true): boolean {
		if (!this.$editingCell) return false;
		const td = this.$editingCell;
		if (submitValue) this.submit();
		td.classList.remove("dt-cell--editing");
		if (this.editParent) this.editParent.remove();
		this.$editingCell = null;
		this.editor = null;
		this.editParent = null;
		this.context = null;
		return true;
	}

	submit(): void {
		if (!this.editor || !this.context) return;
		const { colIndex, rowIndex, column } = this.context;
		const host = this.host;
		const oldValue = this.oldValue;
		const editor = this.editor;

		Promise.resolve(editor.getValue()).then((value) => {
			// Upstream short-circuits on an unchanged value; report scripts rely
			// on `setValue` NOT firing (and therefore not calling the server)
			// when a user tabs through a cell without touching it.
			if (value === oldValue) return;
			void commitValue(host, colIndex, rowIndex, column, editor, value, oldValue);
		});
	}

	/** Drop every listener {@link bind} added — see `CellNavigation.unbind`. */
	unbind(): void {
		if (this._abort) this._abort.abort();
		this._abort = null;
	}

	focus(td: HTMLElement | null): void {
		if (!td) return;
		const prev = this.host.container.querySelector(".dt-cell--focus");
		if (prev) prev.classList.remove("dt-cell--focus");
		td.classList.add("dt-cell--focus");
		this.focused = td;
	}

	unfocus(): void {
		if (this.focused) this.focused.classList.remove("dt-cell--focus");
		this.focused = null;
	}

	/** Wire double-click-to-edit and the Enter/Escape pair onto the container. */
	bind(container: HTMLElement): void {
		this._abort = new AbortController();
		const signal = this._abort.signal;
		container.addEventListener("dblclick", (e) => {
			// A double click inside an open editor belongs to the control (text
			// selection, a date picker's day), not to the grid.
			if (insideEditorUI(e.target)) return;
			const td = isElement(e.target) && e.target.closest<HTMLElement>(".dt-cell");
			if (!td || td.classList.contains("dt-cell--header")) return;
			this.activate(td);
		}, { signal });
		container.addEventListener("click", (e) => {
			// Likewise: clicking an awesomplete option or a picker day must not
			// be read as "the user clicked a cell" and commit the editor out
			// from under the selection they were making.
			if (insideEditorUI(e.target)) return;
			const td = isElement(e.target) && e.target.closest<HTMLElement>(".dt-cell");
			if (!td || td.classList.contains("dt-cell--header")) return;
			if (td !== this.$editingCell) this.deactivate(true);
			this.focus(td);
		}, { signal });
		// Keys are ./navigation.ts's (`onKeyDown`): Escape cancels, Enter
		// commits or opens, Tab commits and moves. This module used to bind
		// its own Enter/Escape too, which ran FIRST (bound earlier on the same
		// container) and closed the editor — so navigation's handler then saw
		// no editor open and re-opened it on the same keystroke.
	}
}
