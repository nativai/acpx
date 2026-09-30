#!/usr/bin/env bash
# sweep-shared-tmp.sh — retention sweeper for TIER 2 of the dev-box scratch
# model: the per-session shared scratch directories named by
# `ACPX_SESSION_SHARED_TMP` (src/acp/session-shared-tmp-dir.ts).
#
# WHY IT EXISTS: tier 2 lives on `/workspace`, the PVC — the box's TIGHT
# filesystem — precisely so both pods can see it and it survives a pod restart.
# Tier 1 (`/tmp`) needs no reaper because a pod restart wipes it; that mechanism
# is exactly what tier 2 gives up. An unswept area advertised as "temporary"
# silently becomes durable, so the 7-day retention this enforces is the other
# half of the promise the variable's name makes.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ 🛑 THIS IS A SCRIPT AND MUST NEVER BECOME AN `acpx` CLI VERB.            │
# │                                                                          │
# │ Not a style preference — it is the transferable lesson from the incident │
# │ this work was forked out of (brick d1e12500): a reclaim job must never   │
# │ run on a request-serving path, and a per-invocation "this one is cheap"  │
# │ exemption cannot see COMPOSITION. That sweep was an on-prompt            │
# │ maintenance pass and it OOM-killed arbitrary user prompts.               │
# │                                                                          │
# │ A CLI verb is reachable from request-serving code. A script in           │
# │ `scripts/` is not. Making it STRUCTURALLY unreachable beats documenting  │
# │ that it must not be reached — and `test/sweep-shared-tmp.test.ts`        │
# │ asserts the verb does not resolve and that no `src/` module references   │
# │ this file, so the property is checked rather than merely asserted here.  │
# │                                                                          │
# │ It is invoked ONLY by a separate, supervised, bounded loop: `nice -n 19`,│
# │ at most one pass hourly, on the CONTROL POD ONLY (one sweeper, never two │
# │ racing over a shared PVC), holding its own lock.                         │
# └──────────────────────────────────────────────────────────────────────────┘
#
# SAFETY MODEL (modelled on /opt/bootstrap/reap-worktrees.sh, the box's existing
# precedent for a conservative reclaim job):
#   * DRY-RUN by default: prints the plan and changes nothing. Pass --apply.
#   * EXIT 0 ALWAYS — a reaper must never wedge a boot or a supervised loop.
#     Per-item failures are logged, never fatal.
#   * REFUSES outright if the resolved root is not strictly under /workspace.
#     A misconfigured root must abort, never widen the blast radius.
#   * Touches ONLY direct children of the root matching `acpx-*`. It never
#     removes the root itself and never recurses outside it. Symlinked children
#     are never followed and never removed.
#   * SKIPS any directory at or containing a LIVE PROCESS's cwd (/proc scan) —
#     cheap insurance against reaping an active gate's HOME whose files happen
#     to be older than the window.
#   * RESOLVES THE ROOT FROM THE WRITER'S OWN MODULE, never a re-typed literal
#     (see resolve_root below).
#   * Logs every removal with path, age and reclaimed bytes.
#
# USAGE:
#   sweep-shared-tmp.sh                  # dry-run: show what WOULD be removed
#   sweep-shared-tmp.sh --apply          # actually remove
#   sweep-shared-tmp.sh --root <path>    # operator/test override (still must be
#                                        #   under /workspace; goes through the
#                                        #   module's own precedence)
#   sweep-shared-tmp.sh --log <file>     # also append to a log file
#
# EXIT: 0 always.

set -uo pipefail

RETENTION_DAYS=7
APPLY=0
ROOT_OVERRIDE=''
LOG_FILE=''

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
# The writer's module — resolved relative to THIS script, so the deployed copy
# reads the deployed module and the two cannot drift apart.
ROOT_MODULE="$REPO_ROOT/src/acp/session-shared-tmp-dir.ts"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --root)  ROOT_OVERRIDE="${2:-}"; shift ;;
    --log)   LOG_FILE="${2:-}"; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 0 ;;  # exit 0: never wedge the loop
  esac
  shift
done

ts() { date -u +%FT%TZ; }
log() {
  local line="$*"
  printf '%s\n' "$line"
  [ -n "$LOG_FILE" ] && printf '[%s] %s\n' "$(ts)" "$line" >> "$LOG_FILE"
  return 0
}

# --- 1. Resolve the root FROM THE WRITER'S MODULE. ----------------------------
# `harness-config-dir-root.ts` exists because a sweep that disagrees with its
# writer produces "a truthful, cheap, entirely clean census over an empty
# directory while the real population sits elsewhere" — a sweeper that reports
# success while reclaiming nothing, with no error anywhere. So the root is not
# re-typed here: node IMPORTS the module and calls its own
# `resolveSessionSharedTmpRoot`, which means the override flag, the
# `ACPX_SESSION_SHARED_TMP_ROOT` variable and the default all follow exactly the
# precedence the writer follows, forever, including changes nobody told this
# script about.
#
# Node 22 strips TypeScript types natively (measured: v22.23.2 imports this .ts
# module directly), and `src/` is present in the deployed install — that tree is
# a git clone reset to origin/<ref> by bootstrap.sh, not an npm-packed tarball,
# so package.json's `files` list does not apply to it.
#
# FAIL CLOSED: if the module cannot be read, we do not fall back to a literal
# and we do not guess. A sweeper that cannot establish its own root must do
# nothing at all.
resolve_root() {
  if [ ! -f "$ROOT_MODULE" ]; then
    log "ABORT: writer module not found at $ROOT_MODULE — refusing to guess a root."
    return 1
  fi
  ACPX_SWEEP_ROOT_OVERRIDE="$ROOT_OVERRIDE" node --input-type=module -e '
    const mod = await import(process.env.ACPX_SWEEP_ROOT_MODULE);
    const explicit = process.env.ACPX_SWEEP_ROOT_OVERRIDE || undefined;
    process.stdout.write(mod.resolveSessionSharedTmpRoot(explicit));
  ' 2>/dev/null
}

export ACPX_SWEEP_ROOT_MODULE="$ROOT_MODULE"
ROOT="$(resolve_root)" || exit 0
if [ -z "$ROOT" ]; then
  log "ABORT: could not resolve the tier-2 root from $ROOT_MODULE — nothing swept."
  exit 0
fi

# --- 2. Refuse any root that is not strictly under /workspace. ----------------
# Checked on the CANONICAL path where one exists, so `..` segments and a
# symlinked root cannot smuggle the sweep out of /workspace. `/workspace` itself
# is refused as emphatically as `/` would be: the glob below would then run over
# the shared project tree.
CANON_ROOT="$ROOT"
if [ -e "$ROOT" ]; then
  CANON_ROOT="$(readlink -f -- "$ROOT" 2>/dev/null || printf '%s' "$ROOT")"
fi
case "$CANON_ROOT" in
  /workspace/?*) : ;;
  *)
    log "REFUSE: resolved root '$ROOT' (canonical '$CANON_ROOT') is not under /workspace — aborting without touching anything."
    exit 0
    ;;
esac
ROOT="$CANON_ROOT"

if [ ! -d "$ROOT" ]; then
  log "Nothing to do: root $ROOT does not exist yet."
  exit 0
fi

# --- 3. Build the PROTECTED set: cwd of every live process, under the root. ---
# Same guard as reap-worktrees.sh. Best-effort by nature: pids race away
# mid-scan and some cwds are unreadable — those are skipped, which is the safe
# direction only because it merely shrinks the protection set for processes that
# are already gone.
declare -a PROC_CWDS=()
for _link in /proc/[0-9]*/cwd; do
  _pid="${_link#/proc/}"; _pid="${_pid%/cwd}"
  _cwd="$(readlink "$_link" 2>/dev/null)" || continue
  [ -n "$_cwd" ] || continue
  case "$_cwd" in "$ROOT"/*) PROC_CWDS+=("$_pid $_cwd") ;; esac
done
log "Loaded ${#PROC_CWDS[@]} live process cwds under $ROOT from /proc (protected)."

# path_under A B → 0 if A == B or A is inside B.
path_under() {
  [ "$1" = "$2" ] && return 0
  case "$1" in "$2"/*) return 0;; esac
  return 1
}

# --- 4. Warn about anything in the root that is not ours. ---------------------
# This is the whole reason the root is `/workspace/.session-scratch` and not the
# pre-existing, hand-made `/workspace/.scratch`: an EXCLUSIVELY acpx-owned root
# lets the sweeper assert that every child matches `acpx-*` and flag anything
# else. That assertion is unavailable the moment the root is shared with
# hand-made files. A stray entry is never removed — it is reported, because it
# means either a hand-rolled file landed in acpx's root or something writes here
# under a name the retention policy cannot see.
shopt -s nullglob dotglob
stray=0
for entry in "$ROOT"/*; do
  case "$(basename -- "$entry")" in
    acpx-*) : ;;
    *) log "WARN  unexpected non-acpx-* entry in the tier-2 root, NOT touched: $entry"; stray=$((stray+1)) ;;
  esac
done
shopt -u dotglob

# --- 5. Walk the acpx-* children and apply the retention policy. --------------
CUTOFF_EPOCH=$(( $(date +%s) - RETENTION_DAYS * 86400 ))
removed=0 kept=0 failed=0 considered=0 reclaimed=0

for child in "$ROOT"/acpx-*; do
  considered=$((considered+1))

  # A symlink is never followed and never removed: `rm -rf` on one would remove
  # only the link, but the mtime walk would read a subtree that is not ours.
  if [ -L "$child" ]; then
    log "SKIP  $child  (symlink — never followed, never removed)"
    kept=$((kept+1)); continue
  fi
  if [ ! -d "$child" ]; then
    log "SKIP  $child  (not a directory)"
    kept=$((kept+1)); continue
  fi

  # A live process's cwd at or inside this directory.
  protected=''
  for s in "${PROC_CWDS[@]:-}"; do
    [ -n "$s" ] || continue
    pid="${s%% *}"; cwd="${s#* }"
    if path_under "$cwd" "$child"; then protected="live process cwd (pid=$pid)"; break; fi
  done
  if [ -n "$protected" ]; then
    log "SKIP  $child  (protected: $protected)"
    kept=$((kept+1)); continue
  fi

  # UNTOUCHED = newest mtime ANYWHERE IN THE SUBTREE, not the directory's own
  # mtime — a directory's mtime only tracks its direct entries, so a busy
  # subdirectory under an otherwise-static parent would read as abandoned.
  # `-print -quit` stops at the FIRST recent entry, so the common case (a live
  # directory) costs almost nothing.
  if [ -n "$(find "$child" -newermt "@$CUTOFF_EPOCH" -print -quit 2>/dev/null)" ]; then
    log "KEEP  $child  (touched within ${RETENTION_DAYS}d)"
    kept=$((kept+1)); continue
  fi

  # Only now — for a directory we are actually going to remove — pay for the
  # full walk that gives the ledger its age and size.
  newest=$(find "$child" -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
  newest=${newest%%.*}
  [ -n "$newest" ] || newest=0
  age_days=$(( ( $(date +%s) - newest ) / 86400 ))
  size=$(du -sb "$child" 2>/dev/null | cut -f1)
  [ -n "$size" ] || size=0

  if [ "$APPLY" -eq 1 ]; then
    if rm -rf -- "$child" 2>/tmp/sweep-shared-tmp-err.$$; then
      log "REMOVE  $child  (age=${age_days}d, reclaimed=${size} bytes)"
      removed=$((removed+1)); reclaimed=$((reclaimed+size))
    else
      log "FAIL    $child  ($(tr '\n' ' ' < /tmp/sweep-shared-tmp-err.$$))"
      failed=$((failed+1))
    fi
    rm -f /tmp/sweep-shared-tmp-err.$$
  else
    log "WOULD-REMOVE  $child  (age=${age_days}d, reclaimable=${size} bytes)"
    removed=$((removed+1)); reclaimed=$((reclaimed+size))
  fi
done
shopt -u nullglob

verb="WOULD remove"; [ "$APPLY" -eq 1 ] && verb="removed"
log "SUMMARY: root=$ROOT considered=$considered ${verb}=$removed kept=$kept failed=$failed stray=$stray bytes=$reclaimed retention=${RETENTION_DAYS}d mode=$([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
exit 0
