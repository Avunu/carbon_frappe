// Copyright (c) 2026, Avunu LLC and contributors
// For license information, please see license.txt

frappe.ui.form.on("Carbon Settings", {
	refresh(frm) {
		frm.add_custom_button(__("View Stylesheet"), () => {
			window.open("/carbon-brand.css", "_blank");
		});
	},
});
