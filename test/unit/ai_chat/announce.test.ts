import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { announcementText } from "../../../carbon_frappe/public/js/ai_chat/announce.ts";

const SAY = (markdown: string, max = 1000): string => announcementText(markdown, max);

describe("announcementText", () => {
	it("returns an empty string for empty or blank input", () => {
		assert.equal(SAY(""), "");
		assert.equal(SAY("  \n\n \t"), "");
	});

	it("returns an empty string when there is no room", () => {
		assert.equal(SAY("hello", 0), "");
	});

	it("leaves plain prose alone and collapses whitespace", () => {
		assert.equal(SAY("Hello   there.\n\nHow are\tyou?"), "Hello there. How are you?");
	});

	it("drops heading, quote and emphasis markers", () => {
		assert.equal(
			SAY("## Result\n> a **bold** and *italic* and ~~gone~~ word"),
			"Result a bold and italic and gone word",
		);
		assert.equal(SAY("__strong__ and _soft_"), "strong and soft");
	});

	it("leaves underscores and asterisks inside words and arithmetic alone", () => {
		assert.equal(SAY("use snake_case_name and 2 * 3 * 4"), "use snake_case_name and 2 * 3 * 4");
	});

	it("keeps the text of links and images, not their targets", () => {
		assert.equal(
			SAY("See [the docs](https://example.com/a_b) and ![a chart](x.png)."),
			"See the docs and a chart.",
		);
		assert.equal(SAY("<https://example.com/x>"), "https://example.com/x");
	});

	it("strips inline code ticks and html tags", () => {
		assert.equal(SAY("Run `bench migrate` now<br> please"), "Run bench migrate now please");
	});

	it("removes bullet and number list markers", () => {
		assert.equal(SAY("- one\n- two\n* three\n+ four\n1. five\n2) six"), "one two three four five six");
	});

	it("keeps the code of a fence and drops the fence lines and info string", () => {
		const text = "Try:\n\n```python\ndef greet(name):\n    return name\n```\n\nDone.";
		assert.equal(SAY(text), "Try: def greet(name): return name Done.");
	});

	it("does not strip markdown inside a fence", () => {
		assert.equal(SAY("```\nlet a = b * c * d; // [x](y)\n```"), "let a = b * c * d; // [x](y)");
	});

	it("keeps a longer fence open across a shorter marker line and tilde fences", () => {
		assert.equal(SAY("~~~\ninside\n~~~\nafter"), "inside after");
		assert.equal(SAY("````\n```\nstill code\n````\nafter"), "``` still code after");
	});

	it("reads an unterminated fence to the end", () => {
		assert.equal(SAY("Intro\n```js\nconst a = 1;"), "Intro const a = 1;");
	});

	it("turns table rows into comma lists and drops the header rule", () => {
		const table = "| Name | Age |\n| --- | :-: |\n| Ann | 31 |\n| Bo | 27 |";
		assert.equal(SAY(table), "Name, Age Ann, 31 Bo, 27");
	});

	it("drops a thematic break", () => {
		assert.equal(SAY("above\n\n---\n\nbelow"), "above below");
	});

	it("unescapes escaped punctuation", () => {
		assert.equal(SAY("5 \\* 3 \\| 2"), "5 * 3 | 2");
	});

	it("keeps text at exactly the limit untouched", () => {
		assert.equal(SAY("abcde fghij", 11), "abcde fghij");
	});

	it("cuts on a word boundary and ends with an ellipsis, within the limit", () => {
		const out = SAY("alpha beta gamma delta", 14);
		assert.equal(out, "alpha beta…");
		assert.ok(out.length <= 14);
	});

	it("does not leave dangling punctuation before the ellipsis", () => {
		assert.equal(SAY("alpha, beta, gamma", 13), "alpha, beta…");
		assert.equal(SAY("alpha beta. gamma", 13), "alpha beta…");
	});

	it("hard-cuts a single word longer than the limit", () => {
		assert.equal(SAY("abcdefghijklmnop", 6), "abcde…");
	});

	it("measures the limit after the markdown is removed", () => {
		assert.equal(SAY("**bold** [link](https://example.com/long/path/here)", 20), "bold link");
	});

	it("stays fast on a long line of unmatched openers", () => {
		for (const opener of [" *a", " [a", " _a", " **a", " `a", " <a"]) {
			const started = performance.now();
			const out = announcementText(opener.repeat(60_000), 1000);
			// The reply is cut to a fixed prefix first, so this takes about 30 ms on a fast machine and a few
			// times that on a shared CI runner. Without the cut the lazy emphasis patterns are quadratic:
			// 20k openers took 1.5 s and this input would take over ten, so 1 s separates the two.
			assert.ok(
				performance.now() - started < 1000,
				`${opener} took ${Math.round(performance.now() - started)}ms`,
			);
			assert.ok(out.length <= 1000);
		}
	});

	it("reads only the start of a very long reply", () => {
		const out = SAY("word ".repeat(100_000), 20);
		assert.equal(out, "word word word word…");
		assert.ok(out.length <= 20);
	});
});
