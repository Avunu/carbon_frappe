// Move frappe's status pill (`.indicator-pill`, e.g. "Enabled"/"Draft") from
// `.title-area` into the heading's own `<li>`, next to the title text.
//
// Why JS, not CSS: `.title-area` lays the breadcrumb trail and the pill out
// as flex SIBLINGS, with the trail (`.navbar-breadcrumbs`) sized by `flex:
// 0 1 auto`. `.navbar-breadcrumbs` is itself a flex container whose LAST li
// is forced onto its own line (`flex: 0 0 100%`, desk/_page-head.scss) to
// become the 28px heading — but a WRAPPING flex container's intrinsic width
// is computed as though nothing wrapped (every crumb plus the heading text,
// summed on one hypothetical unwrapped line), not as the widest of its
// actual wrapped rows. Measured live: even `width: fit-content` on
// `.navbar-breadcrumbs` still came back ~495px against a ~340px rendered
// heading — no CSS sizing keyword asks for "as wide as my widest wrapped
// line". The pill, sized against that inflated sibling width, ends up
// stranded far right of the heading it's meant to sit beside, and the
// heading's own border-top (`flex: 0 0 100%` of the same inflated box)
// draws partial-width for the same reason.
//
// Moving the pill INTO the heading's own li sidesteps the whole problem: a
// single-line flex row has no wrapped-content ambiguity to get wrong.
//
// `page.js:146` is what this leans on for the FIRST relocation: `this.indicator
// = this.wrapper.find(".title-area .indicator-pill")`, so the pill starts out
// reachable by a DOM search regardless of what `set_indicator()`/
// `clear_indicator()` did to its other classes (both strip `page-indicator-
// pill`, page.html's own template class, the first time either runs — a bare
// `.removeClass()` with no argument — which is why this targets
// `.indicator-pill`, not that one).
//
// After the FIRST relocation, a DOM search stops being enough: frappe's own
// breadcrumb rebuild (breadcrumbs.js:281, a bare `$(".navbar-breadcrumbs")
// .empty()`) DETACHES whatever is inside that `<ul>` on every route change —
// including the li this patch moved the pill into. Nothing in frappe ever
// re-attaches a detached indicator; that rebuild only ever expected its OWN
// crumb `<li>`s to live there. A `.find()` cannot locate a node that is no
// longer in the tree, so subsequent runs reach for frappe's own STABLE
// reference instead — `cur_frm.page.indicator` — which stays valid whether or
// not the node is currently attached, letting it be re-appended every route.
// Confirmed live: without this, the pill survived exactly one relocation and
// then silently vanished on the next in-app navigation.
import { record } from "./patch.ts";

function relocate(): boolean {
	const $container = $(".page-container:visible").first();
	const $lastCrumb = $container.find(".page-title .navbar-breadcrumbs > li:last-child").first();
	if (!$lastCrumb.length) return false;

	const frm = window.cur_frm;
	const $pill =
		frm && frm.page.indicator.length
			? frm.page.indicator
			: $container.find(".title-area .indicator-pill").first();
	if (!$pill.length) return false;

	// Idempotent by construction: `.append()` on a node already in the
	// document MOVES it rather than cloning, so calling this again this route
	// (or finding the pill already there) is a harmless no-op, not a stack.
	$lastCrumb.append($pill);
	return true;
}

// breadcrumbs.js rewrites the last crumb's innerHTML on every route change
// (see editable_title.ts's own note on the same element), which would strip
// a pill moved into it — so this polls after a route change the same way,
// rather than assuming one rewrite pass is the last.
let timer: ReturnType<typeof setInterval> | null = null;
function relocateSoon(): void {
	if (timer) clearInterval(timer);
	let tries = 0;
	timer = setInterval(() => {
		if (relocate() || ++tries > 25) {
			if (timer) clearInterval(timer);
			timer = null;
		}
	}, 120);
}

const ok = !!(window.frappe && frappe.router && typeof frappe.router.on === "function");
if (ok) {
	frappe.router.on("change", relocateSoon);
	$(document).ready(relocateSoon);
}
record("status pill relocated into the heading's own line", ok);
