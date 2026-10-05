import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	FlowHttpError,
	attachFile,
	defaultFlowEnv,
	deleteFile,
	deleteSession,
	getSession,
	listRuns,
	listSessions,
	recoverSession,
	renameSession,
	resumeRun,
	serverMessage,
	startRun,
	stopRun,
	submitFeedback,
	uploadFile,
	xhrTransport,
	type FlowEnv,
	type UploadEnv,
	type UploadPost,
	type UploadProgress,
	type UploadReply,
	type XhrLike,
} from "../../../carbon_frappe/public/js/ai_chat/flow/client.ts";
import { createFlowClient } from "../../../carbon_frappe/public/js/ai_chat/controller.ts";
import type { FlowEvent } from "../../../carbon_frappe/public/js/ai_chat/flow/events.ts";
import {
	ANSWERS_APPROVE_ALL,
	ANSWERS_REDIRECT,
	HTTP_ERROR_FORBIDDEN,
	HTTP_ERROR_PAUSED,
	RESUME_APPROVED,
	RUN,
	SESSION,
	SESSION_COMPLETED,
	TEXT_TOOL_TEXT,
	bodyFrom,
	type TestBody,
} from "./fixtures.ts";

function substitute(source: string, replace: readonly string[] = []): string {
	return source.replace(/\{(\d+)\}/g, (_match, index: string) => replace[Number(index)] ?? "");
}

const identity = (source: string, replace?: readonly string[]): string => substitute(source, replace);
const upperCase = (source: string, replace?: readonly string[]): string =>
	substitute(source.toUpperCase(), replace);

interface FetchRecord {
	url: string;
	init: RequestInit;
}

interface CallRecord {
	method: string;
	args: Record<string, unknown> | undefined;
}

interface Harness {
	env: FlowEnv;
	fetches: FetchRecord[];
	calls: CallRecord[];
	/** The body handed to the most recent fetch, for `cancelled()`. */
	bodies: TestBody[];
	reply: { value: unknown };
}

/** Responds to fetch with `respond`, to call with `reply.value`. Never touches a global. */
function harness(
	respond: (harness: Harness) => Response | Promise<Response> = () => {
		throw new Error("unexpected fetch");
	},
	translate: FlowEnv["translate"] = identity,
): Harness {
	const state: Harness = {
		fetches: [],
		calls: [],
		bodies: [],
		reply: { value: null },
		env: {
			fetch: async (url, init) => {
				state.fetches.push({ url, init });
				return respond(state);
			},
			call: async (method, args) => {
				state.calls.push({ method, args });
				return state.reply.value;
			},
			csrfToken: () => "tok",
			translate,
		},
	};
	return state;
}

function sse(chunks: readonly string[], options: { hold?: boolean } = {}): (h: Harness) => Response {
	return (h) => {
		const body = bodyFrom(chunks, options);
		h.bodies.push(body);
		return new Response(body.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	};
}

async function collect(stream: AsyncIterable<FlowEvent>): Promise<FlowEvent[]> {
	const events: FlowEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function sentBody(record: FetchRecord | undefined): Record<string, unknown> {
	assert.ok(record, "expected a fetch");
	const parsed: unknown = JSON.parse(String(record.init.body));
	assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
	return Object.fromEntries(Object.entries(parsed));
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

describe("startRun", () => {
	it("does nothing until the first next(), then POSTs once with the two headers", async () => {
		const h = harness(sse([TEXT_TOOL_TEXT.wire]));
		const stream = startRun({ input: "hi" }, undefined, h.env);
		await Promise.resolve();
		assert.equal(h.fetches.length, 0);

		const events = await collect(stream);
		assert.equal(h.fetches.length, 1);
		const [record] = h.fetches;
		assert.equal(record?.url, "/api/method/flow.api.start_run");
		assert.equal(record?.init.method, "POST");
		const headers = new Headers(record?.init.headers);
		assert.equal(headers.get("Content-Type"), "application/json");
		assert.equal(headers.get("X-Frappe-CSRF-Token"), "tok");
		assert.deepEqual(events, TEXT_TOOL_TEXT.events);
	});

	it("sends exactly {input, stream: true} for a bare call", async () => {
		const h = harness(sse([]));
		await collect(startRun({ input: "hi" }, undefined, h.env));
		assert.deepEqual(sentBody(h.fetches[0]), { input: "hi", stream: true });
	});

	it("includes session and omits agent when both are given", async () => {
		const h = harness(sse([]));
		await collect(startRun({ input: "hi", session: SESSION, agent: "Flow" }, undefined, h.env));
		assert.deepEqual(sentBody(h.fetches[0]), { input: "hi", stream: true, session: SESSION });
	});

	it("includes agent when there is no session", async () => {
		const h = harness(sse([]));
		await collect(startRun({ input: "hi", agent: "Flow" }, undefined, h.env));
		assert.deepEqual(sentBody(h.fetches[0]), { input: "hi", stream: true, agent: "Flow" });
	});

	it("includes model, and attachments only when non-empty", async () => {
		const h = harness(sse([]));
		await collect(startRun({ input: "hi", model: "gpt", attachments: ["a.pdf", "b.png"] }, undefined, h.env));
		assert.deepEqual(sentBody(h.fetches[0]), {
			input: "hi",
			stream: true,
			model: "gpt",
			attachments: ["a.pdf", "b.png"],
		});

		await collect(startRun({ input: "hi", attachments: [] }, undefined, h.env));
		assert.deepEqual(Object.keys(sentBody(h.fetches[1])).sort(), ["input", "stream"]);
	});

	it("never sends a key whose value is undefined", async () => {
		const h = harness(sse([]));
		await collect(startRun({ input: "hi" }, undefined, h.env));
		const raw = String(h.fetches[0]?.init.body);
		assert.equal(raw.includes("null"), false);
		assert.deepEqual(Object.keys(sentBody(h.fetches[0])), ["input", "stream"]);
	});
});

describe("resumeRun", () => {
	it("POSTs {run_name, answers, stream: true} to resume_run and yields the resume events", async () => {
		const h = harness(sse([RESUME_APPROVED.wire]));
		const events = await collect(resumeRun(RUN, ANSWERS_APPROVE_ALL, undefined, h.env));
		assert.equal(h.fetches[0]?.url, "/api/method/flow.api.resume_run");
		assert.equal(h.fetches[0]?.init.method, "POST");
		assert.equal(new Headers(h.fetches[0]?.init.headers).get("X-Frappe-CSRF-Token"), "tok");
		assert.deepEqual(sentBody(h.fetches[0]), { run_name: RUN, answers: ANSWERS_APPROVE_ALL, stream: true });
		assert.deepEqual(events, RESUME_APPROVED.events);
	});

	it("sends a free-text redirect answer verbatim", async () => {
		const h = harness(sse([]));
		await collect(resumeRun(RUN, ANSWERS_REDIRECT, undefined, h.env));
		assert.deepEqual(sentBody(h.fetches[0])["answers"], ANSWERS_REDIRECT);
	});
});

describe("stream failures", () => {
	it("throws a FlowHttpError with the _server_messages text on a 417", async () => {
		const h = harness(
			() =>
				new Response(JSON.stringify(HTTP_ERROR_PAUSED.body), {
					status: HTTP_ERROR_PAUSED.status,
					headers: { "Content-Type": "application/json" },
				}),
		);
		await assert.rejects(collect(startRun({ input: "hi" }, undefined, h.env)), (error: unknown) => {
			assert.ok(error instanceof FlowHttpError);
			assert.equal(error.name, "FlowHttpError");
			assert.equal(error.status, 417);
			assert.equal(error.message, HTTP_ERROR_PAUSED.message);
			return true;
		});
	});

	it("reads _error_message for a 403", async () => {
		const h = harness(
			() => new Response(JSON.stringify(HTTP_ERROR_FORBIDDEN.body), { status: HTTP_ERROR_FORBIDDEN.status }),
		);
		await assert.rejects(collect(resumeRun(RUN, {}, undefined, h.env)), (error: unknown) => {
			assert.ok(error instanceof FlowHttpError);
			assert.equal(error.status, 403);
			assert.equal(error.message, HTTP_ERROR_FORBIDDEN.message);
			return true;
		});
	});

	it("falls back to the translated 'Request failed (status)' for a non-JSON body", async () => {
		const h = harness(() => new Response("<html>Bad Gateway</html>", { status: 502 }), upperCase);
		await assert.rejects(collect(startRun({ input: "hi" }, undefined, h.env)), (error: unknown) => {
			assert.ok(error instanceof FlowHttpError);
			assert.equal(error.status, 502);
			assert.equal(error.message, "REQUEST FAILED (502)");
			return true;
		});
	});

	it("falls back when a JSON error body carries no readable message", async () => {
		const h = harness(() => new Response("{}", { status: 500 }));
		await assert.rejects(
			collect(startRun({ input: "hi" }, undefined, h.env)),
			(error: unknown) => error instanceof FlowHttpError && error.message === "Request failed (500)",
		);
	});

	it("throws the same fallback for a 200 with no body", async () => {
		const h = harness(() => new Response(null, { status: 200 }), upperCase);
		await assert.rejects(collect(startRun({ input: "hi" }, undefined, h.env)), (error: unknown) => {
			assert.ok(error instanceof FlowHttpError);
			assert.equal(error.status, 200);
			assert.equal(error.message, "REQUEST FAILED (200)");
			return true;
		});
	});

	it("propagates a fetch rejection unchanged", async () => {
		const boom = new TypeError("Failed to fetch");
		const h = harness(() => Promise.reject(boom));
		await assert.rejects(
			collect(startRun({ input: "hi" }, undefined, h.env)),
			(error: unknown) => error === boom,
		);
	});
});

describe("abort propagation", () => {
	it("passes the signal to fetch, and omits the key without one", async () => {
		const controller = new AbortController();
		const h = harness(sse([]));
		await collect(startRun({ input: "hi" }, controller.signal, h.env));
		assert.equal(h.fetches[0]?.init.signal, controller.signal);

		await collect(startRun({ input: "hi" }, undefined, h.env));
		assert.equal("signal" in (h.fetches[1]?.init ?? {}), false);
	});

	it("rejects with the abort reason without calling fetch when already aborted", async () => {
		const h = harness(sse([]));
		await assert.rejects(collect(startRun({ input: "hi" }, AbortSignal.abort(), h.env)), isAbortError);
		await assert.rejects(collect(resumeRun(RUN, {}, AbortSignal.abort(), h.env)), isAbortError);
		assert.equal(h.fetches.length, 0);
	});

	it("rejects with a custom abort reason as given", async () => {
		const reason = new Error("navigated away");
		const h = harness(sse([]));
		await assert.rejects(
			collect(startRun({ input: "hi" }, AbortSignal.abort(reason), h.env)),
			(error: unknown) => error === reason,
		);
	});

	it("aborts mid-stream: the next read rejects with AbortError and the body is cancelled", async () => {
		const controller = new AbortController();
		const h = harness(sse([TEXT_TOOL_TEXT.wire], { hold: true }));
		const stream = startRun({ input: "hi" }, controller.signal, h.env);

		const first = await stream.next();
		assert.deepEqual(first.value, TEXT_TOOL_TEXT.events[0]);
		// Queued next() calls resolve in order, so this drains the rest without awaiting in a loop.
		await Promise.all(TEXT_TOOL_TEXT.events.slice(1).map(() => stream.next()));
		const pending = stream.next();
		controller.abort();
		await assert.rejects(pending, isAbortError);
		assert.equal(h.bodies[0]?.cancelled(), true);
	});

	it("cancels the body when the consumer stops early", async () => {
		const h = harness(sse([TEXT_TOOL_TEXT.wire], { hold: true }));
		for await (const _event of startRun({ input: "hi" }, undefined, h.env)) break;
		assert.equal(h.bodies[0]?.cancelled(), true);
	});
});

/** The `_server_messages` of a `frappe.throw` with these texts. */
function serverMessages(...texts: string[]): Record<string, unknown> {
	return { _server_messages: JSON.stringify(texts.map((message) => JSON.stringify({ message }))) };
}

describe("serverMessage", () => {
	function withMessages(...messages: unknown[]): Record<string, unknown> {
		return { _server_messages: JSON.stringify(messages.map((m) => JSON.stringify(m))) };
	}

	it("strips HTML tags and collapses whitespace", () => {
		assert.equal(
			serverMessage(withMessages({ message: "<strong>Stop</strong>  now,\n  <a href='x'>please</a>" })),
			"Stop now, please",
		);
	});

	it("uses the first of two messages", () => {
		assert.equal(serverMessage(withMessages({ message: "first" }, { message: "second" })), "first");
	});

	it("skips an empty first message in favour of the next, then of exception", () => {
		assert.equal(serverMessage(withMessages({ message: "" }, { message: "second" })), "second");
		assert.equal(
			serverMessage({
				...withMessages({ message: "" }),
				exception: "frappe.exceptions.ValidationError: Boom",
			}),
			"Boom",
		);
	});

	it("skips a message that is only markup", () => {
		assert.equal(
			serverMessage({ ...withMessages({ message: "<br>" }), _error_message: "fallback" }),
			"fallback",
		);
	});

	it("strips a leading module.Class prefix from exception, and keeps a bare one", () => {
		assert.equal(
			serverMessage({ exception: "frappe.exceptions.PermissionError: Not allowed" }),
			"Not allowed",
		);
		assert.equal(serverMessage({ exception: "Plain failure" }), "Plain failure");
		assert.equal(serverMessage({ exception: "Note: keep the later colon: ok" }), "keep the later colon: ok");
	});

	it("strips markup from exception, and drops a bare class name as no message", () => {
		assert.equal(
			serverMessage({
				exception:
					"frappe.exceptions.PermissionError: <details><summary>Not permitted</summary>Function <strong>x</strong> is not whitelisted.</details>",
			}),
			"Not permittedFunction x is not whitelisted.",
		);
		assert.equal(serverMessage({ exception: "frappe.exceptions.PermissionError" }), null);
		assert.equal(
			serverMessage({ exception: "frappe.exceptions.PermissionError", _error_message: "kept" }),
			"kept",
		);
	});

	it("reads _error_message last", () => {
		assert.equal(serverMessage({ _error_message: "Not permitted" }), "Not permitted");
		assert.equal(serverMessage({ exception: "a.B: first", _error_message: "second" }), "first");
	});

	it("falls through malformed _server_messages instead of throwing", () => {
		assert.equal(serverMessage({ _server_messages: "not json", _error_message: "kept" }), "kept");
		assert.equal(serverMessage({ _server_messages: '{"a": 1}', _error_message: "kept" }), "kept");
		assert.equal(serverMessage({ _server_messages: '["not json either"]', _error_message: "kept" }), "kept");
		assert.equal(serverMessage({ _server_messages: 5, _error_message: "kept" }), "kept");
	});

	it("returns null for a non-record and for an empty record", () => {
		assert.equal(serverMessage(null), null);
		assert.equal(serverMessage(undefined), null);
		assert.equal(serverMessage("boom"), null);
		assert.equal(serverMessage(["boom"]), null);
		assert.equal(serverMessage(5), null);
		assert.equal(serverMessage({}), null);
		assert.equal(serverMessage({ exception: "", _error_message: "" }), null);
	});

	it("reads the recorded fixtures", () => {
		assert.equal(serverMessage(HTTP_ERROR_PAUSED.body), HTTP_ERROR_PAUSED.message);
		assert.equal(serverMessage(HTTP_ERROR_FORBIDDEN.body), HTTP_ERROR_FORBIDDEN.message);
	});
});

describe("plain calls", () => {
	it("stopRun", async () => {
		const h = harness();
		h.reply.value = { status: "Failed" };
		assert.equal(await stopRun(RUN, h.env), undefined);
		assert.deepEqual(h.calls, [{ method: "flow.api.stop_run", args: { run_name: RUN } }]);
	});

	it("recoverSession returns the recovered count, 0 for anything else", async () => {
		const h = harness();
		h.reply.value = { recovered: 3 };
		assert.equal(await recoverSession(SESSION, h.env), 3);
		assert.deepEqual(h.calls[0], { method: "flow.api.recover_session", args: { session: SESSION } });
		const counts = await Promise.all(
			[null, undefined, "3", 3, [], {}, { recovered: "3" }].map((reply) => {
				const other = harness();
				other.reply.value = reply;
				return recoverSession(SESSION, other.env);
			}),
		);
		assert.deepEqual(counts, [0, 0, 0, 0, 0, 0, 0]);
	});

	it("submitFeedback sends comment null for empty or missing, and passes None through", async () => {
		const h = harness();
		await submitFeedback(RUN, "Down", "Too curt", h.env);
		await submitFeedback(RUN, "Up", "", h.env);
		await submitFeedback(RUN, "None", undefined, h.env);
		assert.deepEqual(h.calls, [
			{
				method: "flow.api.submit_feedback",
				args: { run_name: RUN, rating: "Down", comment: "Too curt" },
			},
			{ method: "flow.api.submit_feedback", args: { run_name: RUN, rating: "Up", comment: null } },
			{ method: "flow.api.submit_feedback", args: { run_name: RUN, rating: "None", comment: null } },
		]);
	});

	it("rejects with whatever call rejects with", async () => {
		const boom = new Error("denied");
		const h = harness();
		h.env.call = () => Promise.reject(boom);
		await assert.rejects(stopRun(RUN, h.env), (error: unknown) => error === boom);
		await assert.rejects(deleteSession("x", h.env), (error: unknown) => error === boom);
		await assert.rejects(listRuns(SESSION, h.env), (error: unknown) => error === boom);
	});
});

describe("listSessions", () => {
	const user = "kevin@avu.nu";

	it("sends the owner, non-trigger and ordering filters with limit_page_length 50", async () => {
		const h = harness();
		h.reply.value = [];
		await listSessions(user, {}, h.env);
		assert.deepEqual(h.calls, [
			{
				method: "frappe.client.get_list",
				args: {
					doctype: "Flow Session",
					filters: { owner: user, source: ["!=", "Trigger"] },
					fields: ["name", "title", "modified"],
					order_by: "modified desc",
					limit_page_length: 50,
				},
			},
		]);
		assert.equal("limit" in (h.calls[0]?.args ?? {}), false);
	});

	it("honours an explicit limit under limit_page_length, never `limit`", async () => {
		const h = harness();
		await listSessions(user, { limit: 7 }, h.env);
		assert.equal(h.calls[0]?.args?.["limit_page_length"], 7);
		assert.equal("limit" in (h.calls[0]?.args ?? {}), false);
	});

	it("parses the reply and drops invalid entries", async () => {
		const h = harness();
		h.reply.value = [
			{ name: "a", title: "One", modified: "2026-10-01 09:00:00" },
			{ title: "no name" },
			null,
			{ name: "b", title: null },
			{ name: 5 },
		];
		assert.deepEqual(await listSessions(user, {}, h.env), [
			{ name: "a", title: "One", modified: "2026-10-01 09:00:00" },
			{ name: "b", title: null },
		]);
		h.reply.value = "garbage";
		assert.deepEqual(await listSessions(user, {}, h.env), []);
	});
});

describe("session and run reads", () => {
	it("getSession sends frappe.client.get and returns the parsed doc", async () => {
		const h = harness();
		h.reply.value = SESSION_COMPLETED.session;
		const doc = await getSession(SESSION, h.env);
		assert.deepEqual(h.calls, [
			{ method: "frappe.client.get", args: { doctype: "Flow Session", name: SESSION } },
		]);
		// The parser keeps only string-valued fields, so the fixture's `model: null` is dropped.
		const { model: _model, ...expected } = SESSION_COMPLETED.session;
		assert.deepEqual(doc, expected);
		assert.equal(doc.messages.length, SESSION_COMPLETED.session.messages.length);
	});

	it("getSession drops invalid rows but keeps the session", async () => {
		const h = harness();
		h.reply.value = { name: SESSION, messages: [{ role: "user", content: "hi" }, { content: "no role" }] };
		const doc = await getSession(SESSION, h.env);
		assert.equal(doc.name, SESSION);
		assert.deepEqual(doc.messages, [{ role: "user", content: "hi" }]);
	});

	it("getSession throws the translated error for an unusable reply", async () => {
		await Promise.all(
			[null, {}, "x", [], { name: 5 }].map((reply) => {
				const h = harness(undefined, upperCase);
				h.reply.value = reply;
				return assert.rejects(
					getSession(SESSION, h.env),
					(error: unknown) =>
						error instanceof Error &&
						!(error instanceof FlowHttpError) &&
						error.message === "UNEXPECTED RESPONSE FROM THE SERVER.",
				);
			}),
		);
	});

	it("listRuns asks for creation asc with no page limit and parses the reply", async () => {
		const h = harness();
		h.reply.value = [...SESSION_COMPLETED.runs, { name: "bad" }, { name: "x", session: "s", status: "Odd" }];
		const runs = await listRuns(SESSION, h.env);
		assert.deepEqual(h.calls, [
			{
				method: "frappe.client.get_list",
				args: {
					doctype: "Flow Run",
					filters: { session: SESSION },
					fields: [
						"name",
						"session",
						"status",
						"questions",
						"error",
						"feedback_rating",
						"feedback_comment",
						"creation",
					],
					order_by: "creation asc",
					limit_page_length: 0,
				},
			},
		]);
		assert.deepEqual(runs, SESSION_COMPLETED.runs);
	});
});

describe("renameSession and deleteSession", () => {
	it("renameSession trims and sends set_value", async () => {
		const h = harness();
		assert.equal(await renameSession(SESSION, "  Quarterly plan \n", h.env), undefined);
		assert.deepEqual(h.calls, [
			{
				method: "frappe.client.set_value",
				args: { doctype: "Flow Session", name: SESSION, fieldname: "title", value: "Quarterly plan" },
			},
		]);
	});

	it("renameSession rejects a blank title without calling", async () => {
		const h = harness(undefined, upperCase);
		await Promise.all(
			["", "   ", "\t\n"].map((title) =>
				assert.rejects(
					renameSession(SESSION, title, h.env),
					(error: unknown) => error instanceof Error && error.message === "A TITLE IS REQUIRED.",
				),
			),
		);
		assert.equal(h.calls.length, 0);
	});

	it("deleteSession sends frappe.client.delete", async () => {
		const h = harness();
		assert.equal(await deleteSession(SESSION, h.env), undefined);
		assert.deepEqual(h.calls, [
			{ method: "frappe.client.delete", args: { doctype: "Flow Session", name: SESSION } },
		]);
	});
});

describe("defaultFlowEnv", () => {
	const saved = new Map<string, PropertyDescriptor | undefined>();

	function install(values: Record<string, unknown>): void {
		for (const [key, value] of Object.entries(values)) {
			if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		}
	}

	afterEach(() => {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		saved.clear();
	});

	it("can be constructed with no globals, and only throws once a field is used", async () => {
		assert.equal(Reflect.has(globalThis, "frappe"), false);
		assert.equal(Reflect.has(globalThis, "__"), false);
		const env = defaultFlowEnv();
		assert.throws(() => env.csrfToken());
		assert.throws(() => env.translate("x"));
		await assert.rejects(env.call("m"), Error);
	});

	it("reads frappe.csrf_token, __ and fetch at call time, not construction time", async () => {
		const env = defaultFlowEnv();
		const seen: { url: string; init: RequestInit }[] = [];
		install({
			frappe: { csrf_token: "csrf-xyz" },
			__: (source: string, replace?: readonly string[]) => `T[${source}|${(replace ?? []).join(",")}]`,
			fetch: async (url: string, init: RequestInit) => {
				seen.push({ url, init });
				return Response.json({ message: { ok: true } });
			},
		});
		assert.equal(env.csrfToken(), "csrf-xyz");
		assert.equal(env.translate("Hello {0}", ["a", "b"]), "T[Hello {0}|a,b]");
		assert.equal(env.translate("Plain"), "T[Plain|]");

		assert.deepEqual(await env.call("flow.api.stop_run", { run_name: "r" }), { ok: true });
		await env.call("flow.api.noargs");
		assert.deepEqual(
			seen.map(({ url, init }) => [url, init.method, init.body]),
			[
				["/api/method/flow.api.stop_run", "POST", '{"run_name":"r"}'],
				["/api/method/flow.api.noargs", "POST", "{}"],
			],
		);
		assert.equal(new Headers(seen[0]?.init.headers).get("X-Frappe-CSRF-Token"), "csrf-xyz");

		install({ frappe: { csrf_token: "second" } });
		assert.equal(env.csrfToken(), "second");
	});

	// frappe.xcall rejects with `undefined` for these (see the module header); the plain
	// calls must reject with an Error that carries the server's reason instead.
	it("call rejects with a FlowHttpError carrying the server's reason", async () => {
		const env = defaultFlowEnv();
		const respond: { response: () => Response } = { response: () => new Response() };
		install({
			frappe: { csrf_token: "t" },
			__: identity,
			fetch: async () => respond.response(),
		});

		respond.response = () => Response.json(HTTP_ERROR_PAUSED.body, { status: HTTP_ERROR_PAUSED.status });
		await assert.rejects(
			env.call("flow.api.stop_run", {}),
			(error: unknown) =>
				error instanceof FlowHttpError && error.status === 417 && error.message === HTTP_ERROR_PAUSED.message,
		);

		respond.response = () => Response.json(HTTP_ERROR_FORBIDDEN.body, { status: 403 });
		await assert.rejects(
			env.call("frappe.client.get", {}),
			(error: unknown) => error instanceof FlowHttpError && error.message === HTTP_ERROR_FORBIDDEN.message,
		);

		// A 404/500 with no JSON body at all, which xcall also turns into `undefined`.
		const rejectsWith = async (status: number): Promise<void> => {
			respond.response = () => new Response("<html>nope</html>", { status });
			await assert.rejects(
				env.call("frappe.client.get", {}),
				(error: unknown) =>
					error instanceof FlowHttpError &&
					error.status === status &&
					error.message === `Request failed (${status})`,
			);
		};
		await rejectsWith(404);
		await rejectsWith(500);
		await rejectsWith(502);
	});

	it("call passes keepalive to fetch only when asked", async () => {
		const env = defaultFlowEnv();
		const inits: RequestInit[] = [];
		install({
			frappe: { csrf_token: "t" },
			__: identity,
			fetch: async (_url: string, init: RequestInit) => {
				inits.push(init);
				return Response.json({ message: null });
			},
		});
		await env.call("frappe.client.delete", {});
		await deleteFile("D1", env, { keepalive: true });
		assert.equal(inits[0]?.keepalive, undefined);
		assert.equal(inits[1]?.keepalive, true);
	});

	it("call resolves undefined when a 2xx body has no message", async () => {
		const env = defaultFlowEnv();
		install({
			frappe: { csrf_token: "t" },
			__: identity,
			fetch: async () => new Response("not json", { status: 200 }),
		});
		assert.equal(await env.call("flow.api.stop_run", {}), undefined);
	});

	it("delegates fetch to the current globalThis.fetch", async () => {
		const env = defaultFlowEnv();
		const seen: unknown[][] = [];
		const response = new Response("ok");
		install({
			fetch: async (...args: unknown[]) => {
				seen.push(args);
				return response;
			},
		});
		const init = { method: "POST" };
		assert.equal(await env.fetch("/x", init), response);
		assert.deepEqual(seen, [["/x", init]]);
	});
});

// -- uploads ------------------------------------------------------------------

interface PostRecord {
	url: string;
	body: FormData;
	options: UploadPost;
}

interface UploadHarness {
	env: UploadEnv;
	posts: PostRecord[];
	/** What the next `post` does. */
	reply: { run: (record: PostRecord) => Promise<UploadReply> };
}

function uploadHarness(translate: UploadEnv["translate"] = identity): UploadHarness {
	const state: UploadHarness = {
		posts: [],
		reply: { run: async () => ({ status: 200, body: "" }) },
		env: {
			csrfToken: () => "tok",
			translate,
			transport: {
				post: (url, body, options) => {
					const record = { url, body, options };
					state.posts.push(record);
					return state.reply.run(record);
				},
			},
		},
	};
	return state;
}

function replyWith(status: number, body: unknown): UploadHarness["reply"] {
	return { run: async () => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) }) };
}

const DOC = {
	name: "49ec5dd196",
	file_name: "CF AI Test notes.txt",
	file_url: "/private/files/CF AI Test notes.txt",
	file_size: 16,
};

describe("uploadFile", () => {
	it("posts the file privately with the CSRF header and maps the File doc", async () => {
		const h = uploadHarness();
		h.reply = replyWith(200, { message: DOC });
		const file = new File(["hello"], "CF AI Test notes.txt", { type: "text/plain" });

		const uploaded = await uploadFile(file, {}, h.env);

		assert.deepEqual(uploaded, {
			name: "49ec5dd196",
			fileName: "CF AI Test notes.txt",
			fileUrl: "/private/files/CF AI Test notes.txt",
			fileSize: 16,
		});
		assert.equal(h.posts.length, 1);
		const [post] = h.posts;
		assert.equal(post?.url, "/api/method/upload_file");
		assert.deepEqual(post?.options.headers, { "X-Frappe-CSRF-Token": "tok" });
		const sent = post?.body.get("file");
		assert.ok(sent instanceof File);
		assert.equal(sent.name, "CF AI Test notes.txt");
		assert.equal(await sent.text(), "hello");
		assert.equal(post?.body.get("is_private"), "1");
		assert.deepEqual([...(post?.body.keys() ?? [])].sort(), ["file", "is_private"]);
	});

	it("falls back to the file's name and null for a url and size the server left out", async () => {
		const h = uploadHarness();
		h.reply = replyWith(200, { message: { name: "x1", file_name: "", file_url: "", file_size: "big" } });
		assert.deepEqual(await uploadFile(new File(["a"], "a.txt"), {}, h.env), {
			name: "x1",
			fileName: "a.txt",
			fileUrl: null,
			fileSize: null,
		});
	});

	it("hands the signal and the progress callback to the transport", async () => {
		const h = uploadHarness();
		h.reply = replyWith(200, { message: DOC });
		const controller = new AbortController();
		const seen: UploadProgress[] = [];
		const onProgress = (progress: UploadProgress): void => void seen.push(progress);

		await uploadFile(new File(["a"], "a.txt"), { signal: controller.signal, onProgress }, h.env);

		const [post] = h.posts;
		assert.equal(post?.options.signal, controller.signal);
		post?.options.onProgress?.({ loaded: 1, total: 2 });
		assert.deepEqual(seen, [{ loaded: 1, total: 2 }]);
	});

	it("passes neither when none was given", async () => {
		const h = uploadHarness();
		h.reply = replyWith(200, { message: DOC });
		await uploadFile(new File(["a"], "a.txt"), {}, h.env);
		assert.deepEqual(Object.keys(h.posts[0]?.options ?? {}), ["headers"]);
	});

	it("rejects with an AbortError, and never calls the transport, when the signal was already aborted", async () => {
		const h = uploadHarness();
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), { signal: controller.signal }, h.env),
			isAbortError,
		);
		assert.equal(h.posts.length, 0);
	});

	it("rejects with the transport's AbortError when the signal fires during the transfer", async () => {
		const h = uploadHarness();
		h.reply = { run: () => Promise.reject(new DOMException("aborted", "AbortError")) };
		await assert.rejects(uploadFile(new File(["a"], "a.txt"), {}, h.env), isAbortError);
	});

	it("reads the server's reason from a failing status", async () => {
		const h = uploadHarness();
		h.reply = replyWith(417, HTTP_ERROR_PAUSED.body);
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError && error.status === 417 && error.message === HTTP_ERROR_PAUSED.message,
		);
	});

	it("words a 413 with no body, and any other bodiless failure, itself", async () => {
		const h = uploadHarness();
		h.reply = replyWith(413, "<html>Request Entity Too Large</html>");
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError &&
				error.status === 413 &&
				error.message === "The file is larger than the server accepts.",
		);
		h.reply = replyWith(502, "");
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError && error.status === 502 && error.message === "Upload failed (502)",
		);
	});

	it("prefers the server's reason to its own wording for a 413", async () => {
		const h = uploadHarness();
		h.reply = replyWith(413, serverMessages("Too big"));
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) => error instanceof FlowHttpError && error.message === "Too big",
		);
	});

	it("never shows a traceback line as the reason", async () => {
		const failure = async (status: number, body: unknown): Promise<string> => {
			const h = uploadHarness();
			h.reply = replyWith(status, body);
			try {
				await uploadFile(new File(["a"], "a.txt"), {}, h.env);
			} catch (error) {
				if (error instanceof FlowHttpError) return error.message;
			}
			return "no error";
		};
		const expired = "Your session may have expired. Reload the page and try again.";
		assert.equal(await failure(403, { exception: "frappe.exceptions.PermissionError" }), expired);
		assert.equal(await failure(401, {}), expired);
		assert.equal(await failure(500, { exception: "OSError: Truncated File Read" }), "Upload failed (500)");
		assert.equal(
			await failure(413, { exception: "werkzeug.exceptions.RequestEntityTooLarge" }),
			"The file is larger than the server accepts.",
		);
		assert.equal(
			await failure(403, {
				...serverMessages("You may not upload here"),
				exception: "frappe.exceptions.PermissionError",
			}),
			"You may not upload here",
		);
	});

	it("turns any other transport failure into the connection sentence with status 0", async () => {
		const h = uploadHarness();
		h.reply = { run: () => Promise.reject(new Error("socket hang up")) };
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError &&
				error.status === 0 &&
				error.message === "The upload failed. Check your connection and try again.",
		);
		h.reply = { run: () => Promise.reject("not even an error") };
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) => error instanceof FlowHttpError && error.status === 0,
		);
	});

	it("rejects a success without message.name as an unexpected response", async () => {
		const h = uploadHarness();
		for (const body of [
			"",
			"not json",
			{ message: null },
			{ message: {} },
			{ message: { name: "" } },
			{ message: { name: 4 } },
			[],
		]) {
			h.reply = replyWith(200, body);
			// oxlint-disable-next-line no-await-in-loop -- each case reads the reply the previous one left in place
			await assert.rejects(
				uploadFile(new File(["a"], "a.txt"), {}, h.env),
				(error: unknown) =>
					error instanceof Error &&
					!(error instanceof FlowHttpError) &&
					error.message === "Unexpected response from the server.",
			);
		}
	});

	it("translates its own sentences", async () => {
		const h = uploadHarness(upperCase);
		h.reply = replyWith(502, "");
		await assert.rejects(
			uploadFile(new File(["a"], "a.txt"), {}, h.env),
			(error: unknown) => error instanceof Error && error.message === "UPLOAD FAILED (502)",
		);
	});
});

/** A scriptable XMLHttpRequest stand-in that records what the transport did to it. */
class FakeXhr implements XhrLike {
	calls: string[] = [];
	headers: [string, string][] = [];
	sent: FormData | null = null;
	statusCode = 200;
	text = "";
	private progress: ((progress: UploadProgress) => void)[] = [];
	private load: (() => void)[] = [];
	private error: (() => void)[] = [];
	private abortListeners: (() => void)[] = [];
	/** Whether `abort()` fires the "abort" event, as a real request in flight does. */
	firesAbort = true;
	throwOnSend: Error | null = null;
	throwOnOpen: Error | null = null;

	open(method: "POST", url: string): void {
		if (this.throwOnOpen) throw this.throwOnOpen;
		this.calls.push(`open ${method} ${url}`);
	}
	setRequestHeader(name: string, value: string): void {
		this.headers.push([name, value]);
	}
	send(body: FormData): void {
		if (this.throwOnSend) throw this.throwOnSend;
		this.calls.push("send");
		this.sent = body;
	}
	abort(): void {
		this.calls.push("abort");
		if (this.firesAbort) for (const listener of this.abortListeners) listener();
	}
	status(): number {
		return this.statusCode;
	}
	responseText(): string {
		return this.text;
	}
	onProgress(listener: (progress: UploadProgress) => void): void {
		this.progress.push(listener);
	}
	onLoad(listener: () => void): void {
		this.load.push(listener);
	}
	onError(listener: () => void): void {
		this.error.push(listener);
	}
	onAbort(listener: () => void): void {
		this.abortListeners.push(listener);
	}
	emitProgress(loaded: number, total: number): void {
		for (const listener of this.progress) listener({ loaded, total });
	}
	emitLoad(status: number, text: string): void {
		this.statusCode = status;
		this.text = text;
		for (const listener of this.load) listener();
	}
	emitError(): void {
		for (const listener of this.error) listener();
	}
}

/** Counts the listeners an AbortSignal holds, which the signal itself does not expose. */
function watchedSignal(): { signal: AbortSignal; listeners: () => number; controller: AbortController } {
	const controller = new AbortController();
	const { signal } = controller;
	let count = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void => {
		count += 1;
		add(type, listener, options);
	};
	signal.removeEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void => {
		count -= 1;
		remove(type, listener, options);
	};
	return { signal, listeners: () => count, controller };
}

describe("xhrTransport", () => {
	const form = (): FormData => {
		const data = new FormData();
		data.append("is_private", "1");
		return data;
	};

	it("opens, sets every header, sends the form, and resolves with the status and text on load", async () => {
		const xhr = new FakeXhr();
		const transport = xhrTransport(() => xhr);
		const body = form();
		const pending = transport.post("/up", body, { headers: { A: "1", B: "2" } });
		assert.deepEqual(xhr.calls, ["open POST /up", "send"]);
		assert.deepEqual(xhr.headers, [
			["A", "1"],
			["B", "2"],
		]);
		assert.equal(xhr.sent, body);
		xhr.emitLoad(417, '{"a":1}');
		assert.deepEqual(await pending, { status: 417, body: '{"a":1}' });
	});

	it("reports progress in order and none after it settled", async () => {
		const xhr = new FakeXhr();
		const seen: UploadProgress[] = [];
		const pending = xhrTransport(() => xhr).post("/up", form(), {
			headers: {},
			onProgress: (progress) => void seen.push(progress),
		});
		xhr.emitProgress(10, 100);
		xhr.emitProgress(60, 100);
		xhr.emitProgress(0, 0);
		xhr.emitLoad(200, "");
		xhr.emitProgress(100, 100);
		await pending;
		assert.deepEqual(seen, [
			{ loaded: 10, total: 100 },
			{ loaded: 60, total: 100 },
			{ loaded: 0, total: 0 },
		]);
	});

	it("works without a progress callback", async () => {
		const xhr = new FakeXhr();
		const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {} });
		xhr.emitProgress(1, 2);
		xhr.emitLoad(200, "ok");
		assert.deepEqual(await pending, { status: 200, body: "ok" });
	});

	it("rejects with an Error when the request fails", async () => {
		const xhr = new FakeXhr();
		const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {} });
		xhr.emitError();
		await assert.rejects(pending, (error: unknown) => error instanceof Error && !isAbortError(error));
	});

	it("aborts the request and rejects with an AbortError when the signal fires mid-flight", async () => {
		const xhr = new FakeXhr();
		const { signal, controller, listeners } = watchedSignal();
		const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {}, signal });
		assert.equal(listeners(), 1);
		xhr.emitProgress(5, 10);
		controller.abort();
		await assert.rejects(pending, isAbortError);
		assert.deepEqual(xhr.calls, ["open POST /up", "send", "abort"]);
		assert.equal(listeners(), 0, "the signal listener is removed once settled");
	});

	it("rejects at once even when the abort fires no event (a request not yet in flight)", async () => {
		const xhr = new FakeXhr();
		xhr.firesAbort = false;
		const { controller } = watchedSignal();
		const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {}, signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, isAbortError);
	});

	it("rejects before opening anything when the signal is already aborted", async () => {
		let created = 0;
		const controller = new AbortController();
		controller.abort();
		const transport = xhrTransport(() => {
			created += 1;
			return new FakeXhr();
		});
		await assert.rejects(
			transport.post("/up", form(), { headers: {}, signal: controller.signal }),
			isAbortError,
		);
		assert.equal(created, 0);
	});

	it("settles once: a late load, error or abort after the first outcome changes nothing", async () => {
		const xhr = new FakeXhr();
		const { signal, controller, listeners } = watchedSignal();
		const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {}, signal });
		xhr.emitLoad(200, "first");
		xhr.emitError();
		controller.abort();
		assert.deepEqual(await pending, { status: 200, body: "first" });
		assert.equal(listeners(), 0);
		assert.deepEqual(xhr.calls, ["open POST /up", "send"], "an abort after the response is not forwarded");
	});

	it("removes the signal listener after a load, an error and an abort event alike", async () => {
		for (const finish of [
			(x: FakeXhr) => x.emitLoad(200, ""),
			(x: FakeXhr) => x.emitError(),
			(x: FakeXhr) => x.abort(),
		]) {
			const xhr = new FakeXhr();
			const { signal, listeners } = watchedSignal();
			const pending = xhrTransport(() => xhr).post("/up", form(), { headers: {}, signal });
			finish(xhr);
			// oxlint-disable-next-line no-await-in-loop -- one transport at a time keeps the listener count per case
			await pending.catch(() => undefined);
			assert.equal(listeners(), 0);
		}
	});

	it("rejects when the factory, open or send throws, without leaving a listener", async () => {
		const boom = new Error("boom");
		await assert.rejects(
			xhrTransport(() => {
				throw boom;
			}).post("/up", form(), { headers: {} }),
			boom,
		);
		const opens = new FakeXhr();
		opens.throwOnOpen = boom;
		await assert.rejects(xhrTransport(() => opens).post("/up", form(), { headers: {} }), boom);
		const sends = new FakeXhr();
		sends.throwOnSend = boom;
		const { signal, listeners } = watchedSignal();
		await assert.rejects(xhrTransport(() => sends).post("/up", form(), { headers: {}, signal }), boom);
		assert.equal(listeners(), 0);
	});
});

describe("attachFile", () => {
	const ok = (message: unknown) => () =>
		new Response(JSON.stringify({ message }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	it("posts the File doc to attach_file and maps the reply", async () => {
		const h = harness(ok({ file: "49ec5dd196", file_name: "CF AI Test notes.txt", file_size: 16 }));
		const attached = await attachFile("49ec5dd196", undefined, h.env);
		assert.deepEqual(attached, { file: "49ec5dd196", fileName: "CF AI Test notes.txt", fileSize: 16 });
		assert.equal(h.fetches[0]?.url, "/api/method/flow.api.attach_file");
		assert.equal(new Headers(h.fetches[0]?.init.headers).get("X-Frappe-CSRF-Token"), "tok");
		assert.deepEqual(sentBody(h.fetches[0]), { file: "49ec5dd196" });
	});

	it("reads a missing size as 0 and a missing name as the File doc", async () => {
		const h = harness(ok({ file: "abc" }));
		assert.deepEqual(await attachFile("abc", undefined, h.env), {
			file: "abc",
			fileName: "abc",
			fileSize: 0,
		});
	});

	it("rejects a reply without message.file as unexpected", async () => {
		for (const message of [null, {}, { file: "" }, { file: 3 }, "x"]) {
			const h = harness(ok(message));
			// oxlint-disable-next-line no-await-in-loop -- independent cases, run in order for a readable failure
			await assert.rejects(
				attachFile("abc", undefined, h.env),
				(error: unknown) =>
					error instanceof Error &&
					!(error instanceof FlowHttpError) &&
					error.message === "Unexpected response from the server.",
			);
		}
		const h = harness(() => new Response("nope", { status: 200 }));
		await assert.rejects(attachFile("abc", undefined, h.env), /Unexpected response/);
	});

	it("throws flow's reason as a FlowHttpError", async () => {
		const body = {
			exc_type: "ValidationError",
			_server_messages: JSON.stringify([
				JSON.stringify({ message: "No readable text found in this file.", title: "Empty File" }),
			]),
		};
		const h = harness(() => Response.json(body, { status: 417 }));
		await assert.rejects(
			attachFile("abc", undefined, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError &&
				error.status === 417 &&
				error.message === "No readable text found in this file.",
		);
	});

	it("says the file could not be read for a 500 whose only text is a traceback line", async () => {
		for (const exception of [
			"zipfile.BadZipFile: File is not a zip file",
			"PIL.UnidentifiedImageError: cannot identify image file <_io.BytesIO object at 0x7ffeb9304ea0>",
		]) {
			const h = harness(() => Response.json({ exception }, { status: 500 }));
			// oxlint-disable-next-line no-await-in-loop -- independent cases, run in order for a readable failure
			await assert.rejects(
				attachFile("abc", undefined, h.env),
				(error: unknown) =>
					error instanceof FlowHttpError &&
					error.status === 500 &&
					error.message === "The file could not be read.",
			);
		}
	});

	it("says the session may have expired for a 403 that carries no message", async () => {
		const exception = "frappe.exceptions.PermissionError: <details>Function is not whitelisted.</details>";
		const h = harness(() => Response.json({ exception }, { status: 403 }));
		await assert.rejects(
			attachFile("abc", undefined, h.env),
			(error: unknown) =>
				error instanceof FlowHttpError &&
				error.message === "Your session may have expired. Reload the page and try again.",
		);
	});

	it("rejects with an AbortError, and sends nothing, for a signal that is already aborted", async () => {
		const h = harness(ok({ file: "abc" }));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(attachFile("abc", controller.signal, h.env), isAbortError);
		assert.equal(h.fetches.length, 0);
	});

	it("hands the signal to fetch, whose abort rejects the call", async () => {
		const controller = new AbortController();
		const h = harness(
			(state) =>
				new Promise<Response>((_resolve, reject) => {
					state.fetches[0]?.init.signal?.addEventListener("abort", () => reject(controller.signal.reason));
				}),
		);
		const pending = attachFile("abc", controller.signal, h.env);
		await Promise.resolve();
		controller.abort();
		await assert.rejects(pending, isAbortError);
		assert.equal(h.fetches[0]?.init.signal, controller.signal);
	});
});

describe("deleteFile", () => {
	it("calls frappe.client.delete on the File doc", async () => {
		const h = harness();
		await deleteFile("49ec5dd196", h.env);
		assert.deepEqual(h.calls, [
			{ method: "frappe.client.delete", args: { doctype: "File", name: "49ec5dd196" } },
		]);
	});

	it("counts a 404 as deleted and rethrows anything else", async () => {
		const failing = (error: unknown): FlowEnv => ({
			...harness().env,
			call: async () => Promise.reject(error),
		});
		await deleteFile("gone", failing(new FlowHttpError("Not found", 404)));
		const forbidden = new FlowHttpError("No permission", 403);
		await assert.rejects(deleteFile("x", failing(forbidden)), forbidden);
		const network = new Error("offline");
		await assert.rejects(deleteFile("x", failing(network)), network);
	});
});

describe("createFlowClient", () => {
	it("binds uploadFile, attachFile and deleteFile to the envs it was given", async () => {
		const h = harness(
			() =>
				new Response(JSON.stringify({ message: { file: "f1", file_name: "a.txt", file_size: 1 } }), {
					status: 200,
				}),
		);
		const u = uploadHarness();
		u.reply = replyWith(200, { message: DOC });
		const client = createFlowClient(h.env, u.env);

		const uploaded = await client.uploadFile(new File(["a"], "a.txt"));
		assert.equal(uploaded.name, "49ec5dd196");
		assert.equal(u.posts.length, 1);

		assert.deepEqual(await client.attachFile("f1"), { file: "f1", fileName: "a.txt", fileSize: 1 });
		assert.equal(h.fetches[0]?.url, "/api/method/flow.api.attach_file");

		await client.deleteFile("f1");
		assert.deepEqual(h.calls.at(-1), {
			method: "frappe.client.delete",
			args: { doctype: "File", name: "f1" },
		});
	});

	it("builds the default upload env only when an upload happens", async () => {
		const client = createFlowClient(harness().env);
		// No XMLHttpRequest in Node: the failure belongs to the upload, not to constructing the client.
		await assert.rejects(client.uploadFile(new File(["a"], "a.txt")));
	});
});
