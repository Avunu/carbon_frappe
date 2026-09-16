import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routes } from "./globals.ts";
import { buildDesktopTree } from "../../carbon_frappe/public/js/anatomy/shell/desktop.ts";
import type {
	FrappeDesktopIconRecord,
	FrappeWorkspaceSidebar,
	FrappeWorkspaceSidebarItem,
} from "frappe-types";

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
		...input,
	};
}

// the dev bench's shape, reduced: a hidden App icon whose children promote,
// a Folder with children, an App with children, and plain workspaces
const boot: FrappeDesktopIconRecord[] = [
	icon({ label: "Framework", icon_type: "App", link_type: "External", link: "/desk/build", app: "frappe" }),
	icon({ label: "Build", parent_icon: "Framework", app: "frappe" }),
	icon({ label: "Users", parent_icon: "Framework", app: "frappe" }),
	icon({ label: "Frappe CRM", icon_type: "App", link_type: "External", link: "/crm", app: "crm" }),
	icon({ label: "Accounting", icon_type: "Folder", link_to: "" }),
	icon({ label: "Invoicing", parent_icon: "Accounting", idx: 1 }),
	icon({ label: "Payments", parent_icon: "Accounting", idx: 2 }),
	icon({ label: "Assets", parent_icon: "ERPNext" }),
	icon({ label: "Buying", parent_icon: "ERPNext" }),
	icon({ label: "Home", hidden: 1 }),
	icon({ label: "Empty Folder", icon_type: "Folder", link_to: "" }),
	icon({ label: "Broken", parent_icon: null }),
	icon({ label: "My Workspaces", app: "frappe" }),
	icon({ label: "ERPNext", icon_type: "App", link_type: "External", link: "/app/home", hidden: 1, idx: 100 }),
];

/** A Workspace Sidebar Item as boot.py serialises it, with every column present. */
const link: FrappeWorkspaceSidebarItem = {
	label: "x",
	link_to: "x",
	link_type: "Workspace",
	type: "Link",
	icon: null,
	child: 0,
	collapsible: 0,
	indent: 0,
	keep_closed: 0,
	url: null,
	show_arrow: 0,
	filters: null,
	route_options: null,
	tab: null,
};

const sidebars: Record<string, FrappeWorkspaceSidebar> = {
	"my workspaces": {
		label: "My Workspaces",
		items: [],
		header_icon: null,
		module_onboarding: null,
		module: null,
		app: "frappe",
	},
};

routes.clear();
for (const [label, href] of [
	["Framework", "/desk/build"],
	["Build", "/desk/build"],
	["Users", "/desk/users"],
	["Frappe CRM", "/crm"],
	["Invoicing", "/desk/invoicing"],
	["Payments", "/desk/payments"],
	["Assets", "/desk/assets"],
	["Buying", "/desk/buying"],
	["Home", "/desk"],
	["My Workspaces", "/desk/private"],
]) {
	routes.set(label!, href!);
}

describe("buildDesktopTree", () => {
	const tree = buildDesktopTree(boot, sidebars, "Invoicing");
	const labels = tree.map((e) => e.label);

	it("keeps boot order, drops hidden icons, and promotes orphans of a hidden parent", () => {
		assert.deepEqual(labels, ["Framework", "Frappe CRM", "Accounting", "Assets", "Buying"]);
	});
	it("nests under a Folder AND under an App with children, one level, no href on the parent", () => {
		const accounting = tree.find((e) => e.label === "Accounting");
		assert.deepEqual(
			accounting?.children.map((c) => [c.label, c.href]),
			[
				["Invoicing", "/desk/invoicing"],
				["Payments", "/desk/payments"],
			],
		);
		assert.equal(accounting?.href, null);
		const framework = tree.find((e) => e.label === "Framework");
		assert.deepEqual(
			framework?.children.map((c) => c.label),
			["Build", "Users"],
		);
		assert.equal(framework?.href, null);
	});
	it("drops an empty Folder, an unroutable leaf, and My Workspaces while its sidebar is empty", () => {
		assert.ok(!labels.includes("Empty Folder"));
		assert.ok(!labels.includes("Broken"));
		assert.ok(!labels.includes("My Workspaces"));
	});
	it("keeps My Workspaces once its sidebar has items", () => {
		const withItems: Record<string, FrappeWorkspaceSidebar> = {
			"my workspaces": { ...sidebars["my workspaces"]!, items: [link] },
		};
		const t = buildDesktopTree(boot, withItems, "");
		assert.ok(t.some((e) => e.label === "My Workspaces"));
	});
	it("selects the icon whose label is the current sidebar title, nested or not", () => {
		const invoicing = tree
			.find((e) => e.label === "Accounting")
			?.children.find((c) => c.label === "Invoicing");
		assert.equal(invoicing?.selected, true);
		assert.equal(tree.find((e) => e.label === "Assets")?.selected, false);
		assert.equal(
			buildDesktopTree(boot, sidebars, "Assets").find((e) => e.label === "Assets")?.selected,
			true,
		);
	});
	it("opens absolute URLs in a new tab", () => {
		routes.set("Docs", "https://docs.example");
		const t = buildDesktopTree(
			[icon({ label: "Docs", link_type: "External", link: "https://docs.example" })],
			{},
			"",
		);
		assert.equal(t[0]?.target, "_blank");
		assert.equal(tree.find((e) => e.label === "Frappe CRM")?.target, null);
	});
});
