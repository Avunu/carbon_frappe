// The rules for attaching files, with no DOM and no network: what may be attached, how a refusal
// is worded, and how a file travels between the composer's pending list, the request's
// `structured_data`, flow's `attachments` argument and the chips the views draw. Kept pure so
// node:test covers every rule; the controller calls it and the views read its results.
//
// Ground truth for the limits is flow, not this file: the types are `FILE_EXTENSIONS` in
// flow/knowledge/extract.py (boot key `flow_supported_file_types`, checked against the NAME's extension
// only), the size is frappe's `max_file_size` (`frappe.boot.max_file_size`, enforced by
// `upload_file`), and flow has no count limit at all, so `MAX_ATTACHMENTS` is ours.
import type { AttachedFile, UploadedFile } from "./flow/client.ts";
import type { FlowSessionAttachmentRow } from "./flow/docs.ts";
import type { Translate } from "./i18n.ts";
import { isExternalFileReference, isRecord } from "./types.ts";
import type { ExternalFileReference, MessageInput, PendingUpload, StructuredField } from "./types.ts";

/**
 * Files one message may carry. Every inline file is appended to its turn's prompt in full and
 * re-sent on every later turn, clamped to what is left of the context window, so a long list
 * squeezes the conversation out; five is a judgement, not a flow limit.
 */
export const MAX_ATTACHMENTS = 5;

/**
 * Longest file name, in characters, that is attached. The server stores a private upload under the
 * name it was given and has been seen to refuse very long ones; 140 is a judgement well inside what
 * every file system takes, not a limit flow states.
 */
export const MAX_FILE_NAME_CHARS = 140;

/** frappe's own client fallback when `frappe.boot.max_file_size` is missing (request.js). */
export const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface UploadLimits {
	/** Lower case, no dot, sorted: `["csv", "docx", "pdf", ...]`. Never empty. */
	readonly extensions: readonly string[];
	/** A file of exactly this many bytes is accepted; one byte more is not. */
	readonly maxFileBytes: number;
	readonly maxFiles: number;
}

/**
 * The limits from `frappe.boot`, or null when attaching is not available: flow did not send
 * `flow_supported_file_types` (an older flow, or none of its boot hook), or the list is empty or not
 * a list of strings. A null result hides every attach affordance. Entries are lower-cased, stripped of a
 * leading dot, kept only when they are `[a-z0-9]+`, de-duplicated and sorted. `max_file_size` must be a
 * positive finite number, else `FALLBACK_MAX_FILE_BYTES`. `boot` is `unknown` because neither key is
 * declared in frappe-types for flow's list.
 */
export function readUploadLimits(boot: unknown): UploadLimits | null {
	if (typeof boot !== "object" || boot === null) return null;
	const listed: unknown = Reflect.get(boot, "flow_supported_file_types");
	if (!Array.isArray(listed)) return null;
	const found = new Set<string>();
	for (const entry of listed) {
		if (typeof entry !== "string") continue;
		const extension = entry.trim().replace(/^\./, "").toLowerCase();
		if (/^[a-z0-9]+$/.test(extension)) found.add(extension);
	}
	if (found.size === 0) return null;
	const size: unknown = Reflect.get(boot, "max_file_size");
	const maxFileBytes =
		typeof size === "number" && Number.isFinite(size) && size > 0 ? size : FALLBACK_MAX_FILE_BYTES;
	return { extensions: [...found].sort(), maxFileBytes, maxFiles: MAX_ATTACHMENTS };
}

/**
 * `"Report.PDF"` is `"pdf"`; a name with no dot, or ending in one, is `""`. Only the last dot counts, and
 * leading dots do not (`".bashrc"` has no extension): the same reading as Python's `os.path.splitext`, which
 * is what flow checks the name with, so the browser and the server never disagree about a file.
 */
export function extensionOf(fileName: string): string {
	const base = fileName.replace(/^\.+/, "");
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The hidden file input's `accept`: `".csv,.docx,.pdf"`. */
export function acceptAttribute(limits: UploadLimits): string {
	return limits.extensions.map((extension) => `.${extension}`).join(",");
}

/**
 * `"1.5 MB"`, `"340 KB"`, `"12 B"`: binary units, one decimal under 10 and none from 10 up, the
 * number formatted for `locale` (a malformed tag falls back to English). The unit symbols are not translated.
 */
export function formatFileSize(bytes: number, locale: string): string {
	const units = ["B", "KB", "MB", "GB"];
	const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	let unit = 0;
	while (unit < units.length - 1 && size / 1024 ** (unit + 1) >= 1) unit += 1;
	let value = size / 1024 ** unit;
	// 1023.96 KB rounds to "1024 KB"; the next unit reads better.
	if (unit > 0 && unit < units.length - 1 && Number(value.toFixed(value < 10 ? 1 : 0)) >= 1024) {
		unit += 1;
		value = size / 1024 ** unit;
	}
	const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
	return `${numberFormat(locale, digits).format(value)} ${units[unit]}`;
}

function numberFormat(locale: string, maximumFractionDigits: number): Intl.NumberFormat {
	try {
		return new Intl.NumberFormat(locale, { maximumFractionDigits });
	} catch {
		// A malformed tag throws a RangeError; the size is still worth showing.
		return new Intl.NumberFormat("en", { maximumFractionDigits });
	}
}

const DISPLAY_NAME_MAX = 80;

/**
 * A file name safe to put in a sentence. A name is whatever the user's file system allows: control
 * characters and the bidirectional overrides (which can make `gnp.exe` read as `exe.png`) are dropped,
 * runs of white space collapse, and a very long name keeps its start and its extension around an ellipsis.
 */
export function displayName(fileName: string): string {
	const cleaned = fileName
		.replace(/[\p{Cc}\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(cleaned);
	if (characters.length <= DISPLAY_NAME_MAX) return cleaned;
	const extension = extensionOf(cleaned);
	const tail = extension === "" || extension.length > 12 ? "" : `.${extension}`;
	return `${characters.slice(0, DISPLAY_NAME_MAX - 1 - tail.length).join("")}\u2026${tail}`;
}

// -- validation ---------------------------------------------------------------

/**
 * Why a file was not accepted. `type`, `size`, `empty`, `duplicate`, `name` and `count` come from
 * `validateFiles`; `approval` and `unavailable` are the controller's, when the composer cannot take
 * files at all right now.
 */
export type FileRejectionReason =
	| "type"
	| "size"
	| "empty"
	| "duplicate"
	| "name"
	| "count"
	| "approval"
	| "unavailable";

export interface FileRejection {
	reason: FileRejectionReason;
	/** The file that was refused; null for `count` (one entry covers the whole overflow), `approval` and `unavailable`. */
	fileName: string | null;
	/** One translated sentence naming the file and the rule it broke. */
	message: string;
}

export interface ValidatedFiles {
	/** In selection order. */
	accepted: File[];
	/** In selection order, `count` last. */
	rejections: FileRejection[];
}

/**
 * Checks `files` against `limits`, in this order per file: `duplicate` (same name, size and
 * `lastModified` as a file in `existing` or earlier in this batch), `empty` (0 bytes), `type` (extension
 * not in `limits.extensions`; a name with no extension is a type error), `size` (above `maxFileBytes`),
 * `name` (more than `MAX_FILE_NAME_CHARS` characters, counted as code points). Paste, drop and the picker
 * all come through here, so one rule covers them.
 * Then `count`: a file that passed the five checks above is accepted only while
 * `existing.length + accepted.length < limits.maxFiles`; the rest are one `count` rejection, so the
 * message says what is wrong with a file before it says there are too many. `existing` is every pending
 * upload's file, failed ones included (a failed chip still takes its slot until removed).
 */
export function validateFiles(
	files: readonly File[],
	existing: readonly File[],
	limits: UploadLimits,
	translate: Translate,
	locale: string,
): ValidatedFiles {
	// Frappe's string extractor greps for `__("...")`, so the literals below keep that spelling.
	const __ = translate;
	const seen = new Set(existing.map(fileKey));
	const rejections: FileRejection[] = [];
	const passed: File[] = [];
	for (const file of files) {
		const name = displayName(file.name);
		const key = fileKey(file);
		const reject = (reason: FileRejectionReason, message: string): void => {
			rejections.push({ reason, fileName: file.name, message });
		};
		if (seen.has(key)) reject("duplicate", __("{0} is already attached.", [name]));
		else if (file.size === 0) reject("empty", __("{0} is empty.", [name]));
		else if (!limits.extensions.includes(extensionOf(file.name))) {
			reject("type", __("{0} is not a supported file type.", [name]));
		} else if (file.size > limits.maxFileBytes) {
			reject(
				"size",
				__("{0} is larger than the {1} limit.", [name, formatFileSize(limits.maxFileBytes, locale)]),
			);
		} else if (Array.from(file.name).length > MAX_FILE_NAME_CHARS) {
			reject(
				"name",
				__("{0} has a name longer than {1} characters. Rename the file and try again.", [
					name,
					String(MAX_FILE_NAME_CHARS),
				]),
			);
		} else {
			// Only a file that passes holds its key: a refused copy must not make its twin read "already attached".
			seen.add(key);
			passed.push(file);
		}
	}
	const free = Math.max(0, limits.maxFiles - existing.length);
	const accepted = passed.slice(0, free);
	if (passed.length > free) {
		rejections.push({
			reason: "count",
			fileName: null,
			message: __("You can attach at most {0} files.", [String(limits.maxFiles)]),
		});
	}
	return { accepted, rejections };
}

function fileKey(file: File): string {
	return JSON.stringify([file.name, file.size, file.lastModified]);
}

export interface MessageSummary {
	title: string;
	/** May be empty. */
	description: string;
}

/** Names listed per reason before "+N more": the error line sits in a shadow root that clips it at a few lines. */
const LISTED_NAMES = 3;

/**
 * The text of the composer's error line after a refusal: title `__("Files not attached")`. A lone
 * rejection's description is its own sentence. Several are grouped by reason in first-seen order, one
 * sentence each (`Not a supported file type: a.exe, noext.`), the names sanitised by `displayName`,
 * de-duplicated and cut to three followed by `+N more`; a rejection with no file (`count`, `approval`,
 * `unavailable`) keeps its message. `Supported types: {0}.` (the extensions, comma separated) is added once,
 * and only when every rejection is a `type` one: with a second reason in play the line is already long and
 * the list is the least useful part. Null for no rejections.
 */
export function summarizeRejections(
	rejections: readonly FileRejection[],
	limits: UploadLimits,
	translate: Translate,
	locale: string,
): MessageSummary | null {
	const __ = translate;
	if (rejections.length === 0) return null;
	const parts =
		rejections.length === 1
			? rejections.map((rejection) => rejection.message)
			: groupedSentences(rejections, limits, __, locale);
	if (rejections.every((rejection) => rejection.reason === "type")) {
		parts.push(__("Supported types: {0}.", [limits.extensions.join(", ")]));
	}
	return { title: __("Files not attached"), description: parts.join(" ") };
}

function groupedSentences(
	rejections: readonly FileRejection[],
	limits: UploadLimits,
	translate: Translate,
	locale: string,
): string[] {
	// Frappe's string extractor greps for `__("...")`, so the literals below keep that spelling.
	const __ = translate;
	const groups = new Map<FileRejectionReason, { names: string[]; messages: Set<string> }>();
	for (const rejection of rejections) {
		let group = groups.get(rejection.reason);
		if (group === undefined) {
			group = { names: [], messages: new Set() };
			groups.set(rejection.reason, group);
		}
		group.messages.add(rejection.message);
		if (rejection.fileName === null) continue;
		const shown = displayName(rejection.fileName);
		if (!group.names.includes(shown)) group.names.push(shown);
	}
	const sentences: string[] = [];
	for (const [reason, { names, messages }] of groups) {
		const listed = names.slice(0, LISTED_NAMES);
		if (names.length > listed.length) listed.push(__("+{0} more", [String(names.length - listed.length)]));
		const list = listed.join(", ");
		if (names.length === 0) sentences.push(...messages);
		else if (reason === "type") sentences.push(__("Not a supported file type: {0}.", [list]));
		else if (reason === "size") {
			const limit = formatFileSize(limits.maxFileBytes, locale);
			sentences.push(__("Too large (over {0}): {1}.", [limit, list]));
		} else if (reason === "empty") sentences.push(__("Empty: {0}.", [list]));
		else if (reason === "duplicate") sentences.push(__("Already attached: {0}.", [list]));
		else if (reason === "name") {
			sentences.push(__("Name longer than {0} characters: {1}.", [String(MAX_FILE_NAME_CHARS), list]));
		} else sentences.push(...messages);
	}
	return sentences;
}

/**
 * The composer's error line while uploads have failed: title `__("File upload error")`, description the
 * distinct `errorMessage`s of the failed uploads, each ended with a period when it has no sentence-final
 * punctuation (server texts and `Upload failed (500)` often lack one), joined by one space, then
 * `__("Remove the attachment and try again.")`. Null when none has failed. The reasons repeat what the
 * failed chips already say: the line is also what the assertive announcement reads, so it stays whole.
 */
export function summarizeFailures(
	uploads: readonly PendingUpload[],
	translate: Translate,
): MessageSummary | null {
	const __ = translate;
	const failed = uploads.filter((upload) => upload.status === "error");
	if (failed.length === 0) return null;
	const reasons = new Set<string>();
	for (const upload of failed) {
		const reason = upload.errorMessage?.trim() ?? "";
		if (reason !== "") reasons.add(/[.!?\u2026\u3002\uFF01\uFF1F]$/u.test(reason) ? reason : `${reason}.`);
	}
	return {
		title: __("File upload error"),
		description: [...reasons, __("Remove the attachment and try again.")].join(" "),
	};
}

/**
 * One 0 to 1 number for the strip under the chips: bytes sent over bytes to send, across the uploads that
 * are `uploading` with a `progress` below 1, each weighted by its file size. Null when none is in that phase
 * (nothing is transferring, or every upload has sent its last byte and flow is reading it): the strip then
 * shows an indeterminate bar, or no strip when nothing is in flight at all.
 */
export function transferProgress(uploads: readonly PendingUpload[]): number | null {
	let sent = 0;
	let total = 0;
	let transferring = false;
	for (const upload of uploads) {
		const progress = upload.progress ?? 0;
		if (upload.status !== "uploading" || progress >= 1) continue;
		transferring = true;
		// An empty file never reaches here (validation refuses it), but a zero weight would divide by nothing.
		const weight = Math.max(upload.file.size, 1);
		sent += Math.max(progress, 0) * weight;
		total += weight;
	}
	return transferring ? Math.min(Math.max(sent / total, 0), 1) : null;
}

// -- the file field -----------------------------------------------------------

/** The `id` of the structured field carrying a File doc. */
export function fileFieldId(fileDoc: string): string {
	return `file-${fileDoc}`;
}

/** The `file` field for a reference. `label` is the file name when there is one. */
export function fileFieldFor(reference: ExternalFileReference): StructuredField {
	const field: StructuredField = { id: fileFieldId(reference.id), type: "file", value: reference };
	if (reference.name !== undefined) field.label = reference.name;
	return field;
}

/**
 * The reference a finished upload becomes: `id` is the File doc (`uploaded.name`, which equals
 * `attached.file`), `name` and `size` come from flow's reply (`attached.fileName`, `attached.fileSize`),
 * falling back to `file.name` / `file.size` when flow sent no size (0); `mime_type` is `file.type` when
 * the browser knew it. No `url`: a sent chip must look the same live and restored, and the restored rows
 * have none, so no sent chip fetches the private file back to draw a thumbnail.
 */
export function referenceFor(
	attached: AttachedFile,
	uploaded: UploadedFile,
	file: File,
): ExternalFileReference {
	return {
		type: "reference",
		id: uploaded.name,
		name: attached.fileName,
		size: attached.fileSize > 0 ? attached.fileSize : file.size,
		...(file.type !== "" && { mime_type: file.type }),
	};
}

/** Every `file` field of the uploads that are `complete`, in upload order. */
export function fileFieldsOf(uploads: readonly PendingUpload[]): StructuredField[] {
	const fields: StructuredField[] = [];
	for (const upload of uploads) {
		if (upload.status !== "complete") continue;
		for (const field of upload.contributedData?.fields ?? []) {
			if (field.type === "file") fields.push(field);
		}
	}
	return fields;
}

/** The File doc names of the `file` fields whose value is a reference: what `start_run` takes as `attachments`. */
export function attachmentIdsOf(fields: readonly StructuredField[]): string[] {
	const ids = new Set<string>();
	for (const field of fields) {
		if (field.type === "file" && isExternalFileReference(field.value)) ids.add(field.value.id);
	}
	return [...ids];
}

/**
 * The `file` fields to put on a restored request: one per `Flow Session Attachment` row whose `run` is
 * `run`, in row order, as a reference with `name` = `file_name` and `size` = `file_size` when present
 * and no `url` or `mime_type`. Empty for a null `run` or no rows.
 */
export function fileFieldsFromRows(
	rows: readonly FlowSessionAttachmentRow[],
	run: string | null,
): StructuredField[] {
	if (run === null) return [];
	const fields: StructuredField[] = [];
	for (const row of rows) {
		if (row.run !== run) continue;
		fields.push(
			fileFieldFor({
				type: "reference",
				id: row.file,
				...(typeof row.file_name === "string" && row.file_name !== "" && { name: row.file_name }),
				...(typeof row.file_size === "number" && { size: row.file_size }),
			}),
		);
	}
	return fields;
}

// -- chips --------------------------------------------------------------------

/** `FileAttachment` of cds-aichat-file-upload-item, minus the live `File`: what a read-only chip is given. */
export interface AttachmentChip {
	id: string;
	name?: string;
	mimeType?: string;
	url?: string;
}

/**
 * The read-only chips of a sent request: one per `file` field whose value passes `isExternalFileReference`,
 * in field order. A field of another type, or whose value is anything else, is skipped. `id` is the
 * reference's `id`; `name`, `mimeType` (from `mime_type`) and `url` are copied only when present.
 */
export function attachmentChipsOf(input: MessageInput | undefined): AttachmentChip[] {
	// The data may come from anywhere a message can be built, so nothing about its shape is trusted.
	const fields: unknown = input?.structured_data?.fields;
	if (!Array.isArray(fields)) return [];
	const chips: AttachmentChip[] = [];
	for (const field of fields) {
		if (!isRecord(field) || field["type"] !== "file") continue;
		const reference: unknown = field["value"];
		if (!isExternalFileReference(reference)) continue;
		chips.push({
			id: reference.id,
			...(reference.name !== undefined && { name: reference.name }),
			...(reference.mime_type !== undefined && { mimeType: reference.mime_type }),
			...(reference.url !== undefined && { url: reference.url }),
		});
	}
	return chips;
}

/** `FileUpload` of cds-aichat-file-uploads, with the status as a string literal (the library types an enum). */
export interface UploadChip {
	id: string;
	file: File;
	/** `uploading` draws Carbon's spinner and no remove button; `edit` draws the remove button. */
	status: "uploading" | "edit";
	isError?: true;
	errorMessage?: string;
}

/**
 * The list `cds-aichat-file-uploads` shows, one chip per pending upload in order. `uploading` maps to
 * `uploading`; `complete` to `edit`; `error` to `edit` with `isError: true` and its `errorMessage`
 * (Carbon draws the invalid state and the reason, and the remove button stays so the user can clear it).
 */
export function uploadChips(uploads: readonly PendingUpload[]): UploadChip[] {
	return uploads.map((upload): UploadChip => {
		if (upload.status === "uploading") return { id: upload.id, file: upload.file, status: "uploading" };
		if (upload.status === "complete") return { id: upload.id, file: upload.file, status: "edit" };
		return {
			id: upload.id,
			file: upload.file,
			status: "edit",
			isError: true,
			...(upload.errorMessage !== undefined && { errorMessage: upload.errorMessage }),
		};
	});
}

// -- drag and paste -----------------------------------------------------------

/** A drag carries files exactly when `DataTransfer.types` lists `"Files"`; text and link drags do not. */
export function isFileDrag(types: readonly string[]): boolean {
	return types.includes("Files");
}

/**
 * Whether a paste should become attachments instead of text: the clipboard holds at least one file and no
 * `text/html`. A spreadsheet or document selection puts files (a picture of the cells) next to its html,
 * and the text must win there; a screenshot or a file copied in a file manager has no html, and some
 * platforms add the file's NAME as `text/plain`, which must not be pasted into the prompt.
 */
export function shouldAttachPaste(types: readonly string[], fileCount: number): boolean {
	return fileCount > 0 && !types.includes("text/html");
}
