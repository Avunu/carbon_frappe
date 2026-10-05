import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AttachedFile, UploadedFile } from "../../../carbon_frappe/public/js/ai_chat/flow/client.ts";
import type { FlowSessionAttachmentRow } from "../../../carbon_frappe/public/js/ai_chat/flow/docs.ts";
import {
	FALLBACK_MAX_FILE_BYTES,
	MAX_ATTACHMENTS,
	MAX_FILE_NAME_CHARS,
	acceptAttribute,
	attachmentChipsOf,
	attachmentIdsOf,
	displayName,
	extensionOf,
	fileFieldFor,
	fileFieldId,
	fileFieldsFromRows,
	fileFieldsOf,
	formatFileSize,
	isFileDrag,
	readUploadLimits,
	referenceFor,
	shouldAttachPaste,
	summarizeFailures,
	summarizeRejections,
	transferProgress,
	uploadChips,
	validateFiles,
} from "../../../carbon_frappe/public/js/ai_chat/uploads.ts";
import type { FileRejection, UploadLimits } from "../../../carbon_frappe/public/js/ai_chat/uploads.ts";
import type {
	ExternalFileReference,
	MessageInput,
	PendingUpload,
	StructuredField,
} from "../../../carbon_frappe/public/js/ai_chat/types.ts";

function substitute(source: string, replace: readonly string[] = []): string {
	return source.replace(/\{(\d+)\}/g, (_match, index: string) => replace[Number(index)] ?? "");
}

const identity = (source: string, replace?: readonly string[]): string => substitute(source, replace);

const LIMITS: UploadLimits = {
	extensions: ["csv", "pdf", "txt"],
	maxFileBytes: 1000,
	maxFiles: 3,
};

function file(name: string, size = 10, lastModified = 1): File {
	return new File(["x".repeat(size)], name, { lastModified });
}

function upload(id: string, overrides: Partial<PendingUpload> = {}): PendingUpload {
	return { id, file: file(`${id}.txt`), status: "uploading", progress: 0, ...overrides };
}

function reference(id: string, extra: Partial<ExternalFileReference> = {}): ExternalFileReference {
	return { type: "reference", id, ...extra };
}

describe("readUploadLimits", () => {
	it("is null for anything that is not a boot object with a usable list", () => {
		assert.equal(readUploadLimits(undefined), null);
		assert.equal(readUploadLimits(null), null);
		assert.equal(readUploadLimits("boot"), null);
		assert.equal(readUploadLimits({}), null);
		assert.equal(readUploadLimits({ flow_supported_file_types: "pdf" }), null);
		assert.equal(readUploadLimits({ flow_supported_file_types: { 0: "pdf" } }), null);
		assert.equal(readUploadLimits({ flow_supported_file_types: [] }), null);
		assert.equal(
			readUploadLimits({ flow_supported_file_types: [1, null, {}, "", ".", "a b", "p*df"] }),
			null,
		);
	});

	it("keeps the usable entries, lower-cased, dotless, unique and sorted", () => {
		const limits = readUploadLimits({
			flow_supported_file_types: ["PDF", ".txt", " csv ", "txt", 7, "tar.gz", "docx", ".PDF"],
			max_file_size: 1234,
		});
		assert.deepEqual(limits, {
			extensions: ["csv", "docx", "pdf", "txt"],
			maxFileBytes: 1234,
			maxFiles: MAX_ATTACHMENTS,
		});
	});

	it("falls back to 5 MiB unless max_file_size is a positive finite number", () => {
		const types = ["pdf"];
		for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "100", {}]) {
			assert.equal(
				readUploadLimits({ flow_supported_file_types: types, max_file_size: bad })?.maxFileBytes,
				FALLBACK_MAX_FILE_BYTES,
			);
		}
		assert.equal(
			readUploadLimits({ flow_supported_file_types: types })?.maxFileBytes,
			FALLBACK_MAX_FILE_BYTES,
		);
		assert.equal(
			readUploadLimits({ flow_supported_file_types: types, max_file_size: 26214400 })?.maxFileBytes,
			26214400,
		);
	});
});

describe("extensionOf", () => {
	it("reads the last dot like os.path.splitext, lower case", () => {
		assert.equal(extensionOf("a.PDF"), "pdf");
		assert.equal(extensionOf("a.tar.gz"), "gz");
		assert.equal(extensionOf("a"), "");
		assert.equal(extensionOf("a."), "");
		assert.equal(extensionOf(".bashrc"), "");
		assert.equal(extensionOf("..x.txt"), "txt");
		assert.equal(extensionOf(""), "");
	});
});

describe("acceptAttribute", () => {
	it("is the dotted list", () => {
		assert.equal(acceptAttribute(LIMITS), ".csv,.pdf,.txt");
	});
});

describe("formatFileSize", () => {
	it("uses 1024 units, one decimal below 10 and none from 10 up", () => {
		const cases: [number, string][] = [
			[0, "0 B"],
			[1, "1 B"],
			[12, "12 B"],
			[1023, "1,023 B"],
			[1024, "1 KB"],
			[1536, "1.5 KB"],
			[340 * 1024, "340 KB"],
			[10 * 1024, "10 KB"],
			[Math.round(1.5 * 1024 * 1024), "1.5 MB"],
			[10 * 1024 * 1024, "10 MB"],
			[25 * 1024 * 1024, "25 MB"],
			[1024 ** 3, "1 GB"],
			[5 * 1024 ** 4, "5,120 GB"],
		];
		for (const [bytes, text] of cases) assert.equal(formatFileSize(bytes, "en"), text, String(bytes));
	});

	it("moves up a unit instead of rounding to 1024", () => {
		assert.equal(formatFileSize(1024 * 1024 - 1, "en"), "1 MB");
		assert.equal(formatFileSize(1024 * 1024 * 1024 - 1, "en"), "1 GB");
	});

	it("formats the number for the locale", () => {
		assert.equal(formatFileSize(1536, "de"), "1,5 KB");
		assert.equal(formatFileSize(1536, "en-US"), "1.5 KB");
	});

	it("falls back to English for a malformed locale and never throws", () => {
		assert.equal(formatFileSize(1536, "not a locale!"), "1.5 KB");
		assert.equal(formatFileSize(1536, ""), "1.5 KB");
	});

	it("reads a negative, NaN or infinite size as 0 B", () => {
		assert.equal(formatFileSize(-5, "en"), "0 B");
		assert.equal(formatFileSize(Number.NaN, "en"), "0 B");
		assert.equal(formatFileSize(Number.POSITIVE_INFINITY, "en"), "0 B");
	});
});

describe("displayName", () => {
	it("leaves an ordinary name alone", () => {
		assert.equal(displayName("CF AI Test notes.txt"), "CF AI Test notes.txt");
	});

	it("drops control characters and bidirectional overrides and collapses white space", () => {
		assert.equal(displayName("a\u0000b\u0007c.txt"), "abc.txt");
		assert.equal(displayName("gnp‮exe.txt"), "gnpexe.txt");
		assert.equal(displayName("⁦x⁩ \t\n y.txt"), "x y.txt");
	});

	it("shortens a long name around an ellipsis and keeps its extension", () => {
		const shown = displayName(`${"a".repeat(200)}.pdf`);
		assert.equal(Array.from(shown).length, 80);
		assert.ok(shown.endsWith("….pdf"));
		assert.ok(shown.startsWith("aaaa"));
	});

	it("drops a very long extension with the rest", () => {
		const shown = displayName(`${"a".repeat(100)}.${"b".repeat(30)}`);
		assert.equal(Array.from(shown).length, 80);
		assert.ok(shown.endsWith("…"));
	});

	it("does not split a surrogate pair when cutting", () => {
		const shown = displayName(`${"\u{1F600}".repeat(120)}.txt`);
		assert.doesNotMatch(shown, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});
});

describe("validateFiles", () => {
	const check = (files: File[], existing: File[] = [], limits: UploadLimits = LIMITS) =>
		validateFiles(files, existing, limits, identity, "en");

	it("accepts files that pass, in order, with no rejections", () => {
		const a = file("a.txt");
		const b = file("b.CSV");
		const result = check([a, b]);
		assert.deepEqual(result.accepted, [a, b]);
		assert.deepEqual(result.rejections, []);
	});

	it("rejects an empty file", () => {
		const result = check([file("e.txt", 0)]);
		assert.deepEqual(result.accepted, []);
		assert.deepEqual(result.rejections, [{ reason: "empty", fileName: "e.txt", message: "e.txt is empty." }]);
	});

	it("rejects an unsupported or missing extension as a type error", () => {
		const result = check([file("a.exe"), file("noext"), file("trail."), file(".txt")]);
		assert.deepEqual(
			result.rejections.map((rejection) => [rejection.reason, rejection.fileName]),
			[
				["type", "a.exe"],
				["type", "noext"],
				["type", "trail."],
				["type", ".txt"],
			],
		);
		assert.equal(result.rejections[0]?.message, "a.exe is not a supported file type.");
	});

	it("accepts a file of exactly the limit and rejects one byte more, naming the limit", () => {
		const exact = file("exact.txt", 1000);
		const over = file("over.txt", 1001);
		const result = check([exact, over]);
		assert.deepEqual(result.accepted, [exact]);
		assert.deepEqual(result.rejections, [
			{ reason: "size", fileName: "over.txt", message: "over.txt is larger than the 1,000 B limit." },
		]);
	});

	it("accepts a name of exactly the limit and rejects one character more", () => {
		const exact = file(`${"a".repeat(MAX_FILE_NAME_CHARS - 4)}.txt`);
		const over = file(`${"a".repeat(MAX_FILE_NAME_CHARS - 3)}.txt`);
		assert.equal(MAX_FILE_NAME_CHARS, 140);
		const result = check([exact, over]);
		assert.deepEqual(result.accepted, [exact]);
		assert.deepEqual(
			result.rejections.map((rejection) => [rejection.reason, rejection.fileName]),
			[["name", over.name]],
		);
		assert.match(
			result.rejections[0]?.message ?? "",
			/ has a name longer than 140 characters\. Rename the file and try again\.$/,
		);
	});

	it("counts the characters of a name, not its UTF-16 units or bytes", () => {
		const emoji = file(`${"\u{1F600}".repeat(MAX_FILE_NAME_CHARS - 4)}.txt`);
		assert.equal(emoji.name.length, 2 * (MAX_FILE_NAME_CHARS - 4) + 4);
		assert.deepEqual(check([emoji]).rejections, []);
		const over = file(`${"\u{1F600}".repeat(MAX_FILE_NAME_CHARS - 3)}.txt`);
		assert.equal(check([over]).rejections[0]?.reason, "name");
	});

	it("names the displayed file, not the raw one, in the name message", () => {
		const long = `a\u202E${"b".repeat(MAX_FILE_NAME_CHARS)}.txt`;
		const message = check([file(long)]).rejections[0]?.message ?? "";
		assert.ok(message.startsWith(`${displayName(long)} has a name`));
	});

	it("checks the name last, after type and size", () => {
		const long = "a".repeat(MAX_FILE_NAME_CHARS);
		assert.equal(check([file(`${long}.exe`)]).rejections[0]?.reason, "type");
		assert.equal(check([file(`${long}.txt`, 5000)]).rejections[0]?.reason, "size");
		assert.equal(check([file(`${long}.txt`)]).rejections[0]?.reason, "name");
	});

	it("formats the limit for the locale", () => {
		const limits = { ...LIMITS, maxFileBytes: 1536 };
		const result = validateFiles([file("big.txt", 2000)], [], limits, identity, "de");
		assert.equal(result.rejections[0]?.message, "big.txt is larger than the 1,5 KB limit.");
	});

	it("checks duplicate, then empty, then type, then size", () => {
		const twin = file("twin.exe", 0);
		const existing = [file("twin.exe", 0)];
		assert.equal(check([twin], existing).rejections[0]?.reason, "duplicate");
		assert.equal(check([file("z.exe", 0)]).rejections[0]?.reason, "empty");
		assert.equal(check([file("z.exe", 5000)]).rejections[0]?.reason, "type");
		assert.equal(check([file("z.txt", 5000)]).rejections[0]?.reason, "size");
	});

	it("treats the same name, size and lastModified as a duplicate of an existing file", () => {
		const existing = [file("a.txt", 10, 5)];
		assert.equal(check([file("a.txt", 10, 5)], existing).rejections[0]?.reason, "duplicate");
		assert.deepEqual(check([file("a.txt", 10, 6)], existing).rejections, []);
		assert.deepEqual(check([file("a.txt", 11, 5)], existing).rejections, []);
		assert.deepEqual(check([file("b.txt", 10, 5)], existing).rejections, []);
	});

	it("treats a repeat inside one batch as a duplicate", () => {
		const first = file("a.txt", 10, 5);
		const result = check([first, file("a.txt", 10, 5)]);
		assert.deepEqual(result.accepted, [first]);
		assert.deepEqual(
			result.rejections.map((rejection) => rejection.reason),
			["duplicate"],
		);
	});

	it("does not let a refused file make its twin a duplicate", () => {
		const result = check([file("a.exe", 10, 5), file("a.exe", 10, 5)]);
		assert.deepEqual(
			result.rejections.map((rejection) => rejection.reason),
			["type", "type"],
		);
	});

	it("fills the free slots in order and reports the rest as one count rejection", () => {
		const existing = [file("e1.txt")];
		const a = file("a.txt");
		const b = file("b.txt");
		const c = file("c.txt");
		const d = file("d.txt");
		const result = check([a, b, c, d], existing);
		assert.deepEqual(result.accepted, [a, b]);
		assert.deepEqual(result.rejections, [
			{ reason: "count", fileName: null, message: "You can attach at most 3 files." },
		]);
	});

	it("accepts exactly up to the limit and refuses everything when full", () => {
		const existing = [file("e1.txt"), file("e2.txt")];
		assert.equal(check([file("a.txt")], existing).rejections.length, 0);
		const full = [...existing, file("e3.txt")];
		const result = check([file("a.txt")], full);
		assert.deepEqual(result.accepted, []);
		assert.equal(result.rejections[0]?.reason, "count");
	});

	it("does not spend a slot on a refused file, and puts count last", () => {
		const a = file("a.txt");
		const b = file("b.txt");
		const c = file("c.txt");
		const d = file("d.txt");
		const result = check([file("bad.exe"), a, b, file("e.txt", 0), c, d]);
		assert.deepEqual(result.accepted, [a, b, c]);
		assert.deepEqual(
			result.rejections.map((rejection) => rejection.reason),
			["type", "empty", "count"],
		);
	});

	it("shows a sanitised name in the message but reports the real one", () => {
		const result = check([file("a‮.exe")]);
		assert.equal(result.rejections[0]?.fileName, "a‮.exe");
		assert.equal(result.rejections[0]?.message, "a.exe is not a supported file type.");
	});

	it("translates through the function it is given", () => {
		const shout = (source: string, replace?: readonly string[]): string =>
			substitute(source.toUpperCase(), replace);
		const result = validateFiles([file("a.exe")], [], LIMITS, shout, "en");
		assert.equal(result.rejections[0]?.message, "a.exe IS NOT A SUPPORTED FILE TYPE.");
	});

	it("handles no files", () => {
		assert.deepEqual(check([]), { accepted: [], rejections: [] });
	});
});

describe("summarizeRejections", () => {
	const rejection = (
		reason: FileRejection["reason"],
		fileName: string | null,
		message = `${fileName ?? "?"} refused.`,
	): FileRejection => ({ reason, fileName, message });
	const summarize = (rejections: FileRejection[], limits: UploadLimits = LIMITS) =>
		summarizeRejections(rejections, limits, identity, "en");

	it("is null for no rejections", () => {
		assert.equal(summarize([]), null);
	});

	it("uses a lone rejection's own sentence", () => {
		assert.deepEqual(summarize([rejection("size", "big.txt", "big.txt is larger than the 1,000 B limit.")]), {
			title: "Files not attached",
			description: "big.txt is larger than the 1,000 B limit.",
		});
	});

	it("lists the supported types after a lone type rejection", () => {
		assert.equal(
			summarize([rejection("type", "a.exe", "a.exe is not a supported file type.")])?.description,
			"a.exe is not a supported file type. Supported types: csv, pdf, txt.",
		);
	});

	it("groups several rejections by reason in first-seen order", () => {
		assert.deepEqual(
			summarize([
				rejection("size", "huge.txt"),
				rejection("type", "a.exe"),
				rejection("empty", "b.txt"),
				rejection("type", "noext"),
			]),
			{
				title: "Files not attached",
				description:
					"Too large (over 1,000 B): huge.txt. Not a supported file type: a.exe, noext. Empty: b.txt.",
			},
		);
	});

	it("formats the size limit for the locale", () => {
		const limits = { ...LIMITS, maxFileBytes: 1536 };
		const description = summarizeRejections(
			[rejection("size", "a.txt"), rejection("size", "b.txt")],
			limits,
			identity,
			"de",
		)?.description;
		assert.equal(description, "Too large (over 1,5 KB): a.txt, b.txt.");
	});

	it("words each file reason", () => {
		assert.equal(
			summarize([rejection("duplicate", "a.txt"), rejection("name", "n.txt")])?.description,
			"Already attached: a.txt. Name longer than 140 characters: n.txt.",
		);
	});

	it("lists the supported types once, for type rejections only", () => {
		assert.equal(
			summarize([rejection("type", "a.exe"), rejection("type", "b.exe")])?.description,
			"Not a supported file type: a.exe, b.exe. Supported types: csv, pdf, txt.",
		);
	});

	it("drops the supported types when another reason is present", () => {
		const description = summarize([rejection("type", "a.exe"), rejection("empty", "b.txt")])?.description;
		assert.equal(description, "Not a supported file type: a.exe. Empty: b.txt.");
	});

	it("cuts a long list to three names and a count of the rest", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}.exe`);
		assert.equal(
			summarize(names.map((name) => rejection("type", name)))?.description,
			"Not a supported file type: a.exe, b.exe, c.exe, +3 more. Supported types: csv, pdf, txt.",
		);
		const three = names.slice(0, 3).map((name) => rejection("empty", name));
		assert.equal(summarize(three)?.description, "Empty: a.exe, b.exe, c.exe.");
	});

	it("shows each distinct name once, sanitised", () => {
		const description = summarize([
			rejection("empty", "a.txt"),
			rejection("empty", "a.txt"),
			rejection("empty", "b\u202E.txt"),
		])?.description;
		assert.equal(description, "Empty: a.txt, b.txt.");
	});

	it("keeps the message of a rejection that names no file", () => {
		assert.equal(
			summarize([
				rejection("type", "a.exe"),
				rejection("count", null, "You can attach at most 3 files."),
				rejection("count", null, "You can attach at most 3 files."),
			])?.description,
			"Not a supported file type: a.exe. You can attach at most 3 files.",
		);
	});

	it("adds nothing for approval or unavailable refusals", () => {
		assert.deepEqual(summarize([rejection("approval", null, "Answer first.")]), {
			title: "Files not attached",
			description: "Answer first.",
		});
	});
});

describe("summarizeFailures", () => {
	it("is null when nothing failed", () => {
		assert.equal(summarizeFailures([], identity), null);
		assert.equal(summarizeFailures([upload("a"), upload("b", { status: "complete" })], identity), null);
	});

	it("names the distinct reasons in first-seen order, each a sentence, then the remedy", () => {
		const summary = summarizeFailures(
			[
				upload("a", { status: "error", errorMessage: "No readable text found in this file." }),
				upload("b", { status: "complete" }),
				upload("c", { status: "error", errorMessage: "Upload failed (500)" }),
				upload("d", { status: "error", errorMessage: "No readable text found in this file." }),
			],
			identity,
		);
		assert.deepEqual(summary, {
			title: "File upload error",
			description:
				"No readable text found in this file. Upload failed (500). Remove the attachment and try again.",
		});
	});

	it("leaves sentence-final punctuation alone and merges a reason that differs only by its period", () => {
		const summary = summarizeFailures(
			[
				upload("a", { status: "error", errorMessage: "File is not a zip file" }),
				upload("b", { status: "error", errorMessage: "File is not a zip file." }),
				upload("c", { status: "error", errorMessage: "Is it a PDF?" }),
				upload("d", { status: "error", errorMessage: "Not readable!" }),
				upload("e", { status: "error", errorMessage: "\u8aad\u3081\u307e\u305b\u3093\u3002" }),
			],
			identity,
		);
		assert.equal(
			summary?.description,
			"File is not a zip file. Is it a PDF? Not readable! \u8aad\u3081\u307e\u305b\u3093\u3002 Remove the attachment and try again.",
		);
	});

	it("skips a missing or blank reason", () => {
		const summary = summarizeFailures(
			[
				upload("a", { status: "error" }),
				upload("b", { status: "error", errorMessage: "" }),
				upload("c", { status: "error", errorMessage: "  " }),
			],
			identity,
		);
		assert.equal(summary?.description, "Remove the attachment and try again.");
	});
});

describe("transferProgress", () => {
	it("is null when nothing is transferring", () => {
		assert.equal(transferProgress([]), null);
		assert.equal(transferProgress([upload("a", { status: "complete" })]), null);
		assert.equal(transferProgress([upload("a", { status: "error" })]), null);
		// every byte sent, flow is reading the file
		assert.equal(transferProgress([upload("a", { progress: 1 })]), null);
	});

	it("weights each file by its size", () => {
		const small = upload("a", { file: file("a.txt", 100), progress: 1 });
		const half = upload("b", { file: file("b.txt", 300), progress: 0.5 });
		const none = upload("c", { file: file("c.txt", 100), progress: 0 });
		// the finished-sending upload does not count: (0.5 * 300 + 0 * 100) / 400
		assert.equal(transferProgress([small, half, none]), 0.375);
	});

	it("reads a missing progress as 0 and a zero-byte file as one byte", () => {
		const bare: PendingUpload = { id: "x", file: file("x.txt", 0), status: "uploading" };
		assert.equal(transferProgress([bare]), 0);
		assert.equal(transferProgress([{ ...bare, progress: 0.5 }]), 0.5);
	});

	it("ignores uploads that are not uploading", () => {
		const live = upload("a", { file: file("a.txt", 10), progress: 0.2 });
		const done = upload("b", { file: file("b.txt", 1000), status: "complete" });
		assert.equal(transferProgress([live, done]), 0.2);
	});

	it("stays within 0 and 1", () => {
		assert.equal(transferProgress([upload("a", { progress: -3 })]), 0);
		assert.ok((transferProgress([upload("a", { progress: 0.999 })]) ?? 2) <= 1);
	});
});

describe("referenceFor", () => {
	const uploaded: UploadedFile = { name: "abc123", fileName: "ignored.txt", fileUrl: null, fileSize: 99 };
	const attached: AttachedFile = { file: "abc123", fileName: "Report.txt", fileSize: 42 };

	it("names the File doc and takes name and size from flow", () => {
		const ref = referenceFor(attached, uploaded, new File(["12345"], "Report.txt"));
		assert.deepEqual(ref, { type: "reference", id: "abc123", name: "Report.txt", size: 42 });
		assert.equal("url" in ref, false);
		assert.equal("mime_type" in ref, false);
	});

	it("falls back to the file's own size when flow sent none", () => {
		const ref = referenceFor({ ...attached, fileSize: 0 }, uploaded, new File(["12345"], "Report.txt"));
		assert.equal(ref.size, 5);
	});

	it("carries the mime type only when the browser knew it", () => {
		const typed = new File(["1"], "Report.txt", { type: "text/plain" });
		assert.equal(referenceFor(attached, uploaded, typed).mime_type, "text/plain");
	});
});

describe("file fields", () => {
	it("derives the field id from the File doc", () => {
		assert.equal(fileFieldId("abc"), "file-abc");
	});

	it("labels a field with the name when there is one", () => {
		assert.deepEqual(fileFieldFor(reference("abc", { name: "A.txt" })), {
			id: "file-abc",
			type: "file",
			label: "A.txt",
			value: reference("abc", { name: "A.txt" }),
		});
		assert.equal("label" in fileFieldFor(reference("abc")), false);
	});

	it("fileFieldsOf takes the file fields of complete uploads in order", () => {
		const done = (id: string): PendingUpload =>
			upload(id, { status: "complete", contributedData: { fields: [fileFieldFor(reference(id))] } });
		const other: StructuredField = { id: "note", type: "text", value: "x" };
		const fields = fileFieldsOf([
			done("a"),
			upload("b"),
			upload("c", { status: "error", contributedData: { fields: [fileFieldFor(reference("c"))] } }),
			upload("d", { status: "complete", contributedData: { fields: [other, fileFieldFor(reference("d"))] } }),
			upload("e", { status: "complete" }),
			done("f"),
		]);
		assert.deepEqual(
			fields.map((field) => field.id),
			["file-a", "file-d", "file-f"],
		);
	});
});

describe("attachmentIdsOf", () => {
	it("returns the File docs of file fields with a reference, in order, once each", () => {
		const fields: StructuredField[] = [
			fileFieldFor(reference("b")),
			{ id: "x", type: "text", value: reference("nope") },
			{ id: "file-junk", type: "file", value: "junk" },
			{ id: "file-junk2", type: "file", value: { type: "reference", id: "" } },
			{ id: "file-junk3", type: "file", value: null },
			fileFieldFor(reference("a")),
			fileFieldFor(reference("b")),
		];
		assert.deepEqual(attachmentIdsOf(fields), ["b", "a"]);
	});

	it("is empty for no fields", () => {
		assert.deepEqual(attachmentIdsOf([]), []);
	});
});

describe("fileFieldsFromRows", () => {
	const row = (doc: string, extra: Partial<FlowSessionAttachmentRow> = {}): FlowSessionAttachmentRow => ({
		file: doc,
		...extra,
	});

	it("keeps the rows of one run in row order", () => {
		const fields = fileFieldsFromRows(
			[
				row("f1", { run: "R1", file_name: "one.txt", file_size: 10 }),
				row("f2", { run: "R2", file_name: "two.txt", file_size: 20 }),
				row("f3", { run: "R1", file_name: "three.txt", file_size: 30 }),
			],
			"R1",
		);
		assert.deepEqual(fields, [
			fileFieldFor({ type: "reference", id: "f1", name: "one.txt", size: 10 }),
			fileFieldFor({ type: "reference", id: "f3", name: "three.txt", size: 30 }),
		]);
	});

	it("adds name and size only when present", () => {
		const [field] = fileFieldsFromRows(
			[row("f1", { run: "R", file_name: "", file_size: null }), row("f2", { run: "R", file_name: null })],
			"R",
		);
		assert.deepEqual(field?.value, { type: "reference", id: "f1" });
		assert.equal("label" in (field ?? {}), false);
	});

	it("keeps a size of 0", () => {
		const [field] = fileFieldsFromRows([row("f1", { run: "R", file_size: 0 })], "R");
		assert.deepEqual(field?.value, { type: "reference", id: "f1", size: 0 });
	});

	it("is empty for a null run, a run with no rows, and rows with no run", () => {
		assert.deepEqual(fileFieldsFromRows([row("f1", { run: "R" })], null), []);
		assert.deepEqual(fileFieldsFromRows([row("f1", { run: "R" })], "OTHER"), []);
		assert.deepEqual(fileFieldsFromRows([row("f1"), row("f2", { run: null })], "R"), []);
		assert.deepEqual(fileFieldsFromRows([], "R"), []);
	});
});

describe("attachmentChipsOf", () => {
	it("is empty without input or fields", () => {
		assert.deepEqual(attachmentChipsOf(undefined), []);
		assert.deepEqual(attachmentChipsOf({ text: "hi" }), []);
		assert.deepEqual(attachmentChipsOf({ structured_data: { fields: [] } }), []);
	});

	it("maps each file reference to a chip, copying only what is present", () => {
		const input: MessageInput = {
			structured_data: {
				fields: [
					fileFieldFor(
						reference("a", { name: "A.txt", mime_type: "text/plain", url: "/private/files/A.txt" }),
					),
					fileFieldFor(reference("b")),
				],
			},
		};
		assert.deepEqual(attachmentChipsOf(input), [
			{ id: "a", name: "A.txt", mimeType: "text/plain", url: "/private/files/A.txt" },
			{ id: "b" },
		]);
	});

	it("skips other field types and hostile values without throwing", () => {
		const hostile: unknown = {
			structured_data: {
				fields: [
					null,
					"text",
					7,
					[],
					{ id: "t", type: "text", value: reference("no") },
					{ id: "f1", type: "file", value: [reference("no")] },
					{ id: "f2", type: "file", value: { type: "reference", id: 7 } },
					{ id: "f3", type: "file", value: { type: "reference", id: "x", name: 3 } },
					{ id: "f4", type: "file" },
					fileFieldFor(reference("ok", { name: "ok.txt" })),
				],
			},
		};
		assert.deepEqual(attachmentChipsOf(asInput(hostile)), [{ id: "ok", name: "ok.txt" }]);
		assert.deepEqual(attachmentChipsOf(asInput({ structured_data: { fields: "nope" } })), []);
		assert.deepEqual(attachmentChipsOf(asInput({ structured_data: null })), []);
	});
});

/** Hands a deliberately malformed message to a function typed for a good one, without a type assertion. */
function asInput(value: unknown): MessageInput {
	const input: MessageInput = {};
	Object.assign(input, value);
	return input;
}

describe("uploadChips", () => {
	it("maps the three statuses", () => {
		const a = upload("a");
		const b = upload("b", { status: "complete" });
		const c = upload("c", { status: "error", errorMessage: "No readable text found in this file." });
		const d = upload("d", { status: "error" });
		assert.deepEqual(uploadChips([a, b, c, d]), [
			{ id: "a", file: a.file, status: "uploading" },
			{ id: "b", file: b.file, status: "edit" },
			{
				id: "c",
				file: c.file,
				status: "edit",
				isError: true,
				errorMessage: "No readable text found in this file.",
			},
			{ id: "d", file: d.file, status: "edit", isError: true },
		]);
	});

	it("is empty for no uploads", () => {
		assert.deepEqual(uploadChips([]), []);
	});
});

describe("drag and paste rules", () => {
	it("a drag carries files exactly when it lists Files", () => {
		assert.equal(isFileDrag(["Files"]), true);
		assert.equal(isFileDrag(["text/plain", "Files"]), true);
		assert.equal(isFileDrag(["text/plain", "text/uri-list"]), false);
		assert.equal(isFileDrag([]), false);
	});

	it("a paste attaches when it has files and no html", () => {
		assert.equal(shouldAttachPaste(["Files"], 1), true);
		assert.equal(shouldAttachPaste(["Files", "text/plain"], 1), true);
		assert.equal(shouldAttachPaste(["Files", "text/html"], 1), false);
		assert.equal(shouldAttachPaste(["text/plain"], 0), false);
		assert.equal(shouldAttachPaste([], 0), false);
	});
});
