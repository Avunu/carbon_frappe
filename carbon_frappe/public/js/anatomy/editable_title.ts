// Make the page heading actually open the rename dialog when the document is
// renameable.
//
// Carbon's page header turns frappe's last breadcrumb into a 28px heading (see
// desk/_page-head.scss). frappe already marks a renameable document by putting
// `editable-title` on .title-area (form/toolbar.js:76-79) — but nothing binds a
// click to the title itself; the affordance is a pencil in the form sidebar,
// reached in two steps. At breadcrumb size that mismatch was invisible. At
// heading size a title that looks editable and does nothing is a worse lie, so
// the binding is made real.
//
// This uses frappe's OWN method rather than reimplementing rename:
// toolbar.setup_editable_title_click_event() (toolbar.js:226) is what the
// sidebar pencil calls, and it does `element.off("click").on("click", ...)`, so
// re-running it is safe. The sidebar pencil keeps working exactly as before —
// this adds a second route to the same dialog, it does not replace one.
//
// WHEN it runs is the part that changed in frappe 16.50. The title used to be a
// node frappe wrote text into; it is now the last crumb of the trail, and
// `Page.render_breadcrumbs` (page.js:1019) EMPTIES the <ol> and builds every
// crumb again on each paint — so a glyph and a click handler placed on the crumb
// last until the next paint and no longer. The previous approach (poll for a few
// seconds after a route change) cannot know about a paint that comes later, so
// this wraps the one function that makes the crumbs and dresses the title as
// the last step of every paint.
//
// The paint that matters is the LAST one of a refresh, and it is the one that
// sees the right `editable-title` state: `Form.refresh_header` runs
// `toolbar.refresh()` first (whose `set_title` paints, THEN toggles the class,
// toolbar.js:70-79) and `page.set_breadcrumbs(...)` after it (form.js:810),
// which paints again with the class already settled. A paint that sees a stale
// class draws a title that the next paint replaces.
import type { Page } from "frappe-types";
import { edit16 } from "../generated/icons.ts";
import { safePatch } from "./patch.ts";

/**
 * The heading: the item of the trail's last <li>. It is a `span` — the current
 * page carries no link or handler (page.js:1053-1054 drops both) — which is why
 * it needs a role and a tab stop below to be an actual control.
 */
const TITLE = ".es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item";

function dress(page: Page): void {
	// the form on screen owns the page it was handed (formview.js:37), and the
	// toolbar is what holds frappe's rename dialog
	const frm = window.cur_frm;
	if (!frm || frm.page !== page) return;
	const toolbar = frm.toolbar;
	if (!toolbar || typeof toolbar.setup_editable_title_click_event !== "function") return;

	// frappe decides renameability; only follow it
	if (!page.$title_area.hasClass("editable-title")) return;

	const $title = page.$title_area.find(TITLE).first();
	if (!$title.length) return;

	// A span that opens a dialog is a button that happens to be drawn as a
	// heading. The glyph only shows on hover and focus, so without a tab stop
	// the keyboard has no way to the rename at all.
	$title.attr({ role: "button", tabindex: "0", "aria-haspopup": "dialog" });

	// Carbon's Editable text reveals an edit glyph on the text it edits, and
	// that glyph is the whole affordance now that desk/_page-head.scss has
	// dropped the (wrong) link underline. It is Carbon's own Edit glyph,
	// generated from @carbon/icons (scripts/generate-icons.ts), rather than
	// frappe's "square-pen" sprite icon: the sprite is frappe's to rename or
	// drop, and it paints by stroke, which the theme had to override.
	//
	// Guarded rather than assumed fresh: a caller may repaint through a path that
	// keeps the node (and this runs once per paint, not once per node).
	if (!$title.children(".cf-title-edit").length) {
		$title.append(`<span class="cf-title-edit" aria-hidden="true">${edit16}</span>`);
	}

	toolbar.setup_editable_title_click_event($title);

	// `off()` first: the node is new on every paint, but a repaint that reuses
	// it must not stack a second handler. Enter and Space are a button's keys.
	$title.off("keydown.cfTitle").on("keydown.cfTitle", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		$title.trigger("click");
	});
}

safePatch(
	() => window.frappe && frappe.ui && frappe.ui.Page && frappe.ui.Page.prototype,
	"render_breadcrumbs",
	(orig) =>
		function (this: Page): void {
			orig.call(this);
			// the title is cosmetic: whatever goes wrong here must not break the
			// paint frappe asked for
			try {
				dress(this);
			} catch (error) {
				console.error("carbon_frappe: editable title not applied", error);
			}
		},
	"Page.render_breadcrumbs (editable page title: frappe's own rename binding)",
);
