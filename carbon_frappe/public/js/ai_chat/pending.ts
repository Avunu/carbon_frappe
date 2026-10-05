// The one question both the controller and the panel ask of the store: is the
// conversation waiting for the user to answer an approval card? Kept apart so they
// cannot disagree.
import type { FlowApprovalItem, Message } from "./types.ts";
import { isFlowApprovalItem, isResponse } from "./types.ts";

/**
 * The approval card the conversation is paused on: the last unanswered
 * `flow_approval` item of the LAST message when that is a response, else undefined.
 * Earlier cards are locked (they carry `answers`), and a request after a response
 * means the turn moved on.
 */
export function pendingApproval(messages: readonly Message[]): FlowApprovalItem | undefined {
	const last = messages[messages.length - 1];
	if (last === undefined || !isResponse(last)) return undefined;
	for (let i = last.output.generic.length - 1; i >= 0; i--) {
		const item = last.output.generic[i];
		if (isFlowApprovalItem(item) && item.user_defined.answers === undefined) return item;
	}
	return undefined;
}
