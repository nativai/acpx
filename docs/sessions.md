---
title: Sessions
description: Persistent multi-turn ACP sessions in acpx — scope rules, named sessions, soft-close, prune, queue ownership, and crash recovery.
---

`acpx` sessions are how multi-turn agent conversations survive between invocations. A session is a JSON record on disk plus, when active, a queue owner process that holds the live ACP connection.
The session record tracks the logical conversation; the queue owner lease is the source of truth for whether `acpx` currently expects a helper process to be alive.

## Scope key

Every session is keyed by a tuple:

```text
(agentCommand, absoluteCwd, optional name)
```

That is what makes `acpx codex` in `~/repos/api` and `acpx codex` in `~/repos/web` resume different conversations, and why `-s backend` and `-s docs` can run side by side in the same repo.

`agentCommand` comes from either the built-in registry, an unknown positional name (treated as a raw command), or `--agent <command>`. Two sessions with different commands are different sessions even if everything else matches.

## Lifecycle commands

```bash
acpx codex sessions                  # list (alias for `sessions list`)
acpx codex sessions list             # list agent sessions via ACP when supported
acpx codex sessions list --filter-cwd . --cursor <cursor>
acpx codex sessions list --local     # list saved acpx records
acpx codex sessions new              # create a fresh cwd-scoped default session
acpx codex sessions new --name api   # create a fresh named session
acpx codex sessions ensure           # idempotent: existing or create
acpx codex sessions ensure --name api
acpx codex sessions show             # metadata for the cwd-scoped default
acpx codex sessions show api         # metadata for the named session
acpx codex sessions history          # last 20 turn previews
acpx codex sessions history --limit 50
acpx codex sessions export api --output api-session.json
acpx codex sessions import api-session.json --name api-restored
acpx codex sessions close            # soft-close cwd default
acpx codex sessions close api        # soft-close named session
acpx codex sessions prune --dry-run
acpx codex sessions prune 4e25443c a1b2c3d4   # the sessions you name
acpx codex sessions prune --cwd               # this directory's
acpx codex sessions prune --older-than 30
acpx codex sessions prune --before 2026-01-01
```

Top-level `acpx sessions …` defaults to `codex`.

`sessions list` prefers the agent-side ACP `session/list` method when the
selected agent advertises `sessionCapabilities.list`. JSON output includes the
agent's `SessionInfo` fields, any `_meta` metadata, and `nextCursor` for manual
pagination. Use `--filter-cwd <dir>` to send the ACP cwd filter; relative paths
resolve against global `--cwd`. Use `--local` when you specifically want the
saved `~/.acpx/sessions` records.

## Auto-resume by directory walk

Prompt commands (`acpx codex 'fix tests'`, `acpx codex prompt …`) resume an existing session rather than create one. Lookup is a directory walk:

1. Detect the nearest git root by walking up from the absolute `cwd`.
2. If a git root exists, walk from `cwd` up to that root **inclusive**, checking each directory.
3. If no git root is found, only check `cwd` exactly — no parent walk.
4. At each directory, find the first **active** (non-closed) session matching `(agentCommand, dir, optionalName)`.
5. If a local match is found, use it.
6. If an explicit name was supplied and local lookup misses, use one exact
   active global match for the selected agent. Multiple matches fail closed and
   require `--session-id` or `--session-url`.
7. Otherwise exit with code `4` and tell you to run `sessions new`.

This means most workflows feel like "I was talking to codex in this repo", regardless of whether you happen to be in `src/` or `docs/` when the next prompt fires.

```bash
cd ~/repos/api/src/auth
acpx codex 'remind me what we changed'   # resumes the session created at ~/repos/api
```

## Named sessions

`-s, --session <name>` adds the name into the creation/default-selection scope
key:

```bash
acpx codex sessions new --name backend
acpx codex sessions new --name docs
acpx codex -s backend 'fix the API pagination bug'
acpx codex -s docs    'rewrite the changelog'
```

Named sessions are independent. They do not share state, queue owners, or
history. Names are mutable display labels, not canonical identity: an
existing-session command keeps its local lookup precedence, then accepts one
exact global match for the selected agent. If that label is reused in multiple
cwds, use the immutable record ID or session URL.

## Sessions vs. ensure vs. new

| Command           | If a matching session exists  | If not                                       |
| ----------------- | ----------------------------- | -------------------------------------------- |
| `sessions new`    | Soft-close it, create a fresh | Create a fresh one                           |
| `sessions ensure` | Return it                     | Create a fresh one                           |
| (prompt commands) | Resume it                     | Exit `4` with guidance to run `sessions new` |

`new` is the explicit "I want to start over" verb. `ensure` is the idempotent "give me a session" verb for scripts. Bare prompt is conservative: it never auto-creates so you do not accidentally fork a session by running from the wrong directory.

## Soft-close

`sessions close` does not delete anything. It marks the record `closed: true` with `closedAt`, asks any active queue owner to send ACP `session/close`, and tears down adapter processes.

- Closed sessions stay on disk with their full record and history.
- Auto-resume by scope skips closed sessions.
- Closed sessions can still be loaded explicitly through embedding APIs.
- `sessions prune` is the explicit way to delete closed records.

## Export / import

`acpx` persists sessions per cwd in `~/.acpx/sessions/`. To move a session between machines or share one with a teammate:

```bash
# On the source machine:
acpx codex sessions export my-debug-session --output debug.json

# On the destination machine:
acpx codex sessions import debug.json --name debug-on-laptop
```

Export refuses to run if the session is locked by a live queue owner. Run `acpx codex sessions close my-debug-session` first.

The archive is plain JSON. Paths are stored relative to home, so an imported session lands at `~/<original-cwd-relative>` on the destination machine without embedding the source machine's absolute cwd. Override with `--cwd`.

Imports keep the archive's provider session id, reopen the copied session as an idle local record, and clear source-machine process metadata. Imported sessions must resume that provider session; if the destination agent cannot load it, prompts fail clearly instead of starting an empty conversation. If the destination already has an active session for the same `(agent, cwd, name)` scope, import fails; pass `--name` or `--cwd` to choose a different scope. If a local record already uses the same provider session id, prune or remove that record before importing.

## Prune

`sessions prune` removes closed records once you actually want them gone. It
deletes each selected session's record **and its messages sidecar** — after which
that session's transcript can never be rebuilt — so it makes you say what you
mean:

```bash
# Preview what would be deleted. Needs no scope.
acpx codex sessions prune --dry-run

# Just the ones you name — the usual case, and the operation most callers want.
acpx codex sessions prune 4e25443c a1b2c3d4

# This directory's closed sessions.
acpx codex sessions prune --cwd

# Delete closed sessions older than 30 days (by closeAt, falling back to lastUsedAt)
acpx codex sessions prune --older-than 30

# Delete closed sessions whose close time is before a date
acpx codex sessions prune --before 2026-01-01

# Every closed session for this agent on this box — the box-wide sweep.
acpx codex sessions prune --whole-box

# Keep the per-session event-stream files (they become unreachable)
acpx codex sessions prune --cwd --no-include-history
```

### Scope is required

A destructive prune with none of `<id>...`, `--cwd`, `--whole-box`,
`--older-than` or `--before` **refuses**: exit 2, nothing deleted, and it prints
copy-pasteable alternatives carrying both the box-wide count and the count in
this directory. `--dry-run` is exempt, so every preview workflow works unchanged.

`--include-templates` is **not** a scope. It widens what a scope selects — it
deletes template blueprints — so it should never be the only thing you typed.
`--no-include-history` is not a scope either; it narrows what is deleted.

### Naming sessions is all-or-nothing

Each positional id must resolve to exactly one _closed_ session — by acpx record
id, ACP session id, or unique suffix — and every session so resolved must
actually be pruned. If any id is unknown, ambiguous, still open, or excluded by a
combined age filter, the run aborts with **nothing deleted**. "Delete these four"
that quietly deletes three is the same failure as one that deletes seven.

`--cwd` matches the invocation directory by exact equality, not as a subtree, so
it will not span sibling worktrees of the same project. Ids and `--cwd` combine
as a union; an age filter then intersects the result.

### What it deletes, and what it can strand

By default a prune of a session takes **everything acpx owns or has made
unreachable**: the record, the messages sidecar, the queue-owner log
(`<id>.owner.log`), the event streams (`<id>.stream.*`) and the stream's
timestamp sidecar (`<id>.timestamps.ndjson`). Nothing is left behind for a
future reader to interpret.

Two tiers decide what `--no-include-history` changes:

| tier    | files                                                           | kept by `--no-include-history`? |
| ------- | --------------------------------------------------------------- | ------------------------------- |
| record  | `<id>.json`, `<id>.messages.ndjson`(`.stale`), `<id>.owner.log` | no — always deleted             |
| history | `<id>.stream.*`, `<id>.timestamps.ndjson`                       | **yes**                         |

The timestamp sidecar follows the _stream_ rather than the record because it is
an index **of** the stream: acpx-ui derives its path from the stream path, so
once the stream is gone the sidecar can never be opened again. Keep the stream
and the index stays with it.

**`--no-include-history` is the one way to strand files.** Selection walks the
record index, so once the record is gone **nothing can ever match those stream
files again and no later prune reclaims them**. A run that opts out prints the
file count and byte total it is leaving unreachable, before deleting anything —
on a `--dry-run` too.

> ⚠️ One file survives every prune: `<id>.delivery.json`, acpx-ui's per-session
> delivery queue. acpx does not write it, and unlike the timestamp sidecar it is
> paired to nothing acpx owns, so acpx has no ownership hook to delete it on. A
> lone `.delivery.json` is explained by the deletion manifest below, not by the
> record having vanished on its own.

### The deletion manifest — `~/.acpx/sessions/deletions.ndjson`

Every destructive prune, and every `templates rollback --delete`, appends **one
NDJSON line per destroyed session** to `~/.acpx/sessions/deletions.ndjson`:
which deleter ran, when, against what scope, which acpx session ordered it, and
the session's id, name and cwd. **If a session has vanished, grep that file
first.**

⚠️ **Match on the `id` field, not on the bare id** — `grep '"id":"<id>"'`, not
`grep <id>`. An entry's `scope` records the invocation's full id list verbatim,
so a bare id also matches **every other entry from the same multi-id run**:
`prune a b c d` writes four entries that each contain all four ids, and
`grep a deletions.ndjson` returns four lines for a one-session question. The
`id` field disambiguates correctly and `scope` recording the real invocation is
right — it is the query that has to be precise.

The line is written **before** the first unlink. If it cannot be written the run
refuses — exit 1, nothing deleted — rather than destroying sessions it cannot
account for. A `--dry-run` destroys nothing and so records nothing.

> **An entry records a deletion that was authorised and begun. The session store
> is the authority on whether it completed.**

**Read the header line before concluding anything from an absence.** The file
opens with a `manifest_open` line carrying `at` and `covers`:

```json
{
  "v": 1,
  "op": "manifest_open",
  "at": "2026-08-21T13:22:04.115Z",
  "box": "https://acpx.devbox.nativai.de",
  "covers": ["sessions_prune", "templates_rollback_delete"]
}
```

`at` dates the coverage boundary and `covers` names it, because **an absence
from this file has three causes and they are not the same**: acpx did not delete
that session; or it was deleted _before_ this file existed; or it was deleted by
a path this manifest never covered. A session deleted before `at` will never
appear here no matter how carefully you grep. Boxes are deployed independently,
so the boundary is per box — which is exactly why `at` is recorded rather than
assumed.

Entries are additive-only: consumers must ignore unknown keys, and no key
changes meaning or type. `invoker` is the one key that uses `null`, and there it
is a positive assertion — _no acpx session in the environment_, i.e. a human at
a terminal or a shell script — rather than a gap. Treat a `null` `invoker` and a
missing one as different. There is no rotation: an entry is ~300 bytes, and
recording every deletion this box has ever performed would come to ~537 KB.

Output:

- `text` — summary plus the pruned ids and close/last-used time
- `json` — `{ action, dryRun, count, bytesFreed, pruned, auditEntries }`
- `quiet` — one pruned session id per line

⚠️ `bytesFreed` keeps its exact name, type and meaning, but its **magnitude
jumps roughly 5x** now that history is deleted by default: stream files are
~82% of a session store's bytes against the messages sidecar's ~17%. That is the
change working as designed, not a contract break — but two runs either side of a
deploy will report very different numbers for the same work.

## Queue ownership

When a prompt is in flight, `acpx` becomes the **queue owner** for that session. Subsequent `acpx codex …` invocations submit through local IPC instead of starting a second adapter:

```bash
acpx codex 'run full test suite and triage failures'
# (still running)
acpx codex --no-wait 'after the suite, summarize root cause in 3 bullets'
acpx codex --no-wait 'and propose 1 follow-up fix'
```

Queue mechanics:

- Owner generates a Unix socket at `~/.acpx/queues/<hash>.sock` (named pipe on Windows) and a `<hash>.lock` ownership file.
- Sockets and lock files are owner-only.
- After the queue drains, the owner stays alive for an idle TTL (default `5400s`) so quick follow-ups do not pay the spawn cost.
- Override TTL with `--ttl <seconds>`. `--ttl 0` keeps it alive indefinitely (until idle shutdown is otherwise triggered).
- Owner generation IDs are cryptographically random so rapid restarts cannot reuse a stale generation token.

## --no-wait

By default the submitter blocks until the queued prompt completes, streaming events back. `--no-wait` returns as soon as the running queue owner acknowledges the submission. Useful for scripted "queue up follow-ups" patterns.

```bash
acpx codex --no-wait 'after the current turn ends, write the release notes'
```

## Cancelling

`Ctrl+C` during an active turn sends ACP `session/cancel` first, waits briefly for `stopReason=cancelled`, and only force-kills if cancellation does not finish in time.

The `cancel` subcommand sends the same cooperative cancel without a terminal signal:

```bash
acpx codex cancel
acpx codex cancel -s backend
```

If nothing is running, `cancel` exits success with `nothing to cancel`.

See [Session control](session-control.md) for `set-mode`, `set <key> <value>`, and `set model`.

## Crash recovery

Saved sessions may include a cached adapter PID from the last connected helper process. That PID is a runtime hint, not proof that the logical session is closed or broken. If a cached PID is gone on the next prompt:

1. `acpx` respawns the agent.
2. Attempts ACP `session/resume` with the saved provider session id when the agent advertises it, otherwise ACP `session/load`.
3. Falls back to `session/new` if reconnecting fails, transparently updating the saved record.

This makes long-running scripted sessions resilient to crashes, OS restarts, and adapter upgrades.

## Status

`acpx codex status` reports local process state:

| State        | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `running`    | Queue owner alive and processing a prompt                                        |
| `idle`       | Saved session resumable, no queue owner running                                  |
| `dead`       | Queue owner was expected but is unavailable, or the last agent exit was abnormal |
| `no-session` | No saved record matches this scope                                               |

Status checks are local (`kill(pid, 0)` semantics) — they do not touch the agent.
`closed` describes the logical session lifecycle. A helper process can exit while the session remains open and resumable. Status reports a PID only when a live queue-owner lease ties that process to the session; queue owner liveness comes from `~/.acpx/queues/*.lock` plus its heartbeat and process probe.

## CWD scoping

`--cwd <dir>` sets both:

- the starting point for the directory-walk lookup
- the exact `cwd` for new sessions created with `sessions new`

```bash
acpx --cwd ~/repos/shop codex sessions new --name pr-842
acpx --cwd ~/repos/shop codex -s pr-842 'review PR #842'
```

CWD is stored as an absolute path in the scope key.

## Session metadata fields

`sessions show` and the JSON form of `sessions new`/`sessions ensure` and `status` include identity fields:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `acpxRecordId`   | Local record id printed in `text` and `quiet` output              |
| `acpxSessionId`  | acpx-side session id (always present)                             |
| `agentSessionId` | Provider-native session id, **only when** the adapter exposes one |

Do not pass an `acpx` session id to a native provider CLI unless `agentSessionId` is also present.

## See also

- [Prompting](prompting.md) — implicit prompt, `prompt`, `exec`, stdin, `--file`, `--no-wait`.
- [Session control](session-control.md) — `cancel`, `set-mode`, `set <key>`, `set model`.
- [Output formats](output-formats.md) — JSON envelope for sessions/status payloads.
- [CLI reference](CLI.md#sessions-subcommand) — long-form spec and exit codes.
