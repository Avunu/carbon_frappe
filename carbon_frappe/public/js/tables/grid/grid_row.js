// CarbonGridRow — frappe's GridRow, rendering into the Carbon table engine.
//
// This subclass replaces only the DOM-PRODUCING half of GridRow. Everything
// else is inherited verbatim, which is the whole reason the ~30 GridRow members
// third-party code calls keep working:
//
//   inherited untouched — set_docfields, set_data, select, remove, insert, move,
//     refresh, refresh_field, refresh_check, refresh_dependency,
//     set_dependant_property, evaluate_depends_on_value, make_control,
//     set_arrow_keys, toggle_view, show_form, hide_form, has_prev/has_next,
//     open_prev/open_next, open_row_at_index, change_page_if_reqd, get_field,
//     set_field_property, toggle_reqd/display/editable, get_visible_columns,
//     the whole Configure Columns dialog, and GridRowForm.
//
//   replaced here — make() (a <tr> instead of two nested divs) and
//     setup_columns() (no Bootstrap 12-column cap).
//
// `make_column` is deliberately NOT overridden. It builds a
// `div.col.grid-static-col[data-fieldname][data-fieldtype]` carrying
// `.field-area` / `.static-area`, the awesomplete-repositioning focus handler,
// and the click-to-edit binding — all of which we want unchanged. The engine
// simply moves that div into the <td> it positions, so `grid_row.columns[f]`
// still points at the exact element frappe built and every
// `.grid-static-col[...]` selector still matches.
import GridRow from "frappe/public/js/frappe/form/grid_row";
import GridRowForm from "frappe/public/js/frappe/form/grid_row_form";

export default class CarbonGridRow extends GridRow {
	/**
	 * Build the row as a single <tr>.
	 *
	 * frappe nests `.grid-row > .data-row`; a table row cannot nest, so one
	 * element carries both class sets. `wrapper` and `row` are the same node —
	 * external code uses both names (`grid_row.wrapper` 6 sites,
	 * `grid_row.row` 4) and neither cares that they coincide.
	 *
	 * The row is NOT appended to a parent here: the engine owns placement, and
	 * appending would put it outside the <tbody> where the browser would hoist
	 * it out of the table.
	 */
	make() {
		const me = this;
		// frappe's row is `.grid-row > .data-row.row.m-0`. Both class sets move
		// onto the single <tr>, MINUS Bootstrap's `.row`: that is
		// `display: flex`, which blockifies every <td> and collapses the table
		// (measured: a 53px-wide row of 32px cells). Nothing selects `.row`
		// here — frappe's own grid rules key off `.data-row`.
		this.wrapper = $('<tr class="grid-row data-row"></tr>');
		this.row = this.wrapper;

		this.wrapper.on("click", function (e) {
			if (
				$(e.target).hasClass("grid-row-check") ||
				$(e.target).hasClass("row-index") ||
				$(e.target).parent().hasClass("row-index")
			) {
				return;
			}
			if (me.grid.allow_on_grid_editing() && me.grid.is_editable()) {
				// in-place editing handles the click
			} else {
				me.toggle_view();
				return false;
			}
		});

		let render_row = true;
		if (this.grid.template && !this.grid.meta.editable_grid) {
			this.render_template();
		} else {
			render_row = this.render_row();
		}
		if (!render_row) return;
		this.set_data();
	}

	/**
	 * Inherit the whole column build, then undo the overflow hack.
	 *
	 * `super.setup_columns()` ends by setting `.column-limit-reached` on
	 * `.form-grid-container` whenever the column spans total more than 10 — the
	 * behaviour this project exists to remove. Because CarbonGrid hands out real
	 * pixel widths the total is effectively always over 10, so the class would
	 * latch on permanently and its stylesheet (common/grid.scss:765-846) would
	 * re-impose a `display: grid` layout on top of our table.
	 */
	setup_columns() {
		super.setup_columns();
		if (this.grid.wrapper) {
			this.grid.wrapper.find(".form-grid-container").removeClass("column-limit-reached");
		}
	}

	/**
	 * The <tr> that hosts the expanded detail form, created on demand.
	 *
	 * frappe's `GridRowForm` constructor does
	 * `$('<div class="form-in-grid">').appendTo(this.row.wrapper)`, and
	 * `show_form()` then calls `this.row.toggle(false)` to hide the data row and
	 * reveal the form in its place. That works when `wrapper` (`.grid-row`) and
	 * `row` (`.data-row`) are two nested divs — the form is a sibling of the
	 * hidden row. Here they are one <tr>, so the form was appended INSIDE the
	 * row that then got hidden: the page froze behind the overlay and no form
	 * ever appeared.
	 *
	 * A table cannot nest rows, so the form gets its own <tr> immediately after
	 * the data row. That row is a DOM HOST, not a visual expansion: frappe's
	 * grid form is a centered modal — `.grid-row-open .form-in-grid` is
	 * `position: fixed; top: 5%; left: 50%; width: 80%` (common/grid.scss:533),
	 * which is what the `frappe.dom.freeze()` backdrop is for. So the row is
	 * collapsed to zero height and only exists to (a) keep `.form-in-grid` in the
	 * grid's DOM subtree and (b) carry `.grid-row-open`, which is the selector
	 * that reveals the form and that `.form-grid-container:has(.grid-row-open)`
	 * also keys off.
	 */
	ensure_form_host() {
		if (!this.form_row) {
			this.form_row = document.createElement("tr");
			this.form_row.className = "grid-row grid-row-form";
			this.form_cell = document.createElement("td");
			this.form_row.appendChild(this.form_cell);
		}
		const columns = this.grid.carbon_table
			? this.grid.carbon_table.table.getVisibleLeafColumns().length
			: 1;
		this.form_cell.setAttribute("colspan", columns);
		return this.form_cell;
	}

	show_form() {
		const host = this.ensure_form_host();
		// Build the form BEFORE super runs, so its wrapper can be relocated out
		// of the <tr> and into the addendum cell; super then finds it already
		// created and only renders into it.
		if (!this.grid_form) {
			this.grid_form = new GridRowForm({ row: this });
		}
		if (this.grid_form.wrapper.parent().get(0) !== host) {
			this.grid_form.wrapper.appendTo(host);
		}
		this.form_row.style.display = "";

		super.show_form();

		// `.grid-row-open` is what turns `.form-in-grid` from `height: 0` into
		// the visible modal. super put it on `this.wrapper`, which it then hid
		// via `this.row.toggle(false)` — and wrapper and row are one <tr> here,
		// so the form went dark with the row. The addendum row carries the class
		// as well, and the same `grid_row` data, so
		// `$(".grid-row-open").data("grid_row")` (layout.js:712,
		// ui/keyboard.js:335) resolves from either element.
		this.form_row.classList.add("grid-row-open");
		$(this.form_row).data({ grid_row: this, doc: this.doc || "" });

		// super toggles these through `this.wrapper.find(...)`, which no longer
		// contains the form. Re-apply against the host it actually lives in.
		const cannot_add_rows =
			this.grid.cannot_add_rows || (this.grid.df && this.grid.df.cannot_add_rows);
		$(host)
			.find(".grid-insert-row-below, .grid-insert-row, .grid-duplicate-row, .grid-append-row")
			.toggle(!cannot_add_rows);
		$(host)
			.find(".grid-delete-row")
			.toggle(!(this.grid.df && this.grid.df.cannot_delete_rows));

		// The addendum row is placed by the engine's render pass; nothing in
		// frappe's show_form() triggers one, so the form would stay detached.
		this.grid.carbon_table && this.grid.carbon_table.render();
	}

	hide_form() {
		super.hide_form();
		if (this.form_row) {
			this.form_row.classList.remove("grid-row-open");
			this.form_row.style.display = "none";
		}
		this.grid.carbon_table && this.grid.carbon_table.render();
	}

	/**
	 * Capture the OUTER `.col` of the open-form button.
	 *
	 * frappe's implementation creates a wrapper `.col`, then REASSIGNS
	 * `this.open_form_button` to the inner `.btn-open-row`, leaving the cell
	 * itself reachable only as `.parent()`. The engine needs the cell.
	 */
	add_open_form_button() {
		super.add_open_form_button();
		if (this.open_form_button && this.open_form_button.length) {
			this.open_form_cell = this.open_form_button.hasClass("col")
				? this.open_form_button
				: this.open_form_button.parent();
		}
	}

	/** The cell element for a fieldname, for the engine to place. */
	get_column_node(fieldname) {
		const $col = this.columns[fieldname];
		return $col && $col.length ? $col.get(0) : null;
	}
}
