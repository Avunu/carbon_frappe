// Minimal DOM helpers for the table engine.
//
// The engine deliberately does NOT use jQuery for its own rendering: it
// re-renders on every state change and jQuery's wrapper allocation shows up in
// profiles at report-view row counts. jQuery objects are still handed OUT at the
// adapter boundary, because frappe's API surface is jQuery-shaped.

/** Create an element with classes, attributes and children in one call. */
export function el(tag, opts = {}) {
	const node = document.createElement(tag);
	if (opts.className) node.className = opts.className;
	if (opts.attrs) {
		for (const k in opts.attrs) {
			const v = opts.attrs[k];
			if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
		}
	}
	if (opts.style) Object.assign(node.style, opts.style);
	if (opts.text != null) node.textContent = opts.text;
	else if (opts.html != null) node.innerHTML = opts.html;
	if (opts.children) for (const c of opts.children) c && node.appendChild(c);
	return node;
}

/** Set an attribute, removing it for null/undefined/false. Avoids churn. */
export function attr(node, name, value) {
	if (value === null || value === undefined || value === false) {
		if (node.hasAttribute(name)) node.removeAttribute(name);
	} else if (node.getAttribute(name) !== String(value)) {
		node.setAttribute(name, value);
	}
}

/** Toggle a class only when it actually changes. */
export function toggleClass(node, name, on) {
	if (!name) return;
	if (on) {
		if (!node.classList.contains(name)) node.classList.add(name);
	} else if (node.classList.contains(name)) {
		node.classList.remove(name);
	}
}

/** Apply a style object, skipping no-op writes (style writes force recalc). */
export function setStyles(node, styles) {
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
export function reconcileOrder(parent, desired, before = null) {
	let cursor = before;
	for (let i = desired.length - 1; i >= 0; i--) {
		const node = desired[i];
		if (node.nextSibling !== cursor || node.parentNode !== parent) {
			parent.insertBefore(node, cursor);
		}
		cursor = node;
	}
}

/** Closest ancestor (inclusive) matching a selector, null-safe. */
export function closest(node, selector) {
	return node && node.closest ? node.closest(selector) : null;
}

/** requestAnimationFrame-coalesced callback. Returns a cancel function. */
export function raf(fn) {
	let handle = null;
	const wrapped = () => {
		handle = null;
		fn();
	};
	const schedule = () => {
		if (handle === null) handle = requestAnimationFrame(wrapped);
	};
	schedule.cancel = () => {
		if (handle !== null) cancelAnimationFrame(handle);
		handle = null;
	};
	return schedule;
}
