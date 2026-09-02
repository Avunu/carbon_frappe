// Safe monkey-patching for the few places this theme must reach past CSS.
//
// The contract: a patch NEVER throws and NEVER half-applies. If frappe renames
// or restructures the target, the patch quietly does nothing, the component
// falls back to stock frappe styling, and the failure is reported. That is
// strictly better than a TypeError inside desk.bundle.js, which would
// white-screen the app over a cosmetic override.
//
// scripts/audit-markup.ts guards the same targets statically at build time;
// this is the runtime half.

import type { CarbonFrappeBrand } from "frappe-types";

declare global {
	// The `__carbon_frappe` marker has to live on the patched function itself,
	// not in a WeakSet here: it is read back across bundles (carbon_charts and
	// carbon_desk stamp their own targets and check them the same way), and a
	// hot reload re-evaluates this module, which would hand out a fresh WeakSet
	// and double-wrap everything. A property on the function survives both.
	//
	// `Function` is the right carrier because `safePatch` only ever stamps a
	// method it has already proved to be a function. The two non-method stamps
	// are already reachable without it: frappe-types declares the marker on
	// `FrappeChartConstructor`, and `FrappeFormatters` carries an index
	// signature that admits it.
	interface Function {
		/**
		 * The patch id, when carbon_frappe wrapped this function. Read as a
		 * truthiness test only; see {@link CarbonFrappeBrand} for why the type
		 * is wider than the `string` written here.
		 */
		__carbon_frappe?: CarbonFrappeBrand;
	}
}

/** One line of the drift report: a patch site and whether it took. */
export interface PatchRecord {
	/** stable name for reporting, as handed to {@link safePatch} / {@link record} */
	id: string;
	/** whether the patch/hook is in place */
	ok: boolean;
}

const registry: PatchRecord[] = [];

/**
 * Wrap a method on a frappe object, delegating to the original.
 *
 * `O` is the object that owns the method and `K` its key. Pinning `K` to
 * `keyof O` is the only way the computed read and write below are typed at all,
 * and it hands `wrap` the original at its real signature rather than as a bare
 * `Function` — so a replacement that drops an argument frappe still passes, or
 * returns the wrong thing, is a compile error at the patch site.
 *
 * The `& Function` on both sides of `wrap` is what makes the marker below
 * writable: a method's type is a plain call signature, and only `Function`
 * carries `__carbon_frappe`. It is also why the replacement's `this` is NOT
 * inferred — TypeScript puts no implicit `this` parameter on a class method's
 * type, so there is nothing here to infer one from. Replacements spell it
 * themselves, `function (this: ListView) { … }`, which is checked against the
 * real class; that is the honest alternative to a `Function`-typed seam, which
 * erases `this` and every argument along with it.
 *
 * @param getOwner  lazily resolves the object holding the method — lazy because
 *   frappe globals may not exist yet at import time. Call sites spell it
 *   `() => frappe.views.ReportView && frappe.views.ReportView.prototype`, so a
 *   short-circuit yields `false`/`undefined`, not just `null`.
 * @param key    method name on that object
 * @param wrap   receives the original, returns the replacement; must call
 *   through for upstream behaviour to survive
 * @param id     stable name for reporting
 * @returns whether the patch is in place
 */
export function safePatch<O extends object, K extends keyof O>(
	getOwner: () => O | null | false | undefined,
	key: K,
	wrap: (orig: O[K] & Function) => O[K] & Function,
	id: string
): boolean {
	let owner: O | null = null;
	try {
		owner = getOwner() || null;
	} catch (e) {
		owner = null;
	}

	// `!owner` is the half of the original `owner && owner[key]` guard that a
	// `typeof target !== "function"` test cannot express to the compiler; the
	// two together are the same single failure branch as before.
	const target = owner && owner[key];
	if (!owner || typeof target !== "function") {
		registry.push({ id, ok: false });
		return false;
	}

	// idempotent: re-running (hot reload, double include) must not double-wrap
	if (target.__carbon_frappe) {
		registry.push({ id, ok: true });
		return true;
	}

	let patched: O[K] & Function;
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
export function record(id: string, ok: unknown): void {
	registry.push({ id, ok: !!ok });
}

/**
 * Report any patch that failed to apply. Loud in dev, console-only in prod —
 * a theme must never block the app it is theming.
 */
export function assertPatches(): void {
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
