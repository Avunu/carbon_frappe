// DOM builders shared by the views. The always-loaded shell has its own string form of the
// error block (anatomy/shell/assistant.ts failureHtml) because this module ships in the lazy
// bundle; the two must stay separate.
import type { CarbonIcon } from "@carbon/web-components/es/globals/internal/icon-loader-utils.js";
import errorFilled20 from "@carbon/icons/es/error--filled/20.js";
import { iconSvg } from "./icons.ts";

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

/**
 * Make `parent`'s children start with `wanted`, in order, moving only what is out of place (moving a
 * custom element disconnects and reconnects it, which would restart a rename's input, and an
 * element already in place costs one comparison). Children that are not wanted are removed only
 * when `removeOthers` is set: Carbon appends an open overflow menu's body to the panel-items
 * container, and that node is not ours to drop.
 */
export function syncChildren(parent: Element, wanted: readonly Element[], removeOthers = true): void {
	let cursor = parent.firstElementChild;
	for (const node of wanted) {
		if (node === cursor) {
			cursor = cursor.nextElementSibling;
			continue;
		}
		parent.insertBefore(node, cursor);
	}
	if (!removeOthers) return;
	while (cursor !== null) {
		const next = cursor.nextElementSibling;
		cursor.remove();
		cursor = next;
	}
}

/** A Carbon glyph as a live <svg>. The descriptors are the bundled @carbon/icons ones, never data. */
export function iconElement(icon: CarbonIcon, attributes?: Record<string, string | number>): SVGElement {
	const template = document.createElement("template");
	template.innerHTML = iconSvg(icon, attributes);
	const svg = template.content.firstElementChild;
	if (!(svg instanceof SVGElement)) throw new Error("carbon_frappe: an icon did not render an <svg>");
	return svg;
}

export interface ErrorNotificationOptions {
	title: string;
	subtitle?: string;
	/** Carbon's modifier for a notification that has no close button. */
	hideClose?: boolean;
}

export interface ErrorNotification {
	/** Carbon's InlineNotification markup, class for class. The caller adds its own role and classes. */
	readonly element: HTMLElement;
	/** Clipped below the title and readable in full on hover. "" takes the subtitle out. */
	setSubtitle(text: string): void;
}

/** The always-loaded desk stylesheet carries the CSS (desk/_carbon-components.scss). */
export function createErrorNotification(options: ErrorNotificationOptions): ErrorNotification {
	const root = el("div", "cds--inline-notification cds--inline-notification--error");
	if (options.hideClose === true) root.classList.add("cds--inline-notification--hide-close-button");
	const details = el("div", "cds--inline-notification__details");
	const wrapper = el("div", "cds--inline-notification__text-wrapper");
	wrapper.append(el("div", "cds--inline-notification__title", options.title));
	details.append(iconElement(errorFilled20, { class: "cds--inline-notification__icon" }), wrapper);
	root.append(details);

	const subtitle = el("div", "cds--inline-notification__subtitle");
	function setSubtitle(text: string): void {
		if (subtitle.textContent !== text) {
			subtitle.textContent = text;
			if (text === "") subtitle.removeAttribute("title");
			else subtitle.title = text;
		}
		if (text !== "" && subtitle.parentElement === null) wrapper.append(subtitle);
		else if (text === "") subtitle.remove();
	}
	setSubtitle(options.subtitle ?? "");
	return { element: root, setSubtitle };
}
