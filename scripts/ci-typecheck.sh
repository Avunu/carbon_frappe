#!/usr/bin/env bash
# carbon_theme's own steps of `ci / typecheck` (`yarn -s ci:typecheck`, run by
# `frappe-nix gate typecheck` after the managed steps):
#
#   check:major   package.json's major is the frappe major the flake pins
#   codegen       `yarn codegen` leaves the committed generated files unchanged
#   compile       the standalone SCSS compile against frappe's sources
#   audit:drift   the token, markup and ai-chat audits, strict, against frappe,
#                 erpnext and hrms at the revisions flake.lock pins
#
# The gate exports FRAPPE_PATH (`frappe-nix pin-path frappe`) and, with
# `frappe-node-modules = true`, installs frappe's node_modules there. The
# legacy icon-class audit (check 9) reads every app next to frappe and fails
# under --strict when an app flake.lock pins is missing, so this lays the
# pinned trees out side by side, as in a bench, under .dev-dist/ci-apps/.
#
# Locally, in the dev shell: `yarn -s ci:typecheck` (frappe-nix fetches and
# hash-checks each tree the first time).
set -euo pipefail

cd "$(dirname "$0")/.."

status=0
step() {
	local name="$1"
	shift
	echo "::group::$name"
	if "$@"; then
		echo "::endgroup::"
	else
		echo "::endgroup::"
		echo "::error::$name failed"
		status=1
	fi
}

generated_current() {
	yarn -s codegen
	git diff --exit-code -- carbon_theme/public/js/generated carbon_theme/public/scss/generated \
		carbon_theme/public/fonts || {
		echo "yarn codegen changed committed files: run it and commit the result" >&2
		return 1
	}
	local untracked
	untracked="$(git ls-files --others --exclude-standard -- carbon_theme/public/js/generated \
		carbon_theme/public/scss/generated carbon_theme/public/fonts)"
	if [ -n "$untracked" ]; then
		printf 'yarn codegen wrote untracked files:\n%s\n' "$untracked" >&2
		return 1
	fi
}

step "check:major" yarn -s check:major
step "generated files are current" generated_current

apps=".dev-dist/ci-apps"
rm -rf "$apps"
mkdir -p "$apps"
ln -s "$(cd "${FRAPPE_PATH:-$(frappe-nix pin-path frappe)}" && pwd)" "$apps/frappe"
for app in erpnext hrms; do
	ln -s "$(frappe-nix pin-path "$app")" "$apps/$app"
done
export FRAPPE_PATH="$PWD/$apps/frappe"

step "compile" yarn -s compile
step "audit:drift" yarn -s audit:drift

exit $status
