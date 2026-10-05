// AI assistant: the header action, the takeover of flow's panel, the lazy chat bundle,
// streaming, approvals, scroll pinning, keyboard, themes and the load-failure fallback, then the
// conversation history (list, search, switch, rename, delete, windowing), feedback, timestamps and
// the polish of the first release (error layout, retry, setup mode, reduced-motion dots), and
// attachments (picker, drop and paste, validation, progress and cancel, send, retry, restore).
//
// Every assertion is a contract between the always-loaded shell (anatomy/shell/assistant.ts),
// the lazy chat (public/js/ai_chat) and flow. Flow is the real backend; its model is a
// scripted OpenAI-compatible server (mock-llm.ts) so the replies, tool calls and failures
// are deterministic. The suite creates, and always removes, its own Flow Model, Tools and
// Agent (every name carries the "CF AI Test" prefix), the sessions they own (the chats it has
// through the UI, a 200-message session and a Trigger session it inserts over REST), the ToDos
// the approvals create and the File docs its uploads leave. Sessions of other agents and other
// users are never touched.
//
//   CF_SITE_URL=http://127.0.0.1:8889 node scripts/test-shell.ts assistant
//   CF_SITE_URL=http://127.0.0.1:8889 node scripts/shell/assistant.ts --cleanup-only
//   CF_AI_ONLY=AI-28,AI-29 CF_SITE_URL=... node scripts/shell/assistant.ts       just those cases
//   CF_AI_TRACE=1 ...                                                             each assertion as it happens
//
// Requires a bench with carbon_frappe and flow built, `yarn build:chat` run (case AI-01 says
// so when it was not), and `chromium` on PATH. Without flow installed the suite asserts the
// negative of AI-01 and stops. Screenshots land in .dev-dist/screenshots/.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCarbonStylesheet, launch, newPage, login } from "../tables/cdp.ts";
import type { CdpEvent, Page } from "../tables/cdp.ts";
import { startMockLlm } from "./mock-llm.ts";
import type { MockLlm } from "./mock-llm.ts";

const BASE = process.env.CF_SITE_URL || "http://localhost:8794";
const SHOT = process.env.CF_SHOT_DIR || new URL("../../.dev-dist/screenshots/", import.meta.url).pathname;
fs.mkdirSync(SHOT, { recursive: true });

const MODEL = "CF AI Test Model";
const AGENT = "CF AI Test Agent";
const TOOL_READ = "cf_ai_test_read";
const TOOL_CREATE = "cf_ai_test_create";
const CLEANUP_ONLY = process.argv.includes("--cleanup-only");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- results -------------------------------------------------------------------

const results: string[] = [];
let passed = 0;
let failed = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
	return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

/**
 * Record one assertion. `observed` is printed on every line and `expected` on a failing one, so
 * the fix loop sees both sides without re-running with a debugger attached.
 */
function ok(id: string, name: string, cond: unknown, observed?: unknown, expected?: string): void {
	const seen = observed === undefined ? "" : `  got ${show(observed)}`;
	if (process.env.CF_AI_TRACE) console.error(`  ${cond ? "pass" : "FAIL"} ${id} ${name}`);
	if (cond) {
		passed++;
		results.push(`PASS  ${id}  ${name}${seen}`);
	} else {
		failed++;
		results.push(`FAIL  ${id}  ${name}${seen}${expected === undefined ? "" : `  expected ${expected}`}`);
	}
}

function fail(id: string, name: string, reason: string): void {
	ok(id, name, false, reason);
}

/** `CF_AI_ONLY=AI-28,AI-33` runs just those cases (AI-28 builds the conversations the history cases use). */
const ONLY = process.env.CF_AI_ONLY?.split(",").map((id) => id.trim()) ?? null;

async function group(id: string, body: () => Promise<void>): Promise<void> {
	if (ONLY !== null && !ONLY.includes(id)) return;
	const started = results.length;
	try {
		await body();
	} catch (e) {
		fail(id, "case aborted", e instanceof Error ? e.message : String(e));
	}
	for (const line of results.slice(started)) console.log(line);
}

// -- network and error log -------------------------------------------------------

interface NetEntry {
	at: number;
	method: string;
	url: string;
	postData: string | undefined;
}

interface ErrorEntry {
	at: number;
	/** `uncaught` is an exception or unhandled rejection; `console` is a console.error or a logged error. */
	kind: "console" | "uncaught";
	text: string;
}

const net: NetEntry[] = [];
const errors: ErrorEntry[] = [];
/** Windows in which a console error is the designed outcome (a blocked bundle, a cut stream). */
const tolerated: Array<[from: number, to: number]> = [];
const listeners: Array<(event: CdpEvent) => void> = [];

function dig(value: unknown, ...keys: string[]): unknown {
	let cursor = value;
	for (const key of keys) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * `page.events` is cleared by every `goto`, which would drop the requests and errors of the very
 * page load the first cases assert on. Tapping `push` sees each notification before that.
 */
function tap(page: Page): void {
	const push = page.events.push.bind(page.events);
	page.events.push = (...events: CdpEvent[]): number => {
		for (const event of events) record(event);
		return push(...events);
	};
}

function record(event: CdpEvent): void {
	const at = Date.now();
	if (event.method === "Network.requestWillBeSent") {
		const url = str(dig(event.params, "request", "url"));
		if (url !== undefined) {
			net.push({
				at,
				method: str(dig(event.params, "request", "method")) ?? "GET",
				url,
				postData: str(dig(event.params, "request", "postData")),
			});
		}
	} else if (event.method === "Runtime.exceptionThrown") {
		const details = dig(event.params, "exceptionDetails");
		const text =
			str(dig(details, "exception", "description")) ?? str(dig(details, "text")) ?? "uncaught exception";
		errors.push({ at, kind: "uncaught", text });
	} else if (event.method === "Runtime.consoleAPICalled" && dig(event.params, "type") === "error") {
		const args = dig(event.params, "args");
		const text = Array.isArray(args)
			? args.map((a) => str(dig(a, "description")) ?? show(dig(a, "value"))).join(" ")
			: "console.error";
		errors.push({ at, kind: "console", text });
	} else if (event.method === "Log.entryAdded") {
		const entry = dig(event.params, "entry");
		if (dig(entry, "level") === "error" && dig(entry, "source") !== "network") {
			errors.push({
				at,
				kind: "console",
				text: `${show(dig(entry, "source"))}: ${show(dig(entry, "text"))}`,
			});
		}
	}
	for (const listener of listeners) listener(event);
}

const netMark = (): number => net.length;
const netSince = (mark: number, pattern: RegExp): NetEntry[] =>
	net.slice(mark).filter((n) => pattern.test(n.url));

async function until(cond: () => boolean, timeout = 5000): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await sleep(50);
	}
	return cond();
}

/** Hold every request matching `pattern` for `ms`, through the Fetch domain. Returns the release. */
async function delayRequests(page: Page, pattern: string, ms: number): Promise<() => Promise<void>> {
	const listener = (event: CdpEvent): void => {
		if (event.method !== "Fetch.requestPaused") return;
		const requestId = str(dig(event.params, "requestId"));
		if (requestId === undefined) return;
		setTimeout(() => {
			page.send("Fetch.continueRequest", { requestId }).catch(() => {});
		}, ms);
	};
	listeners.push(listener);
	await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Request" }] });
	return async () => {
		listeners.splice(listeners.indexOf(listener), 1);
		await page.send("Fetch.disable");
	};
}

// -- input -----------------------------------------------------------------------

const KEY_CODES: Record<string, number> = {
	Enter: 13,
	Escape: 27,
	ArrowUp: 38,
	ArrowDown: 40,
	Home: 36,
	End: 35,
	Backspace: 8,
	Tab: 9,
	" ": 32,
	i: 73,
};
const CTRL = 2;
const SHIFT = 8;

/**
 * A key press that reaches both Lit handlers (`key`) and frappe's shortcut table, which maps
 * `keyCode` and so needs the virtual key code a bare CDP event lacks.
 */
async function press(page: Page, key: string, modifiers = 0): Promise<void> {
	const code = KEY_CODES[key] ?? 0;
	const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
	const base = {
		key,
		code: key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key,
		modifiers,
		windowsVirtualKeyCode: code,
		nativeVirtualKeyCode: code,
	};
	await page.send("Input.dispatchKeyEvent", {
		...base,
		type: text ? "keyDown" : "rawKeyDown",
		...(text ? { text } : {}),
	});
	await page.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
	await sleep(150);
}

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A real pointer click at the centre of the element `expr` evaluates to. Shadow DOM and `:hover` need one. */
async function click(page: Page, expr: string, scroll = true, fx = 0.5): Promise<void> {
	const box = await page.eval<Box | null>(
		`(() => { const el = ${expr}; return el ? window.__ai.center(el, ${scroll}, ${fx}) : null; })()`,
	);
	if (box === null || box.w === 0 || box.h === 0) throw new Error(`cannot click ${expr}: not rendered`);
	const at = { x: Math.round(box.x), y: Math.round(box.y) };
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, buttons: 0 });
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...at,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		...at,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await sleep(150);
}

async function insertText(page: Page, text: string): Promise<void> {
	await page.send("Input.insertText", { text });
	await sleep(100);
}

async function viewport(page: Page, width: number, height: number): Promise<void> {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await sleep(400);
}

// -- page-side helpers --------------------------------------------------------------
// Installed before any document script runs, so they survive every reload. Plain JS: the string
// is evaluated in the page, and a backtick inside it would end the template literal.

const LIB = String.raw`(() => {
	if (window.__ai) return;
	const A = (window.__ai = {});
	const host = () => document.getElementById('cf-ai-panel');
	const norm = (s) => s.replace(/\s+/g, ' ').trim();

	function deepAll(root, sel, out) {
		out = out || [];
		if (root.querySelectorAll) for (const m of root.querySelectorAll(sel)) out.push(m);
		if (root.shadowRoot) deepAll(root.shadowRoot, sel, out);
		if (root.querySelectorAll) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
		return out;
	}
	function deepText(node) {
		if (node.nodeType === 3) return node.textContent;
		if (node.nodeType !== 1 && node.nodeType !== 11) return '';
		if (node.nodeName === 'STYLE' || node.nodeName === 'SCRIPT') return '';
		let t = '';
		if (node.shadowRoot) t += deepText(node.shadowRoot);
		for (const c of node.childNodes) t += deepText(c);
		return t;
	}
	function deepActive() {
		let el = document.activeElement;
		while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
		return el;
	}
	A.deepAll = deepAll;
	A.deepText = (n) => norm(deepText(n));
	A.deepActive = deepActive;
	A.host = host;

	A.prompt = () => document.querySelector('#cf-ai-panel cds-aichat-prompt-line');
	A.textarea = () => { const p = A.prompt(); return p ? deepAll(p, 'textarea')[0] || null : null; };
	A.send = () => document.querySelector('#cf-ai-panel cds-aichat-input-send-control');
	A.scroller = () => document.querySelector('#cf-ai-panel .cf-ai-messages');
	A.rows = () => [...document.querySelectorAll('#cf-ai-panel .cf-ai-message')];
	A.userRows = () => A.rows().filter((r) => r.classList.contains('cf-ai-message--user'));
	A.assistantRows = () => A.rows().filter((r) => r.classList.contains('cf-ai-message--assistant'));
	A.lastAssistant = () => A.assistantRows().slice(-1)[0] || null;
	A.header = () => document.querySelector('#cf-ai-panel cds-aichat-chat-header');
	A.actions = () => (A.header() ? deepAll(A.header(), 'cds-icon-button').map((b) => norm(b.textContent)) : []);
	A.action = (text) => (A.header() ? deepAll(A.header(), 'cds-icon-button').find((b) => norm(b.textContent) === text) || null : null);
	A.card = () => document.querySelector('#cf-ai-panel .cf-ai-approval:not(.cf-ai-approval--locked)');
	A.cardButton = (name) => { const c = A.card(); return c ? c.querySelector('[data-action="' + name + '"]') : null; };
	A.shell = () => document.querySelector('#cf-ai-panel cds-aichat-shell');
	A.isOpen = () => document.body.classList.contains('cf-ai-open');
	// flow's own panel, which frappe-types does not know: null when its bundle never loaded.
	A.flowVisible = () => (window.frappe && frappe.flow && frappe.flow.panel ? frappe.flow.panel.visible : null);
	A.flowHide = () => { if (window.frappe && frappe.flow && frappe.flow.panel && frappe.flow.panel.visible) frappe.flow.panel.hide(); return true; };
	A.idle = () => {
		const s = A.send(); const h = host();
		return !!s && !s.isStopStreamingButtonVisible && !h.querySelector('.cf-ai-message--streaming') && !h.querySelector('.cf-ai-processing:not([hidden])');
	};
	A.center = (el, scroll, fx) => {
		if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width * (fx === undefined ? 0.5 : fx), y: r.top + r.height / 2, w: r.width, h: r.height };
	};
	A.visible = (el) => !!el && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
	A.rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
	A.isInert = (el) => { let n = el; while (n) { if (n.nodeType === 1 && n.inert) return true; n = n.parentNode || n.host || null; } return false; };
	A.contains = (root, el) => { let n = el; while (n) { if (n === root) return true; n = n.parentNode || n.host || null; } return false; };
	A.tabStops = (root) => deepAll(root, 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=true],iframe')
		.filter((el) => el.tabIndex >= 0 && !el.disabled && A.visible(el) && !A.isInert(el))
		.map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''));
	A.unnamed = (root) => {
		const bad = [];
		for (const el of deepAll(root, 'button, cds-icon-button, cds-button, cds-aichat-button, cds-aichat-stop-streaming-button, [role=button]')) {
			const r = el.getRootNode();
			if (r instanceof ShadowRoot && /^CDS-/.test(r.host.tagName) && el.tagName === 'BUTTON') continue;
			if (!A.visible(el)) continue;
			const named = ['aria-label', 'label', 'tooltip-text', 'title'].some((a) => (el.getAttribute(a) || '').trim()) || norm(deepText(el));
			if (!named) bad.push(el.tagName.toLowerCase() + (typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
		}
		return bad;
	};
	A.texts = () => A.rows().map((r) => ({
		role: r.classList.contains('cf-ai-message--user') ? 'user' : 'assistant',
		text: norm([...r.querySelectorAll('.cf-ai-message__bubble, .cf-ai-item--text')].map((n) => deepText(n)).join(' ')),
	}));
	A.probe = (name) => {
		const d = document.createElement('div');
		d.style.cssText = 'position:fixed;visibility:hidden;background:var(' + name + ')';
		document.body.appendChild(d);
		const c = getComputedStyle(d).backgroundColor;
		d.remove();
		return c;
	};

	// -- history overlay ------------------------------------------------------------------------
	A.hist = () => document.querySelector('#cf-ai-panel .cf-ai-history');
	A.histShown = () => { const h = A.hist(); return !!h && !h.hidden && A.visible(h); };
	A.histAction = () => A.action('Conversation history');
	A.items = () => { const h = A.hist(); return h ? [...h.querySelectorAll('cds-aichat-history-panel-item')] : []; };
	A.itemOf = (session) => A.items().find((i) => i.getAttribute('data-session') === session) || null;
	A.names = () => A.items().map((i) => i.name);
	A.sessions = () => A.items().map((i) => i.getAttribute('data-session'));
	A.menus = () => { const h = A.hist(); return h ? [...h.querySelectorAll('cds-aichat-history-panel-menu')].map((m) => m.title || m.getAttribute('title') || '') : []; };
	A.itemButton = (i) => (i && i.shadowRoot ? i.shadowRoot.querySelector('button') : null);
	A.itemMenu = (i) => (i && i.shadowRoot ? i.shadowRoot.querySelector('cds-overflow-menu') : null);
	A.itemTrigger = (i) => { const m = A.itemMenu(i); return m ? deepAll(m, 'button')[0] || null : null; };
	A.menuOpen = (i) => { const m = A.itemMenu(i); return !!m && m.open === true; };
	// The open menu's body is moved out of the row, next to the list, so it is found from the overlay.
	A.menuEntries = () => { const h = A.hist(); return h ? deepAll(h, 'cds-overflow-menu-item').filter((e) => A.visible(e) && e.getBoundingClientRect().height > 0) : []; };
	A.menuEntry = (text) => A.menuEntries().find((e) => norm(e.textContent || '').startsWith(text)) || null;
	A.renameField = (i) => (i && i.shadowRoot ? i.shadowRoot.querySelector('cds-aichat-history-panel-item-input') : null);
	A.renameInput = (i) => { const w = A.renameField(i); return w && w.shadowRoot ? w.shadowRoot.querySelector('input') : null; };
	A.renameSave = (i) => { const w = A.renameField(i); return w && w.shadowRoot ? w.shadowRoot.querySelector('.rename-action--save') : null; };
	A.toolbar = () => { const h = A.hist(); return h ? h.querySelector('cds-aichat-history-toolbar') : null; };
	A.searchInput = () => { const t = A.toolbar(); return t ? deepAll(t, 'input')[0] || null : null; };
	A.searchClear = () => { const t = A.toolbar(); return t ? deepAll(t, 'button').find((b) => /search-close/.test(b.className)) || null : null; };
	A.newChatButton = () => { const t = A.toolbar(); return t ? deepAll(t, 'cds-icon-button').find((b) => norm(b.textContent || '') === 'New chat') || null : null; };
	A.backButton = () => { const h = A.hist(); const hd = h ? h.querySelector('cds-aichat-history-header') : null; return hd ? deepAll(hd, 'cds-icon-button')[0] || null : null; };
	A.delPanel = () => { const h = A.hist(); return h ? h.querySelector('cds-aichat-history-delete-panel') : null; };
	A.delButton = (kind) => { const d = A.delPanel(); return d && d.shadowRoot ? d.shadowRoot.querySelector('cds-aichat-button[kind="' + kind + '"]') : null; };
	A.content = () => { const h = A.hist(); return h ? h.querySelector('cds-aichat-history-content') : null; };
	A.empty = () => { const h = A.hist(); return h ? h.querySelector('.cf-ai-history__empty') : null; };
	A.histError = () => { const h = A.hist(); return h ? h.querySelector('.cf-ai-history__error') : null; };
	A.skeleton = () => { const h = A.hist(); return h ? h.querySelector('cds-aichat-history-loading') : null; };
	// aria-pressed on the host, on its inner button, or the data-pressed hook: whichever the toolbar renders.
	A.pressed = (el) => {
		if (!el) return null;
		const inner = deepAll(el, 'button')[0];
		const seen = [el.getAttribute('aria-pressed'), el.getAttribute('data-pressed'), inner ? inner.getAttribute('aria-pressed') : null];
		return seen.find((v) => v === 'true' || v === 'false') || null;
	};
	A.actionDisabled = (el) => { if (!el) return null; const inner = deepAll(el, 'button')[0]; return el.hasAttribute('disabled') || el.disabled === true || !!(inner && inner.disabled); };
	// Whether the deepest element under the middle of el is el or inside it: nothing clips or covers it.
	A.isHit = (el) => {
		const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
		let top = document.elementFromPoint(x, y);
		while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(x, y); if (!inner || inner === top) break; top = inner; }
		return !!top && A.contains(el, top);
	};
	// feedback footers
	A.footers = () => [...document.querySelectorAll('#cf-ai-panel .cf-ai-message__footer')];
	A.footer = (i) => { const f = A.footers(); return f[i === undefined ? f.length - 1 : i < 0 ? f.length + i : i] || null; };
	A.thumbs = (f) => { const b = f ? f.querySelector('cds-aichat-feedback-buttons') : null; const t = b && b.shadowRoot ? [...b.shadowRoot.querySelectorAll('cds-icon-button')] : []; return { buttons: b, up: t[0] || null, down: t[1] || null }; };
	A.thumbState = (f) => { const b = A.thumbs(f).buttons; const d = f ? f.querySelector('cds-aichat-feedback') : null; return b ? { up: b.isPositiveSelected, down: b.isNegativeSelected, upOff: b.isPositiveDisabled, downOff: b.isNegativeDisabled, open: !!(d && d.isOpen) } : null; };
	A.firstRowKey = () => { const r = A.rows()[0]; return r ? r.getAttribute('data-message-id') : null; };
	A.rowByKey = (k) => document.querySelector('#cf-ai-panel .cf-ai-message[data-message-id="' + k + '"]');
	A.alerts = () => [...document.querySelectorAll('#alert-container .desk-alert')].map((a) => norm(a.textContent || ''));
	A.clearAlerts = () => { for (const a of document.querySelectorAll('#alert-container .desk-alert')) a.remove(); return true; };
	// The naive server datetime read in the zone the server stores in, and the display forms of an instant.
	A.naiveToEpoch = (naive, tz) => {
		const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(naive);
		if (!m) return NaN;
		const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], Math.floor(Number('0.' + (m[7] || '0')) * 1000));
		const offset = (at) => {
			const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map((p) => [p.type, p.value]));
			return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000;
		};
		const first = wall - offset(wall);
		return wall - offset(first);
	};
	A.zones = () => {
		const z = (window.frappe && frappe.boot && frappe.boot.time_zone) || {};
		const sd = (window.frappe && frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.time_zone) || undefined;
		const system = z.system || sd;
		return { system, user: z.user || system, locale: Intl.getCanonicalLocales(frappe.boot.lang || 'en')[0] || 'en' };
	};
	A.dayKey = (at, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).format(at);
	A.shortTime = (at, now) => {
		const z = A.zones();
		const same = A.dayKey(at, z.user) === A.dayKey(now, z.user);
		return new Intl.DateTimeFormat(z.locale, same ? { timeStyle: 'short', timeZone: z.user } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: z.user }).format(at);
	};
	A.fullTime = (at) => { const z = A.zones(); return new Intl.DateTimeFormat(z.locale, { dateStyle: 'full', timeStyle: 'short', timeZone: z.user }).format(at); };
	A.times = () => A.rows().map((r) => {
		const t = r.querySelector('time.cf-ai-message__time');
		const role = r.classList.contains('cf-ai-message--user') ? 'user' : 'assistant';
		return t ? { role, datetime: t.getAttribute('datetime'), text: norm(t.textContent || ''), title: t.getAttribute('title'), label: t.getAttribute('aria-label') } : { role, datetime: null, text: '', title: null, label: null };
	});


	// The recorder: a 20 ms sampler for things that exist for less than a poll, such as the processing dots,
	// a step in its processing state, a live-region message or the position of the scroller mid-stream.
	A.seen = null;
	const pushOnce = (list, v) => { if (!list.includes(v)) list.push(v); };
	A.watch = (on, rows) => {
		if (A.timer) { clearInterval(A.timer); A.timer = null; }
		if (A.observer) { A.observer.disconnect(); A.observer = null; }
		const last = A.seen;
		A.seen = null;
		if (!on) return last;
		const t0 = performance.now();
		const s = (A.seen = { processing: false, stop: false, closedLabels: [], processingLabels: [], steps: [], announced: [], scrollBtn: false, approval: false, scroll: [], rowTexts: [], loops: [] });
		// Live regions keep their last text until the next message, so sampling would report a stale one;
		// only a region that changed since the recorder started counts.
		const observe = () => {
			const box = host() && host().querySelector('.cf-ai-announcer');
			if (!box || A.observer) return;
			A.observer = new MutationObserver((records) => {
				for (const rec of records) {
					const node = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
					const region = node && node.closest('[aria-live]');
					const t = region ? norm(region.textContent || '') : '';
					if (t) pushOnce(s.announced, region.getAttribute('aria-live') + ': ' + t);
				}
			});
			A.observer.observe(box, { childList: true, characterData: true, subtree: true });
		};
		observe();
		A.timer = setInterval(() => {
			const h = host(); if (!h) return;
			observe();
			const send = A.send();
			const dots = h.querySelector('.cf-ai-processing:not([hidden]) cds-aichat-processing');
				if (dots) { s.processing = true; s.loops.push(dots.loop === true); }
				else if (h.querySelector('.cf-ai-processing:not([hidden])')) s.processing = true;
				if (rows) for (const row of h.querySelectorAll('.cf-ai-message--user')) pushOnce(s.rowTexts, deepText(row).replace(/\s+/g, ' ').trim());
			if (send && send.isStopStreamingButtonVisible) s.stop = true;
			for (const row of h.querySelectorAll('.cf-ai-message--assistant')) {
				const steps = deepAll(row, 'cds-aichat-chain-of-thought-step');
				const busy = steps.some((st) => st.status === 'processing');
				for (const t of deepAll(row, 'cds-aichat-chain-of-thought-toggle')) {
					pushOnce(s.closedLabels, t.closedLabelText);
					if (busy) pushOnce(s.processingLabels, t.closedLabelText);
				}
				for (const st of steps) {
					const call = deepAll(st, 'cds-aichat-tool-call-data')[0];
					pushOnce(s.steps, (call ? call.toolName : '?') + ':' + st.status);
				}
			}
			const sc = A.scroller();
			if (sc) {
				s.scroll.push([Math.round(performance.now() - t0), sc.scrollTop, !!(send && send.isStopStreamingButtonVisible)]);
				const b = h.querySelector('.cf-ai-scroll-bottom');
				if (b && !b.hidden && b.getClientRects().length) s.scrollBtn = true;
			}
			if (h.querySelector('.cf-ai-approval')) s.approval = true;
		}, 20);
		return null;
	};

	// -- attachments ------------------------------------------------------------------------------
	// The default mtime is fixed, so two Files built from one spec collide in the duplicate check as one picked twice would.
	A.makeFile = (s) => {
		let body;
		if (s.base64) {
			const bin = atob(s.base64); const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			body = bytes;
		} else if (typeof s.bytes === 'number') {
			body = new Uint8Array(s.bytes).fill(120);
		} else {
			body = (s.text || '').repeat(s.repeat || 1);
		}
		return new File([body], s.name, { type: s.type || '', lastModified: s.modified || 1700000000000 });
	};
	A.transfer = (specs, extra) => {
		const dt = new DataTransfer();
		for (const s of specs || []) dt.items.add(A.makeFile(s));
		if (extra && extra.text) dt.setData('text/plain', extra.text);
		if (extra && extra.html) dt.setData('text/html', extra.html);
		return dt;
	};
	A.fileInput = () => document.querySelector('#cf-ai-panel .cf-ai-file-input');
	A.attach = () => document.querySelector('#cf-ai-panel .cf-ai-attach');
	A.uploads = () => document.querySelector('#cf-ai-panel cds-aichat-file-uploads.cf-ai-uploads');
	A.promptShell = () => document.querySelector('#cf-ai-panel cds-aichat-prompt-line-shell');
	A.pick = (specs) => {
		const input = A.fileInput();
		if (!input) return -1;
		const dt = A.transfer(specs);
		// The input's list is the transfer's own, and the handler empties it with input.value = '': count first.
		const count = dt.files.length;
		input.files = dt.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		return count;
	};
	A.dragTarget = () => document.querySelector('#cf-ai-panel cds-aichat-shell.cf-ai-shell') || A.shell();
	A.drag = (type, specs, extra) => {
		const dt = A.transfer(specs, extra);
		// A constructed DataTransfer ignores writes to dropEffect (it is not part of a real drag), so keep what the handler wrote.
		let effect = 'unset';
		Object.defineProperty(dt, 'dropEffect', { get: () => effect, set: (v) => { effect = v; } });
		const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true });
		A.dragTarget().dispatchEvent(ev);
		return { prevented: ev.defaultPrevented, dropEffect: effect };
	};
	A.paste = (specs, extra, target) => {
		const el = target ? document.querySelector(target) : A.textarea();
		const ev = new ClipboardEvent('paste', { clipboardData: A.transfer(specs, extra), bubbles: true, cancelable: true, composed: true });
		el.dispatchEvent(ev);
		return ev.defaultPrevented;
	};
	A.dropState = () => {
		const d = host() ? host().querySelector('.cf-ai-drop') : null; const sh = A.dragTarget();
		return { exists: !!d, shown: !!d && !d.hidden && A.visible(d), ariaHidden: d ? d.getAttribute('aria-hidden') : null, dragging: !!sh && sh.classList.contains('cf-ai-shell--dragging') };
	};
	// One chip of cds-aichat-file-uploads: the Carbon item inside two shadow roots.
	const chipItem = (i) => {
		const list = A.uploads();
		const items = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('cds-aichat-file-upload-item')] : [];
		const item = items[i];
		return item && item.shadowRoot ? item.shadowRoot.querySelector('cds-file-uploader-item') : null;
	};
	A.chipClose = (i) => { const f = chipItem(i); return f && f.shadowRoot ? f.shadowRoot.querySelector('button.cds--file-close') : null; };
	A.chips = () => {
		const list = A.uploads();
		const items = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('cds-aichat-file-upload-item')] : [];
		return items.map((_item, i) => {
			const f = chipItem(i);
			if (!f) return { name: '', state: null, invalid: false, error: '', close: false };
			const err = f.shadowRoot ? f.shadowRoot.querySelector('.cds--form-requirement__title') : null;
			return { name: norm(f.textContent || ''), state: f.getAttribute('state'), invalid: f.hasAttribute('invalid') || f.invalid === true, error: err ? norm(err.textContent || '') : '', close: !!A.chipClose(i) };
		});
	};
	A.sentChips = (row) => [...(row ? row.querySelectorAll('.cf-ai-message__file') : [])].map((li) => {
		const item = li.querySelector('cds-aichat-file-upload-item');
		const f = item && item.shadowRoot ? item.shadowRoot.querySelector('cds-file-uploader-item') : null;
		return { id: li.getAttribute('data-file-id'), name: f ? norm(f.textContent || '') : '', state: f ? f.getAttribute('state') : null, close: !!(f && f.shadowRoot && f.shadowRoot.querySelector('button.cds--file-close')) };
	});
	A.strip = () => {
		const s = host() ? host().querySelector('.cf-ai-upload-status') : null; const bar = s ? s.querySelector('.cf-ai-upload-status__bar') : null;
		const cancel = s ? s.querySelector('[data-action="cancel-uploads"]') : null;
		return { exists: !!s, shown: !!s && !s.hidden && A.visible(s), bar: !!bar, role: bar ? bar.getAttribute('role') : null, label: bar ? bar.getAttribute('aria-label') : null,
			now: bar ? bar.getAttribute('aria-valuenow') : null, indeterminate: !!bar && bar.classList.contains('cf-ai-upload-status__bar--indeterminate'), cancel: !!cancel };
	};
	A.refusal = () => {
		const box = host() ? host().querySelector('.cf-ai-attach-error') : null; const msg = box ? box.querySelector('cds-aichat-error-message') : null; const sh = A.promptShell();
		return { exists: !!box, shown: !!box && !box.hidden && A.visible(box), title: msg ? msg.title || '' : '', description: msg ? msg.description || '' : '',
			hasError: !!sh && (sh.hasError === true || sh.hasAttribute('has-error')), alert: !!box && (box.getAttribute('role') === 'alert' || !!box.querySelector('[role="alert"]')) };
	};
	A.attachState = () => {
		const b = A.attach(); const inner = b ? deepAll(b, 'button')[0] : null;
		return { exists: !!b, disabled: !!b && A.actionDisabled(b), name: b ? norm((inner && inner.getAttribute('aria-label')) || b.textContent || '') : '', focused: !!b && A.contains(b, deepActive()) };
	};
	// How many times the announcer's regions hold the text right now: a repeated message goes to the next region, so two means said twice.
	A.liveCount = (text) => [...(host() ? host().querySelectorAll('.cf-ai-announcer [aria-live]') : [])].reduce((n, r) => n + norm(r.textContent || '').split(text).length - 1, 0);
	// The panel announcer's regions and the file list's own (inside its shadow root): everything said since the watch started.
	A.live = null;
	A.liveWatch = (on) => {
		if (A.liveTimer) { clearInterval(A.liveTimer); A.liveTimer = null; }
		for (const o of A.liveObs || []) o.disconnect();
		A.liveObs = [];
		const last = A.live;
		A.live = null;
		if (!on) return last;
		const seen = (A.live = []);
		const known = new WeakSet();
		let baseline = true;
		const record = (region) => { const t = norm(region.textContent || ''); const v = region.getAttribute('aria-live') + ': ' + t; if (t && !seen.includes(v)) seen.push(v); };
		const scan = () => {
			const h = host(); if (!h) return;
			const regions = [...h.querySelectorAll('.cf-ai-announcer [aria-live]')];
			const list = h.querySelector('.cf-ai-uploads');
			if (list) regions.push(...deepAll(list, '[aria-live]'));
			for (const region of regions) {
				if (known.has(region)) continue;
				known.add(region);
				// A region that exists when the watch starts still holds its last message; only a later write counts.
				if (!baseline) record(region);
				const o = new MutationObserver(() => record(region));
				o.observe(region, { childList: true, characterData: true, subtree: true });
				A.liveObs.push(o);
			}
			baseline = false;
		};
		scan();
		A.liveTimer = setInterval(scan, 20);
		return null;
	};
})();`;

// -- REST through the page ------------------------------------------------------------

interface ApiReply {
	status: number;
	json: unknown;
}

async function api(page: Page, method: string, path: string, body?: unknown): Promise<ApiReply> {
	const payload = body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body));
	return page.eval<ApiReply>(`(async () => {
		const token = (window.frappe && frappe.csrf_token) || window.csrf_token || '';
		const r = await fetch(${JSON.stringify(path)}, {
			method: ${JSON.stringify(method)},
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': token },
			body: ${payload},
		});
		let json = null;
		try { json = await r.json(); } catch (e) { json = null; }
		return { status: r.status, json };
	})()`);
}

const resource = (doctype: string, name?: string): string =>
	`/api/resource/${encodeURIComponent(doctype)}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

async function list(
	page: Page,
	doctype: string,
	filters: unknown[],
	fields: string[] = ["name"],
	orderBy = "",
): Promise<Array<Record<string, unknown>>> {
	const query =
		`filters=${encodeURIComponent(JSON.stringify(filters))}` +
		`&fields=${encodeURIComponent(JSON.stringify(fields))}&limit_page_length=0${orderBy ? `&order_by=${encodeURIComponent(orderBy)}` : ""}`;
	const reply = await api(page, "GET", `${resource(doctype)}?${query}`);
	if (reply.status !== 200) throw new Error(`listing ${doctype} failed: ${reply.status} ${show(reply.json)}`);
	const data = dig(reply.json, "data");
	return Array.isArray(data) ? data.filter(isRecord) : [];
}

const todosNamed = (page: Page, description: string): Promise<Array<Record<string, unknown>>> =>
	list(page, "ToDo", [["description", "=", description]], ["name", "description"]);

// -- fixtures --------------------------------------------------------------------------

/**
 * Remove everything the suite creates, leaving a site that is as it was.
 *
 * The model is disabled FIRST: `sync_builtin_assistant` runs from `FlowModel.after_insert` and from the
 * `after_migrate` hook, adopts the first enabled model for a missing default agent, and that agent is
 * system-generated and cannot be deleted. A model left enabled by a crash would be adopted by the next
 * `bench migrate`; disabled, it never is. The model is inserted disabled for the same reason.
 *
 * Only names carrying the test prefix are touched; a doc that does not exist is not an error.
 */
async function cleanup(page: Page): Promise<string[]> {
	const problems: string[] = [];
	const del = async (doctype: string, name: string): Promise<void> => {
		const reply = await api(page, "DELETE", resource(doctype, name));
		if (reply.status >= 300 && reply.status !== 404) {
			problems.push(
				`${doctype} ${name}: ${reply.status} ${show(dig(reply.json, "exception") ?? reply.json)}`,
			);
		}
	};
	const model = await api(page, "GET", resource("Flow Model", MODEL));
	if (model.status === 200) {
		const off = await api(page, "PUT", resource("Flow Model", MODEL), { enabled: 0 });
		if (off.status >= 300) problems.push(`Flow Model ${MODEL} could not be disabled: ${off.status}`);
	}
	const sessions = [
		...(await list(page, "Flow Session", [["agent", "=", AGENT]])),
		...(await list(page, "Flow Session", [["model", "=", MODEL]])),
	];
	for (const name of new Set(sessions.map((s) => str(s["name"])))) {
		if (name !== undefined) await del("Flow Session", name);
	}
	// After the sessions: a File linked from an attachment row cannot be deleted while the row exists, and
	// deleting a session deletes the Files it was sent with only when it can.
	for (const file of await list(page, "File", [["file_name", "like", "CF AI Test%"]])) {
		const name = str(file["name"]);
		if (name !== undefined) await del("File", name);
	}
	await del("Flow Agent", AGENT);
	await del("Flow Tool", TOOL_READ);
	await del("Flow Tool", TOOL_CREATE);
	await del("Flow Model", MODEL);
	for (const todo of await list(page, "ToDo", [["description", "like", "CF AI Test%"]])) {
		const name = str(todo["name"]);
		if (name !== undefined) await del("ToDo", name);
	}
	return problems;
}

async function createFixtures(page: Page, mock: MockLlm): Promise<void> {
	const insert = async (doctype: string, body: Record<string, unknown>): Promise<void> => {
		const reply = await api(page, "POST", resource(doctype), body);
		if (reply.status >= 300) {
			throw new Error(
				`creating ${doctype} failed: ${reply.status} ${show(dig(reply.json, "exception") ?? reply.json)}`,
			);
		}
	};
	await insert("Flow Model", {
		title: MODEL,
		model_id: "openai/cf-ai-test",
		base_url: mock.url,
		api_key: "cf-ai-test",
		enabled: 0,
	});
	const on = await api(page, "PUT", resource("Flow Model", MODEL), { enabled: 1 });
	if (on.status >= 300) throw new Error(`enabling ${MODEL} failed: ${on.status} ${show(on.json)}`);
	// Not the builtin read/create slugs: those rows may not exist on a site, and are system-generated when they do.
	await insert("Flow Tool", {
		title: "CF AI Test Read",
		slug: TOOL_READ,
		type: "Imported",
		import_path: "flow.tools.builtins.read",
		description: "CF AI Test: read records",
		requires_confirmation: 0,
		enabled: 1,
	});
	await insert("Flow Tool", {
		title: "CF AI Test Create",
		slug: TOOL_CREATE,
		type: "Imported",
		import_path: "flow.tools.builtins.create",
		description: "CF AI Test: create records",
		requires_confirmation: 1,
		enabled: 1,
	});
	await insert("Flow Agent", {
		title: AGENT,
		model: MODEL,
		instructions: "CF AI Test",
		max_iterations: 10,
		enabled: 1,
		tools: [{ tool: TOOL_READ }, { tool: TOOL_CREATE }],
	});
}

// -- page driving ------------------------------------------------------------------------

const A = "window.__ai";

async function flag(page: Page, expr: string): Promise<boolean> {
	return Boolean(await page.eval<unknown>(expr));
}

/** Load the desk fresh and wait for the header to carry the trigger. */
async function freshPage(page: Page, path = "/desk/todo", keepState = false): Promise<void> {
	// A panel left open by the previous case would reopen itself on load and turn the next click into a close.
	if (!keepState) await page.eval(`(localStorage.removeItem('cf-ai-panel'), true)`).catch(() => {});
	const ready = `!!document.querySelector('#cf-ai-trigger') && !!(frappe.app && frappe.app.sidebar)`;
	await page.goto(`${BASE}${path}`);
	// A busy dev server sometimes answers the desk shell and then stalls on boot; one reload is the remedy a
	// person would try, and a second failure is then a real one.
	await page.waitFor(ready, { timeout: 45000 }).catch(async () => {
		await page.goto(`${BASE}${path}`);
		await page.waitFor(ready, { timeout: 90000 });
	});
	await sleep(400);
}

const trigger = `document.getElementById('cf-ai-trigger')`;

/** Whether the page column and frappe's sidebar are inert: what a full-width panel covers. */
const coveredInert = `(() => {
	const covered = [document.getElementById('body'), document.querySelector('.body-sidebar-container')];
	return covered.map((el) => (el ? el.inert : null));
})()`;

/** Show a frappe toast and report whether it overlaps the prompt line. */
async function toastOverlapsPrompt(page: Page): Promise<{ toast: boolean; overlaps: boolean }> {
	await page.eval(`(frappe.show_alert({ message: 'CF AI Test toast', indicator: 'green' }, 20), true)`);
	await page.waitFor(`!!document.querySelector('#alert-container .desk-alert')`, { timeout: 5000 });
	// the toast fades in; a rect read mid-fade is still its final box, but give the layout a frame to settle
	await sleep(500);
	const result = await page.eval<{ toast: boolean; overlaps: boolean }>(`(() => {
		const toast = document.querySelector('#alert-container .desk-alert');
		const prompt = document.querySelector('#cf-ai-panel cds-aichat-prompt-line-shell');
		if (!toast || !prompt) return { toast: false, overlaps: false };
		const a = toast.getBoundingClientRect(); const b = prompt.getBoundingClientRect();
		const apart = a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
		toast.remove();
		return { toast: true, overlaps: !apart };
	})()`);
	return result;
}

/** Wait for the chat to be mounted and its input focused. */
async function waitMounted(page: Page, timeout = 30000): Promise<void> {
	await page.waitFor(`!!${A}.textarea() && ${A}.deepActive() === ${A}.textarea()`, { timeout });
}

async function openPanel(page: Page): Promise<void> {
	if (!(await flag(page, `${A}.isOpen()`))) await click(page, trigger, false);
	await page.waitFor(`${A}.isOpen()`, { timeout: 10000 });
	await waitMounted(page);
	await sleep(350);
}

async function closePanelWithTrigger(page: Page): Promise<void> {
	if (await flag(page, `${A}.isOpen()`)) await click(page, trigger, false);
	await page.waitFor(`!${A}.isOpen()`, { timeout: 5000 });
	await sleep(350);
}

async function focusInput(page: Page): Promise<void> {
	await page.eval(`${A}.textarea().focus()`);
	await sleep(60);
}

async function waitIdle(page: Page, timeout = 60000): Promise<void> {
	await page.waitFor(`${A}.idle()`, { timeout, interval: 100 });
	// <cds-aichat-markdown> renders on a 100 ms throttle, so the last words and blocks of a finished stream
	// land just after the store says ready; a read straight away sees a reply that is not quite there yet.
	await sleep(350);
	await page.waitFor(`${A}.idle()`, { timeout, interval: 100 });
}

/** Type into the main prompt line and press Enter. Does not wait for anything. */
async function typeAndEnter(page: Page, text: string): Promise<void> {
	await focusInput(page);
	await insertText(page, text);
	await press(page, "Enter");
}

/** Send a message as a new turn; optionally wait for the response to settle. */
async function say(page: Page, text: string, settle = true): Promise<void> {
	const before = await page.eval<number>(`${A}.userRows().length`);
	await typeAndEnter(page, text);
	await page.waitFor(`${A}.userRows().length > ${before}`, { timeout: 10000 });
	if (!settle) return;
	await sleep(250);
	await waitIdle(page);
}

const lastAssistantText = (page: Page): Promise<string> =>
	page.eval<string>(
		`(() => { const r = ${A}.lastAssistant(); return r ? ${A}.deepText(r.querySelector('.cf-ai-message__body') || r) : ''; })()`,
	);

interface Seen {
	processing: boolean;
	stop: boolean;
	closedLabels: string[];
	processingLabels: string[];
	steps: string[];
	announced: string[];
	scrollBtn: boolean;
	approval: boolean;
	scroll: Array<[t: number, top: number, streaming: boolean]>;
	/** Distinct texts of the user rows on screen; only collected when the recorder was started with `rows`. */
	rowTexts: string[];
	/** `loop` of the processing dots at each sample where they were visible. */
	loops: boolean[];
}

const startWatch = (page: Page, rows = false): Promise<unknown> => page.eval(`${A}.watch(true, ${rows})`);
const stopWatch = async (page: Page): Promise<Seen> => {
	const seen = await page.eval<Seen | null>(`${A}.watch(false)`);
	if (seen === null) throw new Error("the page-side recorder was not running");
	return seen;
};

/** The JSON body of a POST flow's client made, or null when it was not JSON. */
function bodyOf(entry: NetEntry | undefined): Record<string, unknown> | null {
	if (entry === undefined || entry.postData === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(entry.postData);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function sessionName(page: Page): Promise<string> {
	return page.eval<string>(`localStorage.getItem('cf-ai-session') || ''`);
}

const sessionCount = async (page: Page): Promise<number> =>
	(await list(page, "Flow Session", [["agent", "=", AGENT]])).length;

// -- history, feedback and the other conversation cases: shared helpers --

/** Console errors a case causes on purpose (a blocked or failed request) are not strays. */
async function tolerate<T>(body: () => Promise<T>): Promise<T> {
	const from = Date.now();
	try {
		return await body();
	} finally {
		tolerated.push([from, Date.now() + 2000]);
	}
}

type Verdict =
	| { kind: "pass"; delayMs?: number }
	| { kind: "fail" }
	| { kind: "fulfill"; body: unknown }
	| { kind: "reply"; status: number; body: unknown };

interface PausedRequest {
	url: string;
	body: Record<string, unknown> | null;
}

/**
 * Decide the fate of every request matching `patterns` from its URL and JSON body: let it through (after
 * `delayMs`), fail it as a network error, answer it with `{message: body}`, or answer it with `status` and `body`
 * as they are (a frappe error reply). Returns the release.
 */
async function intercept(
	page: Page,
	patterns: string[],
	decide: (request: PausedRequest) => Verdict,
): Promise<() => Promise<void>> {
	const listener = (event: CdpEvent): void => {
		if (event.method !== "Fetch.requestPaused") return;
		const requestId = str(dig(event.params, "requestId"));
		if (requestId === undefined) return;
		const postData = str(dig(event.params, "request", "postData"));
		let body: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = postData === undefined ? null : JSON.parse(postData);
			body = isRecord(parsed) ? parsed : null;
		} catch {
			body = null;
		}
		const verdict = decide({ url: str(dig(event.params, "request", "url")) ?? "", body });
		const settle = (): void => {
			let call: Promise<unknown>;
			if (verdict.kind === "fail") {
				call = page.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
			} else if (verdict.kind === "fulfill") {
				call = page.send("Fetch.fulfillRequest", {
					requestId,
					responseCode: 200,
					responseHeaders: [{ name: "Content-Type", value: "application/json" }],
					body: Buffer.from(JSON.stringify({ message: verdict.body })).toString("base64"),
				});
			} else if (verdict.kind === "reply") {
				call = page.send("Fetch.fulfillRequest", {
					requestId,
					responseCode: verdict.status,
					responseHeaders: [{ name: "Content-Type", value: "application/json" }],
					body: Buffer.from(JSON.stringify(verdict.body)).toString("base64"),
				});
			} else {
				call = page.send("Fetch.continueRequest", { requestId });
			}
			call.catch(() => {});
		};
		if (verdict.kind === "pass" && verdict.delayMs !== undefined) setTimeout(settle, verdict.delayMs);
		else settle();
	};
	listeners.push(listener);
	await page.send("Fetch.enable", {
		patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
	});
	return async () => {
		listeners.splice(listeners.indexOf(listener), 1);
		await page.send("Fetch.disable");
	};
}

/** Whether a request is a `frappe.client.get_list` of that doctype. */
const isListOf =
	(doctype: string) =>
	(request: PausedRequest): boolean =>
		/frappe\.client\.get_list/.test(request.url) && request.body?.["doctype"] === doctype;

/** The JSON bodies of the requests since `mark` that went to `method` (a regex source for the method path). */
function posts(mark: number, method: string): Array<Record<string, unknown> | null> {
	return netSince(mark, new RegExp(`/api/method/${method}(\\?|$)`)).map((n) => bodyOf(n));
}

/** The Flow Session list requests (frappe.client.get_list on that doctype) since `mark`. */
const sessionListCalls = (mark: number): Array<Record<string, unknown> | null> =>
	posts(mark, "frappe\\.client\\.get_list").filter((b) => b?.["doctype"] === "Flow Session");

const TITLES = {
	alpha: "CF AI Test history alpha",
	beta: "CF AI Test history beta",
	gamma: "CF AI Test history gamma",
	approval: "TOOL CREATE 7101",
	long: "CF AI Test long session",
	trigger: "CF AI Test trigger session",
} as const;
type FixtureKey = keyof typeof TITLES;

/** Flow Session names of the fixtures, filled by the AI-28 preamble. */
const fixtures: Partial<Record<FixtureKey, string>> = {};
/** `__ai.texts()` of each UI-made fixture right after it was made: what a restore has to reproduce. */
const snapshots: Partial<Record<FixtureKey, unknown>> = {};

function fixture(key: FixtureKey): string {
	const name = fixtures[key];
	if (name === undefined) {
		throw new Error(`fixture session "${TITLES[key]}" does not exist: the AI-28 preamble failed`);
	}
	return name;
}

const q = (value: string): string => JSON.stringify(value);

async function sessionNamed(page: Page, title: string): Promise<string> {
	const found = await list(page, "Flow Session", [
		["title", "=", title],
		["agent", "=", AGENT],
	]);
	const names = found.map((s) => str(s["name"])).filter((n): n is string => n !== undefined);
	const only = names[0];
	if (names.length !== 1 || only === undefined) {
		throw new Error(`expected exactly one Flow Session titled "${title}", found ${names.length}`);
	}
	return only;
}

async function runsOf(page: Page, session: string): Promise<Array<Record<string, unknown>>> {
	return list(
		page,
		"Flow Run",
		[["session", "=", session]],
		["name", "status", "creation", "feedback_rating", "feedback_comment"],
		"creation asc",
	);
}

async function sessionExists(page: Page, name: string): Promise<boolean> {
	return (await list(page, "Flow Session", [["name", "=", name]])).length > 0;
}

/** Start a new conversation from the header and send `text` in it; resolves with the new session. */
async function chatInNewConversation(page: Page, text: string, settle = true): Promise<string> {
	await click(page, `${A}.action('New chat')`);
	await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
	await say(page, text, settle);
	await page.waitFor(`!!localStorage.getItem('cf-ai-session')`, { timeout: 10000 });
	return sessionName(page);
}

// -- the history overlay

const historyShown = (page: Page): Promise<boolean> => flag(page, `${A}.histShown()`);

/** Wait until the overlay shows a settled state: a list, the empty state or the error block. */
async function historySettled(page: Page, timeout = 15000): Promise<void> {
	await page.waitFor(
		`(() => { const h = ${A}.hist(); return !!h && !${A}.skeleton() && (${A}.items().length > 0 || !!${A}.empty() || !!${A}.histError()); })()`,
		{ timeout },
	);
}

/** Open the overlay through the header action and wait for the list. */
async function openHistory(page: Page): Promise<void> {
	if (!(await historyShown(page))) {
		await click(page, `${A}.histAction()`);
		await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
	}
	await historySettled(page);
	await sleep(250);
}

/** Wait for a session's row; the list refreshes behind a stale one when the overlay opens. */
async function waitItem(page: Page, session: string, timeout = 15000): Promise<void> {
	await page.waitFor(`!!${A}.itemOf(${q(session)})`, { timeout });
}

async function closeHistory(page: Page): Promise<void> {
	if (await historyShown(page)) {
		await click(page, `${A}.histAction()`);
		await page.waitFor(`!${A}.histShown()`, { timeout: 5000 });
		await sleep(250);
	}
}

/** Click a row (left of its overflow button) and wait for the overlay to close on the new conversation. */
async function chooseSession(page: Page, session: string): Promise<void> {
	await openHistory(page);
	await waitItem(page, session);
	await click(page, `${A}.itemButton(${A}.itemOf(${q(session)}))`, true, 0.3);
	await page.waitFor(`!${A}.histShown() && localStorage.getItem('cf-ai-session') === ${q(session)}`, {
		timeout: 20000,
	});
	// markdown renders on a 100 ms throttle
	await sleep(450);
}

/** Open a row's overflow menu with the pointer and wait for it to be open. */
async function openRowMenu(page: Page, session: string): Promise<void> {
	const rowTrigger = `${A}.itemTrigger(${A}.itemOf(${q(session)}))`;
	const isOpen = `${A}.menuOpen(${A}.itemOf(${q(session)}))`;
	await click(page, rowTrigger);
	// a menu that was still open elsewhere takes the first click to close; the second one opens this
	const opened = await page.waitFor(isOpen, { timeout: 1500 }).then(
		() => true,
		() => false,
	);
	if (!opened) {
		await click(page, rowTrigger);
		await page.waitFor(isOpen, { timeout: 5000 });
	}
	await sleep(200);
}

/** Pick an entry of an open row menu with the pointer. */
async function pickMenuEntry(page: Page, text: string): Promise<void> {
	await click(page, `${A}.menuEntry(${q(text)})`);
	await sleep(250);
}

const alertTexts = (page: Page): Promise<string[]> => page.eval<string[]>(`${A}.alerts()`);

/** An expression: whether focus is inside the element `target` evaluates to, across shadow roots. */
const focusIn = (target: string): string => `${A}.contains(${target}, ${A}.deepActive())`;

/** The rows of the open conversation as `{role, text}`; stable across a restore. */
const rowTexts = (page: Page): Promise<unknown> => page.eval<unknown>(`${A}.texts()`);

/** Poll an async read until `done` accepts it or the time is up; resolves with the last value either way. */
async function eventually<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	timeout = 8000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await sleep(150);
		value = await read();
	}
	return value;
}

/** Open a row's menu, choose Delete and wait for the confirmation panel. */
async function startDelete(page: Page, session: string): Promise<void> {
	await openRowMenu(page, session);
	await pickMenuEntry(page, "Delete");
	await page.waitFor(`!!${A}.delPanel()`, { timeout: 5000 });
	await sleep(300);
}

/**
 * A clean slate for a case: a fresh page with the panel open and the prompt ready, whatever the previous
 * case left behind (an open list, a blocked URL, an alert). Conversations are kept; they are the fixtures.
 */
async function startCase(page: Page): Promise<void> {
	await page.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
	await page.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
	await freshPage(page);
	await openForCase(page);
}

/** Open the panel on a loaded page and put focus in the prompt, which is off while a saved conversation loads. */
async function openForCase(page: Page): Promise<void> {
	if (!(await flag(page, `${A}.isOpen()`))) await click(page, trigger, false);
	await page.waitFor(`${A}.isOpen() && !!${A}.textarea() && !${A}.prompt().disabled`, { timeout: 40000 });
	await sleep(500);
	await focusInput(page);
}

// -- attachments: helpers ------------------------------------------------------------------------------

/** A file for the page to build (`makeFile` in the page library) or for the suite to write to disk. */
interface FileSpec {
	name: string;
	text?: string;
	/** `text` repeated this many times: a large body without a large literal. */
	repeat?: number;
	/** A body of that many bytes (letters), when only the size matters. */
	bytes?: number;
	/** The body, base64 encoded, for a real binary file. */
	base64?: string;
	type?: string;
	modified?: number;
}

// Flow injects file text into the user turn the mock model reads, so no body or name may carry one of
// its keywords (ERROR, SLOW, HOLD, LONG, TOOL, FLAKY, UNSAFE) as a word.
const BODY = "CF AI Test attachment body alpha beta";
const NOTES: FileSpec = { name: "CF AI Test notes.txt", text: BODY, type: "text/plain" };
const DATA: FileSpec = { name: "CF AI Test data.csv", text: "id,value\n1,alpha\n2,beta\n", type: "text/csv" };
const MARKDOWN: FileSpec = {
	name: "CF AI Test readme.md",
	text: `# CF AI Test\n\n${BODY}\n`,
	type: "text/markdown",
};
const BLANK: FileSpec = { name: "CF AI Test blank.txt", text: "   \n \n", type: "text/plain" };
const PNG: FileSpec = {
	name: "CF AI Test image.png",
	type: "image/png",
	base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};
/** A name the page must show as text. On upload Frappe drops the handler and keeps the tag; a closing tag it would mangle (it strips the slash), taking the extension with it. */
const MARKUP_NAME = "CF AI Test <img src=x onerror=window.__cfAiPwned=5>.txt";

const UPLOAD_URL = /\/api\/method\/upload_file/;
const ATTACH_URL = /flow\.api\.(api\.)?attach_file/;
const START_RUN_URL = "flow\\.api\\.(api\\.)?start_run";
const RESUME_RUN_URL = "flow\\.api\\.(api\\.)?resume_run";

const specs = (files: readonly FileSpec[]): string => JSON.stringify(files);

/** Build the files in the page and set them on the hidden input, then fire `change`: a picker choice. Resolves with how many were set. */
const pickFiles = (page: Page, files: readonly FileSpec[]): Promise<number> =>
	page.eval<number>(`${A}.pick(${specs(files)})`);

interface DragResult {
	prevented: boolean;
	dropEffect: string;
}

/** One drag event on the shell. `payload` is files, or the text of a drag that carries none. */
const dragEvent = (
	page: Page,
	type: "dragenter" | "dragover" | "dragleave" | "drop" | "dragend",
	payload: readonly FileSpec[] | string,
): Promise<DragResult> =>
	page.eval<DragResult>(
		typeof payload === "string"
			? `${A}.drag(${q(type)}, [], { text: ${q(payload)} })`
			: `${A}.drag(${q(type)}, ${specs(payload)})`,
	);

/** A paste on the prompt line's textarea (or on `target`, a selector). Resolves with `defaultPrevented`. */
const pasteFiles = (
	page: Page,
	files: readonly FileSpec[],
	extra: { text?: string; html?: string } = {},
	target?: string,
): Promise<boolean> =>
	page.eval<boolean>(
		`${A}.paste(${specs(files)}, ${JSON.stringify(extra)}, ${target === undefined ? "null" : q(target)})`,
	);

interface Chip {
	name: string;
	state: string | null;
	invalid: boolean;
	error: string;
	close: boolean;
}

const NO_CHIP: Chip = { name: "", state: null, invalid: false, error: "", close: false };

const chips = (page: Page): Promise<Chip[]> => page.eval<Chip[]>(`${A}.chips()`);
const chipNames = async (page: Page): Promise<string[]> => (await chips(page)).map((c) => c.name);

/** Wait until the list shows `count` chips and every one satisfies `settled`; resolves with the last reading either way. */
async function waitChips(
	page: Page,
	count: number,
	settled: (chip: Chip) => boolean = () => true,
	timeout = 20000,
): Promise<Chip[]> {
	return eventually(
		() => chips(page),
		(all) => all.length === count && all.every(settled),
		timeout,
	);
}

/** A chip a user could remove: uploaded and attached, not errored. */
const isStaged = (chip: Chip): boolean => chip.state === "edit" && !chip.invalid && chip.close;

interface StripState {
	exists: boolean;
	shown: boolean;
	bar: boolean;
	role: string | null;
	label: string | null;
	now: string | null;
	indeterminate: boolean;
	cancel: boolean;
}
const strip = (page: Page): Promise<StripState> => page.eval<StripState>(`${A}.strip()`);

interface Refusal {
	exists: boolean;
	shown: boolean;
	title: string;
	description: string;
	hasError: boolean;
	alert: boolean;
}
const refusal = (page: Page): Promise<Refusal> => page.eval<Refusal>(`${A}.refusal()`);

interface AttachState {
	exists: boolean;
	disabled: boolean;
	name: string;
	focused: boolean;
}
const attachState = (page: Page): Promise<AttachState> => page.eval<AttachState>(`${A}.attachState()`);

const sendBlocked = (page: Page): Promise<boolean> => page.eval<boolean>(`${A}.send().disableSend === true`);

const startLive = (page: Page): Promise<unknown> => page.eval(`${A}.liveWatch(true)`);
const stopLive = async (page: Page): Promise<string[]> => {
	const heard = await page.eval<string[] | null>(`${A}.liveWatch(false)`);
	if (heard === null) throw new Error("the live-region recorder was not running");
	return heard;
};
/** The announcements recorded so far, without stopping the recorder. */
const heardNow = async (page: Page): Promise<string[]> =>
	page.eval<string[]>(`${A}.live ? [...${A}.live] : []`);
const heard = (log: string[], politeness: "polite" | "assertive", text: string): boolean =>
	log.some((entry) => entry.startsWith(`${politeness}:`) && entry.includes(text));

/** Wait for an announcement; the announcer writes on a 250 ms tick. */
async function waitHeard(
	page: Page,
	politeness: "polite" | "assertive",
	text: string,
	timeout = 4000,
): Promise<string[]> {
	return eventually(
		() => heardNow(page),
		(log) => heard(log, politeness, text),
		timeout,
	);
}

/** Press Remove on the chip at `index` with the pointer. */
const removeChip = (page: Page, index: number): Promise<void> => click(page, `${A}.chipClose(${index})`);

interface SentChip {
	id: string | null;
	name: string;
	state: string | null;
	close: boolean;
}
/** The read-only chips of the last user row (or of the row `rowExpr` evaluates to). */
const sentChips = (page: Page, rowExpr = `${A}.userRows().slice(-1)[0]`): Promise<SentChip[]> =>
	page.eval<SentChip[]>(`${A}.sentChips(${rowExpr})`);

// -- File docs, through REST ----------------------------------------------------------------------------

interface FileDoc {
	name: string;
	fileName: string;
	isPrivate: number;
	attachedTo: string;
}

/** Every File doc with the test prefix. */
async function listFiles(page: Page): Promise<FileDoc[]> {
	const rows = await list(
		page,
		"File",
		[["file_name", "like", "CF AI Test%"]],
		["name", "file_name", "is_private", "attached_to_doctype", "file_size"],
		"creation asc",
	);
	return rows.flatMap((row) => {
		const name = str(row["name"]);
		return name === undefined
			? []
			: [
					{
						name,
						fileName: str(row["file_name"]) ?? "",
						isPrivate: Number(row["is_private"] ?? 0),
						attachedTo: str(row["attached_to_doctype"]) ?? "",
					},
				];
	});
}

/** The names of the test Files that exist now: a baseline for `filesSince`. */
const fileNames = async (page: Page): Promise<Set<string>> =>
	new Set((await listFiles(page)).map((f) => f.name));

/** Poll until the File docs created after `before` number `count`; a deleted one drops out of the answer. */
async function filesSince(
	page: Page,
	before: Set<string>,
	count: number,
	timeout = 5000,
): Promise<FileDoc[]> {
	return eventually(
		async () => (await listFiles(page)).filter((f) => !before.has(f.name)),
		(found) => found.length === count,
		timeout,
	);
}

const fileExists = async (page: Page, name: string): Promise<boolean> =>
	(await list(page, "File", [["name", "=", name]])).length > 0;

/** Poll until a File doc is gone. */
async function fileGone(page: Page, name: string, timeout = 5000): Promise<boolean> {
	return !(await eventually(
		() => fileExists(page, name),
		(exists) => !exists,
		timeout,
	));
}

/** The Flow Session Attachment rows of a session, from its doc. */
async function attachmentRows(page: Page, session: string): Promise<Array<Record<string, unknown>>> {
	const reply = await api(page, "GET", resource("Flow Session", session));
	const rows = dig(reply.json, "data", "attachments");
	return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

/** The `attachments` of a start_run body, which flow's client sends as an array. */
function attachmentsOf(body: Record<string, unknown> | null | undefined): string[] | null {
	const raw = body?.["attachments"];
	if (!Array.isArray(raw)) return null;
	return raw.filter((v): v is string => typeof v === "string");
}

// -- file choosers and held requests -------------------------------------------------------------------

let diskDir: string | null = null;

/** Removes the files the picker cases wrote; part of every exit path. */
function removeDiskFiles(): void {
	if (diskDir !== null) fs.rmSync(diskDir, { recursive: true, force: true });
	diskDir = null;
}

/** Write a spec to disk and return its path: what a real picker hands the page. */
function writeToDisk(file: FileSpec): string {
	diskDir ??= fs.mkdtempSync(join(tmpdir(), "cf-ai-files-"));
	const target = join(diskDir, file.name);
	fs.writeFileSync(
		target,
		file.base64 === undefined ? (file.text ?? "") : Buffer.from(file.base64, "base64"),
	);
	return target;
}

/**
 * Run `open` (a click or a key press that should open the file picker), catch the picker with
 * `Page.setInterceptFileChooserDialog` and answer it with real files from disk through
 * `DOM.setFileInputFiles`, the way a person's choice reaches the page. Resolves with the picker's mode.
 */
async function chooseFiles(
	page: Page,
	open: () => Promise<void>,
	files: readonly FileSpec[],
): Promise<string> {
	const paths = files.map(writeToDisk);
	const chooser: { node: number | null; mode: string } = { node: null, mode: "" };
	const listener = (event: CdpEvent): void => {
		if (event.method !== "Page.fileChooserOpened") return;
		const node = dig(event.params, "backendNodeId");
		if (typeof node === "number") chooser.node = node;
		chooser.mode = str(dig(event.params, "mode")) ?? "";
	};
	listeners.push(listener);
	await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
	try {
		await open();
		if (!(await until(() => chooser.node !== null, 5000))) {
			throw new Error("the Attach control did not open a file picker within 5s");
		}
		await page.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.node });
	} finally {
		listeners.splice(listeners.indexOf(listener), 1);
		await page.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
	}
	return chooser.mode;
}

interface Hold {
	/** URLs of the requests paused and not yet answered. */
	paused(): string[];
	/** Let every paused request go on. */
	release(): Promise<void>;
	/** Fail every paused request as a dropped connection. */
	failAll(): Promise<void>;
	/** Stop intercepting. A paused request the page already abandoned needs no answer. */
	stop(): Promise<void>;
}

/**
 * Pause every request matching `pattern` until the case answers it: before it leaves the browser
 * (`Request`) or, for `Response`, after the server has handled it and before the page hears back.
 */
async function holdRequests(
	page: Page,
	pattern: string,
	at: "Request" | "Response" = "Request",
): Promise<Hold> {
	const held = new Map<string, string>();
	const listener = (event: CdpEvent): void => {
		if (event.method !== "Fetch.requestPaused") return;
		const requestId = str(dig(event.params, "requestId"));
		if (requestId !== undefined) held.set(requestId, str(dig(event.params, "request", "url")) ?? "");
	};
	listeners.push(listener);
	await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: at }] });
	const settle = async (method: string, extra: Record<string, unknown>): Promise<void> => {
		const ids = [...held.keys()];
		held.clear();
		await Promise.all(ids.map((requestId) => page.send(method, { requestId, ...extra }).catch(() => {})));
	};
	return {
		paused: () => [...held.values()],
		release: () => settle("Fetch.continueRequest", {}),
		failAll: () => settle("Fetch.failRequest", { errorReason: "Failed" }),
		stop: async () => {
			listeners.splice(listeners.indexOf(listener), 1);
			await page.send("Fetch.disable").catch(() => {});
		},
	};
}

/** URLs of the requests the browser reported as cancelled (the page aborted them) while the watch ran. */
function watchCancellations(): { urls(): string[]; stop(): void } {
	const urlOf = new Map<string, string>();
	const cancelled: string[] = [];
	const listener = (event: CdpEvent): void => {
		const requestId = str(dig(event.params, "requestId"));
		if (requestId === undefined) return;
		if (event.method === "Network.requestWillBeSent") {
			urlOf.set(requestId, str(dig(event.params, "request", "url")) ?? "");
		} else if (event.method === "Network.loadingFailed" && dig(event.params, "canceled") === true) {
			cancelled.push(urlOf.get(requestId) ?? "");
		}
	};
	listeners.push(listener);
	return {
		urls: () => [...cancelled],
		stop: () => {
			listeners.splice(listeners.indexOf(listener), 1);
		},
	};
}

// -- the composer, a fresh conversation ----------------------------------------------------------------

/**
 * A fresh page, the panel open and an empty conversation: what every attachments case starts from.
 * `beforeOpen` runs in the page after the load and before the panel mounts, which is when the upload
 * limits are read from `frappe.boot`.
 */
async function freshChat(page: Page, beforeOpen?: string): Promise<void> {
	await page.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
	await page.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
	await freshPage(page);
	// The agent that owns the mock model; the history cases set it for the rest of a full run, a single case needs it here.
	await page.eval(`(localStorage.setItem('cf-ai-agent', ${q(AGENT)}), true)`);
	if (beforeOpen !== undefined) await page.eval(`(${beforeOpen}, true)`);
	await openForCase(page);
	await click(page, `${A}.action('New chat')`);
	await page.waitFor(`${A}.rows().length === 0 && !${A}.prompt().disabled`, { timeout: 15000 });
	await focusInput(page);
}

/** Stage `files` through the hidden input and wait until every chip can be removed. */
async function stage(page: Page, files: readonly FileSpec[], timeout = 30000): Promise<Chip[]> {
	const set = await pickFiles(page, files);
	if (set !== files.length) throw new Error(`the page set ${set} of ${files.length} files on the picker`);
	const staged = await waitChips(page, files.length, isStaged, timeout);
	if (staged.length !== files.length || !staged.every(isStaged)) {
		throw new Error(`the files were not all attached within ${timeout / 1000}s: ${JSON.stringify(staged)}`);
	}
	return staged;
}

/** The binary size of a number of bytes in the unit flow's limit message uses: 1024 base, one decimal below 10. */
function sizeText(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const text = value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
	return `${text} ${units[unit]}`;
}

/** What AI-51 and AI-55 saw, for AI-67 to compare with the boot data. */
const observed: { accept: string | null; limitText: string | null } = { accept: null, limitText: null };

/** The conversation AI-53 sent a file in, which AI-61 reloads and AI-64 deletes. */
const attached: { session: string; doc: string; name: string; rows: number } = {
	session: "",
	doc: "",
	name: "",
	rows: 0,
};

// -- main ---------------------------------------------------------------------------------

const { proc, port } = await launch();
const page = await newPage(port);
tap(page);
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: LIB });

/** What teardown must undo; set as the suite creates it, read by every exit path. */
const run: { mock: MockLlm | null; fixtures: boolean; startedAt: number } = {
	mock: null,
	fixtures: false,
	startedAt: 0,
};

// A killed suite must not leave the model enabled: the next migrate would adopt it into an undeletable
// system agent. SIGKILL cannot be caught; the cleanup that opens every run, and `--cleanup-only`, cover it.
async function disableModel(): Promise<void> {
	if (!run.fixtures) return;
	await api(page, "PUT", resource("Flow Model", MODEL), { enabled: 0 }).catch(() => {});
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void disableModel().finally(() => {
			proc.kill();
			process.exit(130);
		});
	});
}

try {
	await login(page, BASE);
	run.startedAt = Date.now();
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1600,
		height: 1000,
		deviceScaleFactor: 1,
		mobile: false,
	});

	// The first thing on the page is also what the gates and AI-01 to AI-03 look at, so the load is
	// measured from here: everything the desk requested before anything was clicked.
	const loadMark = netMark();
	await page.goto(`${BASE}/desk/todo`);
	await page.waitFor(`!!(frappe.app && frappe.app.sidebar) && !!document.querySelector('.cf-shell-header')`, {
		timeout: 90000,
	});
	await sleep(1500);
	await assertCarbonStylesheet(page);

	if (CLEANUP_ONLY) {
		run.fixtures = true;
		const problems = await cleanup(page);
		console.log(problems.length ? `cleanup left: ${problems.join("; ")}` : "cleanup: nothing left behind");
		process.exitCode = problems.length ? 1 : 0;
	} else {
		await runSuite(loadMark);
	}
} catch (e) {
	fail("AI-00", "suite threw", e instanceof Error ? e.stack || e.message : String(e));
	console.log(results[results.length - 1]);
} finally {
	try {
		if (run.fixtures && !CLEANUP_ONLY) {
			const problems = await cleanup(page);
			ok(
				"AI-00",
				"cleanup removed every CF AI Test document",
				problems.length === 0,
				problems.join("; ") || undefined,
				"nothing left behind",
			);
			console.log(results[results.length - 1]);
		}
	} catch (e) {
		fail("AI-00", "cleanup", e instanceof Error ? e.message : String(e));
		console.log(results[results.length - 1]);
	}
	if (run.mock !== null) await run.mock.close().catch(() => {});
	removeDiskFiles();
	page.close();
	proc.kill();
}

if (!CLEANUP_ONLY) {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}
process.exit(process.exitCode ?? 0);

async function runSuite(loadMark: number): Promise<void> {
	const flowInstalled = await flag(page, `!!(frappe.boot.versions && frappe.boot.versions.flow)`);

	if (!flowInstalled) {
		await group("AI-01", async () => {
			const state = await page.eval<{ trigger: boolean; panel: boolean; classes: string[] }>(`({
				trigger: !!document.getElementById('cf-ai-trigger'),
				panel: !!document.getElementById('cf-ai-panel'),
				classes: [...document.body.classList].filter((c) => c.startsWith('cf-ai')),
			})`);
			const chunks = netSince(loadMark, /\/dist\/ai_chat\//);
			ok(
				"AI-01",
				"flow is not installed: no trigger, no host, no body class, no chat request",
				!state.trigger && !state.panel && state.classes.length === 0 && chunks.length === 0,
				{ ...state, requests: chunks.map((c) => c.url) },
				"nothing of the assistant on a site without flow",
			);
		});
		console.log("SKIP  flow is not installed; cases AI-02 to AI-67 skipped");
		return;
	}

	// From Node, not the page: a request the page makes is a request AI-02 would count.
	const manifest = await fetch(`${BASE}/assets/carbon_frappe/dist/ai_chat/manifest.json`);
	if (!manifest.ok) {
		fail(
			"AI-01",
			"the chat bundle is built",
			`manifest.json answered ${manifest.status}: run "yarn build:chat"`,
		);
		console.log(results[results.length - 1]);
		return;
	}

	// The site starts with no Flow Model, Agent or Tool, so a leftover of a crashed earlier run is
	// the only thing that can be in the way. It goes before the suite creates its own.
	run.fixtures = true;
	const stale = await cleanup(page);
	if (stale.length) throw new Error(`could not clear the leftovers of an earlier run: ${stale.join("; ")}`);

	await group("AI-01", async () => {
		const state = await page.eval<{
			inGlobal: boolean;
			beforeSwitcher: boolean;
			label: string | null;
			controls: string | null;
			expanded: string | null;
		}>(`(() => {
			const t = ${trigger}; const s = document.getElementById('cf-switcher-button');
			return {
				inGlobal: !!t && !!t.closest('.cds--header__global'),
				beforeSwitcher: !!t && !!s && t.nextElementSibling === s,
				label: t && t.getAttribute('aria-label'),
				controls: t && t.getAttribute('aria-controls'),
				expanded: t && t.getAttribute('aria-expanded'),
			};
		})()`);
		ok(
			"AI-01",
			"trigger sits in the global bar, directly before the switcher, with aria wired",
			state.inGlobal &&
				state.beforeSwitcher &&
				state.label === "AI assistant" &&
				state.controls === "cf-ai-panel" &&
				state.expanded === "false",
			state,
			`inGlobal, beforeSwitcher, label "AI assistant", controls "cf-ai-panel", expanded "false"`,
		);
		const placed = `(() => { const t = ${trigger}; const s = document.getElementById('cf-switcher-button'); return !!t && !!s && t.nextElementSibling === s; })()`;
		await page.eval(`frappe.set_route('/desk/user')`);
		await page.waitFor(`location.pathname === '/desk/user'`, { timeout: 30000 });
		await sleep(600);
		ok("AI-01", "trigger stays before the switcher after a route change", await flag(page, placed));
		await page.eval(`history.back()`);
		await page.waitFor(`location.pathname === '/desk/todo'`, { timeout: 30000 });
		await sleep(600);
		ok("AI-01", "trigger stays before the switcher after coming back", await flag(page, placed));
	});

	await group("AI-02", async () => {
		const chunks = netSince(loadMark, /\/dist\/ai_chat\//).map((n) => n.url);
		const reactish = netSince(loadMark, /react/i).map((n) => n.url);
		ok(
			"AI-02",
			"the first desk load requests nothing under /dist/ai_chat/",
			chunks.length === 0,
			chunks,
			"[]",
		);
		ok("AI-02", "the first desk load requests nothing named react", reactish.length === 0, reactish, "[]");
		const host = await page.eval<{
			tag: string;
			label: string | null;
			visibility: string;
			stops: string[];
		} | null>(`(() => {
			const h = document.getElementById('cf-ai-panel');
			return h ? { tag: h.tagName, label: h.getAttribute('aria-label'), visibility: getComputedStyle(h).visibility, stops: ${A}.tabStops(h) } : null;
		})()`);
		ok(
			"AI-02",
			"aside#cf-ai-panel exists, labelled, hidden, with no tab stop",
			host !== null &&
				host.tag === "ASIDE" &&
				!!host.label &&
				host.visibility === "hidden" &&
				host.stops.length === 0,
			host,
			`ASIDE, aria-label, visibility hidden, stops []`,
		);
	});

	await group("AI-03", async () => {
		const flowPanelAsset = await fetch(`${BASE}/assets/flow/flow_panel/flow_panel.js`);
		ok(
			"AI-03",
			"flow's panel bundle is served, so there is a panel to take over",
			flowPanelAsset.ok,
			flowPanelAsset.status,
			`200 (a 404 means sites/assets/flow is not linked to apps/flow/flow/public: bench build links it)`,
		);
		const state = await page.eval<{
			chat: boolean;
			flowRoot: string | null;
			flowVisible: unknown;
			stored: string | null;
		}>(`({
			chat: document.body.classList.contains('cf-ai-chat'),
			flowRoot: document.getElementById('flow-root') ? getComputedStyle(document.getElementById('flow-root')).display : null,
			flowVisible: ${A}.flowVisible(),
			stored: localStorage.getItem('flow-panel-state'),
		})`);
		let storedOpen: unknown = "absent";
		try {
			if (state.stored !== null) storedOpen = dig(JSON.parse(state.stored), "open");
		} catch {
			storedOpen = "unparseable";
		}
		ok(
			"AI-03",
			"flow's panel is taken over: class set, #flow-root hidden, panel closed, state not open",
			state.chat &&
				state.flowRoot === "none" &&
				state.flowVisible === false &&
				(storedOpen === "absent" || storedOpen === false),
			{ ...state, storedOpen },
			`body.cf-ai-chat, #flow-root display none, panel.visible false, flow-panel-state open false or absent`,
		);
		await page.eval(`document.body.focus()`);
		await press(page, "i", CTRL);
		await page.waitFor(`${A}.isOpen()`, { timeout: 15000 });
		const after = await page.eval<{ visible: string; flow: unknown }>(`({
			visible: getComputedStyle(document.getElementById('cf-ai-panel')).visibility,
			flow: ${A}.flowVisible(),
		})`);
		ok(
			"AI-03",
			"Ctrl+I opens our panel and not flow's",
			after.visible === "visible" && after.flow !== true,
			after,
			`host visible, flow.panel.visible false`,
		);
		await waitMounted(page).catch(() => {});
		await press(page, "i", CTRL);
		await sleep(400);
		const stillOpen = await flag(page, `${A}.isOpen()`);
		ok("AI-03", "Ctrl+I again closes it", !stillOpen, stillOpen, "closed");
	});

	await group("AI-05", async () => {
		await freshPage(page);
		const release = await delayRequests(page, "*/dist/ai_chat/manifest.json*", 800);
		try {
			await click(page, trigger, false);
			await page.waitFor(`!!document.querySelector('#cf-ai-panel .cf-ai-status .cds--inline-loading')`, {
				timeout: 4000,
			});
			const state = await page.eval<{ text: string; busy: string | null }>(`({
				text: ${A}.deepText(document.querySelector('#cf-ai-panel .cf-ai-status .cds--inline-loading')),
				busy: document.getElementById('cf-ai-panel').getAttribute('aria-busy'),
			})`);
			ok(
				"AI-05",
				"while the manifest is held, the host shows the inline loading state",
				state.text.includes("Loading the AI assistant") && state.busy === "true",
				state,
				`text "Loading the AI assistant…", aria-busy "true"`,
			);
			await waitMounted(page);
			const gone = await page.eval<{ status: boolean; busy: string | null }>(`({
				status: !!document.querySelector('#cf-ai-panel .cf-ai-status:not([hidden])'),
				busy: document.getElementById('cf-ai-panel').getAttribute('aria-busy'),
			})`);
			ok(
				"AI-05",
				"the loading state is gone once mounted",
				!gone.status && gone.busy !== "true",
				gone,
				`no .cf-ai-status, aria-busy not "true"`,
			);
		} finally {
			await release();
		}
		await press(page, "Escape");
		await page.waitFor(`!${A}.isOpen()`, { timeout: 5000 });
	});

	await group("AI-04", async () => {
		await freshPage(page);
		const mark = netMark();
		const errorsBefore = errors.length;
		await click(page, trigger, false);
		await waitMounted(page);
		const state = await page.eval<{
			expanded: string | null;
			active: boolean;
			defined: boolean;
			inHost: boolean;
			status: boolean;
		}>(`({
			expanded: ${trigger}.getAttribute('aria-expanded'),
			active: ${trigger}.classList.contains('cds--header__action--active'),
			defined: !!customElements.get('cds-aichat-shell'),
			inHost: !!document.querySelector('#cf-ai-panel cds-aichat-shell'),
			status: !!document.querySelector('#cf-ai-panel .cf-ai-status:not([hidden])'),
		})`);
		ok(
			"AI-04",
			"the trigger opens a mounted chat",
			state.expanded === "true" && state.active && state.defined && state.inHost && !state.status,
			state,
			`aria-expanded "true", active class, shell defined and in host, no status block`,
		);
		const manifestReq = netSince(mark, /\/dist\/ai_chat\/manifest\.json/);
		const entries = netSince(mark, /\/dist\/ai_chat\/entry\.[^/]*\.js/);
		const sheets = netSince(mark, /\/dist\/ai_chat\/chat\.[^/]*\.css/);
		const react = netSince(mark, /react/i);
		ok(
			"AI-04",
			"first open fetches the manifest, one entry and one stylesheet, and no react",
			manifestReq.length >= 1 && entries.length === 1 && sheets.length === 1 && react.length === 0,
			{
				manifest: manifestReq.length,
				entries: entries.map((e) => e.url),
				sheets: sheets.map((e) => e.url),
				react: react.map((e) => e.url),
			},
			`manifest >= 1, entries 1, sheets 1, react 0`,
		);
		ok(
			"AI-04",
			"input has focus",
			await flag(page, `${A}.deepActive() === ${A}.textarea() && ${A}.textarea().tagName === 'TEXTAREA'`),
			await page.eval(`${A}.deepActive() && ${A}.deepActive().tagName`),
			"the textarea of cds-aichat-prompt-line",
		);
		const fresh = errors.slice(errorsBefore).map((e) => e.text);
		ok("AI-04", "opening logged no console error", fresh.length === 0, fresh, "[]");
	});

	await group("AI-06", async () => {
		await freshPage(page);
		const mainBefore = await page.eval<string | null>(
			`(() => { const m = document.querySelector('.main-section'); return m ? JSON.stringify(${A}.rect(m)) : null; })()`,
		);
		await openPanel(page);
		const geometry = await page.eval<{
			rect: { top: number; right: number; width: number };
			z: string;
			width: number;
			main: string | null;
		}>(`(() => {
			const h = document.getElementById('cf-ai-panel'); const m = document.querySelector('.main-section');
			return { rect: ${A}.rect(h), z: getComputedStyle(h).zIndex, width: innerWidth, main: m ? JSON.stringify(${A}.rect(m)) : null };
		})()`);
		ok(
			"AI-06",
			"host is 360 wide under the 48px header, flush right, z-index 1025",
			geometry.rect.top === 48 &&
				geometry.rect.right === geometry.width &&
				geometry.rect.width === 360 &&
				geometry.z === "1025",
			geometry,
			`top 48, right ${geometry.width}, width 360, z-index 1025`,
		);
		ok(
			"AI-06",
			"opening does not move .main-section (overlay, not push)",
			mainBefore !== null && mainBefore === geometry.main,
			{ before: mainBefore, after: geometry.main },
			"identical rects",
		);
		await click(page, `${A}.action('Expand')`);
		await page.waitFor(`document.body.classList.contains('cf-ai-expanded')`, { timeout: 5000 });
		await sleep(500);
		const expanded = await page.eval<{ width: number; viewport: number; actions: string[] }>(`({
			width: ${A}.rect(document.getElementById('cf-ai-panel')).width, viewport: innerWidth, actions: ${A}.actions(),
		})`);
		ok(
			"AI-06",
			"Expand fills the viewport and the action becomes Collapse",
			expanded.width === expanded.viewport && expanded.actions.includes("Collapse"),
			expanded,
			`width = viewport, actions include "Collapse"`,
		);
		const coveredWhenExpanded = await page.eval<Array<boolean | null>>(coveredInert);
		ok(
			"AI-06",
			"an expanded panel makes the page column and the sidebar inert",
			coveredWhenExpanded.length === 2 && coveredWhenExpanded.every((inert) => inert === true),
			coveredWhenExpanded,
			"[true, true]",
		);
		const toastExpanded = await toastOverlapsPrompt(page);
		ok(
			"AI-06",
			"a toast over the expanded panel clears the prompt line",
			toastExpanded.toast && !toastExpanded.overlaps,
			toastExpanded,
			"a toast that does not intersect cds-aichat-prompt-line-shell",
		);
		await click(page, `${A}.action('Collapse')`);
		await page.waitFor(`!document.body.classList.contains('cf-ai-expanded')`, { timeout: 5000 });
		await sleep(500);
		const collapsed = await page.eval<number>(`${A}.rect(document.getElementById('cf-ai-panel')).width`);
		ok("AI-06", "Collapse restores 360", collapsed === 360, collapsed, "360");
		const coveredWhenCollapsed = await page.eval<Array<boolean | null>>(coveredInert);
		ok(
			"AI-06",
			"a collapsed panel on a wide viewport leaves the page interactive",
			coveredWhenCollapsed.length === 2 && coveredWhenCollapsed.every((inert) => inert === false),
			coveredWhenCollapsed,
			"[false, false]",
		);
		const toastCollapsed = await toastOverlapsPrompt(page);
		ok(
			"AI-06",
			"a toast beside the collapsed panel clears the prompt line",
			toastCollapsed.toast && !toastCollapsed.overlaps,
			toastCollapsed,
			"a toast that does not intersect cds-aichat-prompt-line-shell",
		);
		const dir = await page.eval<string | null>(`document.documentElement.getAttribute('dir')`);
		await page.eval(`document.documentElement.dir = 'rtl'`);
		await sleep(500);
		const rtl = await page.eval<{ left: number; right: number; viewport: number }>(`({
			...${A}.rect(document.getElementById('cf-ai-panel')), viewport: innerWidth,
		})`);
		await page.eval(
			dir === null
				? `document.documentElement.removeAttribute('dir')`
				: `document.documentElement.setAttribute('dir', ${JSON.stringify(dir)})`,
		);
		ok(
			"AI-06",
			"in a right-to-left document the open panel stays inside the viewport",
			rtl.left >= 0 && rtl.right <= rtl.viewport,
			rtl,
			"0 <= left and right <= viewport",
		);
		await viewport(page, 600, 900);
		const narrow = await page.eval<number>(`${A}.rect(document.getElementById('cf-ai-panel')).width`);
		ok("AI-06", "at a 600px viewport the host is 600 wide", narrow === 600, narrow, "600");
		const coveredWhenNarrow = await page.eval<Array<boolean | null>>(coveredInert);
		ok(
			"AI-06",
			"a panel as wide as the viewport makes the page column and the sidebar inert",
			coveredWhenNarrow.length === 2 && coveredWhenNarrow.every((inert) => inert === true),
			coveredWhenNarrow,
			"[true, true]",
		);
		await viewport(page, 1600, 1000);
		await closePanelWithTrigger(page);
		const coveredWhenClosed = await page.eval<Array<boolean | null>>(coveredInert);
		ok(
			"AI-06",
			"closing the panel releases the page column and the sidebar",
			coveredWhenClosed.length === 2 && coveredWhenClosed.every((inert) => inert === false),
			coveredWhenClosed,
			"[false, false]",
		);
	});

	await group("AI-07", async () => {
		const closedState = (): Promise<{
			open: boolean;
			focusIsTrigger: boolean;
			expanded: string | null;
			visibility: string;
		}> =>
			page.eval(`({
				open: ${A}.isOpen(),
				focusIsTrigger: document.activeElement === ${trigger},
				expanded: ${trigger}.getAttribute('aria-expanded'),
				visibility: getComputedStyle(document.getElementById('cf-ai-panel')).visibility,
			})`);
		await openPanel(page);
		await focusInput(page);
		await press(page, "Escape");
		await sleep(500);
		const byEscape = await closedState();
		ok(
			"AI-07",
			"Escape in the prompt line closes the panel and returns focus to the trigger",
			!byEscape.open &&
				byEscape.focusIsTrigger &&
				byEscape.expanded === "false" &&
				byEscape.visibility === "hidden",
			byEscape,
			`closed, focus on #cf-ai-trigger, aria-expanded "false", visibility hidden`,
		);
		await openPanel(page);
		await click(page, `${A}.action('Close')`);
		await sleep(500);
		const byAction = await closedState();
		ok(
			"AI-07",
			"the header Close action does the same",
			!byAction.open &&
				byAction.focusIsTrigger &&
				byAction.expanded === "false" &&
				byAction.visibility === "hidden",
			byAction,
			`closed, focus on #cf-ai-trigger, aria-expanded "false", visibility hidden`,
		);
		await openPanel(page);
		await click(page, trigger, false);
		await sleep(500);
		const byTrigger = await page.eval<{ open: boolean; inHost: boolean; expanded: string | null }>(`({
			open: ${A}.isOpen(),
			inHost: document.getElementById('cf-ai-panel').contains(${A}.deepActive()),
			expanded: ${trigger}.getAttribute('aria-expanded'),
		})`);
		ok(
			"AI-07",
			"clicking the trigger while open closes without moving focus into the panel",
			!byTrigger.open && !byTrigger.inHost && byTrigger.expanded === "false",
			byTrigger,
			`closed, focus outside the host, aria-expanded "false"`,
		);
	});

	await group("AI-08", async () => {
		const state = (): Promise<{ ai: boolean; switcher: boolean; bell: boolean }> =>
			page.eval(`({
				ai: ${A}.isOpen(),
				switcher: document.getElementById('cf-switcher-panel').classList.contains('cds--header-panel--expanded'),
				bell: (() => { const b = document.querySelector('.cds--header__global .dropdown-notifications'); return b ? b.classList.contains('hidden') : null; })(),
			})`);
		await openPanel(page);
		await click(page, `document.getElementById('cf-switcher-button')`, false);
		await sleep(400);
		const switched = await state();
		ok(
			"AI-08",
			"opening the switcher closes the assistant",
			switched.switcher && !switched.ai,
			switched,
			"switcher open, assistant closed",
		);
		await page.eval(
			`(() => { const b = document.querySelector('.cds--header__global .dropdown-notifications'); if (b) b.classList.remove('hidden'); })()`,
		);
		await click(page, trigger, false);
		await page.waitFor(`${A}.isOpen()`, { timeout: 10000 });
		await sleep(400);
		const back = await state();
		ok(
			"AI-08",
			"opening the assistant closes the switcher and hides the notifications panel",
			back.ai && !back.switcher && back.bell === true,
			back,
			"assistant open, switcher closed, .dropdown-notifications hidden",
		);
		await closePanelWithTrigger(page);
	});

	await group("AI-09", async () => {
		await freshPage(page);
		await openPanel(page);
		await click(page, `${A}.action('Expand')`);
		await page.waitFor(`document.body.classList.contains('cf-ai-expanded')`, { timeout: 5000 });
		await sleep(400);
		await freshPage(page, "/desk/todo", true);
		await page.waitFor(`${A}.isOpen()`, { timeout: 15000 });
		await waitMounted(page).catch(() => {});
		await page.waitFor(`!!${A}.shell()`, { timeout: 30000 });
		await sleep(500);
		const restored = await page.eval<{
			open: boolean;
			expanded: boolean;
			width: number;
			viewport: number;
		}>(`({
			open: ${A}.isOpen(), expanded: document.body.classList.contains('cf-ai-expanded'),
			width: ${A}.rect(document.getElementById('cf-ai-panel')).width, viewport: innerWidth,
		})`);
		ok(
			"AI-09",
			"open and expanded survive a reload: the panel reopens itself and the chat mounts",
			restored.open && restored.expanded && restored.width === restored.viewport,
			restored,
			`open, expanded, width = viewport`,
		);
		await click(page, `${A}.action('Collapse')`);
		await sleep(500);
		await closePanelWithTrigger(page);
		const mark = netMark();
		await freshPage(page, "/desk/todo", true);
		await sleep(2000);
		const stayed = await page.eval<{ open: boolean; expanded: boolean }>(`({
			open: ${A}.isOpen(), expanded: document.body.classList.contains('cf-ai-expanded'),
		})`);
		const loaded = netSince(mark, /\/dist\/ai_chat\//).map((n) => n.url);
		ok(
			"AI-09",
			"a closed, collapsed panel stays closed and loads nothing",
			!stayed.open && !stayed.expanded && loaded.length === 0,
			{ ...stayed, loaded },
			"closed, collapsed, no /dist/ai_chat/ request",
		);
	});

	// -- the cases from here need an agent -------------------------------------------------

	const flowMock = await startMockLlm();
	run.mock = flowMock;
	await createFixtures(page, flowMock);

	await group("AI-10", async () => {
		await page.eval(
			`(localStorage.setItem('cf-ai-agent', ${JSON.stringify(AGENT)}), localStorage.removeItem('cf-ai-session'), true)`,
		);
		await freshPage(page);
		await openPanel(page);
		await page.waitFor(`document.querySelectorAll('#cf-ai-panel .cf-ai-starter').length > 0`, {
			timeout: 15000,
		});
		const home = await page.eval<{
			greeting: string;
			starters: number;
			messagesVisible: boolean;
			first: string;
		}>(`({
			greeting: ${A}.deepText(document.querySelector('#cf-ai-panel .cf-ai-home__greeting') || document.body),
			starters: document.querySelectorAll('#cf-ai-panel .cf-ai-starter').length,
			messagesVisible: ${A}.visible(document.querySelector('#cf-ai-panel .cf-ai-messages')),
			first: (frappe.boot.user && frappe.boot.user.first_name) || '',
		})`);
		ok(
			"AI-10",
			"an empty conversation shows the greeting and four starters, and no message list",
			home.greeting.includes("Hello") &&
				(!home.first || home.greeting.includes(home.first)) &&
				home.starters === 4 &&
				!home.messagesVisible,
			home,
			`greeting with "Hello" and the first name, 4 starters, messages hidden`,
		);
		await closePanelWithTrigger(page);
		await freshPage(page);
		await page.eval(`(frappe.db.count = async () => 0, true)`);
		await openPanel(page);
		await page.waitFor(`!!document.querySelector('#cf-ai-panel .cf-ai-home--setup')`, { timeout: 15000 });
		const setup = await page.eval<{ starters: number; steps: number }>(`({
			starters: document.querySelectorAll('#cf-ai-panel .cf-ai-starter').length,
			steps: document.querySelectorAll('#cf-ai-panel .cf-ai-home__steps li').length,
		})`);
		ok(
			"AI-10",
			"with no enabled agent the home shows the setup state, with no starters",
			setup.starters === 0 && setup.steps === 2,
			setup,
			`.cf-ai-home--setup, 0 starters, 2 setup steps`,
		);
		await closePanelWithTrigger(page);
	});

	await group("AI-11", async () => {
		await freshPage(page);
		await openPanel(page);
		await startWatch(page);
		await say(page, "hello", false);
		await waitIdle(page);
		const seen = await stopWatch(page);
		const state = await page.eval<{
			userText: string;
			assistantRows: number;
			md: { h2: boolean; strong: boolean; code: boolean; table: boolean; snippet: string | null };
			stopVisible: boolean;
			value: string;
			focused: boolean;
		}>(`(() => {
			const row = ${A}.lastAssistant(); const md = row && row.querySelector('cds-aichat-markdown'); const root = md && md.shadowRoot;
			const snippet = md && md.querySelector('cds-aichat-code-snippet');
			return {
				userText: ${A}.deepText(${A}.userRows().slice(-1)[0]),
				assistantRows: ${A}.assistantRows().length,
				md: { h2: !!(root && root.querySelector('h2')), strong: !!(root && root.querySelector('strong')), code: !!(root && root.querySelector('code')),
					table: !!(root && root.querySelector('cds-aichat-table')), snippet: snippet ? snippet.language : null },
				stopVisible: ${A}.send().isStopStreamingButtonVisible,
				value: ${A}.prompt().getValue(),
				focused: ${A}.deepActive() === ${A}.textarea(),
			};
		})()`);
		ok(
			"AI-11",
			"the user row shows what was typed",
			state.userText.includes("hello"),
			state.userText,
			`contains "hello"`,
		);
		ok("AI-11", "the processing indicator appeared while waiting", seen.processing, seen.processing, "true");
		ok("AI-11", "one assistant row", state.assistantRows === 1, state.assistantRows, "1");
		ok(
			"AI-11",
			"the reply renders a heading, bold, inline code, a table and a python code snippet",
			state.md.h2 && state.md.strong && state.md.code && state.md.table && state.md.snippet === "python",
			state.md,
			`h2, strong, code, cds-aichat-table, snippet language "python"`,
		);
		ok(
			"AI-11",
			"Stop was offered while streaming and Send is back",
			seen.stop && !state.stopVisible,
			{ sawStop: seen.stop, stopNow: state.stopVisible },
			"sawStop true, stopNow false",
		);
		ok(
			"AI-11",
			"the prompt line is empty and focused",
			state.value === "" && state.focused,
			{ value: state.value, focused: state.focused },
			`"" and focused`,
		);
	});

	await group("AI-11b", async () => {
		await page.eval(`(delete window.__cfAiPwned, true)`);
		await say(page, "unsafe markup please");
		const state = await page.eval<{
			pwned: unknown;
			handlers: number;
			scripts: number;
			jsLinks: number;
			overlays: number;
			remoteImages: number;
			text: string;
		}>(`(() => {
			const row = ${A}.lastAssistant();
			const all = ${A}.deepAll(row, '*');
			return {
				pwned: window.__cfAiPwned === undefined ? null : window.__cfAiPwned,
				handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
				scripts: all.filter((el) => el.tagName === 'SCRIPT').length,
				jsLinks: all.filter((el) => /^\\s*javascript:/i.test(el.getAttribute('href') || '')).length,
				overlays: all.filter((el) => /position\\s*:\\s*fixed/i.test(el.getAttribute('style') || '')).length,
				remoteImages: all.filter((el) => {
					const src = el.tagName === 'IMG' ? el.getAttribute('src') || '' : '';
					if (src === '') return false;
					const url = new URL(src, location.origin);
					return url.origin !== location.origin || !/^\\/(private\\/)?files\\//.test(url.pathname);
				}).length,
				text: ${A}.deepText(row),
			};
		})()`);
		ok(
			"AI-11b",
			"assistant markdown is sanitised: no handler attribute, script element or javascript: link survives, and nothing ran",
			state.pwned === null && state.handlers === 0 && state.scripts === 0 && state.jsLinks === 0,
			{ pwned: state.pwned, handlers: state.handlers, scripts: state.scripts, jsLinks: state.jsLinks },
			"pwned null, 0 handlers, 0 scripts, 0 javascript: links",
		);
		ok(
			"AI-11b",
			"no reply can lay an overlay over the page or load an image from another site",
			state.overlays === 0 && state.remoteImages === 0,
			{ overlays: state.overlays, remoteImages: state.remoteImages },
			"0 position:fixed styles, 0 images outside /files/",
		);
		ok(
			"AI-11b",
			"the safe text around the markup still rendered",
			state.text.includes("Safe text before") && state.text.includes("Safe text after"),
			state.text.slice(0, 160),
			`"Safe text before" and "Safe text after"`,
		);
	});

	await group("AI-12", async () => {
		const mark = flowMock.requests.length;
		await startWatch(page);
		await say(page, "TOOL READ the ToDos", false);
		await waitIdle(page);
		const seen = await stopWatch(page);
		const state = await page.eval<{
			steps: boolean;
			toggle: boolean;
			status: string | null;
			tool: string | null;
			closed: string | null;
			text: string;
		}>(`(() => {
			const row = ${A}.lastAssistant();
			const step = ${A}.deepAll(row, 'cds-aichat-chain-of-thought-step')[0];
			const call = step && ${A}.deepAll(step, 'cds-aichat-tool-call-data')[0];
			const toggle = ${A}.deepAll(row, 'cds-aichat-chain-of-thought-toggle')[0];
			return { steps: !!row.querySelector('.cf-ai-message__steps'), toggle: !!toggle, status: step ? step.status : null,
				tool: call ? call.toolName : null, closed: toggle ? toggle.closedLabelText : null, text: ${A}.deepText(row) };
		})()`);
		ok(
			"AI-12",
			"the response carries a step list whose step finished as success for the read tool",
			state.steps && state.toggle && state.status === "success" && state.tool === TOOL_READ,
			state,
			`.cf-ai-message__steps, a toggle, status "success", tool "${TOOL_READ}"`,
		);
		ok(
			"AI-12",
			"the step was observed processing, and the collapsed toggle named it meanwhile",
			seen.steps.includes(`${TOOL_READ}:processing`) && seen.processingLabels.some((l) => l !== "Show steps"),
			{ steps: seen.steps, labelsWhileProcessing: seen.processingLabels },
			`a "${TOOL_READ}:processing" sample and a toggle label other than "Show steps" during it`,
		);
		ok(
			"AI-12",
			"the toggle is back to Show steps when nothing is processing",
			state.closed === "Show steps",
			state.closed,
			`"Show steps"`,
		);
		await click(
			page,
			`${A}.deepAll(${A}.lastAssistant(), 'cds-aichat-chain-of-thought-toggle')[0].shadowRoot.querySelector('button')`,
		);
		await sleep(300);
		const opened = await page.eval<{ open: boolean; input: string }>(`(() => {
			const row = ${A}.lastAssistant();
			const list = ${A}.deepAll(row, 'cds-aichat-chain-of-thought')[0];
			const call = ${A}.deepAll(row, 'cds-aichat-tool-call-data')[0];
			return { open: !!list && list.open === true, input: call ? ${A}.deepText(call) : '' };
		})()`);
		ok(
			"AI-12",
			"opening the toggle shows the step with its input",
			opened.open && opened.input.includes("ToDo"),
			opened,
			`list open, input contains "ToDo"`,
		);
		ok(
			"AI-12",
			"the final text arrived",
			state.text.includes("I found"),
			state.text.slice(-120),
			`contains "I found"`,
		);
		const calls = flowMock.requests
			.slice(mark)
			.filter((r) => r.keyword === "TOOL READ" || r.keyword === "TOOL RESULT");
		ok(
			"AI-12",
			"flow called the model a second time with the tool result",
			calls.length === 2 && calls[1]?.lastRole === "tool",
			calls.map((c) => `${c.keyword}/${c.lastRole}`),
			`[TOOL READ/user, TOOL RESULT/tool]`,
		);
	});

	await group("AI-13", async () => {
		const mark = netMark();
		await startWatch(page);
		await say(page, "SLOW please", false);
		await page.waitFor(`${A}.deepText(${A}.lastAssistant() || document.body).includes('word1')`, {
			timeout: 30000,
		});
		const stopVisible = await flag(page, `${A}.send().isStopStreamingButtonVisible`);
		ok("AI-13", "the Stop button is visible while streaming", stopVisible, stopVisible, "true");
		await click(page, `${A}.send().shadowRoot.querySelector('cds-aichat-stop-streaming-button')`);
		const asked = await until(() => netSince(mark, /flow\.api\.(api\.)?stop_run/).length > 0, 3000);
		ok("AI-13", "Stop calls stop_run within 3s", asked, netSince(mark, /stop_run/).length, ">= 1 request");
		await page.waitFor(`!!${A}.lastAssistant().querySelector('.cf-ai-stopped')`, { timeout: 5000 });
		await stopWatch(page);
		const state = await page.eval<{
			stopped: string;
			stopVisible: boolean;
			disabled: boolean;
			focused: boolean;
		}>(`({
			stopped: ${A}.deepText(${A}.lastAssistant().querySelector('.cf-ai-stopped')),
			stopVisible: ${A}.send().isStopStreamingButtonVisible,
			disabled: ${A}.prompt().disabled,
			focused: ${A}.deepActive() === ${A}.textarea(),
		})`);
		ok(
			"AI-13",
			"the row says Response stopped and the input is back: Send shown, enabled, focused",
			state.stopped.includes("Response stopped") && !state.stopVisible && !state.disabled && state.focused,
			state,
			`"Response stopped", no Stop, prompt enabled, focused`,
		);
		const session = await sessionName(page);
		let latest: Record<string, unknown> | undefined;
		for (let i = 0; i < 20; i++) {
			latest = (
				await list(
					page,
					"Flow Run",
					[["session", "=", session]],
					["name", "status", "error"],
					"creation desc",
				)
			)[0];
			if (latest !== undefined && latest["status"] === "Failed") break;
			await sleep(250);
		}
		const error = str(latest?.["error"]) ?? "";
		ok(
			"AI-13",
			"the Flow Run ended Failed as stopped",
			latest?.["status"] === "Failed" && /Stopped by user|Stream interrupted/.test(error),
			{ status: latest?.["status"], error },
			`status "Failed", error "Stopped by user." or "Stream interrupted"`,
		);
		await say(page, "hello");
		ok(
			"AI-13",
			"a new turn after Stop completes",
			(await lastAssistantText(page)).includes("CF AI Test reply"),
			await lastAssistantText(page),
			`"CF AI Test reply"`,
		);
	});

	/** Run a TOOL CREATE turn up to the point where the approval card is waiting. */
	const askToCreate = async (digits: number): Promise<void> => {
		await say(page, `TOOL CREATE ${digits}`, false);
		await page.waitFor(`!!${A}.card()`, { timeout: 60000 });
		await sleep(300);
	};

	await group("AI-14", async () => {
		await startWatch(page);
		await askToCreate(7001);
		const card = await page.eval<{
			questions: number;
			approve: boolean;
			deny: boolean;
			code: string;
			rows: number;
		}>(`(() => {
			const c = ${A}.card();
			const snippet = c.querySelector('cds-aichat-code-snippet');
			return { questions: c.querySelectorAll('.cf-ai-approval__question[data-key]').length,
				approve: ${A}.visible(c.querySelector('[data-action="approve"]')), deny: ${A}.visible(c.querySelector('[data-action="deny"]')),
				code: snippet ? snippet.code : '', rows: ${A}.assistantRows().length };
		})()`);
		ok(
			"AI-14",
			"the approval card shows one question, Approve and Deny, and the arguments",
			card.questions === 1 && card.approve && card.deny && card.code.includes("CF AI Test 7001"),
			card,
			`1 question, both buttons visible, snippet contains "CF AI Test 7001"`,
		);
		ok(
			"AI-14",
			"nothing was created before the answer",
			(await todosNamed(page, "CF AI Test 7001")).length === 0,
			undefined,
			"no ToDo",
		);
		await click(page, `${A}.cardButton('approve')`);
		await sleep(200);
		await waitIdle(page);
		await sleep(700);
		const seen = await stopWatch(page);
		ok(
			"AI-14",
			"the live region announced the approval request",
			seen.announced.some((a) => a.startsWith("assertive:") && a.includes("needs your approval")),
			seen.announced,
			`an assertive message containing "needs your approval"`,
		);
		const after = await page.eval<{
			locked: boolean;
			result: string;
			rows: number;
			text: string;
			steps: string[];
		}>(`(() => {
			const row = ${A}.lastAssistant(); const c = row.querySelector('.cf-ai-approval');
			return { locked: !!c && c.classList.contains('cf-ai-approval--locked'), result: c ? ${A}.deepText(c) : '', rows: ${A}.assistantRows().length,
				text: ${A}.deepText(row), steps: ${A}.deepAll(row, 'cds-aichat-chain-of-thought-step').map((s) => s.status) };
		})()`);
		ok(
			"AI-14",
			"the card locks and says Approved",
			after.locked && after.result.includes("Approved"),
			{ locked: after.locked, result: after.result.slice(0, 120) },
			`locked, contains "Approved"`,
		);
		ok(
			"AI-14",
			"the same response continues: no new assistant row",
			after.rows === card.rows,
			{ before: card.rows, after: after.rows },
			"equal",
		);
		ok(
			"AI-14",
			"the closing text arrived",
			after.text.includes("Created CF AI Test 7001."),
			after.text.slice(-120),
			`"Created CF AI Test 7001."`,
		);
		ok(
			"AI-14",
			"the ToDo exists",
			(await todosNamed(page, "CF AI Test 7001")).length === 1,
			undefined,
			"exactly one ToDo",
		);
		ok(
			"AI-14",
			"every step is success",
			after.steps.length > 0 && after.steps.every((s) => s === "success"),
			after.steps,
			`all "success"`,
		);
	});

	await group("AI-15", async () => {
		await askToCreate(7002);
		const rows = await page.eval<number>(`${A}.assistantRows().length`);
		await click(page, `${A}.cardButton('deny')`);
		await sleep(200);
		await waitIdle(page);
		const state = await page.eval<{
			locked: boolean;
			result: string;
			rows: number;
			promptDisabled: boolean;
			sendDisabled: boolean;
			stop: boolean;
		}>(`(() => {
			const c = ${A}.lastAssistant().querySelector('.cf-ai-approval');
			return { locked: !!c && c.classList.contains('cf-ai-approval--locked'), result: c ? ${A}.deepText(c) : '', rows: ${A}.assistantRows().length,
				promptDisabled: ${A}.prompt().disabled, sendDisabled: ${A}.send().disabled, stop: ${A}.send().isStopStreamingButtonVisible };
		})()`);
		ok(
			"AI-15",
			"Deny locks the card and says Denied",
			state.locked && state.result.includes("Denied"),
			{ locked: state.locked, result: state.result.slice(0, 120) },
			`locked, contains "Denied"`,
		);
		ok(
			"AI-15",
			"no second assistant row and the chat is ready",
			state.rows === rows && !state.promptDisabled && !state.sendDisabled && !state.stop,
			state,
			`same row count, enabled, no Stop`,
		);
		ok(
			"AI-15",
			"nothing was created",
			(await todosNamed(page, "CF AI Test 7002")).length === 0,
			undefined,
			"no ToDo",
		);
	});

	await group("AI-16", async () => {
		const resumeBodies = (mark: number) =>
			netSince(mark, /flow\.api\.(api\.)?resume_run/).map((n) => bodyOf(n));
		const checkRedirect = async (
			digits: number,
			typed: string,
			mark: number,
			keys: string[],
			via: string,
		): Promise<void> => {
			const sent = await until(() => resumeBodies(mark).length > 0, 5000);
			const answers = dig(resumeBodies(mark)[0], "answers");
			const expected = Object.fromEntries(keys.map((k) => [k, typed]));
			ok(
				"AI-16",
				`${via}: resume_run carries the typed text for every question`,
				sent && JSON.stringify(answers) === JSON.stringify(expected),
				answers,
				JSON.stringify(expected),
			);
			await waitIdle(page);
			ok(
				"AI-16",
				`${via}: the run continued`,
				(await lastAssistantText(page)).includes("Understood. I will adjust and try again."),
				(await lastAssistantText(page)).slice(-120),
				`"Understood. I will adjust and try again."`,
			);
			ok(
				"AI-16",
				`${via}: nothing was created`,
				(await todosNamed(page, `CF AI Test ${digits}`)).length === 0,
				undefined,
				"no ToDo",
			);
		};
		const questionKeys = (): Promise<string[]> =>
			page.eval(
				`[...${A}.card().querySelectorAll('.cf-ai-approval__question[data-key]')].map((q) => q.getAttribute('data-key'))`,
			);

		await askToCreate(7003);
		let keys = await questionKeys();
		let mark = netMark();
		await click(page, `${A}.cardButton('other')`);
		await page.waitFor(`${A}.visible(${A}.card().querySelector('.cf-ai-approval__redirect'))`, {
			timeout: 5000,
		});
		await page.eval(`${A}.card().querySelector('.cf-ai-approval__redirect').focus()`);
		await insertText(page, "use a different description");
		await click(page, `${A}.cardButton('redirect-send')`);
		await checkRedirect(7003, "use a different description", mark, keys, "via Other");

		await askToCreate(7004);
		keys = await questionKeys();
		mark = netMark();
		const placeholder = await page.eval<string>(`${A}.prompt().placeholder`);
		ok(
			"AI-16",
			"while an approval is pending the prompt invites a redirect",
			placeholder.includes("tell the assistant what to do instead"),
			placeholder,
			`contains "tell the assistant what to do instead"`,
		);
		await typeAndEnter(page, "make it shorter");
		await checkRedirect(7004, "make it shorter", mark, keys, "via the prompt line");
	});

	await group("AI-17", async () => {
		for (const [word, label] of [
			["ERROR", "a stream cut mid-reply"],
			["ERROR500", "an HTTP 500 before any chunk"],
		] as const) {
			const began = Date.now();
			await startWatch(page);
			await say(page, word, false);
			await page.waitFor(`!!${A}.lastAssistant() && !!${A}.lastAssistant().querySelector('.cf-ai-error')`, {
				timeout: 90000,
			});
			await waitIdle(page);
			// the announcer writes on a 250 ms tick, so the message can land just after the row settles
			await sleep(700);
			const seen = await stopWatch(page);
			tolerated.push([began, Date.now() + 2000]);
			const state = await page.eval<{
				text: string;
				title: string;
				retry: number;
				retryInLast: boolean;
				promptDisabled: boolean;
				stop: boolean;
			}>(`(() => {
				const error = ${A}.lastAssistant().querySelector('.cf-ai-error');
				const retry = [...document.querySelectorAll('#cf-ai-panel [data-action="retry-reply"]')];
				return {
					text: ${A}.deepText(error),
					title: ${A}.deepText(error.querySelector('.cds--inline-notification__title')),
					retry: retry.length, retryInLast: retry.length === 1 && error.contains(retry[0]),
					promptDisabled: ${A}.prompt().disabled, stop: ${A}.send().isStopStreamingButtonVisible,
				};
			})()`);
			ok(
				"AI-17",
				`${word}: ${label} shows an inline error and leaves the chat usable`,
				state.text.length > 0 && !state.promptDisabled && !state.stop,
				state,
				`.cf-ai-error with text, prompt enabled, no Stop`,
			);
			ok(
				"AI-17",
				`${word}: the error block names the failure in the user's terms`,
				state.title === "The assistant could not finish this reply",
				state.title,
				`"The assistant could not finish this reply"`,
			);
			ok(
				"AI-17",
				`${word}: Try again is offered on the last error row only`,
				state.retryInLast,
				{ retry: state.retry, inLast: state.retryInLast },
				"one [data-action=retry-reply], inside the last error block",
			);
			ok(
				"AI-17",
				`${word}: the assertive region announced the problem`,
				seen.announced.some(
					(a) => a.startsWith("assertive:") && /ran into a problem|Something went wrong/.test(a),
				),
				seen.announced,
				`an assertive "The assistant ran into a problem" or "Something went wrong"`,
			);
			await say(page, "hello");
			ok(
				"AI-17",
				`${word}: a following turn works`,
				(await lastAssistantText(page)).includes("CF AI Test reply"),
				(await lastAssistantText(page)).slice(0, 80),
				`"CF AI Test reply"`,
			);
		}
	});

	await group("AI-18", async () => {
		await startWatch(page);
		await say(page, "LONG reply please", false);
		await sleep(500);
		const pin = await page.eval<number>(`(() => {
			const row = ${A}.userRows().slice(-1)[0]; const sc = ${A}.scroller();
			return Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top);
		})()`);
		ok(
			"AI-18",
			"the new user row is pinned 40 to 80px below the scroller's top",
			pin >= 40 && pin <= 80,
			pin,
			"40..80",
		);
		await waitIdle(page);
		const seen = await stopWatch(page);
		const streaming = seen.scroll.filter(([t, , live]) => live && t > 700).map(([, top]) => top);
		const drift = streaming.length ? Math.max(...streaming) - Math.min(...streaming) : -1;
		ok(
			"AI-18",
			"the list does not follow the stream: scrollTop moves at most 2px while it runs",
			streaming.length > 5 && drift <= 2,
			{ samples: streaming.length, drift },
			"drift <= 2 over more than 5 samples",
		);
		ok(
			"AI-18",
			"the scroll-to-bottom button appeared once content ran below the fold",
			seen.scrollBtn,
			seen.scrollBtn,
			"true",
		);
		const button = await page.eval<{ visible: boolean; gap: number }>(`(() => {
			const sc = ${A}.scroller(); const b = document.querySelector('#cf-ai-panel .cf-ai-scroll-bottom');
			return { visible: !!b && !b.hidden && b.getClientRects().length > 0, gap: sc.scrollHeight - sc.scrollTop - sc.clientHeight };
		})()`);
		ok(
			"AI-18",
			"after the stream the button is shown with content below",
			button.visible && button.gap > 60,
			button,
			"visible, gap > 60",
		);
		await click(
			page,
			`document.querySelector('#cf-ai-panel .cf-ai-scroll-bottom cds-aichat-button') || document.querySelector('#cf-ai-panel .cf-ai-scroll-bottom')`,
			false,
		);
		// Smooth scrolling across thousands of pixels takes a while: judge the resting position, and keep the
		// trace so a failure shows whether the list stopped short or the content grew under it.
		const trace: Array<[top: number, height: number, spacer: number]> = [];
		for (let steady = 0, i = 0; i < 80 && steady < 4; i++) {
			const now = await page.eval<[number, number, number]>(
				`[${A}.scroller().scrollTop, ${A}.scroller().scrollHeight, document.querySelector('#cf-ai-panel .cf-ai-spacer').offsetHeight]`,
			);
			const prev = trace[trace.length - 1];
			steady = prev !== undefined && prev.every((v, k) => v === now[k]) ? steady + 1 : 0;
			trace.push(now);
			await sleep(150);
		}
		const bottom = await page.eval<{ gap: number; visible: boolean }>(`(() => {
			const sc = ${A}.scroller(); const b = document.querySelector('#cf-ai-panel .cf-ai-scroll-bottom');
			return { gap: sc.scrollHeight - sc.scrollTop - sc.clientHeight, visible: !!b && !b.hidden && b.getClientRects().length > 0 };
		})()`);
		ok(
			"AI-18",
			"clicking it reaches the bottom and hides it",
			bottom.gap < 2 && !bottom.visible,
			{ ...bottom, trace: trace.filter((_t, k) => k < 4 || k === trace.length - 1) },
			"gap < 2, hidden",
		);

		await say(page, "LONG again", false);
		await page.waitFor(
			`(() => { const sc = ${A}.scroller(); return sc.scrollHeight - sc.clientHeight - sc.scrollTop > 200 && !${A}.idle(); })()`,
			{ timeout: 30000, interval: 50 },
		);
		const before = await page.eval<number>(`${A}.scroller().scrollTop`);
		const centre = await page.eval<Box>(`${A}.center(${A}.scroller(), false)`);
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: Math.round(centre.x),
			y: Math.round(centre.y),
			deltaX: 0,
			deltaY: -200,
		});
		await sleep(250);
		const away = await page.eval<number>(`${A}.scroller().scrollTop`);
		await waitIdle(page);
		await sleep(500);
		const end = await page.eval<number>(`${A}.scroller().scrollTop`);
		ok(
			"AI-18",
			"scrolling up mid-stream sticks: after the stream scrollTop has not jumped back to the pin",
			away < before - 100 && Math.abs(end - away) <= 4,
			{ pin: before, away, end },
			"away < pin - 100 and |end - away| <= 4",
		);
	});

	await group("AI-19", async () => {
		await focusInput(page);
		const active = (): Promise<{ row: number; input: boolean; total: number }> =>
			page.eval(
				`(() => { const rows = ${A}.rows(); return { row: rows.indexOf(document.activeElement), input: ${A}.deepActive() === ${A}.textarea(), total: rows.length }; })()`,
			);
		await press(page, "ArrowUp");
		let at = await active();
		ok(
			"AI-19",
			"ArrowUp in the empty prompt line focuses the last row",
			at.row === at.total - 1 && at.total > 2,
			at,
			"row index = total - 1",
		);
		await press(page, "ArrowUp");
		const up = await active();
		ok(
			"AI-19",
			"ArrowUp moves to the previous row",
			up.row === at.total - 2,
			up,
			`row index ${at.total - 2}`,
		);
		await press(page, "ArrowDown");
		at = await active();
		ok("AI-19", "ArrowDown moves to the next row", at.row === at.total - 1, at, `row index ${at.total - 1}`);
		await press(page, "ArrowDown");
		at = await active();
		ok("AI-19", "ArrowDown on the last row returns to the prompt line", at.input, at, "prompt line focused");
		await press(page, "ArrowUp");
		await press(page, "Escape");
		const stillOpen = await flag(page, `${A}.isOpen()`);
		at = await active();
		ok(
			"AI-19",
			"Escape on a row returns to the prompt line and keeps the panel open",
			at.input && stillOpen,
			{ ...at, open: stillOpen },
			"prompt focused, panel open",
		);
		await press(page, "Escape");
		await sleep(300);
		ok(
			"AI-19",
			"a second Escape closes the panel",
			!(await flag(page, `${A}.isOpen()`)),
			await flag(page, `${A}.isOpen()`),
			"closed",
		);
		await openPanel(page);
	});

	await group("AI-20", async () => {
		const original = await page.eval<string | null>(`document.documentElement.getAttribute('data-theme')`);
		if (!(await flag(page, `!!${A}.shell().querySelector('cds-aichat-code-snippet')`)))
			await say(page, "hello");
		const measure = async (theme: string) => {
			await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
			await sleep(500);
			return page.eval<{
				shell: string;
				surface: boolean;
				tokens: string[];
				snippet: string;
				root: string;
				bubble: string;
			}>(`(() => {
				const shell = ${A}.shell(); const snippet = shell.querySelector('cds-aichat-code-snippet');
				const want = ${A}.probe('--cds-chat-shell-background');
				const surfaces = [shell, ...${A}.deepAll(shell, '*')].map((el) => getComputedStyle(el).backgroundColor);
				const rootStyle = getComputedStyle(document.documentElement);
				return { shell: want, surface: surfaces.includes(want),
					tokens: ['--cds-chat-shell-background', '--cds-chat-bubble-user', '--cds-chat-header-background'].filter((t) => !rootStyle.getPropertyValue(t).trim()),
					snippet: snippet ? getComputedStyle(snippet).getPropertyValue('--cds-syntax-keyword').trim() : '<no snippet>',
					root: rootStyle.getPropertyValue('--cds-syntax-keyword').trim(), bubble: ${A}.probe('--cds-chat-bubble-user') };
			})()`);
		};
		const light = await measure("light");
		await page.eval(
			`(() => { const s = ${A}.shell().querySelector('cds-aichat-code-snippet'); if (s) s.scrollIntoView({ block: 'center' }); })()`,
		);
		await sleep(200);
		await page.screenshot(`${SHOT}/assistant-light.png`);
		const dark = await measure("dark");
		await page.screenshot(`${SHOT}/assistant-dark.png`);
		for (const [name, m] of [
			["light", light],
			["dark", dark],
		] as const) {
			ok(
				"AI-20",
				`${name}: --cds-chat-* tokens resolve and the shell paints --cds-chat-shell-background`,
				m.surface && m.tokens.length === 0,
				{ shell: m.shell, surface: m.surface, missing: m.tokens },
				`a shell surface equal to the token, no missing token`,
			);
			ok(
				"AI-20",
				`${name}: the code snippet's syntax colour is the page's`,
				m.snippet !== "" && m.snippet === m.root,
				{ snippet: m.snippet, page: m.root },
				"equal and non-empty",
			);
		}
		ok(
			"AI-20",
			"the two themes really differ (syntax keyword and shell background)",
			light.root !== dark.root && light.shell !== dark.shell,
			{ syntax: [light.root, dark.root], shell: [light.shell, dark.shell] },
			"different values",
		);
		if (original === null) await page.eval(`document.documentElement.removeAttribute('data-theme')`);
		else await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(original)})`);
	});

	await group("AI-21", async () => {
		await click(page, `${A}.action('New chat')`);
		await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
		await say(page, "hello");
		const sessions = await sessionCount(page);
		const session = await sessionName(page);
		const rows = await page.eval<unknown>(`${A}.texts()`);
		await freshPage(page, "/desk/todo", true);
		await page.waitFor(`${A}.isOpen()`, { timeout: 15000 });
		await page.waitFor(`${A}.rows().length > 0`, { timeout: 30000 });
		await sleep(500);
		const restored = await page.eval<unknown>(`${A}.texts()`);
		ok(
			"AI-21",
			"after a reload the same rows with the same text are back",
			JSON.stringify(restored) === JSON.stringify(rows),
			{ before: rows, after: restored },
			"equal",
		);
		ok(
			"AI-21",
			"cf-ai-session still names the session",
			session !== "" && (await sessionName(page)) === session,
			await sessionName(page),
			session,
		);
		await waitMounted(page).catch(() => {});
		await say(page, "hello");
		ok(
			"AI-21",
			"sending continues the same session",
			(await sessionCount(page)) === sessions && (await sessionName(page)) === session,
			{ sessions: await sessionCount(page), before: sessions },
			`${sessions} sessions`,
		);
	});

	await group("AI-22", async () => {
		const previous = await sessionName(page);
		const sessions = await sessionCount(page);
		await startWatch(page);
		await click(page, `${A}.action('New chat')`);
		await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
		await sleep(600);
		const seen = await stopWatch(page);
		const state = await page.eval<{ home: boolean; session: string | null }>(`({
			home: ${A}.visible(document.querySelector('#cf-ai-panel .cf-ai-home')), session: localStorage.getItem('cf-ai-session'),
		})`);
		ok(
			"AI-22",
			"New chat empties the list, shows home and clears the session",
			state.home && state.session === "",
			state,
			`home visible, cf-ai-session ""`,
		);
		ok(
			"AI-22",
			"the live region said New conversation started",
			seen.announced.some((a) => a.includes("New conversation started")),
			seen.announced,
			`"New conversation started"`,
		);
		await say(page, "hello");
		const next = await sessionName(page);
		ok(
			"AI-22",
			"the next turn creates a different session",
			next !== "" && next !== previous && (await sessionCount(page)) === sessions + 1,
			{ previous, next },
			"a new Flow Session",
		);
	});

	await group("AI-24", async () => {
		const live = await page.eval<{
			aside: boolean;
			name: string | null;
			polite: number;
			assertive: number;
			list: string | null;
			badRows: number;
			heading: string | null;
			unnamed: string[];
		}>(`(() => {
			const h = document.getElementById('cf-ai-panel'); const list = h.querySelector('.cf-ai-list');
			const heading = h.querySelector('.cf-ai-message--user [role="heading"]');
			return { aside: h.tagName === 'ASIDE', name: h.getAttribute('aria-label'),
				polite: h.querySelectorAll('.cf-ai-announcer [aria-live="polite"]').length, assertive: h.querySelectorAll('.cf-ai-announcer [aria-live="assertive"]').length,
				list: list && list.getAttribute('role'), badRows: [...h.querySelectorAll('.cf-ai-message')].filter((r) => r.getAttribute('role') !== 'listitem').length,
				heading: heading && heading.getAttribute('aria-level'), unnamed: ${A}.unnamed(h) };
		})()`);
		ok(
			"AI-24",
			"the host is an aside with a name",
			live.aside && !!live.name,
			{ aside: live.aside, name: live.name },
			"ASIDE with aria-label",
		);
		ok(
			"AI-24",
			"three polite and two assertive live regions",
			live.polite === 3 && live.assertive === 2,
			{ polite: live.polite, assertive: live.assertive },
			"3 polite, 2 assertive",
		);
		ok(
			"AI-24",
			"the list is a list of listitems and user text is a level 2 heading",
			live.list === "list" && live.badRows === 0 && live.heading === "2",
			{ list: live.list, badRows: live.badRows, heading: live.heading },
			`role list, 0 rows without listitem, heading level "2"`,
		);
		ok(
			"AI-24",
			"every button in the open panel has an accessible name",
			live.unnamed.length === 0,
			live.unnamed,
			"[]",
		);
		await closePanelWithTrigger(page);
		await sleep(400);
		const stops = await page.eval<string[]>(`${A}.tabStops(document.getElementById('cf-ai-panel'))`);
		ok("AI-24", "a closed host holds no tab stop", stops.length === 0, stops, "[]");
		await openPanel(page);
	});

	await group("AI-26", async () => {
		for (const [width, height] of [
			[360, 800],
			[1280, 900],
		] as const) {
			await viewport(page, width, height);
			const fit = await page.eval<{ host: number; overflow: boolean; inside: boolean }>(`(() => {
				const h = document.getElementById('cf-ai-panel').getBoundingClientRect();
				const sc = ${A}.scroller().scrollWidth > ${A}.scroller().clientWidth + 1;
				const p = document.querySelector('#cf-ai-panel cds-aichat-prompt-line-shell').getBoundingClientRect();
				return { host: Math.round(h.width), overflow: sc, inside: p.left >= h.left - 1 && p.right <= h.right + 1 };
			})()`);
			ok(
				"AI-26",
				`at ${width}px the panel is 360 wide, nothing overflows and the input stays inside`,
				fit.host === 360 && !fit.overflow && fit.inside,
				fit,
				`host 360, no overflow, input inside`,
			);
			await page.screenshot(`${SHOT}/assistant-${width}.png`);
		}
		await viewport(page, 1600, 1000);
	});

	await group("AI-26b", async () => {
		// With the panel closed the header's own cells decide the fit; the name must be the item that
		// shrinks, or the AI trigger and the switcher are pushed past the right edge and unreachable.
		await closePanelWithTrigger(page);
		for (const width of [320, 360, 480]) {
			await viewport(page, width, 800);
			const cells = await page.eval<{
				viewport: number;
				trigger: { left: number; right: number } | null;
				switcher: { left: number; right: number } | null;
				scroll: number;
				client: number;
			}>(`(() => {
				const edge = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) }; };
				const header = document.querySelector('.cf-shell-header');
				return { viewport: innerWidth, trigger: edge(document.getElementById('cf-ai-trigger')),
					switcher: edge(document.getElementById('cf-switcher-button')),
					scroll: header.scrollWidth, client: header.clientWidth };
			})()`);
			const inside = (c: { left: number; right: number } | null): boolean =>
				c !== null && c.left >= 0 && c.right <= cells.viewport;
			ok(
				"AI-26b",
				`at ${width}px the AI trigger and the switcher sit inside the viewport and the header does not overflow`,
				inside(cells.trigger) && inside(cells.switcher) && cells.scroll <= cells.client,
				cells,
				`0 <= left and right <= ${width} for both cells, header scrollWidth <= clientWidth`,
			);
		}
		await viewport(page, 1600, 1000);
		await openPanel(page);
	});

	await group("AI-27", async () => {
		await click(page, `${A}.action('New chat')`);
		await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
		await page.waitFor(`document.querySelectorAll('#cf-ai-panel .cf-ai-starter').length === 4`, {
			timeout: 15000,
		});
		const motion = (): Promise<{ host: string; starter: string }> =>
			page.eval(`({
				host: getComputedStyle(document.getElementById('cf-ai-panel')).transitionDuration,
				starter: getComputedStyle(document.querySelector('#cf-ai-panel .cf-ai-starter').parentElement).animationName,
			})`);
		const allZero = (d: string): boolean => d.split(",").every((p) => parseFloat(p) === 0);
		await page.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await sleep(200);
		const reduced = await motion();
		await page.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
		});
		await sleep(200);
		const full = await motion();
		await page.send("Emulation.setEmulatedMedia", { features: [] });
		ok(
			"AI-27",
			"with reduced motion the slide transition and the starter animation are off",
			allZero(reduced.host) && reduced.starter === "none",
			reduced,
			`transition-duration 0s, animation-name none`,
		);
		ok(
			"AI-27",
			"without it they are on (so the reduced result is not vacuous)",
			!allZero(full.host) && full.starter !== "none",
			full,
			`a non-zero transition and a named animation`,
		);
	});

	await group("AI-21b", async () => {
		// localStorage outlives a logout, so a pointer recorded for another user must not resume here
		await page.eval(`(localStorage.setItem('cf-ai-session-user', 'cf-ai-test-other@example.com'), true)`);
		await freshPage(page, "/desk/todo", true);
		const pointer = await page.eval<{ session: string | null; owner: string | null; user: string }>(`({
			session: localStorage.getItem('cf-ai-session'), owner: localStorage.getItem('cf-ai-session-user'),
			user: frappe.session.user,
		})`);
		ok(
			"AI-21b",
			"a session pointer left by another user is dropped and the current user recorded",
			pointer.session === "" && pointer.owner === pointer.user,
			pointer,
			`cf-ai-session "", cf-ai-session-user = the signed-in user`,
		);
	});

	// -- conversation history, feedback, timestamps, windowing and the first release's polish ----------------
	//
	// The order matters: the read-only cases of the list come before rename and delete, and every case
	// that needs a conversation on screen selects it through the list itself, so the list is exercised
	// as much as the behaviour it is there for.

	const userName = await page.eval<string>(`frappe.session.user`);

	/** The REST fixtures, then the conversations made through the UI. Ends with gamma's chat open. */
	const buildHistoryFixtures = async (): Promise<void> => {
		const insert = async (body: Record<string, unknown>): Promise<string> => {
			const reply = await api(page, "POST", resource("Flow Session"), body);
			const name = str(dig(reply.json, "data", "name"));
			if (reply.status >= 300 || name === undefined) {
				throw new Error(
					`creating Flow Session "${show(body["title"])}" failed: ${reply.status} ${show(dig(reply.json, "exception") ?? reply.json)}`,
				);
			}
			return name;
		};
		// REST first, so every chat made through the UI afterwards is newer than these two.
		const rows: Array<Record<string, unknown>> = [];
		for (let i = 1; i <= 100; i++) {
			rows.push({ role: "user", content: `CF AI Test long message ${i}` });
			rows.push({ role: "assistant", content: `CF AI Test long reply ${i}` });
		}
		fixtures.long = await insert({ title: TITLES.long, agent: AGENT, messages: rows });
		fixtures.trigger = await insert({ title: TITLES.trigger, agent: AGENT, source: "Trigger" });
		const triggerDoc = await api(page, "GET", resource("Flow Session", fixtures.trigger));
		const long = await api(page, "GET", resource("Flow Session", fixtures.long));
		const longRows = dig(long.json, "data", "messages");
		ok(
			"AI-28",
			"the REST fixtures are what the cases need: a Trigger session and a session of 200 messages",
			dig(triggerDoc.json, "data", "source") === "Trigger" &&
				Array.isArray(longRows) &&
				longRows.length === 200,
			{
				source: dig(triggerDoc.json, "data", "source"),
				messages: Array.isArray(longRows) ? longRows.length : null,
			},
			`source "Trigger", 200 messages`,
		);

		await startCase(page);
		await page.eval(`(localStorage.setItem('cf-ai-agent', ${q(AGENT)}), true)`);
		const approvalMark = netMark();
		await chatInNewConversation(page, "TOOL CREATE 7101", false);
		await page.waitFor(`!!${A}.card()`, { timeout: 60000 });
		await waitIdle(page);
		fixtures.approval = await sessionName(page);
		const started = posts(approvalMark, "flow\\.api\\.(api\\.)?start_run")[0];
		ok(
			"AI-28",
			"a new chat started under the cf-ai-agent override asks flow for that agent",
			dig(started, "agent") === AGENT,
			dig(started, "agent"),
			AGENT,
		);
		for (const key of ["alpha", "beta", "gamma"] as const) {
			fixtures[key] = await chatInNewConversation(page, TITLES[key]);
			snapshots[key] = await rowTexts(page);
		}
		const derived: string[] = [];
		for (const key of ["approval", "alpha", "beta", "gamma"] as const) {
			const named = await sessionNamed(page, TITLES[key]).catch((e: unknown) =>
				e instanceof Error ? e.message : String(e),
			);
			if (named !== fixture(key)) derived.push(`${key}: ${named}`);
		}
		const agentOf = await api(page, "GET", resource("Flow Session", fixture("alpha")));
		ok(
			"AI-28",
			"every chat made through the UI is its own Flow Session, titled from its first message, owned by the test agent",
			derived.length === 0 &&
				new Set([fixtures.approval, fixtures.alpha, fixtures.beta, fixtures.gamma]).size === 4 &&
				dig(agentOf.json, "data", "agent") === AGENT,
			derived,
			"four sessions whose titles are their first messages",
		);
	};

	await group("AI-28", async () => {
		await buildHistoryFixtures();
	});

	await group("AI-28", async () => {
		await startCase(page);
		const before = await page.eval<{ exists: boolean; pressed: string | null; shown: boolean }>(`({
			exists: !!${A}.histAction(), pressed: ${A}.pressed(${A}.histAction()), shown: ${A}.histShown(),
		})`);
		ok(
			"AI-28",
			"the header has a Conversation history action, not pressed, with the list closed",
			before.exists && before.pressed === "false" && !before.shown,
			before,
			`exists, aria-pressed "false", list hidden`,
		);
		await click(page, `${A}.histAction()`);
		await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
		await historySettled(page);
		await sleep(300);
		const open = await page.eval<{
			role: string | null;
			label: string | null;
			pressed: string | null;
			edges: number[];
			promptBelow: boolean;
			homeInert: boolean;
			listInert: boolean;
			searchFocus: boolean;
		}>(`(() => {
			const h = ${A}.hist(); const body = document.querySelector('#cf-ai-panel .cf-ai-body');
			const b = body.getBoundingClientRect(); const r = h.getBoundingClientRect();
			const promptShell = document.querySelector('#cf-ai-panel cds-aichat-prompt-line-shell');
			const prompt = promptShell.getBoundingClientRect(); const active = ${A}.deepActive();
			return {
				role: h.getAttribute('role'), label: h.getAttribute('aria-label'), pressed: ${A}.pressed(${A}.histAction()),
				edges: [r.top - b.top, r.left - b.left, r.right - b.right, r.bottom - b.bottom].map((v) => Math.round(v)),
				promptBelow: ${A}.visible(promptShell) && prompt.height > 0 && prompt.top >= r.bottom - 1,
				homeInert: document.querySelector('#cf-ai-panel .cf-ai-home').inert === true,
				listInert: document.querySelector('#cf-ai-panel .cf-ai-messages').inert === true,
				searchFocus: !!active && active.tagName === 'INPUT' && ${A}.contains(${A}.toolbar(), active),
			};
		})()`);
		ok(
			"AI-28",
			"opening shows the list as a named region exactly over the message area",
			open.role === "region" &&
				open.label === "Conversation history" &&
				open.edges.every((edge) => Math.abs(edge) <= 1),
			{ role: open.role, label: open.label, edgesVsBody: open.edges },
			`role "region", aria-label "Conversation history", edges equal to .cf-ai-body`,
		);
		ok(
			"AI-28",
			"the action is pressed, the prompt line stays visible below the list, the home and message list are inert, focus is in the search field",
			open.pressed === "true" && open.promptBelow && open.homeInert && open.listInert && open.searchFocus,
			open,
			`pressed "true", prompt below, both inert, focus in the toolbar's input`,
		);

		await click(page, `${A}.histAction()`);
		await page.waitFor(`!${A}.histShown()`, { timeout: 5000 });
		await sleep(300);
		const byToggle = await page.eval<{ focus: boolean; open: boolean; pressed: string | null }>(`({
			focus: ${focusIn(`${A}.histAction()`)}, open: ${A}.isOpen(), pressed: ${A}.pressed(${A}.histAction()),
		})`);
		ok(
			"AI-28",
			"the action closes it again with focus on the action and the panel open",
			byToggle.focus && byToggle.open && byToggle.pressed === "false",
			byToggle,
			"focus on the action, panel open, pressed false",
		);

		await openHistory(page);
		await click(page, `${A}.backButton()`);
		await page.waitFor(`!${A}.histShown()`, { timeout: 5000 });
		await sleep(300);
		const byBack = await page.eval<{ focus: boolean; open: boolean }>(
			`({ focus: ${focusIn(`${A}.histAction()`)}, open: ${A}.isOpen() })`,
		);
		ok(
			"AI-28",
			"the back button closes it with focus on the action and the panel open",
			byBack.focus && byBack.open,
			byBack,
			"focus on the action, panel open",
		);

		await openHistory(page);
		await press(page, "Escape");
		await sleep(300);
		const byEscape = await page.eval<{ shown: boolean; focus: boolean; open: boolean }>(`({
			shown: ${A}.histShown(), focus: ${focusIn(`${A}.histAction()`)}, open: ${A}.isOpen(),
		})`);
		ok(
			"AI-28",
			"Escape in the search field closes the list, not the panel, and puts focus on the action",
			!byEscape.shown && byEscape.focus && byEscape.open,
			byEscape,
			"list closed, focus on the action, panel still open",
		);
		await press(page, "Escape");
		await sleep(400);
		ok(
			"AI-28",
			"a second Escape closes the panel",
			!(await flag(page, `${A}.isOpen()`)),
			undefined,
			"closed",
		);
		await startCase(page);
	});

	await group("AI-29", async () => {
		await startCase(page);
		const mark = netMark();
		await openHistory(page);
		const gamma = fixture("gamma");
		await waitItem(page, gamma);
		await sleep(300);
		const requests = sessionListCalls(mark);
		const first = requests[0];
		const filters = dig(first, "filters");
		ok(
			"AI-29",
			"the list asks for the signed-in user's sessions that are not Trigger, newest first",
			requests.length >= 1 &&
				dig(filters, "owner") === userName &&
				JSON.stringify(dig(filters, "source")) === JSON.stringify(["!=", "Trigger"]) &&
				dig(first, "order_by") === "modified desc",
			{ requests: requests.length, filters, order_by: dig(first, "order_by") },
			`filters.owner "${userName}", filters.source ["!=","Trigger"], order_by "modified desc"`,
		);
		const shown = await page.eval<{
			names: string[];
			sessions: string[];
			menus: string[];
			selected: Array<string | null>;
			triggers: boolean[];
		}>(`(() => {
			const items = ${A}.items();
			return {
				names: ${A}.names(), sessions: ${A}.sessions(), menus: ${A}.menus(),
				selected: items.filter((i) => i.selected === true).map((i) => i.getAttribute('data-session')),
				triggers: items.slice(0, 6).map((i) => { const t = ${A}.itemTrigger(i); return !!t && ${A}.visible(t) && t.getBoundingClientRect().width > 0; }),
			};
		})()`);
		const oracle = (
			await list(
				page,
				"Flow Session",
				[
					["owner", "=", userName],
					["source", "!=", "Trigger"],
				],
				["name", "owner"],
				"modified desc",
			)
		)
			.slice(0, 100)
			.map((s) => str(s["name"]));
		ok(
			"AI-29",
			"the rows are the server's list in its order: newest first, no Trigger session",
			JSON.stringify(shown.sessions) === JSON.stringify(oracle) &&
				!shown.sessions.includes(fixture("trigger")),
			{ shown: shown.sessions.slice(0, 6), server: oracle.slice(0, 6) },
			"the same session names in the same order",
		);
		const at = (key: FixtureKey): number => shown.sessions.indexOf(fixture(key));
		ok(
			"AI-29",
			"gamma is above beta, above alpha, above the unanswered approval",
			at("gamma") >= 0 &&
				at("gamma") < at("beta") &&
				at("beta") < at("alpha") &&
				at("alpha") < at("approval"),
			{ gamma: at("gamma"), beta: at("beta"), alpha: at("alpha"), approval: at("approval") },
			"strictly increasing indexes",
		);
		const titles = await page.eval<Record<string, string | null>>(`(() => {
			const out = {};
			for (const s of ${JSON.stringify([fixtures.alpha, fixtures.beta, fixtures.gamma, fixtures.approval])}) { const i = ${A}.itemOf(s); out[s] = i ? i.name : null; }
			return out;
		})()`);
		ok(
			"AI-29",
			"each row's name is its derived title",
			titles[fixture("alpha")] === TITLES.alpha &&
				titles[fixture("beta")] === TITLES.beta &&
				titles[fixture("gamma")] === TITLES.gamma &&
				titles[fixture("approval")] === TITLES.approval,
			titles,
			"the four titles",
		);
		const owners = await list(page, "Flow Session", [["name", "in", shown.sessions]], ["name", "owner"]);
		ok(
			"AI-29",
			"every listed session belongs to the signed-in user",
			owners.length === shown.sessions.length && owners.every((s) => s["owner"] === userName),
			owners.filter((s) => s["owner"] !== userName),
			"[]",
		);
		ok(
			"AI-29",
			"the sessions made today share one group menu titled Today, first in the list",
			shown.menus[0] === "Today" && shown.menus.filter((title) => title === "Today").length === 1,
			shown.menus,
			`["Today", ...]`,
		);
		ok(
			"AI-29",
			"the open conversation's row is the only selected one",
			shown.selected.length === 1 && shown.selected[0] === gamma,
			shown.selected,
			`[${gamma}]`,
		);
		ok(
			"AI-29",
			"every row shows its overflow trigger without hovering",
			shown.triggers.length > 0 && shown.triggers.every(Boolean),
			shown.triggers,
			"all true",
		);
		await closeHistory(page);
	});

	await group("AI-30", async () => {
		await startCase(page);
		await openHistory(page);
		const typeSearch = async (text: string): Promise<void> => {
			await page.eval(`(() => { const i = ${A}.searchInput(); i.focus(); i.select(); return true; })()`);
			await insertText(page, text);
			await sleep(350);
		};
		const mark = netMark();
		await typeSearch("alpha");
		const hit = await page.eval<{ names: string[]; menus: string[]; count: string }>(`({
			names: ${A}.names(), menus: ${A}.menus(), count: ${A}.deepText(${A}.content()),
		})`);
		ok(
			"AI-30",
			"typing alpha leaves only alpha under a Search results menu, with a polite count",
			JSON.stringify(hit.names) === JSON.stringify([TITLES.alpha]) &&
				JSON.stringify(hit.menus) === JSON.stringify(["Search results"]) &&
				hit.count.includes("Results: 1"),
			{ names: hit.names, menus: hit.menus, count: hit.count.slice(0, 60) },
			`[${TITLES.alpha}], ["Search results"], "Results: 1"`,
		);
		await typeSearch("zzz");
		const none = await page.eval<{ names: number; empty: string | null }>(`({
			names: ${A}.items().length, empty: ${A}.empty() ? ${A}.deepText(${A}.empty()) : null,
		})`);
		ok(
			"AI-30",
			"a query nothing matches shows No matching conversations",
			none.names === 0 && none.empty !== null && none.empty.includes("No matching conversations"),
			none,
			`0 rows, .cf-ai-history__empty "No matching conversations"`,
		);
		ok(
			"AI-30",
			"searching is client-side: no Flow Session list request while typing",
			sessionListCalls(mark).length === 0,
			sessionListCalls(mark).length,
			"0",
		);
		await click(page, `${A}.searchClear()`);
		await sleep(350);
		const cleared = await page.eval<{ names: number; menus: string[]; value: string }>(`({
			names: ${A}.items().length, menus: ${A}.menus(), value: ${A}.searchInput().value,
		})`);
		ok(
			"AI-30",
			"clearing the search restores the grouped list",
			cleared.value === "" && cleared.names > 3 && cleared.menus[0] === "Today",
			cleared,
			`empty field, the full list, first menu "Today"`,
		);
		await closeHistory(page);
	});

	await group("AI-31", async () => {
		await startCase(page);
		const beta = fixture("beta");
		const mark = netMark();
		await chooseSession(page, beta);
		const state = await page.eval<{ focus: boolean; session: string | null; disabled: boolean }>(`({
			focus: ${A}.deepActive() === ${A}.textarea(), session: localStorage.getItem('cf-ai-session'),
			disabled: ${A}.prompt().disabled,
		})`);
		const rows = await rowTexts(page);
		ok(
			"AI-31",
			"selecting beta closes the list, focuses the prompt line and records the session",
			state.focus && state.session === beta && !state.disabled,
			state,
			`focus in the prompt, cf-ai-session ${beta}, prompt enabled`,
		);
		ok(
			"AI-31",
			"the rows are beta's, with the same text as when they were typed",
			JSON.stringify(rows) === JSON.stringify(snapshots.beta),
			{ now: rows, typed: snapshots.beta },
			"equal",
		);
		const recovered = posts(mark, "flow\\.api\\.(api\\.)?recover_session").length;
		const fetched = posts(mark, "frappe\\.client\\.get").some(
			(b) => dig(b, "doctype") === "Flow Session" && dig(b, "name") === beta,
		);
		const runsFetched = posts(mark, "frappe\\.client\\.get_list").some(
			(b) => dig(b, "doctype") === "Flow Run" && dig(b, "filters", "session") === beta,
		);
		ok(
			"AI-31",
			"switching reads the session and lists its runs, and never recovers it",
			fetched && runsFetched && recovered === 0,
			{ recovered, fetched, runsFetched },
			"both reads, 0 recover_session requests",
		);
		await openHistory(page);
		const marks = await page.eval<Array<string | null>>(
			`${A}.items().filter((i) => i.selected === true).map((i) => i.getAttribute('data-session'))`,
		);
		ok(
			"AI-31",
			"reopening marks beta as the open conversation",
			marks.length === 1 && marks[0] === beta,
			marks,
			`[${beta}]`,
		);
		await closeHistory(page);

		const approval = fixture("approval");
		await chooseSession(page, approval);
		const card = await page.eval<{
			unlocked: boolean;
			approve: boolean;
			deny: boolean;
			steps: number;
			rows: number;
		}>(`(() => {
			const c = ${A}.card(); const row = ${A}.lastAssistant();
			return { unlocked: !!c, approve: !!c && ${A}.visible(c.querySelector('[data-action="approve"]')),
				deny: !!c && ${A}.visible(c.querySelector('[data-action="deny"]')),
				steps: row ? ${A}.deepAll(row, 'cds-aichat-chain-of-thought-step').length : 0, rows: ${A}.assistantRows().length };
		})()`);
		ok(
			"AI-31",
			"the session left on an approval comes back with its card unlocked and its steps",
			card.unlocked && card.approve && card.deny && card.steps >= 1,
			card,
			"an unlocked card with both buttons and at least one step",
		);
		await click(page, `${A}.cardButton('approve')`);
		await sleep(200);
		await waitIdle(page);
		const resumed = await page.eval<{ rows: number; text: string; locked: boolean }>(`(() => {
			const row = ${A}.lastAssistant(); const c = row.querySelector('.cf-ai-approval');
			return { rows: ${A}.assistantRows().length, text: ${A}.deepText(row), locked: !!c && c.classList.contains('cf-ai-approval--locked') };
		})()`);
		const todos = await todosNamed(page, "CF AI Test 7101");
		ok(
			"AI-31",
			"approving the restored card creates the ToDo and continues the same reply",
			todos.length === 1 &&
				resumed.rows === card.rows &&
				resumed.locked &&
				resumed.text.includes("Created CF AI Test 7101."),
			{
				todos: todos.length,
				rowsBefore: card.rows,
				rowsAfter: resumed.rows,
				locked: resumed.locked,
				tail: resumed.text.slice(-80),
			},
			"one ToDo, the same row count, a locked card, the closing text",
		);
	});

	await group("AI-32", async () => {
		await startCase(page);
		const alpha = fixture("alpha");
		const beta = fixture("beta");
		await chooseSession(page, fixture("gamma"));
		await openHistory(page);
		await waitItem(page, alpha);
		await waitItem(page, beta);
		const release = await intercept(page, ["*/api/method/frappe.client.get"], (r) =>
			r.body?.["name"] === alpha ? { kind: "pass", delayMs: 1500 } : { kind: "pass" },
		);
		try {
			await startWatch(page, true);
			const began = Date.now();
			await click(page, `${A}.itemButton(${A}.itemOf(${q(alpha)}))`, true, 0.3);
			await sleep(150);
			// the second choice by keyboard: while a switch loads the body dims, and a dimmed body takes no pointer
			await page.eval(`(${A}.itemButton(${A}.itemOf(${q(beta)})).focus(), true)`);
			await press(page, "Enter");
			await page.waitFor(`!${A}.histShown() && localStorage.getItem('cf-ai-session') === ${q(beta)}`, {
				timeout: 20000,
			});
			// alpha's answer is due 1500 ms after its request; look again after it must have arrived
			await until(() => Date.now() - began > 2100, 4000);
			await sleep(400);
			const seen = await stopWatch(page);
			const end = await page.eval<{
				session: string | null;
				shown: boolean;
				focus: boolean;
				disabled: boolean;
			}>(`({
				session: localStorage.getItem('cf-ai-session'), shown: ${A}.histShown(),
				focus: ${A}.deepActive() === ${A}.textarea(), disabled: ${A}.prompt().disabled,
			})`);
			const rows = await rowTexts(page);
			ok(
				"AI-32",
				"two quick choices end on the second: its rows, its session, the list closed, focus in the prompt",
				JSON.stringify(rows) === JSON.stringify(snapshots.beta) &&
					end.session === beta &&
					!end.shown &&
					end.focus &&
					!end.disabled,
				{ ...end, rows },
				"beta's rows, cf-ai-session beta, list closed, prompt focused and enabled",
			);
			ok(
				"AI-32",
				"the first choice's conversation was never on screen, even after its late answer",
				!seen.rowTexts.some((text) => text.includes("history alpha")),
				seen.rowTexts,
				`no user row containing "history alpha"`,
			);
		} finally {
			await release();
		}

		await tolerate(async () => {
			await chooseSession(page, alpha);
			await openHistory(page);
			await waitItem(page, beta);
			const before = await rowTexts(page);
			await page.eval(`${A}.clearAlerts()`);
			const failing = await intercept(page, ["*/api/method/frappe.client.get"], (r) =>
				r.body?.["name"] === beta ? { kind: "fail" } : { kind: "pass" },
			);
			try {
				await click(page, `${A}.itemButton(${A}.itemOf(${q(beta)}))`, true, 0.3);
				await page.waitFor(`${A}.alerts().length > 0`, { timeout: 10000 });
				await page.waitFor(`!${A}.prompt().disabled`, { timeout: 10000 });
			} finally {
				await failing();
			}
			const after = await page.eval<{ session: string | null; shown: boolean; disabled: boolean }>(`({
				session: localStorage.getItem('cf-ai-session'), shown: ${A}.histShown(), disabled: ${A}.prompt().disabled,
			})`);
			ok(
				"AI-32",
				"a switch whose read fails keeps the conversation, its session and an enabled prompt, tells the user and leaves the list open",
				JSON.stringify(await rowTexts(page)) === JSON.stringify(before) &&
					after.session === alpha &&
					after.shown &&
					!after.disabled,
				{ ...after, alerts: await alertTexts(page) },
				`alpha's rows, cf-ai-session ${alpha}, list open, prompt enabled, an alert`,
			);
			await closeHistory(page);
		});
	});

	await group("AI-33", async () => {
		await startCase(page);
		const alpha = fixture("alpha");
		const renamed = "CF AI Test renamed";
		const item = `${A}.itemOf(${q(alpha)})`;
		const field = `${A}.renameInput(${item})`;
		const startRename = async (): Promise<void> => {
			await openRowMenu(page, alpha);
			await pickMenuEntry(page, "Rename");
			await page.waitFor(`!!${field} && ${A}.deepActive() === ${field}`, { timeout: 5000 });
		};
		await openHistory(page);
		await waitItem(page, alpha);
		await openRowMenu(page, alpha);
		const menu = await page.eval<Array<{ text: string; hit: boolean }>>(
			`${A}.menuEntries().map((e) => ({ text: e.textContent.replace(/\\s+/g, ' ').trim(), hit: ${A}.isHit(e) }))`,
		);
		ok(
			"AI-33",
			"the row menu offers Rename and Delete, and nothing clips or covers them",
			menu.length === 2 &&
				menu[0]?.text.startsWith("Rename") === true &&
				menu[1]?.text.startsWith("Delete") === true &&
				menu.every((entry) => entry.hit),
			menu,
			"two entries, both the topmost element at their centre",
		);
		await pickMenuEntry(page, "Rename");
		await page.waitFor(`!!${field} && ${A}.deepActive() === ${field}`, { timeout: 5000 });
		const selected = await page.eval<{ start: number; end: number; length: number; value: string }>(`(() => {
			const i = ${field}; return { start: i.selectionStart, end: i.selectionEnd, length: i.value.length, value: i.value };
		})()`);
		ok(
			"AI-33",
			"Rename puts focus in a field holding the title, all selected",
			selected.value === TITLES.alpha && selected.start === 0 && selected.end === selected.length,
			selected,
			`the title, selection 0 to its length`,
		);
		await press(page, "Backspace");
		await sleep(250);
		const empty = await page.eval<{ invalid: boolean; message: string; saveOff: boolean }>(`({
			invalid: ${item}.renameInvalid === true, message: ${item}.renameInvalidMessage,
			saveOff: ${A}.renameSave(${item}).hasAttribute('disabled'),
		})`);
		ok(
			"AI-33",
			"an empty title says a title is required and cannot be saved",
			empty.invalid && empty.message === "A title is required." && empty.saveOff,
			empty,
			`invalid, "A title is required.", Save disabled`,
		);
		await page.eval(`(${field}.select(), true)`);
		await insertText(page, "x".repeat(201));
		await sleep(250);
		const tooLong = await page.eval<{ invalid: boolean; message: string; saveOff: boolean }>(`({
			invalid: ${item}.renameInvalid === true, message: ${item}.renameInvalidMessage,
			saveOff: ${A}.renameSave(${item}).hasAttribute('disabled'),
		})`);
		ok(
			"AI-33",
			"201 characters say the title cannot exceed 200 and cannot be saved",
			tooLong.invalid && tooLong.message === "Title cannot exceed 200 characters." && tooLong.saveOff,
			tooLong,
			`invalid, "Title cannot exceed 200 characters.", Save disabled`,
		);
		await page.eval(`(${field}.select(), true)`);
		await insertText(page, renamed);
		await sleep(200);
		await press(page, "Enter");
		await page.waitFor(`${item}.name === ${q(renamed)} && ${item}.rename !== true`, { timeout: 5000 });
		const stored = await eventually(
			async () =>
				str(dig((await api(page, "GET", resource("Flow Session", alpha))).json, "data", "title")) ?? "",
			(title) => title === renamed,
		);
		const after = await page.eval<{ focus: boolean; shown: boolean; open: boolean }>(`({
			focus: ${focusIn(item)}, shown: ${A}.histShown(), open: ${A}.isOpen(),
		})`);
		ok(
			"AI-33",
			"Enter saves: the row shows the new title, the Flow Session has it, focus is on the row",
			stored === renamed && after.focus && after.shown && after.open,
			{ stored, ...after },
			`title "${renamed}", focus on the row, list and panel open`,
		);

		await startRename();
		await insertText(page, "CF AI Test discarded");
		await press(page, "Escape");
		await sleep(300);
		const cancelled = await page.eval<{
			name: string;
			renaming: boolean;
			shown: boolean;
			open: boolean;
			focus: boolean;
		}>(`({
			name: ${item}.name, renaming: ${item}.rename === true, shown: ${A}.histShown(), open: ${A}.isOpen(),
			focus: ${focusIn(item)},
		})`);
		ok(
			"AI-33",
			"Escape cancels: the old title stays, the list and the panel stay open, focus is on the row",
			cancelled.name === renamed &&
				!cancelled.renaming &&
				cancelled.shown &&
				cancelled.open &&
				cancelled.focus,
			cancelled,
			`title "${renamed}", not renaming, list and panel open, focus on the row`,
		);

		await tolerate(async () => {
			await startRename();
			await page.eval(`${A}.clearAlerts()`);
			await page.send("Network.setBlockedURLs", { urls: ["*frappe.client.set_value*"] });
			try {
				await insertText(page, "CF AI Test refused");
				await press(page, "Enter");
				await page.waitFor(`${A}.alerts().length > 0`, { timeout: 10000 });
				await page.waitFor(`${item}.name === ${q(renamed)}`, { timeout: 5000 });
			} finally {
				await page.send("Network.setBlockedURLs", { urls: [] });
			}
			const doc = await api(page, "GET", resource("Flow Session", alpha));
			ok(
				"AI-33",
				"a refused rename puts the old title back and tells the user",
				dig(doc.json, "data", "title") === renamed,
				{ title: dig(doc.json, "data", "title"), alerts: await alertTexts(page) },
				`row and Flow Session still "${renamed}", an alert`,
			);
		});
		await api(page, "PUT", resource("Flow Session", alpha), { title: TITLES.alpha });
		await closeHistory(page);
	});

	await group("AI-34", async () => {
		await startCase(page);
		const spare = await chatInNewConversation(page, "CF AI Test delete cancel");
		const other = await chatInNewConversation(page, "CF AI Test delete other");
		const open = await chatInNewConversation(page, "CF AI Test delete open");
		const openRows = await rowTexts(page);
		await openHistory(page);
		await waitItem(page, spare);
		await waitItem(page, other);
		await waitItem(page, open);

		await startDelete(page, spare);
		const panelState = await page.eval<{ text: string; focus: boolean; behindInert: boolean }>(`({
			text: ${A}.deepText(${A}.delPanel()), focus: ${A}.contains(${A}.delButton('danger'), ${A}.deepActive()),
			behindInert: ${A}.items().length > 0 && ${A}.isInert(${A}.items()[0]),
		})`);
		ok(
			"AI-34",
			"Delete asks first: a panel with the question and the warning, focus on its Delete button, the list behind it inert",
			panelState.text.includes("Delete this conversation?") &&
				panelState.text.includes("This conversation and its history will be permanently deleted.") &&
				panelState.focus &&
				panelState.behindInert,
			{ ...panelState, text: panelState.text.slice(0, 120) },
			"the copy, focus on Delete, rows inert",
		);
		const dialog = await page.eval<{ role: string | null; name: string; description: string }>(`(() => {
			const d = ${A}.delPanel();
			const text = (attr) => {
				const target = d ? document.getElementById(d.getAttribute(attr) || '') : null;
				return target ? target.textContent.trim() : '';
			};
			return { role: d ? d.getAttribute('role') : null, name: text('aria-labelledby'), description: text('aria-describedby') };
		})()`);
		ok(
			"AI-34",
			"the panel is an alertdialog with a name, and its description names the conversation",
			dialog.role === "alertdialog" &&
				dialog.name.length > 0 &&
				dialog.description.includes("CF AI Test delete cancel"),
			dialog,
			"role alertdialog, a non-empty name, the conversation title in the description",
		);
		await click(page, `${A}.delButton('tertiary')`);
		await sleep(400);
		const cancelled = await page.eval<{ panel: boolean; row: boolean; focus: boolean }>(`({
			panel: !!${A}.delPanel(), row: !!${A}.itemOf(${q(spare)}),
			focus: ${focusIn(`${A}.itemOf(${q(spare)})`)},
		})`);
		ok(
			"AI-34",
			"Cancel changes nothing: the panel is gone, the row and the session remain, focus returns to the row",
			!cancelled.panel && cancelled.row && cancelled.focus && (await sessionExists(page, spare)),
			cancelled,
			"no panel, row listed, session exists, focus inside the row",
		);
		await click(page, `${A}.itemTrigger(${A}.itemOf(${q(spare)}))`);
		const reopened = await page.waitFor(`${A}.menuOpen(${A}.itemOf(${q(spare)}))`, { timeout: 3000 }).then(
			() => true,
			() => false,
		);
		await sleep(250);
		const again = await page.eval<string[]>(`${A}.menuEntries().map((e) => e.textContent.trim())`);
		ok(
			"AI-34",
			"after Cancel the same row's menu opens again with both entries",
			reopened && again.length === 2,
			{ reopened, entries: again },
			"menu open, Rename and Delete visible",
		);
		await press(page, "Escape");
		await sleep(300);
		const afterEscape = await page.eval<{ open: boolean; shown: boolean; panel: boolean }>(`({
			open: ${A}.menuOpen(${A}.itemOf(${q(spare)})), shown: ${A}.histShown(), panel: ${A}.isOpen(),
		})`);
		ok(
			"AI-34",
			"Escape closes an open row menu and nothing else: the list and the panel stay open",
			!afterEscape.open && afterEscape.shown && afterEscape.panel,
			afterEscape,
			"menu closed, list open, panel open",
		);

		await startDelete(page, other);
		await click(page, `${A}.delButton('danger')`);
		await page.waitFor(`!${A}.itemOf(${q(other)}) && !${A}.delPanel()`, { timeout: 10000 });
		await sleep(400);
		const afterOther = await page.eval<{ session: string | null; focusInList: boolean; shown: boolean }>(`({
			session: localStorage.getItem('cf-ai-session'), shown: ${A}.histShown(),
			focusInList: ${A}.items().some((i) => ${A}.contains(i, ${A}.deepActive())) || ${A}.deepActive() === ${A}.searchInput(),
		})`);
		ok(
			"AI-34",
			"deleting a conversation that is not open removes it and its runs and leaves the open one alone",
			!(await sessionExists(page, other)) &&
				(await runsOf(page, other)).length === 0 &&
				JSON.stringify(await rowTexts(page)) === JSON.stringify(openRows) &&
				afterOther.session === open,
			{ ...afterOther, runs: (await runsOf(page, other)).length },
			"session and runs gone, the open conversation's rows and pointer unchanged",
		);
		ok(
			"AI-34",
			"focus moves to another row (or the search field) when its row disappears",
			afterOther.focusInList && afterOther.shown,
			afterOther,
			"focus inside the list, list open",
		);

		await startDelete(page, open);
		await click(page, `${A}.delButton('danger')`);
		await page.waitFor(`!${A}.itemOf(${q(open)}) && !${A}.delPanel()`, { timeout: 10000 });
		await sleep(900);
		const afterOpen = await page.eval<{
			session: string | null;
			rows: number;
			home: boolean;
			shown: boolean;
		}>(`({
			session: localStorage.getItem('cf-ai-session'), rows: ${A}.rows().length,
			home: ${A}.visible(document.querySelector('#cf-ai-panel .cf-ai-home')), shown: ${A}.histShown(),
		})`);
		ok(
			"AI-34",
			"deleting the open conversation resets to a new chat and does not open a neighbour, with the list still open",
			afterOpen.session === "" &&
				afterOpen.rows === 0 &&
				afterOpen.home &&
				afterOpen.shown &&
				!(await sessionExists(page, open)),
			afterOpen,
			`cf-ai-session "", no rows, home visible, list open, session gone`,
		);
		await closeHistory(page);
	});

	await group("AI-35", async () => {
		await startCase(page);
		await chooseSession(page, fixture("gamma"));
		const previous = await sessionName(page);
		const sessionTotal = await sessionCount(page);
		await openHistory(page);
		await startWatch(page);
		await click(page, `${A}.newChatButton()`);
		await page.waitFor(`!${A}.histShown()`, { timeout: 5000 });
		await sleep(700);
		const seen = await stopWatch(page);
		const state = await page.eval<{ home: boolean; session: string | null; rows: number; focus: boolean }>(`({
			home: ${A}.visible(document.querySelector('#cf-ai-panel .cf-ai-home')), session: localStorage.getItem('cf-ai-session'),
			rows: ${A}.rows().length, focus: ${A}.deepActive() === ${A}.textarea(),
		})`);
		ok(
			"AI-35",
			"New chat in the list closes it, shows home, clears the session and focuses the prompt",
			state.home && state.session === "" && state.rows === 0 && state.focus,
			state,
			`home, cf-ai-session "", no rows, prompt focused`,
		);
		ok(
			"AI-35",
			"the live region said New conversation started",
			seen.announced.some((a) => a.includes("New conversation started")),
			seen.announced,
			`"New conversation started"`,
		);
		await say(page, "hello");
		const next = await sessionName(page);
		ok(
			"AI-35",
			"the next turn is a different Flow Session",
			next !== "" && next !== previous && (await sessionCount(page)) === sessionTotal + 1,
			{ previous, next },
			"a new session",
		);
	});

	await group("AI-36", async () => {
		await startCase(page);
		await openHistory(page);
		await startWatch(page);
		await focusInput(page);
		await insertText(page, "SLOW with the list open");
		await press(page, "Enter");
		await page.waitFor(`${A}.send().isStopStreamingButtonVisible`, { timeout: 30000 });
		await sleep(300);
		const live = await page.eval<{ shown: boolean; disabled: boolean | null; pressed: string | null }>(`({
			shown: ${A}.histShown(), disabled: ${A}.actionDisabled(${A}.histAction()), pressed: ${A}.pressed(${A}.histAction()),
		})`);
		ok(
			"AI-36",
			"sending closes the open list, and while the reply streams the action is disabled",
			!live.shown && live.disabled === true && live.pressed !== "true",
			live,
			"list closed, action disabled, not pressed",
		);
		await click(page, `${A}.histAction()`);
		await sleep(400);
		ok(
			"AI-36",
			"clicking the disabled action opens nothing",
			!(await historyShown(page)),
			await historyShown(page),
			"list closed",
		);
		await click(page, `${A}.send().shadowRoot.querySelector('cds-aichat-stop-streaming-button')`);
		await page.waitFor(`!${A}.send().isStopStreamingButtonVisible`, { timeout: 10000 });
		await page.waitFor(`${A}.actionDisabled(${A}.histAction()) === false`, { timeout: 10000 });
		await stopWatch(page);
		await click(page, `${A}.histAction()`);
		await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
		ok("AI-36", "after Stop the action works again", await historyShown(page), undefined, "list open");
		await closeHistory(page);
	});

	await group("AI-37", async () => {
		const sessionList = isListOf("Flow Session");
		// 1. the skeleton, on a page that has never listed anything
		await startCase(page);
		const slow = await intercept(page, ["*/api/method/frappe.client.get_list"], (r) =>
			sessionList(r) ? { kind: "pass", delayMs: 700 } : { kind: "pass" },
		);
		try {
			await click(page, `${A}.histAction()`);
			await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
			await sleep(250);
			const waiting = await page.eval<{ skeleton: boolean; rows: number }>(`({
				skeleton: !!${A}.skeleton() && ${A}.visible(${A}.skeleton()), rows: ${A}.items().length,
			})`);
			ok(
				"AI-37",
				"while the first list is on its way a loading skeleton shows, no rows",
				waiting.skeleton && waiting.rows === 0,
				waiting,
				"cds-aichat-history-loading visible, 0 rows",
			);
			await historySettled(page);
			const loaded = await page.eval<{ skeleton: boolean; rows: number }>(`({
				skeleton: !!${A}.skeleton(), rows: ${A}.items().length,
			})`);
			ok(
				"AI-37",
				"the list replaces the skeleton",
				!loaded.skeleton && loaded.rows > 0,
				loaded,
				"no skeleton, rows",
			);
			await closeHistory(page);
			await click(page, `${A}.histAction()`);
			await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
			await sleep(250);
			const refreshing = await page.eval<{ skeleton: boolean; rows: number }>(`({
				skeleton: !!${A}.skeleton(), rows: ${A}.items().length,
			})`);
			ok(
				"AI-37",
				"opening again shows the previous list at once, while it refreshes",
				!refreshing.skeleton && refreshing.rows > 0,
				refreshing,
				"no skeleton, rows already there",
			);
			await historySettled(page);
		} finally {
			await slow();
		}

		// 2. the error, on a page that has no list to fall back on, then Retry
		await tolerate(async () => {
			await startCase(page);
			const broken = await intercept(page, ["*/api/method/frappe.client.get_list"], (r) =>
				sessionList(r) ? { kind: "fail" } : { kind: "pass" },
			);
			try {
				await click(page, `${A}.histAction()`);
				await page.waitFor(`${A}.histShown() && !!${A}.histError()`, { timeout: 10000 });
				const failure = await page.eval<{ text: string; retry: boolean; rows: number }>(`({
					text: ${A}.deepText(${A}.histError()), retry: ${A}.visible(${A}.histError().querySelector('[data-action="retry-history"]')),
					rows: ${A}.items().length,
				})`);
				ok(
					"AI-37",
					"a list that cannot be read shows an error with Try again and no rows",
					failure.text.includes("Could not load your conversations") && failure.retry && failure.rows === 0,
					{ ...failure, text: failure.text.slice(0, 100) },
					`"Could not load your conversations", [data-action=retry-history], 0 rows`,
				);
			} finally {
				await broken();
			}
			await click(page, `${A}.histError().querySelector('[data-action="retry-history"]')`);
			await page.waitFor(`${A}.items().length > 0 && !${A}.histError()`, { timeout: 15000 });
			ok("AI-37", "Try again, once the server answers, shows the list", true);

			const again = await intercept(page, ["*/api/method/frappe.client.get_list"], (r) =>
				sessionList(r) ? { kind: "fail" } : { kind: "pass" },
			);
			try {
				await closeHistory(page);
				await click(page, `${A}.histAction()`);
				await page.waitFor(`${A}.histShown() && !!${A}.histError()`, { timeout: 10000 });
				const both = await page.eval<{ rows: number; errorAbove: boolean }>(`(() => {
					const e = ${A}.histError().getBoundingClientRect(); const first = ${A}.items()[0].getBoundingClientRect();
					return { rows: ${A}.items().length, errorAbove: e.bottom <= first.top + 1 };
				})()`);
				ok(
					"AI-37",
					"a failed refresh keeps the rows and shows the error above them",
					both.rows > 0 && both.errorAbove,
					both,
					"rows kept, error block above the first row",
				);
			} finally {
				await again();
			}
		});

		// 3. nothing to list
		await startCase(page);
		const none = await intercept(page, ["*/api/method/frappe.client.get_list"], (r) =>
			sessionList(r) ? { kind: "fulfill", body: [] } : { kind: "pass" },
		);
		try {
			await click(page, `${A}.histAction()`);
			await page.waitFor(`${A}.histShown() && !!${A}.empty()`, { timeout: 10000 });
			const empty = await page.eval<{ text: string; rows: number }>(`({
				text: ${A}.deepText(${A}.empty()), rows: ${A}.items().length,
			})`);
			ok(
				"AI-37",
				"an account with no conversations says so",
				empty.text.includes("No conversations yet") && empty.rows === 0,
				empty,
				`.cf-ai-history__empty "No conversations yet"`,
			);
		} finally {
			await none();
		}
		await closeHistory(page);
	});

	await group("AI-38", async () => {
		await startCase(page);
		const alpha = fixture("alpha");
		const spare = await chatInNewConversation(page, "CF AI Test xtab spare");
		const second = await newPage(port);
		try {
			await second.send("Page.addScriptToEvaluateOnNewDocument", { source: LIB });
			await second.send("Emulation.setDeviceMetricsOverride", {
				width: 1600,
				height: 1000,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await second.send("Page.bringToFront");
			await startCase(second);
			// a second tab of the same browser: the stream lease and the session pointer are shared with this one
			const held = await chatInNewConversation(second, "HOLD the stream", false);
			await second.waitFor(`${A}.send().isStopStreamingButtonVisible`, { timeout: 30000 });
			await page.send("Page.bringToFront");
			const leased = await page.eval<boolean>(`!!localStorage.getItem('cf-ai-stream')`);
			ok("AI-38", "the streaming tab holds the stream lease", leased, leased, "true");

			await openHistory(page);
			await waitItem(page, held);
			await page.eval(`${A}.clearAlerts()`);
			await tolerate(async () => {
				await startDelete(page, held);
				await click(page, `${A}.delButton('danger')`);
				await page.waitFor(`${A}.alerts().length > 0`, { timeout: 10000 });
				await sleep(400);
				const refused = await page.eval<{ row: boolean }>(`({ row: !!${A}.itemOf(${q(held)}) })`);
				const alerts = await alertTexts(page);
				ok(
					"AI-38",
					"deleting the conversation another tab is streaming is refused with a message, and it stays",
					alerts.some((a) => a.includes("another tab")) && refused.row && (await sessionExists(page, held)),
					{ alerts, row: refused.row },
					`an alert naming the other tab, the row and the session kept`,
				);
				if (await flag(page, `!!${A}.delPanel()`)) {
					await click(page, `${A}.delButton('tertiary')`);
					await sleep(300);
				}
			});

			const mark = netMark();
			await chooseSession(page, alpha);
			ok(
				"AI-38",
				"switching conversations while another tab streams makes no recover_session request",
				posts(mark, "flow\\.api\\.(api\\.)?recover_session").length === 0 &&
					JSON.stringify(await rowTexts(page)) === JSON.stringify(snapshots.alpha),
				posts(mark, "flow\\.api\\.(api\\.)?recover_session").length,
				"0 requests, and alpha's rows on screen",
			);

			await openHistory(page);
			await waitItem(page, spare);
			await startDelete(page, spare);
			await click(page, `${A}.delButton('danger')`);
			await page.waitFor(`!${A}.itemOf(${q(spare)})`, { timeout: 10000 });
			ok(
				"AI-38",
				"deleting some other conversation works meanwhile",
				!(await sessionExists(page, spare)),
				undefined,
				"the spare session is gone",
			);
			await closeHistory(page);

			await second.send("Page.bringToFront");
			await click(second, `${A}.send().shadowRoot.querySelector('cds-aichat-stop-streaming-button')`);
			await second.waitFor(`!${A}.send().isStopStreamingButtonVisible`, { timeout: 15000 });
			await page.send("Page.bringToFront");
			await page.waitFor(`localStorage.getItem('cf-ai-stream') === null`, { timeout: 10000 });
			// a page of its own: the row menus of this one have been used, and the lists they sit in rebuilt
			await startCase(page);
			await openHistory(page);
			await waitItem(page, held);
			await startDelete(page, held);
			await click(page, `${A}.delButton('danger')`);
			await page.waitFor(`!${A}.itemOf(${q(held)})`, { timeout: 10000 });
			ok(
				"AI-38",
				"once the other tab has stopped, its conversation can be deleted",
				!(await sessionExists(page, held)),
				undefined,
				"the session is gone",
			);
			await closeHistory(page);
		} finally {
			second.close();
		}
	});

	await group("AI-39", async () => {
		await startCase(page);
		const ratingOf = async (name: string): Promise<{ rating: string; comment: string }> => {
			const doc = await api(page, "GET", resource("Flow Run", name));
			return {
				rating: str(dig(doc.json, "data", "feedback_rating")) ?? "",
				comment: str(dig(doc.json, "data", "feedback_comment")) ?? "",
			};
		};
		const footerRun = (index: number): Promise<string> =>
			page.eval<string>(`${A}.footer(${index}).getAttribute('data-run')`);
		const thumbs = (
			index: number,
		): Promise<{
			up: boolean;
			down: boolean;
			upOff: boolean;
			downOff: boolean;
			open: boolean;
		} | null> => page.eval(`${A}.thumbState(${A}.footer(${index}))`);
		const feedbackCalls = (mark: number): Array<Record<string, unknown> | null> =>
			posts(mark, "flow\\.api\\.(api\\.)?submit_feedback");

		const session = await chatInNewConversation(page, "CF AI Test feedback one");
		await page.waitFor(`${A}.footers().length >= 1`, { timeout: 10000 });
		const rated = await footerRun(-1);
		const initial = await thumbs(-1);
		ok(
			"AI-39",
			"a finished reply carries both thumbs, neither selected",
			initial !== null && !initial.up && !initial.down && !initial.upOff && !initial.downOff && !initial.open,
			initial,
			"both thumbs enabled, none selected",
		);

		await startWatch(page);
		let mark = netMark();
		await click(page, `${A}.thumbs(${A}.footer()).up`);
		const sentUp = await until(() => feedbackCalls(mark).length > 0, 5000);
		const up = await eventually(
			() => ratingOf(rated),
			(r) => r.rating === "Up",
		);
		const afterUp = await thumbs(-1);
		ok(
			"AI-39",
			"Up sends the rating and the Flow Run stores it; the Up thumb is selected and Down is disabled",
			sentUp &&
				dig(feedbackCalls(mark)[0], "rating") === "Up" &&
				dig(feedbackCalls(mark)[0], "run_name") === rated &&
				up.rating === "Up" &&
				afterUp?.up === true &&
				afterUp.downOff === true,
			{ body: feedbackCalls(mark)[0], stored: up, state: afterUp },
			`POST rating "Up", feedback_rating "Up", Up selected, Down disabled`,
		);

		mark = netMark();
		await click(page, `${A}.thumbs(${A}.footer()).up`);
		const sentNone = await until(() => feedbackCalls(mark).length > 0, 5000);
		const cleared = await eventually(
			() => ratingOf(rated),
			(r) => r.rating === "",
		);
		const afterNone = await thumbs(-1);
		ok(
			"AI-39",
			"choosing Up again takes it back: rating None sent, the Flow Run is cleared, Down is enabled again",
			sentNone &&
				dig(feedbackCalls(mark)[0], "rating") === "None" &&
				cleared.rating === "" &&
				afterNone?.up === false &&
				afterNone.downOff === false,
			{ body: feedbackCalls(mark)[0], stored: cleared, state: afterNone },
			`POST rating "None", feedback_rating "", nothing selected`,
		);

		mark = netMark();
		await click(page, `${A}.thumbs(${A}.footer()).down`);
		await page.waitFor(`${A}.thumbState(${A}.footer()).open === true`, { timeout: 5000 });
		ok(
			"AI-39",
			"Down opens the comment panel and sends nothing yet",
			feedbackCalls(mark).length === 0,
			feedbackCalls(mark).length,
			"0 requests, panel open",
		);
		await page.eval(
			`(${A}.deepAll(${A}.footer().querySelector('cds-aichat-feedback'), 'textarea')[0].focus(), true)`,
		);
		await insertText(page, "too long");
		await click(page, `${A}.deepAll(${A}.footer().querySelector('cds-aichat-feedback'), 'cds-button')[0]`);
		const sentDown = await until(() => feedbackCalls(mark).length > 0, 5000);
		const down = await eventually(
			() => ratingOf(rated),
			(r) => r.rating === "Down",
		);
		await page.waitFor(`${A}.thumbState(${A}.footer()).open === false`, { timeout: 5000 });
		const afterDown = await thumbs(-1);
		ok(
			"AI-39",
			"submitting a comment sends Down with it, the Flow Run stores both and the panel closes",
			sentDown &&
				dig(feedbackCalls(mark)[0], "rating") === "Down" &&
				dig(feedbackCalls(mark)[0], "comment") === "too long" &&
				down.rating === "Down" &&
				down.comment === "too long" &&
				afterDown?.down === true &&
				afterDown.upOff === true,
			{ body: feedbackCalls(mark)[0], stored: down, state: afterDown },
			`POST Down + "too long", stored, Down selected, panel closed`,
		);
		const seen = await stopWatch(page);
		ok(
			"AI-39",
			"the polite live region announced Feedback sent and Feedback removed",
			seen.announced.some((a) => a.startsWith("polite:") && a.includes("Feedback sent")) &&
				seen.announced.some((a) => a.startsWith("polite:") && a.includes("Feedback removed")),
			seen.announced,
			`polite messages containing "Feedback sent" and "Feedback removed"`,
		);

		await freshPage(page, "/desk/todo", true);
		await page.waitFor(`${A}.isOpen() && ${A}.footers().length >= 1`, { timeout: 40000 });
		await sleep(500);
		const restored = await thumbs(-1);
		ok(
			"AI-39",
			"after a reload the reply's thumbs-down is selected again",
			restored?.down === true && restored.up === false && restored.upOff === true,
			restored,
			"Down selected, Up disabled",
		);
		await chooseSession(page, fixture("gamma"));
		await chooseSession(page, session);
		const switched = await thumbs(-1);
		ok(
			"AI-39",
			"and the same after opening another conversation and coming back",
			switched?.down === true && switched.up === false,
			switched,
			"Down selected",
		);

		await tolerate(async () => {
			await say(page, "CF AI Test feedback two");
			const second = await footerRun(-1);
			await page.eval(`${A}.clearAlerts()`);
			await page.send("Network.setBlockedURLs", { urls: ["*flow.api.submit_feedback*"] });
			try {
				await click(page, `${A}.thumbs(${A}.footer()).up`);
				await page.waitFor(`${A}.alerts().length > 0`, { timeout: 10000 });
				await page.waitFor(`${A}.thumbState(${A}.footer()).up === false`, { timeout: 5000 });
			} finally {
				await page.send("Network.setBlockedURLs", { urls: [] });
			}
			const reverted = await thumbs(-1);
			ok(
				"AI-39",
				"a refused rating takes the selection back, tells the user and stores nothing",
				reverted?.up === false && reverted.upOff === false && (await ratingOf(second)).rating === "",
				{ state: reverted, alerts: await alertTexts(page) },
				"Up not selected and enabled, an alert, no stored rating",
			);
		});
	});

	await group("AI-40", async () => {
		await startCase(page);
		const zones = await page.eval<{ system: string; user: string; locale: string }>(`${A}.zones()`);
		const emulated = zones.system === "Pacific/Auckland" ? "America/Los_Angeles" : "Pacific/Auckland";
		await page.send("Emulation.setTimezoneOverride", { timezoneId: emulated });
		try {
			const browserZone = await page.eval<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
			ok(
				"AI-40",
				"the browser's zone differs from the site's, so a missing conversion cannot pass",
				browserZone !== zones.system,
				{ browser: browserZone, system: zones.system, user: zones.user },
				"different zones",
			);
			const session = await chatInNewConversation(page, "CF AI Test timestamps");
			const live = await page.eval<Array<{ role: string; datetime: string | null }>>(`${A}.times()`);
			const stamped = await page.eval<boolean>(
				`${A}.times().every((t) => t.datetime !== null && Math.abs(Date.parse(t.datetime) - Date.now()) < 60000)`,
			);
			ok(
				"AI-40",
				"live rows show a time within a minute of now, the question and the answer alike",
				live.length === 2 && stamped,
				live,
				"2 rows, each with time[datetime] near now",
			);

			await freshPage(page, "/desk/todo", true);
			await page.waitFor(`${A}.isOpen() && ${A}.rows().length >= 2`, { timeout: 40000 });
			await sleep(500);
			const runs = await runsOf(page, session);
			const creation = str(runs[0]?.["creation"]) ?? "";
			const expected = await page.eval<number>(`${A}.naiveToEpoch(${q(creation)}, ${q(zones.system)})`);
			const restored = await page.eval<
				Array<{
					role: string;
					datetime: string | null;
					text: string;
					title: string | null;
					label: string | null;
				}>
			>(`${A}.times()`);
			ok(
				"AI-40",
				"restored rows carry the run's creation time read in the site's zone, not the browser's",
				restored.length === 2 &&
					restored.every((t) => t.datetime !== null && Math.abs(Date.parse(t.datetime) - expected) <= 1000),
				{ creation, expected: new Date(expected).toISOString(), rows: restored.map((t) => t.datetime) },
				"both rows within 1s of Flow Run.creation in the system zone",
			);
			const shown = await page.eval<boolean[]>(
				`${A}.times().map((t) => t.text === ${A}.shortTime(Date.parse(t.datetime), Date.now()))`,
			);
			ok(
				"AI-40",
				"the text is the time in the user's zone",
				shown.length === 2 && shown.every(Boolean),
				{ texts: restored.map((t) => t.text), zone: zones.user },
				"the page's own Intl formatting of that instant in the user's zone",
			);
			const names = await page.eval<boolean[]>(`${A}.times().map((t) => {
				const at = Date.parse(t.datetime);
				const weekday = new Intl.DateTimeFormat(${A}.zones().locale, { weekday: 'long', timeZone: ${A}.zones().user }).format(at);
				const month = new Intl.DateTimeFormat(${A}.zones().locale, { month: 'long', timeZone: ${A}.zones().user }).format(at);
				return !!t.title && t.title === t.label && t.title === ${A}.fullTime(at) && t.title.includes(weekday) && t.title.includes(month);
			})`);
			ok(
				"AI-40",
				"title and aria-label are the same full date with a weekday and a month name",
				names.length === 2 && names.every(Boolean),
				{ title: restored[0]?.title, label: restored[0]?.label },
				"equal, full date and time",
			);

			await page.eval(
				`(window.__realNow = Date.now, Date.now = () => window.__realNow() + 2 * 86400000, true)`,
			);
			try {
				await chooseSession(page, fixture("beta"));
				const older = await page.eval<Array<{ text: string; timeOnly: string; expected: string }>>(
					`${A}.times().map((t) => { const at = Date.parse(t.datetime); return { text: t.text, timeOnly: new Intl.DateTimeFormat(${A}.zones().locale, { timeStyle: 'short', timeZone: ${A}.zones().user }).format(at), expected: ${A}.shortTime(at, Date.now()) }; })`,
				);
				ok(
					"AI-40",
					"a message from an earlier day shows its date, not only the time",
					older.length >= 2 && older.every((t) => t.text === t.expected && t.text !== t.timeOnly),
					older,
					"month and day before the time",
				);
			} finally {
				await page.eval(`(Date.now = window.__realNow, true)`);
			}
		} finally {
			await page.send("Emulation.setTimezoneOverride", { timezoneId: "" });
		}
	});

	await group("AI-41", async () => {
		await startCase(page);
		const long = fixture("long");
		await page.eval(
			`(window.__long = [], new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }), true)`,
		);
		await openHistory(page);
		await waitItem(page, long);
		const began = Date.now();
		await click(page, `${A}.itemButton(${A}.itemOf(${q(long)}))`, true, 0.3);
		await page.waitFor(
			`!${A}.histShown() && localStorage.getItem('cf-ai-session') === ${q(long)} && ${A}.rows().length > 2`,
			{ timeout: 20000, interval: 50 },
		);
		const builtIn = Date.now() - began;
		await sleep(600);
		const state = await page.eval<{
			rows: number;
			gap: number;
			earlier: boolean;
			longest: number;
			label: string;
		}>(`(() => {
			const sc = ${A}.scroller(); const b = document.querySelector('#cf-ai-panel .cf-ai-earlier');
			return { rows: ${A}.rows().length, gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
				earlier: !!b && !b.hidden && ${A}.visible(b), longest: Math.max(0, ...window.__long), label: b ? b.textContent.trim() : '' };
		})()`);
		ok(
			"AI-41",
			"200 messages open as a window of at most 31 rows, scrolled to the end, within 3 seconds",
			builtIn < 3000 && state.rows > 0 && state.rows <= 31 && state.gap <= 8,
			{ builtIn, rows: state.rows, gapToEnd: state.gap },
			"under 3000 ms, 1 to 31 rows, within 8px of the end",
		);
		ok(
			"AI-41",
			"the page never froze: no long task over 500 ms during the switch",
			state.longest < 500,
			{ longestTaskMs: state.longest },
			"< 500",
		);
		ok(
			"AI-41",
			"Show earlier messages is offered, with the hidden count",
			state.earlier && /Show earlier messages/.test(state.label),
			state.label,
			`a visible "Show earlier messages (...)"`,
		);

		const keyOfFirst = await page.eval<string>(`${A}.firstRowKey()`);
		await page.eval(
			`(document.querySelector('#cf-ai-panel .cf-ai-earlier').scrollIntoView({ block: 'nearest' }), true)`,
		);
		await sleep(200);
		const topBefore = await page.eval<number>(`${A}.rowByKey(${q(keyOfFirst)}).getBoundingClientRect().top`);
		const rowsBefore = state.rows;
		await click(page, `document.querySelector('#cf-ai-panel .cf-ai-earlier')`, false);
		await page.waitFor(`${A}.rows().length > ${rowsBefore}`, { timeout: 10000 });
		await sleep(400);
		const prepended = await page.eval<{
			rows: number;
			top: number;
			focus: boolean;
			first: string | null;
		}>(`(() => {
			const row = ${A}.rowByKey(${q(keyOfFirst)});
			return { rows: ${A}.rows().length, top: row ? row.getBoundingClientRect().top : -1, focus: document.activeElement === row, first: ${A}.firstRowKey() };
		})()`);
		ok(
			"AI-41",
			"showing earlier messages adds about 30 rows, keeps the first row where it was and focuses it",
			prepended.rows - rowsBefore >= 28 &&
				prepended.rows - rowsBefore <= 32 &&
				Math.abs(prepended.top - topBefore) <= 2 &&
				prepended.focus,
			{ added: prepended.rows - rowsBefore, movedBy: prepended.top - topBefore, focus: prepended.focus },
			"28 to 32 rows added, moved by at most 2px, focus on the previously first row",
		);
		await page.eval(`(${A}.rows()[0].focus(), true)`);
		await press(page, "ArrowUp");
		const upToButton = await flag(
			page,
			`document.activeElement && document.activeElement.classList.contains('cf-ai-earlier')`,
		);
		ok(
			"AI-41",
			"ArrowUp on the first built row reaches the button while rows are hidden",
			upToButton,
			upToButton,
			"focus on .cf-ai-earlier",
		);

		for (let i = 0; i < 12; i++) {
			const hidden = await flag(page, `document.querySelector('#cf-ai-panel .cf-ai-earlier').hidden`);
			if (hidden) break;
			const count = await page.eval<number>(`${A}.rows().length`);
			await page.eval(`(document.querySelector('#cf-ai-panel .cf-ai-earlier').focus(), true)`);
			await press(page, "Enter");
			await page.waitFor(`${A}.rows().length > ${count}`, { timeout: 10000 });
		}
		await sleep(300);
		const all = await page.eval<{ rows: number; hidden: boolean; first: string }>(`({
			rows: ${A}.rows().length, hidden: document.querySelector('#cf-ai-panel .cf-ai-earlier').hidden,
			first: ${A}.texts()[0].text,
		})`);
		ok(
			"AI-41",
			"repeating from the keyboard reveals all 200 messages, oldest first, and hides the button",
			all.rows === 200 && all.hidden && all.first === "CF AI Test long message 1",
			all,
			`200 rows, button hidden, first "CF AI Test long message 1"`,
		);
		await say(page, "hello");
		ok(
			"AI-41",
			"the long conversation still takes a new turn",
			(await lastAssistantText(page)).includes("CF AI Test reply"),
			(await lastAssistantText(page)).slice(0, 80),
			`"CF AI Test reply"`,
		);
	});

	await group("AI-42", async () => {
		await startCase(page);
		await chooseSession(page, fixture("long"));
		const handles = await page.eval<{
			top: { w: number; h: number; label: string | null; text: string; action: string | null } | null;
			bottom: { w: number; h: number; label: string | null; text: string; action: string | null } | null;
			jumpHidden: boolean;
		}>(`(() => {
			const read = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), label: el.getAttribute('aria-label'), text: el.textContent.trim(), action: el.getAttribute('data-action') }; };
			const jump = document.querySelector('#cf-ai-panel .cf-ai-scroll-bottom');
			return { top: read(document.querySelector('#cf-ai-panel .cf-ai-scroll-handle--top')), bottom: read(document.querySelector('#cf-ai-panel .cf-ai-scroll-handle--bottom')),
				jumpHidden: !jump || jump.hidden || jump.getClientRects().length === 0 };
		})()`);
		ok(
			"AI-42",
			"both scroll handles exist, are one pixel while unfocused and carry their instructions",
			handles.top !== null &&
				handles.bottom !== null &&
				handles.top.w <= 1 &&
				handles.top.h <= 1 &&
				handles.bottom.w <= 1 &&
				handles.bottom.h <= 1 &&
				handles.top.action === "focus-first" &&
				handles.bottom.action === "focus-last" &&
				handles.top.label ===
					"Beginning of the conversation. Press Enter to move to the first message, then use the arrow keys to move between messages. Press Escape to return to the message field." &&
				handles.bottom.label ===
					"End of the conversation. Press Enter to move to the last message, then use the arrow keys to move between messages. Press Escape to return to the message field.",
			handles,
			"1px clipped, data-action focus-first / focus-last, the two long aria-labels",
		);
		await focusInput(page);
		await press(page, "Tab", SHIFT);
		// The Attach button comes before the editor in the tab order; one more step goes past it.
		if ((await attachState(page)).focused) await press(page, "Tab", SHIFT);
		const onBottom = await page.eval<{ onHandle: boolean; w: number; h: number; text: string }>(`(() => {
			const b = document.querySelector('#cf-ai-panel .cf-ai-scroll-handle--bottom'); const r = b.getBoundingClientRect();
			return { onHandle: document.activeElement === b, w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() };
		})()`);
		ok(
			"AI-42",
			"with the jump button hidden, Shift+Tab from the prompt line lands on the bottom handle, now a visible tile",
			handles.jumpHidden && onBottom.onHandle && onBottom.w > 40 && onBottom.h >= 16,
			{ jumpHidden: handles.jumpHidden, ...onBottom },
			"focus on the bottom handle, a tile larger than 40x16",
		);
		await press(page, "Enter");
		const rowsNow = await page.eval<number>(`${A}.rows().length`);
		const last = await page.eval<number>(`${A}.rows().indexOf(document.activeElement)`);
		await press(page, "ArrowUp");
		const above = await page.eval<number>(`${A}.rows().indexOf(document.activeElement)`);
		ok(
			"AI-42",
			"Enter on it focuses the last row and ArrowUp walks up from there",
			last === rowsNow - 1 && above === rowsNow - 2,
			{ last, above, rows: rowsNow },
			`${rowsNow - 1} then ${rowsNow - 2}`,
		);
		await press(page, "Home");
		const home = await page.eval<number>(`${A}.rows().indexOf(document.activeElement)`);
		await press(page, "End");
		const end = await page.eval<number>(`${A}.rows().indexOf(document.activeElement)`);
		ok(
			"AI-42",
			"Home and End jump to the first and last built row",
			home === 0 && end === rowsNow - 1,
			{ home, end },
			`0 and ${rowsNow - 1}`,
		);
		await press(page, "Enter");
		ok(
			"AI-42",
			"Enter on a row does nothing",
			await flag(page, `${A}.rows().indexOf(document.activeElement) === ${rowsNow - 1}`),
			undefined,
			"focus stays on the row",
		);
		await press(page, "Escape");
		const out = await page.eval<{ input: boolean; open: boolean }>(
			`({ input: ${A}.deepActive() === ${A}.textarea(), open: ${A}.isOpen() })`,
		);
		ok(
			"AI-42",
			"Escape returns to the prompt line with the panel open",
			out.input && out.open,
			out,
			"prompt focused, panel open",
		);

		await page.eval(
			`(${A}.scroller().scrollTop = 0, document.querySelector('#cf-ai-panel .cf-ai-scroll-handle--top').focus(), true)`,
		);
		await sleep(150);
		await press(page, " ");
		const space = await page.eval<{ row: number; top: number }>(`({
			row: ${A}.rows().indexOf(document.activeElement), top: Math.round(${A}.scroller().scrollTop),
		})`);
		ok(
			"AI-42",
			"Space on the top handle focuses the first row and does not scroll the list",
			space.row === 0 && space.top <= 4,
			space,
			"first row focused, scrollTop <= 4",
		);
		await page.eval(`(document.querySelector('#cf-ai-panel .cf-ai-scroll-handle--top').focus(), true)`);
		await press(page, "Escape");
		ok(
			"AI-42",
			"Escape on a handle returns to the prompt line too",
			await flag(page, `${A}.deepActive() === ${A}.textarea() && ${A}.isOpen()`),
			undefined,
			"prompt focused, panel open",
		);
	});

	await group("AI-43", async () => {
		await startCase(page);
		await tolerate(async () => {
			await chatInNewConversation(page, "ERROR make the block wide", false);
			await page.waitFor(`!!${A}.lastAssistant() && !!${A}.lastAssistant().querySelector('.cf-ai-error')`, {
				timeout: 90000,
			});
			await waitIdle(page);
			await sleep(500);
			const layout = await page.eval<{
				host: number;
				wrapper: number;
				buttonTop: number;
				detailsBottom: number;
				inside: boolean;
				overflow: boolean;
			}>(`(() => {
				const host = document.getElementById('cf-ai-panel').getBoundingClientRect();
				const err = ${A}.lastAssistant().querySelector('.cf-ai-error'); const e = err.getBoundingClientRect();
				const wrapper = err.querySelector('.cds--inline-notification__text-wrapper').getBoundingClientRect();
				const details = err.querySelector('.cds--inline-notification__details').getBoundingClientRect();
				const button = err.querySelector('[data-action="retry-reply"]').getBoundingClientRect();
				const sc = ${A}.scroller();
				return { host: Math.round(host.width), wrapper: Math.round(wrapper.width), buttonTop: Math.round(button.top), detailsBottom: Math.round(details.bottom),
					inside: e.left >= host.left - 1 && e.right <= host.right + 1 && button.left >= e.left - 1 && button.right <= e.right + 1,
					overflow: sc.scrollWidth > sc.clientWidth + 1 };
			})()`);
			ok(
				"AI-43",
				"in the 360px panel the error's text keeps room: its column is at least 200px wide",
				layout.host === 360 && layout.wrapper >= 200,
				layout,
				"host 360, text wrapper >= 200",
			);
			ok(
				"AI-43",
				"Try again sits below the text, and the block stays inside the panel without scrolling sideways",
				layout.buttonTop >= layout.detailsBottom - 1 && layout.inside && !layout.overflow,
				layout,
				"button top >= text bottom, inside the host, no horizontal overflow",
			);
			await page.screenshot(`${SHOT}/assistant-error-360.png`);
		});
	});

	await group("AI-44", async () => {
		await startCase(page);
		await tolerate(async () => {
			const first = await chatInNewConversation(page, "FLAKY one", false);
			await page.waitFor(`!!${A}.lastAssistant() && !!${A}.lastAssistant().querySelector('.cf-ai-error')`, {
				timeout: 90000,
			});
			await waitIdle(page);
			await sleep(700);
			const cut = await page.eval<{ retries: number; inLast: boolean }>(`(() => {
				const retry = [...document.querySelectorAll('#cf-ai-panel [data-action="retry-reply"]')];
				return { retries: retry.length, inLast: retry.length === 1 && ${A}.lastAssistant().contains(retry[0]) };
			})()`);
			ok(
				"AI-44",
				"the cut reply offers Try again on the last reply only",
				cut.retries === 1 && cut.inLast,
				cut,
				"one retry button, in the last reply",
			);
			const runs = await runsOf(page, first);
			ok(
				"AI-44",
				"the cut reply's run ended Failed on the server, so nothing is left running to refuse the retry",
				runs.length === 1 && runs[0]?.["status"] === "Failed",
				runs.map((r) => r["status"]),
				`["Failed"]`,
			);
			const retryMark = netMark();
			await click(page, `document.querySelector('#cf-ai-panel [data-action="retry-reply"]')`);
			await sleep(250);
			await waitIdle(page);
			const starts = posts(retryMark, "flow\\.api\\.(api\\.)?start_run");
			const body = starts[0];
			ok(
				"AI-44",
				"Try again sends the same prompt into the same session",
				starts.length === 1 && dig(body, "input") === "FLAKY one" && dig(body, "session") === first,
				body,
				`one start_run with input "FLAKY one" and session ${first}`,
			);
			const after = await page.eval<{
				users: string[];
				retries: number;
				disabled: boolean;
				focus: boolean;
				panel: string;
			}>(`({
				users: ${A}.userRows().map((r) => ${A}.deepText(r)), retries: document.querySelectorAll('#cf-ai-panel [data-action="retry-reply"]').length,
				disabled: ${A}.prompt().disabled, focus: ${A}.deepActive() === ${A}.textarea(), panel: ${A}.deepText(document.getElementById('cf-ai-panel')),
			})`);
			ok(
				"AI-44",
				"the transcript gains a second FLAKY one and a normal answer, and no retry is left",
				after.users.length === 2 &&
					after.users.every((u) => u.includes("FLAKY one")) &&
					(await lastAssistantText(page)).includes("CF AI Test reply") &&
					after.retries === 0 &&
					!/already in progress/i.test(after.panel),
				{ users: after.users, retries: after.retries },
				"two user rows, the default reply, 0 retry buttons, no 'already in progress'",
			);
			ok(
				"AI-44",
				"the prompt is enabled and focused",
				!after.disabled && after.focus,
				{ disabled: after.disabled, focus: after.focus },
				"enabled and focused",
			);
			const seenByModel = flowMock.requests
				.filter((r) => r.lastUserText === "FLAKY one")
				.map((r) => r.keyword);
			ok(
				"AI-44",
				"the model saw the prompt twice: it died the first time and answered the second",
				JSON.stringify(seenByModel) === JSON.stringify(["FLAKY", "FLAKY_OK"]),
				seenByModel,
				`["FLAKY","FLAKY_OK"]`,
			);
		});
	});

	await group("AI-45", async () => {
		// openPanel waits for focus in the prompt, which a disabled prompt never takes
		const opened = async (): Promise<void> => {
			await click(page, trigger, false);
			await page.waitFor(`${A}.isOpen() && !!${A}.shell() && !!${A}.textarea()`, { timeout: 30000 });
			await sleep(600);
		};
		await page.eval(`(localStorage.removeItem('cf-ai-session'), true)`);
		await freshPage(page);
		await page.eval(`(frappe.db.count = async () => 0, true)`);
		await opened();
		await page.waitFor(`!!document.querySelector('#cf-ai-panel .cf-ai-home--setup')`, { timeout: 15000 });
		const mark = netMark();
		const setup = await page.eval<{
			prompt: boolean;
			textarea: boolean;
			send: boolean;
			placeholder: string;
			starters: number;
		}>(`({
			prompt: ${A}.prompt().disabled === true, textarea: ${A}.textarea().disabled === true || ${A}.textarea().readOnly === true || ${A}.textarea().getAttribute('aria-disabled') === 'true', send: ${A}.send().disabled === true,
			placeholder: ${A}.prompt().placeholder, starters: document.querySelectorAll('#cf-ai-panel .cf-ai-starter').length,
		})`);
		ok(
			"AI-45",
			"with no agent configured the prompt and the send control are disabled and say how to proceed",
			setup.prompt && setup.textarea && setup.send && setup.placeholder === "Finish setup to start chatting",
			setup,
			`disabled, placeholder "Finish setup to start chatting"`,
		);
		await insertText(page, "this goes nowhere");
		await press(page, "Enter");
		await sleep(400);
		ok(
			"AI-45",
			"Enter sends nothing",
			posts(mark, "flow\\.api\\.(api\\.)?start_run").length === 0 &&
				(await page.eval<number>(`${A}.userRows().length`)) === 0,
			posts(mark, "flow\\.api\\.(api\\.)?start_run").length,
			"no start_run, no user row",
		);
		await click(page, `${A}.histAction()`);
		await page.waitFor(`${A}.histShown()`, { timeout: 5000 });
		ok(
			"AI-45",
			"the history action still works in setup mode",
			await historyShown(page),
			undefined,
			"list open",
		);
		await closeHistory(page);

		// A conversation that exists keeps its own agent, so setup mode must not lock it.
		await page.eval(
			`(localStorage.setItem('cf-ai-session', ${q(fixture("gamma"))}), localStorage.setItem('cf-ai-session-user', frappe.session.user), localStorage.removeItem('cf-ai-panel'), true)`,
		);
		await freshPage(page);
		await page.eval(`(frappe.db.count = async () => 0, true)`);
		await openForCase(page);
		await page.waitFor(`${A}.rows().length > 0`, { timeout: 30000 });
		const restored = await page.eval<{ disabled: boolean; placeholder: string }>(`({
			disabled: ${A}.prompt().disabled === true, placeholder: ${A}.prompt().placeholder,
		})`);
		ok(
			"AI-45",
			"with a restored conversation the prompt stays enabled even though no agent is configured",
			!restored.disabled && restored.placeholder !== "Finish setup to start chatting",
			restored,
			"enabled, the normal placeholder",
		);
		await startCase(page);
	});

	await group("AI-46", async () => {
		await startCase(page);
		const dotsLoop = (): Promise<boolean | null> =>
			page.eval<boolean | null>(
				`(() => { const d = document.querySelector('#cf-ai-panel .cf-ai-processing cds-aichat-processing'); return d ? d.loop === true : null; })()`,
			);
		const measure = async (
			mode: "reduce" | "no-preference",
		): Promise<{ loop: boolean | null; loops: boolean[] }> => {
			await page.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-reduced-motion", value: mode }],
			});
			await sleep(250);
			const loop = await dotsLoop();
			await startWatch(page);
			await say(page, "SLOW dots", false);
			await page.waitFor(`${A}.send().isStopStreamingButtonVisible`, { timeout: 30000 });
			await sleep(1200);
			await click(page, `${A}.send().shadowRoot.querySelector('cds-aichat-stop-streaming-button')`);
			await waitIdle(page);
			const seen = await stopWatch(page);
			return { loop, loops: seen.loops };
		};
		try {
			await chatInNewConversation(page, "CF AI Test motion", true);
			const reduced = await measure("reduce");
			const full = await measure("no-preference");
			ok(
				"AI-46",
				"with reduced motion the processing dots do not loop",
				reduced.loop === false && reduced.loops.length > 0 && reduced.loops.every((l) => !l),
				{
					property: reduced.loop,
					samples: reduced.loops.length,
					looping: reduced.loops.filter(Boolean).length,
				},
				"loop false, at every sample",
			);
			ok(
				"AI-46",
				"without it they do (so the reduced result is not vacuous)",
				full.loop === true && full.loops.length > 0 && full.loops.every(Boolean),
				{ property: full.loop, samples: full.loops.length },
				"loop true, at every sample",
			);
		} finally {
			await page.send("Emulation.setEmulatedMedia", { features: [] });
		}
	});

	await group("AI-47", async () => {
		await startCase(page);
		await openHistory(page);
		const measure = (): Promise<{
			hist: { left: number; right: number };
			host: { left: number; right: number };
			viewport: number;
			back: number;
			middle: number;
		}> =>
			page.eval(`(() => {
				const h = ${A}.hist().getBoundingClientRect(); const host = document.getElementById('cf-ai-panel').getBoundingClientRect();
				const header = ${A}.hist().querySelector('cds-aichat-history-header').getBoundingClientRect(); const back = ${A}.backButton().getBoundingClientRect();
				return { hist: { left: Math.round(h.left), right: Math.round(h.right) }, host: { left: Math.round(host.left), right: Math.round(host.right) },
					viewport: innerWidth, back: Math.round(back.left + back.width / 2), middle: Math.round(header.left + header.width / 2) };
			})()`);
		const ltr = await measure();
		ok(
			"AI-47",
			"left to right, the back button is at the start (left) of the list's header",
			ltr.back < ltr.middle,
			ltr,
			"back button left of the middle",
		);
		const dir = await page.eval<string | null>(`document.documentElement.getAttribute('dir')`);
		await page.eval(`document.documentElement.dir = 'rtl'`);
		await sleep(500);
		const rtl = await measure();
		await page.eval(
			dir === null
				? `document.documentElement.removeAttribute('dir')`
				: `document.documentElement.setAttribute('dir', ${JSON.stringify(dir)})`,
		);
		ok(
			"AI-47",
			"right to left, the open list stays inside the panel and the panel inside the viewport",
			rtl.hist.left >= rtl.host.left - 1 &&
				rtl.hist.right <= rtl.host.right + 1 &&
				rtl.host.left >= 0 &&
				rtl.host.right <= rtl.viewport,
			rtl,
			"list within host, host within viewport",
		);
		ok(
			"AI-47",
			"and the back button is at the start (right) of the header",
			rtl.back > rtl.middle,
			{ back: rtl.back, middle: rtl.middle },
			"back button right of the middle",
		);
		await closeHistory(page);
	});

	await group("AI-48", async () => {
		await startCase(page);
		const original = await page.eval<string | null>(`document.documentElement.getAttribute('data-theme')`);
		await openHistory(page);
		const paint = async (theme: string): Promise<{ want: string; got: string[]; surface: boolean }> => {
			await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
			await sleep(500);
			return page.eval(`(() => {
				const want = ${A}.probe('--cds-chat-shell-background'); const h = ${A}.hist();
				const got = [h, h.querySelector('cds-aichat-history-shell')].map((el) => getComputedStyle(el).backgroundColor);
				return { want, got, surface: got.includes(want) };
			})()`);
		};
		const light = await paint("light");
		await page.screenshot(`${SHOT}/assistant-history-light.png`);
		const dark = await paint("dark");
		await page.screenshot(`${SHOT}/assistant-history-dark.png`);
		for (const [name, m] of [
			["light", light],
			["dark", dark],
		] as const) {
			ok(
				"AI-48",
				`${name}: the list is painted with --cds-chat-shell-background`,
				m.surface,
				m,
				"the overlay or its shell equals the token",
			);
		}
		ok(
			"AI-48",
			"the two themes paint it differently (so the match is not vacuous)",
			light.want !== dark.want,
			{ light: light.want, dark: dark.want },
			"different colours",
		);
		if (original === null) await page.eval(`document.documentElement.removeAttribute('data-theme')`);
		else await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(original)})`);
		await closeHistory(page);
	});

	await group("AI-49", async () => {
		await startCase(page);
		const closedStops = await page.eval<string[]>(`${A}.tabStops(${A}.hist())`);
		await openHistory(page);
		const names = await page.eval<{
			action: boolean;
			pressed: string | null;
			role: string | null;
			label: string | null;
			itemNames: string[];
			polite: boolean;
			behind: string[];
			unnamed: string[];
		}>(`(() => {
			const h = ${A}.hist(); const content = ${A}.content();
			return {
				action: !!${A}.histAction(), pressed: ${A}.pressed(${A}.histAction()), role: h.getAttribute('role'), label: h.getAttribute('aria-label'),
				itemNames: ${A}.items().map((i) => { const b = ${A}.itemButton(i); return b ? ${A}.deepText(b) : ''; }).filter((t) => !t),
				polite: ${A}.deepAll(content, '[aria-live="polite"]').length > 0,
				behind: [...${A}.tabStops(document.querySelector('#cf-ai-panel .cf-ai-home')), ...${A}.tabStops(document.querySelector('#cf-ai-panel .cf-ai-messages'))],
				unnamed: ${A}.unnamed(document.getElementById('cf-ai-panel')),
			};
		})()`);
		ok(
			"AI-49",
			"the history action has a name and a pressed state; the region has a name; every row has a name",
			names.action &&
				names.pressed === "true" &&
				names.role === "region" &&
				!!names.label &&
				names.itemNames.length === 0 &&
				names.unnamed.length === 0,
			names,
			"named action with aria-pressed, a named region, no row without text, no unnamed button",
		);
		ok("AI-49", "the results count lives in a polite live region", names.polite, names.polite, "true");
		ok(
			"AI-49",
			"a closed list has no tab stop; with it open, the home and the messages behind it have none",
			closedStops.length === 0 && names.behind.length === 0,
			{ closed: closedStops, behind: names.behind },
			"[] and []",
		);
		const first = await page.eval<string>(`${A}.sessions()[0]`);
		await startDelete(page, first);
		const dialog = await page.eval<{ live: boolean; focus: boolean }>(`({
			live: ${A}.deepAll(${A}.delPanel(), '[aria-live]').length > 0,
			focus: ${A}.contains(${A}.delButton('danger'), ${A}.deepActive()),
		})`);
		ok(
			"AI-49",
			"the delete confirmation is a live region and starts on its Delete button",
			dialog.live && dialog.focus,
			dialog,
			"aria-live present, focus on Delete",
		);
		await click(page, `${A}.delButton('tertiary')`);
		await sleep(300);
		await closeHistory(page);
	});

	// -- attachments ---------------------------------------------------------------------------------------
	//
	// Every case starts from its own fresh page and an empty conversation (freshChat), so one runs alone
	// with CF_AI_ONLY. AI-61 and AI-64 need the conversation AI-53 sent a file in. Files made by the page
	// are named "CF AI Test ...", which is how cleanup finds their File docs.

	await group("AI-50", async () => {
		await freshChat(page, "delete frappe.boot.flow_supported_file_types");
		const mark = netMark();
		const present = await page.eval<Record<string, boolean>>(`(() => {
			const h = document.getElementById('cf-ai-panel');
			const has = (sel) => !!h.querySelector(sel);
			return { actions: has('.cf-ai-actions'), attach: has('.cf-ai-attach'), input: has('.cf-ai-file-input'),
				uploads: has('cds-aichat-file-uploads'), strip: has('.cf-ai-upload-status'), error: has('.cf-ai-attach-error'), drop: has('.cf-ai-drop') };
		})()`);
		ok(
			"AI-50",
			"without flow's file types the composer has no attach button, input, chip list, strip, refusal line or drop overlay",
			Object.values(present).every((here) => !here),
			present,
			"every flag false",
		);
		const entered = await dragEvent(page, "dragenter", [NOTES]);
		const dropped = await dragEvent(page, "drop", [NOTES]);
		const pasted = await pasteFiles(page, [NOTES]);
		await sleep(500);
		ok(
			"AI-50",
			"a file drag, drop and paste behave as if the chat were not there: none is cancelled and no request starts",
			!entered.prevented &&
				!dropped.prevented &&
				!pasted &&
				netSince(mark, UPLOAD_URL).length + netSince(mark, ATTACH_URL).length === 0,
			{
				entered: entered.prevented,
				dropped: dropped.prevented,
				pasted,
				requests: netSince(mark, /upload_file|attach_file/).length,
			},
			"nothing prevented, no upload_file or attach_file request",
		);
		await say(page, "hello");
		ok(
			"AI-50",
			"a normal turn still works",
			(await lastAssistantText(page)).includes("CF AI Test reply"),
			(await lastAssistantText(page)).slice(0, 80),
			`"CF AI Test reply"`,
		);
	});

	await group("AI-51", async () => {
		await freshChat(page);
		const state = await page.eval<{
			actions: { slot: string | null; inShell: boolean } | null;
			input: {
				type: string;
				multiple: boolean;
				hidden: boolean;
				tabindex: string | null;
				accept: string;
			} | null;
			button: { action: string | null; tag: string } | null;
			types: string[];
			uploads: { slot: string | null; hasUploads: boolean } | null;
			stripHidden: boolean | null;
			errorHidden: boolean | null;
		}>(`(() => {
			const shell = document.querySelector('#cf-ai-panel .cf-ai-input');
			const actions = shell && shell.querySelector('.cf-ai-actions');
			const input = actions && actions.querySelector('input.cf-ai-file-input');
			const btn = actions && actions.querySelector('cds-icon-button.cf-ai-attach');
			const list = shell && shell.querySelector('cds-aichat-file-uploads.cf-ai-uploads');
			const stripEl = shell && shell.querySelector('.cf-ai-upload-status');
			const err = shell && shell.querySelector('.cf-ai-attach-error');
			return {
				actions: actions ? { slot: actions.getAttribute('slot'), inShell: actions.parentElement === shell } : null,
				input: input ? { type: input.type, multiple: input.multiple, hidden: input.hidden, tabindex: input.getAttribute('tabindex'), accept: input.getAttribute('accept') || '' } : null,
				button: btn ? { action: btn.getAttribute('data-action'), tag: btn.tagName.toLowerCase() } : null,
				types: (frappe.boot.flow_supported_file_types || []).map((t) => String(t).replace(/^\\./, '').toLowerCase()),
				uploads: list ? { slot: list.getAttribute('slot'), hasUploads: list.hasAttribute('has-uploads') } : null,
				stripHidden: stripEl ? stripEl.hidden : null,
				errorHidden: err ? err.hidden : null,
			};
		})()`);
		ok(
			"AI-51",
			"the actions slot holds a hidden multiple file input and the Attach icon button",
			state.actions?.slot === "message-actions" &&
				state.actions.inShell &&
				state.input?.type === "file" &&
				state.input.multiple &&
				state.input.hidden &&
				state.button?.action === "attach" &&
				state.button.tag === "cds-icon-button",
			state,
			`.cf-ai-actions[slot=message-actions] > input[type=file][multiple][hidden] + cds-icon-button.cf-ai-attach[data-action=attach]`,
		);
		const accepted = (state.input?.accept ?? "").split(",").filter((entry) => entry !== "");
		observed.accept = state.input?.accept ?? null;
		ok(
			"AI-51",
			"the input accepts exactly flow's supported types, as dotted extensions",
			accepted.length > 0 &&
				accepted.every((entry) => entry.startsWith(".")) &&
				JSON.stringify([...new Set(accepted.map((entry) => entry.slice(1).toLowerCase()))].sort()) ===
					JSON.stringify([...new Set(state.types)].sort()),
			{ accept: state.input?.accept, boot: state.types },
			`"." + each of frappe.boot.flow_supported_file_types`,
		);
		ok(
			"AI-51",
			"the input is out of the tab order",
			state.input?.tabindex === "-1" && state.input.hidden,
			state.input,
			`tabindex "-1" and hidden`,
		);
		const button = await attachState(page);
		ok(
			"AI-51",
			"the Attach button's accessible name is Attach files and it is enabled",
			button.exists && button.name === "Attach files" && !button.disabled,
			button,
			`name "Attach files", not disabled`,
		);
		ok(
			"AI-51",
			"the chip list sits in file-uploads with no chips; the strip and the refusal line are hidden",
			state.uploads?.slot === "file-uploads" &&
				!state.uploads.hasUploads &&
				state.stripHidden === true &&
				state.errorHidden === true,
			{ uploads: state.uploads, stripHidden: state.stripHidden, errorHidden: state.errorHidden },
			`slot "file-uploads", no has-uploads, strip hidden, refusal hidden`,
		);
		await page.eval(`${A}.attach().focus()`);
		const focused = (await attachState(page)).focused;
		ok("AI-51", "the Attach button can take focus", focused, focused, "true");
		await focusInput(page);
		await press(page, "Tab", SHIFT);
		const landed = await page.eval<{ button: boolean; active: string | null }>(`({
			button: ${A}.attachState().focused,
			active: (() => { const a = ${A}.deepActive(); return a ? a.tagName.toLowerCase() + (a.className && typeof a.className === 'string' ? '.' + a.className.split(' ')[0] : '') : null; })(),
		})`);
		ok(
			"AI-51",
			"Shift+Tab from the prompt line lands on the Attach button (it comes first in the tab order)",
			landed.button,
			landed,
			"the focus is inside cds-icon-button.cf-ai-attach",
		);
	});

	await group("AI-52", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const mark = netMark();
			const before = await fileNames(page);
			const release = await delayRequests(page, "*attach_file*", 1500);
			try {
				await startLive(page);
				const mode = await chooseFiles(page, () => click(page, `${A}.attach()`), [NOTES]);
				ok(
					"AI-52",
					"Attach opens the system picker for several files",
					mode === "selectMultiple",
					mode,
					`mode "selectMultiple"`,
				);
				const early = await waitChips(page, 1, () => true, 8000);
				const uploading = await strip(page);
				ok(
					"AI-52",
					"while flow reads the file the chip is uploading with no remove button, the strip shows and send is held",
					early[0]?.name === NOTES.name &&
						early[0].state === "uploading" &&
						!early[0].close &&
						uploading.shown &&
						(await sendBlocked(page)),
					{ chip: early[0], strip: uploading, sendBlocked: await sendBlocked(page) },
					`chip "${NOTES.name}" state uploading, no close; strip shown; disableSend true`,
				);
				const requestsBefore = posts(mark, START_RUN_URL).length;
				await typeAndEnter(page, "summarize");
				const log = await waitHeard(page, "polite", "Wait for the files to finish uploading.");
				ok(
					"AI-52",
					"Enter while a file is uploading sends nothing, keeps the draft and says why",
					posts(mark, START_RUN_URL).length === requestsBefore &&
						(await page.eval<string>(`${A}.prompt().getValue()`)) === "summarize" &&
						heard(log, "polite", "Wait for the files to finish uploading."),
					{ startRun: posts(mark, START_RUN_URL).length, heard: log },
					`no start_run, draft "summarize", polite "Wait for the files to finish uploading."`,
				);
				const staged = await waitChips(page, 1, isStaged, 20000);
				const done = await waitHeard(page, "polite", "The file was uploaded successfully.");
				const after = await strip(page);
				ok(
					"AI-52",
					"once flow has read it the chip can be removed, the strip is gone, send is free and the list said so",
					isStaged(staged[0] ?? NO_CHIP) &&
						!after.shown &&
						!(await sendBlocked(page)) &&
						heard(done, "polite", "The file was uploaded successfully."),
					{ chip: staged[0], strip: after, sendBlocked: await sendBlocked(page), heard: done },
					`state edit with a close button, strip hidden, disableSend false, polite "The file was uploaded successfully."`,
				);
				const order = netSince(mark, /upload_file|attach_file/).map(
					(n) => `${n.method} ${UPLOAD_URL.test(n.url) ? "upload_file" : "attach_file"}`,
				);
				ok(
					"AI-52",
					"the file is uploaded first and then handed to flow, once each",
					JSON.stringify(order) === JSON.stringify(["POST upload_file", "POST attach_file"]),
					order,
					`["POST upload_file", "POST attach_file"]`,
				);
				const docs = await filesSince(page, before, 1);
				ok(
					"AI-52",
					"the upload is one private File doc attached to nothing",
					docs.length === 1 &&
						docs[0]?.fileName === NOTES.name &&
						docs[0].isPrivate === 1 &&
						docs[0].attachedTo === "",
					docs,
					`one File "${NOTES.name}", is_private 1, no attached_to_doctype`,
				);

				// An image goes through OCR, which a bench may not have: either outcome passes, a hang does not.
				await pickFiles(page, [PNG]);
				const both = await waitChips(page, 2, (chip) => chip.state !== "uploading", 20000);
				const png = both[1] ?? NO_CHIP;
				ok(
					"AI-52",
					"an image ends as an attachment or as a visible error, and does not hang",
					both.length === 2 && png.state !== "uploading" && (isStaged(png) || png.invalid),
					png,
					"state edit (attached) or invalid within 20s",
				);
			} finally {
				await stopLive(page).catch(() => []);
				await release();
			}
		});
	});

	await group("AI-53", async () => {
		await freshChat(page);
		const before = await fileNames(page);
		await stage(page, [NOTES]);
		const docs = await filesSince(page, before, 1);
		const doc = docs[0]?.name ?? "";
		const mark = netMark();
		const mockMark = flowMock.requests.length;
		await say(page, "summarize this file");
		const composer = await chips(page);
		const idle = await strip(page);
		ok(
			"AI-53",
			"sending moves the chip out of the composer",
			composer.length === 0 && !idle.shown,
			{ chips: composer.length, strip: idle.shown },
			"no chip in the composer, strip hidden",
		);
		const wrap = await page.eval<{
			shown: boolean;
			role: string | null;
			label: string | null;
			items: number;
		}>(`(() => {
			const ul = ${A}.userRows().slice(-1)[0].querySelector('.cf-ai-message__files');
			return { shown: !!ul && !ul.hidden && ${A}.visible(ul), role: ul && ul.getAttribute('role'), label: ul && ul.getAttribute('aria-label'), items: ul ? ul.querySelectorAll('.cf-ai-message__file').length : -1 };
		})()`);
		const sent = await sentChips(page);
		ok(
			"AI-53",
			"the user message shows the file as one read-only chip keyed by its File doc",
			wrap.shown &&
				wrap.role === "list" &&
				wrap.items === 1 &&
				sent[0]?.name === NOTES.name &&
				sent[0].id === doc &&
				!sent[0].close,
			{ wrap, sent, doc },
			`one chip "${NOTES.name}", data-file-id = the File doc, no remove button`,
		);
		const body = posts(mark, START_RUN_URL)[0];
		ok(
			"AI-53",
			"start_run carries the typed text and the File doc name in attachments",
			dig(body, "input") === "summarize this file" &&
				JSON.stringify(attachmentsOf(body)) === JSON.stringify([doc]),
			{ input: dig(body, "input"), attachments: body?.["attachments"], doc },
			`input "summarize this file", attachments ["${doc}"]`,
		);
		const reads = flowMock.requests.slice(mockMark).filter((r) => r.attachedFiles.length > 0);
		const last = reads[reads.length - 1];
		ok(
			"AI-53",
			"the model received the file's name and text",
			reads.length === 1 &&
				last?.keyword === "FILES" &&
				JSON.stringify(last.attachedFiles) === JSON.stringify([NOTES.name]) &&
				last.lastUserText.includes(BODY) &&
				last.attachedChars >= BODY.length,
			reads.map((r) => ({ keyword: r.keyword, files: r.attachedFiles, chars: r.attachedChars })),
			`one request with attachedFiles ["${NOTES.name}"] whose text contains the body`,
		);
		ok(
			"AI-53",
			"the reply names the file the model read",
			(await lastAssistantText(page)).includes(`I read 1 file(s): ${NOTES.name}.`),
			(await lastAssistantText(page)).slice(0, 120),
			`"I read 1 file(s): ${NOTES.name}."`,
		);
		const session = await sessionName(page);
		const rows = await attachmentRows(page, session);
		const runs = await runsOf(page, session);
		const turnRun = str(runs[runs.length - 1]?.["name"]);
		ok(
			"AI-53",
			"flow stored one Inline attachment row for the turn's run",
			rows.length === 1 &&
				rows[0]?.["file"] === doc &&
				rows[0]["file_name"] === NOTES.name &&
				rows[0]["mode"] === "Inline" &&
				turnRun !== undefined &&
				rows[0]["run"] === turnRun,
			{
				rows: rows.map((r) => ({
					file: r["file"],
					file_name: r["file_name"],
					mode: r["mode"],
					run: r["run"],
				})),
				run: turnRun,
			},
			`one row: file "${doc}", file_name "${NOTES.name}", mode Inline, run = the turn's run`,
		);
		await sleep(2000);
		ok(
			"AI-53",
			"nothing deleted the sent File",
			await fileExists(page, doc),
			await fileExists(page, doc),
			"the File doc still exists after 2s",
		);
		attached.session = session;
		attached.doc = doc;
		attached.name = NOTES.name;
		attached.rows = await page.eval<number>(`${A}.rows().length`);
	});

	await group("AI-53b", async () => {
		await tolerate(async () => {
			await freshChat(page);
			await page.eval(`(delete window.__cfAiPwned, true)`);
			// What the panel's own DOM holds that a file name could have injected: counted before and after.
			const scan = (): Promise<{ pwned: unknown; images: number; bold: number; handlers: number }> =>
				page.eval(`(() => {
					const all = ${A}.deepAll(document.getElementById('cf-ai-panel'), '*');
					return {
						pwned: window.__cfAiPwned === undefined ? null : window.__cfAiPwned,
						images: all.filter((el) => el.tagName === 'IMG' && el.getAttribute('src') === 'x').length,
						bold: all.filter((el) => el.tagName === 'B').length,
						handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
					};
				})()`);
			const baseline = await scan();
			const before = await fileNames(page);
			const refusedName = "CF AI Test <b>bold</b>.exe";
			await pickFiles(page, [{ name: refusedName, text: "MZ" }]);
			await sleep(600);
			const line = await refusal(page);
			ok(
				"AI-53b",
				"a refused file's markup-laden name is shown as text in the refusal line",
				line.shown && line.description.includes(refusedName),
				line.description,
				`the description contains "${refusedName}" literally`,
			);
			const markup: FileSpec = { name: MARKUP_NAME, text: BODY, type: "text/plain" };
			const [chip] = await stage(page, [markup]);
			const docs = await filesSince(page, before, 1);
			ok(
				"AI-53b",
				"the chip shows the name as text and nothing in the panel was injected",
				chip?.name === MARKUP_NAME && JSON.stringify(await scan()) === JSON.stringify(baseline),
				{ chip: chip?.name, scan: await scan(), baseline },
				`chip text "${MARKUP_NAME}", no img, b or handler added, nothing ran`,
			);
			await say(page, "describe it");
			const sent = await sentChips(page);
			ok(
				"AI-53b",
				"the sent chip and the reply keep it inert too",
				sent.length === 1 &&
					sent[0]?.name === docs[0]?.fileName &&
					JSON.stringify(await scan()) === JSON.stringify(baseline),
				{ sent, file: docs[0]?.fileName, scan: await scan() },
				"the sent chip shows the stored file name as text; still nothing injected",
			);
		});
	});

	await group("AI-54", async () => {
		await freshChat(page);
		const before = await fileNames(page);
		await startLive(page);
		const mark = netMark();
		try {
			await stage(page, [NOTES, DATA]);
			const docs = await filesSince(page, before, 2);
			const first = docs.find((d) => d.fileName === NOTES.name);
			const second = docs.find((d) => d.fileName === DATA.name);
			await removeChip(page, 0);
			const left = await waitChips(page, 1, () => true, 1500);
			const log = await waitHeard(page, "polite", "File removed.");
			const button = await attachState(page);
			ok(
				"AI-54",
				"removing the first chip takes it out at once, the list says so and focus goes to Attach",
				left.length === 1 &&
					left[0]?.name === DATA.name &&
					heard(log, "polite", "File removed.") &&
					button.focused,
				{ chips: left.map((c) => c.name), heard: log, focused: button.focused },
				`one chip "${DATA.name}", polite "File removed.", focus on the Attach button`,
			);
			ok(
				"AI-54",
				"the removed file's File doc is deleted and the other one stays",
				first !== undefined &&
					second !== undefined &&
					(await fileGone(page, first.name, 4000)) &&
					(await fileExists(page, second.name)),
				{ first: first?.name, second: second?.name },
				"first File gone within 4s, second still there",
			);
			await say(page, "compare");
			const body = posts(mark, START_RUN_URL)[0];
			ok(
				"AI-54",
				"only the remaining file goes with the message and only it reaches the model",
				JSON.stringify(attachmentsOf(body)) === JSON.stringify([second?.name]) &&
					(await lastAssistantText(page)).includes(`I read 1 file(s): ${DATA.name}.`) &&
					!(await lastAssistantText(page)).includes(NOTES.name),
				{ attachments: body?.["attachments"], reply: (await lastAssistantText(page)).slice(0, 100) },
				`attachments ["${second?.name}"], reply names only "${DATA.name}"`,
			);
		} finally {
			await stopLive(page).catch(() => []);
		}
	});

	await group("AI-55", async () => {
		await freshChat(page, "frappe.boot.max_file_size = 2048");
		await startLive(page);
		const mark = netMark();
		const before = await fileNames(page);
		const uploadCount = (): number => netSince(mark, UPLOAD_URL).length;
		/** Pick files that must be refused, and check what the person sees and hears. */
		const refused = async (
			label: string,
			files: readonly FileSpec[],
			rule: string,
			mention: string | null,
		): Promise<Refusal> => {
			const uploadsBefore = uploadCount();
			await pickFiles(page, files);
			const log = await waitHeard(page, "assertive", rule);
			const seen = await refusal(page);
			ok(
				"AI-55",
				`${label}: the refusal line names the rule${mention === null ? "" : " and the file"}, the prompt shows an error and the assertive region says it`,
				seen.shown &&
					seen.title === "Files not attached" &&
					seen.description.includes(rule) &&
					(mention === null || seen.description.includes(mention)) &&
					seen.hasError &&
					heard(log, "assertive", rule),
				{ ...seen, heard: log.filter((l) => l.startsWith("assertive:")) },
				`title "Files not attached", description with "${rule}"${mention === null ? "" : ` and "${mention}"`}, has-error, assertive announcement`,
			);
			ok(
				"AI-55",
				`${label}: nothing was uploaded`,
				uploadCount() === uploadsBefore,
				uploadCount() - uploadsBefore,
				"0 new upload_file requests",
			);
			return seen;
		};
		/** One typed character is the user moving on: the line and the error state go. */
		const typeAway = async (label: string): Promise<void> => {
			await focusInput(page);
			await insertText(page, "x");
			const cleared = await eventually(
				() => refusal(page),
				(r) => !r.shown && !r.hasError,
				2000,
			);
			ok(
				"AI-55",
				`${label}: typing a character clears the line and the error state`,
				!cleared.shown && !cleared.hasError,
				cleared,
				"hidden, no has-error",
			);
			await press(page, "Backspace");
		};

		const wrongType = await refused(
			"an unsupported type",
			[{ name: "CF AI Test tool.exe", text: "MZ" }],
			"is not a supported file type",
			"CF AI Test tool.exe",
		);
		ok(
			"AI-55",
			"an unsupported type lists the types that would have been accepted",
			/Supported types: \w+(, \w+)+\./.test(wrongType.description),
			wrongType.description,
			`"Supported types: " and a comma-separated list`,
		);
		await typeAway("an unsupported type");

		const tooBig = await refused(
			"an oversize file",
			[{ name: "CF AI Test big.txt", bytes: 3000, type: "text/plain" }],
			"larger than the 2 KB limit",
			"CF AI Test big.txt",
		);
		observed.limitText = /larger than the (.+?) limit/.exec(tooBig.description)?.[1] ?? null;
		await typeAway("an oversize file");

		await refused(
			"an empty file",
			[{ name: "CF AI Test empty.txt", text: "", type: "text/plain" }],
			"is empty",
			"CF AI Test empty.txt",
		);
		await typeAway("an empty file");

		const several = await refused(
			"several unusable files",
			[
				{ name: "CF AI Test one.exe", text: "MZ" },
				{ name: "CF AI Test two.exe", text: "MZ" },
				{ name: "CF AI Test big2.txt", bytes: 3000, type: "text/plain" },
				{ name: "CF AI Test empty2.txt", text: "", type: "text/plain" },
			],
			"Not a supported file type: CF AI Test one.exe, CF AI Test two.exe.",
			"Empty: CF AI Test empty2.txt.",
		);
		ok(
			"AI-55",
			"several refusals are grouped by reason and the type list is left out once a second reason is present",
			several.description.includes("Too large (over 2 KB): CF AI Test big2.txt.") &&
				!several.description.includes("Supported types"),
			several.description,
			`"Too large (over 2 KB): CF AI Test big2.txt." and no "Supported types"`,
		);
		await typeAway("several unusable files");

		await pickFiles(page, [NOTES]);
		await waitChips(page, 1, () => true, 5000);
		await refused("the same file twice", [NOTES], "is already attached", NOTES.name);
		await typeAway("the same file twice");

		const extra = ["e1", "e2", "e3"].map((n): FileSpec => ({
			name: `CF AI Test ${n}.txt`,
			text: BODY,
			type: "text/plain",
		}));
		await pickFiles(page, [DATA, ...extra]);
		await waitChips(page, 5, () => true, 5000);
		await refused(
			"a sixth file",
			[{ name: "CF AI Test e4.txt", text: BODY, type: "text/plain" }],
			"You can attach at most 5 files.",
			null,
		);
		const five = await waitChips(page, 5, isStaged, 30000);
		ok(
			"AI-55",
			"the five accepted files all upload, and only they did",
			five.length === 5 && uploadCount() === 5,
			{ chips: five.map((c) => c.name), uploads: uploadCount() },
			"5 staged chips, 5 upload_file requests",
		);
		await stopLive(page).catch(() => []);
		await click(page, `${A}.action('New chat')`);
		await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
		const gone = await filesSince(page, before, 0, 10000);
		ok(
			"AI-55",
			"New chat discards the staged files and deletes their File docs",
			(await chips(page)).length === 0 && gone.length === 0,
			{ chips: (await chips(page)).length, files: gone.map((f) => f.name) },
			"no chips, no File docs left",
		);
	});

	await group("AI-56", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const before = await fileNames(page);
			const mark = netMark();
			await startLive(page);
			try {
				await pickFiles(page, [BLANK]);
				const [chip] = await waitChips(page, 1, (c) => c.invalid, 30000);
				ok(
					"AI-56",
					"a file flow cannot read ends as an invalid chip with flow's reason",
					chip?.invalid === true && chip.error.includes("No readable text found in this file."),
					chip,
					`invalid chip, reason "No readable text found in this file."`,
				);
				const line = await refusal(page);
				ok(
					"AI-56",
					"the failure line says what failed and what to do, and the prompt shows an error",
					line.shown &&
						line.title === "File upload error" &&
						line.description.includes("No readable text found in this file.") &&
						line.description.includes("Remove the attachment and try again.") &&
						line.hasError,
					line,
					`title "File upload error", reason and "Remove the attachment and try again.", has-error`,
				);
				const log = await waitHeard(page, "assertive", `${BLANK.name}: No readable text found in this file.`);
				ok(
					"AI-56",
					"the assertive region names the file and the reason",
					heard(log, "assertive", `${BLANK.name}: No readable text found in this file.`),
					log.filter((l) => l.startsWith("assertive:")),
					`assertive "${BLANK.name}: No readable text found in this file."`,
				);
				const startRuns = posts(mark, START_RUN_URL).length;
				await typeAndEnter(page, "describe it");
				const refusedSend = await waitHeard(
					page,
					"assertive",
					"Remove the files that failed to upload, then send.",
				);
				ok(
					"AI-56",
					"send is held while a file has failed: nothing is sent and the assertive region says why",
					(await sendBlocked(page)) &&
						posts(mark, START_RUN_URL).length === startRuns &&
						heard(refusedSend, "assertive", "Remove the files that failed to upload, then send."),
					{
						sendBlocked: await sendBlocked(page),
						startRuns: posts(mark, START_RUN_URL).length,
						heard: refusedSend.filter((l) => l.startsWith("assertive:")),
					},
					`disableSend true, no start_run, assertive "Remove the files that failed to upload, then send."`,
				);
				ok(
					"AI-56",
					"the orphaned File doc is deleted",
					(await filesSince(page, before, 0, 8000)).length === 0 && netSince(mark, UPLOAD_URL).length === 1,
					(await filesSince(page, before, 0, 100)).map((f) => f.name),
					"the upload happened once and no File doc remains",
				);
				await removeChip(page, 0);
				const cleared = await eventually(
					() => refusal(page),
					(r) => !r.shown && !r.hasError,
					2000,
				);
				ok(
					"AI-56",
					"removing the failed chip clears the line, the error state and the send hold",
					(await chips(page)).length === 0 &&
						!cleared.shown &&
						!cleared.hasError &&
						!(await sendBlocked(page)),
					{ line: cleared, sendBlocked: await sendBlocked(page) },
					"no chip, line hidden, no has-error, disableSend false",
				);

				// A dropped connection is a failure too; removing the chip and picking again is the retry.
				const dropMark = netMark();
				const cut = await intercept(page, ["*upload_file*"], () => ({ kind: "fail" }));
				try {
					await pickFiles(page, [NOTES]);
					const [down] = await waitChips(page, 1, (c) => c.invalid, 15000);
					const lost = await refusal(page);
					ok(
						"AI-56",
						"a dropped connection ends as an invalid chip with a connection message, and flow is never asked",
						down?.invalid === true &&
							down.error.includes("The upload failed. Check your connection and try again.") &&
							lost.shown &&
							lost.title === "File upload error" &&
							(await sendBlocked(page)) &&
							netSince(dropMark, ATTACH_URL).length === 0,
						{ chip: down, line: lost },
						`invalid chip "The upload failed. Check your connection and try again.", failure line, send held, no attach_file`,
					);
				} finally {
					await cut();
				}
				await removeChip(page, 0);
				const again = await stage(page, [NOTES], 20000);
				ok(
					"AI-56",
					"once the connection is back, picking the file again attaches it",
					again.length === 1 && !(await sendBlocked(page)) && !(await refusal(page)).shown,
					{ chips: again, sendBlocked: await sendBlocked(page) },
					"one staged chip, send free, no failure line",
				);
			} finally {
				await stopLive(page).catch(() => []);
			}
		});
	});

	await group("AI-57", async () => {
		await freshChat(page);
		await startLive(page);
		const mark = netMark();
		try {
			const enter = await dragEvent(page, "dragenter", [NOTES]);
			const over = await dragEvent(page, "dragover", [NOTES]);
			await dragEvent(page, "dragover", [NOTES]);
			const shown = await page.eval<{
				exists: boolean;
				shown: boolean;
				ariaHidden: string | null;
				dragging: boolean;
			}>(`${A}.dropState()`);
			const said = await waitHeard(page, "polite", "Drop files to attach them to your message.");
			await sleep(800);
			const times = await page.eval<number>(`${A}.liveCount("Drop files to attach them to your message.")`);
			ok(
				"AI-57",
				"a file drag over the panel shows the overlay, marks the shell and tells a screen reader once",
				shown.shown &&
					shown.dragging &&
					shown.ariaHidden === "true" &&
					enter.prevented &&
					over.prevented &&
					over.dropEffect === "copy" &&
					times === 1,
				{ shown, enter: enter.prevented, over, times, said: said.filter((l) => l.includes("Drop files")) },
				"overlay shown, shell.cf-ai-shell--dragging, dragenter and dragover cancelled, dropEffect copy, one announcement",
			);
			await dragEvent(page, "dragleave", [NOTES]);
			const left = await page.eval<{ shown: boolean; dragging: boolean }>(`${A}.dropState()`);
			ok(
				"AI-57",
				"leaving hides the overlay and clears the class",
				!left.shown && !left.dragging,
				left,
				"both off",
			);

			const text = await dragEvent(page, "dragenter", "some dragged words");
			const textOver = await dragEvent(page, "dragover", "some dragged words");
			const quiet = await page.eval<{ shown: boolean; dragging: boolean }>(`${A}.dropState()`);
			ok(
				"AI-57",
				"a drag that carries no files is not touched: no overlay and nothing cancelled",
				!quiet.shown && !quiet.dragging && !text.prevented && !textOver.prevented,
				{ quiet, text: text.prevented, over: textOver.prevented },
				"no overlay, no cancelled event",
			);

			await dragEvent(page, "dragenter", [NOTES]);
			const drop = await dragEvent(page, "drop", [NOTES]);
			const [chip] = await waitChips(page, 1, () => true, 5000);
			const done = await page.eval<{ shown: boolean; dragging: boolean }>(`${A}.dropState()`);
			ok(
				"AI-57",
				"dropping a file cancels the drop, hides the overlay and starts the upload",
				drop.prevented &&
					!done.shown &&
					!done.dragging &&
					chip?.name === NOTES.name &&
					netSince(mark, UPLOAD_URL).length === 1,
				{ drop: drop.prevented, overlay: done, chip: chip?.name, uploads: netSince(mark, UPLOAD_URL).length },
				`drop cancelled, overlay off, chip "${NOTES.name}", one upload_file request`,
			);
			await waitChips(page, 1, isStaged, 20000);
		} finally {
			await stopLive(page).catch(() => []);
		}

		// An approval card is waiting: nothing can be attached, and a drop says why instead of doing nothing.
		await click(page, `${A}.action('New chat')`);
		await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
		await askToCreate(7150);
		const blockedMark = netMark();
		const enterBlocked = await dragEvent(page, "dragenter", [NOTES]);
		const overBlocked = await dragEvent(page, "dragover", [NOTES]);
		const overlay = await page.eval<{ shown: boolean; dragging: boolean }>(`${A}.dropState()`);
		const dropBlocked = await dragEvent(page, "drop", [NOTES]);
		await sleep(400);
		const why = await refusal(page);
		ok(
			"AI-57",
			"with an approval pending there is no overlay, but a drop is cancelled and the refusal line says why",
			!overlay.shown &&
				!overlay.dragging &&
				enterBlocked.prevented &&
				overBlocked.dropEffect === "none" &&
				dropBlocked.prevented &&
				why.shown &&
				why.description.includes("Answer the assistant's question before attaching files.") &&
				netSince(blockedMark, UPLOAD_URL).length === 0,
			{ overlay, dropEffect: overBlocked.dropEffect, drop: dropBlocked.prevented, refusal: why },
			`no overlay, dropEffect none, drop cancelled, "Answer the assistant's question before attaching files.", no upload`,
		);
	});

	await group("AI-58", async () => {
		await freshChat(page);
		const pasted = await pasteFiles(page, [
			{ name: "CF AI Test pasted.txt", text: BODY, type: "text/plain" },
		]);
		const [chip] = await waitChips(page, 1, () => true, 5000);
		ok(
			"AI-58",
			"pasting a file (and nothing else) into the prompt cancels the paste and attaches it",
			pasted && chip?.name === "CF AI Test pasted.txt",
			{ prevented: pasted, chip: chip?.name },
			"defaultPrevented true, a chip named CF AI Test pasted.txt",
		);
		await waitChips(page, 1, isStaged, 20000);
		const html = await pasteFiles(page, [{ name: "CF AI Test cells.txt", text: BODY, type: "text/plain" }], {
			html: "<table><tr><td>1</td></tr></table>",
		});
		const words = await pasteFiles(page, [], { text: "plain words" });
		await sleep(500);
		ok(
			"AI-58",
			"a paste that also carries html, and a plain text paste, are left to the text box",
			!html && !words && (await chipNames(page)).length === 1,
			{ html, words, chips: await chipNames(page) },
			"neither cancelled, still one chip",
		);
	});

	await group("AI-56b", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const before = await fileNames(page);
			await startLive(page);
			try {
				const failures: Array<[string, Verdict, string]> = [
					[
						"a file flow cannot parse (a 500 with only a traceback line)",
						{ kind: "reply", status: 500, body: { exception: "zipfile.BadZipFile: File is not a zip file" } },
						"The file could not be read.",
					],
					[
						"an expired session (a 403 with no message)",
						{ kind: "reply", status: 403, body: {} },
						"Your session may have expired. Reload the page and try again.",
					],
				];
				for (const [label, verdict, text] of failures) {
					const mark = netMark();
					const release = await intercept(page, ["*attach_file*"], () => verdict);
					try {
						await pickFiles(page, [NOTES]);
						const [chip] = await waitChips(page, 1, (c) => c.invalid, 15000);
						const line = await refusal(page);
						ok(
							"AI-56",
							`${label} ends as an invalid chip with a sentence written for people and a failure line that ends it with a period`,
							chip?.invalid === true &&
								chip.error === text &&
								line.title === "File upload error" &&
								line.description === `${text} Remove the attachment and try again.`,
							{ chip, line },
							`invalid chip "${text}", line "${text} Remove the attachment and try again."`,
						);
						ok(
							"AI-56",
							`${label}: the File doc that was uploaded is deleted`,
							(await filesSince(page, before, 0, 8000)).length === 0 &&
								netSince(mark, UPLOAD_URL).length === 1,
							(await filesSince(page, before, 0, 100)).map((f) => f.name),
							"one upload, no File doc left",
						);
					} finally {
						await release();
					}
					await removeChip(page, 0);
				}
			} finally {
				await stopLive(page).catch(() => []);
			}
		});
	});

	await group("AI-59", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const cancels = watchCancellations();
			const hold = await holdRequests(page, "*upload_file*");
			try {
				await startLive(page);
				const mark = netMark();
				await pickFiles(page, [NOTES]);
				await waitChips(page, 1, () => true, 5000);
				await until(() => hold.paused().length === 1, 5000);
				const running = await strip(page);
				ok(
					"AI-59",
					"while the upload is in flight the strip shows a progress bar and a Cancel button",
					running.shown && running.bar && running.cancel && hold.paused().length === 1,
					{ strip: running, held: hold.paused().length },
					"strip shown with bar and cancel; one upload_file held",
				);
				await click(page, `document.querySelector('#cf-ai-panel [data-action="cancel-uploads"]')`);
				const log = await waitHeard(page, "polite", "Upload cancelled.");
				await sleep(500);
				const after = await strip(page);
				ok(
					"AI-59",
					"Cancel removes the chip, hides the strip, says so and returns focus to Attach",
					(await chips(page)).length === 0 &&
						!after.shown &&
						heard(log, "polite", "Upload cancelled.") &&
						(await attachState(page)).focused,
					{
						chips: (await chips(page)).length,
						strip: after.shown,
						heard: log,
						focused: (await attachState(page)).focused,
					},
					`no chip, strip hidden, polite "Upload cancelled.", focus on Attach`,
				);
				ok(
					"AI-59",
					"the browser saw the upload aborted and flow was never asked to read it",
					cancels.urls().some((u) => UPLOAD_URL.test(u)) && netSince(mark, ATTACH_URL).length === 0,
					{ cancelled: cancels.urls(), attach: netSince(mark, ATTACH_URL).length },
					"upload_file cancelled, no attach_file request",
				);
			} finally {
				await stopLive(page).catch(() => []);
				await hold.stop();
			}

			// A staged file is a draft: starting over deletes it.
			const before = await fileNames(page);
			await stage(page, [NOTES]);
			const [doc] = await filesSince(page, before, 1);
			await click(page, `${A}.action('New chat')`);
			await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
			ok(
				"AI-59",
				"New chat clears a staged file and deletes its File doc",
				(await chips(page)).length === 0 && doc !== undefined && (await fileGone(page, doc.name, 5000)),
				{ chips: (await chips(page)).length, doc: doc?.name },
				"no chip, File doc gone within 5s",
			);

			const second = await holdRequests(page, "*upload_file*");
			try {
				const mark = netMark();
				await pickFiles(page, [DATA]);
				await until(() => second.paused().length === 1, 5000);
				await click(page, `${A}.action('New chat')`);
				await page.waitFor(`${A}.rows().length === 0`, { timeout: 5000 });
				await sleep(800);
				ok(
					"AI-59",
					"New chat aborts an upload in flight and flow is never asked to read it",
					(await chips(page)).length === 0 &&
						cancels.urls().filter((u) => UPLOAD_URL.test(u)).length === 2 &&
						netSince(mark, ATTACH_URL).length === 0,
					{
						chips: (await chips(page)).length,
						cancelled: cancels.urls().length,
						attach: netSince(mark, ATTACH_URL).length,
					},
					"no chip, a second cancelled upload_file, no attach_file",
				);
			} finally {
				await second.stop();
				cancels.stop();
			}
		});
	});

	await group("AI-59b", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const cancels = watchCancellations();
			const before = await fileNames(page);
			await startLive(page);
			try {
				// The last byte is out and frappe has made the File, but the page has not heard so: the request must
				// run to its end, because there is no name to delete until it does.
				const held = await holdRequests(page, "*upload_file*", "Response");
				try {
					const mark = netMark();
					await pickFiles(page, [NOTES]);
					await waitChips(page, 1, () => true, 5000);
					await until(() => held.paused().length === 1, 8000);
					const [created] = await filesSince(page, before, 1, 8000);
					await click(page, `document.querySelector('#cf-ai-panel [data-action="cancel-uploads"]')`);
					const log = await waitHeard(page, "polite", "Upload cancelled.");
					await sleep(500);
					ok(
						"AI-59",
						"Cancel after the last byte removes the chip at once and does not abort the request",
						created !== undefined &&
							(await chips(page)).length === 0 &&
							heard(log, "polite", "Upload cancelled.") &&
							!cancels.urls().some((u) => UPLOAD_URL.test(u)),
						{ chips: (await chips(page)).length, cancelled: cancels.urls(), file: created?.name },
						"no chip, polite 'Upload cancelled.', upload_file not cancelled",
					);
					await held.release();
					ok(
						"AI-59",
						"when the reply arrives the File doc is deleted and flow is never asked to read it",
						created !== undefined &&
							(await fileGone(page, created.name, 10000)) &&
							netSince(mark, ATTACH_URL).length === 0 &&
							(await chips(page)).length === 0,
						{ file: created?.name, attach: netSince(mark, ATTACH_URL).length },
						"File doc gone within 10s, no attach_file, no chip",
					);
				} finally {
					await held.stop();
				}

				// The upload is done and flow is reading the file (progress is 99%): Cancel must not leave the File behind.
				const before2 = await fileNames(page);
				const release = await delayRequests(page, "*attach_file*", 3000);
				try {
					await pickFiles(page, [DATA]);
					await waitChips(page, 1, () => true, 5000);
					const [made] = await filesSince(page, before2, 1, 8000);
					await click(page, `document.querySelector('#cf-ai-panel [data-action="cancel-uploads"]')`);
					await waitHeard(page, "polite", "Upload cancelled.");
					ok(
						"AI-59",
						"Cancel while flow reads the file deletes the File doc and leaves no chip",
						made !== undefined &&
							(await fileGone(page, made.name, 10000)) &&
							(await chips(page)).length === 0 &&
							(await filesSince(page, before2, 0, 8000)).length === 0,
						{ file: made?.name, chips: (await chips(page)).length },
						"no chip, File doc gone, none left",
					);
				} finally {
					await release();
				}
			} finally {
				cancels.stop();
				await stopLive(page).catch(() => []);
			}
		});
	});

	await group("AI-60", async () => {
		await freshChat(page);
		const sentence = "CF AI Test attachment body alpha beta gamma delta epsilon.\n";
		const large: FileSpec = {
			name: "CF AI Test large.txt",
			text: sentence,
			repeat: Math.ceil((600 * 1024) / sentence.length),
			type: "text/plain",
		};
		const readings: number[] = [];
		let seconds = 0;
		try {
			await page.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: 150 * 1024,
			});
			const began = Date.now();
			await pickFiles(page, [large]);
			const deadline = Date.now() + 45000;
			while (Date.now() < deadline) {
				const s = await strip(page);
				if (s.now !== null) readings.push(Number(s.now));
				const all = await chips(page);
				if (all.length === 1 && isStaged(all[0] ?? NO_CHIP)) break;
				await sleep(100);
			}
			seconds = Math.round((Date.now() - began) / 100) / 10;
		} finally {
			await page.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
		}
		const middle = readings.filter((v) => v >= 1 && v <= 99);
		const finished = await strip(page);
		ok(
			"AI-60",
			"the progress bar reports a value between 1 and 99 while the bytes go out",
			middle.length > 0,
			{ readings: [...new Set(readings)].slice(0, 12), seconds },
			"at least one aria-valuenow between 1 and 99 (if seconds is near 0 the throttle did not slow the upload)",
		);
		ok(
			"AI-60",
			"afterwards the strip is gone and the chip can be removed",
			!finished.shown && (await chips(page)).length === 1 && isStaged((await chips(page))[0] ?? NO_CHIP),
			{ strip: finished.shown, chips: await chips(page) },
			"strip hidden, one staged chip",
		);
	});

	await group("AI-61", async () => {
		if (attached.session === "") {
			fail(
				"AI-61",
				"needs the conversation AI-53 sent a file in",
				"AI-53 did not run or failed before it saved its session",
			);
			return;
		}
		await page.eval(`(localStorage.setItem('cf-ai-session', ${q(attached.session)}), true)`);
		await startCase(page);
		await page.waitFor(`${A}.userRows().length > 0`, { timeout: 20000 });
		await sleep(500);
		const wrap = await page.eval<{
			role: string | null;
			label: string | null;
			shown: boolean;
			rows: number;
		}>(`(() => {
			const ul = ${A}.userRows().slice(-1)[0].querySelector('.cf-ai-message__files');
			return { role: ul && ul.getAttribute('role'), label: ul && ul.getAttribute('aria-label'), shown: !!ul && !ul.hidden && ${A}.visible(ul), rows: ${A}.rows().length };
		})()`);
		const sent = await sentChips(page);
		ok(
			"AI-61",
			"after a reload the conversation shows the same chip, restored from flow's attachment rows",
			wrap.shown &&
				wrap.role === "list" &&
				wrap.label === "Attachments" &&
				sent.length === 1 &&
				sent[0]?.name === attached.name &&
				sent[0].id === attached.doc &&
				!sent[0].close,
			{ wrap, sent },
			`one chip "${attached.name}" with data-file-id "${attached.doc}", no remove button, role list, aria-label "Attachments"`,
		);
		ok(
			"AI-61",
			"the restored conversation has the rows it had",
			wrap.rows === attached.rows,
			wrap.rows,
			String(attached.rows),
		);
	});

	await group("AI-62", async () => {
		await freshChat(page);
		await askToCreate(7151);
		const mark = netMark();
		const button = await attachState(page);
		await pickFiles(page, [NOTES]);
		await sleep(500);
		const line = await refusal(page);
		ok(
			"AI-62",
			"with an approval pending the Attach button is disabled and a picker choice is refused with the reason",
			button.disabled &&
				line.shown &&
				line.description.includes("Answer the assistant's question before attaching files.") &&
				netSince(mark, UPLOAD_URL).length === 0 &&
				(await chips(page)).length === 0,
			{ attach: button, refusal: line },
			"Attach disabled, the refusal sentence, no upload, no chip",
		);
		await click(page, `${A}.cardButton('other')`);
		await page.waitFor(`${A}.visible(${A}.card().querySelector('.cf-ai-approval__redirect'))`, {
			timeout: 5000,
		});
		const pastedIn = await pasteFiles(page, [NOTES], {}, "#cf-ai-panel .cf-ai-approval__redirect");
		await sleep(300);
		ok(
			"AI-62",
			"a file pasted into the approval card's own text box is left alone",
			!pastedIn && (await chips(page)).length === 0 && netSince(mark, UPLOAD_URL).length === 0,
			{ prevented: pastedIn, chips: (await chips(page)).length },
			"not cancelled, no chip, no upload",
		);
		await typeAndEnter(page, "use a shorter description");
		const answered = await until(() => posts(mark, RESUME_RUN_URL).length > 0, 5000);
		await waitIdle(page);
		const resume = posts(mark, RESUME_RUN_URL)[0];
		ok(
			"AI-62",
			"answering the approval from the main prompt resumes the run and carries no attachments",
			answered && resume !== undefined && resume !== null && !("attachments" in resume),
			resume,
			"a resume_run body without an attachments key",
		);

		// Staging is allowed while a reply streams; the file goes with the next message.
		const before = await fileNames(page);
		await say(page, "SLOW hello", false);
		await page.waitFor(`${A}.send().isStopStreamingButtonVisible`, { timeout: 30000 });
		await stage(page, [NOTES]);
		const [doc] = await filesSince(page, before, 1);
		const streaming = await page.eval<boolean>(`${A}.send().isStopStreamingButtonVisible`);
		const startRuns = posts(mark, START_RUN_URL).length;
		const userRows = await page.eval<number>(`${A}.userRows().length`);
		await focusInput(page);
		await insertText(page, "queued");
		await press(page, "Enter");
		await sleep(400);
		ok(
			"AI-62",
			"a file can be staged while a reply streams; Stop is offered and Enter sends nothing",
			streaming &&
				posts(mark, START_RUN_URL).length === startRuns &&
				(await page.eval<number>(`${A}.userRows().length`)) === userRows,
			{ streaming, startRun: posts(mark, START_RUN_URL).length - startRuns },
			"Stop visible, no new start_run, no new user row",
		);
		await click(page, `${A}.send().shadowRoot.querySelector('cds-aichat-stop-streaming-button')`);
		await page.waitFor(`!!${A}.lastAssistant().querySelector('.cf-ai-stopped')`, { timeout: 10000 });
		await waitIdle(page);
		const draft = await page.eval<string>(`${A}.prompt().getValue()`);
		const later = netMark();
		await focusInput(page);
		if (draft === "") await insertText(page, "after stop");
		await press(page, "Enter");
		await page.waitFor(`${A}.userRows().length > ${userRows}`, { timeout: 10000 });
		await waitIdle(page);
		ok(
			"AI-62",
			"after Stop the next message carries the staged file",
			JSON.stringify(attachmentsOf(posts(later, START_RUN_URL)[0])) === JSON.stringify([doc?.name]) &&
				(await lastAssistantText(page)).includes(`I read 1 file(s): ${NOTES.name}.`),
			{ attachments: posts(later, START_RUN_URL)[0]?.["attachments"], doc: doc?.name, draft },
			`attachments ["${doc?.name}"] and a reply naming "${NOTES.name}"`,
		);
	});

	await group("AI-63", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const before = await fileNames(page);
			await stage(page, [NOTES]);
			const [doc] = await filesSince(page, before, 1);
			const mark = netMark();
			const mockMark = flowMock.requests.length;
			await say(page, "FLAKY cfai63", false);
			await page.waitFor(`!!${A}.lastAssistant() && !!${A}.lastAssistant().querySelector('.cf-ai-error')`, {
				timeout: 90000,
			});
			await waitIdle(page);
			await click(page, `document.querySelector('#cf-ai-panel [data-action="retry-reply"]')`);
			await page.waitFor(`${A}.userRows().length >= 2`, { timeout: 15000 }).catch(() => {});
			await waitIdle(page);
			const bodies = posts(mark, START_RUN_URL);
			ok(
				"AI-63",
				"Try again sends the same files: both start_run bodies carry the File doc",
				bodies.length === 2 &&
					bodies.every((b) => JSON.stringify(attachmentsOf(b)) === JSON.stringify([doc?.name])),
				bodies.map((b) => b?.["attachments"]),
				`two start_run bodies with attachments ["${doc?.name}"]`,
			);
			const reads = flowMock.requests.slice(mockMark).filter((r) => r.attachedFiles.length > 0);
			ok(
				"AI-63",
				"the model received the file text on both attempts and the second succeeded",
				reads.length === 2 &&
					reads.every((r) => r.lastUserText.includes(BODY)) &&
					(await lastAssistantText(page)).includes("CF AI Test reply"),
				reads.map((r) => ({ keyword: r.keyword, chars: r.attachedChars })),
				"two requests with the body in the user turn, then the default reply",
			);
			const rows = await page.eval<string[][]>(
				`${A}.userRows().map((row) => ${A}.sentChips(row).map((c) => c.name))`,
			);
			ok(
				"AI-63",
				"the retried message shows the chip too",
				rows.length >= 1 && (rows[rows.length - 1] ?? []).includes(NOTES.name),
				rows,
				`the last user row has a chip "${NOTES.name}"`,
			);
			ok(
				"AI-63",
				"retrying made no second File doc",
				(await filesSince(page, before, 1, 1000)).length === 1,
				(await filesSince(page, before, 1, 100)).map((f) => f.name),
				"exactly one File doc",
			);
		});
	});

	await group("AI-64", async () => {
		if (attached.session === "") {
			fail(
				"AI-64",
				"needs the conversation AI-53 sent a file in",
				"AI-53 did not run or failed before it saved its session",
			);
			return;
		}
		await startCase(page);
		const existed = await fileExists(page, attached.doc);
		await openHistory(page);
		await waitItem(page, attached.session);
		await startDelete(page, attached.session);
		await click(page, `${A}.delButton('danger')`);
		await page.waitFor(`!${A}.itemOf(${q(attached.session)}) && !${A}.delPanel()`, { timeout: 10000 });
		ok(
			"AI-64",
			"deleting a conversation removes it, and the File it was sent with existed until then",
			existed && !(await sessionExists(page, attached.session)),
			{ existedBefore: existed, session: attached.session },
			"the File doc existed before; the session is gone",
		);
		// Flow deletes a session's File docs only in its 30-day purge (clear_old_logs), not when a person deletes
		// the conversation, so they stay behind as private, unattached Files. That is reported, not failed: the
		// suite's own cleanup removes them, and the fix belongs in flow (Flow Session.on_trash should call _delete_attachment_files).
		if (!(await fileGone(page, attached.doc, 4000))) {
			console.log(
				`KNOWN AI-64  flow keeps the sent File "${attached.doc}" after its conversation is deleted (only its retention purge deletes Files)`,
			);
		}
		await closeHistory(page);
	});

	await group("AI-65", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const release = await delayRequests(page, "*attach_file*", 2500);
			try {
				await pickFiles(page, [NOTES]);
				await waitChips(page, 1, () => true, 5000);
				const during = await strip(page);
				const hostNames = await page.eval<{
					unnamed: string[];
					cancelLabel: string | null;
					input: { hidden: boolean; tabindex: string | null } | null;
				}>(`(() => {
					const cancel = document.querySelector('#cf-ai-panel [data-action="cancel-uploads"]'); const input = ${A}.fileInput();
					return { unnamed: ${A}.unnamed(document.getElementById('cf-ai-panel')), cancelLabel: cancel && cancel.getAttribute('aria-label'),
						input: input ? { hidden: input.hidden, tabindex: input.getAttribute('tabindex') } : null };
				})()`);
				const button = await attachState(page);
				ok(
					"AI-65",
					"while uploading: the Attach button, the progress bar and Cancel have names, and no button is unnamed",
					button.name !== "" &&
						during.shown &&
						during.role === "progressbar" &&
						!!during.label &&
						!!hostNames.cancelLabel &&
						hostNames.unnamed.length === 0,
					{ attach: button.name, strip: during, cancel: hostNames.cancelLabel, unnamed: hostNames.unnamed },
					"a named Attach button, role progressbar with aria-label, a named Cancel, no unnamed button",
				);
				ok(
					"AI-65",
					"the hidden input is not a tab stop",
					hostNames.input?.hidden === true && hostNames.input.tabindex === "-1",
					hostNames.input,
					`hidden, tabindex "-1"`,
				);
			} finally {
				await release();
			}
			await waitChips(page, 1, isStaged, 20000);

			await pickFiles(page, [{ name: "CF AI Test tool.exe", text: "MZ" }]);
			await sleep(400);
			const line = await refusal(page);
			ok(
				"AI-65",
				"the refusal line is not a role=alert (the panel announcer says it once)",
				line.shown && !line.alert,
				line,
				"shown, no role alert",
			);

			// the keyboard alone opens the picker and chooses files
			await page.eval(`${A}.attach().focus()`);
			const byEnter = await chooseFiles(page, () => press(page, "Enter"), [DATA]);
			await waitChips(page, 2, isStaged, 20000);
			await page.eval(`${A}.attach().focus()`);
			const bySpace = await chooseFiles(page, () => press(page, " "), [MARKDOWN]);
			const three = await waitChips(page, 3, isStaged, 20000);
			ok(
				"AI-65",
				"Enter and Space on the Attach button each open the picker; real files from disk attach",
				byEnter === "selectMultiple" &&
					bySpace === "selectMultiple" &&
					JSON.stringify(three.map((c) => c.name)) === JSON.stringify([NOTES.name, DATA.name, MARKDOWN.name]),
				{ byEnter, bySpace, chips: three.map((c) => c.name) },
				`both open a "selectMultiple" picker; chips ${JSON.stringify([NOTES.name, DATA.name, MARKDOWN.name])}`,
			);

			await closePanelWithTrigger(page);
			const stops = await page.eval<string[]>(`${A}.tabStops(document.getElementById('cf-ai-panel'))`);
			ok("AI-65", "a closed host with staged files holds no tab stop", stops.length === 0, stops, "[]");
			await openPanel(page);

			await say(page, "summarize");
			await say(page, "hello");
			const lists = await page.eval<
				Array<{ role: string | null; label: string | null; hidden: boolean; items: number }>
			>(`${A}.userRows().map((row) => {
				const ul = row.querySelector('.cf-ai-message__files');
				return { role: ul && ul.getAttribute('role'), label: ul && ul.getAttribute('aria-label'), hidden: !!ul && (ul.hidden || !${A}.visible(ul)), items: ul ? ul.querySelectorAll('.cf-ai-message__file').length : -1 };
			})`);
			ok(
				"AI-65",
				"each user message has a labelled list; it holds the chips for a message with files and is hidden for one without",
				lists.length === 2 &&
					lists.every((l) => l.role === "list" && !!l.label) &&
					lists[0]?.items === 3 &&
					!lists[0].hidden &&
					lists[1]?.items === 0 &&
					lists[1].hidden,
				lists,
				"two lists with role list and an aria-label: 3 chips visible, then 0 hidden",
			);
		});
	});

	await group("AI-66", async () => {
		await tolerate(async () => {
			await freshChat(page);
			const original = await page.eval<string | null>(`document.documentElement.getAttribute('data-theme')`);
			await pickFiles(page, [NOTES, DATA, BLANK]);
			const three = await waitChips(page, 3, (c) => c.state !== "uploading", 30000);
			ok(
				"AI-66",
				"two files attach and the unreadable one is shown as failed beside them",
				three.length === 3 &&
					isStaged(three[0] ?? NO_CHIP) &&
					isStaged(three[1] ?? NO_CHIP) &&
					three[2]?.invalid === true,
				three,
				"two staged chips and one invalid chip",
			);
			for (const theme of ["light", "dark"] as const) {
				await page.eval(`document.documentElement.setAttribute('data-theme', ${q(theme)})`);
				await sleep(500);
				await page.screenshot(`${SHOT}/assistant-attachments-${theme}.png`);
			}
			if (original === null) await page.eval(`document.documentElement.removeAttribute('data-theme')`);
			else await page.eval(`document.documentElement.setAttribute('data-theme', ${q(original)})`);

			await viewport(page, 360, 800);
			await page.screenshot(`${SHOT}/assistant-attachments-360.png`);
			const dir = await page.eval<string | null>(`document.documentElement.getAttribute('dir')`);
			// The chips scroll sideways inside their own list (Carbon's uploaded-files strip), so the check is that the
			// list and the composer stay within the panel; `scrolls` records that the overflow is contained.
			const measure = (): Promise<{
				scroll: number;
				client: number;
				listInside: boolean;
				scrolls: boolean;
			}> =>
				page.eval(`(() => {
					const input = document.querySelector('#cf-ai-panel .cf-ai-input'); const h = document.getElementById('cf-ai-panel').getBoundingClientRect();
					const list = ${A}.uploads(); const l = list.getBoundingClientRect();
					const box = list.shadowRoot ? list.shadowRoot.querySelector('.cds-aichat--file-uploads-container') : null;
					return { scroll: input.scrollWidth, client: input.clientWidth, listInside: l.left >= h.left - 1 && l.right <= h.right + 1,
						scrolls: !!box && box.scrollWidth > box.clientWidth };
				})()`);
			const ltr = await measure();
			await page.eval(`document.documentElement.dir = 'rtl'`);
			await sleep(500);
			const rtl = await measure();
			await page.screenshot(`${SHOT}/assistant-attachments-360-rtl.png`);
			await page.eval(
				dir === null
					? `document.documentElement.removeAttribute('dir')`
					: `document.documentElement.setAttribute('dir', ${q(dir)})`,
			);
			await viewport(page, 1600, 1000);
			for (const [name, m] of [
				["left to right", ltr],
				["right to left", rtl],
			] as const) {
				ok(
					"AI-66",
					`at 360px, ${name}: the composer does not overflow and the chip list stays inside the panel`,
					m.scroll <= m.client && m.listInside,
					m,
					"composer scrollWidth <= clientWidth, chip list within the host",
				);
			}

			await removeChip(page, 2);
			await waitChips(page, 2, isStaged, 5000);
			await say(page, "compare");
			const align = await page.eval<{ bubble: number; chips: number; count: number }>(`(() => {
				const row = ${A}.userRows().slice(-1)[0];
				const bubble = row.querySelector('.cf-ai-message__bubble').getBoundingClientRect();
				const chips = [...row.querySelectorAll('.cf-ai-message__file')].map((c) => c.getBoundingClientRect());
				return { bubble: Math.round(bubble.right), chips: Math.round(Math.max(...chips.map((c) => c.right))), count: chips.length };
			})()`);
			ok(
				"AI-66",
				"the chips under a sent message end at the bubble's right edge",
				align.count === 2 && Math.abs(align.bubble - align.chips) <= 2,
				align,
				"2 chips, their right edge within 2px of the bubble's",
			);
		});
	});

	await group("AI-67", async () => {
		await freshChat(page);
		const boot = await page.eval<{ types: string[]; max: number | null }>(`({
			types: (frappe.boot.flow_supported_file_types || []).map((t) => String(t).replace(/^\\./, '').toLowerCase()),
			max: typeof frappe.boot.max_file_size === 'number' && frappe.boot.max_file_size > 0 ? frappe.boot.max_file_size : null,
		})`);
		const expectedAccept = [...new Set(boot.types)].sort().map((t) => `.${t}`);
		const accept = (await page.eval<string>(`${A}.fileInput().getAttribute('accept') || ''`)).split(",");
		ok(
			"AI-67",
			"the picker's accept list is flow's list, read from the boot data now",
			JSON.stringify([...accept].sort()) === JSON.stringify([...expectedAccept].sort()),
			{ accept, expected: expectedAccept },
			"the boot types as dotted extensions",
		);
		ok(
			"AI-67",
			"it is the list AI-51 saw",
			observed.accept === null ||
				JSON.stringify(observed.accept.split(",").sort()) === JSON.stringify([...expectedAccept].sort()),
			{ before: observed.accept, now: accept },
			observed.accept === null ? "AI-51 did not run (nothing to compare)" : "the same list",
		);
		const limit = boot.max ?? 5 * 1024 * 1024;
		await pickFiles(page, [{ name: "CF AI Test huge.txt", bytes: limit + 1, type: "text/plain" }]);
		await sleep(600);
		const seen = await refusal(page);
		ok(
			"AI-67",
			"a file one byte over the site's limit is refused with that limit spelled out",
			seen.shown && seen.description.includes(`larger than the ${sizeText(limit)} limit`),
			seen.description,
			`"larger than the ${sizeText(limit)} limit" (max_file_size ${limit})`,
		);
		ok(
			"AI-67",
			"and the limit's wording follows the unit rule AI-55 saw",
			observed.limitText === null || observed.limitText === sizeText(2048),
			{ ai55: observed.limitText, expected: sizeText(2048) },
			observed.limitText === null ? "AI-55 did not run (nothing to compare)" : `"${sizeText(2048)}"`,
		);
	});

	await group("AI-23", async () => {
		const from = Date.now();
		const uncaughtBefore = errors.filter((e) => e.kind === "uncaught").length;
		await page.eval(`${A}.flowHide()`);
		await closePanelWithTrigger(page);
		await page.send("Network.setBlockedURLs", { urls: ["*/dist/ai_chat/*"] });
		try {
			await freshPage(page);
			await click(page, trigger, false);
			await page.waitFor(
				`!!document.querySelector('#cf-ai-panel .cf-ai-status .cds--inline-notification--error[role="alert"]')`,
				{ timeout: 20000 },
			);
			const failure = await page.eval<{
				text: string;
				retry: boolean;
				retryHeight: number;
				flowButton: boolean;
				chat: boolean;
			}>(`(() => {
				const s = document.querySelector('#cf-ai-panel .cf-ai-status');
				const retry = s.querySelector('[data-action="retry"]');
				return { text: ${A}.deepText(s), retry: !!retry, retryHeight: retry ? retry.getBoundingClientRect().height : 0, flowButton: !!s.querySelector('[data-action="flow"]'), chat: document.body.classList.contains('cf-ai-chat') };
			})()`);
			ok(
				"AI-23",
				"a blocked bundle shows the inline error with Retry and Open the Flow panel, and releases the takeover",
				failure.text.includes("The AI assistant could not be loaded") &&
					failure.retry &&
					failure.flowButton &&
					!failure.chat,
				{ ...failure, text: failure.text.slice(0, 140) },
				`title copy, [data-action=retry], [data-action=flow], no body.cf-ai-chat`,
			);
			ok(
				"AI-23",
				"Retry is a touch-sized target",
				failure.retryHeight >= 32,
				failure.retryHeight,
				"height >= 32",
			);
			// Escape on the failure block closes the panel (no chat owns the key yet) and gives focus back
			await page.eval(`document.querySelector('#cf-ai-panel [data-action="retry"]').focus()`);
			await press(page, "Escape");
			await sleep(500);
			const afterEscape = await page.eval<{ open: boolean; active: string | null }>(`({
				open: ${A}.isOpen(), active: document.activeElement ? document.activeElement.id : null,
			})`);
			ok(
				"AI-23",
				"Escape on Retry closes the panel and returns focus to the trigger",
				!afterEscape.open && afterEscape.active === "cf-ai-trigger",
				afterEscape,
				`closed, activeElement #cf-ai-trigger`,
			);
			// still blocked: opening again lands on the failure block, which the steps below start from
			await click(page, trigger, false);
			await page.waitFor(`!!document.querySelector('#cf-ai-panel [data-action="retry"]')`, {
				timeout: 20000,
			});
			await page.eval(`document.body.focus()`);
			await press(page, "i", CTRL);
			await sleep(500);
			const handed = await page.eval<{ flow: unknown; root: string | null }>(`({
				flow: ${A}.flowVisible(), root: document.getElementById('flow-root') ? getComputedStyle(document.getElementById('flow-root')).display : null,
			})`);
			ok(
				"AI-23",
				"Ctrl+I now opens flow's panel",
				handed.flow === true && handed.root !== "none",
				handed,
				`panel.visible true, #flow-root shown`,
			);
			await page.eval(`${A}.flowHide()`);
			await sleep(300);
			await page.send("Network.setBlockedURLs", { urls: [] });
			if (!(await flag(page, `${A}.isOpen()`))) await click(page, trigger, false);
			await click(page, `document.querySelector('#cf-ai-panel [data-action="retry"]')`);
			await waitMounted(page).catch(() => {});
			await page.waitFor(`!!${A}.shell()`, { timeout: 30000 });
			const recovered = await page.eval<{ chat: boolean; root: string | null }>(`({
				chat: document.body.classList.contains('cf-ai-chat'), root: document.getElementById('flow-root') ? getComputedStyle(document.getElementById('flow-root')).display : null,
			})`);
			ok(
				"AI-23",
				"Retry mounts the chat and takes flow's panel over again",
				recovered.chat && recovered.root === "none",
				recovered,
				`body.cf-ai-chat, #flow-root display none`,
			);
			const wasOpen = await flag(page, `${A}.isOpen()`);
			if (wasOpen) await closePanelWithTrigger(page);
			await page.eval(`document.body.focus()`);
			await press(page, "i", CTRL);
			await page.waitFor(`${A}.isOpen()`, { timeout: 10000 });
			const ours = await page.eval<unknown>(`${A}.flowVisible()`);
			ok("AI-23", "Ctrl+I opens ours again, not flow's", ours !== true, ours, "flow.panel.visible not true");
			await closePanelWithTrigger(page);

			await page.send("Network.setBlockedURLs", { urls: ["*/dist/ai_chat/*"] });
			await freshPage(page);
			await click(page, trigger, false);
			await page.waitFor(`!!document.querySelector('#cf-ai-panel [data-action="flow"]')`, { timeout: 20000 });
			await click(page, `document.querySelector('#cf-ai-panel [data-action="flow"]')`);
			await sleep(600);
			const toFlow = await page.eval<{ flow: unknown; ours: boolean; expanded: string | null }>(`({
				flow: ${A}.flowVisible(), ours: ${A}.isOpen(), expanded: ${trigger}.getAttribute('aria-expanded'),
			})`);
			ok(
				"AI-23",
				"Open the Flow panel shows flow's and closes ours",
				toFlow.flow === true && !toFlow.ours && toFlow.expanded === "false",
				toFlow,
				`panel.visible true, ours closed`,
			);
			await page.eval(`${A}.flowHide()`);

			// Only the entry module fails: the manifest answers, so this is a failed import(), which the
			// browser caches until the page reloads and the panel therefore offers a reload for
			await page.send("Network.setBlockedURLs", { urls: ["*/dist/ai_chat/entry.*.js"] });
			await freshPage(page);
			await click(page, trigger, false);
			await page.waitFor(`!!document.querySelector('#cf-ai-panel [data-action="retry"]')`, {
				timeout: 20000,
			});
			const reloadOffered = await page.eval<boolean>(
				`!!document.querySelector('#cf-ai-panel .cf-ai-status [data-action="reload"]')`,
			);
			ok(
				"AI-23",
				"a failed entry import offers Reload the page beside Retry",
				reloadOffered,
				reloadOffered,
				`[data-action=reload] in the failure block`,
			);
			await page.send("Network.setBlockedURLs", { urls: [] });
			await click(page, `document.querySelector('#cf-ai-panel [data-action="retry"]')`);
			await page.waitFor(`!!${A}.shell()`, { timeout: 30000 });
			const mounted = await flag(page, `!!document.querySelector('#cf-ai-panel cds-aichat-shell')`);
			ok(
				"AI-23",
				"Retry mounts the chat once the entry is reachable again",
				mounted,
				mounted,
				`cds-aichat-shell inside #cf-ai-panel`,
			);
			await page.eval(`${A}.flowHide()`);
		} finally {
			await page.send("Network.setBlockedURLs", { urls: [] });
			tolerated.push([from, Date.now() + 2000]);
		}
		const uncaught = errors
			.filter((e) => e.kind === "uncaught")
			.slice(uncaughtBefore)
			.map((e) => e.text);
		ok("AI-23", "the failure paths raised no unhandled error", uncaught.length === 0, uncaught, "[]");
		await freshPage(page);
	});

	// -- teardown, then the run-wide check -----------------------------------------------------

	const problems = await cleanup(page);
	run.fixtures = problems.length > 0;
	ok(
		"AI-00",
		"cleanup removed every CF AI Test document",
		problems.length === 0,
		problems.join("; ") || undefined,
		"nothing left behind",
	);
	console.log(results[results.length - 1]);
	await page.eval(
		`(localStorage.removeItem('cf-ai-agent'), localStorage.removeItem('cf-ai-session'), localStorage.removeItem('cf-ai-panel'), true)`,
	);
	await flowMock.close();
	run.mock = null;

	const stray = errors.filter(
		(e) =>
			e.at >= run.startedAt &&
			!/favicon/.test(e.text) &&
			!tolerated.some(([a, b]) => e.at >= a && e.at <= b && e.kind === "console"),
	);
	ok(
		"AI-25",
		"no console error or unhandled exception across the run",
		stray.length === 0,
		stray.map((e) => `${e.kind}: ${e.text}`).slice(0, 5),
		"[]",
	);
	console.log(results[results.length - 1]);
}
