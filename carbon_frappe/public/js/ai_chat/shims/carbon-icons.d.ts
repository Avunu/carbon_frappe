// @carbon/icons ships its ES glyph modules (`es/<name>/<size>.js`) without
// declarations. Each default export is the descriptor object @carbon/web-components'
// icon loader takes, which is exactly what its `CarbonIcon` type names.
//
// Kept a SCRIPT (no top-level import/export) so this is an ambient declaration.
declare module "@carbon/icons/es/*" {
	import type { CarbonIcon } from "@carbon/web-components/es/globals/internal/icon-loader-utils.js";
	const icon: CarbonIcon;
	export default icon;
}
