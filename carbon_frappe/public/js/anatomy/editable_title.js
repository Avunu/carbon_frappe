// Make the page heading actually open the rename dialog when the document is
// renameable.
//
// Carbon's page header turns frappe's last breadcrumb into a 28px heading (see
// desk/_page-head.scss). frappe already marks a renameable document by putting
// `editable-title` on .title-area — but in v16 nothing binds a click to the
// title itself; the affordance is a pencil in the form sidebar, reached in two
// steps. At breadcrumb size that mismatch was invisible. At heading size a
// title that looks editable and does nothing is a worse lie, so the binding is
// made real.
//
// This uses frappe's OWN method rather than reimplementing rename:
// toolbar.setup_editable_title_click_event() is what the sidebar pencil calls,
// and it does `element.off("click").on("click", ...)`, so re-running it is
// safe. The sidebar pencil keeps working exactly as before — this adds a second
// route to the same dialog, it does not replace one.
import { record } from "./patch";

function bind() {
	const frm = window.cur_frm;
	const toolbar = frm && frm.toolbar;
	if (!toolbar || typeof toolbar.setup_editable_title_click_event !== "function") return false;

	const $container = $(".page-container:visible").first();
	const $area = $container.find(".title-area").first();
	if (!$area.length) return false;

	// frappe decides renameability; only follow it
	if (!$area.hasClass("editable-title")) return true;

	const $title = $area.find(".navbar-breadcrumbs > li:last-child > a").first();
	if (!$title.length) return false;

	// the last crumb is a link to the current page; clicking it should rename,
	// not navigate
	$title.attr("href", null);
	toolbar.setup_editable_title_click_event($title);
	return true;
}

let timer = null;
function bindSoon() {
	if (timer) clearInterval(timer);
	let tries = 0;
	timer = setInterval(() => {
		if (bind() || ++tries > 25) {
			clearInterval(timer);
			timer = null;
		}
	}, 120);
}

const ok = !!(window.frappe && frappe.router && typeof frappe.router.on === "function");
if (ok) {
	frappe.router.on("change", bindSoon);
	$(document).ready(bindSoon);
}
record("editable page title (frappe's own rename binding)", ok);
