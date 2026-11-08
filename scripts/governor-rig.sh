#!/usr/bin/env bash
# governor-rig.sh — the §10 test rig of the runaway process-tree governor (brick 5d7a23b6, CONCEPTION v1.2 §10):
# a full, isolated acpx + atrium stack (the devn-slot FULL-STACK recipe, /wisdom/Projects/acpx-ui/skills/devn-slot/
# reference/full-stack.md) running THIS branch's acpx with its own HOME, plus the governor in test mode
# (ACPX_GOVERNOR_TEST=1 --test-rig, ACPX_GOVERNOR_ATRIUM_URL = the rig's atrium) — ALL IN THE CALLER'S OWN
# WORKBENCH, so the storms, the governor and the harness's /proc sampler share one pod.
#
# Run every command from your OWN agent session's shell on the control plane (never through ssh-remote: the
# workbench is your seat's). ONE command stands the rig up from nothing:
#
#   bash scripts/governor-rig.sh all --root /workspace/projects/acpx-ui/.environments/gov-rig-<you> --slot <N>
#
# or step by step:
#   create  --root <dir> --slot <N> [--name <n>] [--template <root>] [--ui-commit <sha>]  instance, worktrees, secrets
#   build   --config <root>/stack.conf          build-all.sh in the workbench (5 repos, ~10 min the first time)
#   seed    --config …                          bricks-seed.mjs (one time) + gen-os-runtime.sh (the OS copy)
#   up      --config … [--limit-bytes auto|N]   stack up under `ulimit -u 2000`, then the governor
#   governor --config … [--limit-bytes auto|N]  (re)start ONLY the governor (timeout -s KILL 900 — restart per AC)
#   agent   --config … new "<prompt>" | say <id> "<text>" | show <id> [n]   a real Claude session in the rig
#   sampler --config … start | report          the harness's own 50 ms /proc sampler (AC1 a/f, AC2) — 900 s max
#   orphan  --config … <sid>                    AC2: cut every parent link of a storm (TaskStop's remainder)
#   spawn-system --config … [N]                 AC5(iii): N children INSIDE the governor's own (system) session
#   scan    --config … [--format json]          `acpx governor scan` of the rig (find a storm's sid)
#   status  --config …                          heartbeat, last events, atrium
#   down    --config …                          governor, sampler, then the stack (ensure-down.sh)
#
# Exit: 0 ok · 2 usage/config · 64 wrong pod · else the failing step's rc.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)              # this acpx worktree
SELF="$HERE/scripts/governor-rig.sh"
FS_DIR=/wisdom/Projects/acpx-ui/skills/devn-slot/scripts/full-stack
DEFAULT_TEMPLATE=/workspace/projects/acpx-ui/.environments/mu-stack
GIB=1073741824

die() { echo "governor-rig: $*" >&2; exit 2; }
ts() { date -u +%FT%TZ; }
role() { cat /etc/nativai/image-role 2>/dev/null || true; }
on_control() { [ "$(role)" != workbench ] || { echo "governor-rig: run this on the control plane" >&2; exit 64; }; }
on_workbench() { [ "$(role)" = workbench ] || { echo "governor-rig: this step runs inside the workbench" >&2; exit 64; }; }

load() { # load()   sets CONF and sources it (the full-stack lib does the refusals)
  [ -n "${CONF:-}" ] || die "--config <root>/stack.conf is required"
  # shellcheck disable=SC1091
  . "$FS_DIR/lib.sh"
  stack_load_config --config "$CONF"
  ACPX_WT="$P/acpx/$STACK_NAME"
  GOV_HOME="$SLOT_HOME/.acpx/governor"
}

# ── create ─────────────────────────────────────────────────────────────────────────────────────────────
cmd_create() {
  on_control
  local root="" slot="" name="" template="$DEFAULT_TEMPLATE" ui=""
  while [ $# -gt 0 ]; do case "$1" in
    --root) root=$2; shift 2 ;; --slot) slot=$2; shift 2 ;; --name) name=$2; shift 2 ;;
    --template) template=$2; shift 2 ;; --ui-commit) ui=$2; shift 2 ;; *) die "create: unknown argument $1" ;; esac; done
  [ -n "$root" ] && [ -n "$slot" ] || die "create needs --root <dir> --slot <N>"
  case "$root" in /workspace/*) ;; *) die "--root must be under /workspace" ;; esac
  [ ! -e "$root" ] || die "$root exists — use --config $root/stack.conf with the other commands"
  [[ "$slot" =~ ^[1-9]$|^10$ ]] || die "--slot is 1..10"
  name=${name:-$(basename "$root")}
  [ -f "$template/stack.conf" ] || die "template $template has no stack.conf"
  local acpx_sha; acpx_sha=$(git -C "$HERE" rev-parse HEAD)
  git -C "$HERE" merge-base --is-ancestor HEAD "origin/$(git -C "$HERE" rev-parse --abbrev-ref HEAD)" 2>/dev/null \
    || echo "governor-rig: NOTE acpx HEAD ${acpx_sha:0:12} is not on its pushed branch"
  # The template's values for everything but the instance's own identity, ports and the acpx commit.
  local T_SUB T_CODEX T_UI T_CAA T_CODEXACP T_PTY T_FQDN T_INT T_NS T_ATRIUM T_PROBE T_PROJECTS
  eval "$(bash -c '. "$1"
    printf "T_SUB=%q T_CODEX=%q T_UI=%q T_CAA=%q T_CODEXACP=%q T_PTY=%q\n" "$STACK_SUBSCRIPTION" "$STACK_CODEX_PROFILE" \
      "$STACK_COMMIT_ACPX_UI" "$STACK_COMMIT_CLAUDE_AGENT_ACP" "$STACK_COMMIT_CODEX_ACP" "$STACK_COMMIT_CLAUDE_PTY_ACP"
    printf "T_FQDN=%q T_INT=%q T_NS=%q T_ATRIUM=%q T_PROBE=%q T_PROJECTS=%q\n" "$STACK_BOX_FQDN" "$STACK_BOX_FQDN_INT" \
      "$STACK_BOX_NAMESPACE" "$STACK_BOX_ATRIUM_URL" "$STACK_PROBE_BOX_BRICK" "$STACK_PROJECTS"' x "$template/stack.conf")"
  [ -d "$template/secrets/$T_SUB" ] || die "template has no staged subscription secrets/$T_SUB"
  # atrium: the acpx-ui this BOX runs in production (compatible with an acpx cut from dev), unless --ui-commit.
  # The template's own acpx-ui may be a programme branch built against a different acpx.
  [ -n "$ui" ] || ui=$(python3 -I -c 'import json;print(json.load(open("/data/runtime/info.json"))["acpx-ui"]["sha"])' 2>/dev/null || true)
  T_UI=${ui:-$T_UI}
  mkdir -p "$root"/{home/.acpx/subscriptions,logs,run}
  install -d -m 700 "$root/secrets"
  cat > "$root/stack.conf" <<CONF
# governor rig (brick 5d7a23b6) — created $(ts) by governor-rig.sh from template $template
STACK_ROOT=$root
STACK_NAME=$name
STACK_PROJECTS=$T_PROJECTS
STACK_SLOT=$slot
STACK_EDGE_PORT=$((2999 + slot))
STACK_MAIN_PORT=$((3100 + slot * 10))
STACK_PURPOSE='governor rig (brick 5d7a23b6)'
STACK_WORKBENCH_SIZE=6g
STACK_BRICKS_PORT=$((8100 + slot * 10))
STACK_BRICKS_MAINT_PORT=$((8101 + slot * 10))
STACK_BRICKS_TELEMETRY_PORT=$((8102 + slot * 10))
STACK_REALM=$name
STACK_BOX_FQDN=$T_FQDN
STACK_BOX_FQDN_INT=$T_INT
STACK_BOX_NAMESPACE=$T_NS
STACK_BOX_ATRIUM_URL=$T_ATRIUM
STACK_PROBE_BOX_BRICK=$T_PROBE
STACK_SUBSCRIPTION=$T_SUB
STACK_CODEX_PROFILE=$T_CODEX
STACK_COMMIT_ACPX_UI=$T_UI
STACK_COMMIT_ACPX=$acpx_sha
STACK_COMMIT_CLAUDE_AGENT_ACP=$T_CAA
STACK_COMMIT_CODEX_ACP=$T_CODEXACP
STACK_COMMIT_CLAUDE_PTY_ACP=$T_PTY
CONF
  local repo commit
  for repo in acpx-ui acpx claude-agent-acp codex-acp claude-pty-acp; do
    case "$repo" in acpx-ui) commit=$T_UI ;; acpx) commit=$acpx_sha ;; claude-agent-acp) commit=$T_CAA ;;
      codex-acp) commit=$T_CODEXACP ;; claude-pty-acp) commit=$T_PTY ;; esac
    git --git-dir="$T_PROJECTS/$repo/.bare" fetch -q origin
    git --git-dir="$T_PROJECTS/$repo/.bare" worktree add -q --detach "$T_PROJECTS/$repo/$name" "$commit"
    git --git-dir="$T_PROJECTS/$repo/.bare" worktree lock --reason "governor rig $root (brick 5d7a23b6)" "$T_PROJECTS/$repo/$name"
  done
  # Secrets: the ONE staged Claude subscription and the Codex quota reading (Codex itself is not used by the rig).
  cp -a "$template/secrets/$T_SUB" "$root/secrets/$T_SUB"
  [ -f "$template/secrets/codex-quota.json" ] && install -m 600 "$template/secrets/codex-quota.json" "$root/secrets/"
  # The subscription registry: the template's, its paths moved to this instance, only the staged Claude profile.
  python3 -I - "$template" "$root" "$T_SUB" <<'PY'
import json, sys
template, root, sub = sys.argv[1:]
src = json.load(open(f"{template}/home/.acpx/subscriptions/registry.json"))
text = json.dumps(src).replace(template, root)
reg = json.loads(text)
reg["profiles"] = [p for p in reg.get("profiles", []) if p.get("id") == sub]
reg["default"] = sub
reg.pop("quarantined", None)
with open(f"{root}/home/.acpx/subscriptions/registry.json", "w") as fh:
    json.dump(reg, fh, indent=1)
PY
  chmod 600 "$root/home/.acpx/subscriptions/registry.json"
  git clone -q --no-hardlinks "$template/os-src" "$root/os-src"
  cat > "$root/README" <<README
governor rig — brick 5d7a23b6 (impl 953a461e). Created $(ts) by $SELF.
owner seat: ${ACPX_SEAT_URL:-<unknown>}
Template: $template (os-src, the staged subscription $T_SUB, the registry). acpx = $acpx_sha (governor branch).
Commands: bash $SELF <build|seed|up|governor|agent|sampler|orphan|spawn-system|status|down> --config $root/stack.conf
Remove when the brick is done: down, then git worktree unlock+remove the five '$name' worktrees, then this folder.
README
  echo "$(ts) created $root (slot $slot, main port $((3100 + slot * 10)), realm $name, acpx ${acpx_sha:0:12})"
}

# ── build / seed / up ──────────────────────────────────────────────────────────────────────────────────
# A long workbench job: detached (its output is written INSIDE the workbench), followed here until its exit line.
run_detached() { # run_detached <size> <cmd…>
  local size=$1 out log rc; shift
  out=$(workbench-exec --size "$size" --detach -- "$@" 2>&1); echo "$out"
  log=$(printf '%s\n' "$out" | sed -n 's/.* log=\([^ ]*\) .*/\1/p' | head -1)
  [ -n "$log" ] || die "workbench-exec --detach printed no log path"
  until grep -q '^workbench-exec: exit=' "$log" 2>/dev/null; do sleep 10; done
  tail -n 12 "$log"; rc=$(sed -n 's/^workbench-exec: exit=//p' "$log" | tail -1); return "${rc:-1}"; }

cmd_build() { on_control; load; cd "$STACK_ROOT"
  run_detached 6g bash "$FS_DIR/build-all.sh" --config "$STACK_CONFIG" install; }

cmd_seed() { on_control; load; cd "$STACK_ROOT"
  if [ ! -s "$SEC/bricks/realm-token" ]; then workbench-exec -- node "$FS_DIR/bricks-seed.mjs" --config "$STACK_CONFIG"; fi
  bash "$FS_DIR/gen-os-runtime.sh" --config "$STACK_CONFIG"
  echo on > "$RUN/os-seams.on"; }

limit_arg() { # limit_arg auto|N|"" -> the --limit-bytes value (auto = the workbench's C now + 1.5 GiB, §10 AC4)
  case "${1:-}" in
    "") echo "" ;;
    auto) awk -v add=$((GIB * 3 / 2)) '$1=="anon"{a=$2} $1=="kernel"{k=$2} END{printf "%.0f\n", a+k+add}' /sys/fs/cgroup/memory.stat ;;
    *) [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "--limit-bytes is auto or a byte count"; echo "$1" ;;
  esac; }

cmd_up() { on_control; load; cd "$STACK_ROOT"
  local limit=${1:-}
  local Q=$SEC/codex-quota.json
  curl -fsS "$STACK_BOX_ATRIUM_URL/api/usage/codex/quota" -o "$Q.new" 2>/dev/null && chmod 600 "$Q.new" && mv "$Q.new" "$Q" || true
  [ -s "$Q" ] || die "no $Q (the stack's atrium refuses to start without a Codex quota reading)"
  # RLIMIT_NPROC is inherited: atrium, every owner, adapter, claude and every tool command of the rig get it.
  workbench-exec --size "$STACK_WORKBENCH_SIZE" -- bash -c 'ulimit -u 2000 && exec bash "$1" --config "$2"' x \
    "$FS_DIR/ensure-up.sh" "$STACK_CONFIG"
  cmd_governor "$limit"; }

# ── the governor: its own session IS the rig's system session (§10) ────────────────────────────────────
cmd_governor() { on_control; load; cd "$STACK_ROOT"
  workbench-exec -- bash "$SELF" _wb-governor --config "$STACK_CONFIG" "${1:-}"; }

wb_governor() { on_workbench; load
  [ -f "$ACPX_WT/dist/capacity/governor/main.js" ] || die "no $ACPX_WT/dist/capacity/governor/main.js — build first"
  wb_governor_stop
  local limit; limit=$(limit_arg "${1:-}")
  rm -f "$RUN/governor.ctl"; mkfifo -m 600 "$RUN/governor.ctl"
  ulimit -u 2000
  setsid -f bash "$SELF" _wb-launcher --config "$STACK_CONFIG" "$limit" < /dev/null >> "$R/logs/governor-launcher.log" 2>&1
  for _ in $(seq 1 50); do [ -s "$GOV_HOME/heartbeat.json" ] && [ -s "$RUN/governor.pid" ] && break; sleep 0.2; done
  echo "$(ts) governor pid $(cat "$RUN/governor.pid" 2>/dev/null) limit=${limit:-real} log $R/logs/governor.log"
  tail -3 "$R/logs/governor.log" || true; }

wb_launcher() { # runs as its own session leader: the rig's SYSTEM session (never governed)
  load; local limit=${1:-} args=(--test-rig)
  [ -n "$limit" ] && args+=(--limit-bytes "$limit")
  echo $$ > "$RUN/governor-launcher.pid"
  cd /
  env HOME="$SLOT_HOME" ACPX_STATE_HOME="$SLOT_HOME" ACPX_GOVERNOR_TEST=1 \
      ACPX_GOVERNOR_ATRIUM_URL="$MAIN_URL" \
      timeout -s KILL 900 node --max-old-space-size=64 "$ACPX_WT/dist/capacity/governor/main.js" "${args[@]}" \
      >> "$R/logs/governor.log" 2>&1 < /dev/null &
  local gov=$!
  echo "$gov" > "$RUN/governor.pid"
  # When the governor ends (timeout -s KILL 900, or a refusal), the launcher ends too.
  ( while kill -0 "$gov" 2>/dev/null; do sleep 2; done; echo stop > "$RUN/governor.ctl" ) &
  # The control channel: `spawn-system N` runs N children IN THIS SESSION (AC5 iii); `stop` ends the rig governor.
  while read -r line < "$RUN/governor.ctl"; do
    case "$line" in
      spawn-system\ *) n=${line#spawn-system }; [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -le 400 ] || continue
        bash -c 'for i in $(seq "$1"); do sleep 120 & done; wait' x "$n" > /dev/null 2>&1 &
        echo "$(ts) launcher: spawned a $n-child process in the system session (pid $!)" ;;
      stop) kill -TERM "$(cat "$RUN/governor.pid")" 2>/dev/null || true; break ;;
    esac
  done
  wait; }

wb_governor_stop() { load
  local lp; lp=$(cat "$RUN/governor-launcher.pid" 2>/dev/null || true)
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then
    [ -p "$RUN/governor.ctl" ] && { echo stop > "$RUN/governor.ctl" & sleep 2; }
    kill -TERM -- "-$lp" 2>/dev/null || true
  fi
  rm -f "$RUN/governor.pid" "$RUN/governor-launcher.pid"; }

cmd_spawn_system() { on_control; load
  workbench-exec -- bash -c 'echo "spawn-system $2" > "$1"' x "$RUN/governor.ctl" "${1:-200}"; }

# ── a real agent in the rig (the rig atrium's own API, from inside the workbench) ──────────────────────
cmd_agent() { on_control; load; workbench-exec -- bash "$SELF" _wb-agent --config "$STACK_CONFIG" "$@"; }
wb_agent() { on_workbench; load
  local sub=${1:-}; shift || true
  case "$sub" in
    new) node -e 'const [s,n,p]=process.argv.slice(1);console.log(JSON.stringify({agentType:"claude",subscriptionId:s,name:n,initialPrompt:p,noBrick:true}))' \
           "$STACK_SUBSCRIPTION" "governor rig $(date -u +%H%M%S)" "$1" \
         | curl -sS -X POST -H 'content-type: application/json' --data-binary @- "$MAIN_URL/api/sessions" \
         | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.sessionId?`session ${r.sessionId}`:s.slice(0,300))})' ;;
    say) node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$2" \
         | curl -sS -o /dev/null -w 'prompt POST -> %{http_code}\n' -X POST -H 'content-type: application/json' --data-binary @- "$MAIN_URL/api/sessions/$1/prompt" ;;
    show) curl -s "$MAIN_URL/api/sessions/$1/messages?anchor=last_clear&limit=${2:-30}" | node -e '
          let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of (JSON.parse(s).messages||[])){
          const t=typeof m.content==="string"?m.content:JSON.stringify(m.blocks||m.content||"");
          console.log(`--- ${m.role} ${m.from||""}\n${t.slice(0,4000)}`)}})' ;;
    *) die "agent new \"<prompt>\" | say <id> \"<text>\" | show <id> [n]" ;;
  esac; }

# ── the harness's own sampler (AC1 a/f, AC2): never the governor's log ─────────────────────────────────
cmd_sampler() { on_control; load
  case "${1:-}" in
    start) workbench-exec -- bash -c 'ulimit -u 2000; cd /; setsid -f timeout -s KILL 900 python3 -I "$1" "$2" "$3" > /dev/null 2>&1 < /dev/null' x \
             "$HERE/scripts/governor-rig-sampler.py" "$GOV_HOME/heartbeat.json" "$R/logs/sampler.jsonl"
           echo "$(ts) sampler started (900 s max) -> $R/logs/sampler.jsonl" ;;
    report) python3 -I "$HERE/scripts/governor-rig-sampler.py" --report "$R/logs/sampler.jsonl" ;;
    *) die "sampler start | report" ;;
  esac; }

# ── AC2: cut every parent link of a storm — what TaskStop left on 2026-11-08 ───────────────────────────
cmd_orphan() { on_control; load; [[ "${1:-}" =~ ^[0-9]+$ ]] || die "orphan <sid>"
  workbench-exec -- python3 -I "$HERE/scripts/governor-rig-sampler.py" --orphan "$1"; }

# `acpx governor scan` of the RIG's workbench, with the rig's HOME (its leases, records and governor memory).
cmd_scan() { on_control; load
  workbench-exec -- env HOME="$SLOT_HOME" ACPX_STATE_HOME="$SLOT_HOME" node "$ACPX_WT/dist/cli.js" governor scan "$@"; }

cmd_status() { on_control; load
  echo "== governor heartbeat"; cat "$GOV_HOME/heartbeat.json" 2>/dev/null || echo "(none)"
  echo "== last events"; tail -n 8 "$GOV_HOME/events.ndjson" 2>/dev/null | cut -c1-400 || true
  echo "== atrium"; workbench-exec -- curl -s -o /dev/null -w '%{http_code}\n' "$MAIN_URL/api/config" || true; }

cmd_down() { on_control; load; cd "$STACK_ROOT"
  workbench-exec -- bash "$SELF" _wb-governor-stop --config "$STACK_CONFIG" || true
  workbench-exec -- bash "$FS_DIR/ensure-down.sh" --config "$STACK_CONFIG"; }

cmd_all() { on_control
  local root="" slot="" rest=()
  while [ $# -gt 0 ]; do case "$1" in --root) root=$2; rest+=("$1" "$2"); shift 2 ;; --slot) slot=$2; rest+=("$1" "$2"); shift 2 ;;
    *) rest+=("$1"); shift ;; esac; done
  [ -n "$root" ] || die "all needs --root <dir> --slot <N>"
  [ -f "$root/stack.conf" ] || cmd_create "${rest[@]}"
  CONF="$root/stack.conf"
  local st="$root/logs/build-status.txt"
  if ! [ -s "$st" ] || grep -qv ' rc=0$' "$st"; then cmd_build; fi
  cmd_seed
  cmd_up ""
  cmd_status; }

# ── dispatch ───────────────────────────────────────────────────────────────────────────────────────────
sub=${1:-}; shift || true
CONF=""; ARGV=()
while [ $# -gt 0 ]; do case "$1" in --config) CONF=$2; shift 2 ;; --config=*) CONF=${1#--config=}; shift ;;
  --limit-bytes) ARGV+=("$2"); shift 2 ;; *) ARGV+=("$1"); shift ;; esac; done
set -- "${ARGV[@]+"${ARGV[@]}"}"
case "$sub" in
  create) cmd_create "$@" ;; all) cmd_all "$@" ;; build) cmd_build ;; seed) cmd_seed ;; up) cmd_up "${1:-}" ;;
  governor) cmd_governor "${1:-}" ;; spawn-system) cmd_spawn_system "${1:-200}" ;; agent) cmd_agent "$@" ;;
  sampler) cmd_sampler "${1:-}" ;; orphan) cmd_orphan "${1:-}" ;; status) cmd_status ;; down) cmd_down ;;
  scan) cmd_scan "$@" ;;
  _wb-governor) wb_governor "${1:-}" ;; _wb-launcher) wb_launcher "${1:-}" ;; _wb-governor-stop) wb_governor_stop ;;
  _wb-agent) wb_agent "$@" ;;
  *) sed -n '2,32p' "$SELF"; exit 2 ;;
esac
