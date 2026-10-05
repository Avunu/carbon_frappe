// Screen-reader announcements for the chat, through the same live-region rotation
// @carbon/ai-chat uses (aria-announcer-manager.ts): one write per 250 ms tick, rotated
// across three polite regions (more than one, or NVDA and JAWS drop back-to-back
// identical messages) plus two assertive ones for errors.
//
// The message list is deliberately NOT a live region: a streaming reply would be read
// delta by delta. Announcements are made on store transitions only (a finished response, a
// pending approval, a new chat), never per streamed delta.
//
// The pinned @carbon/ai-chat-components 1.11.0 exports only the manager class; the
// `mountAriaAnnouncer` helper that creates the regions is in 1.12.0-rc.1. The regions
// are created here, exactly as that helper does, so the bump needs no change but a
// deletion of `createRegion`.
import { AriaAnnouncerManager } from "@carbon/ai-chat-components/es/globals/utils/aria-announcer-manager.js";

export type Politeness = "polite" | "assertive";

export interface Announcer {
	announce(message: string, politeness?: Politeness): void;
	/** Cancels pending writes and removes the regions from the container. */
	dispose(): void;
}

export const POLITE_REGIONS = 3;
export const ASSERTIVE_REGIONS = 2;

function createRegion(container: HTMLElement, politeness: Politeness): HTMLDivElement {
	const region = document.createElement("div");
	region.setAttribute("aria-live", politeness);
	container.appendChild(region);
	return region;
}

/**
 * Create the live regions inside `container`. The container must be in the document
 * and exposed to assistive technology (not `hidden`, `inert` or `display: none`),
 * and visually hidden by the caller's CSS (`.cf-ai-visually-hidden`).
 */
export function createAnnouncer(container: HTMLElement): Announcer {
	const polite = Array.from({ length: POLITE_REGIONS }, () => createRegion(container, "polite"));
	const assertive = Array.from({ length: ASSERTIVE_REGIONS }, () => createRegion(container, "assertive"));
	const manager = new AriaAnnouncerManager();
	manager.connect(polite, assertive);
	return {
		announce: (message, politeness = "polite") => manager.announce(message, politeness),
		dispose: () => {
			manager.disconnect();
			for (const region of [...polite, ...assertive]) region.remove();
		},
	};
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
// a table's header rule or a thematic break: nothing but dashes, colons, pipes and spaces
const RULE_LINE = /^[\s|:-]*-[\s|:-]*$/;
// How much source is read per character wanted. The inline patterns backtrack quadratically on
// a long line of unmatched openers, and only the first `maxLength` characters are ever spoken.
const SOURCE_FACTOR = 8;

/** One line outside a fence, with its block syntax removed. Returns null for a line that only held syntax. */
function plainLine(line: string): string | null {
	if (RULE_LINE.test(line)) return null;
	let out = line.replace(/^\s{0,3}(#{1,6}\s+|(>\s?)+|[-*+]\s+|\d{1,9}[.)]\s+)/, "");
	if (/^\s*\|.*\|\s*$/.test(out)) {
		// a table row: cells become a comma list, the way a reader would say it
		out = out
			.trim()
			.slice(1, -1)
			.split("|")
			.map((cell) => cell.trim())
			.filter((cell) => cell !== "")
			.join(", ");
	}
	return out
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
		.replace(/<\/?[a-zA-Z][^>]*>/g, "")
		.replace(/`+([^`]*)`+/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

/**
 * A reply as it should be read aloud: markdown syntax removed (fences keep their code,
 * links keep their text, table pipes and list markers go), whitespace collapsed, and cut
 * to `maxLength` characters on a word boundary with an ellipsis when longer.
 * Pure; the unit tests cover it.
 */
export function announcementText(markdown: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	// an unclosed fence at the cut is harmless: the rest of the reply is not read anyway
	const bounded =
		markdown.length > maxLength * SOURCE_FACTOR ? markdown.slice(0, maxLength * SOURCE_FACTOR) : markdown;
	const lines: string[] = [];
	let fence: string | null = null;
	for (const line of bounded.replace(/\r\n?/g, "\n").split("\n")) {
		if (fence === null) {
			fence = FENCE_OPEN.exec(line)?.[1] ?? null;
			if (fence !== null) continue;
		} else {
			// a fence closes on a bare marker of the same character that is at least as long
			const closing = FENCE_CLOSE.exec(line)?.[1];
			if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
			else lines.push(line);
			continue;
		}
		const plain = plainLine(line);
		if (plain !== null) lines.push(plain);
	}
	const text = lines.join(" ").replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) return text;

	const room = text.slice(0, maxLength - 1);
	// back up to the last space so the cut never lands inside a word, unless the room ends
	// exactly on a word or one word fills it
	const boundary = text.charAt(maxLength - 1) === " " ? -1 : room.lastIndexOf(" ");
	const cut = boundary > 0 ? room.slice(0, boundary) : room;
	return `${cut.replace(/[\s,;:.-]+$/, "")}\u2026`;
}
