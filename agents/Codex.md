# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- Runtime controls exposed by current codex-acp releases include ACP modes, advertised models, and `session/set_model`.
- Reasoning effort is encoded in advertised Codex model ids such as `gpt-5.2[high]` when the adapter reports those variants.
- Codex spawns remove inherited descriptive `CLAUDE_EFFORT` metadata from the caller. Requested model/effort selection, `CLAUDE_CODE_EFFORT_LEVEL`, and existing `CODEX_*` handling remain unchanged.
- `acpx --model <id> codex ...` and `acpx codex set model <id>` apply the requested model through ACP model selection.
- Adapters emitting `_meta.acpxUsage.unit` on `usage_update` persist one request's token counts and actual model in `acpx.cost_units`. Reasoning is a subset of output; it is retained without adding it again to cost. Native models without catalogue rates retain null prices and their token counts.
