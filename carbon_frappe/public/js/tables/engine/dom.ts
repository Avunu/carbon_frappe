// Minimal DOM helpers for the table engine.
//
// The engine deliberately does NOT use jQuery for its own rendering: it
// re-renders on every state change and jQuery's wrapper allocation shows up in
// profiles at report-view row counts. jQuery objects are still handed OUT at the
// adapter boundary, because frappe's API surface is jQuery-shaped.

/**
 * What {@link attr} and `el({ attrs })` accept. `null`, `undefined` and `false`
 * REMOVE the attribute (or skip writing it); everything else is stringified the
 * way `setAttribute` would have stringified it anyway.
 */
export type AttrValue = string | number | boolean | null | undefined;

/**
 * The camelCased, string-valued members of `CSSStyleDeclaration` — i.e. the CSS
 * properties {@link setStyles} can write. `cssText` is excluded because writing
 * it replaces the whole declaration rather than one property, and the numeric
 * index signature is excluded because it enumerates properties rather than
 * naming them.
 */
export type StyleProperty = Exclude<
	{
		[K in keyof CSSStyleDeclaration]-?: CSSStyleDeclaration[K] extends string ? K : never;
	}[keyof CSSStyleDeclaration],
	number | "cssText"
>;

/** A bag of CSS properties, as {@link setStyles} and `el({ style })` take it. */
export type StyleBag = {
	[K in StyleProperty]?: string | number | null | undefined;
};

/** The options `el()` builds an element from. */
export interface ElOptions {
	className?: string | undefined;
	attrs?: Record<string, AttrValue> | undefined;
	style?: StyleBag | undefined;
	text?: string | null | undefined;
	html?: string | null | undefined;
	/** Falsy entries are skipped, so a child can be built conditionally. */
	children?: ReadonlyArray<Node | null | undefined | false> | undefined;
}

/**
 * Create an element with classes, attributes and children in one call.
 *
 * Generic over the tag so callers get the real element type back —
 * `el("input")` is an `HTMLInputElement`, not the `HTMLElement`
 * `document.createElement(someString)` would have given them, and the renderer
 * reads `.value` / `.disabled` off it without a narrowing dance.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	opts: ElOptions = {}
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (opts.className) node.className = opts.className;
	if (opts.attrs) {
		for (const k in opts.attrs) {
			const v = opts.attrs[k];
			if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
		}
	}
	if (opts.style) Object.assign(node.style, opts.style);
	if (opts.text != null) node.textContent = opts.text;
	else if (opts.html != null) node.innerHTML = opts.html;
	if (opts.children) for (const c of opts.children) c && node.appendChild(c);
	return node;
}

/** Set an attribute, removing it for null/undefined/false. Avoids churn. */
export function attr(node: Element, name: string, value: AttrValue): void {
	if (value === null || value === undefined || value === false) {
		if (node.hasAttribute(name)) node.removeAttribute(name);
	} else if (node.getAttribute(name) !== String(value)) {
		node.setAttribute(name, String(value));
	}
}

/** Toggle a class only when it actually changes. */
export function toggleClass(node: Element, name: string | null | undefined, on: boolean): void {
	if (!name) return;
	if (on) {
		if (!node.classList.contains(name)) node.classList.add(name);
	} else if (node.classList.contains(name)) {
		node.classList.remove(name);
	}
}

/**
 * Apply a style object, skipping no-op writes (style writes force recalc).
 *
 * Generic over the property NAMES rather than taking a plain {@link StyleBag}:
 * `for…in` only hands back a key precise enough to index `node.style` when the
 * object it walks has a generic type, which is what keeps this cast-free.
 */
export function setStyles<K extends StyleProperty>(
	node: HTMLElement,
	styles: { [P in K]?: string | number | null | undefined }
): void {
	for (const k in styles) {
		const v = styles[k];
		const next = v === null || v === undefined ? "" : String(v);
		if (node.style[k] !== next) node.style[k] = next;
	}
}

/**
 * Reorder `children` under `parent` to match `desired`, moving the minimum
 * number of nodes. Nodes not in `desired` are left alone — the caller removes
 * them, because only the caller knows whether a detached row is being recycled
 * or destroyed.
 */
export function reconcileOrder(
	parent: Node,
	desired: readonly Node[],
	before: Node | null = null
): void {
	let cursor = before;
	for (let i = desired.length - 1; i >= 0; i--) {
		const node = desired[i];
		// `desired` is built by pushing, so it is never sparse; the guard is
		// what the index signature costs, not a case that happens.
		if (node === undefined) continue;
		if (node.nextSibling !== cursor || node.parentNode !== parent) {
			parent.insertBefore(node, cursor);
		}
		cursor = node;
	}
}

/** Closest ancestor (inclusive) matching a selector, null-safe. */
export function closest(node: Element | null | undefined, selector: string): Element | null {
	return node && node.closest ? node.closest(selector) : null;
}

/** A scheduler {@link raf} returns: call it to schedule, `.cancel()` to drop. */
export interface RafScheduler {
	(): void;
	cancel(): void;
}

/** requestAnimationFrame-coalesced callback. Returns a cancel function. */
export function raf(fn: () => void): RafScheduler {
	let handle: number | null = null;
	const wrapped = (): void => {
		handle = null;
		fn();
	};
	const schedule = (): void => {
		if (handle === null) handle = requestAnimationFrame(wrapped);
	};
	schedule.cancel = (): void => {
		if (handle !== null) cancelAnimationFrame(handle);
		handle = null;
	};
	return schedule;
}
