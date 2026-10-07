// UI Shell header — the module-sidebar-driven name, links and sub-menus, the
// measured overflow, the switcher, the utilities, the way it sits beside frappe's
// dock and sidebar, and g100 parity.
//
// Every assertion here is a contract the header keeps with frappe's module sidebar
// (which it projects) or with Carbon's UI Shell CSS (which styles it). The route
// fixtures are ERPNext's Projects sidebar (7 top-level rows, two Section Breaks) and
// its Stock sidebar (13 rows — the overflow case); both are read from the live
// `frappe.boot.module_sidebars`, so the suite needs erpnext and nothing else.
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

/**
 * Wait for the shell to mount AND the sidebar to have projected the given shell
 * (a key of `frappe.boot.module_sidebars`, which is also `sidebar.current_module`).
 */
async function ready(p: Page, shell: string): Promise<void> {
	await p.waitFor(
		`(() => {
			const name = document.querySelector('.cf-shell-header .cds--header__name > span:last-child');
			const sb = frappe.app && frappe.app.sidebar;
			return !!name && !!sb && sb.current_module === ${JSON.stringify(shell)} && name.textContent === sb.sidebar_data.label && !!document.querySelector('.cf-shell-header .cds--header__menu-bar > li[data-cf-index]');
		})()`,
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

/** A real pointer click at the centre of an element: what a user does, including the document-level handlers. */
async function pointerClick(p: Page, selector: string): Promise<void> {
	const at = await p.eval<{ x: number; y: number } | null>(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
		const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (!at) throw new Error(`pointerClick: no ${selector}`);
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
		await p.send("Input.dispatchMouseEvent", {
			type,
			x: Math.round(at.x),
			y: Math.round(at.y),
			button: type === "mouseMoved" ? "none" : "left",
			buttons: type === "mousePressed" ? 1 : 0,
			clickCount: type === "mouseMoved" ? 0 : 1,
		});
	}
	await sleep(300);
}

/**
 * A site set to the Desktop Icon grid asks its System Manager to "Try the new navigation" each time the
 * landing page opens (new_navigation_nudge.js). Hiding the dialog submits nothing: its buttons are what
 * write the answer, and this suite writes nothing.
 */
async function dismissNudge(p: Page): Promise<void> {
	await p.eval(
		`(() => { const d = window.cur_dialog; if (d && /new navigation/i.test(String(d.title || ''))) d.hide(); })()`,
	);
	await sleep(500);
}

/** Both themes of the same state, for the screenshot record. */
async function shoot(p: Page, name: string): Promise<void> {
	await p.screenshot(`${SHOT}/shell-${name}-light.png`);
	await p.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
	await sleep(500);
	await p.screenshot(`${SHOT}/shell-${name}-dark.png`);
	await p.eval(`document.documentElement.setAttribute('data-theme', 'light')`);
	await sleep(400);
}

interface NameState {
	text: string;
	prefix: string | null;
	href: string | null;
	firstSidebarHref: string | null;
	landing: string | null;
	app: string | null;
	label: string | null;
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
interface Rect {
	top: number;
	bottom: number;
	left: number;
	right: number;
	width: number;
	height: number;
}

const RECT = `const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };`;

try {
	await login(page, BASE);
	// A site that configures Carbon Settings brand colours (the dev bench does) repaints the g100 zone, so
	// the cases that assert Carbon's own tokens fail there. CF_NO_BRAND=1 stops the page loading
	// /carbon-brand.css, which is what makes them measure the stock values.
	if (process.env["CF_NO_BRAND"]) await page.send("Network.setBlockedURLs", { urls: ["*carbon-brand.css*"] });
	await viewport(page, 1600, 1000);

	// -- 1. name -------------------------------------------------------------
	await page.goto(`${BASE}/desk/projects`);
	await ready(page, "Projects");
	await assertCarbonStylesheet(page);

	const name = await page.eval<NameState>(`(() => {
		const a = document.querySelector('.cf-shell-header .cds--header__name');
		const prefix = a.querySelector('.cds--header__name--prefix');
		const first = document.querySelector('.body-sidebar .sidebar-items a.item-anchor[href]');
		const sb = frappe.app.sidebar; const app = sb.get_sidebar_app();
		return { text: a.textContent.replace(/\\u00a0/g, ' ').trim(), prefix: prefix && prefix.textContent, href: a.getAttribute('href'), firstSidebarHref: first && first.getAttribute('href'),
			landing: sb.module_landing_route('Projects'), app: app && app.app_title, label: sb.sidebar_data.label };
	})()`);
	ok(
		"header name is '<app title> <module label>'",
		name.text === "ERPNext Projects" && name.app === "ERPNext" && name.label === "Projects",
		JSON.stringify(name),
	);
	ok("prefix span carries the app title", name.prefix === "ERPNext");
	ok(
		"header name links to the module's landing route, which is the sidebar's first link",
		!!name.href && name.href === name.landing && name.href === name.firstSidebarHref,
		`${name.href} vs ${name.landing} vs ${name.firstSidebarHref}`,
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
		JSON.stringify(nav.labels) === JSON.stringify(nav.sidebarLabels) && nav.labels.length === 7,
		JSON.stringify(nav),
	);
	ok(
		"every populated Section Break is a sub-menu",
		nav.submenus === nav.sections && nav.submenus >= 2,
		`${nav.submenus} vs ${nav.sections}`,
	);
	const current = await page.eval<{ header: string[]; sidebar: string[] }>(`(() => ({
		header: [...document.querySelectorAll('.cf-shell-header .cds--header__nav a[aria-current="page"]')].map(a => a.getAttribute('href')),
		sidebar: [...document.querySelectorAll('.body-sidebar .sidebar-items .active-sidebar > a.item-anchor')].map(a => a.getAttribute('href')),
	}))()`);
	ok(
		"the current link is the one row frappe lit (.active-sidebar)",
		current.sidebar.length === 1 && current.header.length === 1 && current.header[0] === current.sidebar[0],
		JSON.stringify(current),
	);
	await shoot(page, "projects");

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
	// frappe writes the shell into the URL (`/desk/projects/task`, router.js:868-910), so the
	// wait is on the end of the path, not the whole of it
	await page.eval(`frappe.set_route('/desk/task')`);
	await page.waitFor(`location.pathname.endsWith('/task')`, { timeout: 30000 });
	await sleep(1200);
	const task = await page.eval<{ current: string[]; shell: string; active: string[] }>(`(() => ({
		current: [...document.querySelectorAll('.cf-shell-header .cds--header__nav a[aria-current="page"]')].map(a => a.textContent.trim()),
		shell: frappe.app.sidebar.current_module,
		active: [...document.querySelectorAll('.body-sidebar .sidebar-items .active-sidebar > a.item-anchor')].map(a => a.textContent.trim()),
	}))()`);
	ok(
		"navigating to /desk/task marks the Task link current, and only it",
		task.current.join() === "Task" && task.active.join() === "Task" && task.shell === "Projects",
		JSON.stringify(task),
	);

	await page.eval(`frappe.set_route('/desk/activity-type')`);
	await page.waitFor(`location.pathname.endsWith('/activity-type')`, { timeout: 30000 });
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
	// ERPNext's Stock sidebar has the most top-level rows of its shells that read as plain
	// links (13); the expected count is the sidebar's own, not a literal
	await page.goto(`${BASE}/desk/stock`);
	await ready(page, "Stock");
	await viewport(page, 1056, 900);
	await sleep(700);
	interface Overflow {
		more: boolean;
		hidden: number;
		inMore: number;
		overlap: boolean;
		total: number;
		rows: number;
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
		const rows = [...document.querySelectorAll('.body-sidebar .sidebar-items > .sidebar-item-container')].filter(r => r.querySelector(':scope > .standard-sidebar-item > .item-anchor > .sidebar-item-label')).length;
		return { more: !more.hidden, hidden, inMore: more.querySelectorAll('a').length - 1, overlap, total: tops.length, rows, name: span.scrollWidth <= span.clientWidth ? name.textContent.replace(/\\u00a0/g, ' ').trim() : 'TRUNCATED' };
	})()`;
	const overflow = await page.eval<Overflow>(OVERFLOW);
	ok(
		"a 13-row sidebar overflows into More at 1056px",
		overflow.more && overflow.hidden > 0 && overflow.total === overflow.rows && overflow.total >= 12,
		JSON.stringify(overflow),
	);
	ok("nothing in the bar overlaps the global bar", !overflow.overlap);
	ok("the name is never squeezed by the bar", overflow.name === "ERPNext Stock", overflow.name);
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
	// The panel is the desktop's list (shell/desktop.ts): the apps screen, or on a site set to the
	// Desktop Icon grid the icons, with the app that owns the shell on screen selected.
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
	const iconMode = await page.eval<boolean>(`Array.isArray(frappe.boot.desktop_icons)`);
	const sw = await page.eval<SwitcherState>(SWITCHER);
	ok(
		"switcher opens a 256px header panel with tabbable rows",
		sw.expanded === "true" && sw.panel && sw.width === "256px" && sw.tab === "0" && sw.active,
		JSON.stringify(sw),
	);
	await shoot(page, "switcher");

	// Apps screen (the default): DesktopPage.render_app_icons (desktop.js:169-212). A site set to the
	// icon grid has no app_data-driven desktop, so the mode is forced for this block by taking the
	// icons out of boot and re-rendering through frappe's own `make_sidebar` (the header's hook).
	const appsMode = await page.eval<{
		rows: string[];
		expected: string[];
		hrefs: string[];
		expectedHrefs: string[];
		selected: string[];
		groups: number;
	}>(`(() => {
		const boot = frappe.boot; const saved = boot.desktop_icons; delete boot.desktop_icons;
		try {
			frappe.app.sidebar.make_sidebar();
			const p = document.querySelector('#cf-switcher-panel');
			const links = [...p.querySelectorAll('.cds--switcher > .cds--switcher__item > .cds--switcher__item-link')];
			const apps = boot.app_data.map((a, i) => [a, i]).filter(([a]) => a.on_apps_screen).sort((x, y) => ((x[0].sequence_id ?? 100) - (y[0].sequence_id ?? 100)) || (x[1] - y[1])).map(([a]) => a);
			return {
				rows: links.map(a => a.textContent.trim()),
				expected: apps.map(a => __(a.app_title)).concat([__('Desktop')]),
				hrefs: links.slice(0, -1).map(a => a.getAttribute('href')),
				expectedHrefs: apps.map(a => frappe.app.sidebar.app_landing_route(a) || a.app_route || '/desk'),
				selected: [...p.querySelectorAll('.cds--switcher__item-link--selected')].map(a => a.textContent.trim()),
				groups: p.querySelectorAll('.cf-switcher__toggle').length,
			};
		} finally { if (saved) boot.desktop_icons = saved; frappe.app.sidebar.make_sidebar(); }
	})()`);
	ok(
		"apps screen: the rows are the on-screen apps in sequence_id order, then Desktop, none nested",
		appsMode.rows.join("|") === appsMode.expected.join("|") &&
			appsMode.groups === 0 &&
			appsMode.rows.length > 2,
		`${appsMode.rows.join("|")} vs ${appsMode.expected.join("|")}`,
	);
	ok(
		"apps screen: each row leads where the desktop's tile does (app_landing_route)",
		appsMode.hrefs.join("|") === appsMode.expectedHrefs.join("|"),
		`${appsMode.hrefs.join("|")} vs ${appsMode.expectedHrefs.join("|")}`,
	);
	ok(
		"apps screen: the app that owns the shell on screen is the selected row",
		appsMode.selected.join() === "ERPNext",
		appsMode.selected.join(),
	);

	if (iconMode) {
		const sw2 = await page.eval<SwitcherState>(SWITCHER);
		// the desktop's own top level, from boot: visible icons whose parent is absent or hidden, in the
		// grid's order (DesktopIconGrid.prepare: idx, then label)
		const expectedRows = await page.eval<string[]>(`(() => {
			const icons = frappe.boot.desktop_icons.filter(i => i.hidden !== 1); const visible = new Set(icons.map(i => i.label));
			const kids = new Set(icons.filter(i => i.parent_icon && visible.has(i.parent_icon)).map(i => i.parent_icon));
			return icons.filter(i => !(i.parent_icon && visible.has(i.parent_icon))).filter(i => i.icon_type !== 'Folder' || kids.has(i.label)).sort((a, b) => a.idx === b.idx ? a.label.localeCompare(b.label) : a.idx - b.idx).map(i => __(i.label)).concat([__('Desktop')]);
		})()`);
		ok(
			"icon grid: the rows are the desktop's icons in the desktop's order, then Desktop; Projects' icon is selected",
			sw2.rows.join("|") === expectedRows.join("|") && sw2.selected.join() === "Projects",
			`${sw2.rows.join("|")} vs ${expectedRows.join("|")} / ${sw2.selected.join()}`,
		);
		ok(
			"icon grid: Accounting is a disclosure row (a Folder), Framework too (an App with workspaces)",
			sw2.groups.includes("Accounting") && sw2.groups.includes("Framework"),
			sw2.groups.join(),
		);

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
			`frappe.boot.desktop_icons.filter(i => i.parent_icon === 'Accounting' && i.hidden !== 1).sort((a, b) => a.idx === b.idx ? a.label.localeCompare(b.label) : a.idx - b.idx).map(i => __(i.label))`,
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
		await key(page, "Escape");
	}

	// the panel was closed above in icon mode; reopen it so the keyboard rows are tabbable
	await page.eval(
		`(() => { const b = document.querySelector('#cf-switcher-button'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()`,
	);
	await sleep(300);
	await page.eval(`document.querySelector('#cf-switcher-panel .cds--switcher__item-link').focus()`);
	await key(page, "ArrowDown");
	const moved = await page.eval<string>(`document.activeElement.textContent.trim()`);
	const second = await page.eval<string>(
		`document.querySelectorAll('#cf-switcher-panel .cds--switcher > .cds--switcher__item')[1].textContent.trim()`,
	);
	ok("ArrowDown moves focus through the switcher", moved === second, `${moved} vs ${second}`);
	await key(page, "Escape");
	const swClosed = await page.eval<{ expanded: string | null; focused: boolean }>(
		`(() => { const b = document.querySelector('#cf-switcher-button'); return { expanded: b.getAttribute('aria-expanded'), focused: document.activeElement === b }; })()`,
	);
	ok(
		"Escape closes the switcher and refocuses its button",
		swClosed.expanded === "false" && swClosed.focused,
		JSON.stringify(swClosed),
	);

	// the selected row follows the app: Frappe's Build shell belongs to Framework
	await page.goto(`${BASE}/desk/build`);
	await ready(page, "Build");
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	await sleep(400);
	const onBuild = await page.eval<{ selected: string[]; name: string }>(`({
		selected: [...document.querySelectorAll('#cf-switcher-panel .cds--switcher__item-link--selected')].map(a => a.textContent.trim()),
		name: document.querySelector('.cf-shell-header .cds--header__name').textContent.replace(/\\u00a0/g, ' ').trim(),
	})`);
	ok(
		"on Build the switcher selects Framework and the name reads '<app> <module>'",
		(iconMode ? onBuild.selected.join() === "Build" : onBuild.selected.join() === "Framework") &&
			onBuild.name === "Framework Build",
		JSON.stringify(onBuild),
	);
	await key(page, "Escape");
	await page.goto(`${BASE}/desk/projects`);
	await ready(page, "Projects");

	// -- 7. hamburger ------------------------------------------------------------
	const HAMBURGER = `(() => ({
		expanded: frappe.app.sidebar.sidebar_expanded,
		aria: document.querySelector('.cds--header__menu-toggle').getAttribute('aria-expanded'),
		disabled: document.querySelector('.cds--header__menu-toggle').disabled,
		hidden: document.querySelector('.body-sidebar-container').classList.contains('sidebar-hidden'),
		glyph: !!document.querySelector('.cds--header__menu-toggle svg'),
		visibleToggles: [...document.querySelectorAll('.cds--header__menu-toggle, .page-head .sidebar-toggle-btn')].filter(b => b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none').length,
	}))()`;
	const before = await page.eval<{
		expanded: boolean;
		aria: string | null;
		disabled: boolean;
		hidden: boolean;
		glyph: boolean;
		visibleToggles: number;
	}>(HAMBURGER);
	await page.eval(`document.querySelector('.cds--header__menu-toggle').click()`);
	await sleep(700);
	const after = await page.eval<typeof before>(HAMBURGER);
	ok(
		"hamburger toggles the sidebar and mirrors sidebar_expanded in aria-expanded",
		before.expanded !== after.expanded &&
			after.aria === String(after.expanded) &&
			before.aria === String(before.expanded),
		JSON.stringify({ before, after }),
	);
	// beside a pinned dock a collapsed sidebar slides shut, and the control that brings it back must
	// not be the one frappe's `sidebar-expand` argument ("not a rail") says is still open
	ok(
		"a collapsed sidebar is aria-expanded=false whether it folded to a rail or slid shut, and the hamburger stays enabled",
		after.aria === "false" && !after.disabled,
		JSON.stringify(after),
	);
	ok("hamburger keeps the Menu glyph", after.glyph);
	await page.eval(`document.querySelector('.cds--header__menu-toggle').click()`);
	await sleep(700);
	const reopened = await page.eval<typeof before>(HAMBURGER);
	ok(
		"a second click reopens it",
		reopened.expanded === true && reopened.aria === "true",
		JSON.stringify(reopened),
	);
	ok("there is one hamburger at 1600px", reopened.visibleToggles === 1, String(reopened.visibleToggles));
	await viewport(page, 900, 800);
	const narrowToggles = await page.eval<number>(
		`[...document.querySelectorAll('.cds--header__menu-toggle, .page-head .sidebar-toggle-btn')].filter(b => b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none').length`,
	);
	ok(
		"there is still one hamburger between 768 and 991px, where the page head carries its own",
		narrowToggles === 1,
		String(narrowToggles),
	);
	await viewport(page, 1600, 1000);

	// -- 8. search, notifications, account --------------------------------------------
	const cells = await page.eval<{
		search: string | null;
		bell: string | null;
		account: string | null;
		order: string[];
	}>(`(() => {
		const g = document.querySelector('.cf-shell-header .cds--header__global');
		return {
			search: g.querySelector('.cf-header__search') && g.querySelector('.cf-header__search').getAttribute('aria-label'),
			bell: g.querySelector('.cf-header__bell') && g.querySelector('.cf-header__bell').getAttribute('aria-label'),
			account: g.querySelector('.cf-header__account') && g.querySelector('.cf-header__account').getAttribute('aria-label'),
			order: [...g.children].map(c => c.classList.contains('cf-header__search') ? 'search' : c.classList.contains('cf-header__bell') ? 'bell' : c.classList.contains('cf-header__account') ? 'account' : c.id === 'cf-ai-trigger' ? 'ai' : c.id === 'cf-switcher-button' ? 'switcher' : '?'),
		};
	})()`);
	ok(
		"the global bar is search, bell, account, [assistant], switcher — one of each",
		cells.search === "Search" &&
			cells.bell === "Notifications" &&
			cells.account === "User Menu" &&
			["search", "bell", "account", "switcher"].every(
				(c, i) => c === cells.order.filter((o) => o !== "ai")[i],
			) &&
			cells.order[cells.order.length - 1] === "switcher",
		JSON.stringify(cells),
	);

	// search: the cell carries the class frappe's awesome bar delegates its click to, so frappe's own
	// handler opens (and a second click closes) the search modal
	await pointerClick(page, ".cf-shell-header .cf-header__search");
	const searchOpen = await page.eval<{ open: boolean; modal: boolean }>(
		`({ open: frappe.app.awesome_bar.is_open(), modal: !!document.querySelector('.modal.show #navbar-search') })`,
	);
	ok(
		"the search cell opens frappe's search modal",
		searchOpen.open && searchOpen.modal,
		JSON.stringify(searchOpen),
	);
	const searchAbove = await page.eval<boolean>(
		`(() => { const el = document.elementFromPoint(24, 24); return !!el && !el.closest('.cf-shell-header'); })()`,
	);
	ok("the modal's backdrop covers the header", searchAbove);
	// a second click on the cell is the toggle, but the modal's backdrop is over it by now: close it the way
	// frappe's own Ctrl+K does
	await page.eval(`frappe.app.awesome_bar.close()`);
	await sleep(500);
	const searchClosed = await page.eval<boolean>(`!frappe.app.awesome_bar.is_open()`);
	ok("it closes again", searchClosed);

	// bell: frappe's panel, re-hosted on <body> and drawn as a right header panel
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	const bell = await page.eval<{
		open: boolean;
		parent: string | undefined;
		expanded: string | null;
		position: string;
		rect: Rect | null;
		bg: string;
		tabs: number;
		viewport: number;
		viewportHeight: number;
	}>(`(() => {
		${RECT}
		const p = frappe.ui.sidebar_panels.get('notifications'); const el = p && p.$panel[0]; const cs = el && getComputedStyle(el);
		return { open: !!(p && p.is_open), parent: el && el.parentElement.tagName, expanded: document.querySelector('.cf-header__bell').getAttribute('aria-expanded'),
			position: cs && cs.position, rect: rect(el), bg: cs && cs.backgroundColor, tabs: el ? el.querySelectorAll('.es-tab-buttons button, .es-pill').length : 0, viewport: innerWidth, viewportHeight: innerHeight };
	})()`);
	ok(
		"the bell opens frappe's notifications panel (aria-expanded mirrored)",
		bell.open && bell.expanded === "true" && bell.tabs >= 2,
		JSON.stringify(bell),
	);
	ok(
		"the panel is a fixed right header panel: under the header, flush to the end, full height, 360px",
		bell.parent === "BODY" &&
			bell.position === "fixed" &&
			!!bell.rect &&
			bell.rect.top === 48 &&
			bell.rect.right === bell.viewport &&
			bell.rect.width === 360 &&
			bell.rect.bottom === bell.viewportHeight,
		JSON.stringify(bell),
	);
	ok("the panel is on the g100 $layer", bell.bg === "rgb(38, 38, 38)", bell.bg);
	await shoot(page, "notifications");
	await pointerClick(page, ".cf-shell-header #cf-switcher-button");
	const yielded = await page.eval<{ notifications: boolean; switcher: boolean }>(
		`({ notifications: !!frappe.ui.sidebar_panels.open_panel, switcher: document.querySelector('#cf-switcher-panel').classList.contains('cds--header-panel--expanded') })`,
	);
	ok(
		"opening the switcher closes the notifications panel",
		!yielded.notifications && yielded.switcher,
		JSON.stringify(yielded),
	);
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	const yielded2 = await page.eval<{ notifications: boolean; switcher: boolean }>(
		`({ notifications: !!(frappe.ui.sidebar_panels.open_panel && frappe.ui.sidebar_panels.open_panel.name === 'notifications'), switcher: document.querySelector('#cf-switcher-panel').classList.contains('cds--header-panel--expanded') })`,
	);
	ok(
		"opening the bell closes the switcher",
		yielded2.notifications && !yielded2.switcher,
		JSON.stringify(yielded2),
	);
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	const bellClosed = await page.eval<{ open: boolean; expanded: string | null }>(
		`({ open: !!(frappe.ui.sidebar_panels.get('notifications') || {}).is_open, expanded: document.querySelector('.cf-header__bell').getAttribute('aria-expanded') })`,
	);
	ok(
		"a second click on the bell closes it",
		!bellClosed.open && bellClosed.expanded === "false",
		JSON.stringify(bellClosed),
	);

	const badge = await page.eval<{ text: string; hidden: boolean; bg: string; count: number }>(`(() => {
		frappe.app.sidebar.notifications.tabs.notifications.update_count_badge(3);
		const b = document.querySelector('.cf-shell-header .notification-count');
		return { text: b.textContent.trim(), hidden: b.classList.contains('hidden'), bg: getComputedStyle(b).backgroundColor, count: document.querySelectorAll('.cf-shell-header .notification-count').length };
	})()`);
	// #fa4d56 is $support-error in g100 — the zone's value, not the page's #da1e28
	ok(
		"update_count_badge paints the header's badge",
		badge.text === "3" && !badge.hidden && badge.bg === "rgb(250, 77, 86)" && badge.count === 1,
		JSON.stringify(badge),
	);
	await page.eval(`frappe.app.sidebar.notifications.tabs.notifications.update_count_badge(0)`);

	// account: frappe's user menu, built once on the cell
	await pointerClick(page, ".cf-shell-header .cf-header__account");
	const menu = await page.eval<{
		labels: string[];
		open: boolean;
		above: boolean;
		avatar: Rect | null;
		menus: number;
	}>(`(() => {
		${RECT}
		const m = document.querySelector('.es-menu'); const r = m && m.getBoundingClientRect();
		const at = r ? document.elementFromPoint(r.left + 8, r.top + 8) : null;
		return { labels: [...document.querySelectorAll('.es-menu .es-menu__label')].map(l => l.textContent.trim()), open: !!m, above: !!at && !!m && m.contains(at),
			avatar: rect(document.querySelector('.cf-shell-header .cf-header__account .avatar')), menus: document.querySelectorAll('.es-menu').length };
	})()`);
	ok(
		"the account cell opens frappe's user menu, once, above the header",
		menu.open &&
			menu.menus === 1 &&
			menu.above &&
			menu.labels.includes("Settings") &&
			menu.labels.includes("Logout"),
		JSON.stringify(menu),
	);
	ok(
		"the avatar is 24px in its 48px cell",
		!!menu.avatar && menu.avatar.width === 24 && menu.avatar.height === 24,
		JSON.stringify(menu.avatar),
	);
	// the menu was opened with the pointer, so focus is still on the cell and Escape is not what closes it
	// (it is, once focus is in the menu); a click on the bar's empty stretch is the outside click
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: 1150,
		y: 24,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: 1150,
		y: 24,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await sleep(400);
	const menuClosed = await page.eval<{ menus: number; active: boolean }>(
		`({ menus: document.querySelectorAll('.es-menu').length, active: document.querySelector('.cf-header__account').classList.contains('user-menu-active') })`,
	);
	ok(
		"a click outside closes the menu and releases the cell",
		menuClosed.menus === 0 && !menuClosed.active,
		JSON.stringify(menuClosed),
	);

	// -- 9. beside frappe's dock and sidebar ------------------------------------------
	const layout = await page.eval<{
		header: Rect | null;
		dock: Rect | null;
		dockLogo: Rect | null;
		logoOnTop: boolean;
		sidebar: Rect | null;
		main: Rect | null;
		dockZ: string;
		headerZ: string;
		hidden: Record<string, string>;
		pinned: boolean;
		viewportHeight: number;
		overflowY: number;
	}>(`(() => {
		${RECT}
		const logo = document.querySelector('.dock .dock-logo .shell-header'); const lr = logo && logo.getBoundingClientRect();
		const at = lr ? document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2) : null;
		const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'absent'; };
		return {
			header: rect(document.querySelector('.cf-shell-header')), dock: rect(document.querySelector('#desk-dock')), dockLogo: rect(logo),
			logoOnTop: !!at && !!logo && logo.contains(at), sidebar: rect(document.querySelector('.body-sidebar')), main: rect(document.querySelector('.main-section')),
			dockZ: getComputedStyle(document.querySelector('#desk-dock')).zIndex, headerZ: getComputedStyle(document.querySelector('.cf-shell-header')).zIndex,
			hidden: { band: disp('.standard-items-band'), chip: disp('.body-sidebar .dropdown-navbar-user'), dockUser: disp('.dock .dock-user'), navbar: disp('.desktop-navbar') },
			pinned: document.body.classList.contains('dock-pinned'), viewportHeight: innerHeight, overflowY: document.documentElement.scrollHeight - innerHeight,
		};
	})()`);
	ok(
		"the pinned dock starts under the header, its logo is visible and not covered",
		layout.pinned &&
			!!layout.dock &&
			layout.dock.top === 48 &&
			layout.dock.bottom === layout.viewportHeight &&
			layout.logoOnTop &&
			Number(layout.dockZ) < Number(layout.headerZ),
		JSON.stringify({
			dock: layout.dock,
			logo: layout.dockLogo,
			onTop: layout.logoOnTop,
			z: [layout.dockZ, layout.headerZ],
		}),
	);
	ok(
		"the sidebar and the content column start under the header and end at the viewport",
		!!layout.sidebar &&
			!!layout.main &&
			layout.sidebar.top === 48 &&
			layout.main.top === 48 &&
			layout.sidebar.bottom === layout.viewportHeight &&
			layout.main.bottom === layout.viewportHeight &&
			!!layout.dock &&
			layout.sidebar.left >= layout.dock.right - 1 &&
			layout.overflowY <= 0,
		JSON.stringify({ sidebar: layout.sidebar, main: layout.main, dock: layout.dock, over: layout.overflowY }),
	);
	ok(
		"what the header replaces is not drawn: the search/notification band, the sidebar's user chip, the dock's avatar, the landing navbar",
		layout.hidden["band"] === "none" &&
			layout.hidden["chip"] === "none" &&
			layout.hidden["dockUser"] === "none" &&
			(layout.hidden["navbar"] === "none" || layout.hidden["navbar"] === "absent"),
		JSON.stringify(layout.hidden),
	);
	// a panel beside the sidebar (any `frappe.ui.SidebarPanel` an app registers) fits the viewport
	const sidePanel = await page.eval<{ rect: Rect | null; fits: boolean }>(`(() => {
		${RECT}
		const p = new frappe.ui.SidebarPanel({ name: 'cf-test-panel', title: 'CF test' });
		try { p.show(); const r = rect(p.$panel[0]); return { rect: r, fits: !!r && r.bottom <= innerHeight && r.top >= 48 }; }
		finally { p.hide(); p.$panel.remove(); delete frappe.ui.sidebar_panels.panels['cf-test-panel']; }
	})()`);
	ok(
		"a panel beside the sidebar fits the viewport under the header (it overflowed by the header's row)",
		sidePanel.fits,
		JSON.stringify(sidePanel.rect),
	);

	// the floating dock: the preference is applied in place (`set_pinned`), never saved here
	const floating = await page.eval<{
		pinned: boolean;
		open: boolean;
		dock: Rect | null;
		z: string;
		sidebarLeft: number;
	}>(`(() => {
		${RECT}
		const d = frappe.app.sidebar.dock; d.set_pinned(false); d.open();
		const r = rect(document.querySelector('#desk-dock'));
		return { pinned: document.body.classList.contains('dock-pinned'), open: document.body.classList.contains('dock-open'), dock: r, z: getComputedStyle(document.querySelector('#desk-dock')).zIndex, sidebarLeft: rect(document.querySelector('.body-sidebar')).left };
	})()`);
	await sleep(500);
	const floatingRect = await page.eval<Rect | null>(
		`(() => { ${RECT} return rect(document.querySelector('#desk-dock')); })()`,
	);
	ok(
		"a floating dock is a tray under the header: it opens clear of it, above the sidebar and below the assistant",
		!floating.pinned &&
			floating.open &&
			!!floatingRect &&
			floatingRect.top >= 48 &&
			Number(floating.z) > 1021 &&
			Number(floating.z) < 1025,
		JSON.stringify({ floatingRect, z: floating.z }),
	);
	await shoot(page, "floating-dock");
	await page.eval(`(() => { const d = frappe.app.sidebar.dock; d.set_pinned(true); })()`);
	await sleep(600);
	const repinned = await page.eval<boolean>(`document.body.classList.contains('dock-pinned')`);
	ok("pinning it again restores the column", repinned);

	// -- 10. geometry + z-order, light and dark ---------------------------------------
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
	// The assistant trigger is a fifth cell when flow is installed
	const expectedCells =
		4 + ((await page.eval<boolean>(`!!document.querySelector('#cf-ai-trigger')`)) ? 1 : 0);
	ok(
		"every utility is a 48x48 cell, no gaps, icon on $icon-secondary",
		light.cellCount === expectedCells &&
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

	// -- 11. landing page ---------------------------------------------------------
	await page.goto(`${BASE}/desk`);
	await page.waitFor(
		`!!document.querySelector('.cf-shell-header .cds--header__name') && !!document.querySelector('.desktop-container') && !!document.querySelector('.desktop-container .desktop-icon, .desktop-container .icons .icon')`,
		{ timeout: 90000 },
	);
	await sleep(1500);
	await dismissNudge(page);
	const landing = await page.eval<{
		name: string;
		navHidden: boolean;
		menuDisabled: boolean;
		searches: number;
		bells: number;
		accounts: number;
		navbar: string;
		desktopCells: number;
		dock: boolean;
		sidebar: string;
	}>(`(() => {
		const h = document.querySelector('.cf-shell-header'); const nb = document.querySelector('.desktop-navbar');
		return { name: h.querySelector('.cds--header__name').textContent.trim(), navHidden: h.querySelector('.cds--header__nav').hidden, menuDisabled: h.querySelector('.cds--header__menu-toggle').disabled,
			searches: h.querySelectorAll('.cf-header__search').length, bells: h.querySelectorAll('.cf-header__bell').length, accounts: h.querySelectorAll('.cf-header__account').length,
			navbar: nb ? getComputedStyle(nb).display : 'absent', desktopCells: h.querySelectorAll('.desktop-notifications, .desktop-avatar, .search-widget-wrapper').length,
			dock: !!document.querySelector('#desk-dock') && getComputedStyle(document.querySelector('#desk-dock')).display !== 'none', sidebar: getComputedStyle(document.querySelector('.body-sidebar-container')).display };
	})()`);
	ok(
		"landing page: name 'Desktop', nav hidden, hamburger disabled, one search + one bell + one account, frappe's own navbar not drawn, no dock or sidebar",
		landing.name === "Desktop" &&
			landing.navHidden &&
			landing.menuDisabled &&
			landing.searches === 1 &&
			landing.bells === 1 &&
			landing.accounts === 1 &&
			landing.navbar === "none" &&
			landing.desktopCells === 0 &&
			!landing.dock &&
			landing.sidebar === "none",
		JSON.stringify(landing),
	);
	// the landing page's own search still works from the header cell
	await pointerClick(page, ".cf-shell-header .cf-header__search");
	const landingSearch = await page.eval<boolean>(`!!document.querySelector('.modal.show #navbar-search')`);
	await page.eval(`frappe.app.awesome_bar.close()`);
	await sleep(500);
	ok("landing page: the header's search cell opens the search modal", landingSearch);
	// and the bell opens the same panel there, though the sidebar's container is hidden
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	const landingBell = await page.eval<{ open: boolean; visible: boolean; rect: Rect | null }>(`(() => {
		${RECT}
		const p = frappe.ui.sidebar_panels.get('notifications'); const el = p && p.$panel[0];
		return { open: !!(p && p.is_open), visible: !!el && el.getClientRects().length > 0, rect: rect(el) };
	})()`);
	ok(
		"landing page: the bell opens the notifications panel at the right edge",
		landingBell.open &&
			landingBell.visible &&
			!!landingBell.rect &&
			landingBell.rect.top === 48 &&
			landingBell.rect.width === 360,
		JSON.stringify(landingBell),
	);
	await shoot(page, "landing-notifications");
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	await sleep(300);
	// the desktop itself is the reference: its rendered top-level icons, in order
	if (iconMode) {
		const parity = await page.eval<{ desktop: string[]; switcher: string[] }>(`(() => {
			const desktop = [...document.querySelectorAll('.desktop-container .desktop-icon')].filter(i => !i.parentElement.closest('.desktop-icon')).map(i => i.querySelector('.icon-title')?.textContent.trim()).filter(Boolean);
			const top = [...document.querySelectorAll('#cf-switcher-panel .cds--switcher > .cds--switcher__item > .cds--switcher__item-link')].map(a => a.textContent.trim());
			return { desktop, switcher: top.slice(0, -1) };
		})()`);
		ok(
			"landing page: the switcher rows equal the rendered desktop's top-level icons",
			parity.desktop.length > 0 && parity.switcher.join("|") === parity.desktop.join("|"),
			`${parity.switcher.join("|")} vs ${parity.desktop.join("|")}`,
		);
	}
	await page.eval(`document.querySelector('#cf-switcher-button').click()`);
	await sleep(400);
	await shoot(page, "landing-switcher");
	await key(page, "Escape");
	// visiting the landing page again rebuilds frappe's navbar; nothing doubles
	await page.eval(`frappe.set_route('/desk/projects')`);
	await page.waitFor(`location.pathname.startsWith('/desk/projects')`, { timeout: 30000 });
	await sleep(800);
	await page.eval(`frappe.set_route('/desk')`);
	await page.waitFor(`location.pathname === '/desk'`, { timeout: 30000 });
	await sleep(1200);
	// a bench that rebuilds its bundles under the run reloads the page; wait for the header to come back
	await page.waitFor(`!!document.querySelector('.cf-shell-header .cf-header__bell')`, { timeout: 60000 });
	await dismissNudge(page);
	const revisit = await page.eval<{
		bells: number;
		accounts: number;
		searches: number;
		counts: number;
	}>(`(() => {
		const h = document.querySelector('.cf-shell-header');
		return { bells: h.querySelectorAll('.cf-header__bell').length, accounts: h.querySelectorAll('.cf-header__account').length, searches: h.querySelectorAll('.cf-header__search').length, counts: document.querySelectorAll('.cf-shell-header .notification-count').length };
	})()`);
	ok(
		"revisiting the landing page leaves one of each cell",
		revisit.bells === 1 && revisit.accounts === 1 && revisit.searches === 1 && revisit.counts === 1,
		JSON.stringify(revisit),
	);
	await pointerClick(page, ".cf-shell-header .cf-header__bell");
	const revisitBell = await page.eval<number>(
		`document.querySelectorAll('.sidebar-panel-notifications:not(.hidden)').length`,
	);
	ok(
		"revisiting the landing page: the bell still opens exactly one panel",
		revisitBell === 1,
		String(revisitBell),
	);
	await pointerClick(page, ".cf-shell-header .cf-header__bell");

	// -- 12. mobile: frappe fills <header>, the shell stays out ----------------------
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 767,
		height: 900,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await page.goto(`${BASE}/desk/projects`);
	await page.waitFor(`!!(frappe.app && frappe.app.sidebar)`, { timeout: 90000 });
	await sleep(2500);
	const mobile = await page.eval<{ shell: boolean; bodyClass: boolean; sticky: boolean; band: string }>(
		`(() => ({ shell: !!document.querySelector('.cf-shell-header'), bodyClass: document.body.classList.contains('cf-has-shell'), sticky: !!document.querySelector('.main-section .sticky-top'), band: getComputedStyle(document.querySelector('.standard-items-band')).display }))()`,
	);
	ok(
		"under 768px the shell does not mount, frappe's own header stands and its search / notification rows are not hidden",
		!mobile.shell && !mobile.bodyClass && mobile.sticky && mobile.band !== "none",
		JSON.stringify(mobile),
	);
	await page.send("Emulation.clearDeviceMetricsOverride");

	// the Projects dashboard's chart draws a NaN path while it has no data (frappe-charts); not the header's
	const errs = page.consoleErrors().filter((e) => !/favicon|404|attribute d: Expected number/.test(e));
	ok("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
	results.push(`FAIL  suite threw: ${e instanceof Error ? e.stack || e.message : String(e)}`);
} finally {
	page.close();
	proc.kill();
}

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
