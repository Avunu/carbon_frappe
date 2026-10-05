// The empty-conversation screen: a greeting and starter prompts, or, when flow has no
// enabled agent, what an administrator has to configure first.
//
// Markup:
//
//   div.cf-ai-home  [.cf-ai-home--setup in setup mode]
//     h2.cf-ai-home__greeting            "Hello, <first name>" (setup mode: "Finish setup to start")
//     p.cf-ai-home__intro
//     div.cf-ai-home__starters           ready mode only
//       div.cf-ai-home__starter > cds-aichat-button.cf-ai-starter[is-quick-action]   one per starter
//     ol.cf-ai-home__steps               setup mode, System Managers: what to configure
//     p.cf-ai-home__action > a.cf-ai-home__link   setup mode, System Managers: where to configure it
//     p.cf-ai-home__note                 setup mode, everyone else: ask an administrator
//
// The sections of the other modes are detached, not hidden: a hidden starter would still
// be a starter to a query, and the panel's tests count them.
import { el } from "../dom.ts";
import type { Translate } from "../i18n.ts";
import { createChatButton } from "../elements.ts";

/** `loading` shows the greeting without starters until the agent count is known. */
export type HomeMode = "loading" | "ready" | "setup";

export interface HomeDeps {
	translate: Translate;
	/** `frappe.boot.user.first_name`, falling back to the full name; "" drops the name from the greeting. */
	firstName: string;
	/** The user may create Flow Models and Agents (has the System Manager role): setup mode lists the steps. */
	canConfigure: boolean;
	/** A starter was clicked; the panel sends its text. */
	onStarter(text: string): void;
}

export interface HomeView {
	readonly element: HTMLElement;
	setMode(mode: HomeMode): void;
	dispose(): void;
}

export function createHome(deps: HomeDeps): HomeView {
	const __ = deps.translate;
	const root = el("div", "cf-ai-home");
	const greeting = el("h2", "cf-ai-home__greeting");
	const intro = el("p", "cf-ai-home__intro");
	const abort = new AbortController();

	// Spelled out so frappe's extractor sees each string; the order is the order shown.
	const starterTexts = [
		__("What can you help me with?"),
		__("Show my open To Dos"),
		__("Which DocTypes can I read?"),
		__("Summarize what changed today"),
	];
	const starters = el("div", "cf-ai-home__starters");
	starterTexts.forEach((text, index) => {
		const wrapper = el("div", "cf-ai-home__starter");
		// Staggers the entrance (see _home.scss); a custom property, so it is a CSSOM write.
		wrapper.style.setProperty("--index", String(index + 1));
		const control = createChatButton();
		control.className = "cf-ai-starter";
		control.kind = "tertiary";
		control.isQuickAction = true;
		control.textContent = text;
		control.addEventListener("click", () => deps.onStarter(text), { signal: abort.signal });
		wrapper.append(control);
		starters.append(wrapper);
	});

	const steps = el("ol", "cf-ai-home__steps");
	steps.append(
		el("li", "", __("Create and enable a Flow Model with your provider credentials.")),
		el("li", "", __("Enable a Flow Agent. Flow creates one automatically when a model exists.")),
	);

	const action = el("p", "cf-ai-home__action");
	const link = el("a", "cf-ai-home__link", __("Open Flow Models"));
	// A real href keeps middle-click and "open in new tab" working; a plain click goes
	// through the router instead of reloading the desk.
	link.href = "/app/flow-model";
	link.addEventListener(
		"click",
		(event) => {
			if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			frappe.set_route("List", "Flow Model").catch(console.error);
		},
		{ signal: abort.signal },
	);
	action.append(link);

	const note = el(
		"p",
		"cf-ai-home__note",
		__("The assistant has not been set up yet. Ask your administrator to enable it."),
	);

	function setMode(mode: HomeMode): void {
		const setup = mode === "setup";
		root.classList.toggle("cf-ai-home--setup", setup);
		greeting.textContent = setup
			? __("Finish setup to start")
			: deps.firstName === ""
				? __("Hello")
				: __("Hello, {0}", [deps.firstName]);
		if (!setup) {
			intro.textContent = __("Ask about your data, draft records, or run a task.");
			root.replaceChildren(greeting, intro, ...(mode === "ready" ? [starters] : []));
		} else if (deps.canConfigure) {
			intro.textContent = __("The assistant needs a few things configured first:");
			root.replaceChildren(greeting, intro, steps, action);
		} else {
			root.replaceChildren(greeting, note);
		}
	}

	setMode("loading");
	return {
		element: root,
		setMode,
		dispose() {
			abort.abort();
			root.replaceChildren();
		},
	};
}
