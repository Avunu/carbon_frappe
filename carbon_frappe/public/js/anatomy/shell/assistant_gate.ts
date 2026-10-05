// The decisions behind the header's AI action that need neither the DOM nor frappe,
// kept apart from assistant.ts so node:test can cover them.
//
// This file ships in the always-loaded carbon_anatomy bundle, which frappe builds with
// its own esbuild (0.14.x). Write nothing that esbuild cannot parse: no `satisfies`, no
// `accessor`, no `using`. The chat module is only named by type (erased), never imported.
import type { ChatModule } from "../../ai_chat/entry.ts";

/** The app whose `frappe.boot.versions` entry switches the feature on. */
export const FLOW_APP = "flow";

/** Where `scripts/build-ai-chat.ts` writes the lazy bundle (served from the app's public/dist). */
export const ASSET_BASE = "/assets/carbon_frappe/dist/ai_chat/";
export const MANIFEST_URL = `${ASSET_BASE}manifest.json`;

/** localStorage: the panel's open/expanded state (written by assistant.ts). */
export const PANEL_STATE_KEY = "cf-ai-panel";
/** localStorage: the Frappe user that SESSION_KEY's value (ai_chat/storage_keys.ts) belongs to (see `reconcileSession`). */
export const SESSION_USER_KEY = "cf-ai-session-user";
/** localStorage: flow's own panel state, `{open, fullscreen, width, session}` (apps/flow/frontend/src/lib/panelState.js). */
export const FLOW_PANEL_STATE_KEY = "flow-panel-state";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string | null | undefined): unknown {
	if (typeof raw !== "string" || raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

// -- gate ---------------------------------------------------------------------

export interface GateBoot {
	versions?: Record<string, string>;
	read_only?: boolean;
}

/** Flow is installed (and the site is not read-only, where flow could not write its sessions). */
export function shouldMountAssistant(boot: GateBoot | null | undefined): boolean {
	if (!boot || boot.read_only === true) return false;
	const version = boot.versions ? boot.versions[FLOW_APP] : undefined;
	return typeof version === "string" && version !== "";
}

// -- panel state --------------------------------------------------------------

export interface PanelState {
	open: boolean;
	expanded: boolean;
}

export const DEFAULT_PANEL_STATE: PanelState = { open: false, expanded: false };

/** The stored state, or the default for anything missing, malformed or of another version. */
export function parsePanelState(raw: string | null | undefined): PanelState {
	const parsed = parseJson(raw);
	if (!isRecord(parsed) || parsed["v"] !== 1) return { ...DEFAULT_PANEL_STATE };
	return { open: parsed["open"] === true, expanded: parsed["expanded"] === true };
}

export function serialisePanelState(state: PanelState): string {
	return JSON.stringify({ v: 1, open: state.open, expanded: state.expanded });
}

// -- flow's state -------------------------------------------------------------

/**
 * The value to write to SESSION_KEY on first use, or null to leave the key alone.
 *
 * `own` is what SESSION_KEY holds now: null only before the chat has ever run (the
 * controller writes "" for a deliberate new chat, so a cleared session is never
 * resurrected from flow). The seed is flow's remembered session, or "" when it had none.
 */
export function seedSession(own: string | null, flowStateRaw: string | null): string | null {
	if (own !== null) return null;
	const flow = parseJson(flowStateRaw);
	const session = isRecord(flow) ? flow["session"] : undefined;
	return typeof session === "string" ? session : "";
}

/**
 * The value to write to SESSION_KEY at boot, or null to leave the key alone.
 *
 * localStorage belongs to the browser, not to the account, and frappe's logout leaves it
 * alone: without this the next person to sign in would have the previous one's session
 * resumed (and, with enough read access, rendered, with its running runs failed).
 * `owner` is the user SESSION_USER_KEY recorded; a different user starts a new chat, and
 * a pointer of unknown owner (written before the owner was recorded) is dropped for the
 * same reason. Flow's own remembered session is not trusted across users either.
 */
export function reconcileSession(
	user: string,
	owner: string | null,
	own: string | null,
	flowStateRaw: string | null,
): string | null {
	if (owner === user || (owner === null && own === null)) return seedSession(own, flowStateRaw);
	return own === "" ? null : "";
}

/**
 * Flow's stored panel state with `open` forced false and everything else (session,
 * width, fullscreen) kept, or null when there is nothing parseable to rewrite.
 * `FlowPanel.hide()` persists `session: store.sessionName.value`, which is still null
 * if it runs before flow's own async restore: rewriting from a snapshot read BEFORE
 * the hide keeps the session for the seed and for handing the panel back.
 */
export function closedFlowState(flowStateRaw: string | null): string | null {
	const flow = parseJson(flowStateRaw);
	if (!isRecord(flow)) return null;
	return JSON.stringify({ ...flow, open: false });
}

// -- flow's panel -------------------------------------------------------------

/** The slice of apps/flow's `frappe.flow.panel` (FlowPanel, frontend/src/main.js) the takeover calls. */
export interface FlowPanelLike {
	show(): void;
	hide(): void;
	toggle(): void;
	/** FlowPanel.visible: true while its slide-over is open. */
	visible: boolean;
}

export function isFlowPanel(value: unknown): value is FlowPanelLike {
	return (
		isRecord(value) &&
		typeof value["show"] === "function" &&
		typeof value["hide"] === "function" &&
		typeof value["toggle"] === "function" &&
		typeof value["visible"] === "boolean"
	);
}

// -- lazy bundle --------------------------------------------------------------

export interface ChatManifest {
	/** Entry module, relative to ASSET_BASE: `entry.<hash>.js`. */
	entry: string;
	/** Stylesheet, relative to ASSET_BASE: `chat.<hash>.css`. */
	css: string;
	/** ISO timestamp of the build; informational. */
	built: string;
}

// A file name inside the bundle directory: letters, digits, dot, dash, underscore and
// forward slash, no leading slash, no "..". The manifest is fetched from our own origin
// but is still data, and its values become a <link href> and an import() specifier.
const SAFE_ASSET = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.\-/]*$/;

export function parseManifest(value: unknown): ChatManifest | null {
	if (!isRecord(value)) return null;
	const entry = value["entry"];
	const css = value["css"];
	const built = value["built"];
	if (typeof entry !== "string" || !SAFE_ASSET.test(entry) || !entry.endsWith(".js")) return null;
	if (typeof css !== "string" || !SAFE_ASSET.test(css) || !css.endsWith(".css")) return null;
	return { entry, css, built: typeof built === "string" ? built : "" };
}

export function assetUrl(file: string): string {
	return `${ASSET_BASE}${file}`;
}

/**
 * The `import()` specifier for the entry module. A failed dynamic import stays in the
 * document's module map, so the same URL rejects again without a request; a changed
 * query is a new module, which makes Retry work after a failed entry fetch. A failed
 * chunk it imports is cached under its own URL and only a page reload clears that.
 */
export function entrySpecifier(entry: string, failures: number): string {
	return failures > 0 ? `${assetUrl(entry)}?retry=${failures}` : assetUrl(entry);
}

/** The contract version `entry.ts` exports as `CHAT_CONTRACT`; bump both together on a breaking change. */
export const CHAT_CONTRACT_VERSION = 1;

/** A dynamic-import result that is the chat entry of this contract version (not a stale or foreign module). */
export function isChatModule(value: unknown): value is ChatModule {
	return (
		typeof value === "object" &&
		value !== null &&
		"mountChat" in value &&
		typeof value.mountChat === "function" &&
		"CHAT_CONTRACT" in value &&
		value.CHAT_CONTRACT === CHAT_CONTRACT_VERSION
	);
}
