// Time handling for message timestamps and the conversation list, as pure functions.
//
// Frappe stores every datetime as a naive string ("2026-10-02 14:05:09.123456") in the
// SYSTEM time zone; nothing in the string says which. Reading it with `new Date(string)`
// would take it for the browser's zone and shift every restored message by the difference
// between the server and the browser. Frappe's own `frappe.datetime.str_to_user` converts
// system to user zone but returns a formatted string, and frappe-types declares no
// accessor that yields an instant, so the conversion is done here with Intl, from the
// zones in `frappe.boot.time_zone` (`readTimeZones`).
//
// The user's zone is where times are SHOWN, live (`Date.now()`) and restored alike:
// frappe renders every datetime in it, not in the browser's.
import { isRecord } from "./types.ts";

const DAY_MS = 86_400_000;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

export interface TimeZones {
	/** The zone server datetimes are stored in. */
	system?: string;
	/** The zone the signed-in user wants times shown in; defaults to the system zone, as frappe does. */
	user?: string;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The zones out of `frappe.boot`. `boot.time_zone` is `{system, user}` (frappe/boot.py
 * `set_time_zone`) but frappe-types does not declare it, so `boot` is read as `unknown`;
 * `boot.sysdefaults.time_zone` (declared) is the fallback for the system zone.
 */
export function readTimeZones(boot: unknown): TimeZones {
	if (!isRecord(boot)) return {};
	const declared = isRecord(boot["time_zone"]) ? boot["time_zone"] : {};
	const defaults = isRecord(boot["sysdefaults"]) ? boot["sysdefaults"] : {};
	const system = nonEmptyString(declared["system"]) ?? nonEmptyString(defaults["time_zone"]);
	const user = nonEmptyString(declared["user"]) ?? system;
	const zones: TimeZones = {};
	if (system !== undefined) zones.system = system;
	if (user !== undefined) zones.user = user;
	return zones;
}

/** `Intl.DateTimeFormat` for `timeZone`, or undefined when the runtime rejects the name. */
function formatterFor(
	locale: string,
	timeZone: string | undefined,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale, timeZone === undefined ? options : { ...options, timeZone });
	} catch {
		// a locale or zone tag the runtime rejects: the reader's own defaults beat no time at all
		return new Intl.DateTimeFormat(undefined, options);
	}
}

/** How far `timeZone` is ahead of UTC at the instant `at`, in milliseconds. Throws RangeError for an unknown zone. */
function offsetAt(at: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(at);
	const read = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);
	const asUtc = Date.UTC(
		read("year"),
		read("month") - 1,
		read("day"),
		read("hour"),
		read("minute"),
		read("second"),
	);
	return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant (epoch milliseconds) a naive server datetime names, given the zone the server
 * stores in. Undefined for a value that is not a datetime. A missing or unknown `systemTimeZone`
 * reads the string in the browser's zone, which is right on a bench whose zone matches the
 * browser's and the best available guess otherwise. A wall-clock time that falls in a DST
 * gap or repeats resolves to the earlier of the two instants.
 */
export function serverDatetimeToEpoch(
	naive: string | null | undefined,
	systemTimeZone?: string,
): number | undefined {
	if (typeof naive !== "string") return undefined;
	const match = NAIVE.exec(naive.trim());
	if (match === null) return undefined;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined ||
		second === undefined
	) {
		return undefined;
	}
	// ".5" is half a second and ".123456" is 123 ms: the digits follow a decimal point
	const millis = Math.floor(Number(`0.${match[7] ?? "0"}`) * 1000);
	const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
	// Date.UTC rolls "2026-13-45 24:00:00" and "0000-00-00 00:00:00" (MySQL's zero date) over to some other
	// day instead of failing; a field that does not survive the round trip means the string was no datetime.
	const check = new Date(wall);
	if (
		Number.isNaN(wall) ||
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		check.getUTCHours() !== hour ||
		check.getUTCMinutes() !== minute ||
		check.getUTCSeconds() !== second
	) {
		return undefined;
	}

	if (systemTimeZone !== undefined) {
		try {
			// The zone's offset can change within a day of `wall` (a DST switch), so try the offset on either
			// side: the instants they give are the wall time's readings, and only a reading the zone agrees
			// with is real. Two real readings mean the clock repeated that hour (the earlier wins); none
			// means it skipped it (the earlier candidate again).
			const offsets = new Set([
				offsetAt(wall - DAY_MS, systemTimeZone),
				offsetAt(wall + DAY_MS, systemTimeZone),
			]);
			const candidates = Array.from(offsets, (offset) => wall - offset).sort((a, b) => a - b);
			return candidates.find((at) => offsetAt(at, systemTimeZone) === wall - at) ?? candidates[0];
		} catch {
			// unknown zone name: fall through to the browser's zone
		}
	}
	return new Date(year, month - 1, day, hour, minute, second, millis).getTime();
}

export interface TimeFormatOptions {
	/** BCP 47 tag. */
	locale: string;
	/** IANA zone to show times in (`TimeZones.user`); the browser's zone when absent. */
	timeZone?: string | undefined;
}

/** The calendar day of `at` in `timeZone` as a comparable number (year * 10000 + month * 100 + day). */
export function dayNumber(at: number, timeZone?: string): number {
	const parts = formatterFor("en-US", timeZone, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(at);
	const read = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);
	return read("year") * 10000 + read("month") * 100 + read("day");
}

/** Whole calendar days from `earlier` to `later` in `timeZone` (0 for the same day, negative when reversed). */
export function daysBetween(earlier: number, later: number, timeZone?: string): number {
	const ordinal = (at: number): number => {
		const day = dayNumber(at, timeZone);
		return Date.UTC(Math.floor(day / 10000), Math.floor((day % 10000) / 100) - 1, day % 100) / DAY_MS;
	};
	return Math.round(ordinal(later) - ordinal(earlier));
}

/**
 * The short form shown in a message's avatar line: the time alone for today, and the day
 * and month before it for any other day, because a restored conversation spans days and
 * "3:05 PM" alone would not say which.
 */
export function formatMessageTime(timestamp: number, now: number, options: TimeFormatOptions): string {
	const sameDay = dayNumber(timestamp, options.timeZone) === dayNumber(now, options.timeZone);
	const format = sameDay
		? { timeStyle: "short" as const }
		: {
				month: "short" as const,
				day: "numeric" as const,
				hour: "numeric" as const,
				minute: "2-digit" as const,
			};
	return formatterFor(options.locale, options.timeZone, format).format(timestamp);
}

/** The full date and time, for a `<time>` element's accessible name and tooltip. */
export function formatMessageDateTime(timestamp: number, options: TimeFormatOptions): string {
	return formatterFor(options.locale, options.timeZone, { dateStyle: "full", timeStyle: "short" }).format(
		timestamp,
	);
}
