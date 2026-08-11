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

	// frappe decides renameability; only follow it. NOT a success condition:
	// the class is added by frm.refresh() -> toolbar.refresh(), which can land
	// after the container becomes visible, so reporting "done" here stopped the
	// retry loop before the document was marked — and every list -> form
	// navigation arrived with the heading unbound. Keep polling instead; a
	// genuinely non-renameable document simply exhausts the tries in silence.
	if (!$area.hasClass("editable-title")) return false;

	const $title = $area.find(".navbar-breadcrumbs > li:last-child > a").first();
	if (!$title.length) return false;

	// the last crumb is a link to the current page; clicking it should rename,
	// not navigate
	$title.attr("href", null);

	// Carbon's Editable text reveals an edit glyph on the text it edits, and
	// that glyph is the whole affordance now that desk/_page-head.scss has
	// dropped the (wrong) link underline. Taken from frappe's own sprite —
	// the same "square-pen" the sidebar rename button uses — because CSS cannot
	// reach a sprite and inlining a Carbon glyph would be the one asset in this
	// theme not sourced from an @carbon package.
	//
	// Idempotent: breadcrumbs.js rewrites the crumb's innerHTML on every route
	// change, which drops the glyph and re-runs this; within a route it must not
	// stack a second one.
	if (!$title.children(".cf-title-edit").length && frappe.utils?.icon) {
		$title.append(
			`<span class="cf-title-edit" aria-hidden="true">${frappe.utils.icon(
				"square-pen",
				"sm"
			)}</span>`
		);
	}

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
