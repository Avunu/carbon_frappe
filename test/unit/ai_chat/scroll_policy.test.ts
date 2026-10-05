import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	JUMP_BUTTON_PX,
	PIN_OFFSET_PX,
	STREAM_END_NEAR_PIN_PX,
	TALL_ROW_RATIO,
	TALL_ROW_VISIBLE_PX,
	USER_SCROLL_AWAY_PX,
	WINDOW_CHUNK,
	WINDOW_INITIAL,
	atStreamEnd,
	earlierWindowStart,
	growOnlySpacerHeight,
	hasContentBelow,
	initialWindowStart,
	pinScrollTop,
	scrollTopAfterPrepend,
	spacerHeightFor,
	userScrolledAway,
} from "../../../carbon_frappe/public/js/ai_chat/scroll_policy.ts";

describe("constants", () => {
	it("keep the thresholds the upstream controller documents", () => {
		assert.equal(PIN_OFFSET_PX, 60);
		assert.equal(USER_SCROLL_AWAY_PX, 50);
		assert.equal(JUMP_BUTTON_PX, 60);
		assert.equal(STREAM_END_NEAR_PIN_PX, 60);
		assert.equal(TALL_ROW_RATIO, 0.25);
		assert.equal(TALL_ROW_VISIBLE_PX, 100);
	});
});

describe("pinScrollTop", () => {
	it("starts the viewport 60px above the row so the previous turn's tail shows", () => {
		assert.equal(pinScrollTop(500, 80, 800), 440);
	});

	it("floors a fractional offset", () => {
		assert.equal(pinScrollTop(500.9, 80, 800), 440);
	});

	it("never goes negative for a row near the top", () => {
		assert.equal(pinScrollTop(20, 80, 800), 0);
		assert.equal(pinScrollTop(0, 80, 800), 0);
	});

	it("leaves a row of exactly a quarter of the viewport alone", () => {
		assert.equal(pinScrollTop(500, 200, 800), 440);
	});

	it("scrolls past a row taller than a quarter, leaving its last 100px in view", () => {
		assert.equal(pinScrollTop(500, 300, 800), 440 + 200);
	});

	it("applies the tall-row shift on top of the clamped base", () => {
		assert.equal(pinScrollTop(10, 400, 800), 0 + 300);
	});

	it("does not shift for a tall row shorter than the visible tail", () => {
		// 90px tall in a 300px viewport is "tall" by ratio but has less than 100px to scroll past
		assert.equal(pinScrollTop(500, 90, 300), 440);
	});
});

describe("spacerHeightFor", () => {
	it("is the gap between the content's end and the bottom of the target viewport", () => {
		// target scrollTop 440 in a 800px viewport shows down to 1240; content ends at 700
		assert.equal(spacerHeightFor(700, 440, 800), 540);
	});

	it("is zero when the content already reaches that far", () => {
		assert.equal(spacerHeightFor(2000, 440, 800), 0);
		assert.equal(spacerHeightFor(1240, 440, 800), 0);
	});

	it("rounds a fractional gap up so the pin stays reachable", () => {
		assert.equal(spacerHeightFor(700.2, 440, 800), 540);
		assert.equal(spacerHeightFor(700.8, 440, 800), 540);
		assert.equal(spacerHeightFor(699.5, 440, 800), 541);
	});
});

describe("growOnlySpacerHeight", () => {
	const base = { scrollHeight: 1500, clientHeight: 800, spacerHeight: 500, pinnedScrollTop: 440 };

	it("keeps the current height when the pin is still reachable", () => {
		// content is 1000px tall; 440 + 800 = 1240 needed, so 240 is enough and 500 is kept
		assert.equal(growOnlySpacerHeight(base), 500);
	});

	it("grows when content above the pin shrank", () => {
		// content 600px tall now: 1240 - 600 = 640 needed
		assert.equal(growOnlySpacerHeight({ ...base, scrollHeight: 1100 }), 640);
	});

	it("never shrinks, however much content streamed in", () => {
		assert.equal(growOnlySpacerHeight({ ...base, scrollHeight: 5000 }), 500);
		assert.equal(growOnlySpacerHeight({ ...base, spacerHeight: 900, scrollHeight: 5000 }), 900);
	});

	it("is zero for an empty spacer on content that reaches the pin", () => {
		assert.equal(
			growOnlySpacerHeight({ scrollHeight: 3000, clientHeight: 800, spacerHeight: 0, pinnedScrollTop: 440 }),
			0,
		);
	});
});

describe("userScrolledAway", () => {
	const geometry = { pinnedScrollTop: 440, maxScrollTop: 2000 };

	it("is true more than 50px above the pin with room below", () => {
		assert.equal(userScrolledAway({ ...geometry, scrollTop: 389 }), true);
		assert.equal(userScrolledAway({ ...geometry, scrollTop: 0 }), true);
	});

	it("is false at exactly 50px above the pin (the threshold is exclusive)", () => {
		assert.equal(userScrolledAway({ ...geometry, scrollTop: 390 }), false);
	});

	it("is false at, and below, the pin: the reader is following the reply", () => {
		assert.equal(userScrolledAway({ ...geometry, scrollTop: 440 }), false);
		assert.equal(userScrolledAway({ ...geometry, scrollTop: 1500 }), false);
	});

	it("is inconclusive above the pin when the browser capped scrollTop at the bottom", () => {
		// content shrank so the maximum is below the pin; the position is the browser's doing
		assert.equal(userScrolledAway({ pinnedScrollTop: 440, maxScrollTop: 400, scrollTop: 380 }), null);
		assert.equal(userScrolledAway({ pinnedScrollTop: 440, maxScrollTop: 420, scrollTop: 370 }), null);
	});

	it("treats a position within 50px of the maximum as no room below", () => {
		assert.equal(userScrolledAway({ pinnedScrollTop: 440, maxScrollTop: 430, scrollTop: 385 }), null);
		assert.equal(userScrolledAway({ pinnedScrollTop: 440, maxScrollTop: 451, scrollTop: 385 }), true);
	});
});

describe("hasContentBelow", () => {
	const viewport = { scrollHeight: 2000, clientHeight: 800, scrollTop: 0, spacerHeight: 0 };

	it("is true when more than 60px of content is below the viewport", () => {
		assert.equal(hasContentBelow({ ...viewport, scrollTop: 1139 }), true);
	});

	it("is false at exactly 60px (the threshold is exclusive) and when at the bottom", () => {
		assert.equal(hasContentBelow({ ...viewport, scrollTop: 1140 }), false);
		assert.equal(hasContentBelow({ ...viewport, scrollTop: 1200 }), false);
	});

	it("does not count the spacer as content", () => {
		// the same scroll position that shows the button without a spacer hides it with one
		const scrolled = { ...viewport, scrollTop: 900 };
		assert.equal(hasContentBelow(scrolled), true);
		assert.equal(hasContentBelow({ ...scrolled, spacerHeight: 400 }), false);
	});

	it("shows the button again once real content outgrows the spacer", () => {
		assert.equal(
			hasContentBelow({ ...viewport, scrollHeight: 2000, spacerHeight: 400, scrollTop: 700 }),
			true,
		);
	});

	it("is false when the content fits the viewport", () => {
		assert.equal(
			hasContentBelow({ scrollHeight: 700, clientHeight: 800, scrollTop: 0, spacerHeight: 0 }),
			false,
		);
	});
});

describe("atStreamEnd", () => {
	const geometry = { pinnedScrollTop: 440, maxScrollTop: 3000 };

	it("re-pins at, and near, the pin", () => {
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 440 }), "re-pin");
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 380 }), "re-pin");
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 500 }), "re-pin");
	});

	it("keeps a position more than 60px away in either direction", () => {
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 379 }), "keep");
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 501 }), "keep");
		assert.equal(atStreamEnd({ ...geometry, scrollTop: 2900 }), "keep");
	});

	it("re-pins a scrollTop the browser capped below the pin", () => {
		// the content shrank, the browser clamped scrollTop to the new maximum; that is not the reader's choice
		assert.equal(atStreamEnd({ pinnedScrollTop: 1000, maxScrollTop: 600, scrollTop: 600 }), "re-pin");
		assert.equal(atStreamEnd({ pinnedScrollTop: 1000, maxScrollTop: 601, scrollTop: 599 }), "re-pin");
	});

	it("keeps a position far below the pin even at the maximum", () => {
		assert.equal(atStreamEnd({ pinnedScrollTop: 440, maxScrollTop: 3000, scrollTop: 3000 }), "keep");
	});

	it("keeps a position above the pin that the browser did not cap", () => {
		assert.equal(atStreamEnd({ pinnedScrollTop: 1000, maxScrollTop: 3000, scrollTop: 300 }), "keep");
	});
});

// user, assistant, user, assistant ...: a turn starts at every even index
const alternating = (index: number): boolean => index % 2 === 0;

describe("initialWindowStart", () => {
	it("shows everything of a short conversation", () => {
		assert.equal(initialWindowStart(0, alternating), 0);
		assert.equal(initialWindowStart(2, alternating), 0);
		assert.equal(initialWindowStart(WINDOW_INITIAL, alternating), 0);
	});

	it("opens on the last WINDOW_INITIAL messages when that is a turn start", () => {
		assert.equal(initialWindowStart(200, alternating), 200 - WINDOW_INITIAL);
	});

	it("snaps back to the question of a reply it would have cut off", () => {
		// 31 messages: index 1 is a reply, so the window opens at the user message before it
		assert.equal(initialWindowStart(WINDOW_INITIAL + 1, alternating), 0);
		assert.equal(initialWindowStart(WINDOW_INITIAL + 3, alternating), 2);
	});

	it("falls back to 0 when no turn starts before the cut", () => {
		assert.equal(
			initialWindowStart(100, () => false),
			0,
		);
	});

	it("never starts inside a long run of replies to one question", () => {
		// a question at 0 and 99 replies after it
		assert.equal(
			initialWindowStart(100, (index) => index === 0),
			0,
		);
	});
});

describe("earlierWindowStart", () => {
	it("moves back one chunk", () => {
		assert.equal(earlierWindowStart(100, alternating), 100 - WINDOW_CHUNK);
	});

	it("snaps back to a turn start", () => {
		assert.equal(earlierWindowStart(101, alternating), 70);
	});

	it("stops at 0 and stays there", () => {
		assert.equal(earlierWindowStart(10, alternating), 0);
		assert.equal(earlierWindowStart(WINDOW_CHUNK, alternating), 0);
		assert.equal(earlierWindowStart(0, alternating), 0);
	});

	it("reveals the whole of a 200-message conversation in the expected number of steps", () => {
		let start = initialWindowStart(200, alternating);
		let steps = 0;
		while (start > 0) {
			const next = earlierWindowStart(start, alternating);
			assert.ok(next < start, "every step makes progress");
			start = next;
			steps++;
		}
		assert.equal(steps, 6);
	});

	it("still makes progress when the only turn start is far back", () => {
		assert.equal(
			earlierWindowStart(50, (index) => index === 0),
			0,
		);
	});
});

describe("scrollTopAfterPrepend", () => {
	it("moves scrollTop by exactly how far the anchor moved", () => {
		assert.equal(scrollTopAfterPrepend(120, 40, 1840), 1920);
	});

	it("is unchanged when nothing was inserted", () => {
		assert.equal(scrollTopAfterPrepend(120, 40, 40), 120);
	});

	it("never goes negative", () => {
		assert.equal(scrollTopAfterPrepend(10, 500, 100), 0);
	});

	it("keeps a fractional offset", () => {
		assert.equal(scrollTopAfterPrepend(0, 10.5, 310.25), 299.75);
	});
});
