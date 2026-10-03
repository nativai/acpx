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
acpx codex sessions new              # create a fresh session (prints its id)
acpx codex sessions new --name api   # same, naming the new seat (a display label)
acpx codex sessions show --session-id <id>     # metadata for a session
acpx codex sessions history --session-id <id>  # last 20 turn previews
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

## Addressing

A session is addressed by its id and nothing else (`--session-id <id>` or `--session-url <url>`). `sessions new` always creates a new session and never touches another one; there is no `sessions ensure`, no cwd walk and no name lookup. A call that names no session exits `4` with the create form.

## Session metadata fields

`sessions show` and the JSON form of `sessions new` and `status` include identity fields:

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
