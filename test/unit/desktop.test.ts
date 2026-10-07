import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./globals.ts";
import { buildAppsTree, buildDesktopTree } from "../../carbon_frappe/public/js/anatomy/shell/desktop.ts";
import type { IconRoute } from "../../carbon_frappe/public/js/anatomy/shell/desktop.ts";
import type { FrappeBootAppEntry, FrappeDesktopIconRecord } from "frappe-types";

// -- the Apps screen (the default desktop) -----------------------------------------

type AppInput = Pick<FrappeBootAppEntry, "app_name"> & Partial<FrappeBootAppEntry>;

/** An `app_data` entry as `get_app_data` returns it, with every member present. */
function app(input: AppInput): FrappeBootAppEntry {
	return {
		on_apps_screen: true,
		sequence_id: 100,
		app_title: input.app_name,
		app_route: "",
		desk_route: "",
		app_logo_url: null,
		dock: [],
		...input,
	};
}

// the dev bench's shape, reduced: Framework trails (it declares 1000), two apps tie at the default
// order, one is off the screen, and one has no route of its own
const framework = app({
	app_name: "frappe",
	app_title: "Framework",
	sequence_id: 1000,
	app_route: "/app/build",
});
const erpnext = app({ app_name: "erpnext", app_title: "ERPNext", sequence_id: 1, app_route: "/desk/home" });
const apps: FrappeBootAppEntry[] = [
	framework,
	erpnext,
	app({ app_name: "telephony", app_title: "Telephony", on_apps_screen: false }),
	app({ app_name: "helpdesk", app_title: "Helpdesk", app_route: "/helpdesk" }),
	app({ app_name: "hrms", app_title: "Frappe HR" }),
	app({ app_name: "wiki", app_title: "Wiki", app_route: "https://wiki.example" }),
];

/** `sidebar.app_landing_route`: the app's declared route is what it returns when it has one. */
const landing = (a: FrappeBootAppEntry): string | null => a.app_route || null;

describe("buildAppsTree (DesktopPage.render_app_icons, desktop.js:169-212)", () => {
	const tree = buildAppsTree(apps, "erpnext", landing);

	it("lists the apps on the apps screen by sequence_id, ties in installed order, Framework last", () => {
		assert.deepEqual(
			tree.map((e) => e.label),
			["erpnext", "helpdesk", "hrms", "wiki", "frappe"],
		);
	});
	it("leaves out an app that did not opt into the screen", () => {
		assert.ok(!tree.some((e) => e.label === "telephony"));
	});
	it("leads where the tile does: the landing route, else the app's route, else /desk", () => {
		assert.equal(tree.find((e) => e.label === "erpnext")?.href, "/desk/home");
		assert.equal(tree.find((e) => e.label === "hrms")?.href, "/desk");
		// the landing route wins over the declared one
		const t = buildAppsTree([framework], null, () => "/desk/build/todo");
		assert.equal(t[0]?.href, "/desk/build/todo");
	});
	it("opens an absolute URL in a new tab and nothing else", () => {
		assert.equal(tree.find((e) => e.label === "wiki")?.target, "_blank");
		assert.equal(tree.find((e) => e.label === "helpdesk")?.target, null);
	});
	it("selects the app that owns the shell on screen, and none on the launcher", () => {
		assert.deepEqual(
			tree.filter((e) => e.selected).map((e) => e.label),
			["erpnext"],
		);
		assert.ok(buildAppsTree(apps, null, landing).every((e) => !e.selected));
	});
	it("is flat: no row has children (the dock is the module switcher)", () => {
		assert.ok(tree.every((e) => e.children.length === 0));
	});
	it("shows the translated title, keeping the app name as the row's identity", () => {
		const t = buildAppsTree([erpnext], null, landing, (s) => `<${s}>`);
		assert.equal(t[0]?.title, "<ERPNext>");
		assert.equal(t[0]?.label, "erpnext");
	});
});

// -- the Desktop Icon grid (the retiring desktop) ------------------------------------

type IconInput = Pick<FrappeDesktopIconRecord, "label"> & Partial<FrappeDesktopIconRecord>;

/** A Desktop Icon row as boot.py returns it, with every column present. */
function icon(input: IconInput): FrappeDesktopIconRecord {
	return {
		bg_color: null,
		link: null,
		link_type: "Workspace Sidebar",
		app: "erpnext",
		icon_type: "Link",
		parent_icon: null,
		icon: null,
		link_to: input.label,
		idx: 0,
		standard: 1,
		logo_url: null,
		hidden: 0,
		name: input.label,
		restrict_removal: 0,
		icon_image: null,
		module: input.label,
		...input,
	};
}

// a hidden App icon whose children promote, a Folder with children, an App with children, and
// plain workspaces; idx ties are left to the label, as the grid leaves them
const boot: FrappeDesktopIconRecord[] = [
	icon({
		label: "Framework",
		icon_type: "App",
		link_type: "External",
		link: "/desk/build",
		app: "frappe",
		idx: 3,
	}),
	icon({ label: "Users", parent_icon: "Framework", app: "frappe", idx: 2 }),
	icon({ label: "Build", parent_icon: "Framework", app: "frappe", idx: 1 }),
	icon({ label: "Frappe CRM", icon_type: "App", link_type: "External", link: "/crm", app: "crm", idx: 1 }),
	icon({ label: "Accounting", icon_type: "Folder", link_to: "", idx: 2 }),
	icon({ label: "Payments", parent_icon: "Accounting", idx: 2 }),
	icon({ label: "Invoicing", parent_icon: "Accounting", idx: 1 }),
	icon({ label: "Buying", parent_icon: "ERPNext", idx: 5 }),
	icon({ label: "Assets", parent_icon: "ERPNext", idx: 5 }),
	icon({ label: "Home", hidden: 1 }),
	icon({ label: "Empty Folder", icon_type: "Folder", link_to: "" }),
	icon({ label: "Broken", parent_icon: null, idx: 9 }),
	icon({ label: "ERPNext", icon_type: "App", link_type: "External", link: "/app/home", hidden: 1, idx: 100 }),
];

/** The grid's `get_route`: what an icon opens, and the shell it names. `Broken` resolves to nothing. */
const resolve = (i: FrappeDesktopIconRecord): IconRoute | null => {
	if (i.label === "Broken") return null;
	if (i.link_type === "External") return { href: i.link ?? "", shell: null };
	return { href: `/desk/${i.label.toLowerCase()}`, shell: i.label };
};

describe("buildDesktopTree (the Desktop Icon grid, desktop_icons.bundle.js)", () => {
	const tree = buildDesktopTree(boot, "Invoicing", resolve);
	const labels = tree.map((e) => e.label);

	it("sorts by idx, then label, drops hidden icons and promotes orphans of a hidden parent", () => {
		// Frappe CRM (1), Accounting (2), Framework (3), then the promoted idx 5 pair by label
		assert.deepEqual(labels, ["Frappe CRM", "Accounting", "Framework", "Assets", "Buying"]);
	});
	it("nests under a Folder AND under an App with children, one level, in the grid's order, no href on the parent", () => {
		const accounting = tree.find((e) => e.label === "Accounting");
		assert.deepEqual(
			accounting?.children.map((c) => [c.label, c.href]),
			[
				["Invoicing", "/desk/invoicing"],
				["Payments", "/desk/payments"],
			],
		);
		assert.equal(accounting?.href, null);
		const fw = tree.find((e) => e.label === "Framework");
		assert.deepEqual(
			fw?.children.map((c) => c.label),
			["Build", "Users"],
		);
		assert.equal(fw?.href, null);
	});
	it("drops an empty Folder and an icon the grid cannot route", () => {
		assert.ok(!labels.includes("Empty Folder"));
		assert.ok(!labels.includes("Broken"));
	});
	it("selects the icon that opens the shell on screen, nested or not", () => {
		const invoicing = tree
			.find((e) => e.label === "Accounting")
			?.children.find((c) => c.label === "Invoicing");
		assert.equal(invoicing?.selected, true);
		assert.equal(tree.find((e) => e.label === "Assets")?.selected, false);
		assert.equal(buildDesktopTree(boot, "Assets", resolve).find((e) => e.label === "Assets")?.selected, true);
	});
	it("selects nothing on the launcher", () => {
		const t = buildDesktopTree(boot, "", resolve);
		assert.ok(t.every((e) => !e.selected && e.children.every((c) => !c.selected)));
	});
	it("opens absolute URLs in a new tab", () => {
		const t = buildDesktopTree(
			[icon({ label: "Docs", link_type: "External", link: "https://docs.example" })],
			"",
			resolve,
		);
		assert.equal(t[0]?.target, "_blank");
		assert.equal(tree.find((e) => e.label === "Frappe CRM")?.target, null);
	});
});
