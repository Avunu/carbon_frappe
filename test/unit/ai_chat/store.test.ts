import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createChatStore } from "../../../carbon_frappe/public/js/ai_chat/store.ts";
import type {
	ChatError,
	ChatState,
	Message,
	MessageRequest,
	MessageResponse,
	MessageState,
	PendingUpload,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";
import { isResponse } from "../../../carbon_frappe/public/js/ai_chat/types.ts";

function request(id: string, text = id): MessageRequest {
	return { id, input: { message_type: "text", text } };
}

function response(id: string, text = id): MessageResponse {
	return { id, output: { generic: [{ response_type: "text", text }] } };
}

function ids(messages: readonly Message[]): (string | undefined)[] {
	return messages.map((message) => message.id);
}

function counter(): { calls: number; fn: () => void } {
	const c = {
		calls: 0,
		fn: () => {
			c.calls += 1;
		},
	};
	return c;
}

function pending(id: string, overrides: Partial<PendingUpload> = {}): PendingUpload {
	return { id, file: new File(["x"], `${id}.txt`), status: "uploading", progress: 0, ...overrides };
}

const COMM_ERROR: ChatError = { errorType: "MESSAGE_COMMUNICATION", message: "boom", messageID: "r1" };

afterEach(() => {
	mock.restoreAll();
});

describe("initial state", () => {
	it("starts empty and loading", () => {
		assert.deepEqual(createChatStore().get(), {
			messages: [],
			status: "loading",
			error: null,
			activeResponseId: null,
			session: null,
			pendingUploads: [],
			hasInFlightUploads: false,
		});
	});

	it("overlays the initial partial state", () => {
		const first = request("a");
		const store = createChatStore({ status: "ready", session: "S1", messages: [first] });
		assert.equal(store.get().status, "ready");
		assert.equal(store.get().session, "S1");
		assert.equal(store.get().messages[0], first);
		assert.equal(store.get().activeResponseId, null);
		assert.equal(store.getMessageState("a"), "complete");
	});
});

describe("get() identity", () => {
	it("is stable with no change", () => {
		const store = createChatStore();
		assert.equal(store.get(), store.get());
	});

	it("is stable across no-op mutations", () => {
		const first = request("a");
		const store = createChatStore({ status: "ready", messages: [first], session: "S" });
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);

		store.setStatus("ready");
		store.setSession("S");
		store.remove(["nope"]);
		store.upsert("a", "complete", first);
		store.upsert("a", "complete", () => first);
		store.replace([first]);

		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("changes identity on a real change but keeps untouched field references", () => {
		const first = request("a");
		const store = createChatStore({ status: "ready", messages: [first] });
		const before = store.get();
		store.setSession("S");
		const after = store.get();
		assert.notEqual(after, before);
		assert.equal(after.messages, before.messages);
		assert.equal(after.error, before.error);
		assert.equal(after.session, "S");
		assert.equal(before.session, null, "the previous snapshot is not mutated");
	});

	it("keeps the messages array reference when only status changes", () => {
		const store = createChatStore({ messages: [request("a")] });
		const messages = store.get().messages;
		store.setStatus("ready");
		assert.equal(store.get().messages, messages);
	});
});

describe("subscribe", () => {
	it("is not called on subscribe and is called once per real change with no arguments", () => {
		const store = createChatStore();
		const args: unknown[][] = [];
		store.subscribe((...received: unknown[]) => {
			args.push(received);
		});
		assert.equal(args.length, 0);
		store.setStatus("ready");
		store.setSession("S");
		assert.deepEqual(args, [[], []]);
	});

	it("stops after unsubscribe, which is idempotent", () => {
		const store = createChatStore();
		const a = counter();
		const b = counter();
		const unsubscribeA = store.subscribe(a.fn);
		store.subscribe(b.fn);
		store.setStatus("ready");
		unsubscribeA();
		unsubscribeA();
		store.setSession("S");
		assert.equal(a.calls, 1);
		assert.equal(b.calls, 2);
	});

	it("treats the same function subscribed twice as two subscriptions", () => {
		const store = createChatStore();
		const seen = counter();
		const first = store.subscribe(seen.fn);
		store.subscribe(seen.fn);
		store.setStatus("ready");
		assert.equal(seen.calls, 2);
		first();
		store.setSession("S");
		assert.equal(seen.calls, 3);
	});

	it("calls listeners in subscription order, after the state is updated", () => {
		const store = createChatStore();
		const order: string[] = [];
		store.subscribe(() => order.push(`a:${store.get().status}`));
		store.subscribe(() => order.push(`b:${store.get().status}`));
		store.setStatus("submitted");
		assert.deepEqual(order, ["a:submitted", "b:submitted"]);
	});

	it("does not call a listener added during delivery in that same pass", () => {
		const store = createChatStore();
		const late = counter();
		let added = false;
		store.subscribe(() => {
			if (added) return;
			added = true;
			store.subscribe(late.fn);
		});
		store.setStatus("ready");
		assert.equal(late.calls, 0);
		store.setSession("S");
		assert.equal(late.calls, 1);
	});

	it("a message-state-only change notifies nobody", () => {
		const first = response("r1");
		const store = createChatStore({ status: "ready", messages: [first] });
		const seen = counter();
		store.subscribe(seen.fn);
		store.upsert("r1", "error", first);
		assert.equal(store.getMessageState("r1"), "error");
		assert.equal(seen.calls, 0);
	});
});

describe("select", () => {
	it("does not announce the baseline and fires only when the selection changes", () => {
		const store = createChatStore();
		const values: string[] = [];
		store.select(
			(state) => state.status,
			(value) => values.push(value),
		);
		assert.deepEqual(values, []);
		store.setSession("S");
		assert.deepEqual(values, [], "unrelated change");
		store.setStatus("ready");
		store.setStatus("ready");
		store.setStatus("submitted");
		assert.deepEqual(values, ["ready", "submitted"]);
	});

	it("compares with Object.is by default, so a fresh object each time always fires", () => {
		const store = createChatStore();
		const seen = counter();
		store.select((state) => ({ status: state.status }), seen.fn);
		store.setSession("S");
		store.setSession("T");
		assert.equal(seen.calls, 2);
	});

	it("honors a custom isEqual", () => {
		const store = createChatStore();
		const seen: { status: string }[] = [];
		store.select(
			(state) => ({ status: state.status }),
			(value) => seen.push(value),
			{ isEqual: (a, b) => a.status === b.status },
		);
		store.setSession("S");
		assert.deepEqual(seen, []);
		store.setStatus("ready");
		assert.deepEqual(seen, [{ status: "ready" }]);
		store.setSession("T");
		assert.equal(seen.length, 1);
	});

	it("compares against the last announced value, not the last state", () => {
		const store = createChatStore();
		const seen: number[] = [];
		store.select(
			(state) => state.messages.length,
			(value) => seen.push(value),
		);
		store.upsert("a", "complete", request("a"));
		store.upsert("a", "complete", request("a", "edited"));
		store.upsert("b", "complete", request("b"));
		store.remove(["a", "b"]);
		assert.deepEqual(seen, [1, 2, 0]);
	});

	it("stops after unsubscribe", () => {
		const store = createChatStore();
		const seen = counter();
		const stop = store.select((state) => state.status, seen.fn);
		store.setStatus("ready");
		stop();
		stop();
		store.setStatus("submitted");
		assert.equal(seen.calls, 1);
	});

	it("reports a throwing selector and keeps serving other listeners", () => {
		const error = mock.method(console, "error", () => {});
		const store = createChatStore();
		const boom = new Error("selector");
		const seen = counter();
		store.select(
			(state) => {
				if (state.status === "ready") throw boom;
				return state.status;
			},
			() => {},
		);
		store.subscribe(seen.fn);
		store.setStatus("ready");
		assert.equal(error.mock.callCount(), 1);
		assert.equal(error.mock.calls[0]?.arguments[0], boom);
		assert.equal(seen.calls, 1);
		assert.equal(store.get().status, "ready");
	});

	it("lets a throwing selector at subscribe time propagate and registers nothing", () => {
		const store = createChatStore();
		assert.throws(
			() =>
				store.select(
					() => {
						throw new Error("baseline");
					},
					() => {},
				),
			/baseline/,
		);
		store.setStatus("ready");
	});
});

describe("upsert", () => {
	it("takes (id, state, updater), the order of the SDK's messaging.upsertMessage", () => {
		const store = createChatStore({ status: "ready" });
		// The first two parameters must stay assignable to the SDK's (messageID, state, ...).
		const leading: (id: string, state: MessageState) => void = (id, state) =>
			store.upsert(id, state, response(id, "x"));
		leading("r1", "streaming");
		assert.equal(store.getMessageState("r1"), "streaming");
		assert.equal(store.get().activeResponseId, "r1");
		assert.deepEqual(ids(store.get().messages), ["r1"]);
	});

	it("appends a new id and replaces an existing one in place", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r1", "streaming", response("r1", "partial"));
		store.upsert("q2", "complete", request("q2"));
		const edited = response("r1", "partial and more");
		store.upsert("r1", "complete", edited);
		assert.deepEqual(ids(store.get().messages), ["q1", "r1", "q2"]);
		assert.equal(store.get().messages[1], edited);
	});

	it("keeps untouched messages by identity (structural sharing)", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r1", "streaming", response("r1"));
		const [q1, r1] = store.get().messages;
		const before = store.get().messages;
		store.upsert("r1", "streaming", response("r1", "more"));
		assert.notEqual(store.get().messages, before);
		assert.equal(store.get().messages[0], q1);
		assert.notEqual(store.get().messages[1], r1);
		assert.equal(before[1], r1, "the old array is untouched");
	});

	it("passes undefined then the previous message to a function updater", () => {
		const store = createChatStore({ status: "ready" });
		const seen: (Message | undefined)[] = [];
		store.upsert("r1", "streaming", (previous) => {
			seen.push(previous);
			return response("r1", "one");
		});
		const stored = store.get().messages[0];
		store.upsert("r1", "streaming", (previous) => {
			seen.push(previous);
			return response("r1", "two");
		});
		assert.equal(seen[0], undefined);
		assert.equal(seen[1], stored);
	});

	it("builds the next draft from the previous one", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "streaming", response("r1", "a"));
		store.upsert("r1", "complete", (previous) => {
			assert.ok(isResponse(previous));
			return {
				...previous,
				output: { generic: [...previous.output.generic, { response_type: "text", text: "b" }] },
			};
		});
		const stored = store.get().messages[0];
		assert.ok(isResponse(stored));
		assert.deepEqual(
			stored.output.generic.map((item) => (item.response_type === "text" ? item.text : null)),
			["a", "b"],
		);
	});

	it("forces the id when the value carries another one, or none", () => {
		const store = createChatStore();
		store.upsert("r1", "complete", response("other"));
		store.upsert("r2", "complete", { output: { generic: [] } });
		assert.deepEqual(ids(store.get().messages), ["r1", "r2"]);
		assert.equal(store.getMessageState("r1"), "complete");
		assert.equal(store.getMessageState("other"), undefined);
		// A forced id still replaces in place on the next upsert.
		store.upsert("r1", "complete", response("other", "again"));
		assert.equal(store.get().messages.length, 2);
	});

	it("is a no-op for messages when the identical previous object comes back", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "complete", response("r1"));
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		store.upsert("r1", "complete", (previous) => previous ?? response("r1"));
		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("leaves the state intact when the updater throws", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "streaming", response("r1"));
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		assert.throws(
			() =>
				store.upsert("r1", "complete", () => {
					throw new Error("bad updater");
				}),
			/bad updater/,
		);
		assert.equal(store.get(), before);
		assert.equal(store.getMessageState("r1"), "streaming");
		assert.equal(seen.calls, 0);
	});

	it("drives activeResponseId from the message state", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "streaming", response("r1"));
		assert.equal(store.get().activeResponseId, "r1");
		store.upsert("r1", "streaming", response("r1", "more"));
		assert.equal(store.get().activeResponseId, "r1");
		store.upsert("r1", "complete", response("r1", "done"));
		assert.equal(store.get().activeResponseId, null);

		store.upsert("r2", "streaming", response("r2"));
		store.upsert("r2", "error", response("r2", "oops"));
		assert.equal(store.get().activeResponseId, null);
		assert.equal(store.getMessageState("r2"), "error");
	});

	it("leaves activeResponseId alone when a different id completes", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "streaming", response("r1"));
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r0", "error", response("r0"));
		assert.equal(store.get().activeResponseId, "r1");
	});

	it("moves activeResponseId to the newest streaming id", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("r1", "streaming", response("r1"));
		store.upsert("r2", "streaming", response("r2"));
		assert.equal(store.get().activeResponseId, "r2");
	});

	it("records message states and returns undefined for unknown ids", () => {
		const store = createChatStore({ status: "ready" });
		assert.equal(store.getMessageState("r1"), undefined);
		store.upsert("r1", "streaming", response("r1"));
		assert.equal(store.getMessageState("r1"), "streaming");
		store.upsert("r1", "complete", response("r1", "x"));
		assert.equal(store.getMessageState("r1"), "complete");
	});
});

describe("remove", () => {
	it("removes matching messages and their states, preserving the rest by identity", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r1", "complete", response("r1"));
		store.upsert("q2", "complete", request("q2"));
		const q2 = store.get().messages[2];
		store.remove(["q1", "r1", "missing"]);
		assert.deepEqual(ids(store.get().messages), ["q2"]);
		assert.equal(store.get().messages[0], q2);
		assert.equal(store.getMessageState("q1"), undefined);
		assert.equal(store.getMessageState("r1"), undefined);
		assert.equal(store.getMessageState("q2"), "complete");
	});

	it("clears activeResponseId only when the active message is removed", () => {
		const store = createChatStore({ status: "ready" });
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r1", "streaming", response("r1"));
		store.remove(["q1"]);
		assert.equal(store.get().activeResponseId, "r1");
		store.remove(["r1"]);
		assert.equal(store.get().activeResponseId, null);
	});

	it("does nothing for an empty list or unknown ids", () => {
		const store = createChatStore({ messages: [request("a")] });
		const before = store.get();
		store.remove([]);
		store.remove(["zzz"]);
		assert.equal(store.get(), before);
	});
});

describe("replace", () => {
	it("assigns message-<index> ids to id-less messages, preserving the others", () => {
		const store = createChatStore({ status: "ready" });
		const withId = request("keep");
		store.replace([{ input: { text: "hi" } }, withId, { output: { generic: [] } }]);
		assert.deepEqual(ids(store.get().messages), ["message-0", "keep", "message-2"]);
		assert.equal(store.get().messages[1], withId);
	});

	it("does not mutate its input", () => {
		const store = createChatStore();
		const bare: Message = { input: { text: "hi" } };
		store.replace([bare]);
		assert.equal(bare.id, undefined);
	});

	it("marks every message complete, drops stale states and clears the active id", () => {
		const store = createChatStore({ status: "streaming" });
		store.upsert("old", "streaming", response("old"));
		store.replace([request("q1"), response("r1")]);
		assert.equal(store.getMessageState("q1"), "complete");
		assert.equal(store.getMessageState("r1"), "complete");
		assert.equal(store.getMessageState("old"), undefined);
		assert.equal(store.get().activeResponseId, null);
		assert.deepEqual(ids(store.get().messages), ["q1", "r1"]);
	});

	it("leaves status, error and session untouched", () => {
		const store = createChatStore();
		store.setSession("S");
		store.setStatus("error", COMM_ERROR);
		store.replace([request("q1")]);
		assert.equal(store.get().status, "error");
		assert.equal(store.get().error, COMM_ERROR);
		assert.equal(store.get().session, "S");
	});

	it("notifies once, and keeps the array when every message is the same object", () => {
		const first = request("q1");
		const store = createChatStore({ messages: [first] });
		const seen = counter();
		store.subscribe(seen.fn);
		store.replace([first]);
		assert.equal(seen.calls, 0);
		store.replace([first, response("r1")]);
		assert.equal(seen.calls, 1);
	});

	it("notifies when the only change is the cleared active id", () => {
		const first = response("r1");
		const store = createChatStore({ status: "streaming" });
		store.upsert("r1", "streaming", first);
		const seen = counter();
		store.subscribe(seen.fn);
		store.replace([first]);
		assert.equal(store.get().activeResponseId, null);
		assert.equal(seen.calls, 1);
	});
});

describe("setStatus", () => {
	it("keeps the error for 'error' and clears it for any other status", () => {
		const store = createChatStore();
		store.setStatus("error", COMM_ERROR);
		assert.equal(store.get().error, COMM_ERROR);
		store.setStatus("error");
		assert.equal(store.get().error, null, "error ?? null when none is supplied");
		store.setStatus("error", COMM_ERROR);
		store.setStatus("submitted", COMM_ERROR);
		assert.equal(store.get().error, null, "an error passed with a non-error status is ignored");
		assert.equal(store.get().status, "submitted");
	});

	it("clears activeResponseId on ready, error and loading, not on submitted or streaming", () => {
		const store = createChatStore({ status: "ready" });
		for (const [status, cleared] of [
			["submitted", false],
			["streaming", false],
			["ready", true],
			["error", true],
			["loading", true],
		] as const) {
			store.upsert("r1", "streaming", response("r1"));
			store.setStatus(status);
			assert.equal(store.get().activeResponseId, cleared ? null : "r1", status);
		}
	});

	it("does not validate transitions", () => {
		const store = createChatStore();
		store.setStatus("streaming");
		store.setStatus("loading");
		assert.equal(store.get().status, "loading");
	});

	it("a new error object under 'error' is a real change", () => {
		const store = createChatStore();
		store.setStatus("error", COMM_ERROR);
		const seen = counter();
		store.subscribe(seen.fn);
		store.setStatus("error", COMM_ERROR);
		assert.equal(seen.calls, 0);
		store.setStatus("error", { ...COMM_ERROR });
		assert.equal(seen.calls, 1);
	});
});

describe("setSession", () => {
	it("sets and clears the session", () => {
		const store = createChatStore();
		store.setSession("S1");
		assert.equal(store.get().session, "S1");
		store.setSession(null);
		assert.equal(store.get().session, null);
	});
});

describe("reset", () => {
	function busyStore() {
		const store = createChatStore({ status: "ready" });
		store.setSession("S");
		store.upsert("q1", "complete", request("q1"));
		store.upsert("r1", "streaming", response("r1"));
		store.setStatus("error", COMM_ERROR);
		return store;
	}

	it("starts a new ready conversation and clears message states", () => {
		const store = busyStore();
		const seen = counter();
		store.subscribe(seen.fn);
		store.reset();
		assert.deepEqual(store.get(), {
			messages: [],
			status: "ready",
			error: null,
			activeResponseId: null,
			session: null,
			pendingUploads: [],
			hasInFlightUploads: false,
		});
		assert.equal(store.getMessageState("q1"), undefined);
		assert.equal(store.getMessageState("r1"), undefined);
		assert.equal(seen.calls, 1, "exactly one notification");
	});

	it("overlays the initial partial state", () => {
		const store = busyStore();
		const first = request("seed");
		store.reset({ session: "S2", status: "loading", messages: [first] });
		assert.equal(store.get().session, "S2");
		assert.equal(store.get().status, "loading");
		assert.equal(store.get().messages[0], first);
		assert.equal(store.getMessageState("seed"), "complete");
		assert.equal(store.getMessageState("q1"), undefined);
	});

	it("is a no-op on a fresh ready store", () => {
		const store = createChatStore({ status: "ready" });
		const before = store.get();
		store.reset();
		assert.equal(store.get(), before);
	});
});

describe("delivery", () => {
	it("reports a throwing listener with console.error and still runs the rest", () => {
		const error = mock.method(console, "error", () => {});
		const store = createChatStore();
		const boom = new Error("listener");
		const after = counter();
		store.subscribe(() => {
			throw boom;
		});
		store.subscribe(after.fn);
		store.setStatus("ready");
		assert.equal(error.mock.callCount(), 1);
		assert.equal(error.mock.calls[0]?.arguments[0], boom);
		assert.equal(after.calls, 1);
		assert.equal(store.get().status, "ready", "state is unaffected by the throw");
	});

	it("reports a throwing select listener", () => {
		const error = mock.method(console, "error", () => {});
		const store = createChatStore();
		const boom = new Error("select listener");
		const after = counter();
		store.select(
			(state) => state.status,
			() => {
				throw boom;
			},
		);
		store.subscribe(after.fn);
		store.setStatus("ready");
		assert.equal(error.mock.callCount(), 1);
		assert.equal(error.mock.calls[0]?.arguments[0], boom);
		assert.equal(after.calls, 1);
	});

	it("skips a later listener that an earlier one unsubscribed during the pass", () => {
		const store = createChatStore();
		const later = counter();
		let stopLater: () => void = () => {};
		store.subscribe(() => stopLater());
		stopLater = store.subscribe(later.fn);
		store.setStatus("ready");
		assert.equal(later.calls, 0);
		store.setSession("S");
		assert.equal(later.calls, 0);
	});

	it("lets a listener unsubscribe itself mid-pass without disturbing the others", () => {
		const store = createChatStore();
		const log: string[] = [];
		const stopA = store.subscribe(() => {
			log.push("a");
			stopA();
		});
		store.subscribe(() => log.push("b"));
		store.setStatus("ready");
		store.setSession("S");
		assert.deepEqual(log, ["a", "b", "b"]);
	});

	it("applies a listener's mutation at once and runs exactly one extra pass", () => {
		const store = createChatStore();
		const seenByA: string[] = [];
		const seenByB: string[] = [];
		let mutated = false;
		store.subscribe(() => {
			seenByA.push(store.get().status);
			if (!mutated) {
				mutated = true;
				store.setStatus("submitted");
				assert.equal(store.get().status, "submitted", "applied synchronously, not deferred");
			}
		});
		store.subscribe(() => seenByB.push(store.get().status));
		store.setStatus("ready");
		// Pass 1: A (sees ready, mutates), B (already reads the latest). Pass 2: both again.
		assert.deepEqual(seenByA, ["ready", "submitted"]);
		assert.deepEqual(seenByB, ["submitted", "submitted"]);
	});

	it("a select listener behind the mutator only sees the final value", () => {
		const store = createChatStore();
		let mutated = false;
		store.subscribe(() => {
			if (mutated) return;
			mutated = true;
			store.setStatus("streaming");
		});
		const values: string[] = [];
		store.select(
			(state) => state.status,
			(value) => values.push(value),
		);
		store.setStatus("ready");
		assert.deepEqual(values, ["streaming"]);
	});

	it("a select listener ahead of the mutator sees both values, in order", () => {
		const store = createChatStore();
		const values: string[] = [];
		store.select(
			(state) => state.status,
			(value) => values.push(value),
		);
		let mutated = false;
		store.subscribe(() => {
			if (mutated) return;
			mutated = true;
			store.setStatus("streaming");
		});
		store.setStatus("ready");
		assert.deepEqual(values, ["ready", "streaming"]);
	});

	it("a mutation that changes nothing during delivery causes no extra pass", () => {
		const store = createChatStore();
		const log: string[] = [];
		store.subscribe(() => {
			log.push("a");
			store.setStatus("ready");
		});
		store.setStatus("ready");
		assert.deepEqual(log, ["a"]);
	});

	it("gives up on listeners that mutate forever instead of hanging", () => {
		const error = mock.method(console, "error", () => {});
		const store = createChatStore();
		let calls = 0;
		store.subscribe(() => {
			calls += 1;
			store.setSession(`S${calls}`);
		});
		store.setStatus("ready");
		assert.equal(error.mock.callCount(), 1);
		assert.equal(calls, 100);
		// Delivery recovers afterwards.
		const seen = counter();
		store.subscribe(seen.fn);
		store.setStatus("submitted");
		assert.equal(seen.calls >= 1, true);
	});
});

describe("pending uploads", () => {
	it("addPendingUpload appends in order and sets hasInFlightUploads", () => {
		const store = createChatStore({ status: "ready" });
		const a = pending("a");
		const b = pending("b", { status: "complete" });
		store.addPendingUpload(a);
		store.addPendingUpload(b);
		assert.deepEqual(store.get().pendingUploads, [a, b]);
		assert.equal(store.get().pendingUploads[0], a);
		assert.equal(store.get().hasInFlightUploads, true);
	});

	it("addPendingUpload leaves an id that is already there alone and notifies nobody", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		store.addPendingUpload(pending("a", { status: "complete" }));
		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("updatePendingUpload replaces one entry and keeps the others' references", () => {
		const store = createChatStore({ status: "ready" });
		const a = pending("a");
		const b = pending("b");
		store.addPendingUpload(a);
		store.addPendingUpload(b);
		const messages = store.get().messages;
		store.updatePendingUpload("a", (previous) => ({ ...previous, progress: 0.5 }));
		assert.equal(store.get().pendingUploads[0]?.progress, 0.5);
		assert.equal(store.get().pendingUploads[1], b);
		assert.equal(store.get().messages, messages);
	});

	it("updatePendingUpload gives the updater the current entry", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		const seen: PendingUpload[] = [];
		store.updatePendingUpload("a", (previous) => {
			seen.push(previous);
			return { ...previous, progress: 0.2 };
		});
		store.updatePendingUpload("a", (previous) => {
			seen.push(previous);
			return previous;
		});
		assert.equal(seen[1]?.progress, 0.2);
	});

	it("updatePendingUpload of an unknown id, or returning the same entry, changes and notifies nothing", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		let called = 0;
		store.updatePendingUpload("nope", (previous) => {
			called += 1;
			return { ...previous, progress: 1 };
		});
		store.updatePendingUpload("a", (previous) => previous);
		assert.equal(called, 0, "the updater is not even asked for an unknown id");
		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("derives hasInFlightUploads through every transition", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		store.addPendingUpload(pending("b"));
		assert.equal(store.get().hasInFlightUploads, true);
		store.updatePendingUpload("a", (previous) => ({ ...previous, status: "complete" }));
		assert.equal(store.get().hasInFlightUploads, true, "b is still uploading");
		store.updatePendingUpload("b", (previous) => ({ ...previous, status: "error", errorMessage: "no" }));
		assert.equal(store.get().hasInFlightUploads, false);
		store.updatePendingUpload("b", (previous) => ({ ...previous, status: "uploading" }));
		assert.equal(store.get().hasInFlightUploads, true);
		store.removePendingUpload("b");
		assert.equal(store.get().hasInFlightUploads, false);
	});

	it("removePendingUpload drops one entry; an unknown id does nothing", () => {
		const store = createChatStore({ status: "ready" });
		const a = pending("a");
		const b = pending("b");
		store.addPendingUpload(a);
		store.addPendingUpload(b);
		store.removePendingUpload("a");
		assert.deepEqual(store.get().pendingUploads, [b]);
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		store.removePendingUpload("a");
		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("clearPendingUploads empties the list, and is a no-op when it is already empty", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		store.addPendingUpload(pending("b", { status: "complete" }));
		store.clearPendingUploads();
		assert.deepEqual(store.get().pendingUploads, []);
		assert.equal(store.get().hasInFlightUploads, false);
		const before = store.get();
		const seen = counter();
		store.subscribe(seen.fn);
		store.clearPendingUploads();
		assert.equal(store.get(), before);
		assert.equal(seen.calls, 0);
	});

	it("notifies a pendingUploads selector only when the list changes", () => {
		const store = createChatStore({ status: "ready" });
		const lists: (readonly PendingUpload[])[] = [];
		store.select(
			(state) => state.pendingUploads,
			(list) => void lists.push(list),
		);
		store.setStatus("submitted");
		store.upsert("q", "complete", request("q"));
		assert.equal(lists.length, 0);
		store.addPendingUpload(pending("a"));
		store.updatePendingUpload("a", (previous) => ({ ...previous, progress: 0.5 }));
		assert.equal(lists.length, 2);
	});

	it("derives hasInFlightUploads from an initial list, ignoring a caller's flag", () => {
		const store = createChatStore({
			pendingUploads: [pending("a"), pending("b", { status: "complete" })],
			hasInFlightUploads: false,
		});
		assert.equal(store.get().hasInFlightUploads, true);
		const idle = createChatStore({
			pendingUploads: [pending("a", { status: "complete" })],
			hasInFlightUploads: true,
		});
		assert.equal(idle.get().hasInFlightUploads, false);
	});

	it("reset clears pendingUploads and the flag", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		store.reset();
		assert.deepEqual(store.get().pendingUploads, []);
		assert.equal(store.get().hasInFlightUploads, false);
	});

	it("reset can seed pending uploads, and derives the flag for them", () => {
		const store = createChatStore({ status: "ready" });
		store.reset({ pendingUploads: [pending("a")], hasInFlightUploads: false });
		assert.equal(store.get().pendingUploads.length, 1);
		assert.equal(store.get().hasInFlightUploads, true);
	});

	it("reset of an idle store keeps the empty list's identity and notifies nobody", () => {
		const store = createChatStore({ status: "ready" });
		const before = store.get();
		const list = before.pendingUploads;
		const seen = counter();
		store.subscribe(seen.fn);
		store.reset();
		assert.equal(store.get(), before);
		assert.equal(store.get().pendingUploads, list);
		assert.equal(seen.calls, 0);
	});

	it("a message change leaves the pending list's reference alone", () => {
		const store = createChatStore({ status: "ready" });
		store.addPendingUpload(pending("a"));
		const list = store.get().pendingUploads;
		store.upsert("q", "complete", request("q"));
		store.setStatus("submitted");
		assert.equal(store.get().pendingUploads, list);
	});
});

describe("state snapshot type", () => {
	it("exposes the seven ChatState fields only", () => {
		const state: ChatState = createChatStore().get();
		assert.deepEqual(Object.keys(state).sort(), [
			"activeResponseId",
			"error",
			"hasInFlightUploads",
			"messages",
			"pendingUploads",
			"session",
			"status",
		]);
	});
});
