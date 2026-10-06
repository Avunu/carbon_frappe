import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./globals.ts";
import { activeHref, readModel, readSidebar } from "../../carbon_frappe/public/js/anatomy/shell/model.ts";
import type { RowNode } from "../../carbon_frappe/public/js/anatomy/shell/model.ts";

// There is no DOM under node:test. The sidebar walk reads a handful of selectors off whatever it is
// handed (shell/model.ts `RowNode`), so a tree of nodes that answer exactly those selectors, by
// their text, is enough to run it.

interface NodeInit {
	classes?: string[];
	attrs?: Record<string, string>;
	text?: string;
}

class FakeNode implements RowNode {
	readonly classList: { contains(token: string): boolean };
	readonly textContent: string | null;
	private readonly attrs: Record<string, string>;
	private readonly answers = new Map<string, FakeNode[]>();

	constructor(init: NodeInit = {}) {
		const classes = new Set(init.classes ?? []);
		this.classList = { contains: (token) => classes.has(token) };
		this.attrs = init.attrs ?? {};
		this.textContent = init.text ?? null;
	}

	/** Make `selectors` answer with `nodes` when asked of this node. */
	answer(selectors: string, ...nodes: FakeNode[]): this {
		this.answers.set(selectors, nodes);
		return this;
	}

	getAttribute(name: string): string | null {
		return this.attrs[name] ?? null;
	}
	querySelector(selectors: string): FakeNode | null {
		return this.answers.get(selectors)?.[0] ?? null;
	}
	querySelectorAll(selectors: string): FakeNode[] {
		return this.answers.get(selectors) ?? [];
	}
}

const ANCHOR = ":scope > .standard-sidebar-item > .item-anchor";
const LABEL = ":scope > .sidebar-item-label";
const NESTED = ":scope > .nested-container";
const CHILDREN = ":scope > .sidebar-item-container";
const ROWS = ":scope .sidebar-items > .sidebar-item-container";

/** One `.sidebar-item-container` with its anchor and label, as sidebar_item.html renders them. */
function row(
	label: string,
	anchor: { href?: string; target?: string } | null,
	classes: string[] = [],
): FakeNode {
	const container = new FakeNode({ classes: ["sidebar-item-container", ...classes] });
	if (!anchor) return container;
	const attrs: Record<string, string> = {};
	if (anchor.href) attrs["href"] = anchor.href;
	if (anchor.target) attrs["target"] = anchor.target;
	const a = new FakeNode({ attrs });
	a.answer(LABEL, new FakeNode({ text: ` ${label} ` }));
	return container.answer(ANCHOR, a);
}

/** A Section Break: a `.section-item` whose children are in its `.nested-container`. */
function section(label: string, children: FakeNode[]): FakeNode {
	const container = row(label, {}, ["section-item"]);
	return container.answer(NESTED, new FakeNode().answer(CHILDREN, ...children));
}

describe("readSidebar (sidebar_item.html)", () => {
	beforeEach(() => {
		// `leaf()` turns an anchor with no href into a delegated action only when it is an HTMLElement
		Object.assign(globalThis, { HTMLElement: FakeNode });
	});

	it("reads links in order, with their href and target", () => {
		const body = new FakeNode().answer(
			ROWS,
			row("Home", { href: "/desk/projects" }),
			row("Docs", { href: "https://docs.example", target: "_blank" }),
		);
		assert.deepEqual(readSidebar(body), [
			{ kind: "link", key: "0", label: "Home", href: "/desk/projects", target: null },
			{ kind: "link", key: "1", label: "Docs", href: "https://docs.example", target: "_blank" },
		]);
	});

	it("reads a Section Break with children as a group, and its href-less children as actions", () => {
		const body = new FakeNode().answer(
			ROWS,
			row("Task", { href: "/desk/projects/task" }),
			section("Setup", [row("Activity Type", { href: "/desk/projects/activity-type" }), row("Toggle", {})]),
		);
		const items = readSidebar(body);
		assert.equal(items.length, 2);
		const group = items[1];
		assert.equal(group?.kind, "group");
		assert.deepEqual(group?.kind === "group" ? group.items.map((i) => [i.kind, i.key, i.label]) : [], [
			["link", "1/0", "Activity Type"],
			["action", "1/1", "Toggle"],
		]);
	});

	it("skips spacers and chrome (no label), and a section with nothing under it", () => {
		const spacer = new FakeNode({ classes: ["sidebar-item-container"] }).answer(
			ANCHOR,
			new FakeNode().answer(LABEL, new FakeNode({ text: "" })),
		);
		const body = new FakeNode().answer(
			ROWS,
			spacer,
			section("Empty", []),
			row("Home", { href: "/desk/projects" }),
		);
		assert.deepEqual(
			readSidebar(body).map((i) => i.label),
			["Home"],
		);
	});

	it("trims labels", () => {
		const body = new FakeNode().answer(ROWS, row("  Padded ", { href: "/desk/x" }));
		assert.equal(readSidebar(body)[0]?.label, "Padded");
	});
});

describe("activeHref (the one row frappe lit, sidebar.js:513-518, 547-575)", () => {
	const SELECTOR = ".body-sidebar .sidebar-items .active-sidebar > a.item-anchor[href]";
	afterEach(() => {
		Object.assign(globalThis, { document: undefined });
	});

	it("is the href of the anchor under `.active-sidebar`, scoped to the sidebar's rows", () => {
		const anchor = new FakeNode({ attrs: { href: "/desk/projects/task" } });
		Object.assign(globalThis, {
			document: { querySelector: (s: string) => (s === SELECTOR ? anchor : null) },
		});
		assert.equal(activeHref(), "/desk/projects/task");
	});
	it("is null when no row is lit", () => {
		Object.assign(globalThis, { document: { querySelector: () => null } });
		assert.equal(activeHref(), null);
	});
});

interface SidebarInit {
	module?: string | undefined;
	expanded?: boolean;
	/** Whether the page on screen allows the panel / the dock: both false is the launcher. */
	panel?: boolean;
	dock?: boolean;
	display?: string;
	label?: string | undefined;
	app?: { app_name: string; app_title: string } | null;
	landing?: string | null;
	rows?: FakeNode[];
}

/** `frappe.app.sidebar`, reduced to what `readModel` reads. */
function installSidebar(init: SidebarInit): void {
	const body = new FakeNode().answer(ROWS, ...(init.rows ?? []));
	const sidebar = {
		current_module: init.module,
		sidebar_expanded: init.expanded ?? true,
		sidebar_data: init.label === undefined ? undefined : { label: init.label },
		wrapper: { get: () => body },
		page_allows_sidebar: () => init.panel ?? true,
		page_allows_dock: () => init.dock ?? true,
		get_sidebar_app: () => init.app ?? null,
		module_landing_route: () => init.landing ?? null,
	};
	Object.assign(globalThis, {
		getComputedStyle: () => ({ display: init.display ?? "block" }),
	});
	Object.assign(globalThis.frappe, { app: { sidebar } });
}

describe("readModel (what the header shows, from frappe.app.sidebar)", () => {
	beforeEach(() => {
		Object.assign(globalThis, { HTMLElement: FakeNode });
	});

	it("names '<app title> <module label>' and links to the module's landing route", () => {
		installSidebar({
			module: "Projects",
			label: "Projects",
			app: { app_name: "erpnext", app_title: "ERPNext" },
			landing: "/desk/projects",
			rows: [row("Home", { href: "/desk/projects/home" })],
		});
		const m = readModel();
		assert.equal(m.prefix, "ERPNext");
		assert.equal(m.name, "Projects");
		assert.equal(m.module, "Projects");
		assert.equal(m.home, "/desk/projects");
		assert.equal(m.navHidden, false);
		assert.equal(m.items.length, 1);
	});

	it("falls back to the first rendered link, then to /desk, when the module has no landing route", () => {
		installSidebar({ module: "M", label: "M", rows: [row("A", { href: "/desk/m/a" })] });
		assert.equal(readModel().home, "/desk/m/a");
		installSidebar({ module: "M", label: "M" });
		assert.equal(readModel().home, "/desk");
	});

	it("names the module by its key when the sidebar carries no label, and has no prefix without an app", () => {
		installSidebar({ module: "Private", label: undefined, app: null });
		const m = readModel();
		assert.equal(m.name, "Private");
		assert.equal(m.prefix, "");
		assert.equal(m.app, null);
	});

	it("is the launcher where the page allows neither the panel nor the dock, whatever shell is held", () => {
		installSidebar({ module: "Accounts", label: "Accounts", panel: false, dock: false, display: "none" });
		const m = readModel();
		assert.equal(m.name, "Desktop");
		assert.equal(m.module, "");
		assert.equal(m.prefix, "");
		assert.equal(m.navHidden, true);
		assert.equal(m.menuDisabled, true);
		assert.deepEqual(m.items, []);
	});

	it("is a module page where only the dock is hidden", () => {
		installSidebar({ module: "Projects", label: "Projects", dock: false });
		assert.equal(readModel().name, "Projects");
	});

	it("is the launcher before any shell is chosen", () => {
		installSidebar({ module: undefined });
		assert.equal(readModel().name, "Desktop");
	});

	it("disables the hamburger only while the wrapper is not drawn, not while the sidebar is collapsed", () => {
		installSidebar({ module: "P", label: "P", display: "none" });
		assert.equal(readModel().menuDisabled, true);
		// collapsed beside a pinned dock: the wrapper is drawn (its panel is 0 wide) and the control
		// that brings the sidebar back must stay usable
		installSidebar({ module: "P", label: "P", expanded: false });
		const m = readModel();
		assert.equal(m.menuDisabled, false);
		assert.equal(m.expanded, false);
	});

	it("changes its signature when the name, the links or the visibility change, and only then", () => {
		installSidebar({ module: "P", label: "P", rows: [row("A", { href: "/desk/p/a" })] });
		const a = readModel().signature;
		assert.equal(readModel().signature, a);
		installSidebar({ module: "P", label: "P", rows: [row("A", { href: "/desk/p/b" })] });
		assert.notEqual(readModel().signature, a);
		installSidebar({ module: "P", label: "Q", rows: [row("A", { href: "/desk/p/a" })] });
		assert.notEqual(readModel().signature, a);
		// the expanded state is not part of what the nav renders from
		installSidebar({ module: "P", label: "P", expanded: false, rows: [row("A", { href: "/desk/p/a" })] });
		assert.equal(readModel().signature, a);
	});
});
