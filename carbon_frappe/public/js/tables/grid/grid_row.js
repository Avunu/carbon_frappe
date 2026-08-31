// CarbonGridRow — frappe's GridRow, rendering into the Carbon table engine.
//
// This subclass replaces only the DOM-PRODUCING half of GridRow. Everything
// else is inherited verbatim, which is the whole reason the ~30 GridRow members
// third-party code calls keep working:
//
//   inherited untouched — set_docfields, set_data, select, remove, insert, move,
//     refresh, refresh_field, refresh_check, refresh_dependency,
//     set_dependant_property, evaluate_depends_on_value, make_control,
//     set_arrow_keys, has_prev/has_next, open_prev/open_next,
//     open_row_at_index, change_page_if_reqd, get_field, set_field_property,
//     toggle_reqd/display/editable, get_visible_columns, the whole Configure
//     Columns dialog, and GridRowForm.
//
//   replaced here — make() (a <tr> instead of two nested divs), setup_columns()
//     (no Bootstrap 12-column cap), and show_form()/hide_form(), which turn
//     frappe's centered pseudo-modal into a Carbon expandable row.
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
import { ensureChildRow, expandButton, syncExpandState } from "./expand";
import { rowMenuButton } from "./row_menu";

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
	 * The per-column search inputs, always built.
	 *
	 * frappe hides the filter row below `rows_threshold_for_grid_search` (20)
	 * and — the part that matters — REMOVES the row's wrapper when it decides
	 * not to show it, so `search_columns` is never populated. The Carbon
	 * toolbar's magnifier owns that visibility now (tables/grid/toolbar.js), and
	 * it has to be able to reveal the row at any row count, so the row is always
	 * constructed. `this.show_search` is left truthy because `render_row()`
	 * branches on it to build search cells rather than data cells.
	 */
	show_search_row() {
		return !!this.show_search;
	}

	/**
	 * Also stamp the row number into the detail panel.
	 *
	 * frappe writes `.row-index span, .grid-form-row-index` through
	 * `this.wrapper.find(...)`, and the panel is no longer inside the row's
	 * <tr> — it is the sibling child row — so the "Editing Row #" heading came
	 * up blank.
	 */
	set_row_index() {
		super.set_row_index();
		if (this.doc && this.doc.idx !== undefined && this.form_row) {
			$(this.form_row).find(".grid-form-row-index").html(this.doc.idx);
		}
	}

	/** True while this row's detail panel is open. */
	is_expanded() {
		return !!(this.wrapper && this.wrapper.hasClass("grid-row-open"));
	}

	// ------------------------------------------------------- expandable anatomy

	/**
	 * The child row's inner container, which is where the detail form lives.
	 *
	 * Kept under frappe's old name as well (`ensure_form_host`) because the
	 * shape of this method is what the grid test suite asserts against.
	 */
	ensure_form_host() {
		return ensureChildRow(this);
	}

	/** `_expand` column content — the chevron. */
	expand_node() {
		return expandButton(this);
	}

	/**
	 * `_menu` column content — the `⋮` overflow menu.
	 *
	 * It reuses frappe's own trailing cell when there is one so that
	 * `open_form_button.parent().focus()` (grid_row.js:1533, and the global
	 * `$(document).on("escape")` handler) still lands somewhere real. When
	 * `df.in_place_edit` suppresses that cell, we make our own.
	 */
	menu_node() {
		if (!this.menu_cell) {
			this.menu_cell =
				this.open_form_cell && this.open_form_cell.length
					? this.open_form_cell.get(0)
					: document.createElement("div");
			this.menu_cell.classList.add("cf-grid__row-menu-cell");
		}
		const button = rowMenuButton(this);
		if (button.parentNode !== this.menu_cell) this.menu_cell.appendChild(button);
		return this.menu_cell;
	}

	// ------------------------------------------------------------- detail panel

	/**
	 * Accepts a third argument frappe does not have: `{ modal: true }` opens the
	 * row in the legacy centered dialog instead of the inline panel. It is the
	 * escape hatch the row menu's "Open in dialog" item uses, for child doctypes
	 * whose form is too tall to read inside a table row.
	 *
	 * Only the REQUEST is recorded here, and only when this call could open the
	 * row. How the row is actually displayed is latched in `show_form()` and
	 * read back in `hide_form()`, because the two have to agree about the freeze
	 * count and a close can arrive from somewhere that knows nothing about the
	 * mode: `super.toggle_view(true)` on a DIFFERENT row closes this one by
	 * calling `this.toggle_view(false)` (grid_row.js:1452). Resetting the flag
	 * there left `hide_form()` thinking an open modal was inline, so it added a
	 * counterweight freeze that super's unfreeze then only half-removed — and
	 * the backdrop stayed up over the whole desk.
	 */
	toggle_view(show, callback, opts) {
		if (opts && opts.modal !== undefined) this._request_modal = !!opts.modal;
		else if (show === true) this._request_modal = false;
		return super.toggle_view(show, callback);
	}

	/**
	 * Open the row as a Carbon expandable row.
	 *
	 * frappe's show_form() is built for a modal and does three things that are
	 * wrong here; each is undone immediately after `super` rather than
	 * reimplemented, so the script triggers, the Layout build and the
	 * `cur_frm.cur_grid` bookkeeping in between stay frappe's:
	 *
	 *   1. `GridRowForm`'s constructor appends `.form-in-grid` to
	 *      `this.row.wrapper` — our <tr>. It is built here first, so it can be
	 *      relocated into the child row before super renders into it.
	 *   2. `this.row.toggle(false)` hides the data row, because upstream the
	 *      form is a SIBLING of the row inside `.grid-row`. Here they are one
	 *      <tr>, and Carbon keeps the parent row visible above the panel.
	 *   3. `frappe.dom.freeze()` raises a modal backdrop. Inline needs none —
	 *      but `hide_form()` unconditionally unfreezes, so the count has to be
	 *      balanced rather than skipped (frappe.dom.freeze_count, dom.js:172).
	 */
	show_form() {
		const host = this.ensure_form_host();
		if (!this.grid_form) {
			this.grid_form = new GridRowForm({ row: this });
		}
		if (this.grid_form.wrapper.parent().get(0) !== host) {
			this.grid_form.wrapper.appendTo(host);
		}

		super.show_form();
		this.set_row_index();

		// Latch the mode for the matching hide_form().
		this._modal_form = !!this._request_modal;
		const modal = this._modal_form;

		// (2) the parent row stays visible — Carbon's expandable row shows the
		// summary above the panel, and `.grid-row-open` now sits on a node the
		// user can actually see, which is also where frappe expects it
		// (`$('.grid-row-open').data('grid_row')` — layout.js:712,
		// ui/keyboard.js:335).
		this.wrapper.show();

		// (3) balance super's freeze unless we actually want the backdrop.
		if (!modal) frappe.dom.unfreeze();

		// super's `frappe.utils.is_xs()` branch pins the grid to `min-width: 0`
		// and `position: unset` so a modal can escape it. The inline panel lives
		// inside the table and wants neither.
		$(this.grid.form_grid).css({ "min-width": "", position: "" });

		$(this.grid.wrapper).toggleClass("cf-grid--modal-form", modal);

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

		syncExpandState(this, true);
		if (this.grid.carbon_table) {
			this.grid.carbon_table.setExpandedRow(this.doc && this.doc.name);
			this.grid.carbon_table.render();
		}
	}

	hide_form() {
		const modal = !!this._modal_form;
		// Counterweight to super's unconditional `frappe.dom.unfreeze()`. In
		// modal mode super's own freeze from show_form() is still standing and
		// this one would be one too many.
		if (!modal) frappe.dom.freeze("", "dark grid-form");

		super.hide_form();

		this._modal_form = false;
		this._request_modal = false;
		$(this.grid.wrapper).removeClass("cf-grid--modal-form");
		$(this.grid.form_grid).css({ "min-width": "", position: "" });

		syncExpandState(this, false);
		if (this.grid.carbon_table) {
			this.grid.carbon_table.setExpandedRow(null);
			this.grid.carbon_table.render();
		}
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
