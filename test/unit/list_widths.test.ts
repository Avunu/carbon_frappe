import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_WIDTH,
	MIN_ESTIMATE,
	MIN_WIDTH,
	clampWidth,
	estimateWidth,
	metaWidth,
	textOf,
} from "../../carbon_frappe/public/js/tables/widths.ts";

describe("textOf", () => {
	it("drops tags and counts an entity as one character", () => {
		assert.equal(textOf('<span class="x">Tom &amp; Jerry</span>'), "Tom x Jerry");
	});
	it("collapses the whitespace get_column_html indents its output with", () => {
		assert.equal(textOf('\n\t<div class="list-row-col">\n\t\t<span> Open </span>\n\t</div>\n'), "Open");
	});
	it("is empty for markup with no text, such as a progress bar", () => {
		assert.equal(
			textOf('<div class="progress"><div class="progress-bar" style="width: 40%"></div></div>'),
			"",
		);
	});
});

describe("clampWidth", () => {
	it("holds a width to frappe's own 50..400", () => {
		assert.equal(clampWidth(10), MIN_WIDTH);
		assert.equal(clampWidth(900), MAX_WIDTH);
		assert.equal(clampWidth(220), 220);
	});
});

describe("estimateWidth", () => {
	it("is never narrower than the floor, however short the column", () => {
		assert.equal(estimateWidth({ label: "ID" }, ["<span>1</span>"]), MIN_ESTIMATE);
	});
	it("follows the widest sampled cell", () => {
		const narrow = estimateWidth({ label: "Name" }, ["<span>Ann</span>", "<span>Bo</span>"]);
		const wide = estimateWidth({ label: "Name" }, [
			"<span>Ann</span>",
			"<span>An unusually long customer name</span>",
		]);
		assert.ok(wide > narrow, `${wide} > ${narrow}`);
	});
	it("lets a long header hold the column open over short cells", () => {
		const header = estimateWidth({ label: "Expected Delivery Date" }, ["<span>1</span>"]);
		assert.ok(header > MIN_ESTIMATE, String(header));
	});
	it("sets numeric and date output (carbon-num, Plex Mono) wider than the same characters in Sans", () => {
		const sans = estimateWidth({ label: "" }, ["<span>2026-09-16</span>"]);
		const mono = estimateWidth({ label: "" }, ['<span class="carbon-num">2026-09-16</span>']);
		assert.ok(mono > sans, `${mono} > ${sans}`);
	});
	it("adds the pill's padding to a status or select tag", () => {
		const plain = estimateWidth({ label: "" }, ["<span>Completed</span>"]);
		const pill = estimateWidth({ label: "" }, ['<span class="es-badge">Completed</span>']);
		assert.ok(pill > plain, `${pill} > ${plain}`);
	});
	it("makes room for what a header carries beside its label", () => {
		const plain = estimateWidth({ label: "Status" }, ["<span>x</span>"]);
		const withChrome = estimateWidth({ label: "Status", headerExtra: 72 }, ["<span>x</span>"]);
		assert.ok(withChrome > plain, `${withChrome} > ${plain}`);
	});
	it("makes room for the checkbox in the Subject column", () => {
		const subject = estimateWidth({ label: "", subject: true }, ["<span>Quarterly review</span>"]);
		const field = estimateWidth({ label: "" }, ["<span>Quarterly review</span>"]);
		assert.ok(subject > field, `${subject} > ${field}`);
	});
	it("gives a cell with no text a usable width rather than none", () => {
		const bar = estimateWidth({ label: "" }, ['<div class="progress"></div>']);
		assert.ok(bar >= MIN_ESTIMATE, String(bar));
	});
	it("caps a very long value at frappe's maximum", () => {
		assert.equal(estimateWidth({ label: "" }, [`<span>${"x".repeat(500)}</span>`]), MAX_WIDTH);
	});
	it("copes with no sample at all (an empty list)", () => {
		assert.equal(estimateWidth({ label: "Status" }, []), MIN_ESTIMATE);
	});
});

describe("metaWidth", () => {
	it("grows with the avatars in the widest row, by frappe's own steps", () => {
		const widths = [0, 1, 2, 3].map(metaWidth);
		assert.deepEqual(
			widths,
			[...widths].sort((a, b) => a - b),
		);
		assert.equal(new Set(widths).size, 4);
	});
	it("treats anything past three as three", () => {
		assert.equal(metaWidth(7), metaWidth(3));
	});
});
