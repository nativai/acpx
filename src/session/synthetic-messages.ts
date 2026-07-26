import type { SessionAgentMessage, SessionMessage } from "../types.js";

// Text prefixes of the acpx-authored breadcrumbs that were written BEFORE the
// `Agent.synthetic:true` tag existed (guard deployed 2026-07-22, tag deployed
// 2026-07-26 — brick://de3645c6 / brick://509b4ee1). Records from that window
// carry the advisory UNTAGGED, baked into `record.messages` and the
// `.messages.ndjson` sidecar — so tag-only recognition leaves every pre-tag
// never-run session permanently unpromptable (proven live: specimen b7d8d768
// still died loud AFTER the tag fix deployed). A data migration over live
// multi-box stores is riskier than content recognition, so legacy breadcrumbs
// are recognized by their known text prefixes instead. Keep in sync with the
// builders in model-guard.ts / fable-degrade.ts / model-floor-enforce.ts (all
// of which now always tag); this list is legacy-compat only and can be dropped
// once pre-2026-07-26 never-run records stop mattering.
const LEGACY_SYNTHETIC_TEXT_PREFIXES = [
  "⚠ implicit Fable blocked → forced ",
  "⚠ Fable share exhausted on all subscriptions — degraded to ",
  "⚠ served below pinned model floor: ",
] as const;

// A synthetic acpx-authored breadcrumb: either tagged (`synthetic:true`, every
// writer since brick://509b4ee1) or a recognized legacy untagged one. The legacy
// shape check is strict — exactly one Text content, no tool results, known
// prefix — so a real model turn is essentially never misclassified; the residual
// risk is a pre-tag turn that consisted of NOTHING but a verbatim quote of one
// advisory, where the cost is a session/new fallback instead of a loud refusal.
export function isSyntheticAgentEntry(agent: SessionAgentMessage): boolean {
  if (agent.synthetic === true) {
    return true;
  }
  const content = agent.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const only = content[0] as { Text?: unknown } | undefined;
  if (!only || typeof only.Text !== "string") {
    return false;
  }
  if (Object.keys(agent.tool_results ?? {}).length !== 0) {
    return false;
  }
  const text = only.Text;
  return LEGACY_SYNTHETIC_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// True only when a REAL model turn exists in the message log — synthetic
// breadcrumbs (tagged or legacy-recognized) are excluded. Shared core of the
// "nothing to lose / nothing to port / no real history" decisions:
// - resume→session/new fallback safety (engine/lifecycle sessionHasRealAgentTurn)
// - transcript-port gates on subscription/account switches
// - owner permission-mode restorability
export function messagesHaveRealAgentTurn(messages: SessionMessage[]): boolean {
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "Agent" in message &&
      !isSyntheticAgentEntry(message.Agent),
  );
}
