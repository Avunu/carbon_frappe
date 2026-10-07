// Page head — the breadcrumb trail as a Carbon eyebrow and heading, the status
// tag beside it, the editable title, the page actions, and the menu and dialog
// that sit next to them.
//
// Every assertion is a contract the theme keeps with frappe 16.50's markup (the
// trail is `nav.es-breadcrumbs > ol > li > .es-breadcrumbs__item`, the status a
// sibling `.page-indicator-pill` badge, the buttons es-buttons, the menus
// `.es-menu` panels portaled to <body>) or with Carbon's anatomy that styles it.
// The fixtures are documents every site has, read and never saved: the Role form
// "System Manager" for a renameable title with an "Enabled" status, the Language
// "en" for a status derived from a document whose title cannot be renamed, and the
// Role list for a page with no
// eyebrow. The status colours of the other states are set on the live page head
// (`page.set_indicator`), which is DOM state only.
import { createRequire } from "node:module";
import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "../tables/cdp.ts";
import type { Page } from "../tables/cdp.ts";

const BASE = process.env["CF_SITE_URL"] || "http://localhost:8794";
const SHOT = process.env["CF_SHOT_DIR"] || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });

const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
const ok = (n: string, c: unknown, x = ""): void => {
	results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- Carbon's own constants ---------------------------------------------------
// The tag colours are read from the pinned @carbon/colors rather than typed in:
// Carbon's tag is `<c>-20` on `<c>-70` text in g10 and `<c>-80` on `<c>-30` in
// g100 (tag/_tag-tokens.scss), so a version bump that moves a step moves this.
const require = createRequire(import.meta.url);
const carbonColors: unknown = require("@carbon/colors");

function carbonHex(name: string): string {
	if (typeof carbonColors !== "object" || carbonColors === null)
		throw new Error("@carbon/colors did not load");
	const value = Reflect.get(carbonColors, name);
	if (typeof value !== "string") throw new Error(`@carbon/colors has no ${name}`);
	return value;
}

/** `#d0e2ff` as the `rgb(208, 226, 255)` a computed style reports. */
function rgb(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

interface TagTheme {
	/** what frappe writes into `data-theme` for this indicator colour */
	readonly colour: string;
	/** the Carbon scale it must land on */
	readonly scale: string;
}

/**
 * The status colours frappe's own indicators use: Draft and Cancelled are red,
 * Submitted blue, Paid green. Carbon has no orange or yellow TAG, so those are
 * left to the theme's own decision for them (map/_colors-palette.scss: the amber
 * ramp is Carbon's yellow) and not asserted here.
 */
const TAGS: ReadonlyArray<readonly [label: string, theme: TagTheme]> = [
	["Draft", { colour: "red", scale: "red" }],
	["Submitted", { colour: "blue", scale: "blue" }],
	["Cancelled", { colour: "red", scale: "red" }],
	["Paid", { colour: "green", scale: "green" }],
];

// -- helpers ---------------------------------------------------------------------
async function viewport(p: Page, width: number, height: number, mobile = false): Promise<void> {
	await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
	await sleep(400);
}

async function clip(p: Page, file: string, height: number): Promise<void> {
	const r = await p.send("Page.captureScreenshot", {
		format: "png",
		clip: { x: 0, y: 0, width: 1600, height, scale: 1 },
	});
	const data = typeof r === "object" && r !== null ? Reflect.get(r, "data") : undefined;
	if (typeof data !== "string") throw new Error(`no screenshot data for ${file}`);
	fs.writeFileSync(file, Buffer.from(data, "base64"));
}

async function theme(p: Page, name: "light" | "dark"): Promise<void> {
	await p.eval(`document.documentElement.setAttribute('data-theme', '${name}')`);
	await sleep(500);
}

/** A real pointer click: CSS :hover and focus only respond to the input domain. */
async function click(p: Page, x: number, y: number): Promise<void> {
	await p.hover(x, y);
	const at = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
	await p.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...at });
	await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...at });
	await sleep(250);
}

async function key(p: Page, keyName: string, code = keyName): Promise<void> {
	const text = keyName === "Enter" ? "\r" : keyName === " " ? " " : undefined;
	await p.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		key: keyName,
		code,
		...(text ? { text } : {}),
	});
	await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code });
	await sleep(200);
}

/** Wait for a desk route's page head, with its trail painted, to be on screen. */
async function openRoute(p: Page, route: string, trailLength: number): Promise<void> {
	await p.goto(`${BASE}${route}`);
	await p.waitFor(
		`$('.page-container:visible .page-head .es-breadcrumbs > ol > li').length === ${trailLength}`,
		{ timeout: 90000 },
	);
	// the form paints the trail twice (toolbar, then set_breadcrumbs); the late
	// paint is the one under test, so let it land
	await sleep(1500);
}

// -- what the page says about itself ---------------------------------------------
interface HeadState {
	crumbs: Array<{ tag: string; cls: string; href: string | null; current: string | null; text: string }>;
	navTag: string;
	navIsDirectChildOfTitleArea: boolean;
	olIsList: boolean;
	oldMarkup: boolean;
	eyebrow: { color: string; fontSize: string; fontWeight: string; underline: string } | null;
	lastDivider: string;
	heading: {
		tag: string;
		fontSize: string;
		lineHeight: string;
		fontWeight: string;
		color: string;
		top: number;
		bottom: number;
		left: number;
		right: number;
		text: string;
	};
	eyebrowBottom: number | null;
	rule: { property: string; content: string; liTop: number };
	pill: {
		insideOl: boolean;
		parentIsTitleArea: boolean;
		display: string;
		text: string;
		theme: string | null;
		classes: string;
		left: number;
		top: number;
		bottom: number;
		height: number;
		radius: string;
		fontSize: string;
		bg: string;
		color: string;
	} | null;
	row: { top: number; bottom: number };
	patched: boolean;
}

const HEAD = `(() => {
	const $c = $('.page-container:visible').first();
	const area = $c.find('.title-area')[0];
	const nav = area.querySelector('nav.es-breadcrumbs');
	const ol = nav && nav.querySelector(':scope > ol');
	const lis = ol ? [...ol.querySelectorAll(':scope > li')] : [];
	const items = lis.map(li => li.firstElementChild);
	const last = lis[lis.length - 1];
	const item = items[items.length - 1];
	const cs = (el, pseudo) => getComputedStyle(el, pseudo);
	const rect = (el) => el.getBoundingClientRect();
	const content = $c.find('.page-head-content')[0];
	const first = lis.length > 1 ? items[0] : null;
	const pillEl = area.querySelector('.page-indicator-pill');
	const pillVisible = pillEl && cs(pillEl).display !== 'none';
	const row = rect(last);
	return {
		crumbs: items.map(el => ({ tag: el.tagName.toLowerCase(), cls: el.className, href: el.getAttribute('href'), current: el.getAttribute('aria-current'), text: el.textContent.trim() })),
		navTag: nav ? nav.tagName.toLowerCase() : '',
		navIsDirectChildOfTitleArea: !!nav && nav.parentElement === area,
		olIsList: !!ol && ol.tagName === 'OL' && cs(ol).listStyleType === 'none',
		oldMarkup: !!area.querySelector('ul.navbar-breadcrumbs, .title-text, .title-text-form, .indicator-pill'),
		eyebrow: first ? { color: cs(first).color, fontSize: cs(first).fontSize, fontWeight: cs(first).fontWeight, underline: cs(first).textDecorationLine } : null,
		lastDivider: cs(last, '::before').content,
		heading: { tag: item.tagName.toLowerCase(), fontSize: cs(item).fontSize, lineHeight: cs(item).lineHeight, fontWeight: cs(item).fontWeight, color: cs(item).color,
			top: rect(item).top, bottom: rect(item).bottom, left: rect(item).left, right: rect(item).right, text: item.textContent.trim() },
		eyebrowBottom: first ? rect(first).bottom : null,
		rule: { property: getComputedStyle(document.documentElement).getPropertyValue('--cf-trail-rule-top').trim(), content: cs(content, '::before').content, liTop: rect(last).top - rect(content).top },
		pill: pillVisible ? { insideOl: !!ol && ol.contains(pillEl), parentIsTitleArea: pillEl.parentElement === area, display: cs(pillEl).display, text: pillEl.textContent.trim(),
			theme: pillEl.getAttribute('data-theme'), classes: pillEl.className, left: rect(pillEl).left, top: rect(pillEl).top, bottom: rect(pillEl).bottom, height: rect(pillEl).height,
			radius: cs(pillEl).borderTopLeftRadius, fontSize: cs(pillEl).fontSize, bg: cs(pillEl).backgroundColor, color: cs(pillEl).color } : null,
		row: { top: row.top, bottom: row.bottom },
		patched: !!(frappe.ui.Page.prototype.render_breadcrumbs && frappe.ui.Page.prototype.render_breadcrumbs.__carbon_frappe),
	};
})()`;

/** A token as the colour a computed style reports. */
const TOKEN = (name: string): string => `(() => {
	const s = document.createElement('span'); s.style.color = 'var(${name})'; document.body.appendChild(s);
	const c = getComputedStyle(s).color; s.remove(); return c;
})()`;

try {
	await login(page, BASE);
	await viewport(page, 1600, 1000);

	// -- 1. the trail on a form --------------------------------------------------
	await openRoute(page, "/desk/role/System%20Manager", 2);
	await assertCarbonStylesheet(page);
	const form = await page.eval<HeadState>(HEAD);
	const linkPrimary = await page.eval<string>(TOKEN("--cds-link-primary"));
	const textPrimary = await page.eval<string>(TOKEN("--cds-text-primary"));
	const textSecondary = await page.eval<string>(TOKEN("--cds-text-secondary"));

	ok(
		"the trail is nav.es-breadcrumbs > ol > li with a link to the list and the page as the last crumb",
		form.navTag === "nav" &&
			form.olIsList &&
			form.crumbs.length === 2 &&
			form.crumbs[0]?.tag === "a" &&
			form.crumbs[0]?.href === "/desk/role" &&
			form.crumbs[0]?.cls === "es-breadcrumbs__item" &&
			form.crumbs[1]?.tag === "span" &&
			form.crumbs[1]?.current === "page" &&
			form.crumbs[1]?.href === null &&
			form.crumbs[1]?.text === "System Manager",
		JSON.stringify(form.crumbs),
	);
	ok("none of the pre-16.50 markup is left in the title area", !form.oldMarkup);
	ok("the theme's render_breadcrumbs patch took", form.patched);
	ok(
		"the parent crumb is a Carbon breadcrumb link: $link-primary, 14px, regular, no underline",
		form.eyebrow !== null &&
			form.eyebrow.color === linkPrimary &&
			form.eyebrow.fontSize === "14px" &&
			form.eyebrow.fontWeight === "400" &&
			form.eyebrow.underline === "none",
		JSON.stringify(form.eyebrow),
	);
	ok(
		'no divider sits before the heading: the "/" is for a trail, not for the page under it',
		form.lastDivider === "none",
		form.lastDivider,
	);
	ok(
		"the page is Carbon heading-04: 28px / 36px, regular, $text-primary, a span (not a link)",
		form.heading.tag === "span" &&
			form.heading.fontSize === "28px" &&
			form.heading.lineHeight === "36px" &&
			form.heading.fontWeight === "400" &&
			form.heading.color === textPrimary,
		JSON.stringify(form.heading),
	);
	ok(
		"the heading drops to its own line under the eyebrow",
		form.eyebrowBottom !== null && form.heading.top >= form.eyebrowBottom,
		`eyebrow bottom ${form.eyebrowBottom}, heading top ${form.heading.top}`,
	);
	ok(
		"the rule under the eyebrow is drawn at the heading row's own top edge",
		form.rule.property.endsWith("px") &&
			Math.abs(parseFloat(form.rule.property) - form.rule.liTop) <= 1 &&
			form.rule.content !== "none",
		JSON.stringify(form.rule),
	);

	// a longer trail (a view that adds crumbs) is the only place the divider shows
	const trail = await page.eval<{
		divider: string;
		dividerColor: string;
		first: string;
		lastDivider: string;
		items: number;
	}>(`(() => {
		const p = frappe.get_current_page();
		p.set_breadcrumbs([{ label: 'Selling', href: '/desk/selling' }, { label: 'Role', href: '/desk/role' }, { label: 'System Manager' }]);
		const lis = [...p.$title_area.find('.es-breadcrumbs > ol > li')]; const cs = getComputedStyle;
		return { divider: cs(lis[1], '::before').content, dividerColor: cs(lis[1], '::before').color, first: cs(lis[0], '::before').content, lastDivider: cs(lis[2], '::before').content, items: lis.length };
	})()`);
	ok(
		'a longer trail divides its parents with a "/" in $text-primary, none before the first or the heading',
		trail.items === 3 &&
			trail.divider.includes("/") &&
			trail.dividerColor === textPrimary &&
			trail.first === "none" &&
			trail.lastDivider === "none",
		JSON.stringify(trail),
	);
	// restore the document's own trail for the rest of the suite
	await openRoute(page, "/desk/role/System%20Manager", 2);

	// -- 2. the status pill ---------------------------------------------------------
	const pill = form.pill;
	ok(
		"the status is a badge beside the trail (not inside it), with Carbon's tag silhouette",
		pill !== null &&
			pill.parentIsTitleArea &&
			!pill.insideOl &&
			pill.classes.includes("es-badge") &&
			pill.classes.includes("page-indicator-pill") &&
			pill.text === "Enabled" &&
			pill.height === 24 &&
			pill.radius === "16px" &&
			pill.fontSize === "12px",
		JSON.stringify(pill),
	);
	// the pill was once stranded far to the right of a heading it belongs to,
	// because a wrapping flex trail is as wide as its crumbs summed on one line
	ok(
		"the pill sits right against the heading text, centred on its row",
		pill !== null &&
			pill.left - form.heading.right >= 0 &&
			pill.left - form.heading.right <= 16 &&
			Math.abs((pill.top + pill.bottom) / 2 - (form.row.top + form.row.bottom) / 2) <= 24,
		pill
			? `gap ${pill.left - form.heading.right}px, pill mid ${(pill.top + pill.bottom) / 2}, row ${form.row.top}-${form.row.bottom}`
			: "no pill",
	);
	await clip(page, SHOT + "/pagehead-form-light.png", 220);

	// -- 2b. every colour a status can take lands on a Carbon tag ----------------------
	for (const mode of ["light", "dark"] as const) {
		await theme(page, mode);
		const failures: string[] = [];
		for (const [label, tag] of TAGS) {
			const seen = await page.eval<{
				bg: string;
				color: string;
				hidden: boolean;
				theme: string | null;
			}>(`(() => {
				const p = frappe.get_current_page(); p.set_indicator(${JSON.stringify(label)}, ${JSON.stringify(tag.colour)});
				const el = p.indicator[0]; const cs = getComputedStyle(el);
				return { bg: cs.backgroundColor, color: cs.color, hidden: cs.display === 'none', theme: el.getAttribute('data-theme') };
			})()`);
			const fill = mode === "light" ? `${tag.scale}20` : `${tag.scale}80`;
			const ink = mode === "light" ? `${tag.scale}70` : `${tag.scale}30`;
			if (seen.hidden || seen.theme !== tag.colour)
				failures.push(`${label}: not shown / theme ${seen.theme}`);
			if (seen.bg !== rgb(carbonHex(fill)) || seen.color !== rgb(carbonHex(ink))) {
				failures.push(`${label}: ${seen.bg} on ${seen.color}, want ${fill} on ${ink}`);
			}
		}
		ok(
			`Draft / Submitted / Cancelled / Paid are Carbon tags in ${mode}: <c>-${mode === "light" ? "20 on -70" : "80 on -30"}`,
			failures.length === 0,
			failures.join(" | "),
		);
		if (mode === "dark") await clip(page, SHOT + "/pagehead-form-dark.png", 220);
	}
	// an indicator that is cleared goes away entirely
	const cleared = await page.eval<string>(
		`(() => { const p = frappe.get_current_page(); p.clear_indicator(); return getComputedStyle(p.indicator[0]).display; })()`,
	);
	ok("clear_indicator hides the pill", cleared === "none", cleared);
	await theme(page, "light");

	// -- 3. the title is a rename control -------------------------------------------------
	// a fresh load: the previous section rewrote the status in place
	await openRoute(page, "/desk/role/System%20Manager", 2);
	const title = await page.eval<{
		editable: boolean;
		glyph: boolean;
		glyphSvg: boolean;
		role: string | null;
		tabindex: string | null;
		haspopup: string | null;
		opacity: string;
		cursor: string;
		x: number;
		y: number;
	}>(`(() => {
		const $a = $('.page-container:visible .title-area').first();
		const item = $a.find('.es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0];
		const g = item.querySelector('.cf-title-edit'); const r = item.getBoundingClientRect();
		return { editable: $a.hasClass('editable-title'), glyph: !!g, glyphSvg: !!(g && g.querySelector('svg')), role: item.getAttribute('role'), tabindex: item.getAttribute('tabindex'),
			haspopup: item.getAttribute('aria-haspopup'), opacity: g ? getComputedStyle(g).opacity : '', cursor: getComputedStyle(item).cursor, x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	ok(
		"a renameable document's heading carries Carbon's Edit glyph, hidden until it is hovered",
		title.editable && title.glyph && title.glyphSvg && title.opacity === "0",
		JSON.stringify(title),
	);
	ok(
		"the heading is a keyboard-reachable button that says it opens a dialog",
		title.role === "button" &&
			title.tabindex === "0" &&
			title.haspopup === "dialog" &&
			title.cursor === "pointer",
		JSON.stringify(title),
	);
	await page.hover(title.x, title.y);
	const hovered = await page.eval<{ opacity: string; bg: string }>(`(() => {
		const item = $('.page-container:visible .title-area .es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0];
		return { opacity: getComputedStyle(item.querySelector('.cf-title-edit')).opacity, bg: getComputedStyle(item).backgroundColor };
	})()`);
	ok(
		"hovering the heading reveals the glyph and washes the heading with $field-hover",
		hovered.opacity === "1" && hovered.bg !== "rgba(0, 0, 0, 0)",
		JSON.stringify(hovered),
	);
	await clip(page, SHOT + "/pagehead-title-hover.png", 220);

	// a repaint (frappe empties and refills the <ol>) must not drop the affordance
	const repainted = await page.eval<{ glyph: boolean; role: string | null; same: boolean }>(`(() => {
		const p = frappe.get_current_page(); const before = p.$title_area.find('.es-breadcrumbs__item').last()[0];
		p.render_breadcrumbs();
		const item = p.$title_area.find('.es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0];
		return { glyph: !!item.querySelector('.cf-title-edit'), role: item.getAttribute('role'), same: item === before };
	})()`);
	ok(
		"a repaint of the trail keeps the glyph and the button role on the new heading node",
		repainted.glyph && repainted.role === "button" && !repainted.same,
		JSON.stringify(repainted),
	);

	// click the heading: frappe's own Rename dialog opens. Nothing is submitted.
	const where = await page.eval<{ x: number; y: number }>(`(() => {
		const r = $('.page-container:visible .title-area .es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0].getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	await click(page, where.x, where.y);
	const dialog = await page.waitFor<{ title: string; fields: string[] } | false>(
		`(() => { const m = document.querySelector('.modal.show'); return m ? { title: m.querySelector('.modal-title').textContent.trim(), fields: [...m.querySelectorAll('.frappe-control')].map(f => f.dataset.fieldname) } : false; })()`,
		{ timeout: 10000 },
	);
	ok(
		"clicking the heading opens the Rename dialog",
		!!dialog && dialog.title === "Rename" && dialog.fields.includes("name"),
		JSON.stringify(dialog),
	);
	// bootstrap ignores hide() while the fade-in is still running
	await sleep(700);
	await page.eval(`document.querySelector('.modal.show .btn-modal-close').click()`);
	await page.waitFor(`!document.querySelector('.modal.show')`, { timeout: 10000 });

	// the same from the keyboard
	// :focus-visible only matches a script focus when the last input was the
	// keyboard, and the click above was a mouse
	await key(page, "Shift");
	await page.eval(
		`$('.page-container:visible .title-area .es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0].focus()`,
	);
	await sleep(300); // the glyph fades in
	const focused = await page.eval<{ outline: string; opacity: string }>(`(() => {
		const item = document.activeElement; return { outline: getComputedStyle(item).outlineStyle + ' ' + getComputedStyle(item).outlineWidth, opacity: getComputedStyle(item.querySelector('.cf-title-edit')).opacity };
	})()`);
	await key(page, "Enter");
	const viaKey = await page.waitFor<string | false>(
		`(() => { const m = document.querySelector('.modal.show'); return m ? m.querySelector('.modal-title').textContent.trim() : false; })()`,
		{ timeout: 10000 },
	);
	ok("Enter on the focused heading opens the Rename dialog too", viaKey === "Rename", String(viaKey));
	ok(
		"a keyboard-focused heading shows the glyph inside Carbon's 2px focus ring",
		focused.opacity === "1" && focused.outline === "solid 2px",
		JSON.stringify(focused),
	);
	// bootstrap ignores hide() while the fade-in is still running
	await sleep(700);
	await page.eval(`document.querySelector('.modal.show .btn-modal-close').click()`);
	await page.waitFor(`!document.querySelector('.modal.show')`, { timeout: 10000 });

	// a document that cannot be renamed keeps an inert heading
	await openRoute(page, "/desk/language/en", 2);
	const inert = await page.eval<{
		editable: boolean;
		glyph: boolean;
		role: string | null;
		cursor: string;
		status: string;
	}>(`(() => {
		const $a = $('.page-container:visible .title-area').first();
		const item = $a.find('.es-breadcrumbs > ol > li:last-child > .es-breadcrumbs__item')[0];
		const pill = $a.find('.page-indicator-pill')[0];
		return { editable: $a.hasClass('editable-title'), glyph: !!item.querySelector('.cf-title-edit'), role: item.getAttribute('role'), cursor: getComputedStyle(item).cursor, status: pill.textContent.trim() + '/' + pill.getAttribute('data-theme') };
	})()`);
	ok(
		"a document that cannot be renamed has a plain heading: no glyph, no button role, no pointer",
		!inert.editable && !inert.glyph && inert.role === null && inert.cursor !== "pointer",
		JSON.stringify(inert),
	);
	ok("its status comes from the document: Enabled, blue", inert.status === "Enabled/blue", inert.status);

	// -- 4. a list has no eyebrow ----------------------------------------------------------
	await openRoute(page, "/desk/role", 1);
	const list = await page.eval<HeadState>(HEAD);
	ok(
		"a list's trail is the page alone: heading-04, no eyebrow, no rule under nothing",
		list.crumbs.length === 1 &&
			list.crumbs[0]?.tag === "span" &&
			list.heading.fontSize === "28px" &&
			list.rule.content === "none",
		JSON.stringify([list.crumbs, list.heading.fontSize, list.rule.content]),
	);
	await clip(page, SHOT + "/pagehead-list-light.png", 220);
	await theme(page, "dark");
	await clip(page, SHOT + "/pagehead-list-dark.png", 220);
	const darkHeading = await page.eval<string>(
		`getComputedStyle($('.page-container:visible .es-breadcrumbs li:last-child .es-breadcrumbs__item')[0]).color`,
	);
	ok(
		"the heading follows the theme: $text-primary in dark is Carbon's #f4f4f4",
		darkHeading === rgb("#f4f4f4"),
		darkHeading,
	);
	await theme(page, "light");

	// -- 5. the page actions ---------------------------------------------------------------------
	await openRoute(page, "/desk/role/System%20Manager", 2);
	interface Actions {
		primary: {
			variant: string | null;
			height: number;
			radius: string;
			bg: string;
			color: string;
			label: string;
			tag: string;
		} | null;
		menu: { height: number; width: number; bg: string; radius: string; label: string | null } | null;
		margins: string[];
		focusRing: boolean;
		gaps: number[];
	}
	const actions = await page.eval<Actions>(`(() => {
		const $c = $('.page-container:visible').first(); const cs = getComputedStyle;
		const p = $c.find('.page-actions .primary-action:visible')[0]; const m = $c.find('.page-actions .menu-more-button')[0];
		const btns = [...$c.find('.page-actions .standard-actions').find('.es-button:visible, .btn:visible')];
		const r = btns.map(b => b.getBoundingClientRect());
		return {
			primary: p ? { variant: p.getAttribute('data-variant'), height: p.getBoundingClientRect().height, radius: cs(p).borderTopLeftRadius, bg: cs(p).backgroundColor, color: cs(p).color, label: p.querySelector('.es-button__label').textContent.trim(), tag: p.tagName.toLowerCase() } : null,
			menu: m ? { height: m.getBoundingClientRect().height, width: m.getBoundingClientRect().width, bg: cs(m).backgroundColor, radius: cs(m).borderTopLeftRadius, label: m.getAttribute('aria-label') } : null,
			margins: btns.map(b => cs(b).marginLeft),
			focusRing: true,
			gaps: r.slice(1).map((b, i) => Math.round(b.left - (r[i].right))),
		};
	})()`);
	const buttonPrimary = await page.eval<string>(TOKEN("--cds-button-primary"));
	const expectedPrimary = buttonPrimary || rgb("#0f62fe");
	ok(
		"Save is a solid es-button on Carbon's primary: square, 40px, the brand or blue-60 fill",
		actions.primary !== null &&
			actions.primary.tag === "button" &&
			actions.primary.variant === "solid" &&
			actions.primary.height === 40 &&
			actions.primary.radius === "0px" &&
			actions.primary.bg === expectedPrimary &&
			actions.primary.label === "Save",
		JSON.stringify(actions.primary) + " want " + expectedPrimary,
	);
	ok(
		"the Menu trigger is a square 40px ghost: no fill at rest",
		actions.menu !== null &&
			actions.menu.height === 40 &&
			actions.menu.width === 40 &&
			actions.menu.bg === "rgba(0, 0, 0, 0)" &&
			actions.menu.radius === "0px",
		JSON.stringify(actions.menu),
	);
	ok(
		"the buttons are one flush set: no margin, no gap between neighbours",
		actions.margins.length >= 3 &&
			actions.margins.every((m) => m === "0px") &&
			actions.gaps.every((g) => g === 0),
		JSON.stringify([actions.margins, actions.gaps]),
	);

	// the Menu: an es-menu panel on Carbon's menu surface
	const menuBox = await page.eval<{ x: number; y: number }>(`(() => {
		const r = $('.page-container:visible .page-actions .menu-more-button')[0].getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	await click(page, menuBox.x, menuBox.y);
	const layer01 = await page.eval<string>(
		`(() => { const s = document.createElement('span'); s.style.backgroundColor = 'var(--cds-layer-01)'; document.body.appendChild(s); const c = getComputedStyle(s).backgroundColor; s.remove(); return c; })()`,
	);
	const menu = await page.waitFor<
		| {
				count: number;
				z: string;
				bg: string;
				radius: string;
				row: number;
				firstColor: string;
				inBody: boolean;
				expanded: string | null;
				pressed: string;
		  }
		| false
	>(
		`(() => {
			const m = document.querySelector('.es-menu'); if (!m) return false;
			const rows = [...m.querySelectorAll('.es-menu__item')]; const cs = getComputedStyle(m); const trigger = document.querySelector('.page-container .menu-more-button');
			return { count: rows.length, z: cs.zIndex, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, row: Math.round(rows[0].getBoundingClientRect().height), firstColor: getComputedStyle(rows[0]).color, inBody: m.parentElement === document.body, expanded: trigger.getAttribute('aria-expanded'), pressed: getComputedStyle(trigger).backgroundColor };
		})()`,
		{ timeout: 10000 },
	);
	ok(
		"the Menu opens an es-menu in <body>: above the shell (1060), square, on $layer-01, with Carbon's 32px rows",
		!!menu &&
			menu.inBody &&
			menu.count >= 5 &&
			menu.z === "1060" &&
			menu.radius === "0px" &&
			menu.bg === layer01 &&
			menu.row === 32 &&
			menu.firstColor === textSecondary,
		JSON.stringify(menu),
	);
	ok(
		"an open trigger takes the selected-ghost tone",
		!!menu && menu.expanded === "true" && menu.pressed !== "rgba(0, 0, 0, 0)",
		JSON.stringify(menu && { expanded: menu.expanded, pressed: menu.pressed }),
	);
	await page.screenshot(SHOT + "/pagehead-form-menu.png");
	await key(page, "Escape");
	await page.waitFor(`!document.querySelector('.es-menu')`, { timeout: 10000 });

	// -- 6. a dialog ----------------------------------------------------------------------------
	await page.eval(`(() => {
		const d = new frappe.ui.Dialog({ title: 'CF page head', fields: [{ fieldtype: 'Data', fieldname: 'x', label: 'Name' }] });
		d.set_primary_action('Rename', () => {}); d.set_secondary_action_label('Cancel'); d.show();
		window.__cfDialog = d;
	})()`);
	// bootstrap attaches and fades the modal in asynchronously, and measures of a
	// modal that is not laid out yet are all zero
	await page.waitFor(`!!document.querySelector('.modal.show')`, { timeout: 10000 });
	await sleep(700);
	const dlg = await page.eval<{
		radius: string;
		primaryIsEs: boolean;
		primaryFound: number;
		secondaryFound: number;
		heights: number[];
		widths: number[];
		bg: string;
		align: string;
		title: string;
		titleSize: string;
	}>(`(() => {
		const d = window.__cfDialog;
		const m = d.$wrapper.find('.modal-content')[0]; const foot = d.$wrapper.find('.modal-footer')[0];
		const btns = [...foot.querySelectorAll('.standard-actions > .es-button')].filter(b => getComputedStyle(b).display !== 'none');
		const primary = d.get_primary_btn()[0];
		return { radius: getComputedStyle(m).borderTopLeftRadius, primaryIsEs: primary.classList.contains('es-button'), primaryFound: d.get_primary_btn().length, secondaryFound: d.get_secondary_btn().length,
			heights: btns.map(b => b.getBoundingClientRect().height), widths: btns.map(b => Math.round(b.getBoundingClientRect().width)), bg: getComputedStyle(primary).backgroundColor, align: getComputedStyle(btns[0]).justifyContent,
			title: d.$wrapper.find('.modal-title').text().trim(), titleSize: getComputedStyle(d.$wrapper.find('.modal-title')[0]).fontSize };
	})()`);
	ok(
		"a dialog's primary and secondary buttons are es-buttons found by frappe's own selectors",
		dlg.primaryIsEs && dlg.primaryFound === 1 && dlg.secondaryFound === 1,
		JSON.stringify(dlg),
	);
	ok(
		"the modal is square, with heading-03 for its title",
		dlg.radius === "0px" && dlg.titleSize === "20px" && dlg.title === "CF page head",
		JSON.stringify([dlg.radius, dlg.titleSize]),
	);
	ok(
		"the footer's two actions are Carbon's full-bleed pair: 48px, equal halves, labels at the start",
		dlg.heights.length === 2 &&
			dlg.heights.every((h) => h === 48) &&
			dlg.widths[0] === dlg.widths[1] &&
			dlg.align === "flex-start" &&
			dlg.bg === expectedPrimary,
		JSON.stringify([dlg.heights, dlg.widths, dlg.align, dlg.bg]),
	);
	await page.screenshot(SHOT + "/pagehead-dialog-light.png");
	await theme(page, "dark");
	await page.screenshot(SHOT + "/pagehead-dialog-dark.png");
	await theme(page, "light");
	await page.eval(`window.__cfDialog.hide(); delete window.__cfDialog`);
	await page.waitFor(`!document.querySelector('.modal.show')`, { timeout: 10000 });

	// -- 7. one hamburger -------------------------------------------------------------------------
	// frappe shows the page head's own below 992px; the UI Shell's is on from 768px
	for (const width of [1600, 900]) {
		await viewport(page, width, 900);
		await sleep(600);
		const toggles = await page.eval<{ page: string; header: number; shell: boolean }>(`(() => {
			const t = $('.page-container:visible .page-title .sidebar-toggle-btn')[0];
			const hs = [...document.querySelectorAll('.cf-shell-header .cds--header__menu-toggle')].filter(b => b.offsetParent !== null);
			return { page: getComputedStyle(t).display, header: hs.length, shell: document.body.classList.contains('cf-has-shell') };
		})()`);
		ok(
			`at ${width}px the page head's hamburger is hidden and the shell's is the one control`,
			toggles.shell && toggles.page === "none" && toggles.header === 1,
			JSON.stringify(toggles),
		);
	}
	await viewport(page, 767, 900, true);
	await page.goto(`${BASE}/desk/role/System%20Manager`);
	await page.waitFor(`$('.page-container:visible .page-head .es-breadcrumbs > ol > li').length === 2`, {
		timeout: 90000,
	});
	await sleep(1500);
	const phone = await page.eval<{ page: string; shell: boolean }>(`(() => ({
		page: getComputedStyle($('.page-container:visible .page-title .sidebar-toggle-btn')[0]).display,
		shell: document.body.classList.contains('cf-has-shell'),
	}))()`);
	ok(
		"under 768px the shell is not mounted, so frappe's own hamburger stands",
		!phone.shell && phone.page !== "none",
		JSON.stringify(phone),
	);
	await page.send("Emulation.clearDeviceMetricsOverride");

	const errs = page.consoleErrors().filter((e) => !/favicon|404/.test(e));
	ok("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
	results.push(`FAIL  suite threw: ${e instanceof Error ? e.stack || e.message : String(e)}`);
} finally {
	page.close();
	proc.kill();
}

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
