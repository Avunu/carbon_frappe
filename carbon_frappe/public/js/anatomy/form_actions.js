// Collect a form's actions into the one bar.
//
// frappe splits them across two siblings in .page-actions: .standard-actions
// (prev/next, menu, secondary, primary) and .custom-actions (the doctype's own
// actions — Create, workflow transitions). CSS pins .standard-actions to the
// bottom as Carbon's full-bleed action bar, which left .custom-actions behind
// in the page head, so a form's actions lived in two places at once.
//
// Moving the node rather than restyling it in place keeps frappe's handlers
// bound and lets the bar be a single flex row, so the primary stays outermost
// right with no width measuring.
import { record } from "./patch";

function collect() {
	const $container = $(".page-container:visible").first();
	if (!$container.length) return false;

	const $standard = $container.find(".page-head .standard-actions").first();
	const $custom = $container.find(".page-head .custom-actions").first();
	if (!$standard.length || !$custom.length) return false;

	// already collected
	if ($custom.parent().is($standard)) return true;

	// prepended so the doctype's actions read left of the navigation and
	// primary buttons, keeping the primary outermost right
	$standard.prepend($custom);
	return true;
}

let timer = null;
function collectSoon() {
	if (timer) clearInterval(timer);
	let tries = 0;
	timer = setInterval(() => {
		if (collect() || ++tries > 25) {
			clearInterval(timer);
			timer = null;
		}
	}, 80);
}

const ok = !!(window.frappe && frappe.router && typeof frappe.router.on === "function");
if (ok) {
	frappe.router.on("change", collectSoon);
	$(document).ready(collectSoon);
}
record("form action collection (.custom-actions -> the bar)", ok);
