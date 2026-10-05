import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { SSEFrameParser, readFlowEvents } from "../../../carbon_frappe/public/js/ai_chat/flow/sse.ts";
import type { SSEFrame } from "../../../carbon_frappe/public/js/ai_chat/flow/sse.ts";
import type { FlowEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import {
	ERROR_AFTER_DONE,
	ERROR_BEFORE_TEXT,
	ERROR_MID_TEXT,
	PAUSED_TWO_QUESTIONS,
	RESUME_APPROVED,
	RESUME_DENIED,
	RESUME_REDIRECTED_PAUSED_AGAIN,
	TEXT_ONLY,
	TEXT_TOOL_TEXT,
	TEXT_UNICODE,
	TEXT_UNICODE_RAW,
	TOOL_ERROR,
	bodyFrom,
	chunkBytes,
	encode,
	ev,
	frame,
	pyJson,
} from "./fixtures.ts";
import type { Transcript } from "./fixtures.ts";

const RUN_STARTED_DATA = '{"type": "run_started", "name": "k3j9x8h2ab", "session": "t5r2m7q1cd"}';

const TEXT_ONLY_FRAMES: SSEFrame[] = [
	{ event: "run_started", data: RUN_STARTED_DATA },
	{ event: "text", data: '{"type": "text", "delta": "Hello"}' },
	{ event: "text", data: '{"type": "text", "delta": " there"}' },
	{ event: "text", data: '{"type": "text", "delta": "! How can I help?"}' },
	{
		event: "done",
		data: '{"type": "done", "status": "Completed", "iterations": 1, "output": "Hello there! How can I help?", "usage": {"prompt_tokens": 142, "completion_tokens": 11, "total_tokens": 153}}',
	},
];

function pushAll(parser: SSEFrameParser, chunks: readonly string[]): SSEFrame[] {
	return chunks.flatMap((chunk) => parser.push(chunk));
}

async function collect(events: AsyncIterable<FlowEvent>): Promise<FlowEvent[]> {
	const out: FlowEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** A quiet body that counts reads and records the reason it was cancelled with. */
function watchedBody(): { stream: ReadableStream<Uint8Array>; pulls: () => number; reason: () => unknown } {
	let pulls = 0;
	let reason: unknown;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull: () => {
				pulls++;
				return new Promise<void>(() => {});
			},
			cancel(why: unknown) {
				reason = why;
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, pulls: () => pulls, reason: () => reason };
}

/** Settles with whatever `promise` does, or rejects if it is still pending after `ms`. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

describe("SSEFrameParser", () => {
	it("returns every frame of a whole wire pushed at once", () => {
		assert.deepEqual(new SSEFrameParser().push(TEXT_ONLY.wire), TEXT_ONLY_FRAMES);
	});

	it("yields identical frames when pushed one character at a time", () => {
		assert.deepEqual(pushAll(new SSEFrameParser(), [...TEXT_ONLY.wire]), TEXT_ONLY_FRAMES);
	});

	it("is independent of where a push is split, for LF, CRLF and bare-CR wires", () => {
		const wires = {
			lf: TEXT_ONLY.wire,
			crlf: TEXT_ONLY.wire.replaceAll("\n", "\r\n"),
			cr: TEXT_ONLY.wire.replaceAll("\n", "\r"),
		};
		for (const [name, wire] of Object.entries(wires)) {
			for (let at = 0; at <= wire.length; at++) {
				const frames = pushAll(new SSEFrameParser(), [wire.slice(0, at), wire.slice(at)]);
				assert.deepEqual(frames, TEXT_ONLY_FRAMES, `${name} split at ${at}`);
			}
		}
	});

	it("treats CRLF and bare CR as line ends in a single push", () => {
		assert.deepEqual(new SSEFrameParser().push("event: a\r\ndata: x\r\n\r\n"), [{ event: "a", data: "x" }]);
		assert.deepEqual(new SSEFrameParser().push("event: a\rdata: x\r\r"), [{ event: "a", data: "x" }]);
	});

	it("swallows the LF that follows a CR at a chunk end instead of reading a blank line", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(parser.push("data: x\r"), []);
		// A phantom blank line here would dispatch the frame early.
		assert.deepEqual(parser.push("\n"), []);
		assert.deepEqual(parser.push("\n"), [{ event: "message", data: "x" }]);
	});

	it("swallows only an LF after a trailing CR, not another CR", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(parser.push("data: x\r"), []);
		assert.deepEqual(parser.push("\r\n"), [{ event: "message", data: "x" }]);
	});

	it("does not carry the CR flag past a chunk that did not start with LF", () => {
		const parser = new SSEFrameParser();
		parser.push("data: a\r");
		parser.push("data: b\n");
		// This LF is a genuine blank line, not the tail of a CRLF.
		assert.deepEqual(parser.push("\n"), [{ event: "message", data: "a\nb" }]);
	});

	it("joins multi-line data with newlines", () => {
		assert.deepEqual(new SSEFrameParser().push("data: a\ndata: b\n\n"), [{ event: "message", data: "a\nb" }]);
		assert.deepEqual(new SSEFrameParser().push("data: a\ndata:\ndata: b\n\n"), [
			{ event: "message", data: "a\n\nb" },
		]);
	});

	it("strips exactly one leading space from a value and keeps later colons", () => {
		const frames = new SSEFrameParser().push("data:no-space\n\ndata:  two\n\ndata: a:b\n\n");
		assert.deepEqual(
			frames.map((f) => f.data),
			["no-space", " two", "a:b"],
		);
	});

	it("reads a field with no colon as an empty value", () => {
		const parser = new SSEFrameParser();
		// Bare `data` appends an empty line, so the frame dispatches with empty data (per spec).
		assert.deepEqual(parser.push("data\n\n"), [{ event: "message", data: "" }]);
		assert.deepEqual(parser.push("event\ndata: x\n\n"), [{ event: "message", data: "x" }]);
	});

	it("lets the last event field win", () => {
		assert.deepEqual(new SSEFrameParser().push("event: a\nevent: b\ndata: x\n\n"), [
			{ event: "b", data: "x" },
		]);
	});

	it("ignores comment lines between and inside frames", () => {
		const wire = ": keepalive\nevent: text\n:hb\ndata: x\n: another\n\n: tail\n\n";
		assert.deepEqual(new SSEFrameParser().push(wire), [{ event: "text", data: "x" }]);
	});

	it("dispatches nothing for a comment-only block", () => {
		assert.deepEqual(new SSEFrameParser().push(": keepalive\n\n: again\n\n"), []);
	});

	it("dispatches nothing for an event with no data and does not leak its name", () => {
		const frames = new SSEFrameParser().push("event: text\n\ndata: x\n\n");
		assert.deepEqual(frames, [{ event: "message", data: "x" }]);
	});

	it('names a frame "message" when it has no event field', () => {
		assert.deepEqual(new SSEFrameParser().push('data: {"a": 1}\n\n'), [
			{ event: "message", data: '{"a": 1}' },
		]);
	});

	it("ignores id, retry and unknown fields", () => {
		const wire = "id: 7\nretry: 1000\nweird: yes\nevent: text\ndata: x\n\n";
		assert.deepEqual(new SSEFrameParser().push(wire), [{ event: "text", data: "x" }]);
	});

	it("returns [] for an empty push and keeps state across it", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(parser.push(""), []);
		parser.push("data: a");
		assert.deepEqual(parser.push(""), []);
		assert.deepEqual(parser.push("\n\n"), [{ event: "message", data: "a" }]);
	});

	it("returns many frames from one push, in order", () => {
		const wire = [1, 2, 3].map((n) => `event: e${n}\ndata: d${n}\n\n`).join("");
		assert.deepEqual(new SSEFrameParser().push(wire), [
			{ event: "e1", data: "d1" },
			{ event: "e2", data: "d2" },
			{ event: "e3", data: "d3" },
		]);
	});

	it("does not return a trailing incomplete frame, and completes it from a later push", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(parser.push("data: a\n\ndata: b\n"), [{ event: "message", data: "a" }]);
		assert.deepEqual(parser.push("\n"), [{ event: "message", data: "b" }]);
	});

	it("does not return a final line that has no terminator", () => {
		assert.deepEqual(new SSEFrameParser().push("data: a\n\ndata: b"), [{ event: "message", data: "a" }]);
	});

	it("reset() drops the pending frame and the partial line", () => {
		const parser = new SSEFrameParser();
		parser.push("event: text\ndata: pending\n");
		parser.reset();
		assert.deepEqual(parser.push("\n"), []);
		parser.push("data: par");
		parser.reset();
		assert.deepEqual(parser.push("tial\n\n"), []);
		assert.deepEqual(parser.push("data: ok\n\n"), [{ event: "message", data: "ok" }]);
	});

	it("reset() forgets a pending event name", () => {
		const parser = new SSEFrameParser();
		parser.push("event: text\n");
		parser.reset();
		assert.deepEqual(parser.push("data: x\n\n"), [{ event: "message", data: "x" }]);
	});

	it("takes time linear in the length of one unterminated line", () => {
		const parser = new SSEFrameParser();
		const payload = "x".repeat(1024 * 1024);
		const slices: string[] = ["data: "];
		for (let at = 0; at < payload.length; at += 64) slices.push(payload.slice(at, at + 64));
		slices.push("\n\n");
		const began = performance.now();
		const frames = pushAll(parser, slices);
		const took = performance.now() - began;
		assert.deepEqual(frames, [{ event: "message", data: payload }]);
		// Rejoining the tail on every push took seconds at this size; linear takes milliseconds.
		assert.ok(took < 1000, `took ${Math.round(took)}ms`);
	});

	it("rebuilds a line split across many pushes, with CRLF landing inside the tail", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(pushAll(parser, ["da", "ta: a", "bc\r", "\nda", "ta: d\r", "\n\r", "\n"]), [
			{ event: "message", data: "abc\nd" },
		]);
	});

	it("strips a BOM at the start of the stream once, until reset()", () => {
		const parser = new SSEFrameParser();
		assert.deepEqual(parser.push("﻿data: a\n\n"), [{ event: "message", data: "a" }]);
		// Mid-stream the BOM is part of the field name, which no field matches.
		assert.deepEqual(parser.push("﻿data: b\n\n"), []);
		parser.reset();
		assert.deepEqual(parser.push("﻿data: c\n\n"), [{ event: "message", data: "c" }]);
	});

	it("still finds the BOM when the first push is empty", () => {
		const parser = new SSEFrameParser();
		parser.push("");
		assert.deepEqual(parser.push("﻿data: a\n\n"), [{ event: "message", data: "a" }]);
	});

	it("produces nothing for leading and repeated blank lines", () => {
		assert.deepEqual(new SSEFrameParser().push("\n\n\n"), []);
		assert.deepEqual(new SSEFrameParser().push("\r\n\r\n"), []);
		assert.deepEqual(new SSEFrameParser().push("\n\ndata: a\n\n\n\ndata: b\n\n"), [
			{ event: "message", data: "a" },
			{ event: "message", data: "b" },
		]);
	});
});

const TRANSCRIPTS: [string, Transcript][] = [
	["TEXT_ONLY", TEXT_ONLY],
	["TEXT_TOOL_TEXT", TEXT_TOOL_TEXT],
	["PAUSED_TWO_QUESTIONS", PAUSED_TWO_QUESTIONS],
	["RESUME_APPROVED", RESUME_APPROVED],
	["RESUME_DENIED", RESUME_DENIED],
	["RESUME_REDIRECTED_PAUSED_AGAIN", RESUME_REDIRECTED_PAUSED_AGAIN],
	["TOOL_ERROR", TOOL_ERROR],
	["ERROR_BEFORE_TEXT", ERROR_BEFORE_TEXT],
	["ERROR_MID_TEXT", ERROR_MID_TEXT],
	["ERROR_AFTER_DONE", ERROR_AFTER_DONE],
];

describe("readFlowEvents", () => {
	for (const [name, transcript] of TRANSCRIPTS) {
		it(`yields the ${name} events from one chunk`, async () => {
			assert.deepEqual(await collect(readFlowEvents(bodyFrom([transcript.wire]).stream)), transcript.events);
		});
	}

	it("gives identical events for every chunk size", async () => {
		await Promise.all(
			TRANSCRIPTS.flatMap(([name, transcript]) =>
				[1, 2, 3, 7, 64].map(async (size) => {
					const events = await collect(readFlowEvents(bodyFrom(chunkBytes(transcript.wire, size)).stream));
					assert.deepEqual(events, transcript.events, `${name} in ${size}-byte chunks`);
				}),
			),
		);
	});

	it("gives identical events when split into two chunks at every byte boundary", async () => {
		await Promise.all(
			TRANSCRIPTS.map(async ([name, transcript]) => {
				const bytes = encode(transcript.wire);
				const splits = Array.from({ length: bytes.length + 1 }, (_, at) => at);
				await Promise.all(
					splits.map(async (at) => {
						const body = bodyFrom([bytes.slice(0, at), bytes.slice(at)]);
						assert.deepEqual(
							await collect(readFlowEvents(body.stream)),
							transcript.events,
							`${name} at ${at}`,
						);
					}),
				);
			}),
		);
	});

	it("keeps multi-byte characters split across chunks intact", async () => {
		const bytes = encode(TEXT_UNICODE_RAW);
		const splits = Array.from({ length: bytes.length + 1 }, (_, at) => [bytes.slice(0, at), bytes.slice(at)]);
		const chunkings = [chunkBytes(TEXT_UNICODE_RAW, 1), chunkBytes(TEXT_UNICODE_RAW, 2), ...splits];
		await Promise.all(
			chunkings.map(async (chunks, index) => {
				const events = await collect(readFlowEvents(bodyFrom(chunks).stream));
				assert.deepEqual(events, TEXT_UNICODE.events, `chunking ${index}`);
			}),
		);
		assert.deepEqual(TEXT_UNICODE.events[2], { type: "text", delta: "☕ — 你好 " });
	});

	it("parses the escaped (as flow sends it) unicode wire to the same events", async () => {
		assert.ok([...TEXT_UNICODE.wire].every((ch) => ch.charCodeAt(0) < 0x80));
		assert.deepEqual(
			await collect(readFlowEvents(bodyFrom(chunkBytes(TEXT_UNICODE.wire, 3)).stream)),
			TEXT_UNICODE.events,
		);
	});

	it("skips unknown event names without parsing their data", async () => {
		const wire =
			frame(ev.runStarted("r", "s")) +
			"event: ping\ndata: {}\n\n" +
			"event: ping\ndata: not json at all\n\n" +
			// A valid payload under an unknown name must still be skipped, not read by its `type`.
			'event: ping\ndata: {"type":"text","delta":"nope"}\n\n' +
			frame(ev.text("x"));
		const events = await collect(readFlowEvents(bodyFrom([wire]).stream));
		assert.deepEqual(events, [ev.runStarted("r", "s"), ev.text("x")]);
	});

	it("stops with one error event on malformed JSON in a known frame", async () => {
		const wire =
			frame(ev.runStarted("r", "s")) +
			frame(ev.text("kept")) +
			"event: text\ndata: {oops\n\n" +
			frame(ev.text("never delivered")) +
			frame(ev.done("Completed", "x", 1, {}));
		const body = bodyFrom([wire], { hold: true });
		const events = await collect(readFlowEvents(body.stream));
		assert.equal(events.length, 3);
		assert.deepEqual(events.slice(0, 2), [ev.runStarted("r", "s"), ev.text("kept")]);
		const last = events[2];
		assert.equal(last?.type, "error");
		assert.ok(last?.type === "error" && last.message.startsWith("Malformed text frame: "));
		assert.ok(last?.type === "error" && last.message.length > "Malformed text frame: ".length);
		assert.equal(body.cancelled(), true);
	});

	it("names the offending event in the malformed-frame message", async () => {
		const events = await collect(readFlowEvents(bodyFrom(["event: done\ndata: \n\n"]).stream));
		assert.equal(events.length, 1);
		const [only] = events;
		assert.ok(only?.type === "error" && only.message.startsWith("Malformed done frame: "));
	});

	it("skips a known event whose payload lacks a required field", async () => {
		const wire = 'event: text\ndata: {"delta": 5}\n\n' + frame(ev.text("ok"));
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire]).stream)), [ev.text("ok")]);
	});

	it('delivers a "message" frame by the payload type', async () => {
		const wire = 'event: message\ndata: {"type":"text","delta":"x"}\n\n';
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire]).stream)), [ev.text("x")]);
	});

	it("delivers a frame with no event line by the payload type", async () => {
		const wire = `data: ${pyJson({ type: "text", delta: "y" })}\n\n`;
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire]).stream)), [ev.text("y")]);
	});

	it('silently skips a "message" frame with bad JSON or an unknown payload type', async () => {
		const wire =
			"data: {nope\n\n" +
			'data: {"type":"mystery","delta":"z"}\n\n' +
			'data: {"delta":"no type"}\n\n' +
			frame(ev.text("ok"));
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire]).stream)), [ev.text("ok")]);
	});

	it("ignores comments and keepalives between frames", async () => {
		const wire = `: connected\n\n${frame(ev.text("a"))}: keepalive\n\n${frame(ev.text("b"))}`;
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire]).stream)), [ev.text("a"), ev.text("b")]);
	});

	it("completes with no events for an empty stream", async () => {
		const body = bodyFrom([]);
		assert.deepEqual(await collect(readFlowEvents(body.stream)), []);
		assert.equal(body.stream.locked, false);
	});

	it("yields nothing for a stream holding only a partial frame", async () => {
		const wire = frame(ev.text("lost"));
		assert.deepEqual(await collect(readFlowEvents(bodyFrom([wire.slice(0, -1)]).stream)), []);
		assert.deepEqual(await collect(readFlowEvents(bodyFrom(['event: text\ndata: {"del']).stream)), []);
	});

	it("discards a trailing frame cut off mid-character", async () => {
		const bytes = encode(frame(ev.text("a")) + 'event: text\ndata: {"type": "text", "delta": "é');
		// Drop the second byte of the two-byte é.
		const events = await collect(readFlowEvents(bodyFrom([bytes.slice(0, -1)]).stream));
		assert.deepEqual(events, [ev.text("a")]);
	});

	it("ends silently when the stream closes without done or error", async () => {
		const wire = frame(ev.runStarted("r", "s")) + frame(ev.text("partial"));
		const events = await collect(readFlowEvents(bodyFrom([wire]).stream));
		assert.deepEqual(events, [ev.runStarted("r", "s"), ev.text("partial")]);
	});

	it("keeps reading after done, because error can follow it", async () => {
		const events = await collect(readFlowEvents(bodyFrom([ERROR_AFTER_DONE.wire]).stream));
		assert.deepEqual(
			events.map((e) => e.type),
			["run_started", "text", "done", "error"],
		);
	});

	it("releases the reader lock and cancels the body when it finishes", async () => {
		const body = bodyFrom([TEXT_ONLY.wire]);
		await collect(readFlowEvents(body.stream));
		assert.equal(body.stream.locked, false);
	});

	it("pulls the next chunk only when the consumer asks and nothing is queued", async () => {
		let pulls = 0;
		const frames = [frame(ev.text("1")) + frame(ev.text("2")), frame(ev.text("3"))];
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const chunk = frames[pulls++];
					if (chunk === undefined) controller.close();
					else controller.enqueue(encode(chunk));
				},
			},
			{ highWaterMark: 0 },
		);
		const gen = readFlowEvents(stream);
		assert.equal(pulls, 0);
		assert.deepEqual((await gen.next()).value, ev.text("1"));
		assert.equal(pulls, 1);
		assert.deepEqual((await gen.next()).value, ev.text("2"));
		assert.equal(pulls, 1);
		assert.deepEqual((await gen.next()).value, ev.text("3"));
		assert.equal(pulls, 2);
		await gen.return(undefined);
	});

	describe("abort", () => {
		it("rejects with AbortError mid-stream, yields nothing more and cancels the body", async () => {
			const controller = new AbortController();
			const chunks = [frame(ev.runStarted("r", "s")), frame(ev.text("a")), frame(ev.text("never"))];
			const body = bodyFrom(chunks, { hold: true });
			const gen = readFlowEvents(body.stream, controller.signal);
			assert.deepEqual((await gen.next()).value, ev.runStarted("r", "s"));
			assert.deepEqual((await gen.next()).value, ev.text("a"));
			controller.abort();
			await assert.rejects(gen.next(), isAbortError);
			assert.equal(body.cancelled(), true);
			assert.deepEqual(await gen.next(), { value: undefined, done: true });
		});

		it("does not yield a frame already queued when the abort is observed", async () => {
			const controller = new AbortController();
			const body = bodyFrom([frame(ev.text("a")) + frame(ev.text("queued"))]);
			const gen = readFlowEvents(body.stream, controller.signal);
			assert.deepEqual((await gen.next()).value, ev.text("a"));
			controller.abort();
			await assert.rejects(gen.next(), isAbortError);
		});

		it("wakes a read that is pending on a quiet connection", async () => {
			const controller = new AbortController();
			const body = bodyFrom([frame(ev.runStarted("r", "s"))], { hold: true });
			const gen = readFlowEvents(body.stream, controller.signal);
			await gen.next();
			const pending = gen.next();
			controller.abort();
			await assert.rejects(pending, isAbortError);
			assert.equal(body.cancelled(), true);
			assert.equal(body.stream.locked, false);
		});

		it("rejects with a custom abort reason as given", async () => {
			const controller = new AbortController();
			const reason = new Error("user navigated away");
			const body = bodyFrom([frame(ev.text("a"))], { hold: true });
			const gen = readFlowEvents(body.stream, controller.signal);
			await gen.next();
			const pending = gen.next();
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
		});

		it("rejects at once for an already-aborted signal, reading nothing", async () => {
			const controller = new AbortController();
			controller.abort();
			// Quiet and unread: an abort listener added to a signal that has already fired never runs,
			// so only the check before the first read can settle this.
			const body = watchedBody();
			const gen = readFlowEvents(body.stream, controller.signal);
			await settlesWithin(assert.rejects(gen.next(), isAbortError), 500);
			assert.equal(body.pulls(), 0);
			assert.equal(body.stream.locked, false);
		});

		it("cancels the body with the abort reason", async () => {
			const controller = new AbortController();
			const reason = new Error("user navigated away");
			const body = watchedBody();
			const gen = readFlowEvents(body.stream, controller.signal);
			const pending = gen.next();
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
			assert.equal(body.reason(), reason);
		});

		it("removes its abort listener when it finishes", async () => {
			const controller = new AbortController();
			const body = bodyFrom([TEXT_ONLY.wire]);
			const gen = readFlowEvents(body.stream, controller.signal);
			await gen.next();
			assert.equal(getEventListeners(controller.signal, "abort").length, 1);
			for await (const _event of gen);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			// A leaked listener would call cancel on the released stream; nothing may throw or reject.
			controller.abort();
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(body.stream.locked, false);
		});
	});

	describe("early exit", () => {
		it("cancels a held body when the consumer breaks", async () => {
			const body = bodyFrom([TEXT_ONLY.wire], { hold: true });
			const seen: FlowEvent[] = [];
			for await (const event of readFlowEvents(body.stream)) {
				seen.push(event);
				break;
			}
			assert.deepEqual(seen, [TEXT_ONLY.events[0]]);
			assert.equal(body.cancelled(), true);
			assert.equal(body.stream.locked, false);
		});

		it("cancels an open body that has more chunks", async () => {
			const body = bodyFrom(chunkBytes(TEXT_ONLY.wire, 16));
			for await (const _event of readFlowEvents(body.stream)) break;
			assert.equal(body.cancelled(), true);
		});

		it("never touches the body when closed before the first next()", async () => {
			const body = bodyFrom([TEXT_ONLY.wire], { hold: true });
			const gen = readFlowEvents(body.stream);
			await gen.return(undefined);
			// A generator that never started has not locked the stream, so there is nothing to cancel.
			assert.equal(body.stream.locked, false);
		});
	});

	describe("read errors", () => {
		it("yields the events read before the failure, then rejects with the read error", async () => {
			const chunks = [frame(ev.runStarted("r", "s")), frame(ev.text("a")), frame(ev.text("lost"))];
			const body = bodyFrom(chunks, { failAfter: 2 });
			const gen = readFlowEvents(body.stream);
			assert.deepEqual((await gen.next()).value, ev.runStarted("r", "s"));
			assert.deepEqual((await gen.next()).value, ev.text("a"));
			await assert.rejects(gen.next(), (error: unknown) => error instanceof TypeError);
			assert.equal(body.stream.locked, false);
		});

		it("does not invent events when the failure comes mid-frame", async () => {
			const wire = frame(ev.text("a"));
			const body = bodyFrom([wire, wire.slice(0, 10)], { failAfter: 2 });
			const seen: FlowEvent[] = [];
			await assert.rejects(
				(async () => {
					for await (const event of readFlowEvents(body.stream)) seen.push(event);
				})(),
				(error: unknown) => error instanceof TypeError && error.message === "network error",
			);
			assert.deepEqual(seen, [ev.text("a")]);
		});
	});
});
