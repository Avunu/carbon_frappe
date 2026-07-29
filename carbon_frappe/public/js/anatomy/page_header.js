// Carbon page header: an eyebrow above a heading-04 title.
//
// There is no host element to style. page.set_title() writes into `a.title-text`
// — the LAST <li> of the breadcrumb list — and desk/_breadcrumbs.scss
// deliberately holds that at 14px breadcrumb size. So the 28/36 title has to be
// inserted.
//
// Driven by frappe.router's "change" event rather than a MutationObserver:
// it is deterministic, fires once per navigation, and ten frappe modules
// already subscribe to it.
import { record } from "./patch";

function decorate() {
	const $container = $(".page-container:visible").first();
	if (!$container.length) return false;

	// set_title() writes into a.title-text (the last breadcrumb), which is the
	// one place the current title is reliably readable — the page object is not
	// exposed on every wrapper.
	const title = $container.find(".title-area .title-text").first().text().trim();
	if (!title) return false;

	const $main = $container.find(".layout-main-section").first();
	if (!$main.length) return false;

	let $header = $main.children(".cf-page-header").first();
	if (!$header.length) {
		$header = $(
			'<div class="cf-page-header">' +
				'<div class="cf-page-eyebrow"></div>' +
				'<h1 class="cf-page-title"></h1>' +
				"</div>"
		);
		// page.js prepends .page-form (the filter toolbar) into .layout-main-section,
		// so inserting before it yields Carbon's order:
		//   breadcrumb rail -> h1 -> toolbar -> table
		const $form = $main.children(".page-form").first();
		if ($form.length) {
			$header.insertBefore($form);
		} else {
			$header.prependTo($main);
		}
	}

	$header.find(".cf-page-title").text(title);

	// Eyebrow: the parent breadcrumb, i.e. the section this page sits under.
	const crumbs = $container
		.find(".navbar-breadcrumbs li")
		.map((_, li) => $(li).text().trim())
		.get()
		.filter(Boolean);
	const eyebrow = crumbs.length > 1 ? crumbs[crumbs.length - 2] : "";
	$header.find(".cf-page-eyebrow").text(eyebrow).toggle(!!eyebrow);
	return true;
}

// router "change" fires BEFORE frappe has rendered the new page, so a single
// call finds no .layout-main-section and silently does nothing. Retry briefly
// until the page exists, then stop.
let timer = null;
function decorateSoon() {
	if (timer) clearInterval(timer);
	let tries = 0;
	timer = setInterval(() => {
		const done = decorate();
		if (done || ++tries > 25) {
			clearInterval(timer);
			timer = null;
		}
	}, 80);
}

const ok = !!(window.frappe && frappe.router && typeof frappe.router.on === "function");
if (ok) {
	frappe.router.on("change", decorateSoon);
	$(document).ready(decorateSoon);
}
record("frappe.router.on('change') (Carbon page header)", ok);
