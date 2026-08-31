// The Carbon table toolbar for frappe's child-table Grid.
//
// frappe puts every grid action in a footer BELOW the table:
//
//   .grid-footer > .flex
//     .grid-buttons        Delete / Edit / Delete all / Duplicate rows / Add row / Add multiple
//     .grid-pagination     First ‹ n of m › Last
//     .grid-bulk-actions   Download / Upload
//
// Carbon puts them ABOVE it, in a `cds--table-toolbar`, with a
// `cds--batch-actions` bar that slides over the toolbar while rows are
// selected, and it puts pagination below as its own component.
//
// EVERYTHING HERE MOVES NODES; NOTHING IS REBUILT. `Grid.make()` caches element
// handles (`remove_rows_button`, `edit_rows_button`, `grid_buttons`, …) and
// `frappe.utils.bind_actions_with_object` wires `data-action="delete_rows"` and
// friends onto the elements themselves (grid.js:129-154). Relocating a node
// therefore preserves its handler, its cached handle, and every `.hidden` /
// `.d-none` toggle `setup_toolbar()` and `refresh_remove_rows_button()` apply
// through `this.wrapper.find(...)` — `this.wrapper` is `.grid-field`, which
// still contains the toolbar. Rebuilding the buttons would have thrown all of
// that away and left `setup_allow_bulk_edit()` un-hiding orphaned nodes.
import { CARBON } from "../engine/classes";
import { icon } from "../engine/icons";

function esc(text) {
	if (window.frappe && frappe.utils && frappe.utils.escape_html) {
		return frappe.utils.escape_html(text);
	}
	return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function el(tag, className, attrs) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
	return node;
}

/**
 * Re-present a frappe text button as a Carbon icon-only toolbar action.
 *
 * The BUTTON ELEMENT is kept — only its contents change — so its click handler
 * and its cached `grid.*_button` handle survive. The old label becomes the
 * accessible name rather than being dropped.
 */
function toToolbarAction(node, iconName, fallbackLabel) {
	if (!node || node.__cf_toolbar_action) return node;
	node.__cf_toolbar_action = true;
	const label = (node.textContent || "").trim() || fallbackLabel;
	node.classList.add(CARBON.toolbarAction, "cds--btn", "cds--btn--ghost", "cds--btn--icon-only");
	node.innerHTML = `${icon(iconName, "sm")}<span class="cds--visually-hidden">${esc(label)}</span>`;
	node.setAttribute("title", label);
	node.setAttribute("aria-label", label);
	return node;
}

export default class GridToolbar {
	constructor(grid, node) {
		this.grid = grid;
		this.node = node;
		this.build();
	}

	build() {
		const node = this.node;
		node.setAttribute("role", "group");
		node.setAttribute("aria-label", __("Table toolbar", null, "Carbon grid toolbar"));

		// ORDER IS LOAD-BEARING. Carbon's slide-over is
		// `.cds--batch-actions--active ~ .cds--toolbar-content` (a general
		// sibling combinator, _data-table-action.scss:298), so the batch bar has
		// to come first in the DOM.
		this.batch = el("div", CARBON.batchActions, { "aria-hidden": "true" });
		const summary = el("div", CARBON.batchSummary);
		const para = el("p", CARBON.batchSummary + "__para");
		this.count = el("span", null, { dir: "auto" });
		para.appendChild(this.count);
		summary.appendChild(para);

		this.actions = el("div", CARBON.actionList);
		this.cancel = el("button", `${CARBON.batchSummary}__cancel cds--btn cds--btn--primary`, {
			type: "button",
		});
		this.cancel.textContent = __("Cancel");
		this.cancel.addEventListener("click", () => this.grid.clear_selection());

		this.batch.appendChild(summary);
		this.batch.appendChild(this.actions);

		this.content = el("div", CARBON.toolbarContent);

		node.appendChild(this.batch);
		node.appendChild(this.content);

		this.moveBatchButtons();
		this.buildSearchToggle();
		this.moveBulkActions();
		// Anchor: the gear is rebuilt by `make_head()` on every refresh and has
		// to land back in the same slot each time.
		this.gearSlot = el("span", "cf-grid__toolbar-gear-slot");
		this.content.appendChild(this.gearSlot);
		this.moveAddButtons();

		this.actions.appendChild(this.cancel);
		this.refreshBatch();
	}

	/** Delete / Edit / Delete all / Duplicate — the selection-scoped actions. */
	moveBatchButtons() {
		const w = this.grid.wrapper;
		for (const sel of [
			".grid-remove-rows",
			".grid-edit-rows",
			".grid-remove-all-rows",
			".grid-duplicate-rows",
		]) {
			const node = w.find(sel).get(0);
			if (!node) continue;
			node.classList.add("cds--btn", "cds--btn--primary");
			this.actions.appendChild(node);
		}
	}

	/**
	 * The magnifier.
	 *
	 * Deliberately a `cds--toolbar-action` toggle rather than Carbon's
	 * `cds--toolbar-search-container-expandable`: that component is a text input
	 * doing a global match, and this grid's search is frappe's per-column filter
	 * row in the <thead> — with per-fieldtype matching (Sr No, Duration,
	 * Barcode, Rating…) the engine has no equivalent for. Presenting a text
	 * field that is really a disclosure control would be a lie; a pressed-state
	 * toggle is the honest Carbon idiom for it.
	 */
	buildSearchToggle() {
		const button = el("button", `${CARBON.toolbarAction} cds--btn cds--btn--ghost cds--btn--icon-only`, {
			type: "button",
			"aria-pressed": "false",
		});
		const label = __("Filter rows", null, "Carbon grid toolbar");
		button.innerHTML = `${icon("es-line-search", "sm")}<span class="cds--visually-hidden">${esc(label)}</span>`;
		button.setAttribute("title", label);
		button.setAttribute("aria-label", label);
		button.addEventListener("click", () => {
			const open = this.grid.toggle_search();
			button.setAttribute("aria-pressed", open ? "true" : "false");
			button.classList.toggle(CARBON.searchActive, open);
		});
		this.search_button = button;
		this.content.appendChild(button);
	}

	/** Download / Upload, un-hidden by `setup_allow_bulk_edit()` when it applies. */
	moveBulkActions() {
		const w = this.grid.wrapper;
		const download = w.find(".grid-download").get(0);
		const upload = w.find(".grid-upload").get(0);
		if (download) this.content.appendChild(toToolbarAction(download, "es-line-download", __("Download")));
		if (upload) this.content.appendChild(toToolbarAction(upload, "es-line-upload", __("Upload")));
	}

	/**
	 * `.grid-custom-buttons` and `.grid-buttons` move as WHOLE NODES, because
	 * `Grid.add_custom_button()` (grid.js:1588) appends into them by class and
	 * would otherwise drop buttons into a container nobody can see.
	 * `.grid-buttons` still holds Add row / Add multiple at this point — the
	 * selection-scoped buttons were lifted out of it above.
	 */
	moveAddButtons() {
		const w = this.grid.wrapper;
		const custom = w.find(".grid-custom-buttons").get(0);
		if (custom) this.content.appendChild(custom);

		const buttons = this.grid.grid_buttons && this.grid.grid_buttons.get(0);
		if (buttons) this.content.appendChild(buttons);

		// One primary per toolbar, as Carbon has it: "Add row" is the primary
		// action and "Add multiple" is the secondary next to it.
		const add = w.find(".grid-add-row").get(0);
		if (add) add.classList.add("cds--btn", "cds--btn--sm", "cds--btn--primary");
		const addMany = w.find(".grid-add-multiple-rows").get(0);
		if (addMany) addMany.classList.add("cds--btn", "cds--btn--sm", "cds--btn--tertiary");
	}

	/**
	 * Re-adopt the Configure Columns gear.
	 *
	 * `Grid.make_head()` constructs a brand new header GridRow — and therefore a
	 * brand new gear — on every `refresh()`, so this cannot be done once at
	 * build time.
	 */
	sync() {
		const button = this.grid.header_row && this.grid.header_row.configure_columns_button;
		const node = button && button.get(0);
		if (!node || node.parentNode === this.gearSlot) return;
		this.gearSlot.textContent = "";
		node.classList.add("cf-grid__toolbar-gear", CARBON.toolbarAction);
		const label = __("Configure Columns");
		node.setAttribute("role", "button");
		node.setAttribute("tabindex", "0");
		node.setAttribute("title", label);
		node.setAttribute("aria-label", label);
		this.gearSlot.appendChild(node);
	}

	/**
	 * Drive the batch bar from the selection.
	 *
	 * The clip-path/transform that hides the bar does NOT take it out of the
	 * accessibility tree or the tab order, so `aria-hidden` and a roving
	 * tabindex have to be flipped by hand — @carbon/react does the same
	 * (DataTable-batch-actions.stories.js:96-152).
	 */
	refreshBatch() {
		const n = (this.grid.get_selected() || []).length;
		const active = n > 0;
		this.count.textContent =
			n === 1 ? __("1 item selected") : __("{0} items selected", [n]);
		this.batch.classList.toggle(CARBON.batchActionsActive, active);
		this.batch.setAttribute("aria-hidden", active ? "false" : "true");
		this.content.setAttribute("aria-hidden", active ? "true" : "false");
		for (const b of this.batch.querySelectorAll("button")) b.tabIndex = active ? 0 : -1;
		for (const b of this.content.querySelectorAll("button, [role='button']")) {
			b.tabIndex = active ? -1 : 0;
		}
	}
}

/**
 * Pagination, below the table, as Carbon puts it.
 *
 * The `.grid-pagination` element itself has to survive: `GridPagination`
 * re-`.html()`s its contents on every page change and only renders at all when
 * `data.length > grid_page_length` (grid_pagination.js:16).
 */
export function mountFooter(grid, node) {
	const pagination = grid.wrapper.find(".grid-pagination").get(0);
	if (!pagination) return;
	pagination.classList.add(CARBON.pagination);
	node.appendChild(pagination);
}
