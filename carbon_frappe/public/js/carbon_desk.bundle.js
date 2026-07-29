// carbon_frappe desk shim — tags formatted data values with `carbon-num` so the
// stylesheet can set IBM Plex Mono on them.
//
// Why JS at all: most numerics are reachable from CSS (list rows carry
// .text-right, grid cells carry [data-fieldtype]), but frappe-datatable — the
// report view, query reports, data import preview — emits only positional
// classes (.dt-cell--col-N) with no fieldtype or alignment hook. Alignment there
// comes from a stylesheet frappe injects at runtime, which CSS cannot read. The
// one thing every numeric render path DOES share is frappe.form.formatters, so
// tagging at the formatter reaches all of them at once.
//
// Both patches delegate to the original, so upstream behaviour changes carry
// through and re-applying is a no-op.

function patchFormatters() {
	const f = window.frappe && frappe.form && frappe.form.formatters;
	if (!f || f.__carbon_frappe) return false;

	// _right() wraps every Currency / Float / Int / Percent / Duration value in
	// <div style='text-align: right'>. Give that wrapper a class so the CSS hook
	// is a class rather than an inline-style substring match.
	const _right = f._right;
	if (typeof _right === "function") {
		f._right = function (value, options) {
			const out = _right.call(this, value, options);
			return typeof out === "string" && out.startsWith("<div ")
				? out.replace("<div ", '<div class="carbon-num" ')
				: out;
		};
	}

	// Dates are the gap CSS can't cover: formatters.Date returns a bare string,
	// so datatable date cells have no hook at all. Wrap them.
	for (const type of ["Date", "Datetime", "Time"]) {
		const orig = f[type];
		if (typeof orig !== "function") continue;
		f[type] = function (...args) {
			const out = orig.apply(this, args);
			return typeof out === "string" && out
				? `<span class="carbon-num">${out}</span>`
				: out;
		};
	}

	f.__carbon_frappe = true;
	return true;
}

if (!patchFormatters()) {
	document.addEventListener("DOMContentLoaded", patchFormatters);
}
