// UI Shell header — the sidebar-driven name, links and sub-menus, the
// measured overflow, the switcher, the harvested utilities, and g100 parity.
//
// Every assertion here is a contract the header keeps with frappe's Workspace
// Sidebar (which it projects) or with Carbon's UI Shell CSS (which styles it).
// The route fixtures are ERPNext's Projects sidebar (8 top-level rows, two
// Section Breaks) and HRMS's Recruitment sidebar (13 rows — the overflow case).
import fs from "node:fs";
import { assertCarbonStylesheet, launch, newPage, login } from "../tables/cdp.ts";
import type { Page } from "../tables/cdp.ts";

const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });

const { proc, port } = await launch();
const page = await newPage(port);
const results: string[] = [];
const ok = (n: string, c: unknown, x = ""): void => {
	results.push(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the shell to mount AND the sidebar to have projected the given workspace. */
async function ready(p: Page, title: string): Promise<void> {
	await p.waitFor(
		`!!document.querySelector('.cf-shell-header .cds--header__name') && (frappe.app.sidebar.sidebar_title || '') === ${JSON.stringify(title)} && !!document.querySelector('.cf-shell-header .cds--header__menu-bar > li')`,
		{ timeout: 90000 },
	);
	await sleep(600);
}

async function viewport(p: Page, width: number, height: number): Promise<void> {
	await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(400);
}

async function key(p: Page, keyName: string, code = keyName, modifiers = 0): Promise<void> {
	// Escape / Enter / arrows arrive as rawKeyDown + keyUp; Enter also needs the
	// `text` so a focused anchor "activates" like a real keypress
	const text = keyName === "Enter" ? "\r" : keyName === " " ? " " : undefined;
	await p.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		key: keyName,
		code,
		modifiers,
		...(text ? { text } : {}),
	});
	await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
	await sleep(150);
}

interface NameState {
	text: string;
	prefix: string | null;
	href: string | null;
	firstSidebarHref: string | null;
}
interface NavState {
	labels: string[];
	sidebarLabels: string[];
	submenus: number;
	sections: number;
}
interface GeometryState {
	bg: string;
	border: string;
	height: string;
	z: string;
	position: string;
	cells: Array<[number, number, string]>;
	cellCount: number;
	gap: number;
}

try {
	await login(page, BASE);
	await viewport(page, 1600, 1000);

	// -- 1. name -------------------------------------------------------------
	await page.goto(`${BASE}/desk/projects`);
	await ready(page, "Projects");
	await assertCarbonStylesheet(page);

	const name = await page.eval<NameState>(`(() => {
		const a = document.querySelector('.cf-shell-header .cds--header__name');
		const prefix = a.querySelector('.cds--header__name--prefix');
		const first = document.querySelector('.body-sidebar .sidebar-items a.item-anchor[href]');
		return { text: a.textContent.replace(/\\u00a0/g, ' ').trim(), prefix: prefix && prefix.textContent, href: a.getAttribute('href'), firstSidebarHref: first && first.getAttribute('href') };
	})()`);
	ok(
		"header name is '<app title> <workspace title>'",
		name.text === "ERPNext Projects",
		JSON.stringify(name),
	);
	ok("prefix span carries the app title", name.prefix === "ERPNext");
	ok(
		"header name links to the sidebar's first link",
		!!name.href && name.href === name.firstSidebarHref,
		`${name.href} vs ${name.firstSidebarHref}`,
	);

	// -- 2. nav mirrors the sidebar's top level --------------------------------
	const nav = await page.eval<NavState>(`(() => {
		const bar = document.querySelector('.cf-shell-header .cds--header__menu-bar');
		const lis = [...bar.querySelectorAll(':scope > li:not(.cf-header__more)')];
		const rows = [...document.querySelectorAll('.body-sidebar .sidebar-items > .sidebar-item-container')];
		const label = (el) => { const l = el.querySelector(':scope > .standard-sidebar-item > .item-anchor > .sidebar-item-label'); return l ? l.textContent.trim() : null; };
		return {
			labels: lis.map(li => li.querySelector('a').textContent.trim()),
			sidebarLabels: rows.map(label).filter(Boolean),
			submenus: lis.filter(li => li.classList.contains('cds--header__submenu')).length,
			sections: rows.filter(r => r.classList.contains('section-item') && r.querySelector('.nested-container .sidebar-item-container')).length,
		};
	})()`);
	ok(
		"nav labels equal the sidebar's top-level labels",
		JSON.stringify(nav.labels) === JSON.stringify(nav.sidebarLabels),
		JSON.stringify(nav),
	);
	ok(
		"every populated Section Break is a sub-menu",
		nav.submenus === nav.sections && nav.submenus >= 2,
		`${nav.submenus} vs ${nav.sections}`,
	);
	await page.screenshot(SHOT + "/shell-light.png");

	// -- 3. sub-menu behaviour ---------------------------------------------------
	const setup = `document.querySelector('.cf-shell-header .cds--header__submenu[data-cf-index] > .cds--header__menu-title')`;
	await page.eval(`${setup}.click()`);
	await sleep(250);
	const opened = await page.eval<{
		expanded: string | null;
		display: string;
		width: string;
		bg: string;
		hash: string;
	}>(`(() => {
		const t = ${setup}; const menu = t.nextElementSibling; const cs = getComputedStyle(menu);
		return { expanded: t.getAttribute('aria-expanded'), display: cs.display, width: cs.width, bg: cs.backgroundColor, hash: location.hash };
	})()`);
	ok(
		"clicking a sub-menu title opens it (aria-expanded + CSS)",
		opened.expanded === "true" && opened.display === "flex",
		JSON.stringify(opened),
	);
	ok(
		"open sub-menu is 16rem wide on the g100 $layer",
		opened.width === "256px" && opened.bg === "rgb(38, 38, 38)",
		`${opened.width} ${opened.bg}`,
	);
	ok("the title's href='#' did not reach the URL", opened.hash === "", opened.hash);
	await page.screenshot(SHOT + "/shell-submenu.png");

	await page.eval(`${setup}.focus()`);
	await key(page, "Escape");
	const afterEsc = await page.eval<{ expanded: string | null; focused: boolean }>(`(() => {
		const t = ${setup}; return { expanded: t.getAttribute('aria-expanded'), focused: document.activeElement === t };
	})()`);
	ok(
		"Escape closes the sub-menu and returns focus to its title",
		afterEsc.expanded === "false" && afterEsc.focused,
		JSON.stringify(afterEsc),
	);

	await key(page, "Enter");
	const afterEnter = await page.eval<string | null>(`${setup}.getAttribute('aria-expanded')`);
	ok("Enter on a focused title toggles it", afterEnter === "true", String(afterEnter));

	await page.eval(`document.querySelector('#body').click()`);
	await sleep(200);
	const afterOutside = await page.eval<string | null>(`${setup}.getAttribute('aria-expanded')`);
	ok("a click outside closes it", afterOutside === "false", String(afterOutside));

	// -- 4. aria-current follows the route ------------------------------------
	await page.eval(`frappe.set_route('/desk/task')`);
	await page.waitFor(`location.pathname === '/desk/task'`, { timeout: 30000 });
	await sleep(1200);
	const current = await page.eval<{ current: string[]; title: string }>(`(() => ({
		current: [...document.querySelectorAll('.cf-shell-header a[aria-current="page"]')].map(a => a.textContent.trim()),
		title: frappe.app.sidebar.sidebar_title,
	}))()`);
	ok(
		"navigating to /desk/task marks the Task link current",
		current.current.includes("Task") && current.title === "Projects",
		JSON.stringify(current),
	);

	await page.eval(`frappe.set_route('/desk/activity-type')`);
	await page.waitFor(`location.pathname === '/desk/activity-type'`, { timeout: 30000 });
	await sleep(1200);
	const nested = await page.eval<{ child: string[]; titles: string[] }>(`(() => ({
		child: [...document.querySelectorAll('.cf-shell-header .cds--header__menu a[aria-current="page"]')].map(a => a.textContent.trim()),
		titles: [...document.querySelectorAll('.cf-shell-header .cds--header__menu-title.cds--header__menu-item--current')].map(a => a.textContent.trim()),
	}))()`);
	ok(
		"a current child marks its collapsed sub-menu title",
		nested.child.includes("Activity Type") && nested.titles.includes("Setup"),
		JSON.stringify(nested),
	);

	// -- 5. overflow at the lg breakpoint ---------------------------------------
	await page.goto(`${BASE}/desk/recruitment`);
	await ready(page, "Recruitment");
	await viewport(page, 1056, 900);
	await sleep(700);
	interface Overflow {
		more: boolean;
		hidden: number;
		inMore: number;
		overlap: boolean;
		total: number;
		name: string;
	}
	const OVERFLOW = `(() => {
		const h = document.querySelector('.cf-shell-header');
		const more = h.querySelector('.cf-header__more');
		const tops = [...h.querySelectorAll('.cds--header__menu-bar > li[data-cf-index]')];
		const hidden = tops.filter(li => li.hidden).length;
		const global = h.querySelector('.cds--header__global').getBoundingClientRect();
		const overlap = tops.some(li => !li.hidden && li.getBoundingClientRect().right > global.left + 1);
		const name = h.querySelector('.cds--header__name');
		const span = name.querySelector('span:last-child');
		return { more: !more.hidden, hidden, inMore: more.querySelectorAll('a').length - 1, overlap, total: tops.length, name: span.scrollWidth <= span.clientWidth ? name.textContent.replace(/\\u00a0/g, ' ').trim() : 'TRUNCATED' };
	})()`;
	const overflow = await page.eval<Overflow>(OVERFLOW);
	ok(
		"13-row sidebar overflows into More at 1056px",
		overflow.more && overflow.hidden > 0 && overflow.total === 13,
		JSON.stringify(overflow),
	);
	ok("nothing in the bar overlaps the global bar", !overflow.overlap);
	ok("the name is never squeezed by the bar", overflow.name === "Frappe HR Recruitment", overflow.name);
	await page.screenshot(SHOT + "/shell-overflow.png");

	await viewport(page, 1600, 1000);
	await sleep(700);
	const wide = await page.eval<Overflow>(OVERFLOW);
	ok(
		"at 1600px more rows fit than at 1056px",
		wide.hidden < overflow.hidden && !wide.overlap,
		JSON.stringify(wide),
	);
	await viewport(page, 2560, 1000);
	await sleep(700);
	const widest = await page.eval<Overflow>(OVERFLOW);
	ok(
		"at 2560px every row is back in the bar and More is gone",
		!widest.more && widest.hidden === 0,
		JSON.stringify(widest),
	);

	// -- 6. switcher ---------------------------------------------------------------
	// The panel is the desktop's icon list (shell/desktop.ts): the current
	// workspace selected, a Folder / App-with-workspaces as a disclosure row.
	await page.goto(`${BASE}/desk/projects`);
	await ready(page, "Projects");
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	await sleep(400);
	interface SwitcherState {
		expanded: string | null;
		panel: boolean;
		width: string;
		selected: string[];
		tab: string | null;
		active: boolean;
		rows: string[];
		groups: string[];
	}
	const SWITCHER = `(() => {
		const b = document.querySelector('#cf-switcher-button'); const p = document.querySelector('#cf-switcher-panel');
		const top = [...p.querySelectorAll('.cds--switcher > .cds--switcher__item > .cds--switcher__item-link')];
		return { expanded: b.getAttribute('aria-expanded'), panel: p.classList.contains('cds--header-panel--expanded'), width: getComputedStyle(p).width,
			selected: [...p.querySelectorAll('.cds--switcher__item-link--selected')].map(a => a.textContent.trim()), tab: p.querySelector('.cds--switcher__item-link').getAttribute('tabindex'), active: b.classList.contains('cds--header__action--active'),
			rows: top.map(a => a.textContent.trim()), groups: [...p.querySelectorAll('.cf-switcher__toggle')].map(t => t.dataset.group) };
	})()`;
	const sw = await page.eval<SwitcherState>(SWITCHER);
	ok(
		"switcher opens a 256px header panel with the current workspace selected",
		sw.expanded === "true" &&
			sw.panel &&
			sw.width === "256px" &&
			sw.selected.join() === "Projects" &&
			sw.tab === "0" &&
			sw.active,
		JSON.stringify(sw),
	);
	// the desktop's own top level, from boot: visible icons whose parent is absent or hidden
	const expectedRows = await page.eval<string[]>(`(() => {
		const icons = frappe.boot.desktop_icons.filter(i => i.hidden !== 1); const visible = new Set(icons.map(i => i.label));
		const kids = new Set(icons.filter(i => i.parent_icon && visible.has(i.parent_icon)).map(i => i.parent_icon));
		return icons.filter(i => !(i.parent_icon && visible.has(i.parent_icon))).filter(i => i.icon_type !== 'Folder' || kids.has(i.label)).map(i => __(i.label)).concat([__('Desktop')]);
	})()`);
	ok(
		"switcher rows are the desktop's icons in the desktop's order, then Desktop",
		sw.rows.join("|") === expectedRows.join("|"),
		`${sw.rows.join("|")} vs ${expectedRows.join("|")}`,
	);
	ok(
		"Accounting is a disclosure row (a Folder), Framework too (an App with workspaces)",
		sw.groups.includes("Accounting") && sw.groups.includes("Framework"),
		sw.groups.join(),
	);
	await page.screenshot(SHOT + "/shell-switcher.png");

	interface GroupState {
		expanded: string | null;
		hidden: boolean;
		controls: boolean;
		children: string[];
		childTabs: string[];
	}
	const GROUP = (label: string): string => `(() => {
		const t = document.querySelector('.cf-switcher__toggle[data-group=${JSON.stringify(label)}]'); const sub = document.getElementById(t.getAttribute('aria-controls'));
		return { expanded: t.getAttribute('aria-expanded'), hidden: sub.hidden, controls: sub.classList.contains('cf-switcher__submenu'),
			children: [...sub.querySelectorAll('.cds--switcher__item-link')].map(a => a.textContent.trim()), childTabs: [...sub.querySelectorAll('.cds--switcher__item-link')].map(a => a.getAttribute('tabindex')) };
	})()`;
	const expectedKids = await page.eval<string[]>(
		`frappe.boot.desktop_icons.filter(i => i.parent_icon === 'Accounting' && i.hidden !== 1).map(i => __(i.label))`,
	);
	const closed = await page.eval<GroupState>(GROUP("Accounting"));
	ok(
		"Accounting starts collapsed: aria-expanded false, submenu hidden, children untabbable",
		closed.expanded === "false" &&
			closed.hidden &&
			closed.controls &&
			closed.children.join("|") === expectedKids.join("|") &&
			closed.childTabs.every((t) => t === "-1"),
		JSON.stringify(closed),
	);
	await page.eval(`document.querySelector('.cf-switcher__toggle[data-group="Accounting"]').click()`);
	await sleep(200);
	const groupOpened = await page.eval<GroupState>(GROUP("Accounting"));
	const stillOpen = await page.eval<boolean>(
		`document.querySelector('#cf-switcher-panel').classList.contains('cds--header-panel--expanded')`,
	);
	ok(
		"clicking Accounting expands it in place and keeps the panel open",
		groupOpened.expanded === "true" &&
			!groupOpened.hidden &&
			groupOpened.childTabs.every((t) => t === "0") &&
			stillOpen,
		JSON.stringify(groupOpened),
	);
	await page.screenshot(SHOT + "/shell-switcher-expanded.png");

	await page.eval(`document.querySelector('.cf-switcher__toggle[data-group="Accounting"]').focus()`);
	await key(page, "ArrowDown");
	const intoGroup = await page.eval<string>(`document.activeElement.textContent.trim()`);
	ok("ArrowDown from an expanded toggle enters its first child", intoGroup === expectedKids[0], intoGroup);
	await key(page, "ArrowUp");
	await key(page, "ArrowLeft");
	await key(page, "ArrowDown");
	const overGroup = await page.eval<{ collapsed: string | null; next: string }>(
		`({ collapsed: document.querySelector('.cf-switcher__toggle[data-group="Accounting"]').getAttribute('aria-expanded'), next: document.activeElement.textContent.trim() })`,
	);
	ok(
		"ArrowLeft collapses the toggle and ArrowDown then skips its children",
		overGroup.collapsed === "false" &&
			overGroup.next === expectedRows[expectedRows.indexOf("Accounting") + 1],
		JSON.stringify(overGroup),
	);

	await page.eval(`document.querySelector('#cf-switcher-panel .cds--switcher__item-link').focus()`);
	await key(page, "ArrowDown");
	const moved = await page.eval<string>(`document.activeElement.textContent.trim()`);
	ok("ArrowDown moves focus through the switcher", moved === expectedRows[1], moved);
	await key(page, "Escape");
	const swClosed = await page.eval<{ expanded: string | null; focused: boolean }>(
		`(() => { const b = document.querySelector('#cf-switcher-button'); return { expanded: b.getAttribute('aria-expanded'), focused: document.activeElement === b }; })()`,
	);
	ok(
		"Escape closes the switcher and refocuses its button",
		swClosed.expanded === "false" && swClosed.focused,
		JSON.stringify(swClosed),
	);

	// a nested workspace: its row is selected and its group opens itself
	await page.goto(`${BASE}/desk/invoicing`);
	await ready(page, "Invoicing");
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	await sleep(400);
	const onInvoicing = await page.eval<SwitcherState>(SWITCHER);
	const nestedGroup = await page.eval<GroupState>(GROUP("Accounting"));
	ok(
		"on Invoicing the nested row is selected and Accounting is pre-expanded",
		onInvoicing.selected.join() === "Invoicing" && nestedGroup.expanded === "true" && !nestedGroup.hidden,
		JSON.stringify({ selected: onInvoicing.selected, group: nestedGroup.expanded }),
	);
	await key(page, "Escape");
	await page.goto(`${BASE}/desk/projects`);
	await ready(page, "Projects");

	// -- 7. hamburger ------------------------------------------------------------
	const before = await page.eval<{ expanded: boolean; aria: string | null }>(
		`(() => ({ expanded: document.querySelector('.body-sidebar-container').classList.contains('expanded'), aria: document.querySelector('.cds--header__menu-toggle').getAttribute('aria-expanded') }))()`,
	);
	await page.eval(`document.querySelector('.cds--header__menu-toggle').click()`);
	await sleep(500);
	const after = await page.eval<{ expanded: boolean; aria: string | null; glyph: boolean }>(
		`(() => ({ expanded: document.querySelector('.body-sidebar-container').classList.contains('expanded'), aria: document.querySelector('.cds--header__menu-toggle').getAttribute('aria-expanded'), glyph: !!document.querySelector('.cds--header__menu-toggle svg') }))()`,
	);
	ok(
		"hamburger toggles the sidebar and mirrors it in aria-expanded",
		before.expanded !== after.expanded &&
			after.aria === String(after.expanded) &&
			before.aria === String(before.expanded),
		JSON.stringify({ before, after }),
	);
	ok("hamburger keeps the Menu glyph", after.glyph);
	await page.eval(`document.querySelector('.cds--header__menu-toggle').click()`);
	await sleep(400);

	// -- 8. bell + badge --------------------------------------------------------------
	await page.eval(
		`document.querySelector('.cf-shell-header .sidebar-notification .cds--header__action').click()`,
	);
	await sleep(500);
	const bell = await page.eval<{
		shown: boolean;
		position: string;
		top: string;
		width: string;
		bg: string;
	}>(`(() => {
		const host = document.querySelector('.cf-shell-header .dropdown-notifications'); const list = host.querySelector('.notifications-list'); const cs = getComputedStyle(list);
		return { shown: !host.classList.contains('hidden'), position: cs.position, top: cs.top, width: cs.width, bg: cs.backgroundColor };
	})()`);
	ok(
		"bell opens the notifications as a fixed right panel under the header",
		bell.shown &&
			bell.position === "fixed" &&
			bell.top === "48px" &&
			bell.width === "360px" &&
			bell.bg === "rgb(38, 38, 38)",
		JSON.stringify(bell),
	);
	await page.screenshot(SHOT + "/shell-notifications.png");
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	await sleep(300);
	const yielded = await page.eval<boolean>(
		`document.querySelector('.cf-shell-header .dropdown-notifications').classList.contains('hidden')`,
	);
	ok("opening the switcher hides the notifications panel", yielded);
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	const badge = await page.eval<{ text: string; hidden: boolean; bg: string }>(`(() => {
		frappe.app.sidebar.notifications.tabs.notifications.update_count_badge(3);
		const b = document.querySelector('.cf-shell-header .sidebar-notification-count');
		return { text: b.textContent.trim(), hidden: b.classList.contains('hidden'), bg: getComputedStyle(b).backgroundColor };
	})()`);
	// #fa4d56 is $support-error in g100 — the zone's value, not the page's #da1e28
	ok(
		"update_count_badge paints the header's badge after the move",
		badge.text === "3" && !badge.hidden && badge.bg === "rgb(250, 77, 86)",
		JSON.stringify(badge),
	);
	await page.eval(`frappe.app.sidebar.notifications.tabs.notifications.update_count_badge(0)`);
	// let the switcher cell's colour transition (fast-02) finish before measuring
	await sleep(500);

	// -- 9. geometry + z-order, light and dark ---------------------------------------
	const geometry = async (): Promise<GeometryState> =>
		page.eval<GeometryState>(`(() => {
			const h = document.querySelector('.cf-shell-header'); const cs = getComputedStyle(h);
			const cells = [...h.querySelectorAll('.cds--header__global .cds--header__action')].map(a => { const r = a.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), getComputedStyle(a).color]; });
			const rects = [...h.querySelectorAll('.cds--header__global .cds--header__action')].map(a => a.getBoundingClientRect());
			let gap = 0; for (let i = 1; i < rects.length; i++) gap = Math.max(gap, Math.round(rects[i].left - rects[i-1].right));
			return { bg: cs.backgroundColor, border: cs.borderBottomColor, height: cs.height, z: cs.zIndex, position: cs.position, cells, cellCount: cells.length, gap };
		})()`);
	const light = await geometry();
	ok(
		"header is 48px, fixed, z 1030 on g100 tokens (light theme)",
		light.height === "48px" &&
			light.position === "fixed" &&
			light.z === "1030" &&
			light.bg === "rgb(22, 22, 22)" &&
			light.border === "rgb(57, 57, 57)",
		JSON.stringify(light),
	);
	ok(
		"every utility is a 48x48 cell, no gaps, icon on $icon-secondary",
		light.cellCount === 4 &&
			light.cells.every(([w, h, c]) => w === 48 && h === 48 && c === "rgb(198, 198, 198)") &&
			light.gap === 0,
		JSON.stringify(light.cells),
	);

	await page.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
	await sleep(600);
	const dark = await geometry();
	ok(
		"header is identical in the dark theme",
		dark.bg === light.bg && dark.border === light.border && dark.cells[0]?.[2] === light.cells[0]?.[2],
		JSON.stringify(dark),
	);
	await page.screenshot(SHOT + "/shell-dark.png");
	await page.eval(`document.documentElement.setAttribute('data-theme', 'light')`);

	const stacking = await page.eval<{ covered: boolean }>(`(() => {
		const d = new frappe.ui.Dialog({ title: 'z', fields: [] }); d.show();
		const el = document.elementFromPoint(24, 24);
		const covered = !el.closest('.cf-shell-header');
		d.hide();
		return { covered };
	})()`);
	ok("a dialog's backdrop covers the header", stacking.covered);

	await viewport(page, 1000, 800);
	const narrow = await page.eval<string>(
		`getComputedStyle(document.querySelector('.cf-shell-header .cds--header__nav')).display`,
	);
	ok("below lg (66rem) the header nav hides and the sidebar carries the links", narrow === "none", narrow);
	await viewport(page, 1600, 1000);

	// -- 10. landing page ---------------------------------------------------------
	await page.goto(`${BASE}/desk`);
	await page.waitFor(
		`!!document.querySelector('.cf-shell-header .cds--header__name') && !!document.querySelector('.desktop-container')`,
		{ timeout: 90000 },
	);
	await sleep(1500);
	const landing = await page.eval<{
		name: string;
		navHidden: boolean;
		menuDisabled: boolean;
		searches: number;
		bells: number;
		navbars: number;
	}>(`(() => {
		const h = document.querySelector('.cf-shell-header');
		return { name: h.querySelector('.cds--header__name').textContent.trim(), navHidden: h.querySelector('.cds--header__nav').hidden, menuDisabled: h.querySelector('.cds--header__menu-toggle').disabled,
			searches: h.querySelectorAll('#navbar-modal-search, #desktop-navbar-modal-search').length, bells: h.querySelectorAll('.sidebar-notification, .desktop-notification-icon').length, navbars: document.querySelectorAll('.desktop-navbar').length };
	})()`);
	ok(
		"landing page: name 'Desktop', nav hidden, hamburger disabled, one search + one bell, no stray navbar",
		landing.name === "Desktop" &&
			landing.navHidden &&
			landing.menuDisabled &&
			landing.searches === 1 &&
			landing.bells === 1 &&
			landing.navbars === 0,
		JSON.stringify(landing),
	);
	// the desktop itself is the reference: its rendered top-level icons, in order
	const parity = await page.eval<{ desktop: string[]; switcher: string[] }>(`(() => {
		const desktop = [...document.querySelectorAll('.desktop-container .desktop-icon')].filter(i => !i.parentElement.closest('.desktop-icon')).map(i => i.querySelector('.icon-title')?.textContent.trim()).filter(Boolean);
		const top = [...document.querySelectorAll('#cf-switcher-panel .cds--switcher > .cds--switcher__item > .cds--switcher__item-link')].map(a => a.textContent.trim());
		return { desktop, switcher: top.slice(0, -1) };
	})()`);
	ok(
		"switcher rows equal the rendered desktop's top-level icons",
		parity.desktop.length > 0 && parity.switcher.join("|") === parity.desktop.join("|"),
		`${parity.switcher.join("|")} vs ${parity.desktop.join("|")}`,
	);

	// -- 11. mobile: frappe fills <header>, the shell stays out ----------------------
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 767,
		height: 900,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await page.goto(`${BASE}/desk/projects`);
	await page.waitFor(`!!(frappe.app && frappe.app.sidebar)`, { timeout: 90000 });
	await sleep(2500);
	const mobile = await page.eval<{ shell: boolean; bodyClass: boolean; sticky: boolean }>(
		`(() => ({ shell: !!document.querySelector('.cf-shell-header'), bodyClass: document.body.classList.contains('cf-has-shell'), sticky: !!document.querySelector('.main-section .sticky-top') }))()`,
	);
	ok(
		"under 768px the shell does not mount and frappe's own header stands",
		!mobile.shell && !mobile.bodyClass && mobile.sticky,
		JSON.stringify(mobile),
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
