// Report view / query report row height -> Carbon lg (48px), matching the list
// view so a doctype reads the same in either view.
//
// This needs BOTH halves and neither works alone:
//
//   CSS  — frappe pins `.datatable .dt-row { height: 35px }` as a STATIC rule in
//          its own scss (not the stylesheet frappe-datatable injects), so
//          datatable.style.setCellHeight() cannot beat it. Overridden in
//          desk/_datatable.scss.
//   JS   — frappe-datatable's virtual scroller absolutely positions every row
//          from options.cellHeight. Change the CSS alone and rows render 48px
//          while the scroller still strides 35px, so they overlap.
//
// The patch target is NOT frappe.DataTable.prototype, despite ui/datatable.js
// doing `frappe.DataTable = DataTable`. esbuild bundles two separate copies of
// frappe-datatable into the desk bundle: frappe.DataTable resolves to one
// (DataTable2) while report_view.js's module-local import instantiates the
// other (DataTable3). Verified at runtime —
// `cur_list.datatable.constructor === frappe.DataTable` is false. Patching the
// prototype therefore applies cleanly and does nothing at all.
//
// So the option is set on the instance instead, via the one method that
// constructs it.
import { safePatch } from "./patch";

// Carbon data-table lg. Kept in sync with --list-row-height (desk/_list.scss)
// and the .dt-row height in desk/_datatable.scss.
const CARBON_ROW_HEIGHT = 48;

function applyRowHeight(datatable) {
	if (!datatable || !datatable.options) return;
	if (datatable.options.cellHeight === CARBON_ROW_HEIGHT) return;

	datatable.options.cellHeight = CARBON_ROW_HEIGHT;
	try {
		// keeps the injected .dt-cell__content rule in step with the CSS override
		datatable.style.setCellHeight(CARBON_ROW_HEIGHT);
		// The constructor has already absolutely-positioned every row from the old
		// height, so the option alone leaves the scroller striding 35px under 48px
		// rows. refresh() is the public re-layout; verified to restride to 48
		// without dropping data.
		datatable.refresh();
	} catch (e) {
		/* leave frappe's layout alone rather than half-applying */
	}
}

safePatch(
	() => window.frappe && frappe.views && frappe.views.ReportView && frappe.views.ReportView.prototype,
	"setup_datatable",
	(orig) =>
		function (values) {
			const out = orig.call(this, values);
			applyRowHeight(this.datatable);
			return out;
		},
	"frappe.views.ReportView.prototype.setup_datatable (48px report rows)"
);
