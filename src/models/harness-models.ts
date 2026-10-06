/**
 * The harness-native models — Claude's subscription aliases — expressed as the SAME rows, with the SAME `depth` descriptor, as the
 * OpenRouter catalogue (C4 §7.2 rule 2 / C5 §8.1 note 4).
 *
 * ONE list, all sources. Two endpoints would mean two matchers and two orderings.
 *
 * Provenance of the values: read out of acpx-ui `src/models.ts` at `origin/dev`
 * on 2026-09-03 — `CLAUDE_THINKING_DEPTH_OPTIONS` (:94), `claudeEffortCeiling`
 * (:341).
 * Codex is deliberately absent: its descriptor declares an ACP catalogue with
 * per-model ladders, so connected-session advertisement is its only authority.
 */

import {
  findAdvertisedOption,
  labelFromAdvertisedOption,
  taglineFromAdvertisedOption,
} from "./claude-advertised-label.js";
import type { ClaudeAdvertisementSnapshot } from "./claude-advertisement.js";
import { depthRank, toCanonicalLadder } from "./depth.js";
import type {
  AdvertisedBy,
  CanonicalDepthLevel,
  CatalogueModel,
  DepthDescriptor,
  ModelSource,
} from "./types.js";

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
  if (source === "claude-subscription") {
    return ["claude"];
  }
  if (source === "chatgpt") {
    return ["codex"];
  }
  return null;
}

const CLAUDE_LADDER = toCanonicalLadder(["low", "medium", "high", "xhigh", "max"]);

/** acpx-ui `claudeEffortCeiling` (:341): opus / fable / default reach `max`, the rest stop at `high`. */
function claudeEffortCeiling(alias: string): CanonicalDepthLevel {
  const a = alias.trim().toLowerCase();
  return !a || a === "default" || a.includes("opus") || a.includes("fable") ? "max" : "high";
}

function capLadder(ladder: CanonicalDepthLevel[], ceiling: CanonicalDepthLevel) {
  return ladder.filter((level) => depthRank(level) <= depthRank(ceiling));
}

// `default` is the ONE Claude alias whose id is not itself a family name — its
// `aliasTarget` is what lets `model-floor.ts` resolve a `"default"` pin to a
// comparable family instead of comparing the literal string "default" against
// a served id (brick://ac931199). This mapping is ours, not observed off the
// wire, and we update it the day acpx's own "default" choice changes.
//
// ⚠️ THE ROW NAMES ARE NOT HELD HERE ANY MORE (brick ebfe4c3c). Each row's `name`
// is the Claude Code binary's OWN label for that alias, read off the adapter's
// `model` advertisement by `labelFromAdvertisedOption` — the advertisement is
// probed once per deployed adapter version and cached (`claude-advertisement.ts`)
// — so an SDK bump that ships "Opus 5.6" needs ZERO edits in either repo.
// `fallbackName` is what a row shows when no advertisement is known, and it must
// stay VERSION-FREE: a vintage baked in here is a claim we do not control and it
// rots silently on the next bump. That already happened twice — "Sonnet 5" and
// "Default (Opus 5, 1M context)" while the binary served 5.5, then "Haiku 4.5" /
// "Fable 5" / a "1M" default the deployed binary no longer advertises.
//
// The row SET stays the five aliases, not the advertised list: `opus[1m]` and
// `sonnet[1m]` are deliberately curated out of the picker (sonnet[1m] needs paid
// credits). A new VERSION of a family needs no edit; a new FAMILY alias is a
// one-line, deliberate curation and cost call — it also needs an effort ceiling.
//
// To learn what is ACTUALLY served, read the session record's
// `acpx.served.model` — never a label.
const CLAUDE_ALIASES: {
  id: string;
  fallbackName: string;
  aliasTarget?: { id: string; name: string | null };
}[] = [
  { id: "default", fallbackName: "Default", aliasTarget: { id: "opus", name: "Opus" } },
  { id: "opus", fallbackName: "Opus" },
  { id: "sonnet", fallbackName: "Sonnet" },
  { id: "haiku", fallbackName: "Haiku" },
  { id: "fable", fallbackName: "Fable" },
];

const CLAUDE_STATIC_DESCRIPTION = "Claude Code on a Claude Max subscription.";

/**
 * Historical measurement retained as rationale for removing the Codex product list.
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
function nativeRow(params: {
  source: ModelSource;
  id: string;
  name: string;
  vendor: string;
  description: string;
  depth: DepthDescriptor;
  account: string;
  agentTypes: string[];
  aliasTarget?: { id: string; name: string | null } | null;
  advertisedBy?: AdvertisedBy;
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
    // A plan-billed seat quotes no per-token rate of any kind — including the
    // cache rates (brick 6253611b). `null` here is "no rate is stated", which is
    // deliberately NOT zero: a zero would be a price we are asserting.
    billing: {
      kind: "plan",
      inPerM: null,
      outPerM: null,
      cacheReadPerM: null,
      cacheWritePerM: null,
      account: params.account,
    },
    depth: params.depth,
    badges: [],
    aliasTarget: params.aliasTarget ?? null,
    equivalentTo: [],
    createdAt: null,
    selectable: true,
    unavailableReasons: [],
    availability: {},
    favorite: false,
    favoritedAt: null,
    agentTypes: params.agentTypes,
    ...(params.advertisedBy ? { advertisedBy: params.advertisedBy } : {}),
  };
}

/**
 * The name, tagline and citation for one Claude alias row: the advertised label
 * when the snapshot carries a clean one, else the version-free fallback — and a
 * citation IFF the name came from the advertisement.
 */
function claudeRowText(
  alias: (typeof CLAUDE_ALIASES)[number],
  advert: ClaudeAdvertisementSnapshot | null | undefined,
): { name: string; description: string; advertisedBy?: AdvertisedBy } {
  const option = advert ? findAdvertisedOption(advert.options, alias.id) : undefined;
  const label = option ? labelFromAdvertisedOption(option) : undefined;
  if (!advert || !option || label === undefined) {
    return { name: alias.fallbackName, description: CLAUDE_STATIC_DESCRIPTION };
  }
  return {
    name: label,
    description: taglineFromAdvertisedOption(option) ?? CLAUDE_STATIC_DESCRIPTION,
    advertisedBy: {
      adapter: "claude-agent-acp",
      adapterSha: advert.adapterSha,
      sdkVersion: advert.sdkVersion,
      probedAt: advert.probedAt,
      source: advert.source,
    },
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
 *
 * 🛑 PURE, AND IT MUST STAY PURE — the advertisement is PASSED IN. `model-floor.ts`
 * calls this with no argument on the per-turn hot path under the contract "a
 * plain in-memory lookup … no cache/network I/O"; reading the advertisement cache
 * in here would put a file read on every turn. `loadCatalogue` reads the cache
 * once and hands the snapshot over. Called with no snapshot, the rows carry their
 * version-free fallback names, which is all the floor needs (it reads ids and
 * `aliasTarget`, never names).
 */
export function harnessNativeModels(advert?: ClaudeAdvertisementSnapshot | null): NativeModel[] {
  const rows: NativeModel[] = [];

  for (const alias of CLAUDE_ALIASES) {
    const text = claudeRowText(alias, advert);
    rows.push(
      nativeRow({
        source: "claude-subscription",
        id: alias.id,
        name: text.name,
        vendor: "anthropic",
        description: text.description,
        depth: {
          kind: "ladder",
          levels: capLadder(CLAUDE_LADDER, claudeEffortCeiling(alias.id)),
          default: null,
          mandatory: false,
        },
        account: "claude-subscription",
        agentTypes: ["claude"],
        aliasTarget: alias.aliasTarget ?? null,
        advertisedBy: text.advertisedBy,
      }),
    );
  }

  return rows;
}
