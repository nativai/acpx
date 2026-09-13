# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.

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
