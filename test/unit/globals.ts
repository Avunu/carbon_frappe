// The desk globals the pure browser modules read AT CALL TIME. Installed on
// `globalThis` before those modules are imported; each stub reproduces the
// slice of frappe behaviour the function under test depends on, and nothing
// more. `Object.assign` rather than a typed assignment on purpose: the real
// `Frappe` type is the whole desk, and a test wants to say which three
// members exist, not pretend the other thousand do.
import type { FrappeDesktopIconRecord } from "frappe-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}:\d{2}$/;

export const routes = new Map<string, string>();

Object.assign(globalThis, {
	window: globalThis,
	location: { pathname: "/" },
	__: (s: string) => s,
	cint: (v: unknown) => {
		const n = parseInt(String(v), 10);
		return Number.isNaN(n) ? 0 : n;
	},
	// the system number format is `#,###.##`
	strip_number_groups: (v: string) => v.replace(/,/g, ""),
	frappe: {
		utils: {
			get_route_for_icon: (icon: FrappeDesktopIconRecord) => routes.get(icon.label),
		},
		datetime: {
			validate: (d: string) => ISO_DATE.test(d) || ISO_DATETIME.test(d) || ISO_TIME.test(d),
			// user format dd-mm-yyyy, the way frappe's `user_to_str` would render it
			user_to_str: (val: string, onlyTime = false) => {
				if (onlyTime) {
					const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(val);
					return m ? `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}` : "Invalid date";
				}
				const m = /^(\d{2})-(\d{2})-(\d{4})(?: (\d{2}:\d{2}:\d{2}))?$/.exec(val);
				if (!m) return "Invalid date";
				return `${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4]}` : ""}`;
			},
		},
	},
});
