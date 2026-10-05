// The typed surface of the <cds-aichat-*> elements the chat creates or reads.
//
// Each interface lists ONLY the properties this code touches, copied from the
// element's source in @carbon/ai-chat-components (the file is named per interface).
// They are local rather than imported because two of the packages' declarations do
// not typecheck (markdown, feedback: see the `paths` note in tsconfig.base.json), and
// because importing a class would pull its Lit internals into every type the views
// mention. A property listed here that the element stops exposing is caught at run
// time by the guards below, not by the compiler, so bump @carbon/ai-chat-components
// only with a pass over this file.
//
// Every factory narrows `document.createElement` with a type predicate that tests
// the properties exist. An element whose class never registered stays a bare
// HTMLElement with none of them, which is the failure this catches: the lazy chunk
// loaded but register.ts was not reached, or an element was renamed upstream.
import type { CarbonIcon } from "@carbon/web-components/es/globals/internal/icon-loader-utils.js";
import { isRecord } from "./types.ts";
import type { Translate } from "./i18n.ts";
import type { AttachmentChip, UploadChip } from "./uploads.ts";

export const TAGS = {
	shell: "cds-aichat-shell",
	chatHeader: "cds-aichat-chat-header",
	promptLineShell: "cds-aichat-prompt-line-shell",
	promptLine: "cds-aichat-prompt-line",
	sendControl: "cds-aichat-input-send-control",
	markdown: "cds-aichat-markdown",
	chainOfThought: "cds-aichat-chain-of-thought",
	chainOfThoughtToggle: "cds-aichat-chain-of-thought-toggle",
	chainOfThoughtStep: "cds-aichat-chain-of-thought-step",
	toolCallData: "cds-aichat-tool-call-data",
	feedbackButtons: "cds-aichat-feedback-buttons",
	feedback: "cds-aichat-feedback",
	processing: "cds-aichat-processing",
	codeSnippet: "cds-aichat-code-snippet",
	button: "cds-aichat-button",
	historyShell: "cds-aichat-history-shell",
	historyHeader: "cds-aichat-history-header",
	historyToolbar: "cds-aichat-history-toolbar",
	historyContent: "cds-aichat-history-content",
	historyLoading: "cds-aichat-history-loading",
	historyPanel: "cds-aichat-history-panel",
	historyPanelItems: "cds-aichat-history-panel-items",
	historyPanelMenu: "cds-aichat-history-panel-menu",
	historyPanelItem: "cds-aichat-history-panel-item",
	historyDeletePanel: "cds-aichat-history-delete-panel",
	fileUploads: "cds-aichat-file-uploads",
	fileUploadItem: "cds-aichat-file-upload-item",
	errorMessage: "cds-aichat-error-message",
	iconButton: "cds-icon-button",
} as const;

// -- element interfaces -------------------------------------------------------

/** chat-shell/src/shell.ts. Children go in light DOM slots: header, messages, input. */
export interface ShellElement extends HTMLElement {
	aiEnabled: boolean;
	cornerAll: "round" | "square";
	/** Names the `role="region"` the shell wraps around the messages and input slots. */
	messagesAriaLabel: string;
	/** Centres the messages and input slots in a column at most 672px wide: for the expanded panel. */
	contentMaxWidth: boolean;
}

/** One toolbar action of the chat header (toolbar/src/toolbar.ts `Action`). */
export interface HeaderAction {
	/** Becomes the icon button's tooltip, which is its accessible name. */
	text: string;
	icon: CarbonIcon;
	onClick?: () => void;
	/** Keep it out of the overflow menu. The header is built with `overflow` off, so all are. */
	fixed?: boolean;
	/**
	 * Two-state toggle. @carbon/ai-chat-components 1.11.0 ignores it (the toolbar renders `aria-pressed`
	 * from 1.12 on), so view/panel.ts also sets the attribute on the rendered button itself.
	 */
	isSelected?: boolean;
	/** Greys the button out and takes it out of the tab order. */
	disabled?: boolean;
	testId?: string;
}

/** chat-shell/src/chat-header.ts. Re-assign `actions` (a new array) to re-render. */
export interface ChatHeaderElement extends HTMLElement {
	headerTitle: string;
	actions: HeaderAction[];
	overflow: boolean;
	requestFocus(): boolean;
}

/** prompt-line/src/prompt-line-shell.ts. Slots: editor, send-control. */
export interface PromptLineShellElement extends HTMLElement {
	disabled: boolean;
	hasError: boolean;
	expanded: boolean;
}

/**
 * prompt-line/src/prompt-line.ts. A textarea in its LIGHT DOM (slot="editor"), never
 * replaced: do not touch its children.
 */
export interface PromptLineElement extends HTMLElement {
	disabled: boolean;
	placeholder: string;
	ariaLabel: string;
	getValue(): string;
	clearContent(): void;
	hasFocus(): boolean;
}

/** prompt-line/src/send-control.ts. Slotted into the shell's send-control slot. */
export interface SendControlElement extends HTMLElement {
	hasValidInput: boolean;
	disabled: boolean;
	/** Blocks sending without disabling the control, so the Stop button still works. */
	disableSend: boolean;
	/** Swaps the send button for the stop button. Attribute `show-stop-streaming`. */
	isStopStreamingButtonVisible: boolean;
	buttonLabel: string;
	stopResponseLabel: string;
}

/** The argument of a `customRenderers.codeBlock` callback (markdown-renderer-types.ts), minus the token. */
export interface CodeBlockArgs {
	/** The fence's info string; "" when unset. */
	language: string;
	/** May be incomplete while streaming. */
	code: string;
	isStreaming: boolean;
	/** Stable across renders while the block stays put; the key to cache the element under. */
	slotName: string;
}

export interface MarkdownRenderers {
	/** Return null to fall back to the default snippet. Return the SAME element for the same slot. */
	codeBlock?: (args: CodeBlockArgs) => HTMLElement | null;
	/** Attribute overrides for the `<img>` the element still renders; null keeps its defaults. */
	image?: (args: { src: string; alt?: string; title?: string }) => { src?: string } | null;
}

/**
 * markdown/src/markdown.ts. Setting `markdown` re-renders (the element throttles
 * itself to 100 ms and diffs the token tree), so set it on every delta.
 */
export interface MarkdownElement extends HTMLElement {
	markdown: string;
	/**
	 * Per-element render overrides. A `codeBlock` renderer returns an element that the
	 * markdown element adopts as a light-DOM child, in page scope, where the lazy
	 * stylesheet reaches it: the default snippet lives in markdown's shadow root and
	 * cannot be re-themed from outside (scss/ai_chat/_code-snippet-theme.scss).
	 */
	customRenderers: MarkdownRenderers | undefined;
	/** True while deltas are still arriving: holds a half-streamed table in a skeleton. */
	streaming: boolean;
	sanitizeHTML: boolean;
	removeHTML: boolean;
	codeSnippetShowLessText: string;
	codeSnippetShowMoreText: string;
	codeSnippetCopyButtonTooltipContent: string;
	codeSnippetAriaLabelReadOnly: string;
	tableFilterPlaceholderText: string;
	tablePreviousPageText: string;
	tableNextPageText: string;
	tableItemsPerPageText: string;
	tableDownloadLabelText: string;
	tableLocale: string;
}

export type StepStatus = "processing" | "failure" | "success";

/** chain-of-thought/src/chain-of-thought.ts: the collapsible list of steps. */
export interface ChainOfThoughtElement extends HTMLElement {
	open: boolean;
	/** Set by the element; hand it to the toggle's `panelId`. */
	panelId: string;
}

/**
 * chain-of-thought/src/chain-of-thought-toggle.ts. It flips its own `open` and fires
 * `chain-of-thought-toggle`; the caller copies the new state onto the list by hand.
 */
export interface ChainOfThoughtToggleElement extends HTMLElement {
	open: boolean;
	openLabelText: string;
	closedLabelText: string;
	panelId: string | undefined;
}

/** chain-of-thought/src/chain-of-thought-step.ts. Its default slot holds a tool-call-data. */
export interface ChainOfThoughtStepElement extends HTMLElement {
	title: string;
	stepNumber: number;
	labelText: string;
	status: StepStatus;
	open: boolean;
	statusSucceededLabelText: string;
	statusFailedLabelText: string;
	statusProcessingLabelText: string;
}

/**
 * chain-of-thought/src/tool-call-data.ts. Slots: description, input, output. A step
 * with no slotted content and no `toolName` has no body and cannot be expanded.
 */
export interface ToolCallDataElement extends HTMLElement {
	toolName: string;
	inputLabelText: string;
	outputLabelText: string;
	toolLabelText: string;
}

/** feedback/src/feedback-buttons.ts. */
export interface FeedbackButtonsElement extends HTMLElement {
	isPositiveSelected: boolean;
	isNegativeSelected: boolean;
	isPositiveOpen: boolean;
	isNegativeOpen: boolean;
	hasPositiveDetails: boolean;
	hasNegativeDetails: boolean;
	isPositiveDisabled: boolean;
	isNegativeDisabled: boolean;
	positiveLabel: string | undefined;
	negativeLabel: string | undefined;
	/** The id of the details panel; the buttons derive `aria-controls` from it. */
	panelID: string | undefined;
}

/** feedback/src/feedback.ts: the details panel (text box, submit, close). */
export interface FeedbackElement extends HTMLElement {
	isOpen: boolean;
	isReadonly: boolean;
	title: string;
	showTextArea: boolean;
	placeholder: string;
	maxLength: number | undefined;
}

/** processing/src/processing.ts: the three animated dots. */
export interface ProcessingElement extends HTMLElement {
	loop: boolean;
	quickLoad: boolean;
}

/** code-snippet/src/code-snippet.ts, used read-only. */
export interface CodeSnippetElement extends HTMLElement {
	code: string;
	language: string;
	highlight: boolean;
	hideHeader: boolean;
	copyButtonTooltipContent: string;
	showLessText: string;
	showMoreText: string;
	ariaLabelReadOnly: string;
	foldCollapseLabel: string;
	foldExpandLabel: string;
	/** The header's "N lines". Upstream's default is English and has no singular. */
	getLineCountText: (args: { count: number }) => string;
}

/** chat-button/src/chat-button.ts, which extends cds-button: kind/size/disabled are its. */
export interface ChatButtonElement extends HTMLElement {
	kind: string;
	size: string;
	disabled: boolean;
	isQuickAction: boolean;
}

/**
 * The cds-aichat-history-* family (chat-history/src). The shell, the panel-items container and the
 * loading skeleton have no property this code sets; their interfaces exist so a factory can return
 * a checked element.
 */
export interface HistoryShellElement extends HTMLElement {
	/** Lit's: present only on an upgraded element. */
	updateComplete: Promise<boolean>;
}

export interface HistoryHeaderElement extends HTMLElement {
	headerTitle: string;
	closeButtonLabel: string;
	/** Renders the "back" button; it fires `history-header-close-click`. */
	showCloseAction: boolean;
}

/** The `cds-search` attributes the toolbar forwards (history-toolbar.ts `SearchAttributes`). */
export interface HistorySearchAttributes {
	"label-text"?: string;
	placeholder?: string;
	disabled?: boolean;
	value?: string;
	"close-button-label-text"?: string;
}

export interface HistoryToolbarElement extends HTMLElement {
	newChatLabel: string;
	searchOff: boolean;
	searchAttributes: HistorySearchAttributes | undefined;
}

export interface HistoryContentElement extends HTMLElement {
	resultsLabel: string;
	/** Shown as "<label>: <count>" in a polite live region; undefined or "" hides it. */
	resultsCount: string | number | undefined;
}

export interface HistoryLoadingElement extends HistoryShellElement {}

export interface HistoryPanelElement extends HTMLElement {
	/** Keeps every item's overflow menu visible instead of only on hover or focus. */
	showActions: boolean;
}

export interface HistoryPanelItemsElement extends HistoryShellElement {}

/** A collapsible group of items. Its heading is the `title` attribute. */
export interface HistoryPanelMenuElement extends HTMLElement {
	expanded: boolean;
}

/**
 * One entry of an item's overflow menu. `onClick` is NOT called by the element: a choice fires
 * `history-item-menu-action` with `detail.action` equal to `text`, so the handler matches on the
 * (translated) text.
 */
export interface HistoryItemAction {
	text: string;
	/** Danger styling. */
	delete?: boolean;
	/** A rule above the entry. */
	divider?: boolean;
	/** A rendered glyph (`iconLoader(...)` from @carbon/web-components); upstream types it as a descriptor but renders it as a template. */
	icon?: unknown;
	onClick: () => void;
}

export interface HistoryPanelItemElement extends HTMLElement {
	selected: boolean;
	name: string;
	/** Swaps the row for a text field. The element turns it off itself on save and cancel. */
	rename: boolean;
	actions: HistoryItemAction[];
	overflowMenuLabel: string;
	renameInvalid: boolean;
	renameInvalidMessage: string;
}

export interface HistoryDeletePanelElement extends HTMLElement {
	cancelText: string;
	deleteText: string;
	/** The id of the item being deleted; the shell uses it to move focus once the row is gone. */
	itemId: string;
}

/**
 * file-uploads/src/file-uploads.ts (1.11.0, not the 1.12 source: `getRemoveFileLabel` and
 * `getFileUploadFailureText` do not exist yet). The list in the prompt line's `file-uploads` slot. It
 * announces added, uploading, uploaded, failed and removed files itself, through its own live regions.
 * Fires `cds-aichat-file-remove` (EVENTS.fileRemove) from a chip's remove button; it does not remove anything.
 */
export interface FileUploadsElement extends HTMLElement {
	/** The library types this `FileUpload[]` with an enum status; `UploadChip` spells its values as literals. */
	uploads: readonly UploadChip[];
	/** The label of every remove button: 1.11.0 has no per-file name to put in it. */
	removeFileLabel: string;
	uploadingFileLabel: string;
	fileRemovedLabel: string;
	uploadSuccessLabel: string;
	uploadFailureLabel: string;
	getFilesAddedText: (args: { count: number }) => string;
	getFilesUploadingText: (args: { count: number }) => string;
	/** Lit's: settles once the chips of the last `uploads` assignment are in the list's shadow root. */
	updateComplete: Promise<boolean>;
}

/**
 * file-uploads/src/file-upload-item.ts: one chip. With `readOnly` it is the chip of a sent message: no
 * status and no remove button, given an `AttachmentChip` (no live `File` survives a reload).
 */
export interface FileUploadItemElement extends HTMLElement {
	upload: UploadChip | AttachmentChip | null;
	readOnly: boolean;
	removeFileLabel: string;
	uploadingFileLabel: string;
	/** Shown when the chip has no name. */
	fallbackLabel: string;
}

/** prompt-line/src/error-message.ts, in the shell's `field-messaging` slot. `title` is HTMLElement's own. */
export interface ErrorMessageElement extends HTMLElement {
	description: string;
	collapsible: boolean;
	fullscreen: boolean;
}

/** @carbon/web-components icon-button. The glyph goes in `slot=icon`, the tooltip (its accessible name) in `slot=tooltip-content`. */
export interface IconButtonElement extends HTMLElement {
	kind: string;
	size: string;
	align: string;
	disabled: boolean;
}

// -- guards and factories -----------------------------------------------------

function hasAll(element: HTMLElement, names: readonly string[]): boolean {
	return names.every((name) => name in element);
}

function create<T extends HTMLElement>(tag: string, isUpgraded: (element: HTMLElement) => element is T): T {
	const element: HTMLElement = document.createElement(tag);
	if (!isUpgraded(element)) {
		throw new Error(
			`carbon_frappe: <${tag}> is not upgraded. The AI chat bundle did not register it ` +
				`(register.ts not reached) or @carbon/ai-chat-components dropped a property this code reads.`,
		);
	}
	return element;
}

const isShell = (element: HTMLElement): element is ShellElement =>
	hasAll(element, ["aiEnabled", "cornerAll", "messagesAriaLabel", "contentMaxWidth"]);
const isChatHeader = (element: HTMLElement): element is ChatHeaderElement =>
	hasAll(element, ["headerTitle", "actions", "overflow", "requestFocus"]);
const isPromptLineShell = (element: HTMLElement): element is PromptLineShellElement =>
	hasAll(element, ["disabled", "hasError", "expanded"]);
const isPromptLine = (element: HTMLElement): element is PromptLineElement =>
	hasAll(element, ["placeholder", "getValue", "clearContent", "hasFocus"]);
const isSendControl = (element: HTMLElement): element is SendControlElement =>
	hasAll(element, ["hasValidInput", "isStopStreamingButtonVisible", "buttonLabel", "stopResponseLabel"]);
const isMarkdown = (element: HTMLElement): element is MarkdownElement =>
	hasAll(element, ["markdown", "streaming", "sanitizeHTML", "removeHTML", "tableLocale", "customRenderers"]);
const isChainOfThought = (element: HTMLElement): element is ChainOfThoughtElement =>
	hasAll(element, ["open", "panelId"]);
const isChainOfThoughtToggle = (element: HTMLElement): element is ChainOfThoughtToggleElement =>
	hasAll(element, ["open", "openLabelText", "closedLabelText", "panelId"]);
const isChainOfThoughtStep = (element: HTMLElement): element is ChainOfThoughtStepElement =>
	hasAll(element, ["stepNumber", "labelText", "status", "statusFailedLabelText"]);
const isToolCallData = (element: HTMLElement): element is ToolCallDataElement =>
	hasAll(element, ["toolName", "inputLabelText", "outputLabelText"]);
const isFeedbackButtons = (element: HTMLElement): element is FeedbackButtonsElement =>
	hasAll(element, ["isPositiveSelected", "isNegativeSelected", "hasNegativeDetails", "panelID"]);
const isFeedback = (element: HTMLElement): element is FeedbackElement =>
	hasAll(element, ["isOpen", "isReadonly", "showTextArea", "maxLength"]);
const isProcessing = (element: HTMLElement): element is ProcessingElement =>
	hasAll(element, ["loop", "quickLoad"]);
const isCodeSnippet = (element: HTMLElement): element is CodeSnippetElement =>
	hasAll(element, ["code", "language", "highlight", "hideHeader", "foldExpandLabel", "getLineCountText"]);
const isChatButton = (element: HTMLElement): element is ChatButtonElement =>
	hasAll(element, ["kind", "size", "disabled", "isQuickAction"]);

const isFileUploads = (element: HTMLElement): element is FileUploadsElement =>
	hasAll(element, [
		"uploads",
		"fileRemovedLabel",
		"uploadFailureLabel",
		"getFilesAddedText",
		"updateComplete",
	]);
const isFileUploadItem = (element: HTMLElement): element is FileUploadItemElement =>
	hasAll(element, ["upload", "readOnly", "fallbackLabel"]);
const isErrorMessage = (element: HTMLElement): element is ErrorMessageElement =>
	hasAll(element, ["description", "collapsible", "fullscreen"]);
const isIconButton = (element: HTMLElement): element is IconButtonElement =>
	hasAll(element, ["kind", "size", "align", "autoalign", "enterDelayMs"]);

const isHistoryShell = (element: HTMLElement): element is HistoryShellElement =>
	hasAll(element, ["updateComplete"]);
const isHistoryHeader = (element: HTMLElement): element is HistoryHeaderElement =>
	hasAll(element, ["headerTitle", "closeButtonLabel", "showCloseAction"]);
const isHistoryToolbar = (element: HTMLElement): element is HistoryToolbarElement =>
	hasAll(element, ["newChatLabel", "searchOff", "searchAttributes"]);
const isHistoryContent = (element: HTMLElement): element is HistoryContentElement =>
	hasAll(element, ["resultsLabel", "resultsCount"]);
const isHistoryPanel = (element: HTMLElement): element is HistoryPanelElement =>
	hasAll(element, ["showActions", "expanded"]);
const isHistoryPanelMenu = (element: HTMLElement): element is HistoryPanelMenuElement =>
	hasAll(element, ["expanded", "updateComplete"]);
const isHistoryPanelItem = (element: HTMLElement): element is HistoryPanelItemElement =>
	hasAll(element, ["selected", "name", "rename", "actions", "renameInvalid", "overflowMenuLabel"]);
const isHistoryDeletePanel = (element: HTMLElement): element is HistoryDeletePanelElement =>
	hasAll(element, ["cancelText", "deleteText", "itemId"]);

export const createShell = (): ShellElement => create(TAGS.shell, isShell);
export const createChatHeader = (): ChatHeaderElement => create(TAGS.chatHeader, isChatHeader);
export const createPromptLineShell = (): PromptLineShellElement =>
	create(TAGS.promptLineShell, isPromptLineShell);
export const createPromptLine = (): PromptLineElement => create(TAGS.promptLine, isPromptLine);
export const createSendControl = (): SendControlElement => create(TAGS.sendControl, isSendControl);
export const createMarkdown = (): MarkdownElement => create(TAGS.markdown, isMarkdown);
export const createChainOfThought = (): ChainOfThoughtElement =>
	create(TAGS.chainOfThought, isChainOfThought);
export const createChainOfThoughtToggle = (): ChainOfThoughtToggleElement =>
	create(TAGS.chainOfThoughtToggle, isChainOfThoughtToggle);
export const createChainOfThoughtStep = (): ChainOfThoughtStepElement =>
	create(TAGS.chainOfThoughtStep, isChainOfThoughtStep);
export const createToolCallData = (): ToolCallDataElement => create(TAGS.toolCallData, isToolCallData);
export const createFeedbackButtons = (): FeedbackButtonsElement =>
	create(TAGS.feedbackButtons, isFeedbackButtons);
export const createFeedback = (): FeedbackElement => create(TAGS.feedback, isFeedback);
export const createProcessing = (): ProcessingElement => create(TAGS.processing, isProcessing);
export const createCodeSnippet = (): CodeSnippetElement => create(TAGS.codeSnippet, isCodeSnippet);
export const createChatButton = (): ChatButtonElement => create(TAGS.button, isChatButton);
export const createHistoryShell = (): HistoryShellElement => create(TAGS.historyShell, isHistoryShell);
export const createHistoryHeader = (): HistoryHeaderElement => create(TAGS.historyHeader, isHistoryHeader);
export const createHistoryToolbar = (): HistoryToolbarElement =>
	create(TAGS.historyToolbar, isHistoryToolbar);
export const createHistoryContent = (): HistoryContentElement =>
	create(TAGS.historyContent, isHistoryContent);
export const createHistoryLoading = (): HistoryLoadingElement => create(TAGS.historyLoading, isHistoryShell);
export const createHistoryPanel = (): HistoryPanelElement => create(TAGS.historyPanel, isHistoryPanel);
export const createHistoryPanelItems = (): HistoryPanelItemsElement =>
	create(TAGS.historyPanelItems, isHistoryShell);
export const createHistoryPanelMenu = (): HistoryPanelMenuElement =>
	create(TAGS.historyPanelMenu, isHistoryPanelMenu);
export const createHistoryPanelItem = (): HistoryPanelItemElement =>
	create(TAGS.historyPanelItem, isHistoryPanelItem);
export const createHistoryDeletePanel = (): HistoryDeletePanelElement =>
	create(TAGS.historyDeletePanel, isHistoryDeletePanel);
export const createFileUploads = (): FileUploadsElement => create(TAGS.fileUploads, isFileUploads);
export const createFileUploadItem = (): FileUploadItemElement =>
	create(TAGS.fileUploadItem, isFileUploadItem);
export const createErrorMessage = (): ErrorMessageElement => create(TAGS.errorMessage, isErrorMessage);
export const createIconButton = (): IconButtonElement => create(TAGS.iconButton, isIconButton);

// -- events -------------------------------------------------------------------

/** Event names the chat listens for. Every one bubbles and is composed. */
export const EVENTS = {
	/** prompt-line, per keystroke. detail `{rawValue}`. */
	promptChange: "cds-aichat-prompt-change",
	/** prompt-line: Enter on a non-empty field, or Ctrl/Cmd+Enter. No detail; it does not clear the field. */
	promptSendIntent: "cds-aichat-prompt-send-intent",
	/** prompt-line, before the above. detail `{originalEvent}`. */
	promptKeydown: "cds-aichat-prompt-keydown",
	/** send-control: the send button, only while `hasValidInput`. No detail. */
	inputSend: "cds-aichat-input-send",
	/** send-control: the stop button. No detail. */
	inputStop: "cds-aichat-input-stop-streaming",
	/** feedback-buttons. detail `{isPositive}`. */
	feedbackButtonsClick: "feedback-buttons-click",
	/** feedback. detail `{text, selectedCategories}`. */
	feedbackSubmit: "feedback-submit",
	/** feedback: its close button. No detail. */
	feedbackClose: "feedback-close",
	/** chain-of-thought-toggle, after it flipped itself. detail `{open, panelId}`. */
	chainOfThoughtToggle: "chain-of-thought-toggle",
	/** history-toolbar: the new chat button. No detail. */
	historyNewChat: "chat-history-new-chat-click",
	/** history-header: the back button. No detail. */
	historyHeaderClose: "history-header-close-click",
	/** history-panel-item, on a click or Enter outside its overflow menu. detail `{itemId, itemName, element}`. */
	historyItemSelected: "history-item-selected",
	/** history-panel-item: an overflow menu entry was chosen. detail `{action, itemId, itemName, element}`. */
	historyItemMenuAction: "history-item-menu-action",
	/** history-panel-item-input, per keystroke while renaming. detail `{value, itemId}`. */
	historyRenameChange: "history-panel-item-input-change",
	/** history-panel-item-input: Enter or the save button (the item has already applied the name itself). detail `{newName, itemId}`. */
	historyRenameSave: "history-panel-item-input-save",
	/** history-panel-item-input: Escape, the cancel button, or focus leaving with nothing to save. No detail. */
	historyRenameCancel: "history-panel-item-input-cancel",
	/** history-delete-panel: Delete. detail `{itemId, nextItemId?, deletedItemWasSelected?}`; history-shell listens too. */
	historyDeleteConfirm: "history-delete-confirm",
	/** history-delete-panel: Cancel. No detail. */
	historyDeleteCancel: "history-delete-cancel",
	/** cds-search inside the toolbar's shadow root (bubbles, composed). detail `{value}`. */
	searchInput: "cds-search-input",
	/** file-uploads, from a chip's remove button. detail `{fileId}`: the `UploadChip.id` (the pending upload's id). */
	fileRemove: "cds-aichat-file-remove",
} as const;

export interface PromptChangeDetail {
	rawValue: string;
}

export interface PromptKeydownDetail {
	originalEvent: KeyboardEvent;
}

export interface FeedbackButtonsClickDetail {
	isPositive: boolean;
}

export interface FeedbackSubmitDetail {
	text: string;
	selectedCategories: string[];
}

export interface ToggleDetail {
	open: boolean;
}

export function isPromptChangeDetail(detail: unknown): detail is PromptChangeDetail {
	return isRecord(detail) && typeof detail["rawValue"] === "string";
}

export function isPromptKeydownDetail(detail: unknown): detail is PromptKeydownDetail {
	return isRecord(detail) && detail["originalEvent"] instanceof KeyboardEvent;
}

export function isFeedbackButtonsClickDetail(detail: unknown): detail is FeedbackButtonsClickDetail {
	return isRecord(detail) && typeof detail["isPositive"] === "boolean";
}

export function isFeedbackSubmitDetail(detail: unknown): detail is FeedbackSubmitDetail {
	return (
		isRecord(detail) &&
		typeof detail["text"] === "string" &&
		Array.isArray(detail["selectedCategories"]) &&
		detail["selectedCategories"].every((entry) => typeof entry === "string")
	);
}

export function isToggleDetail(detail: unknown): detail is ToggleDetail {
	return isRecord(detail) && typeof detail["open"] === "boolean";
}

export interface FileRemoveDetail {
	fileId: string;
}

export function isFileRemoveDetail(detail: unknown): detail is FileRemoveDetail {
	return isRecord(detail) && typeof detail["fileId"] === "string";
}

export interface HistoryItemDetail {
	itemId: string;
	itemName: string;
}

export interface HistoryMenuActionDetail extends HistoryItemDetail {
	action: string;
}

export interface HistoryRenameChangeDetail {
	value: string;
	itemId: string;
}

export interface HistoryRenameSaveDetail {
	newName: string;
	itemId: string;
}

export interface SearchInputDetail {
	value: string;
}

export function isHistoryItemDetail(detail: unknown): detail is HistoryItemDetail {
	return isRecord(detail) && typeof detail["itemId"] === "string" && typeof detail["itemName"] === "string";
}

export function isHistoryMenuActionDetail(detail: unknown): detail is HistoryMenuActionDetail {
	return isHistoryItemDetail(detail) && "action" in detail && typeof detail["action"] === "string";
}

export function isHistoryRenameChangeDetail(detail: unknown): detail is HistoryRenameChangeDetail {
	return isRecord(detail) && typeof detail["value"] === "string" && typeof detail["itemId"] === "string";
}

export function isHistoryRenameSaveDetail(detail: unknown): detail is HistoryRenameSaveDetail {
	return isRecord(detail) && typeof detail["newName"] === "string" && typeof detail["itemId"] === "string";
}

export function isSearchInputDetail(detail: unknown): detail is SearchInputDetail {
	return isRecord(detail) && typeof detail["value"] === "string";
}

/**
 * Listen for a CustomEvent whose `detail` passes `isDetail`; an event with any other
 * detail is dropped, so a handler never sees a shape it did not ask for. Returns the
 * function that removes the listener.
 */
export function listenDetail<D>(
	target: EventTarget,
	type: string,
	isDetail: (detail: unknown) => detail is D,
	handler: (detail: D, event: CustomEvent<unknown>) => void,
): () => void {
	const listener = (event: Event): void => {
		if (!(event instanceof CustomEvent)) return;
		const detail: unknown = event.detail;
		if (isDetail(detail)) handler(detail, event);
	};
	target.addEventListener(type, listener);
	return () => target.removeEventListener(type, listener);
}

// -- shared configuration -----------------------------------------------------

/**
 * Every user-visible string of a markdown element's code blocks and tables, through
 * `translate`. `locale` is the BCP 47 tag its tables sort and paginate with.
 */
export function localizeMarkdown(element: MarkdownElement, translate: Translate, locale: string): void {
	const __ = translate;
	element.codeSnippetShowLessText = __("Show less");
	element.codeSnippetShowMoreText = __("Show more");
	element.codeSnippetCopyButtonTooltipContent = __("Copy code");
	element.codeSnippetAriaLabelReadOnly = __("Code snippet");
	element.tableFilterPlaceholderText = __("Filter table...");
	element.tablePreviousPageText = __("Previous page");
	element.tableNextPageText = __("Next page");
	element.tableItemsPerPageText = __("Items per page:");
	element.tableDownloadLabelText = __("Download table data");
	element.tableLocale = locale;
}

/** Every user-visible string of a standalone code snippet, through `translate`. */
export function localizeCodeSnippet(element: CodeSnippetElement, translate: Translate): void {
	const __ = translate;
	element.showLessText = __("Show less");
	element.showMoreText = __("Show more");
	element.copyButtonTooltipContent = __("Copy code");
	element.ariaLabelReadOnly = __("Code snippet");
	element.foldCollapseLabel = __("Collapse code block");
	element.foldExpandLabel = __("Expand code block");
	element.getLineCountText = ({ count }) => (count === 1 ? __("1 line") : __("{0} lines", [String(count)]));
}

/** Lines a not yet built block reserves room for, which is also what the snippet shows before "Show more". */
const PLACEHOLDER_MAX_LINES = 15;
/** How far outside the viewport a block starts building, so scrolling does not show the empty placeholder. */
const BUILD_MARGIN = "600px";

type Visible = () => void;
const pendingBlocks = new Map<Element, Visible>();
let blockObserver: IntersectionObserver | null = null;

/** Run `build` once `element` is near the viewport (at once where there is no IntersectionObserver). */
function whenNearViewport(element: Element, build: Visible): void {
	if (typeof IntersectionObserver === "undefined") {
		build();
		return;
	}
	blockObserver ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const ready = pendingBlocks.get(entry.target);
				blockObserver?.unobserve(entry.target);
				pendingBlocks.delete(entry.target);
				ready?.();
			}
		},
		{ rootMargin: BUILD_MARGIN },
	);
	pendingBlocks.set(element, build);
	blockObserver.observe(element);
}

/**
 * The `customRenderers.codeBlock` callback for assistant messages: a read-only,
 * highlighted <cds-aichat-code-snippet> per fenced block, kept per slot so a streaming
 * re-render updates the element it already returned instead of replacing it.
 *
 * Each snippet is built only when its block nears the viewport. A snippet builds a
 * CodeMirror editor and measures layout, so a restored conversation with a fence in every
 * answer froze the tab for many seconds (the cost grows with the square of the row count).
 * Until then the slot holds an empty wrapper that reserves the block's approximate height.
 */
export function createCodeBlockRenderer(translate: Translate): (args: CodeBlockArgs) => HTMLElement {
	interface Block {
		readonly wrapper: HTMLElement;
		snippet: CodeSnippetElement | null;
		language: string;
		code: string;
	}
	const blocks = new Map<string, Block>();

	function sync(block: Block): void {
		const { snippet } = block;
		if (snippet === null) {
			const lines = Math.min(block.code.split("\n").length, PLACEHOLDER_MAX_LINES);
			block.wrapper.style.setProperty("--cf-ai-code-lines", String(lines));
			return;
		}
		if (snippet.language !== block.language) snippet.language = block.language;
		if (snippet.code !== block.code) snippet.code = block.code;
	}

	function build(block: Block): void {
		const snippet = createCodeSnippet();
		localizeCodeSnippet(snippet, translate);
		snippet.highlight = true;
		block.snippet = snippet;
		sync(block);
		block.wrapper.removeAttribute("data-pending");
		block.wrapper.append(snippet);
	}

	return (args) => {
		let block = blocks.get(args.slotName);
		if (!block) {
			const wrapper = document.createElement("div");
			wrapper.className = "cf-ai-code-block";
			wrapper.dataset["pending"] = "";
			const created: Block = { wrapper, snippet: null, language: args.language, code: args.code };
			blocks.set(args.slotName, created);
			block = created;
			whenNearViewport(wrapper, () => build(created));
		}
		block.language = args.language;
		block.code = args.code;
		sync(block);
		return block.wrapper;
	};
}
