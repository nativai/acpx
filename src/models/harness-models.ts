/**
 * The harness-native models — Claude's subscription/claude-home aliases, the
 * claude-pty bridge's three, and the Codex families with their per-family effort
 * ceiling — expressed as the SAME rows, with the SAME `depth` descriptor, as the
 * OpenRouter catalogue (C4 §7.2 rule 2 / C5 §8.1 note 4).
 *
 * ONE list, all sources. Two endpoints would mean two matchers and two orderings.
 *
 * Provenance of the values: read out of acpx-ui `src/models.ts` at `origin/dev`
 * on 2026-09-03 — `CLAUDE_THINKING_DEPTH_OPTIONS` (:94), `claudeEffortCeiling`
 * (:341), `CODEX_MODEL_FAMILIES` (:60), `CODEX_DEFAULT_EFFORT` (:186),
 * `codexEffortCeiling` (:371), `cappedCodexDepthOptions` (:381),
 * `MODEL_OPTIONS['claude-pty']` (:210). They are OWNED here now: acpx is the
 * basis, and acpx must not import from its own consumer.
 */

import { depthRank, toCanonicalLadder } from "./depth.js";
import type { CanonicalDepthLevel, CatalogueModel, DepthDescriptor, ModelSource } from "./types.js";

/** A native row plus the agent types that can actually run it (the availability join's input). */
export type NativeModel = CatalogueModel & {
  agentTypes: string[];
};

/**
 * Which agent types can spawn a harness-native source. This is acpx's OWN
 * knowledge — it is what makes `--agent claude` hide the Codex families even
 * before the harness-capability table exists, without guessing at any capability
 * value. `null` = not a native source (i.e. OpenRouter), where the question is
 * the capability table's to answer, not this module's.
 */
export function nativeAgentTypesForSource(source: ModelSource): string[] | null {
  if (source === "claude-subscription" || source === "claude-home") {
    return ["claude"];
  }
  if (source === "claude-pty") {
    return ["claude-pty"];
  }
  if (source === "chatgpt") {
    return ["codex"];
  }
  return null;
}

const CLAUDE_LADDER = toCanonicalLadder(["low", "medium", "high", "xhigh", "max"]);
const CODEX_LADDER = toCanonicalLadder(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** acpx-ui `claudeEffortCeiling` (:341): opus / fable / default reach `max`, the rest stop at `high`. */
function claudeEffortCeiling(alias: string): CanonicalDepthLevel {
  const a = alias.trim().toLowerCase();
  return !a || a === "default" || a.includes("opus") || a.includes("fable") ? "max" : "high";
}

/**
 * acpx-ui `codexEffortCeiling` (:371). An unknown family falls to the conservative `xhigh` floor.
 *
 * ⚠️ THAT FLOOR IS WHY A NEW FAMILY MUST BE ADDED HERE AND IN {@link CODEX_FAMILIES} AS ONE CHANGE.
 * Adding the family alone is WORSE than omitting it: the model becomes selectable and then silently
 * caps at `xhigh`, so a rung the adapter genuinely advertises is unreachable with nothing erroring.
 * Omitting it entirely at least fails LOUD (`MODEL_SLUG_UNKNOWN` at the `--model` gate). Over-ask is
 * loud, under-ask is silent — so "when unsure, cap lower" is the direction that quietly deletes
 * capability, which inverts the usual instinct this map otherwise teaches.
 */
function codexEffortCeiling(family: string): CanonicalDepthLevel {
  const f = family.trim().toLowerCase();
  // gpt-6-astra advertises SIX rungs (low…ultra) — measured on the ACP wire against
  // codex-acp 42987b87 / @openai/codex 0.153.3, which advertises 7 families / 35 ids with astra
  // as the sole delta from 0.144.1. OpenAI's published model page lists only FIVE and omits
  // `ultra`; the docs are WRONG and the wire is authoritative here, because acpx gates against
  // what the adapter advertises. Do NOT "correct" astra back to `max` on the strength of the docs.
  if (f === "gpt-5.6-sol" || f === "gpt-5.6-terra" || f === "gpt-6-astra") {
    return "ultra";
  }
  if (f === "gpt-5.6-luna") {
    return "max";
  }
  return "xhigh";
}

function capLadder(ladder: CanonicalDepthLevel[], ceiling: CanonicalDepthLevel) {
  return ladder.filter((level) => depthRank(level) <= depthRank(ceiling));
}

const CLAUDE_ALIASES: { id: string; name: string }[] = [
  { id: "default", name: "Default (Opus 5, 1M context)" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet 5" },
  { id: "haiku", name: "Haiku 4.5" },
  { id: "fable", name: "Fable 5" },
];

const CLAUDE_PTY_ALIASES: { id: string; name: string }[] = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

/**
 * 🔒 A FROZEN MEASUREMENT WITH A RE-MEASURE TRIGGER — NOT A PRODUCT LIST.
 *
 * SCOPE OF THE MEASUREMENT, and all three parts are load-bearing:
 *   ADAPTER    `codex-acp 42987b87` → `@openai/codex ^0.153.3`: SEVEN families,
 *              35 composed ids. The sole delta from the prior reading is
 *              `gpt-6-astra`; no family was retired and none returned.
 *   PRIOR      `codex-acp 0.0.45` → `@openai/codex 0.144.1` (six families, 29
 *              composed ids) — MEASURED 2026-09-04T22:36Z from a real session's
 *              ACP `available_models` (brick://db554b05 `reports/MEASUREMENT.md`).
 *              Kept, not deleted: it is what makes the delta classifiable.
 *   BOX        devbox.
 *   CREDENTIAL the account this box's codex auth resolves to.
 *
 * ⚠️ WHO MEASURED WHAT, because this block's whole point is that a citation
 * names a measurement rather than a belief. The 0.144.1 reading is db554b05's,
 * off the wire. The SEVEN-families / 35-ids reading at 0.153.3 is the codex-acp
 * bump lane's, from the same `available_models` channel, RELAYED HERE AND NOT
 * RE-DERIVED by the author of this stamp. `gpt-6-astra`'s SIX-rung ladder
 * (low…ultra) is the Astra lane's, measured on the ACP wire; OpenAI's published
 * page lists five and omits `ultra`, and the wire is authoritative here because
 * acpx gates against what the adapter advertises.
 *   ⚠️ NOT MEASURED BY ANYONE IN THIS PROGRAMME: astra's rung COUNT was never
 *   independently re-derived — it is relayed from the bump lane throughout. No
 *   shipped behaviour depends on the count, only on `ultra` existing, which IS
 *   measured. Stated so a later reader does not promote it to a fact.
 *
 * 🛑 THIS BLOCK'S OWN TRIGGER FIRED ONCE AND NOTHING WATCHED IT. The bump to
 * `42987b87` merged into the program branch at 2026-09-05T01:22Z. This block
 * already SAID that 0.153.3 carried a seventh family and named it. The table
 * was not updated, `acpx --model 'gpt-6-astra[…]'` failed with -32602
 * MODEL_SLUG_UNKNOWN on every box, and the UI 502'd on a model it offered —
 * because acpx gates `--model` against this table BEFORE any adapter is
 * reached. A re-measure trigger written in a comment has a reader, never an
 * agent. That is why brick://8ca68c82 (sourcing this from the advertisement)
 * is the real fix and this stamp is only an interim.
 *
 * ⚠️ THE BOX AND CREDENTIAL ARE NOT DECORATION. codex's models-manager refreshes
 * its catalogue REMOTELY, with an ETag/TTL, AND PER ACCOUNT — so this list is
 * established for this box and this credential and is NOT proven universal. A
 * reader on another box or another account who takes it as a fleet fact is wrong
 * in a way nothing announces, which is the exact defect shape this block keeps
 * finding.
 *
 * WHY THREE FAMILIES ARE ABSENT HERE. `gpt-5.4`, `gpt-5.3-codex` and `gpt-5.2`
 * were listed until 2026-09-04 and the adapter advertises NONE of them — at
 * `0.144.1` or at `0.153.3`. They were phantom rows: `acpx models show` printed
 * a selectable model with a full ladder, and no `--model` form could spawn one,
 * composed or bare. They are not "stale pending a bump"; they are absent at both
 * measured versions.
 *
 * ⚠️ RE-MEASURE TRIGGER — DO NOT EDIT THIS LIST FROM RELEASE NOTES, A PRODUCT
 * PAGE, OR A MODEL NAME YOU SAW. When the adapter pin moves, take a session's
 * `available_models` off the wire and diff it against the two sets above. The
 * citation exists so that the next delta is CLASSIFIABLE: an uncited list that
 * changes is indistinguishable from a list that was always wrong.
 *
 * The structural fix — sourcing this from the advertisement instead of from a
 * constant — is brick://8ca68c82, deliberately scoped after G3.
 */
const CODEX_FAMILIES: { id: string; name: string }[] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  // gpt-6-astra — an OpenAI FLAGSHIP model, not a Codex-branded one (there is no `codex-astra`
  // slug; the Codex-branded line is gpt-5.3-codex*). Requires codex >= 0.153.1; our adapter pins
  // 0.153.3. Its ceiling arm in codexEffortCeiling() above is part of THIS entry — see the warning
  // there before adding any future family. Deliberately NOT first: acpx-ui's mirror of this table
  // treats index 0 as the client-side create-time default, and Astra is opt-in.
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
];

/** Codex bakes the effort into the id and REJECTS a bare family, so its ladder has no "Default" rung. */
const CODEX_DEFAULT_EFFORT: CanonicalDepthLevel = "medium";

function nativeRow(params: {
  source: ModelSource;
  id: string;
  name: string;
  vendor: string;
  description: string;
  depth: DepthDescriptor;
  account: string;
  agentTypes: string[];
}): NativeModel {
  return {
    key: `${params.source}:${params.id}`,
    source: params.source,
    id: params.id,
    name: params.name,
    vendor: params.vendor,
    description: params.description,
    contextLength: null,
    tools: true,
    billing: { kind: "plan", inPerM: null, outPerM: null, account: params.account },
    depth: params.depth,
    badges: [],
    aliasTarget: null,
    equivalentTo: [],
    createdAt: null,
    selectable: true,
    unavailableReasons: [],
    availability: {},
    favorite: false,
    favoritedAt: null,
    agentTypes: params.agentTypes,
  };
}

/**
 * Every harness-native model acpx knows how to spawn today, with the ladder its
 * harness actually accepts.
 *
 * `depth.default: null` on the Claude ladders is deliberate and load-bearing:
 * the SDK's own default effort is not a value acpx holds statically, and a
 * fabricated one would be rendered by the picker as the model's truth. `null`
 * means "the harness default applies" — which is exactly what omitting the flag
 * does today.
 */
export function harnessNativeModels(): NativeModel[] {
  const rows: NativeModel[] = [];

  for (const source of ["claude-subscription", "claude-home"] as const) {
    for (const alias of CLAUDE_ALIASES) {
      rows.push(
        nativeRow({
          source,
          id: alias.id,
          name: alias.name,
          vendor: "anthropic",
          description:
            source === "claude-subscription"
              ? "Claude Code on a Claude Max subscription."
              : "Claude Code against an independent Claude home directory.",
          depth: {
            kind: "ladder",
            levels: capLadder(CLAUDE_LADDER, claudeEffortCeiling(alias.id)),
            default: null,
            mandatory: false,
          },
          account: source,
          agentTypes: ["claude"],
        }),
      );
    }
  }

  for (const alias of CLAUDE_PTY_ALIASES) {
    rows.push(
      nativeRow({
        source: "claude-pty",
        id: alias.id,
        name: alias.name,
        vendor: "anthropic",
        description: "Interactive Claude through the claude-pty bridge.",
        // The bridge advertises one fixed ladder for every model it takes, and
        // its own default is `high` (C4 CONCEPTION §6.3).
        depth: { kind: "ladder", levels: CLAUDE_LADDER, default: "high", mandatory: false },
        account: "claude-pty",
        agentTypes: ["claude-pty"],
      }),
    );
  }

  for (const family of CODEX_FAMILIES) {
    rows.push(
      nativeRow({
        source: "chatgpt",
        id: family.id,
        name: family.name,
        vendor: "openai",
        description:
          "Codex family; the reasoning effort is fused into the model id as family[effort].",
        depth: {
          kind: "ladder",
          levels: capLadder(CODEX_LADDER, codexEffortCeiling(family.id)),
          default: CODEX_DEFAULT_EFFORT,
          // Codex rejects a bare family, so there is no "send nothing" rung.
          mandatory: true,
        },
        account: "chatgpt",
        agentTypes: ["codex"],
      }),
    );
  }

  return rows;
}
