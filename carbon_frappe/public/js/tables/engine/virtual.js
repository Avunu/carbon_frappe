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

/** Below this many rows, windowing costs more than it saves. */
export const VIRTUAL_THRESHOLD = 100;

export default class RowVirtualizer {
	constructor(host) {
		this.host = host;
		this.virtualizer = null;
		this.cleanup = null;
		this.enabled = false;
	}

	/** (Re)build the virtualizer for a row count. Idempotent per count/height. */
	sync(count, rowHeight, scrollElement) {
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

	teardown() {
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
	window(count) {
		if (!this.enabled || !this.virtualizer) {
			return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 };
		}
		this.virtualizer._willUpdate();
		const items = this.virtualizer.getVirtualItems();
		if (!items.length) {
			return { start: 0, end: 0, paddingTop: 0, paddingBottom: this.virtualizer.getTotalSize() };
		}
		const first = items[0];
		const last = items[items.length - 1];
		return {
			start: first.index,
			end: last.index + 1,
			paddingTop: first.start,
			paddingBottom: Math.max(0, this.virtualizer.getTotalSize() - last.end),
		};
	}

	scrollToIndex(index, opts) {
		if (this.enabled && this.virtualizer) this.virtualizer.scrollToIndex(index, opts);
	}
}
