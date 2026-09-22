// Expose `.page-head`'s actual, dynamic geometry to CSS as custom properties.
// Two consumers, both in desk/_page-head.scss and desk/_form.scss:
//
//  1. The rule between the breadcrumb trail and the title (desk/_page-head.scss)
//     used to be a border on the title's own `<li>` — which, like the pill
//     (title_indicator.ts), can only ever be as wide as that li's own box, not
//     the full head. A pseudo-element on `.page-head-content` draws it full
//     width instead, positioned at `--cf-trail-rule-top`: the title li's own
//     top edge, which is exactly where the trail's wrapped line(s) end,
//     however many there are (a short trail, a wrapped long one, a title that
//     itself wraps to two lines — all of it is just "wherever the li starts").
//
//  2. `.form-tabs-list` staying pinned below the header while the form scrolls
//     under it (frappe: desk/form.scss:484-485, ALREADY `position: sticky`)
//     needs a correct `top` offset to stick AT, not just the sticky
//     declaration — frappe's own `.form-tabs-sticky-up`/`-down` (desk/
//     form.scss:527-535) hardcode `top: calc(var(--navbar-height))`, which
//     only happens to be correct in stock frappe because `--page-head-height`
//     and `--navbar-height` are BOTH 48px there. Carbon's two-row breadcrumb
//     eyebrow + heading makes `.page-head` genuinely taller (measured: 96px on
//     an ordinary title, more on one that wraps) — sticking the tab bar at a
//     stale 48px means it sticks HALFWAY UP INSIDE the (taller, higher
//     z-index) header instead of below it. Confirmed live: exactly that —
//     scrolling left the tab bar's top half rendered behind `.page-head`,
//     which is what made it look like sticking "did not work" at all.
//     `--cf-page-head-height` is `.page-head`'s own measured height, and
//     desk/_form.scss overrides `.form-tabs-sticky-up`/`-down` to stick at
//     it instead of frappe's hardcoded (here, wrong) constant.
//
// Both need to react to `.page-head`'s SIZE, not just to route changes — a
// title that wraps to a second line, a badge that appears/disappears, a
// window resize that changes wrapping, all change this without a route
// change occurring. A ResizeObserver on `.page-head` itself covers every one
// of those causes at once, rather than re-measuring after guessing which
// events might have moved something.
import { record } from "./patch.ts";

function measure(pageHead: HTMLElement): void {
	const contentRect = pageHead.getBoundingClientRect();
	document.documentElement.style.setProperty("--cf-page-head-height", `${contentRect.height}px`);

	const lastCrumb = pageHead.querySelector<HTMLElement>(".page-title .navbar-breadcrumbs > li:last-child");
	const content = pageHead.querySelector<HTMLElement>(".page-head-content");
	if (!lastCrumb || !content) return;
	const top = lastCrumb.getBoundingClientRect().top - content.getBoundingClientRect().top;
	document.documentElement.style.setProperty("--cf-trail-rule-top", `${top}px`);
}

// One observer, reused for whichever `.page-head` is current — `.disconnect()`
// before re-observing so navigating to a DIFFERENT cached Page (frappe keeps
// one per doctype/view, only one ever `:visible`) does not leave the observer
// watching a hidden page's now-frozen size.
const observer = new ResizeObserver((entries) => {
	const entry = entries[0];
	if (entry) measure(entry.target as HTMLElement);
});

function attach(): boolean {
	// `:visible` is jQuery's own pseudo-class, not standard CSS — native
	// `document.querySelector` throws a SyntaxError on it rather than simply
	// not matching, which a bare `if (!pageHead)` here would never catch (the
	// throw unwinds past this function entirely, back out to the interval
	// callback below, silently — nothing surfaces a `SyntaxError` thrown
	// inside a `setInterval` tick as a console error). `$(...).get(0)` is the
	// idiom the rest of this file (and title_indicator.ts) already uses for
	// exactly this selector.
	const pageHead = $(".page-container:visible .page-head").get(0);
	if (!pageHead) return false;
	observer.disconnect();
	observer.observe(pageHead);
	measure(pageHead);
	return true;
}

// Route changes swap which `.page-head` is `:visible`; poll briefly the same
// way title_indicator.ts and editable_title.ts do, since the new one is not
// necessarily visible/rendered the instant the route event fires.
let timer: ReturnType<typeof setInterval> | null = null;
function attachSoon(): void {
	if (timer) clearInterval(timer);
	let tries = 0;
	timer = setInterval(() => {
		if (attach() || ++tries > 25) {
			if (timer) clearInterval(timer);
			timer = null;
		}
	}, 120);
}

const ok = !!(window.frappe && frappe.router && typeof frappe.router.on === "function");
if (ok) {
	frappe.router.on("change", attachSoon);
	$(document).ready(attachSoon);
}
record("page-head geometry exposed for the full-width rule and sticky tabs", ok);
