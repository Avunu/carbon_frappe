#!/usr/bin/env bash
# The site-backed suites, against a bench this repo's flake assembles:
#
#   nix develop --no-pure-eval -c bash ci/integration.sh
#
# Brings the devenv processes up detached (MariaDB, Redis, the frappe runtime,
# nginx), provisions the site with every app in sites/apps.txt (frappe, erpnext,
# hrms, carbon_frappe), then runs, in order:
#
#   bench run-tests --app carbon_frappe --coverage    the Python unittest classes
#   bench build --app carbon_frappe                   the assets the browser suites load
#   scripts/test-tables.ts                            the table engine and its adapters
#   scripts/test-shell.ts                             the UI Shell header
#
# It is what CI's `integration` job runs and what a developer runs to get the
# same answer; nothing here is CI-specific except the step summary.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${FRAPPE_BENCH_ROOT:?run inside the frappe-nix shell}"
: "${FRAPPE_SITE:?run inside the frappe-nix shell}"

# `devenv` here is the flake-compat wrapper; without this it re-enters the
# shell, and process-compose's TUI has no terminal to draw on.
export DEVENV_IN_DIRENV_SHELL=true PC_TUI_ENABLED=0

devenv up -D
cleanup() {
	process-compose -U -u "$PC_SOCKET_PATH" down >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The web port is allocated at `devenv up` (hashed from the bench name, moved
# if taken) and written into common_site_config.json; nginx answers with a
# non-2xx until the site exists, so any HTTP response means "up".
cfg="$FRAPPE_BENCH_ROOT/sites/common_site_config.json"
PORT=""
for _ in $(seq 150); do
	PORT="$(jq -r '.webserver_port // empty' "$cfg" 2>/dev/null || true)"
	if [ -n "$PORT" ] && curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/"; then break; fi
	sleep 2
done
[ -n "$PORT" ] || { echo "::error::the bench never answered on its web port" >&2; exit 1; }
echo "bench is up on http://127.0.0.1:$PORT"

# `bench new-site` asks for the MariaDB root password through getpass, which
# reads a line from stdin when there is no tty; the dev bench's root has none.
printf '\n' | provision-site admin
# A fresh site sends every desk route to the setup wizard until it is marked
# complete — the same call frappe's own UI-test workflow makes.
bench --site "$FRAPPE_SITE" execute frappe.utils.install.complete_setup_wizard
# without this `bench run-tests` prints "Testing is disabled" and exits 0
bench --site "$FRAPPE_SITE" set-config allow_tests true

status=0
step() {
	local name="$1"
	shift
	echo "::group::$name"
	if "$@"; then
		echo "- ✅ $name" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
	else
		status=1
		echo "- ❌ $name" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
	fi
	echo "::endgroup::"
}

# `--coverage` needs the `coverage` package, which frappe-nix's app-mode
# workspace does not carry by default (its dev group is a fixed list); the
# tests matter more than the number, so it is used when present.
coverage_flag=()
if "$FRAPPE_BENCH_ROOT/env/bin/python" -c 'import coverage' 2>/dev/null; then coverage_flag=(--coverage); fi
step "bench run-tests --app carbon_frappe" bench --site "$FRAPPE_SITE" run-tests --app carbon_frappe "${coverage_flag[@]}"
step "bench build --app carbon_frappe" bench build --app carbon_frappe
# 127.0.0.1, not localhost: nginx listens on the IPv4 loopback, and a runner
# whose `localhost` resolves to ::1 first would have every suite fail at login
export CF_SITE_URL="http://127.0.0.1:$PORT"
export CF_SHOT_DIR="${CF_SHOT_DIR:-$PWD/.dev-dist/screenshots}"
step "scripts/test-tables.ts" node scripts/test-tables.ts
step "scripts/test-shell.ts" node scripts/test-shell.ts

# python coverage, as the summary's last line
cov="$FRAPPE_BENCH_ROOT/sites/coverage.xml"
if [ -f "$cov" ]; then
	rate="$(grep -o 'line-rate="[0-9.]*"' "$cov" | head -1 | grep -o '[0-9.]*')"
	echo "Python line coverage: $(awk "BEGIN { printf \"%.1f%%\", ${rate:-0} * 100 }")" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
exit $status
