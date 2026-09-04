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
import CarbonGrid, { frmOption } from "./grid";
import type { ControlTable } from "frappe-types";

export default function installGrid(): void {
	if (!window.frappe || !frappe.ui || !frappe.ui.form) return;

	safePatch(
		() => frappe.ui.form.ControlTable && frappe.ui.form.ControlTable.prototype,
		"make",
		(orig) =>
			// The `this` parameter is the whole of the annotation, and it erases:
			// `safePatch` hands the replacement straight back to frappe, which
			// calls it as `control.make()`, so the receiver IS a `ControlTable`.
			// Spelling it is required rather than cosmetic — a class method's
			// type carries no implicit `this`, so there is nothing for the
			// compiler to infer one from and `noImplicitThis` rejects the bare
			// `function`. See safePatch's own doc comment.
			function (this: ControlTable) {
				orig.call(this);
				// Narrower than `ControlTable#grid`'s declared `Grid`, which is
				// exactly the point of the swap and exactly why frappe-types
				// declares the Grid family ONCE (deep-modules.d.ts) and
				// re-exports it from `frappe.ui.form`: the `Grid` that
				// `CarbonGrid extends` and the `Grid` this property holds are
				// the same type, so a subclass is assignable with no cast.
				this.grid = new CarbonGrid({
					// `...frmOption(this.frm)` rather than `frm: this.frm`:
					// `GridOptions#frm` is optional, so under
					// `exactOptionalPropertyTypes` the key may be absent but not
					// present-and-`undefined`. Same instance shape either way —
					// `Grid`'s constructor is `$.extend(this, opts)`, which
					// skips an `undefined` value. See `frmOption` in ./grid.
					...frmOption(this.frm),
					df: this.df,
					parent: this.wrapper,
					control: this,
				});
			},
		"frappe.ui.form.ControlTable.prototype.make (CarbonGrid)"
	);
}
