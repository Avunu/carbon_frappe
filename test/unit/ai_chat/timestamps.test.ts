import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	dayNumber,
	daysBetween,
	formatMessageDateTime,
	formatMessageTime,
	readTimeZones,
	serverDatetimeToEpoch,
} from "../../../carbon_frappe/public/js/ai_chat/timestamps.ts";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

const originalZone = process.env["TZ"];
afterEach(() => {
	if (originalZone === undefined) delete process.env["TZ"];
	else process.env["TZ"] = originalZone;
});

describe("readTimeZones", () => {
	it("reads boot.time_zone", () => {
		assert.deepEqual(readTimeZones({ time_zone: { system: KOLKATA, user: NEW_YORK } }), {
			system: KOLKATA,
			user: NEW_YORK,
		});
	});

	it("defaults the user zone to the system zone, as frappe does", () => {
		assert.deepEqual(readTimeZones({ time_zone: { system: KOLKATA } }), { system: KOLKATA, user: KOLKATA });
	});

	it("falls back to sysdefaults for the system zone", () => {
		assert.deepEqual(readTimeZones({ sysdefaults: { time_zone: NEW_YORK } }), {
			system: NEW_YORK,
			user: NEW_YORK,
		});
		assert.deepEqual(readTimeZones({ time_zone: { user: KOLKATA }, sysdefaults: { time_zone: NEW_YORK } }), {
			system: NEW_YORK,
			user: KOLKATA,
		});
	});

	it("returns nothing for a boot that has no usable zone", () => {
		assert.deepEqual(readTimeZones(null), {});
		assert.deepEqual(readTimeZones(undefined), {});
		assert.deepEqual(readTimeZones("Asia/Kolkata"), {});
		assert.deepEqual(readTimeZones([]), {});
		assert.deepEqual(readTimeZones({}), {});
		assert.deepEqual(
			readTimeZones({ time_zone: { system: "", user: "" }, sysdefaults: { time_zone: "" } }),
			{},
		);
		assert.deepEqual(readTimeZones({ time_zone: { system: 5, user: null } }), {});
	});
});

describe("serverDatetimeToEpoch", () => {
	it("reads the string in the system zone, not the browser's", () => {
		// 14:05:09 in Kolkata (+05:30) is 08:35:09 UTC
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09", KOLKATA), Date.UTC(2026, 9, 2, 8, 35, 9));
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09", "UTC"), Date.UTC(2026, 9, 2, 14, 5, 9));
	});

	it("is independent of the zone the test process runs in", () => {
		const results = new Set<number | undefined>();
		for (const zone of ["America/Los_Angeles", "UTC", "Pacific/Auckland"]) {
			process.env["TZ"] = zone;
			results.add(serverDatetimeToEpoch("2026-10-02 14:05:09", KOLKATA));
		}
		assert.deepEqual([...results], [Date.UTC(2026, 9, 2, 8, 35, 9)]);
	});

	it("accepts a T separator and surrounding whitespace", () => {
		const expected = Date.UTC(2026, 9, 2, 8, 35, 9);
		assert.equal(serverDatetimeToEpoch("2026-10-02T14:05:09", KOLKATA), expected);
		assert.equal(serverDatetimeToEpoch("  2026-10-02 14:05:09\n", KOLKATA), expected);
	});

	it("reads the fraction as a decimal fraction of a second", () => {
		const base = Date.UTC(2026, 9, 2, 14, 5, 9);
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09.5", "UTC"), base + 500);
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09.05", "UTC"), base + 50);
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09.123456", "UTC"), base + 123);
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09.999999", "UTC"), base + 999);
		assert.equal(serverDatetimeToEpoch("2026-10-02 14:05:09.000001", "UTC"), base);
	});

	it("resolves a wall time that DST skips to the earlier instant", () => {
		// 2026-03-08 02:30 does not exist in New York: clocks go from 02:00 EST to 03:00 EDT
		assert.equal(serverDatetimeToEpoch("2026-03-08 02:30:00", NEW_YORK), Date.UTC(2026, 2, 8, 6, 30, 0));
		// either side of the gap is unambiguous
		assert.equal(serverDatetimeToEpoch("2026-03-08 01:30:00", NEW_YORK), Date.UTC(2026, 2, 8, 6, 30, 0));
		assert.equal(serverDatetimeToEpoch("2026-03-08 03:30:00", NEW_YORK), Date.UTC(2026, 2, 8, 7, 30, 0));
	});

	it("resolves a wall time that DST repeats to the earlier instant", () => {
		// 2026-11-01 01:30 happens twice in New York: 05:30 UTC (EDT) and 06:30 UTC (EST)
		assert.equal(serverDatetimeToEpoch("2026-11-01 01:30:00", NEW_YORK), Date.UTC(2026, 10, 1, 5, 30, 0));
		assert.equal(serverDatetimeToEpoch("2026-11-01 02:30:00", NEW_YORK), Date.UTC(2026, 10, 1, 7, 30, 0));
	});

	it("reads back as the same wall time around every DST switch, except for times the clock skipped", () => {
		const wallOf = (at: number, timeZone: string): string => {
			const parts = new Intl.DateTimeFormat("en-CA", {
				timeZone,
				hourCycle: "h23",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			}).formatToParts(at);
			const part = (type: Intl.DateTimeFormatPartTypes): string =>
				parts.find((entry) => entry.type === type)?.value ?? "";
			return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
		};
		const switches: [string, string][] = [
			[NEW_YORK, "2026-03-07"],
			[NEW_YORK, "2026-10-31"],
			["Europe/London", "2026-03-28"],
			["Europe/London", "2026-10-24"],
			["Pacific/Auckland", "2026-09-26"],
			["Pacific/Auckland", "2027-04-03"],
			["Australia/Lord_Howe", "2026-10-03"],
			["Australia/Lord_Howe", "2027-04-03"],
			["America/Santiago", "2026-09-05"],
		];
		for (const [zone, firstDay] of switches) {
			let skipped = 0;
			const start = Date.UTC(
				Number(firstDay.slice(0, 4)),
				Number(firstDay.slice(5, 7)) - 1,
				Number(firstDay.slice(8, 10)),
			);
			// 30-minute steps over three days, as wall-clock strings
			for (let step = 0; step < 3 * 48; step++) {
				const wall = new Date(start + step * 1_800_000).toISOString().slice(0, 19).replace("T", " ");
				const at = serverDatetimeToEpoch(wall, zone);
				assert.notEqual(at, undefined, `${zone} ${wall}`);
				if (at === undefined) continue;
				const back = wallOf(at, zone);
				if (back !== wall) {
					skipped += 1;
					assert.ok(back < wall, `${zone} ${wall} resolved later, to ${back}`);
				}
			}
			assert.ok(skipped <= 4, `${zone} ${firstDay}: ${skipped} wall times did not round trip`);
		}
	});

	it("reads the string in the browser's zone when the zone is unknown or missing", () => {
		process.env["TZ"] = NEW_YORK;
		const expected = Date.UTC(2026, 0, 15, 17, 0, 0);
		assert.equal(serverDatetimeToEpoch("2026-01-15 12:00:00"), expected);
		assert.equal(serverDatetimeToEpoch("2026-01-15 12:00:00", "Mars/Phobos"), expected);
		assert.equal(serverDatetimeToEpoch("2026-01-15 12:00:00", ""), expected);
	});

	it("is undefined for anything that is not a full datetime", () => {
		for (const value of [
			undefined,
			null,
			"",
			"   ",
			"garbage",
			"2026-10-02",
			"2026-10-02 14:05",
			"14:05:09",
			"2026/10/02 14:05:09",
			"2026-10-02 14:05:09Z",
			"2026-10-02 14:05:09.1234567",
			"2026-10-02 14:05:09 PM",
		]) {
			assert.equal(serverDatetimeToEpoch(value, KOLKATA), undefined, String(value));
		}
	});

	it("is undefined for a datetime Date.UTC would silently roll over", () => {
		for (const value of [
			"0000-00-00 00:00:00",
			"2026-13-01 00:00:00",
			"2026-02-30 00:00:00",
			"2026-10-02 24:00:00",
			"2026-10-02 12:60:00",
			"2026-10-02 12:00:60",
		]) {
			assert.equal(serverDatetimeToEpoch(value, KOLKATA), undefined, value);
		}
		assert.notEqual(serverDatetimeToEpoch("2028-02-29 00:00:00", KOLKATA), undefined);
	});
});

describe("dayNumber and daysBetween", () => {
	// Auckland is UTC+13 in October (daylight time), Honolulu UTC-10
	const instant = Date.UTC(2026, 9, 2, 11, 0, 0);

	it("reads the calendar day in the given zone", () => {
		assert.equal(dayNumber(instant, "UTC"), 20261002);
		assert.equal(dayNumber(instant, "Pacific/Auckland"), 20261003);
		assert.equal(dayNumber(instant, "Pacific/Honolulu"), 20261002);
		const evening = Date.UTC(2026, 9, 2, 9, 30, 0);
		assert.equal(dayNumber(evening, "Pacific/Auckland"), 20261002);
		assert.equal(dayNumber(evening, "Pacific/Honolulu"), 20261001);
	});

	it("counts calendar days, not 24-hour blocks", () => {
		const lateEvening = Date.UTC(2026, 9, 2, 22, 0, 0);
		const earlyMorning = Date.UTC(2026, 9, 3, 2, 0, 0);
		assert.equal(daysBetween(lateEvening, earlyMorning, "UTC"), 1);
		assert.equal(daysBetween(lateEvening, earlyMorning, "America/Los_Angeles"), 0);
		assert.equal(daysBetween(earlyMorning, lateEvening, "UTC"), -1);
		assert.equal(daysBetween(instant, instant, "UTC"), 0);
	});

	it("counts a 23-hour DST day as one day", () => {
		const midnightBefore = Date.UTC(2026, 2, 8, 5, 0, 0); // Mar 8 00:00 EST
		const midnightAfter = Date.UTC(2026, 2, 9, 4, 0, 0); // Mar 9 00:00 EDT, 23 hours later
		assert.equal(dayNumber(midnightAfter - 1, NEW_YORK), 20260308);
		assert.equal(daysBetween(midnightBefore, midnightAfter, NEW_YORK), 1);
	});

	it("counts across month and year ends", () => {
		const dec31 = Date.UTC(2026, 11, 31, 12, 0, 0);
		const jan1 = Date.UTC(2027, 0, 1, 12, 0, 0);
		assert.equal(daysBetween(dec31, jan1, "UTC"), 1);
		assert.equal(daysBetween(Date.UTC(2028, 1, 28, 12), Date.UTC(2028, 2, 1, 12), "UTC"), 2);
	});

	it("falls back to the browser's zone for a zone the runtime rejects", () => {
		process.env["TZ"] = "UTC";
		assert.equal(dayNumber(instant, "Mars/Phobos"), 20261002);
		assert.equal(dayNumber(instant), 20261002);
	});
});

describe("formatMessageTime", () => {
	const noon = Date.UTC(2026, 9, 2, 19, 5, 0); // 3:05 PM in New York (EDT)

	it("shows the time alone for a time on the same day as now, in the display zone", () => {
		const text = formatMessageTime(noon, noon + 60_000, { locale: "en-US", timeZone: NEW_YORK });
		assert.match(text, /^3:05\sPM$/);
	});

	it("compares days in the display zone, not in UTC", () => {
		// 02:00 UTC on Oct 3 is still Oct 2 evening in New York
		const text = formatMessageTime(Date.UTC(2026, 9, 3, 2, 0, 0), Date.UTC(2026, 9, 2, 20, 0, 0), {
			locale: "en-US",
			timeZone: NEW_YORK,
		});
		assert.match(text, /^10:00\sPM$/);
	});

	it("adds the month and day for another day", () => {
		const text = formatMessageTime(noon, noon + 2 * 86_400_000, { locale: "en-US", timeZone: NEW_YORK });
		assert.match(text, /^Oct 2, 3:05\sPM$/);
	});

	it("follows the locale", () => {
		const text = formatMessageTime(noon, noon + 60_000, { locale: "de-DE", timeZone: NEW_YORK });
		assert.match(text, /^15:05$/);
	});

	it("never throws for a locale or zone the runtime rejects", () => {
		const bad = formatMessageTime(noon, noon, { locale: "not a locale!", timeZone: "Mars/Phobos" });
		assert.equal(typeof bad, "string");
		assert.notEqual(bad, "");
		assert.notEqual(formatMessageTime(noon, noon, { locale: "en-US" }), "");
		assert.notEqual(formatMessageDateTime(noon, { locale: "", timeZone: "Mars/Phobos" }), "");
	});
});

describe("formatMessageDateTime", () => {
	it("spells out the weekday, date and time", () => {
		const text = formatMessageDateTime(Date.UTC(2026, 9, 2, 19, 5, 0), {
			locale: "en-US",
			timeZone: NEW_YORK,
		});
		assert.match(text, /^Friday, October 2, 2026 at 3:05\sPM$/);
	});

	it("shows the same instant differently per zone", () => {
		const at = Date.UTC(2026, 9, 2, 19, 5, 0);
		assert.match(
			formatMessageDateTime(at, { locale: "en-US", timeZone: "Pacific/Auckland" }),
			/Saturday, October 3/,
		);
	});
});
