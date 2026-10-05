// Everything the views draw for attachments, in two builders: the composer's half (attach button,
// the chips of the files being uploaded, the progress strip, the refusal line, the drop overlay and the
// listeners for picking, dropping and pasting) and the half on a sent message (read-only chips).
//
// Composer markup. The panel appends `composerChildren` to the prompt-line shell and `dropOverlay` to
// `.cf-ai-body`; each child sets its own `slot`:
//
//   div.cf-ai-actions[slot=message-actions]
//     input.cf-ai-file-input[type=file][multiple][hidden][tabindex=-1][accept]   the picker, never shown
//     cds-icon-button.cf-ai-attach[kind=ghost][size=sm][data-action=attach]
//       svg[slot=icon]                                                            ICONS.attachment16
//       span[slot=tooltip-content]                                                "Attach files"
//   cds-aichat-file-uploads.cf-ai-uploads[slot=file-uploads]                      the chips
//   div.cf-ai-upload-status[slot=file-uploads][hidden]                            while any upload is in flight
//     div.cf-ai-upload-status__bar[role=progressbar][aria-valuemin=0][aria-valuemax=100][aria-label]
//       div.cf-ai-upload-status__fill                                             inline-size in percent
//     button.cds--btn.cds--btn--sm.cds--btn--ghost[data-action=cancel-uploads]    "Cancel"
//   div.cf-ai-attach-error[slot=field-messaging][hidden]
//     cds-aichat-error-message                                                    title + description
//
//   div.cf-ai-drop[hidden][aria-hidden=true]                                      over .cf-ai-body, pointer-events none
//     svg                                                                         ICONS.upload32
//     p.cf-ai-drop__text                                                          "Drop files to attach"
//
// The browser suite selects on these class names, attributes and strings; change one together with it.
import type { Announcer } from "../announce.ts";
import type { Controller } from "../controller.ts";
import { el, iconElement, syncChildren } from "../dom.ts";
import { createDragDepth } from "../drag_depth.ts";
import {
	EVENTS,
	TAGS,
	createErrorMessage,
	createFileUploadItem,
	createFileUploads,
	createIconButton,
	isFileRemoveDetail,
	isPromptChangeDetail,
	listenDetail,
} from "../elements.ts";
import type { FileUploadItemElement, PromptLineElement, PromptLineShellElement } from "../elements.ts";
import { ICONS } from "../icons.ts";
import type { Translate } from "../i18n.ts";
import type { ChatStore } from "../store.ts";
import type { PendingUpload } from "../types.ts";
import {
	acceptAttribute,
	displayName,
	isFileDrag,
	shouldAttachPaste,
	summarizeFailures,
	summarizeRejections,
	transferProgress,
	uploadChips,
} from "../uploads.ts";
import type { AttachmentChip, MessageSummary, UploadChip, UploadLimits } from "../uploads.ts";

/** Why the composer cannot take files right now; null when it can. */
export type AttachBlock = "approval" | "unavailable";

export interface AttachmentsDeps {
	translate: Translate;
	/** BCP 47 tag for file sizes in refusal messages. */
	locale: string;
	limits: UploadLimits;
	store: ChatStore;
	controller: Pick<Controller, "addFiles" | "removeFile">;
	/** The panel's announcer: refusals and upload reasons are read through it, assertively. */
	announcer: Announcer;
	/** `cds-aichat-shell.cf-ai-shell`: where drag events and the pasted-file listener are installed. */
	shell: HTMLElement;
	/** Gets `hasError` while a refusal or a failed upload is on show. */
	promptLineShell: PromptLineShellElement;
	/** Pastes are taken only when they land in this element; typing in it clears a refusal. */
	promptLine: PromptLineElement;
	/** The control that had focus (a chip's remove button, Cancel) is gone and the attach button is disabled. */
	focusInput(): void;
}

export interface Attachments {
	/** In DOM order: actions, uploads, upload status, attach error. */
	readonly composerChildren: readonly HTMLElement[];
	readonly dropOverlay: HTMLElement;
	/**
	 * The panel's answer to "can the composer take files?". A block disables the attach button and stops
	 * the drop overlay from showing; a drop or paste is still handed to `controller.addFiles`, whose
	 * refusal is what the user reads.
	 */
	setBlocked(block: AttachBlock | null): void;
	/** Hide the refusal line (the panel calls it when a message is sent and on a new chat). Upload failures stay. */
	clearRefusal(): void;
	/** Removes the listeners and the subscriptions. The panel removes the elements with the shell. */
	dispose(): void;
}

/** Above this an image chip gets no thumbnail; see `chipFile`. */
export const THUMBNAIL_MAX_BYTES = 512 * 1024;

const untyped = new WeakMap<File, File>();

/**
 * The File the list is given for a chip. Carbon draws a 36px <img> from the object URL of any file typed
 * `image/*`, and Chromium decodes the whole bitmap for it and keeps it while the chip is staged: five phone
 * photos cost about 300 MB of renderer memory, which the size limit does not bound (pixels do). A larger
 * image is handed over without its type, which draws the file-type icon. The copy shares the bytes and is
 * memoized so a chip keeps one File across renders.
 */
export function chipFile(file: File): File {
	if (!file.type.startsWith("image/") || file.size <= THUMBNAIL_MAX_BYTES) return file;
	let copy = untyped.get(file);
	if (copy === undefined) {
		copy = new File([file], file.name);
		untyped.set(file, copy);
	}
	return copy;
}

/** Chips that look alike to the list: progress is not among them, so a byte count never re-renders a chip. */
function sameChips(a: readonly UploadChip[], b: readonly UploadChip[]): boolean {
	return (
		a.length === b.length &&
		a.every((chip, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				chip.id === other.id &&
				chip.file === other.file &&
				chip.status === other.status &&
				chip.isError === other.isError &&
				chip.errorMessage === other.errorMessage
			);
		})
	);
}

export function createAttachments(deps: AttachmentsDeps): Attachments {
	const __ = deps.translate;
	const { store, controller, announcer, shell, promptLineShell } = deps;
	const cleanups: (() => void)[] = [];
	let blocked: AttachBlock | null = null;
	let refusal: MessageSummary | null = null;

	// -- the attach button and its picker -----------------------------------------

	const actions = el("div", "cf-ai-actions");
	actions.slot = "message-actions";
	const input = el("input", "cf-ai-file-input");
	input.type = "file";
	input.multiple = true;
	input.accept = acceptAttribute(deps.limits);
	// Only the button opens it: a hidden input must not be a second tab stop.
	input.hidden = true;
	input.tabIndex = -1;

	const attach = createIconButton();
	attach.className = "cf-ai-attach";
	attach.kind = "ghost";
	attach.size = "sm";
	attach.align = "top-start";
	attach.dataset["action"] = "attach";
	const glyph = iconElement(ICONS.attachment16);
	glyph.setAttribute("slot", "icon");
	const tooltip = el("span", "", __("Attach files"));
	tooltip.slot = "tooltip-content";
	attach.append(glyph, tooltip);
	actions.append(input, attach);

	function focusAfterRemoval(): void {
		if (attach.disabled) deps.focusInput();
		else attach.focus();
	}

	const onAttachClick = (): void => input.click();
	const onPick = (): void => {
		// `files` is live: clearing the value empties it, so it is copied first. Clearing lets the same
		// file be picked again, which would otherwise raise no `change`.
		const picked = Array.from(input.files ?? []);
		input.value = "";
		handleFiles(picked);
	};
	attach.addEventListener("click", onAttachClick);
	input.addEventListener("change", onPick);
	cleanups.push(
		() => attach.removeEventListener("click", onAttachClick),
		() => input.removeEventListener("change", onPick),
	);

	// -- the chips -----------------------------------------------------------------

	const fileUploads = createFileUploads();
	fileUploads.className = "cf-ai-uploads";
	fileUploads.slot = "file-uploads";
	// Carbon 1.11.0 names every remove button alike: there is no per-file label to give.
	fileUploads.removeFileLabel = __("Remove file");
	fileUploads.uploadingFileLabel = __("Uploading file");
	fileUploads.fileRemovedLabel = __("File removed.");
	fileUploads.uploadSuccessLabel = __("The file was uploaded successfully.");
	fileUploads.uploadFailureLabel = __("There was an error uploading the file.");
	fileUploads.getFilesAddedText = ({ count }) =>
		count === 1 ? __("File added.") : __("{0} files added.", [String(count)]);
	fileUploads.getFilesUploadingText = ({ count }) =>
		count === 1 ? __("Uploading file.") : __("Uploading {0} files.", [String(count)]);

	cleanups.push(
		listenDetail(fileUploads, EVENTS.fileRemove, isFileRemoveDetail, (detail) => {
			controller.removeFile(detail.fileId);
			focusAfterRemoval();
		}),
	);

	// -- the strip under the chips -------------------------------------------------

	// Carbon's `uploading` chip has no remove button, so this is the only way to stop one.
	const status = el("div", "cf-ai-upload-status");
	status.slot = "file-uploads";
	status.hidden = true;
	const bar = el("div", "cf-ai-upload-status__bar");
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	bar.setAttribute("aria-label", __("Uploading files"));
	const fill = el("div", "cf-ai-upload-status__fill");
	bar.append(fill);
	const cancel = el("button", "cds--btn cds--btn--sm cds--btn--ghost", __("Cancel"));
	cancel.type = "button";
	cancel.dataset["action"] = "cancel-uploads";
	cancel.setAttribute("aria-label", __("Cancel uploading files"));
	status.append(bar, cancel);

	const onCancel = (): void => {
		for (const upload of store.get().pendingUploads) {
			if (upload.status === "uploading") controller.removeFile(upload.id);
		}
		announcer.announce(__("Upload cancelled."));
		focusAfterRemoval();
	};
	cancel.addEventListener("click", onCancel);
	cleanups.push(() => cancel.removeEventListener("click", onCancel));

	// -- the line under the editor -------------------------------------------------

	// No role="alert": the announcer says it, and a second live region would read it twice.
	const errorHost = el("div", "cf-ai-attach-error");
	errorHost.slot = "field-messaging";
	errorHost.hidden = true;
	const errorMessage = createErrorMessage();
	errorHost.append(errorMessage);

	let line: MessageSummary | null = null;
	function renderLine(uploads: readonly PendingUpload[]): void {
		const next = refusal ?? summarizeFailures(uploads, __);
		const same =
			next === null
				? line === null
				: line !== null && line.title === next.title && line.description === next.description;
		if (same) return;
		line = next;
		errorHost.hidden = next === null;
		if (next !== null) {
			errorMessage.title = next.title;
			errorMessage.description = next.description;
		}
		promptLineShell.hasError = next !== null;
	}

	function clearRefusal(): void {
		if (refusal === null) return;
		refusal = null;
		renderLine(store.get().pendingUploads);
	}

	// the user moved on: a refusal is about the last attempt, not about what they are typing
	cleanups.push(listenDetail(deps.promptLine, EVENTS.promptChange, isPromptChangeDetail, clearRefusal));

	// -- adding files --------------------------------------------------------------

	function handleFiles(files: readonly File[]): void {
		if (files.length === 0) return;
		const result = controller.addFiles(files);
		const summary = summarizeRejections(result.rejections, deps.limits, __, deps.locale);
		refusal = summary;
		renderLine(store.get().pendingUploads);
		if (summary !== null) announcer.announce(`${summary.title} ${summary.description}`.trim(), "assertive");
	}

	// -- store -> DOM --------------------------------------------------------------

	let shownChips: readonly UploadChip[] = [];
	let shownPercent: number | null | undefined;
	// Uploads whose failure was already read out. The list only says "there was an error".
	const reported = new Set<string>();

	function renderStrip(uploads: readonly PendingUpload[]): void {
		const inFlight = store.get().hasInFlightUploads;
		if (status.hidden === inFlight) status.hidden = !inFlight;
		const value = transferProgress(uploads);
		const percent = value === null ? null : Math.round(value * 100);
		if (percent === shownPercent) return;
		shownPercent = percent;
		bar.classList.toggle("cf-ai-upload-status__bar--indeterminate", percent === null);
		if (percent === null) {
			bar.removeAttribute("aria-valuenow");
			fill.style.removeProperty("inline-size");
		} else {
			bar.setAttribute("aria-valuenow", String(percent));
			fill.style.inlineSize = `${percent}%`;
		}
	}

	function announceFailures(uploads: readonly PendingUpload[]): void {
		const present = new Set<string>();
		for (const upload of uploads) {
			present.add(upload.id);
			if (upload.status !== "error" || reported.has(upload.id)) continue;
			reported.add(upload.id);
			announcer.announce(
				__("{0}: {1}", [displayName(upload.file.name), upload.errorMessage ?? ""]),
				"assertive",
			);
		}
		for (const id of reported) {
			if (!present.has(id)) reported.delete(id);
		}
	}

	// The list lays its chips out in a row that scrolls sideways, so a chip that fails past the edge is
	// invisible and it is the one the user has to remove. Each failure is brought into view once.
	const revealed = new Set<string>();
	let revealFrame = 0;

	function revealFailures(chips: readonly UploadChip[]): void {
		const present = new Set(chips.map((chip) => chip.id));
		for (const id of revealed) {
			if (!present.has(id)) revealed.delete(id);
		}
		const failed = chips.find((chip) => chip.isError && !revealed.has(chip.id));
		if (failed === undefined) return;
		revealed.add(failed.id);
		cancelAnimationFrame(revealFrame);
		// The chips are rendered by the list and each one again by its own element, which gives the chip
		// its final width; a frame after the list settles is when the scroll position can be computed.
		void fileUploads.updateComplete.then(() => {
			revealFrame = requestAnimationFrame(() => {
				const index = shownChips.findIndex((chip) => chip.id === failed.id);
				const items = fileUploads.shadowRoot?.querySelectorAll(TAGS.fileUploadItem);
				items?.[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
			});
		});
	}

	// Carbon stretches every chip to the tallest one, and a failed chip carries its reason under the name:
	// without this, one failure leaves a band of empty space under the others. The rule has to live in the
	// list's shadow root, out of reach of the page's stylesheets.
	let listStyled = false;
	function styleList(): void {
		const root = fileUploads.shadowRoot;
		if (listStyled || root === null) return;
		listStyled = true;
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(
			".cds-aichat--file-uploads-container { align-items: flex-start; " +
				"scrollbar-color: var(--cds-border-strong-01) var(--cds-layer-accent-01); }",
		);
		root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
	}

	function renderUploads(uploads: readonly PendingUpload[]): void {
		const chips = uploadChips(uploads);
		if (!sameChips(shownChips, chips)) {
			shownChips = chips;
			fileUploads.uploads = chips.map((chip) => ({ ...chip, file: chipFile(chip.file) }));
			styleList();
			revealFailures(chips);
		}
		renderStrip(uploads);
		announceFailures(uploads);
		renderLine(uploads);
	}

	// A failure that exists before the first render (none today) must not be announced as news.
	for (const upload of store.get().pendingUploads) {
		if (upload.status === "error") reported.add(upload.id);
	}
	renderUploads(store.get().pendingUploads);
	cleanups.push(store.select((state) => state.pendingUploads, renderUploads));

	// -- drag and drop -------------------------------------------------------------

	const overlay = el("div", "cf-ai-drop");
	overlay.hidden = true;
	overlay.setAttribute("aria-hidden", "true");
	overlay.append(iconElement(ICONS.upload32), el("p", "cf-ai-drop__text", __("Drop files to attach")));

	const drag = createDragDepth();
	function syncOverlay(): void {
		const dragging = drag.depth > 0 && blocked === null;
		overlay.hidden = !dragging;
		shell.classList.toggle("cf-ai-shell--dragging", dragging);
	}

	/**
	 * The transfer of a drag that carries files, after claiming the event; null for anything else, which is
	 * left entirely alone (a link or selected text dragged around the panel is not ours). Cancelling is what
	 * keeps the browser from opening a dropped file in place of the page.
	 */
	function claimFileDrag(event: DragEvent): DataTransfer | null {
		const transfer = event.dataTransfer;
		if (transfer === null || !isFileDrag(Array.from(transfer.types))) return null;
		event.preventDefault();
		event.stopPropagation();
		return transfer;
	}

	type DragType = "dragenter" | "dragover" | "dragleave" | "drop" | "dragend";
	const onDragEnter = (event: DragEvent): void => {
		if (claimFileDrag(event) === null) return;
		const started = drag.enter();
		syncOverlay();
		if (started && blocked === null) {
			announcer.announce(__("Drop files to attach them to your message."));
		}
	};
	const onDragOver = (event: DragEvent): void => {
		const transfer = claimFileDrag(event);
		if (transfer !== null) transfer.dropEffect = blocked === null ? "copy" : "none";
	};
	const onDragLeave = (event: DragEvent): void => {
		if (claimFileDrag(event) === null) return;
		drag.leave();
		syncOverlay();
	};
	const onDrop = (event: DragEvent): void => {
		const transfer = claimFileDrag(event);
		if (transfer === null) return;
		drag.reset();
		syncOverlay();
		handleFiles(Array.from(transfer.files));
	};
	// A drag that never reaches a drop target ends here, not with a leave.
	const onDragEnd = (): void => {
		drag.reset();
		syncOverlay();
	};
	const dragListeners: readonly (readonly [DragType, (event: DragEvent) => void])[] = [
		["dragenter", onDragEnter],
		["dragover", onDragOver],
		["dragleave", onDragLeave],
		["drop", onDrop],
		["dragend", onDragEnd],
	];
	for (const [type, listener] of dragListeners) {
		shell.addEventListener(type, listener);
		cleanups.push(() => shell.removeEventListener(type, listener));
	}

	// -- paste ---------------------------------------------------------------------

	// Capture phase, so the prompt line never sees a paste it should not turn into text. Only a paste into
	// the main prompt line counts: the approval card's textarea is not an attach target.
	const onPaste = (event: ClipboardEvent): void => {
		const data = event.clipboardData;
		if (data === null || !event.composedPath().includes(deps.promptLine)) return;
		if (!shouldAttachPaste(Array.from(data.types), data.files.length)) return;
		event.preventDefault();
		event.stopPropagation();
		handleFiles(Array.from(data.files));
	};
	shell.addEventListener("paste", onPaste, true);
	cleanups.push(() => shell.removeEventListener("paste", onPaste, true));

	return {
		composerChildren: [actions, fileUploads, status, errorHost],
		dropOverlay: overlay,
		setBlocked(block) {
			blocked = block;
			attach.disabled = block !== null;
			syncOverlay();
		},
		clearRefusal,
		dispose() {
			for (const cleanup of cleanups.splice(0)) cleanup();
			cancelAnimationFrame(revealFrame);
			drag.reset();
			syncOverlay();
		},
	};
}

export interface MessageFiles {
	/** `ul.cf-ai-message__files[role=list]`; empty and `hidden` while there are no chips. */
	readonly element: HTMLElement;
	/** Keyed by `AttachmentChip.id`: a chip already shown is reused, so a streaming update never rebuilds them. */
	update(chips: readonly AttachmentChip[]): void;
	dispose(): void;
}

export interface MessageFilesDeps {
	translate: Translate;
}

/** The read-only chips under a sent message's bubble: `li.cf-ai-message__file > cds-aichat-file-upload-item[read-only]`. */
export function createMessageFiles(deps: MessageFilesDeps): MessageFiles {
	const __ = deps.translate;
	// `role="list"` is spelled out: Safari drops a list's semantics (and its item count) once the CSS removes the bullets.
	const element = el("ul", "cf-ai-message__files");
	element.setAttribute("role", "list");
	element.setAttribute("aria-label", __("Attachments"));
	element.hidden = true;

	interface Shown {
		readonly item: HTMLElement;
		readonly upload: FileUploadItemElement;
		readonly chip: AttachmentChip;
	}
	const shown = new Map<string, Shown>();

	return {
		element,
		update(chips) {
			const live = new Map<string, Shown>();
			const ordered: HTMLElement[] = [];
			chips.forEach((chip, index) => {
				// the same File doc listed twice would collide; the suffix keeps both on show
				const key = live.has(chip.id) ? `${chip.id}~${index}` : chip.id;
				const previous = shown.get(key);
				const unchanged =
					previous !== undefined &&
					previous.chip.name === chip.name &&
					previous.chip.mimeType === chip.mimeType &&
					previous.chip.url === chip.url;
				if (previous !== undefined && unchanged) {
					live.set(key, previous);
					ordered.push(previous.item);
					return;
				}
				let item = previous?.item;
				let upload = previous?.upload;
				if (item === undefined || upload === undefined) {
					item = el("li", "cf-ai-message__file");
					item.dataset["fileId"] = chip.id;
					upload = createFileUploadItem();
					upload.className = "cf-ai-file";
					upload.readOnly = true;
					upload.fallbackLabel = __("Attachment");
					item.append(upload);
				}
				upload.upload = chip;
				live.set(key, { item, upload, chip });
				ordered.push(item);
			});
			shown.clear();
			for (const [key, entry] of live) shown.set(key, entry);
			syncChildren(element, ordered);
			element.hidden = ordered.length === 0;
		},
		dispose() {
			shown.clear();
			element.replaceChildren();
		},
	};
}
