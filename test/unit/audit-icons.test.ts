import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findLegacyClassNames, findSpriteIds, findSpriteReferences } from "../../scripts/lib/audit-icons.ts";

describe("findLegacyClassNames", () => {
	it("finds the class however the markup spells the element", () => {
		const text = `
			' <i class="fa fa-lock text-warning"></i>'
			$btn.html(\`<i class="fa fa-spinner fa-spin"></i>\`);
			"icon": "octicon octicon-file-directory",
			<span class="fa-fixed-width fa fa-user"></span>
		`;
		assert.deepEqual([...findLegacyClassNames(text)].sort(), [
			"fa-fixed-width",
			"fa-lock",
			"fa-spin",
			"fa-spinner",
			"fa-user",
			"octicon-file-directory",
		]);
	});
	it("keeps multi-word names whole", () => {
		assert.deepEqual([...findLegacyClassNames("fa fa-angle-double-right")], ["fa-angle-double-right"]);
	});
	it("does not read a locale code or an unrelated word as an icon", () => {
		assert.equal(findLegacyClassNames("lang = 'fa-IR'; const sofa = 1; fax-number").size, 0);
	});
});

describe("findSpriteReferences", () => {
	it("reads href fragments and frappe.utils.icon calls, normalising to the sprite's ids", () => {
		const text = `
			<svg><use href="#icon-heart"></use></svg>
			frappe.utils.icon("square-pen", "sm")
			utils?.icon('es-line-search')
		`;
		assert.deepEqual([...findSpriteReferences(text)].sort(), [
			"es-line-search",
			"icon-heart",
			"icon-square-pen",
		]);
	});
	it("ignores a dynamic name rather than guessing one", () => {
		assert.equal(findSpriteReferences("frappe.utils.icon(name, size)").size, 0);
	});
});

describe("findSpriteIds", () => {
	it("lists every <symbol> id in a sprite sheet", () => {
		const svg = `<svg><symbol viewBox="0 0 16 16" id="icon-up"><path/></symbol>
			<symbol id="es-line-x" viewBox="0 0 1 1"/></svg>`;
		assert.deepEqual([...findSpriteIds(svg)].sort(), ["es-line-x", "icon-up"]);
	});
});
