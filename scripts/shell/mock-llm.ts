// A scripted OpenAI-compatible chat.completions server for the AI assistant suite.
//
// Flow reaches its model through litellm, and a Flow Model can point `base_url` anywhere,
// so the suite gets deterministic replies (and tool calls) without a provider key or any
// network. The reply is chosen by a keyword in the LAST user message; a conversation whose
// last message is a tool result is answered with plain text, because that is the second
// model call of a tool turn and answering it with another tool call would loop until
// the agent's iteration limit.
//
// Flow injects an attached file's text into the user turn, so the keyword search sees file bodies and
// names too: a fixture file must not contain ERROR, SLOW, HOLD, LONG, TOOL, FLAKY or UNSAFE as a word.
// A turn that carries files and matches no keyword is answered with the names that reached the model.
//
//   node scripts/shell/mock-llm.ts --port 8950     serve until killed, for curl
//
// Zero dependencies on purpose: it runs in the suite's process, in CI's bare Node, and by
// hand against a litellm checkout.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockLlmOptions {
	/** 0 or absent: let the OS pick. */
	port?: number;
	/** Gap between SLOW's 40 chunks. Long enough for a test to click Stop mid-stream. */
	slowMs?: number;
}

export type MockKeyword =
	| "ERROR500"
	| "ERROR"
	| "SLOW"
	/** Streams for far longer than any case waits, until the client closes: a tab that holds the stream lease. */
	| "HOLD"
	| "LONG"
	| "TOOL CREATE"
	| "TOOL READ"
	| "UNSAFE"
	/** No keyword matched but the user turn carries injected files: the reply names them. */
	| "FILES"
	/** First request carrying a `FLAKY <token>`: dies like ERROR. */
	| "FLAKY"
	/** Every later request with the same token: the default reply. */
	| "FLAKY_OK"
	| "TOOL RESULT"
	| "DEFAULT";

export interface MockRequest {
	at: number;
	stream: boolean;
	lastUserText: string;
	/** `"tool"` marks the second call of a tool turn. */
	lastRole: string;
	toolNames: string[];
	keyword: MockKeyword;
	/** File names flow injected into the last user turn as `--- File: <name> ---` blocks, in order. */
	attachedFiles: string[];
	/** Characters between those markers: how much attachment text actually reached the model. */
	attachedChars: number;
	/** The description the TOOL CREATE reply asked to insert. */
	createName?: string;
}

export interface MockLlm {
	port: number;
	/** The litellm `api_base`: `/chat/completions` is appended to it. */
	url: string;
	requests: MockRequest[];
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one reply does: text slices, then optionally a tool call, then optionally a dropped connection. */
interface Plan {
	keyword: MockKeyword;
	slices: string[];
	/** Delay before each slice. */
	gapMs: number;
	tool?: { name: string; args: string };
	/** Kill the socket after the slices, with no finish frame, usage chunk or [DONE]. */
	cut?: boolean;
	createName?: string;
}

const TOOL_NAMED_MS = 400;

const READ_ARGS = JSON.stringify({ doctype: "ToDo", fields: ["name", "description"], limit: 3 });

const DEFAULT_REPLY = [
	"## CF AI Test reply",
	"",
	"This answer has **bold** text, `inline code` and a [link](https://example.com/).",
	"",
	"```python",
	"def greet(name):",
	'    return f"hello {name}"',
	"```",
	"",
	"| Name | Value |",
	"| --- | --- |",
	"| alpha | 1 |",
	"| beta | 2 |",
	"",
].join("\n");

// Markup a sanitizer must neutralise: an inline handler, a script element, a javascript: URL, a handler
// on a hyphenated tag (which sanitizeHTML alone lets through), a full-page overlay and a remote image. The
// marker text after it proves the paragraph still rendered, so "nothing rendered" cannot pass as "sanitised".
const UNSAFE_REPLY = [
	"Safe text before.",
	"",
	'<img src="x" onerror="window.__cfAiPwned = 1">',
	"",
	"<script>window.__cfAiPwned = 2</script>",
	"",
	"[click me](javascript:window.__cfAiPwned=3)",
	"",
	'<x-a onmouseenter="window.__cfAiPwned = 4" style="position:fixed;inset:0">.</x-a>',
	"",
	'<div style="position:fixed;inset:0">x</div>',
	"",
	"![x](https://evil.example/px.png?q=1)",
	"",
	"Safe text after.",
	"",
].join("\n");

function slice(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

/** The text of a message `content`, which is a string or an array of `{type: "text", text}` parts. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
		.join("");
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
	const raw = body["messages"];
	return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function toolNamesOf(body: Record<string, unknown>): string[] {
	const raw = body["tools"];
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const tool of raw) {
		const fn = isRecord(tool) ? tool["function"] : undefined;
		if (isRecord(fn) && typeof fn["name"] === "string") names.push(fn["name"]);
	}
	return names;
}

function lastUserText(messages: Record<string, unknown>[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message !== undefined && message["role"] === "user") return contentText(message["content"]);
	}
	return "";
}

interface InjectedFiles {
	names: string[];
	chars: number;
}

// Flow appends `--- File: {name} ---\n{text}\n--- End of file: {name} ---` to the user turn the file was
// attached to (flow/flow/doctype/flow_session/flow_session.py). The backreference pairs each opening line
// with its own closing line, so a body that quotes another file's marker does not end early.
const FILE_BLOCK = /^--- File: (.+) ---\n([\s\S]*?)\n--- End of file: \1 ---$/gm;

/** The files flow injected into `text`, in order, and how many characters of their bodies it carried. */
function injectedFiles(text: string): InjectedFiles {
	const found: InjectedFiles = { names: [], chars: 0 };
	for (const block of text.matchAll(FILE_BLOCK)) {
		found.names.push(block[1] ?? "");
		found.chars += (block[2] ?? "").length;
	}
	return found;
}

function pickTool(names: string[], verb: string): string | undefined {
	return names.find((n) => n === verb || n.endsWith(`_${verb}`));
}

/** The description the model asked to insert, read back from the assistant message that made the call. */
function requestedCreateName(messages: Record<string, unknown>[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const calls =
			message !== undefined && message["role"] === "assistant" ? message["tool_calls"] : undefined;
		if (!Array.isArray(calls)) continue;
		for (const call of calls) {
			const fn = isRecord(call) ? call["function"] : undefined;
			const raw = isRecord(fn) ? fn["arguments"] : undefined;
			if (typeof raw !== "string") continue;
			try {
				const args: unknown = JSON.parse(raw);
				const records = isRecord(args) ? args["records"] : undefined;
				const first = Array.isArray(records) ? records[0] : undefined;
				const description = isRecord(first) ? first["description"] : undefined;
				if (typeof description === "string") return description;
			} catch {
				/* not JSON: keep looking */
			}
		}
	}
	return undefined;
}

/** The reply to a tool result: text only, chosen by what the result says. */
function toolResultPlan(messages: Record<string, unknown>[], toolContent: string): Plan {
	let text: string;
	if (/"status"\s*:\s*"redirect"/.test(toolContent)) {
		text = "Understood. I will adjust and try again.";
	} else if (/"created"/.test(toolContent)) {
		let name = requestedCreateName(messages);
		if (name === undefined) {
			try {
				const parsed: unknown = JSON.parse(toolContent);
				const created = isRecord(parsed) ? parsed["created"] : undefined;
				const first = Array.isArray(created) ? created[0] : undefined;
				name = typeof first === "string" ? first : "record";
			} catch {
				name = "record";
			}
		}
		text = `Created ${name}.`;
	} else {
		let count = 0;
		try {
			const parsed: unknown = JSON.parse(toolContent);
			if (Array.isArray(parsed)) count = parsed.length;
		} catch {
			/* unparseable reads count as none */
		}
		text = `I found ${count} ToDo records.`;
	}
	return { keyword: "TOOL RESULT", slices: slice(text, 8), gapMs: 10 };
}

function planFor(
	messages: Record<string, unknown>[],
	toolNames: string[],
	slowMs: number,
	nonce: number,
	flaky: Set<string>,
): Plan {
	const last = messages[messages.length - 1];
	if (last !== undefined && last["role"] === "tool") {
		return toolResultPlan(messages, contentText(last["content"]));
	}

	const typed = lastUserText(messages);
	const user = typed.toUpperCase();
	const has = (word: string): boolean => new RegExp(`\\b${word}\\b`).test(user);

	// A retry resends the very same text, so only the order of the two requests tells them apart.
	if (has("FLAKY")) {
		const token = /\bFLAKY\s+(\S+)/i.exec(typed)?.[1] ?? "";
		if (!flaky.has(token)) {
			flaky.add(token);
			return { keyword: "FLAKY", slices: ["Starting", " the work"], gapMs: 30, cut: true };
		}
		return { keyword: "FLAKY_OK", slices: slice(DEFAULT_REPLY, 8), gapMs: 10 };
	}
	if (has("ERROR500")) return { keyword: "ERROR500", slices: [], gapMs: 0 };
	if (has("ERROR")) return { keyword: "ERROR", slices: ["Starting", " the work"], gapMs: 30, cut: true };
	if (has("SLOW")) {
		return {
			keyword: "SLOW",
			slices: Array.from({ length: 40 }, (_unused, k) => `word${k} `),
			gapMs: slowMs,
		};
	}
	if (has("HOLD")) {
		return {
			keyword: "HOLD",
			slices: Array.from({ length: 400 }, (_unused, k) => `held${k} `),
			gapMs: slowMs,
		};
	}
	if (has("LONG")) {
		const filler = "The quick brown fox jumps over the lazy dog. ".repeat(5).slice(0, 200);
		return {
			keyword: "LONG",
			slices: Array.from({ length: 60 }, (_unused, k) => `Paragraph ${k + 1}: ${filler}\n\n`),
			gapMs: 20,
		};
	}
	if (has("TOOL CREATE")) {
		const tool = pickTool(toolNames, "create");
		if (tool === undefined) {
			return {
				keyword: "TOOL CREATE",
				slices: slice("CF AI Test mock: no create tool offered.", 8),
				gapMs: 10,
			};
		}
		const digits = /TOOL CREATE\s+(\d+)/.exec(user);
		const createName = `CF AI Test ${digits?.[1] ?? nonce}`;
		const args = JSON.stringify({ doctype: "ToDo", records: [{ description: createName }] });
		return {
			keyword: "TOOL CREATE",
			slices: slice("I will create the ToDo.", 8),
			gapMs: 10,
			tool: { name: tool, args },
			createName,
		};
	}
	if (has("TOOL READ")) {
		const tool = pickTool(toolNames, "read");
		if (tool === undefined) {
			return { keyword: "TOOL READ", slices: slice("CF AI Test mock: no read tool offered.", 8), gapMs: 10 };
		}
		return {
			keyword: "TOOL READ",
			slices: slice("Let me look at your ToDos.", 8),
			gapMs: 10,
			tool: { name: tool, args: READ_ARGS },
		};
	}
	if (has("UNSAFE")) return { keyword: "UNSAFE", slices: slice(UNSAFE_REPLY, 8), gapMs: 10 };
	// Last, so a keyword typed beside an attached file still steers the reply, as it does without one.
	const files = injectedFiles(typed).names;
	if (files.length > 0) {
		return {
			keyword: "FILES",
			slices: slice(`I read ${files.length} file(s): ${files.join(", ")}.`, 8),
			gapMs: 10,
		};
	}
	return { keyword: "DEFAULT", slices: slice(DEFAULT_REPLY, 8), gapMs: 10 };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMockLlm(options: MockLlmOptions = {}): Promise<MockLlm> {
	const slowMs = options.slowMs ?? 250;
	const requests: MockRequest[] = [];
	let sequence = 0;
	const flaky = new Set<string>();

	const respond = async (
		res: http.ServerResponse,
		body: Record<string, unknown>,
		plan: Plan,
		stream: boolean,
	): Promise<void> => {
		const id = `chatcmpl-cfai-${++sequence}`;
		const created = Math.floor(Date.now() / 1000);
		const model = typeof body["model"] === "string" ? body["model"] : "cf-ai-test";
		const callId = `call_cfai_${sequence}`;
		const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
		const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): string =>
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`;
		const delta = (d: Record<string, unknown>, finish: string | null = null): string =>
			chunk([{ index: 0, delta: d, finish_reason: finish }]);

		if (!stream) {
			const message: Record<string, unknown> = { role: "assistant", content: plan.slices.join("") };
			if (plan.tool) {
				message["tool_calls"] = [
					{ id: callId, type: "function", function: { name: plan.tool.name, arguments: plan.tool.args } },
				];
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					id,
					object: "chat.completion",
					created,
					model,
					choices: [{ index: 0, message, finish_reason: plan.tool ? "tool_calls" : "stop" }],
					usage,
				}),
			);
			return;
		}

		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(delta({ role: "assistant", content: "" }));

		for (const piece of plan.slices) {
			await sleep(plan.gapMs);
			// A stopped or reloaded client closes the socket; writing on would only fill the log.
			if (closed) return;
			res.write(delta({ content: piece }));
		}
		if (plan.cut) {
			await sleep(plan.gapMs);
			res.socket?.destroy();
			return;
		}
		if (plan.tool) {
			await sleep(plan.gapMs);
			if (closed) return;
			// Flow announces the call once id and name are known, then again when the arguments finish. The gap
			// between the two is the only window in which the browser can observe a step as processing before
			// the tool runs, so it is wide enough for a polling test to catch.
			res.write(
				delta({
					tool_calls: [
						{ index: 0, id: callId, type: "function", function: { name: plan.tool.name, arguments: "" } },
					],
				}),
			);
			await sleep(TOOL_NAMED_MS);
			for (const part of slice(plan.tool.args, 24)) {
				if (closed) return;
				res.write(delta({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
				await sleep(plan.gapMs);
			}
		}
		if (closed) return;
		res.write(delta({}, plan.tool ? "tool_calls" : "stop"));
		// litellm only surfaces usage when this chunk, with an empty `choices`, follows the finish frame.
		res.write(chunk([], { usage }));
		res.write("data: [DONE]\n\n");
		res.end();
	};

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
		const route = (req.url ?? "").split("?")[0];
		const json = (status: number, payload: unknown): void => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(payload));
		};

		if (req.method === "GET" && route === "/v1/models") return json(200, { object: "list", data: [] });
		if (req.method !== "POST" || route !== "/v1/chat/completions") {
			return json(404, { error: { message: `no route for ${req.method} ${route}`, type: "not_found" } });
		}

		const chunks: Buffer[] = [];
		for await (const part of req) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
		} catch {
			return json(400, { error: { message: "request body is not JSON", type: "invalid_request_error" } });
		}
		if (!isRecord(parsed)) {
			return json(400, {
				error: { message: "request body is not an object", type: "invalid_request_error" },
			});
		}

		const messages = messagesOf(parsed);
		const toolNames = toolNamesOf(parsed);
		const stream = parsed["stream"] === true;
		const plan = planFor(messages, toolNames, slowMs, Date.now() % 1e6, flaky);
		const last = messages[messages.length - 1];
		const userText = lastUserText(messages);
		const injected = injectedFiles(userText);
		requests.push({
			at: Date.now(),
			stream,
			lastUserText: userText,
			lastRole: last !== undefined && typeof last["role"] === "string" ? last["role"] : "",
			toolNames,
			keyword: plan.keyword,
			attachedFiles: injected.names,
			attachedChars: injected.chars,
			...(plan.createName === undefined ? {} : { createName: plan.createName }),
		});

		if (plan.keyword === "ERROR500") {
			return json(500, { error: { message: "CF AI Test mock failure", type: "server_error" } });
		}
		await respond(res, parsed, plan, stream);
	};

	const server = http.createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			console.error("mock-llm:", error);
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "mock failure", type: "server_error" } }));
		});
	});
	// Idle keep-alive sockets would hold close() open for the default 5 s after a suite.
	server.keepAliveTimeout = 1000;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
	});
	const address: AddressInfo | string | null = server.address();
	if (address === null || typeof address === "string") {
		throw new Error(`mock-llm could not read its port (got ${JSON.stringify(address)})`);
	}

	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				// A SLOW stream the client never closed would otherwise keep the server (and the suite) alive.
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

if (import.meta.main) {
	const flag = process.argv.indexOf("--port");
	const port = flag === -1 ? 0 : Number(process.argv[flag + 1]);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		console.error("usage: node scripts/shell/mock-llm.ts [--port <0-65535>]");
		process.exit(2);
	}
	const mock = await startMockLlm({ port });
	process.stdout.write(`mock-llm listening on ${mock.url}\n`);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void mock.close().then(() => process.exit(0));
		});
	}
}
