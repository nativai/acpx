# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.

## Model labels

acpx holds no table of Claude model names or versions. Every label is read from the adapter's own advertisement — the `model` config option the bundled Claude Code binary returns on `session/new`, whose description begins with the model's short name:

- **Running and closed sessions:** the session index entry carries `resolvedModelLabel` — derived from the session's own stored advertisement for its current model — and `servedModel`, the model id the API actually served on the last turn. A session started on an older binary keeps the label of the model it ran. `acpx sessions reindex` backfills both fields after an upgrade.
- **Before a session exists** (`acpx models`, pickers): the Claude rows are named from a cached probe of the adapter (a transient session, no prompt), re-probed once per deployed adapter build. `acpx models --refresh` forces a re-probe.
- With no advertisement available, rows and sessions show version-free alias names (`Opus`, `Sonnet`) — never a guessed version.

A label says what the binary calls the alias; to know what actually served a session, read `servedModel` (or the record's `acpx.served.model`).

## Account-scoped automation ceilings

Claude subscription profiles sharing the same functional `account` share one automatic weekly ceiling. Operators can inspect and change it without reading or rewriting credential-bearing registry JSON:

```bash
acpx subscriptions ceiling show [profile:<id> | account:<id>]
acpx subscriptions ceiling set account:<id> 90%
acpx subscriptions ceiling set-default 1.00
acpx subscriptions ceiling clear account:<id>
acpx subscriptions ceiling clear-default
```

Explicit registry policy is hard for automatic sessions at turn boundaries: acpx switches away from a known at-ceiling account or returns `automation-capacity-reserved` before prompt submission. Pinned/manual sessions may override that reserve; account locks may not. Registries with no explicit policy retain the legacy soft 0.90 behavior, and `ACPX_SUBSCRIPTION_AUTO_SELECT=off` disables both selection and hard admission for rollback. Usage JSON reports the policy-aware eligibility verdict and telemetry freshness; unknown weekly telemetry is not treated as a known ceiling.
