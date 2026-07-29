// Safe monkey-patching for the few places this theme must reach past CSS.
//
// The contract: a patch NEVER throws and NEVER half-applies. If frappe renames
// or restructures the target, the patch quietly does nothing, the component
// falls back to stock frappe styling, and the failure is reported. That is
// strictly better than a TypeError inside desk.bundle.js, which would
// white-screen the app over a cosmetic override.
//
// scripts/audit-markup.mjs guards the same targets statically at build time;
// this is the runtime half.

const registry = [];

/**
 * Wrap a method on a frappe object, delegating to the original.
 *
 * @param {() => object|null} getOwner  lazily resolves the object holding the
 *   method — lazy because frappe globals may not exist yet at import time
 * @param {string} key    method name on that object
 * @param {(orig: Function) => Function} wrap  receives the original, returns
 *   the replacement; must call through for upstream behaviour to survive
 * @param {string} id     stable name for reporting
 * @returns {boolean} whether the patch is in place
 */
export function safePatch(getOwner, key, wrap, id) {
	let owner = null;
	try {
		owner = getOwner();
	} catch (e) {
		owner = null;
	}

	const target = owner && owner[key];
	if (typeof target !== "function") {
		registry.push({ id, ok: false });
		return false;
	}

	// idempotent: re-running (hot reload, double include) must not double-wrap
	if (target.__carbon_frappe) {
		registry.push({ id, ok: true });
		return true;
	}

	let patched;
	try {
		patched = wrap(target);
	} catch (e) {
		registry.push({ id, ok: false });
		return false;
	}

	patched.__carbon_frappe = id;
	owner[key] = patched;
	registry.push({ id, ok: true });
	return true;
}

/** Register a non-method hook (an observer, a router subscription) for reporting. */
export function record(id, ok) {
	registry.push({ id, ok: !!ok });
}

/**
 * Report any patch that failed to apply. Loud in dev, console-only in prod —
 * a theme must never block the app it is theming.
 */
export function assertPatches() {
	const failed = registry.filter((r) => !r.ok);
	if (!failed.length) return;

	const msg =
		`carbon_frappe: ${failed.length} markup patch(es) no longer apply — ` +
		`${failed.map((f) => f.id).join(", ")}. ` +
		`These components have silently reverted to stock frappe styling.`;

	console.error(msg);

	// window.dev_server is emitted by frappe/www/desk.html
	if (window.dev_server && window.frappe && frappe.msgprint) {
		frappe.msgprint({ title: "Carbon theme drift", message: msg, indicator: "red" });
	}
}
