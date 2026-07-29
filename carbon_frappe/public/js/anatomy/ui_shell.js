// Carbon UI Shell header.
//
// frappe/www/desk.html ships an empty <header></header> that frappe only fills
// under four narrow conditions (read_only, impersonated, announcement widget,
// mobile — see ui/toolbar/toolbar.js). On a normal desktop desk load it stays
// empty, which makes it a legitimate mount point rather than something we are
// taking over.
//
// Two rules shape what goes in it, both from the official docs:
//   * "For each UI shell component, left-to-right translates to
//      product-to-global" — the product name sits left, system-level utilities
//      right.
//   * "The hamburger menu is only needed when there is a collapsable left
//      navigation." frappe's side nav does collapse, so it earns one.
//
// The account menu is MOVED, not cloned: frappe binds dropdown handlers to that
// exact node, so relocating it keeps them live and avoids two user menus.
import { record } from "./patch";

const MOUNTED = "cf-shell-mounted";

function productName() {
	const boot = (window.frappe && frappe.boot) || {};
	// Carbon splits the brand: company prefix at 400, product name at 600
	const company = (boot.sysdefaults && boot.sysdefaults.company) || "";
	const app = (boot.app_data && boot.app_data[0] && boot.app_data[0].app_title) || "Frappe";
	return { company, app };
}

function mount() {
	const header = document.querySelector("header");
	// bail if absent, already ours, or frappe filled it (read-only / mobile /
	// impersonation / announcement) — those cases must keep frappe's markup
	if (!header || header.classList.contains(MOUNTED) || header.children.length) return false;

	const { company, app } = productName();

	header.classList.add(MOUNTED, "cf-shell-header");
	header.innerHTML = `
		<button class="cf-shell-menu" aria-label="Open navigation" type="button">
			<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
				<rect x="2" y="5"    width="16" height="1.4"></rect>
				<rect x="2" y="9.3"  width="16" height="1.4"></rect>
				<rect x="2" y="13.6" width="16" height="1.4"></rect>
			</svg>
		</button>
		<a class="cf-shell-name" href="/app">
			${company ? `<span class="cf-shell-prefix">${frappe.utils.escape_html(company)}</span> ` : ""}
			<span class="cf-shell-product">${frappe.utils.escape_html(app)}</span>
		</a>
		<div class="cf-shell-spacer"></div>
		<div class="cf-shell-actions"></div>
	`;

	// Delegate to frappe's own toggle rather than reimplementing it.
	header.querySelector(".cf-shell-menu").addEventListener("click", () => {
		const btn = document.querySelector(".sidebar-toggle-btn");
		if (btn) btn.click();
	});

	// Move (don't clone) the account menu into the header's right rail.
	const user = document.querySelector(".body-sidebar .dropdown-navbar-user");
	if (user) header.querySelector(".cf-shell-actions").appendChild(user);

	return true;
}

// The desk boots asynchronously, so retry until the header exists.
let tries = 0;
const timer = setInterval(() => {
	if (mount() || ++tries > 40) {
		clearInterval(timer);
		record("Carbon UI Shell header (<header> mount)", tries <= 40);
	}
}, 100);
