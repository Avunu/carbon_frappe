// Install CarbonGrid as the child-table control's grid.
//
// `Grid` is a module-private default export of frappe/form/grid.js — there is no
// `frappe.ui.form.Grid` global to reassign. But `frappe.ui.form.ControlTable`
// IS global, and it is the only place in core that constructs a Grid
// (form/controls/table.js:8).
//
// The swap is three lines because of one detail of frappe's design: `Grid`'s
// CONSTRUCTOR builds no DOM. It only does `$.extend(this, opts)` and derives
// `doctype` / `meta` / `fields_map`; `Grid.make()` is lazy, called from
// `refresh()` (`!this.wrapper && this.make()`). So letting the base `make()` run
// and then replacing `this.grid` costs nothing and discards nothing.
//
// Everything else in `ControlTable.make()` is inherited, including the ~90-line
// clipboard-paste handler — which reads `this.grid` at event time rather than
// closing over it, so it picks up CarbonGrid without modification.
import { safePatch } from "../../anatomy/patch";
import CarbonGrid from "./grid";

export default function installGrid() {
	if (!window.frappe || !frappe.ui || !frappe.ui.form) return;

	safePatch(
		() => frappe.ui.form.ControlTable && frappe.ui.form.ControlTable.prototype,
		"make",
		(orig) =>
			function () {
				orig.call(this);
				this.grid = new CarbonGrid({
					frm: this.frm,
					df: this.df,
					parent: this.wrapper,
					control: this,
				});
			},
		"frappe.ui.form.ControlTable.prototype.make (CarbonGrid)"
	);
}
