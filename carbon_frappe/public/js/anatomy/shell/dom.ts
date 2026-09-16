// DOM helpers shared by the UI Shell modules. Nothing here knows about frappe
// or Carbon; it is the handful of narrowings the shell repeats.

/**
 * A node the shell's own template just wrote.
 *
 * A template/selector drift used to surface as a bare `TypeError: … is null`
 * one line later. This throws in the same place for the same reason and names
 * the selector that went missing — `mount()` runs inside the retry interval
 * either way.
 */
export function required(root: ParentNode, sel: string): HTMLElement {
	const node = root.querySelector<HTMLElement>(sel);
	if (!node) throw new Error(`carbon_frappe: UI Shell header is missing ${sel}`);
	return node;
}

/**
 * `nodeType === 1` stays the decision the JS made; the rest is only what lets
 * the compiler believe it, since `Node` carries no `matches`. Duck-typed rather
 * than `instanceof Element` for the same reason tables/datatable/navigation.ts
 * is: a node adopted from another realm fails `instanceof` while still being a
 * perfectly good element.
 */
export function isElementNode(node: Node): node is Element {
	return node.nodeType === 1 && "matches" in node && typeof node.matches === "function";
}

/**
 * The same duck test for the HTMLElement surface the shell writes to
 * (`hidden`, `dataset`, `focus()`, `click()`). `matches` proves Element;
 * `focus` is HTMLElement's (and SVGElement's), and SVG never reaches these
 * paths — every caller has already selected a `.item-anchor` / `<a>` / `<button>`.
 */
export function isHTMLElement(node: Node | EventTarget | null | undefined): node is HTMLElement {
	return (
		!!node &&
		node instanceof Node &&
		isElementNode(node) &&
		"focus" in node &&
		typeof node.focus === "function"
	);
}

/** Trimmed `textContent` of an element, or `""` for none. */
export function text(el: Element | null | undefined): string {
	return (el && el.textContent ? el.textContent : "").trim();
}

/**
 * HTML-escape for the shell's template strings. frappe's own escaper when the
 * desk is up (it is, by the time anything here renders); the inline fallback
 * only exists so this module has no load-order dependency on `frappe.utils`.
 */
export function esc(s: string): string {
	if (window.frappe && frappe.utils && typeof frappe.utils.escape_html === "function") {
		return frappe.utils.escape_html(s);
	}
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
