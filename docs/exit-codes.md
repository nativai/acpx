---
title: Exit codes
description: Stable acpx exit codes for scripting — success, runtime errors, usage errors, timeouts, no-session, permission denial, and interrupts.
---

`acpx` uses a small, stable set of exit codes so wrapping scripts can branch on them.

| Code  | Meaning                                                             |
| ----- | ------------------------------------------------------------------- |
| `0`   | Success                                                             |
| `1`   | Agent / protocol / runtime error                                    |
| `2`   | CLI usage error (bad flags, conflicting flags, malformed `--agent`) |
| `3`   | Timeout (`--timeout` exceeded)                                      |
| `4`   | No session found (prompt requires an explicit `sessions new`)       |
| `5`   | Permission denied (every request denied/cancelled, none approved)   |
| `75`  | No capacity: nothing ran (`capacity --need N`, a gated create)      |
| `130` | Interrupted (`SIGINT` / `SIGTERM`)                                  |

## Notes

- **`0`** is also returned by `cancel` when there is nothing to cancel. The text/JSON output makes the distinction.
- **`1`** is the catch-all for adapter errors, transport failures, and unexpected runtime errors. Stderr or the JSON error envelope contains details.
- **`2`** signals "you typed something `acpx` cannot run" — combining `--agent` with a positional agent token, mutually exclusive permission flags, missing required arguments, etc.
- **`3`** is reserved for `--timeout` expiry. Adapter-side timeouts that are not surfaced as `acpx` timeouts come through as `1`.
- **`4`** is the "no session id given" signal. Pass `--session-id <id>`, or run `sessions new` to create one and retry.
- **`5`** only fires when at least one permission request happened, and every one ended in a denial or cancellation. If at least one was approved, the result reflects whatever the agent returned.
- **`75`** means "temporary, nothing ran, try again later" — the same meaning as `workbench-exec`'s 75. `acpx capacity --need N` returns it when fewer than N new sessions of `--agent` fit in the box's memory. An agent's `sessions new` / `copy` / `--from-template` returns it when the same check (`--need 1`) fails, before anything is created — stderr starts `acpx: REFUSED reason=<no_capacity|memory_pressure|node_pressure|admission_busy> nothing_started=true`, ends `queued_ahead=<n>`, and `--format json` carries `acpxCode: "CAPACITY"` with the capacity snapshot and `queuedAhead`. A human's create from atrium, and a handover successor, are never refused; an unconfigured box (no `/etc/podinfo`) never returns it.
  - **Automation.** Atrium creates wakeup and brick-trigger sessions with `ACPX_ADMISSION_CLASS=automation`; they are gated by the same check and get the same exit 75, and atrium then keeps them in its queue until room frees. `automation` is never inferred.
  - **Queued automation goes first.** Atrium publishes what waits in `<admission dir>/waiting/<writer>.json` (schema in the header of `src/capacity/waiting.ts`; a file counts while it is less than 5 minutes old). An agent's slots — in the gate and in `acpx capacity` (class `spawn`, the default) — are net of that count, so `queued_ahead=<n>` on an agent's refusal means n automation sessions start before the agent's next create. `acpx capacity --class automation` reports the gross slots; both classes list what waits (`waiting` in JSON, a `waiting:` line in text).
  - **Reservations.** An admitted create reserves its harness's memory until its session's owner appears. Once the record exists, the reservation outlives the `sessions new` process: 10 minutes for `automation`, 180 s for every other class. While the owner lives, the owner is charged at least the reservation; once the session has run a turn or is closed, the reservation stops counting as soon as no owner is live. A prompt-less `sessions new` therefore holds its room for up to 180 s; pass `--prompt-file` to start the owner at once.
- **`130`** matches the conventional shell signal exit code for `Ctrl+C` (`128 + SIGINT`). `acpx` cancels cooperatively before exiting with this code.

## Branching example

```bash
if acpx --format quiet codex 'one-line summary' >summary.txt; then
  echo "ok"
else
  case $? in
    2)   echo "usage error" ;;
    3)   echo "timed out"   ;;
    4)   echo "no session — run sessions new"; acpx codex sessions new ;;
    5)   echo "all denied"  ;;
    130) echo "interrupted" ;;
    *)   echo "agent or runtime error" ;;
  esac
fi
```

## See also

- [Permissions](permissions.md) — what makes exit `5` happen.
- [Sessions](sessions.md) — what makes exit `4` happen and how to fix it.
- [Prompting](prompting.md) — `--timeout` and `--no-wait` semantics.
