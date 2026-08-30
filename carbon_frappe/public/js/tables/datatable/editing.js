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
//     `frappe.db.set_value` is in flight.

import { insideEditorUI } from "./navigation";

export default class CellEditing {
	constructor(host) {
		this.host = host;
		this.$editingCell = null;
		this.editor = null;
		this.editParent = null;
		this.oldValue = undefined;
		this.context = null;
	}

	/** The `.dt-cell__edit` mount point, created on demand inside the cell. */
	ensureEditParent(td, colIndex) {
		let parent = td.querySelector(":scope > .dt-cell__edit");
		if (!parent) {
			parent = document.createElement("div");
			parent.className = `dt-cell__edit dt-cell__edit--col-${colIndex}`;
			td.appendChild(parent);
		}
		parent.innerHTML = "";
		return parent;
	}

	activate(td) {
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

		let editor;
		if (typeof host.options.getEditor === "function") {
			editor = host.options.getEditor(colIndex, rowIndex, value, parent, column, row, data);
			if (editor === false) {
				parent.remove();
				return false;
			}
		}
		if (!editor) editor = this.defaultEditor(parent);

		this.$editingCell = td;
		this.editor = editor;
		this.editParent = parent;
		this.oldValue = value;
		this.context = { colIndex, rowIndex, column, cell };
		td.classList.add("dt-cell--editing");
		if (typeof editor.initValue === "function") editor.initValue(value, rowIndex, column);
		return true;
	}

	defaultEditor(parent) {
		const input = document.createElement("input");
		input.className = "dt-input";
		input.type = "text";
		parent.appendChild(input);
		return {
			initValue(value) {
				input.value = value == null ? "" : value;
				input.focus();
				input.select();
			},
			getValue() {
				return input.value;
			},
			setValue(value) {
				input.value = value == null ? "" : value;
			},
		};
	}

	/** Commit (or abandon) the open editor. Mirrors `deactivateEditing`. */
	deactivate(submitValue = true) {
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

	submit() {
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
			host.updateCell(colIndex, rowIndex, { content: value }, true);
			let result;
			try {
				result = editor.setValue ? editor.setValue(value, rowIndex, column) : undefined;
			} catch (e) {
				result = Promise.reject(e);
			}
			Promise.resolve(result).catch(() => {
				host.updateCell(colIndex, rowIndex, { content: oldValue }, true);
			});
		});
	}

	focus(td) {
		if (!td) return;
		const prev = this.host.container.querySelector(".dt-cell--focus");
		if (prev) prev.classList.remove("dt-cell--focus");
		td.classList.add("dt-cell--focus");
		this.focused = td;
	}

	unfocus() {
		if (this.focused) this.focused.classList.remove("dt-cell--focus");
		this.focused = null;
	}

	/** Wire double-click-to-edit and the Enter/Escape pair onto the container. */
	bind(container) {
		container.addEventListener("dblclick", (e) => {
			// A double click inside an open editor belongs to the control (text
			// selection, a date picker's day), not to the grid.
			if (insideEditorUI(e.target)) return;
			const td = e.target.closest && e.target.closest(".dt-cell");
			if (!td || td.classList.contains("dt-cell--header")) return;
			this.activate(td);
		});
		container.addEventListener("click", (e) => {
			// Likewise: clicking an awesomplete option or a picker day must not
			// be read as "the user clicked a cell" and commit the editor out
			// from under the selection they were making.
			if (insideEditorUI(e.target)) return;
			const td = e.target.closest && e.target.closest(".dt-cell");
			if (!td || td.classList.contains("dt-cell--header")) return;
			if (td !== this.$editingCell) this.deactivate(true);
			this.focus(td);
		});
		container.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && this.$editingCell) {
				this.deactivate(false);
				e.stopPropagation();
			} else if (e.key === "Enter" && this.$editingCell) {
				this.deactivate(true);
				e.stopPropagation();
			} else if (e.key === "Enter" && this.focused) {
				this.activate(this.focused);
				e.preventDefault();
			}
		});
	}
}
