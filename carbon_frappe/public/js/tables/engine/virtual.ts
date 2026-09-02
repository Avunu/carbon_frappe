// Row virtualization.
//
// Report views routinely render tens of thousands of rows (frappe's own guard,
// `max_report_rows`, defaults to 100 000) and frappe-datatable used HyperList to
// cope. We use @tanstack/virtual-core, driving SPACER ROWS rather than absolute
// positioning: a <tr> holding one colspan'd <td> of the right height keeps the
// <table> element valid, so `table-layout: fixed`, <colgroup> widths and
// `position: sticky` pinned cells all keep working. Absolute positioning would
// have forced the whole grid into divs and cost us Carbon's data-table CSS.
//
// Virtualization is DISABLED, not merely bypassed, whenever a row of
// non-uniform height is on screen — an expanded Grid detail form, or an
// expanded report tree node whose child rows the adapter renders itself. Mixed
// heights under a fixed `estimateSize` produce a scrollbar that drifts out of
// step with the content, which is worse than rendering every row.
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from "@tanstack/virtual-core";
import type { ScrollToOptions } from "@tanstack/virtual-core";

/** Below this many rows, windowing costs more than it saves. */
export const VIRTUAL_THRESHOLD = 100;

/**
 * `scrollToIndex`'s options, re-exported under a name that does not collide
 * with the DOM's own `ScrollToOptions`.
 */
export type RowScrollToOptions = ScrollToOptions;

/**
 * What the virtualizer needs back from CarbonTable.
 *
 * Declared here rather than importing `CarbonTable`, because table.js imports
 * THIS module: the two are mutually dependent at runtime and the dependency has
 * to point one way. `shouldVirtualize` is the "same height for every row" veto
 * described above; `scheduleRender` is the engine's rAF-coalesced re-render.
 */
export interface RowVirtualizerHost {
	shouldVirtualize(count: number): boolean;
	scheduleRender(): void;
}

/**
 * The slice of rows to render, plus the two spacer heights that stand in for
 * the rows outside it.
 */
export interface VirtualWindow {
	/** First row index to render. */
	start: number;
	/** One past the last row index to render. */
	end: number;
	/** Height of the leading spacer row, in px. */
	paddingTop: number;
	/** Height of the trailing spacer row, in px. */
	paddingBottom: number;
}

export default class RowVirtualizer {
	host: RowVirtualizerHost;
	/** `HTMLElement` scroll parent, `Element` items — the engine measures rows itself. */
	virtualizer: Virtualizer<HTMLElement, Element> | null;
	cleanup: (() => void) | null;
	enabled: boolean;
	// The three `sync()` arguments the last build was made from. Undefined until
	// the first sync, null after a teardown; either way they can only compare
	// unequal to a real count/height/element, which is what the guard wants.
	_count: number | null | undefined;
	_rowHeight: number | null | undefined;
	_scrollElement: HTMLElement | null | undefined;

	constructor(host: RowVirtualizerHost) {
		this.host = host;
		this.virtualizer = null;
		this.cleanup = null;
		this.enabled = false;
	}

	/** (Re)build the virtualizer for a row count. Idempotent per count/height. */
	sync(count: number, rowHeight: number, scrollElement: HTMLElement): boolean {
		const want = this.host.shouldVirtualize(count);
		if (!want) {
			this.teardown();
			return false;
		}
		if (
			this.virtualizer &&
			this._count === count &&
			this._rowHeight === rowHeight &&
			this._scrollElement === scrollElement
		) {
			return true;
		}

		const opts = {
			count,
			getScrollElement: () => scrollElement,
			estimateSize: () => rowHeight,
			scrollToFn: elementScroll,
			observeElementOffset,
			observeElementRect,
			// Carbon lg rows are 48px; 12 rows of overscan is roughly half a
			// viewport, enough that a fast wheel scroll never shows a gap.
			overscan: 12,
			onChange: () => this.host.scheduleRender(),
		};

		if (this.virtualizer) {
			this.virtualizer.setOptions(Object.assign({}, opts, { onChange: opts.onChange }));
		} else {
			this.virtualizer = new Virtualizer(opts);
			this.cleanup = this.virtualizer._didMount();
		}
		this._count = count;
		this._rowHeight = rowHeight;
		this._scrollElement = scrollElement;
		this.enabled = true;
		this.virtualizer.measure();
		return true;
	}

	teardown(): void {
		if (this.cleanup) this.cleanup();
		this.cleanup = null;
		this.virtualizer = null;
		this.enabled = false;
		this._count = this._rowHeight = this._scrollElement = null;
	}

	/**
	 * The window to render, as `{ start, end, paddingTop, paddingBottom }`.
	 * Returns the full range when virtualization is off, so callers never need
	 * a second code path.
	 */
	window(count: number): VirtualWindow {
		if (!this.enabled || !this.virtualizer) {
			return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 };
		}
		this.virtualizer._willUpdate();
		const items = this.virtualizer.getVirtualItems();
		// `first`/`last` stand in for the `items.length` test: virtual-core
		// returns a dense array, so an absent first item IS an empty window,
		// and reading them up front is what makes the two indexed reads below
		// definite.
		const first = items[0];
		const last = items[items.length - 1];
		if (!first || !last) {
			return { start: 0, end: 0, paddingTop: 0, paddingBottom: this.virtualizer.getTotalSize() };
		}
		return {
			start: first.index,
			end: last.index + 1,
			paddingTop: first.start,
			paddingBottom: Math.max(0, this.virtualizer.getTotalSize() - last.end),
		};
	}

	scrollToIndex(index: number, opts?: RowScrollToOptions): void {
		if (this.enabled && this.virtualizer) this.virtualizer.scrollToIndex(index, opts);
	}
}
