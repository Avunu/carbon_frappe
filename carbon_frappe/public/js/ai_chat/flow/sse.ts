// Server-sent events as flow.api.start_run / resume_run emit them (`_format_sse`:
// `event: <type>\ndata: <json>\n\n`), read from a fetch body. EventSource cannot be
// used because the runs are POSTs, so this is the WHATWG SSE line grammar, minus
// `id`/`retry`, which flow never sends.

import { FLOW_EVENT_NAMES, parseFlowEvent } from "./events.ts";
import type { FlowEvent } from "./events.ts";

export interface SSEFrame {
	/** The `event:` field; "message" when the frame had none (the SSE default). */
	event: string;
	/**
	 * The `data:` lines joined by "\n". A frame with no data lines is not dispatched, so
	 * this is empty only when every data line was itself empty (a bare `data:`).
	 */
	data: string;
}

// `\r\n` must win over `\r`, or a CRLF terminator would read as a line plus a phantom blank line.
const LINE_BREAK = /\r\n|\r|\n/g;

export class SSEFrameParser {
	// The unterminated tail as the pieces that arrived, joined once when its line ends. Joining on
	// every push and rescanning would be quadratic in the length of one line, and a tool result
	// is a single `data:` line however large it is.
	#tail: string[] = [];
	#event = "";
	#data = "";
	// A chunk can end between the \r and \n of a CRLF; the \r already ended the line.
	#skipLineFeed = false;
	#bomChecked = false;

	/** Feed decoded text; returns the frames COMPLETED by it, in order. Keeps the unfinished tail. */
	push(text: string): SSEFrame[] {
		if (text === "") return [];
		let chunk = text;
		if (!this.#bomChecked) {
			this.#bomChecked = true;
			if (chunk.startsWith("﻿")) chunk = chunk.slice(1);
		}
		if (this.#skipLineFeed) {
			this.#skipLineFeed = false;
			if (chunk.startsWith("\n")) chunk = chunk.slice(1);
		}

		// Only the new text is scanned: the tail never holds a line break, because a \r ends a line
		// even when its \n has not arrived yet (see #skipLineFeed).
		const frames: SSEFrame[] = [];
		let start = 0;
		LINE_BREAK.lastIndex = 0;
		for (let match = LINE_BREAK.exec(chunk); match !== null; match = LINE_BREAK.exec(chunk)) {
			const head = chunk.slice(start, match.index);
			let line = head;
			if (this.#tail.length > 0) {
				this.#tail.push(head);
				line = this.#tail.join("");
				this.#tail = [];
			}
			const frame = this.#line(line);
			if (frame) frames.push(frame);
			start = match.index + match[0].length;
			// A lone \r at the very end of the chunk may be the first half of a CRLF.
			if (match[0] === "\r" && start === chunk.length) this.#skipLineFeed = true;
		}
		if (start < chunk.length) this.#tail.push(chunk.slice(start));
		return frames;
	}

	/** Drop all state (partial line, partial frame, CR flag, BOM flag). */
	reset(): void {
		this.#tail = [];
		this.#event = "";
		this.#data = "";
		this.#skipLineFeed = false;
		this.#bomChecked = false;
	}

	#line(line: string): SSEFrame | null {
		if (line === "") return this.#dispatch();
		if (line.startsWith(":")) return null;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.#event = value;
		else if (field === "data") this.#data += `${value}\n`;
		return null;
	}

	#dispatch(): SSEFrame | null {
		const event = this.#event;
		const data = this.#data;
		this.#event = "";
		this.#data = "";
		if (data === "") return null;
		return { event: event || "message", data: data.slice(0, -1) };
	}
}

interface Decoded {
	event: FlowEvent;
	/** The stream cannot be trusted past this frame. */
	fatal: boolean;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function decodeFrame(frame: SSEFrame): Decoded | null {
	if (FLOW_EVENT_NAMES.some((name) => name === frame.event)) {
		const parsed = parseJson(frame.data);
		if (!parsed.ok) {
			// Skipping would drop a text delta or the `done` and silently corrupt the answer.
			const message = `Malformed ${frame.event} frame: ${parsed.message}`;
			return { event: { type: "error", message }, fatal: true };
		}
		const event = parseFlowEvent(frame.event, parsed.value);
		return event && { event, fatal: false };
	}
	// A proxy that drops the `event:` field leaves the payload's own `type` to name it.
	if (frame.event === "message") {
		const parsed = parseJson(frame.data);
		if (!parsed.ok) return null;
		const event = parseFlowEvent("message", parsed.value);
		return event && { event, fatal: false };
	}
	return null;
}

/**
 * Decode a run's response body into flow events. Yields nothing synthetic: a body that
 * ends without `done` or `error` just ends, and the caller decides what that means. The
 * body is always cancelled and unlocked when the generator finishes, however it ends.
 */
export async function* readFlowEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<FlowEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	const parser = new SSEFrameParser();
	// Cancelling the reader is what wakes a read() that is pending on a quiet connection.
	const onAbort = (): void => {
		reader.cancel(signal?.reason).catch(() => {});
	};
	try {
		signal?.throwIfAborted();
		signal?.addEventListener("abort", onAbort, { once: true });
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- each read must wait for the consumer to want more
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			const frames = parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }));
			for (const frame of frames) {
				signal?.throwIfAborted();
				const decoded = decodeFrame(frame);
				if (!decoded) continue;
				yield decoded.event;
				if (decoded.fatal) return;
			}
			if (done) return;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			// Already released.
		}
	}
}
