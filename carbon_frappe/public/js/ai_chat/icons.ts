// The Carbon glyphs the chat draws itself. They come from @carbon/icons as
// descriptors (the shape @carbon/web-components' icon loader takes), so the
// toolbar `actions` of cds-aichat-chat-header accept them as they are and
// `iconSvg` renders the same descriptor for light-DOM markup. shims/carbon-icons.d.ts
// supplies the missing declarations.
import type { CarbonIcon } from "@carbon/web-components/es/globals/internal/icon-loader-utils.js";
import { carbonIconToSVG } from "@carbon/web-components/es/globals/internal/icon-loader-utils.js";
import add16 from "@carbon/icons/es/add/16.js";
import arrowDown16 from "@carbon/icons/es/arrow--down/16.js";
import attachment16 from "@carbon/icons/es/attachment/16.js";
import chatBot16 from "@carbon/icons/es/chat-bot/16.js";
import close16 from "@carbon/icons/es/close/16.js";
import history16 from "@carbon/icons/es/history/16.js";
import maximize16 from "@carbon/icons/es/maximize/16.js";
import minimize16 from "@carbon/icons/es/minimize/16.js";
import security16 from "@carbon/icons/es/security/16.js";
import upload32 from "@carbon/icons/es/upload/32.js";
import warningAlt16 from "@carbon/icons/es/warning--alt/16.js";

export const ICONS = {
	add16,
	arrowDown16,
	attachment16,
	chatBot16,
	close16,
	history16,
	maximize16,
	minimize16,
	security16,
	upload32,
	warningAlt16,
};

/**
 * The glyph as an `<svg>` string for innerHTML. `focusable="false"` and
 * `aria-hidden="true"` are added by the icon helpers unless `aria-label` is passed,
 * so a glyph beside a text label is already hidden from assistive technology.
 */
export function iconSvg(icon: CarbonIcon, attributes?: Record<string, string | number>): string {
	return carbonIconToSVG(icon, attributes);
}
