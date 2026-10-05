// The translation seam for the chat. Modules never call the global `__` at import
// time (there is none in Node, and none before the desk boots); they take a
// `Translate` and are handed `globalTranslate()` by whoever mounts them, so the unit
// tests pass `identityTranslate` and the desk passes frappe's.
//
// Frappe's string extractor greps for the literal spelling `__("...")`, so a module
// that receives a `Translate` binds it with `const __ = deps.translate;` and writes
// every user-facing string as `__("...")` at the call site, never through a variable.
import type { Translate } from "./flow/tool_labels.ts";
import { identityTranslate } from "./flow/tool_labels.ts";

export type { Translate };
export { identityTranslate };

/** frappe's `__`, read lazily at each call; the identity when the desk is not there. */
export function globalTranslate(): Translate {
	return (source, replace) => {
		if (typeof __ !== "function") return identityTranslate(source, replace);
		return replace === undefined ? __(source) : __(source, replace);
	};
}
