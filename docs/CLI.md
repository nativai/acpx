---
title: acpx CLI Reference
description: Definitive command and behavior reference for the acpx CLI, including grammar, options, session rules, output modes, permissions, and exit codes.
author: Bob <bob@dutifulbob.com>
date: 2026-02-18
---

## Overview

`acpx` is a headless ACP client for scriptable agent workflows.

Default behavior is conversational:

- prompt commands use a persisted session
- session lookup is scoped by agent command and working directory (plus optional session name)
- `exec` runs one prompt in a temporary session

## Full command grammar

Global options apply to all commands.

```bash
acpx [global_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]
acpx [global_options] flow run <file> [--input-json <json> | --input-file <path>] [--default-agent <name>]
acpx [global_options] cancel [-s <name>]
acpx [global_options] set-mode <mode> [-s <name>]
acpx [global_options] set <key> <value> [-s <name>]
acpx [global_options] status [-s <name> | --session-id <id> | --session-url <url>]
acpx [global_options] sessions [list | new [--name <name>] | ensure [--name <name>] | close [name] | show [name] | history [name] [--limit <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>]]
acpx [global_options] config [show | init]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] <agent> cancel [-s <name>]
acpx [global_options] <agent> set-mode <mode> [-s <name>]
acpx [global_options] <agent> set <key> <value> [-s <name>]
acpx [global_options] <agent> status [-s <name> | --session-id <id> | --session-url <url>]
acpx [global_options] <agent> sessions [list | new [--name <name>] | ensure [--name <name>] | close [name] | show [name] | history [name] [--limit <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>]]
```

`<agent>` can be:

- built-in friendly name from [the README](https://github.com/openclaw/acpx/blob/main/README.md)
- unknown token (treated as raw command)
- overridden by `--agent <command>` escape hatch

Additional built-in agent docs live in [the Agents page](agents.md).

Prompt options:

```bash
-s, --session <name>   Use named session (local first, then one exact global agent match)
--no-wait              Queue prompt and return immediately if session is busy
-f, --file <path>      Read prompt text from file (`-` means stdin)
```

Notes:

- Top-level `prompt`, `exec`, `cancel`, `set-mode`, `set`, `sessions`, and bare `acpx <prompt>` default to `codex`.
- Top-level `flow run <file>` executes a user-authored workflow module and persists run state under `~/.acpx/flows/runs/`.
- If a prompt argument is omitted, `acpx` reads prompt text from stdin when piped.
- `--file` works for implicit prompt, `prompt`, and `exec` commands.
- `acpx` with no args in an interactive terminal shows help.

## `flow run` subcommand

```bash
acpx [global_options] flow run <file> [--input-json <json> | --input-file <path>] [--default-agent <name>]
```

- Runs a user-authored workflow module step by step through the `acpx/flows` runtime.
- Persists run artifacts under `~/.acpx/flows/runs/<runId>/`.
- Reuses one implicit main ACP session by default for non-isolated `acp` nodes.
- `acp` nodes may override their working directory per step, which lets flows prepare an isolated workspace with an action node and then keep the agent session inside that cwd.
- `acp` and `action` nodes use the global `--timeout` value as their default step timeout. If `--timeout` is omitted, flows default to 15 minutes per active step.
- Flows may declare permission requirements. If a flow requires an explicit grant such as `approve-all`, `acpx` fails fast before starting the flow and tells you which permission flag to pass.
- `--input-json` passes flow input inline as JSON.
- `--input-file` reads flow input JSON from disk.
- `--default-agent` supplies the default agent profile for `acp` nodes that do not pin one.
- The file is always provided by the caller at runtime. `acpx` does not require any built-in flow registry.
- The source repo includes example flow files under `examples/flows/`, including a larger PR-triage example under `examples/flows/pr-triage/`.

Example invocations:

```bash
acpx flow run ./my-flow.ts --input-file ./flow-input.json

acpx flow run examples/flows/branch.flow.ts \
  --input-json '{"task":"FIX: add a regression test for the reconnect bug"}'

acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
```

The PR-triage example is only an example workflow. It can post GitHub comments
or close a PR if you run it against a live repository.

## Global options

All global options:

| Option                                   | Description                                    | Details                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <command>`                      | Raw ACP agent command (escape hatch)           | Do not combine with positional agent token.                                                                                                                                                                |
| `--cwd <dir>`                            | Working directory                              | Defaults to current directory. Stored as absolute path for scoping.                                                                                                                                        |
| `--approve-all`                          | Auto-approve all permissions                   | Permission mode `approve-all`.                                                                                                                                                                             |
| `--approve-reads`                        | Auto-approve reads/searches, prompt for others | Default permission mode.                                                                                                                                                                                   |
| `--deny-all`                             | Deny all permissions                           | Permission mode `deny-all`.                                                                                                                                                                                |
| `--format <fmt>`                         | Output format                                  | `text` (default), `json`, `quiet`.                                                                                                                                                                         |
| `--suppress-reads`                       | Suppress read file contents                    | Replaces raw read payloads with `[read output suppressed]`.                                                                                                                                                |
| `--json-strict`                          | Strict JSON mode                               | Requires `--format json`; suppresses non-JSON stderr output.                                                                                                                                               |
| `--no-terminal`                          | Disable ACP terminal capability                | Advertises `clientCapabilities.terminal: false` during ACP initialize for new agent clients.                                                                                                               |
| `--non-interactive-permissions <policy>` | Non-TTY prompt policy                          | `deny` (default) or `fail` when approval prompt cannot be shown.                                                                                                                                           |
| `--permission-policy <json-or-file>`     | Per-tool permission policy                     | JSON object or file path with `autoApprove`, `autoDeny`, `escalate`, and optional `defaultAction` (`approve`, `deny`, `escalate`). Alias: `--policy`.                                                      |
| `--timeout <seconds>`                    | Max wait time for agent response               | Must be positive. Decimal seconds allowed.                                                                                                                                                                 |
| `--ttl <seconds>`                        | Queue owner idle TTL before shutdown           | Default `5400`. `0` disables TTL.                                                                                                                                                                          |
| `--model <id>`                           | Set agent model                                | Claude-compatible adapters may consume session creation metadata; other agents must advertise ACP models and support `session/set_model`, otherwise `acpx` fails clearly instead of silently falling back. |
| `--reasoning-effort <level>`             | Set Claude thinking depth                      | Claude subscription and claude-home profiles accept `low`, `medium`, `high`, `xhigh`, `max`; OpenRouter reasoning profiles accept `minimal`, `low`, `medium`, `high`.                                      |
| `--verbose`                              | Enable verbose logs                            | Prints ACP/debug details to stderr.                                                                                                                                                                        |

Permission flags are mutually exclusive. Using more than one of `--approve-all`, `--approve-reads`, `--deny-all` is a usage error.

### Global option examples

```bash
acpx --approve-all codex 'apply this patch and run tests'
acpx --approve-reads codex 'inspect the repo and propose a plan'
acpx --deny-all codex 'summarize this code without running tools'
acpx --non-interactive-permissions fail codex 'fail fast when prompt cannot be shown'
acpx --policy '{"escalate":["execute"],"defaultAction":"deny"}' --format json codex exec 'run tests'

acpx --cwd ~/repos/api codex 'review auth middleware'
acpx --format json codex exec 'summarize open TODO items'
acpx --format json --json-strict codex exec 'machine-safe JSON output'
acpx --no-terminal codex exec 'summarize without terminal capability'
acpx --timeout 120 codex 'investigate flaky test failures'
acpx --ttl 30 codex 'keep queue owner warm for quick follow-up'
acpx --verbose codex 'debug adapter startup issues'
```

## Agent commands

Each agent command supports the same shape.

### `pi`

```bash
acpx [global_options] pi [prompt_options] [prompt_text...]
acpx [global_options] pi prompt [prompt_options] [prompt_text...]
acpx [global_options] pi exec [prompt_text...]
acpx [global_options] pi sessions [list | new [--name <name>] | ensure [--name <name>] | close [name]]
```

Built-in command mapping: `pi -> npx pi-acp`

### `openclaw`

```bash
acpx [global_options] openclaw [prompt_options] [prompt_text...]
acpx [global_options] openclaw prompt [prompt_options] [prompt_text...]
acpx [global_options] openclaw exec [prompt_text...]
acpx [global_options] openclaw sessions [list | new [--name <name>] | ensure [--name <name>] | close [name]]
```

Built-in command mapping: `openclaw -> openclaw acp`

For repo-local OpenClaw checkouts, override the built-in command in config:

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node scripts/run-node.mjs acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

### `codex`

```bash
acpx [global_options] codex [prompt_options] [prompt_text...]
acpx [global_options] codex prompt [prompt_options] [prompt_text...]
acpx [global_options] codex exec [prompt_text...]
acpx [global_options] codex sessions [list | new [--name <name>] | ensure [--name <name>] | close [name]]
```

Built-in command mapping: `codex -> npx -y @agentclientprotocol/codex-acp`

### `claude`

```bash
acpx [global_options] claude [prompt_options] [prompt_text...]
acpx [global_options] claude prompt [prompt_options] [prompt_text...]
acpx [global_options] claude exec [prompt_text...]
acpx [global_options] claude sessions [list | new [--name <name>] | ensure [--name <name>] | close [name]]
```

Built-in command mapping: `claude -> npx -y @agentclientprotocol/claude-agent-acp`

Additional built-in agent docs live in [the Agents page](agents.md).

### Custom positional agents

Unknown agent names are treated as raw commands:

```bash
acpx [global_options] my-agent [prompt_options] [prompt_text...]
acpx [global_options] my-agent exec [prompt_text...]
acpx [global_options] my-agent sessions
```

## `prompt` subcommand (explicit)

Persistent-session prompt command:

```bash
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
```

Behavior:

- Finds existing session for scope key `(agentCommand, cwd, name?)`
- Does not auto-create sessions; missing scope exits with code `4` and guidance to run `sessions new`
- Sends prompt on resumed/new session
- If another prompt is already running for that session, submits to the running queue owner instead of starting a second ACP subprocess
- By default waits for queued prompt completion; `--no-wait` returns after queue acknowledgement
- Updates session metadata after completion

The agent command itself also has an implicit prompt form:

```bash
acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] [prompt_text...]   # defaults to codex
```

## `exec` subcommand

One-shot prompt (no saved session):

```bash
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]   # defaults to codex
```

Behavior:

- Creates temporary ACP session
- Sends prompt once
- Does not write/use a saved session record
- Supports prompt text from args, stdin, `--file <path>`, and `--file -`

## `cancel` command

```bash
acpx [global_options] <agent> cancel [-s <name>]
acpx [global_options] cancel [-s <name>]   # defaults to codex
```

Behavior:

- Sends cooperative `session/cancel` through queue-owner IPC when a prompt is running.
- If no prompt is running, prints `nothing to cancel` and exits success.

## `set-mode` command

```bash
acpx [global_options] <agent> set-mode <mode> [-s <name>]
acpx [global_options] set-mode <mode> [-s <name>]   # defaults to codex
```

Behavior:

- Calls ACP `session/set_mode`.
- `<mode>` values are adapter-defined (not globally standardized across all ACP adapters).
- Unsupported mode ids are rejected by the adapter (often as `Invalid params`).
- Routes through queue-owner IPC when an owner is active.
- Falls back to a direct client reconnect when no owner is running.

## `set` command

```bash
acpx [global_options] <agent> set <key> <value> [-s <name>]
acpx [global_options] set <key> <value> [-s <name>]   # defaults to codex
```

Behavior:

- Calls ACP `session/set_config_option`.
- Routes through queue-owner IPC when an owner is active.
- Falls back to a direct client reconnect when no owner is running.
- **`set model <id>`**: Intercepted to call `session/set_model` instead. Some agents support `session/set_model` but not `session/set_config_option` for model changes; routing through the dedicated method ensures broad compatibility.

## `sessions` subcommand

```bash
acpx [global_options] <agent> sessions
acpx [global_options] <agent> sessions list
acpx [global_options] <agent> sessions list [--cursor <cursor>] [--filter-cwd <dir>] [--local]
acpx [global_options] <agent> sessions new
acpx [global_options] <agent> sessions new --name <name>
acpx [global_options] <agent> sessions ensure
acpx [global_options] <agent> sessions ensure --name <name>
acpx [global_options] <agent> sessions close
acpx [global_options] <agent> sessions close <name>
acpx [global_options] <agent> sessions reopen <id>
acpx [global_options] <agent> sessions reopen <id>
acpx [global_options] <agent> sessions show
acpx [global_options] <agent> sessions show <name>
acpx [global_options] <agent> sessions history
acpx [global_options] <agent> sessions history <name> [--limit <count>]
acpx [global_options] <agent> sessions export [name] --output <path> [--cwd <dir>]
acpx [global_options] <agent> sessions import <archive> [--name <name>] [--cwd <dir>]
acpx [global_options] <agent> sessions prune [<id>...] [--cwd | --whole-box] [--older-than <days> | --before <date>] [--dry-run] [--no-include-history] [--include-templates]

acpx [global_options] sessions ...   # defaults to codex
```

Behavior:

- `sessions` and `sessions list` are equivalent
- list uses ACP `session/list` when the agent advertises
  `sessionCapabilities.list`, returning agent-native `SessionInfo` metadata and
  `nextCursor` in JSON output
- `sessions list --cursor <cursor>` fetches an agent-side page from an ACP
  cursor returned by a prior list response
- `sessions list --filter-cwd <dir>` sends the ACP cwd filter; relative values
  resolve against global `--cwd`
- `sessions list --local` reads saved acpx records for selected `agentCommand`
  instead of contacting the agent
- when the agent does not support `session/list`, list falls back to local saved
  records unless agent-side list filters were requested
- `sessions new` creates a fresh cwd-scoped default session
- `sessions new --name <name>` creates a fresh named session for cwd
- creating a fresh session soft-closes the previous open session in that scope (if present)
- text and quiet output print the local `acpxRecordId`; JSON output also includes
  `acpxSessionId` and, when the adapter exposes one, `agentSessionId`
- `sessions ensure` returns the nearest matching active session or creates one for cwd
- `sessions ensure --name <name>` does the same for named sessions
- `sessions close` soft-closes the current cwd default session
- `sessions close <name>` soft-closes the local named session first, then one exact global agent match
- `sessions reopen <id>` reopens a closed session so prompts are accepted again — the inverse of `sessions close`. Idempotent (an already-open session exits 0 with `reopened:false`), spawns nothing (the next prompt cold-respawns the owner), and does NOT cascade to subagents. **Not `sessions recover`**, which force-restarts a wedged queue owner and leaves the session closed.
- `sessions reopen <id>` reopens a closed session so prompts are accepted again — the inverse of `sessions close`. Idempotent (an already-open session exits 0 with `reopened:false`), spawns nothing (the next prompt cold-respawns the owner), and does NOT cascade to subagents. Not `sessions recover`, which restarts a wedged queue owner and leaves the session closed.
- `sessions show [name]` displays stored session metadata
- `sessions history [name]` displays stored turn history previews (default 20, configurable with `--limit`)
- `sessions export [name] --output <path>` writes a portable JSON archive with session state and event history; `--cwd <dir>` selects a different source cwd relative to global `--cwd`
- `sessions import <archive>` writes a fresh local record from a portable archive, reopens it as idle, keeps the provider session id, and clears source-machine process metadata
- Imported sessions must resume that provider session; if the destination agent cannot load it, prompts fail clearly instead of starting an empty conversation
- `sessions import --name <name>` and `--cwd <dir>` override the imported destination scope; import fails instead of creating a duplicate when an active session already exists for that `(agent, cwd, name)` scope or when another local record already uses the same provider session id
- `sessions prune` deletes each selected session's record **and its messages sidecar** — after which that session's transcript can never be rebuilt. Template blueprints are skipped unless `--include-templates`.
- **A destructive prune requires a scope and refuses without one** (exit 2, nothing deleted), because unscoped it selects every closed session for the agent on the whole box. `--dry-run` needs no scope.
- `sessions prune <id> [<id>...]` prunes exactly the sessions you name — the usual case. Ids are an acpx record id, an ACP session id, or a unique suffix. **All or nothing:** every id must resolve to exactly one closed session and every resolved session must be pruned, or the run aborts having deleted nothing.
- `sessions prune --cwd` prunes closed sessions whose cwd is the current directory, by exact equality — not a subtree match, so it does not span sibling worktrees of the same project
- `sessions prune --whole-box` is the box-wide sweep: every closed session for this agent on this box. It cannot be combined with ids or `--cwd`, and there is deliberately no `--all` alias — the long form is what makes an override greppable in a transcript later.
- Ids and `--cwd` combine as a union ("this directory's, plus the ones I name"); an age filter then intersects the result
- `sessions prune --before <date>` and `--older-than <days>` filter by close time, falling back to last-used time for older records, and each counts as a scope on its own
- `sessions prune --dry-run` previews closed sessions that can be deleted and deletes nothing. It fails on a bad id exactly where the real run would, so the preview cannot promise what the real run refuses.
- Before deleting anything, a destructive prune prints what it is about to destroy. By default that is the record, the messages sidecar, the event stream, the stream's timestamp sidecar and the queue-owner log — a pruned session leaves nothing behind
- `--no-include-history` keeps the event stream files and their timestamp sidecar. They are then **unreachable**: prune selects off the record index, so once the record is gone no later prune can reclaim them. A run that opts out says how many files and how many bytes it is leaving
- **`--include-history` is now the default** and the flag is still accepted, so existing invocations keep working unchanged. Note that `bytesFreed` is consequently ~5x larger than before this default flipped — stream bytes now count toward it
- Every destructive prune appends one line per deleted session to `~/.acpx/sessions/deletions.ndjson` **before** deleting anything, and refuses to run (exit 1, nothing deleted) if it cannot. `templates rollback --delete` writes to the same file
- `--include-templates` is not a scope — it widens what a scope selects, so it still needs one
- close errors if the target session does not exist

For commands that address an existing session, an explicit name first uses that
command's local lookup behavior. If local lookup misses, one exact global match
for the selected agent is used. Multiple matches fail closed and list record IDs
and cwds; select one with `--session-id` or `--session-url`. Omitted/default
names, `sessions new`, and `sessions ensure` remain cwd-scoped.

## `status` command

```bash
acpx [global_options] <agent> status
acpx [global_options] <agent> status -s <name>
acpx [global_options] <agent> status --session-id <id>
acpx [global_options] <agent> status --session-url <url>
acpx [global_options] status
acpx [global_options] status -s <name>
acpx [global_options] status --session-id <id>
acpx [global_options] status --session-url <url>
```

Shows local process status for the selected session. Name lookup (`-s/--session`)
checks the exact cwd first, then resolves one exact global match for the selected
agent. Ambiguous names require `--session-id` or `--session-url`; those durable
identity selectors always resolve the persisted session globally.

- `running`, `idle`, `dead`, or `no-session`
- session id, agent command, live queue-owner pid when available
- model id, available models, desired reasoning effort, and live advertised effort when known
- uptime when running
- last prompt timestamp
- last known exit code/signal when dead

`idle` means the persistent session is saved and resumable, but no queue owner is
currently running. The next prompt starts a queue owner and reconnects the
session.

Status checks are local and PID-based (`kill(pid, 0)` semantics). Cached session
PIDs are not reported unless a live queue-owner lease ties them to the session.

## `config` command

```bash
acpx [global_options] config show
acpx [global_options] config init
```

- `config show` prints the resolved config from global + project files.
- `config init` writes a default global config template if missing.

Config files:

- global: `~/.acpx/config.json`
- project: `<cwd>/.acpxrc.json` (merged on top of global)

Supported keys:

```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-all",
  "nonInteractivePermissions": "deny",
  "authPolicy": "skip",
  "ttl": 5400,
  "timeout": null,
  "format": "text",
  "agents": {
    "my-custom": { "command": "./bin/my-acp-server", "args": ["acp"] }
  },
  "auth": {
    "my_auth_method_id": "credential-value"
  }
}
```

CLI flags always override config values.

For ACP `authenticate` handshakes, use either config `auth` entries or explicit
`ACPX_AUTH_<METHOD_ID>` environment variables such as `ACPX_AUTH_OPENAI_API_KEY`.
Ambient provider env vars such as `OPENAI_API_KEY` are still passed through to
child agents, but they do not trigger ACP auth-method selection on their own.

## `--agent` escape hatch

`--agent <command>` sets a raw adapter command explicitly.

Examples:

```bash
acpx --agent ./my-custom-acp-server 'do something'
acpx --agent 'node ./scripts/acp-dev-server.mjs --mode ci' exec 'summarize changes'
```

Rules:

- Do not combine positional agent and `--agent` in one command.
- The resolved command string becomes the session scope key (`agentCommand`).
- Invalid empty command or unterminated quoting in `--agent` is a usage error.

## Session behavior and scoping

Session records are stored in:

```text
~/.acpx/sessions/*.json
```

### Auto-resume

For prompt commands:

1. Detect the nearest git root by checking for `.git` while walking up from `absoluteCwd`.
2. If a git root is found, walk from `absoluteCwd` up to that git root (inclusive).
3. If no git root exists, only check exact `absoluteCwd` (no parent-directory walk).
4. At each checked directory, find the first active (non-closed) session matching `(agentCommand, dir, optionalName)`.
5. If found, use that session record for prompt queueing and resume attempts.
6. If not found, exit with code `4` and print guidance to create one via `sessions new`.

Use `sessions new [--name <name>]` when you explicitly want a fresh scoped session.
Use `sessions ensure [--name <name>]` when you want idempotent "get-or-create" behavior.

If a saved session PID is dead, `acpx` respawns the agent, tries `session/resume` when advertised or `session/load` otherwise, and transparently falls back to `session/new` when reconnecting fails.

### Prompt queueing

When a prompt is already in flight for a session, `acpx` uses a per-session queue owner process:

1. owner process keeps the active turn running
2. other `acpx` invocations enqueue prompts through local IPC
3. owner drains queued prompts one-by-one after each completed turn
4. after the queue drains, owner waits for new work up to TTL (`--ttl`, default 5400s)
5. submitter either blocks until completion (default) or exits immediately with `--no-wait`
6. if interrupted (`Ctrl+C`) during an active turn, `acpx` sends `session/cancel` first, waits briefly for cancelled completion, then force-kills only if needed

### Soft-close behavior

- soft-closed sessions remain on disk with `closed: true` and `closedAt`
- auto-resume ignores closed sessions during scope lookup
- closed sessions still keep full record data and can be resumed explicitly via record id/session load flows
- session records also keep lightweight turn history previews used by `sessions history`

### Named sessions

`-s, --session <name>` adds `name` into the scope key so multiple parallel conversations can coexist in the same repo and agent command.

### CWD scoping

`--cwd` sets the starting point for directory-walk routing (bounded by git root) and the exact scope directory when creating sessions via `sessions new`.

## Output formats

`--format` controls output mode:

- `text` (default): human-readable stream
- `json`: raw ACP NDJSON stream for automation
- `quiet`: assistant text only
- `--format json --json-strict`: same ACP NDJSON stream, with non-JSON stderr output suppressed

### Prompt/exec output behavior

- `text`: assistant text, tool status blocks, client-operation logs, plan updates, and `[done] <reason>`
- `json`: one raw ACP JSON-RPC message per line
- `quiet`: concatenated assistant text only

When `--suppress-reads` is enabled:

- `text`: read-like tool outputs render as `[read output suppressed]`
- `json`: ACP `fs/read_text_file` responses and read-like tool-call outputs replace raw file contents with `[read output suppressed]`
- `quiet`: unchanged, because quiet mode only prints assistant text

ACP message examples:

```json
{"jsonrpc":"2.0","id":"req-1","method":"session/prompt","params":{"sessionId":"019c...","prompt":"hi"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

Hard rule for the ACP stream:

- no acpx-specific event envelope,
- no synthetic `type`/`stream` wrapper fields,
- no ACP payload key renaming.

### Control-command JSON mapping

When `--format json` is used:

- commands that talk to an ACP adapter emit raw ACP JSON-RPC messages.
- local query commands (`sessions list/show/history/export/import/prune`) emit local JSON documents (not ACP stream traffic).

### Sessions/query command output behavior

- `sessions list` with `text`: tab-separated `id`, `name`, `cwd`, `lastUsedAt` (closed sessions include a `[closed]` marker next to id)
- `sessions list` with `json`: a single JSON array of session records
- `sessions list` with `quiet`: one session id per line (closed sessions include `[closed]`)
- `sessions show` with `text`: key/value metadata dump
- `sessions show` with `json`: full session record object
- `sessions history` with `text`: tab-separated `timestamp role textPreview` entries
- `sessions history` with `json`: object containing `entries` array
- `sessions export` with `text`: output path summary
- `sessions export` with `json`: object containing `action` and `output`
- `sessions export` with `quiet`: output path
- `sessions import` with `text`: imported record id and cwd summary
- `sessions import` with `json`: object containing `action`, `record_id`, and `cwd`
- `sessions import` with `quiet`: imported record id
- `sessions prune` with `text`: summary plus pruned ids and close/last-used time
- `sessions prune` with `json`: object containing `action`, `dryRun`, `count`, `bytesFreed`, `pruned`, `skippedTemplates`, `scope`, `strandedStreamFiles`, and `strandedStreamBytes`
- `sessions prune` refused for want of a scope with `json`: object on **stdout** with `action: "sessions_prune_refused"`, `reason`, `agentName`, `cwd`, `closedCandidates`, `closedCandidatesInCwd`, and `scopes`; exit 2. `reason` is one of `scope_required`, `scope_conflict`, `session_not_found`, `session_ambiguous`, `session_open`.
- `sessions prune` with `quiet`: one pruned session id per line, and nothing else — a refusal goes to stderr so a quiet consumer's stdout parse is never handed prose
- `status` with `text`: key/value process status lines

## Permission modes

Choose exactly one mode:

- `--approve-all`: auto-approve all permission requests
- `--approve-reads`: auto-approve read/search requests, prompt for other kinds (default)
- `--deny-all`: auto-deny/reject requests when possible

Prompting behavior in `--approve-reads`:

- interactive TTY: asks `Allow <tool>? (y/N)` for non-read/search requests
- non-interactive (no TTY): non-read/search requests are not approved

Non-interactive prompt policy:

- `--non-interactive-permissions deny`: deny non-read/search prompts when no TTY (default)
- `--non-interactive-permissions fail`: fail with `PERMISSION_PROMPT_UNAVAILABLE`

Per-tool policy:

- `--permission-policy <json-or-file>` or `--policy <json-or-file>` matches ACP permission requests by tool kind, title head, title, or raw input tool/name.
- `autoDeny` wins over `autoApprove`, which wins over `escalate`; unmatched requests use `defaultAction` when set, otherwise the selected permission mode.
- Non-interactive escalations deny the current request. Text mode prints a `[permission]` notice; JSON mode keeps raw ACP NDJSON and includes escalation details, including tool input when supplied by the agent, on the `session/request_permission` response at `_meta.acpx.permissionEscalation`.

## Exit codes

| Code  | Meaning                                                                                    |
| ----- | ------------------------------------------------------------------------------------------ |
| `0`   | Success                                                                                    |
| `1`   | Agent/protocol/runtime error                                                               |
| `2`   | CLI usage error                                                                            |
| `3`   | Timeout                                                                                    |
| `4`   | No session found (prompt requires an explicit `sessions new`)                              |
| `5`   | Permission denied (permission requested, none approved, and at least one denied/cancelled) |
| `130` | Interrupted (`SIGINT`/`SIGTERM`)                                                           |

## Environment variables

Child adapter processes inherit the current environment by default. `acpx`
also injects session identity variables when a saved session is involved:

- `ACPX_SESSION_URL`: acpx-ui URL for this session, including `?session=<id>`.
- `ACPX_PARENT_SESSION_URL`: parent session URL when lineage is known.
- `ACPX_SESSION_NAME`: set only for named sessions; unset for unnamed sessions.
- `ACPX_TASK_FOLDER`: task folder metadata when present on the session.
- `ACPX_AGENT_FOLDER`: per-agent working folder when acpx creates one.

Session storage path is derived from the OS home directory
(`~/.acpx/sessions`).

## Practical examples

```bash
# Review a PR in a dedicated named session
acpx --cwd ~/repos/shop codex sessions new --name pr-842
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Review PR #842, list risks, and propose a minimal patch'

# Continue that same PR review later
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Now draft commit message and rollout checklist'

# Parallel workstreams in one repo
acpx codex sessions new --name backend
acpx codex sessions new --name docs
acpx codex -s backend 'fix checkout timeout'
acpx codex -s docs 'document payment retry behavior'

# One-shot ask with no saved context
acpx claude exec 'summarize src/session.ts in 5 bullets'

# Manage sessions
acpx codex sessions
acpx codex sessions new --name docs
acpx codex sessions show docs
acpx codex sessions history docs --limit 10
acpx codex sessions close docs
acpx codex status

# Prompt from file/stdin
echo 'triage failing tests' | acpx codex
acpx codex --file prompt.md
acpx codex --file - 'also check lint warnings'

# Config inspection
acpx config show
acpx config init

# JSON automation pipeline
acpx --format json codex exec 'review latest diff for security issues' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'
```
