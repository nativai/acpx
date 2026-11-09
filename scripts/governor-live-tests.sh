#!/usr/bin/env bash
# Live tests of the process-tree governor (brick 5d7a23b6, CONCEPTION §11 N1-N5) — WORKBENCH ONLY.
# Sets the caps the storms need BEFORE anything runs: `ulimit -u 2000`, `timeout -s KILL 900`, and
# a depth cap (DMAX, default 400) inside every storm. Run from a built worktree:
#   ACPX_GOVERNOR_LIVE_TESTS=1 scripts/governor-live-tests.sh <results.jsonl> N1x20 N2 N3x10 N4x3 N5
set -euo pipefail
[ "${ACPX_GOVERNOR_LIVE_TESTS:-}" = 1 ] || { echo "refused: ACPX_GOVERNOR_LIVE_TESTS=1 not set" >&2; exit 3; }
if [ -e /data/runtime ] || [ -e /opt/acpx-ui ]; then
  echo "refused: this is a control pod; live storms run only in a workbench" >&2
  exit 3
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
main="$here/dist/capacity/governor/main.js"
[ -f "$main" ] || { echo "refused: $main missing — pnpm run build first" >&2; exit 3; }
results="$1"
shift
ulimit -u 2000
export DMAX="${DMAX:-400}" ACPX_GOVERNOR_LIVE_UNDER_TIMEOUT=1
cd /
exec timeout -s KILL "${GOVERNOR_LIVE_TIMEOUT_S:-900}" python3 -I "$here/scripts/governor-live-tests.py" "$main" "$results" "$@"
