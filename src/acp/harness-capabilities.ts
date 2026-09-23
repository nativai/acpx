import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpAdapterKind } from "./agent-command.js";

/**
 * The per-harness capability descriptor (CONCEPTION §8, Decision F).
 *
 * ONE table, in acpx, with two audiences: acpx-ui's create dialog / chat header
 * (the C5 §8.4 field names) and acpx's own CLI + apply paths (the C4 mechanism
 * fields). Daniel, 2026-09-03 22:58:57Z: *"we need some transparent mechanism
 * backed by ACPX … ACPX needs to be the basis for all of this"* — the web app
 * and the CLI only READ this; there is no UI-side table.
 *
 * ⛔ **There is deliberately no permission field of any kind.** CONCEPTION §8's
 * draft struct carried `permissionModel`; Daniel's later ruling (2026-09-03
 * 23:17:00Z, program DECISIONS.md row "7 (amended)") drops it: acpx
 * short-circuits every permission request so every agent always runs with the
 * process's full permissions, and neither the UI nor an agent has a permission
 * concept to render. Adding one back is a decision to reverse, not a gap to fill.
 *
 * ## The rule that makes this table worth having
 *
 * Every field that states *what a user can do* is DERIVED from the field that
 * states *how the mechanism works* — see {@link deriveHarnessCapabilities}. The
 * hand-written half lives in {@link HARNESS_FACTS} as {@link HarnessCapabilityFacts},
 * a type that does not contain the derived fields at all, so writing
 * `canSetModelLive: true` into a row is a TYPE ERROR rather than something a
 * reviewer has to catch. A hand-written `true` would offer a control that
 * destroys the session; a hand-written `false` would outlive the fix.
 *
 * ## Every cell traces to a measurement
 *
 * Citations in this file are one of:
 *   - `I2 R<n>` — FINDINGS-pi, brick c239d784 (measured 2026-09-03 on devbox)
 *   - `MAP §<n>` — CURRENT-STATE-capability-map, brick 2decfc57 (source reads, [V])
 *   - a `file:line` in this repo or in a deployed adapter under `/opt`.
 *
 * ## The `<boolean>` / `<field>Reason` naming rule — so the NEXT field answers itself
 *
 * A capability boolean that can be denied carries a sibling reason string on the
 * wire. **The reason key is the boolean with its capability PREFIX stripped, plus
 * `Reason`** — `supports`/`canSet` is the prefix:
 *
 *   `supportsSessionClear`  → `sessionClearReason`
 *   `canSetCredentialLive`  → `credentialLiveReason`
 *   `supportsModelDegrade`  → `modelDegradeReason`
 *
 * **The one exception, named rather than hidden: `canSetModelLive`'s reason is
 * `liveModelChangeReason`, not `modelLiveReason`.** It is a legacy one-off that
 * predates the rule; it is on the wire and consumed by acpx-ui, and a breaking
 * rename for symmetry is a bad trade (ruled by the descriptor owner, 2026-09-05).
 * Two conventions, one stated rule and one named exception — write the next field
 * to the rule.
 *
 * Every pair obeys the same invariant, and it is STRUCTURAL rather than
 * conventional: the reason lives on {@link HarnessCapabilityFacts} as a plain
 * `string` and {@link deriveHarnessCapabilities} is the ONLY thing that puts it on
 * the wire, nulling it when its boolean is true. **A non-null reason therefore
 * cannot accompany a `true`.**
 *
 * ## The three-state convention — mechanical, not a habit
 *
 * ⛔ **THERE IS NO THIRD STATE ON THE WIRE.** These keys are ALWAYS PRESENT on all
 * five harness blocks and every boolean is a real boolean: never a placeholder,
 * never a null boolean, never an omitted key. A consumer separates the three
 * states it cares about by TOKEN, at the front of the reason string:
 *
 *   - `not measured: …`     — OURS. The key is present and the boolean is `false`,
 *                             but the cell was never measured against this
 *                             harness's ADAPTER. The reason names exactly what is
 *                             missing. This is an honest deliverable, not a gap.
 *   - `descriptor absent: …` — THE CONSUMER'S, never written here. An old acpx that
 *                             serves no descriptor, or omits the key.
 *   - a bare reason          — a REAL, MEASURED denial.
 *
 * ⚠️ **`not measured:` is the only defence against the defect this table exists to
 * end.** A cell whose adapter was never probed must NOT be given a confident
 * `false`: a confident false is indistinguishable from a measured denial, outlives
 * whoever wrote it, and cannot be found again. If you measure such a cell, replace
 * the token with the real reason and cite the build you measured it on.
 */

export const HARNESS_IDS = ["claude", "codex", "pi"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** How acpx makes a model selection reach the harness (CONCEPTION §5.2/§5.3). */
export type ModelMechanism = "set-model" | "config-option" | "compose-into-id" | "none";

/** How acpx makes a thinking-depth request reach the harness (CONCEPTION §5.2/§6). */
export type DepthMechanism = "config-option" | "mode" | "compose-into-id" | "none";

/**
 * Where the harness's model list comes from.
 *  - `acp`     — enumerable from the ACP handshake (`models`, or a `model` config option)
 *  - `openrouter` — fetched from OpenRouter's live catalogue
 *  - `static`  — a fixed list compiled into the adapter
 */
export type ModelCatalogue = "acp" | "openrouter" | "static";

/**
 * How the depth ladder is determined.
 *  - `acp`       — whatever the adapter advertises for the session
 *  - `per-model` — the advertised ladder depends on the CURRENTLY SELECTED model,
 *                  so it must be re-read after a model change and may be absent
 *                  entirely for a non-reasoning model
 *  - `static`    — a fixed list, identical for every model
 */
export type DepthLadder = "acp" | "per-model" | "static";

/** What "any OpenRouter model" costs for this harness (CONCEPTION §7.4). */
export type ArbitraryModelSupport = "none" | "native" | "provisioned" | "via-shim";

/** Where this harness's credential comes from (CONCEPTION §5.1). */
export type CredentialTier = "profile" | "box-provider" | "none";

/**
 * What a fork honouring `--at-index N` actually does.
 *  - `exact`         — the fork is truncated at the requested point
 *  - `turn-granular` — the fork IS truncated, but only at a coarser boundary, so
 *                      a request between boundaries lands elsewhere. Carries
 *                      {@link HarnessForkSupport.atIndexGranularityMessages} and
 *                      {@link HarnessForkSupport.atIndexRounding} so a consumer
 *                      can say WHERE it will land — see {@link resolveForkLandingIndex}.
 *  - `ignored`       — the request is accepted and SILENTLY full-copies
 *  - `unsupported`   — refused loudly, so the caller knows
 *
 * The distinction `turn-granular` draws against `exact` is the whole reason this
 * field exists: a truncation that silently lands somewhere other than where it
 * was asked to is the same class of silent wrong answer as `ignored`, one notch
 * quieter. (WS-core call, 2026-09-04, on the codex evidence below.)
 */
export type ForkAtIndexSupport = "exact" | "turn-granular" | "ignored" | "unsupported";

/**
 * Which channel acpx uses to deliver the OS primer. Wider than
 * `PrimerChannel` in `./agent-command.ts` by one value: `config-file` is the
 * measured-available path for Pi (`$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`,
 * I2 R9), and B3 writes it — see `src/acp/harness-config-dir.ts`.
 *
 * ⚠️ **THIS CELL IS A GATE, NOT ONLY A LABEL.** `applyHarnessConfigDir` gives a
 * per-session config dir — and therefore adapter ENVIRONMENT VARIABLES — to
 * exactly the harnesses whose value here is `config-file`. Changing a cell to
 * `config-file` hands that harness's adapter new env entries; changing one away
 * silently removes its primer. It is not a descriptive string.
 */
export type HarnessPrimerChannel =
  | "system-prompt"
  | "developer-instructions"
  | "config-file"
  | "none";

/** A model's identity for the picker: the `(source, id)` pair (C5 §8.1). */
export interface HarnessDefaultModel {
  /** C5's model-source vocabulary: `openrouter | claude-subscription | claude-home | chatgpt`. */
  source: string;
  /**
   * The model id, or the literal `default` when acpx pins nothing and the
   * harness picks its own default.
   */
  id: string;
}

/**
 * How a catalogue row's `(source, id)` becomes the id THIS harness accepts on
 * the wire (brick c4da2ff2, problem 1).
 *
 *  - `bare`            — the row's `id`, verbatim.
 *  - `source-prefixed` — `source + "/" + id`, because the harness namespaces its
 *                        models by provider.
 *
 * ⚠️ **A PER-HARNESS PROPERTY, NOT A PER-SOURCE ONE — WHICH IS THE WHOLE REASON
 * THIS CELL EXISTS.** The obvious shortcut, `source === "openrouter" ? \`openrouter/${id}\`
 * : id`, is correct for pi and **silently wrong for codex**, whose
 * ids carry no prefix at all; and it would be wrong again the day claude's
 * `via-shim` path is wired, because the shim takes an unprefixed OpenRouter id.
 * A UI-side derivation on the source cannot express that, so it must be declared
 * here and shipped (`availability.<agent>.modelId`).
 *
 * The other half of the wire id — the `[rung]` codex fuses in — is NOT restated
 * here: it is already expressed by `depth.mechanism === "compose-into-id"`, and
 * a second cell saying the same thing is a second cell that can disagree.
 */
export type ModelIdForm = "bare" | "source-prefixed";

export interface HarnessModelSupport {
  mechanism: ModelMechanism;
  catalogue: ModelCatalogue;
  idForm: ModelIdForm;
}

export interface HarnessDepthSupport {
  mechanism: DepthMechanism;
  ladder: DepthLadder;
  /**
   * Whether an `effort` CONFIG OPTION is present in the adapter's `session/new`
   * advertisement when the harness runs its own default model. `false` where
   * depth is not a config option at all.
   *
   * This is not a detail — it is the single easiest thing in this program to get
   * subtly wrong (CONCEPTION §5.2). acpx reads the advertised options from the
   * `session/new` SNAPSHOT (src/session/config-option-application.ts:252), so a
   * harness that advertises `effort` only when the CURRENTLY SELECTED model
   * reasons does not advertise it at all under a non-reasoning default. A depth
   * mechanism that is routed in general still never fires there, and every test
   * that pins a reasoning model at creation would pass while the flag silently
   * did nothing.
   */
  configOptionAdvertisedAtSessionNew: boolean;
}

export interface HarnessCredentialSupport {
  tier: CredentialTier;
  providers?: string[];
}

export interface HarnessForkSupport {
  supported: boolean;
  atIndex: ForkAtIndexSupport;
  /**
   * How many acpx message indices make up one truncation boundary. Present only
   * for `turn-granular`; `resolveForkLandingIndex` needs it to answer "where
   * will this fork actually land?" without the caller re-deriving the harness's
   * arithmetic.
   */
  atIndexGranularityMessages?: number;
  /** Which way a between-boundaries request is resolved. Present only for `turn-granular`. */
  atIndexRounding?: "down" | "up";
}

/**
 * Where a `--at-index <requested>` fork will ACTUALLY land for this harness.
 *
 * `undefined` means the question has no answer for that harness: an `ignored`
 * fork lands nowhere (it full-copies) and an `unsupported` one never happens.
 * For `exact` the answer is the request itself. For `turn-granular` it is the
 * request snapped to the nearest boundary in the declared direction — which is
 * what the UI must tell the user BEFORE the fork, not after.
 */
export function resolveForkLandingIndex(
  fork: HarnessForkSupport,
  requestedIndex: number,
): number | undefined {
  if (fork.atIndex === "exact") {
    return requestedIndex;
  }
  if (fork.atIndex !== "turn-granular") {
    return undefined;
  }
  const granularity = fork.atIndexGranularityMessages;
  if (granularity === undefined || granularity <= 0) {
    return undefined;
  }
  const boundaries = requestedIndex / granularity;
  const snapped = fork.atIndexRounding === "up" ? Math.ceil(boundaries) : Math.floor(boundaries);
  return snapped * granularity;
}

/** The full descriptor: hand-written facts plus the derived answers. */
export interface HarnessCapabilities {
  id: HarnessId;
  label: string;

  // ── C5 §8.4: what the picker and the header gate on. ALL DERIVED. ──
  canSetModelLive: boolean;
  canSetDepthLive: boolean;
  /** Shown beside the padlock when `canSetModelLive` is false; null when it is true. */
  liveModelChangeReason: string | null;
  supportsProfiles: boolean;
  supportsOutputStyles: boolean;
  /** false ⇒ the OpenRouter band renders locked. Derived (CONCEPTION §7.4). */
  acceptsArbitraryModelIds: boolean;
  /** `"source:id"` — derived from {@link HarnessCapabilityFacts.defaultModel}. */
  defaultModelKey: string;

  // ── C5 §8.4 continued: three HAND-WRITTEN measurements + their derived reasons ──
  //
  // ⚠️ THESE THREE BOOLEANS ARE NOT DERIVED, AND THE ASYMMETRY WITH
  // `canSetModelLive` IS DELIBERATE — recorded rather than papered over. There is
  // no mechanism field to derive them from, and inventing one to satisfy the
  // "hand-written true is a TYPE ERROR" protection above would be a fabricated
  // derivation: worse than an honest hand-written cell, because it would look
  // checked. They are therefore ABSENT from the `Omit` in
  // {@link HarnessCapabilityFacts} (their reasons are not), and their only
  // defences are the `not measured:` token, an adapter-identity citation beside
  // each cell, and `test/harness-capabilities.test.ts`.
  //
  // ⚠️ EACH IS A FACT ABOUT THE ADAPTER, NEVER ABOUT THE HARNESS'S NAME. That is
  // the whole point: acpx-ui answered all three with `agentType === "claude"`, so
  // pi's values were "measured" against no adapter at all and no adapter swap
  // could ever change them (brick 82a2aafd, discharging 29b8ce8a).

  /**
   * Can this harness clear a session's conversation IN PLACE, keeping the acpx
   * session alive?
   *
   * The mechanism is a passthrough: acpx-ui posts the literal prompt text
   * `/clear` (`ChatView.tsx:5012-5024` at acpx-ui `6a45e58`) and acpx forwards it
   * verbatim — **acpx has no `/clear` handling of its own**: measured on the
   * PRE-state of this commit with `/bin/grep -ra` over `src/`, planted positive
   * control fired and vanished on removal, zero occurrences outside a
   * `set/clear` substring in `mode-preference.ts`. (Stated narrowly on purpose.
   * An earlier draft of this comment said acpx has "no `/clear` concept
   * anywhere", which over-reached: `isSlashCommandRecord`
   * (`src/acp/claude-fork-index.ts:330-342`) is a slash-command concept — see the
   * claude cell, where it is evidence.) So this cell asks whether the HARNESS
   * executes `/clear` as a slash command rather than answering it as an ordinary
   * user message.
   *
   * ⚠️ A wrong `true` here is the silent-wrong-answer class: the client draws the
   * context boundary from the presence of its own `/clear` message, so a harness
   * that merely *replied* to the text produces an identical-looking boundary that
   * hides history which is still in context.
   */
  supportsSessionClear: boolean;
  /** Why not. `null` when {@link supportsSessionClear} is true. */
  sessionClearReason: string | null;

  /**
   * Can this harness's CREDENTIAL be moved on an ALREADY-RUNNING session, without
   * creating a new one?
   *
   * ⚠️ **NOT `supportsProfiles`**, which asks only whether a profile can be bound
   * AT CREATION. codex is `supportsProfiles: true` and `canSetCredentialLive:
   * false` — reusing the create-time answer here would unlock a live control the
   * seam refuses at `account-seam.ts:187`.
   */
  canSetCredentialLive: boolean;
  /** Why not. `null` when {@link canSetCredentialLive} is true. */
  credentialLiveReason: string | null;

  /**
   * Does this harness support acpx's automatic model DEGRADE — the Fable→Opus
   * rewrite that keeps a session running instead of raising a terminal when every
   * subscription is cleanly Fable-exhausted (`src/session/fable-degrade.ts`,
   * brick://4d517be2)?
   *
   * Gates the degrade footer in acpx-ui's model control. `false` does not mean the
   * harness cannot change model — it means acpx has no degrade path that reaches
   * this harness.
   */
  supportsModelDegrade: boolean;
  /** Why not. `null` when {@link supportsModelDegrade} is true. */
  modelDegradeReason: string | null;

  // ── C4 additions: the mechanism, for the CLI and the apply paths ──
  arbitraryModelSupport: ArbitraryModelSupport;
  model: HarnessModelSupport;
  depth: HarnessDepthSupport;
  credential: HarnessCredentialSupport;
  fork: HarnessForkSupport;
  midTurnSteering: boolean;
  primerChannel: HarnessPrimerChannel;
  usageReporting: boolean;
  promptImages: boolean;
}

/**
 * The hand-written half. Deliberately `Omit`s every derived field: a row that
 * tries to state `canSetModelLive` / `canSetDepthLive` / `liveModelChangeReason`
 * / `acceptsArbitraryModelIds` / `defaultModelKey` fails to compile.
 */
export type HarnessCapabilityFacts = Omit<
  HarnessCapabilities,
  | "canSetModelLive"
  | "canSetDepthLive"
  | "liveModelChangeReason"
  | "acceptsArbitraryModelIds"
  | "defaultModelKey"
  // The three REASONS are derived (nulled when their boolean is true); the three
  // BOOLEANS above them are hand-written and stay in, per the note on
  // `supportsSessionClear` in {@link HarnessCapabilities}.
  | "sessionClearReason"
  | "credentialLiveReason"
  | "modelDegradeReason"
> & {
  defaultModel: HarnessDefaultModel;
  /**
   * The reason to show when the derivation says the model cannot be changed
   * live. Never rendered while `canSetModelLive` is true, so it cannot go
   * stale into the UI — {@link deriveHarnessCapabilities} returns null there.
   */
  liveModelChangeBlockedReason: string;
  /**
   * Why {@link HarnessCapabilities.supportsSessionClear} is false. Plain `string`,
   * never null — the null-when-true is the derivation's job, exactly as for
   * {@link liveModelChangeBlockedReason}. Begins with `not measured: ` when this
   * harness's adapter has not been probed (see the three-state convention in the
   * file header).
   */
  sessionClearBlockedReason: string;
  /** Why {@link HarnessCapabilities.canSetCredentialLive} is false. Same contract. */
  credentialLiveBlockedReason: string;
  /** Why {@link HarnessCapabilities.supportsModelDegrade} is false. Same contract. */
  modelDegradeBlockedReason: string;
  /**
   * **The adapter build every claim in this block was measured against**
   * (brick 4791a88c).
   *
   * ## ⚠️ WHY THIS IS A FIELD AND NOT A COMMENT
   *
   * Before this, not one cell in this table named the build it was proven on —
   * measured: zero occurrences of any adapter version anywhere in the file,
   * against 48 `mechanism` hits, so the file is deep and the absence was total.
   * **A claim with no version cannot be shown to have EXPIRED, so it cannot be
   * checked at all.**
   *
   * That is not hypothetical here. pi's `session/set_model` was **real in
   * pi-acp 0.0.26 and gone in 0.0.33**, while this table's comment said it was
   * "proven three ways" — true when written, false when read, and nothing in the
   * file could tell the difference. A version is what turns a belief back into a
   * falsifiable claim.
   *
   * Structured rather than prose so a TEST can require it: every harness must
   * carry one, and the ones acpx pins must agree with `AGENT_REGISTRY`.
   *
   * ⚠️ **COMPLEMENTARY TO F-12's LEARNED FACT, NOT REDUNDANT WITH IT.** The
   * citation makes a claim falsifiable; the runtime learning
   * (`model_set_unsupported_for`) makes it self-correcting when it turns out to
   * be wrong. Neither replaces the other: learning cannot tell you a claim was
   * only ever true of an older build, and a citation cannot fix a live session.
   */
  measuredAgainst: HarnessMeasurementSource;
};

/**
 * The ADAPTER IDENTITY a claim was proven against.
 *
 * ## ⚠️ WHY THIS IS A UNION AND NOT A STRING (brick 4791a88c)
 *
 * It **was** a string, and the string permitted the one value this whole
 * mechanism exists to reject: **`"pi-acp@^0.0.33"`**. The nativai `pi-acp` FORK
 * and UPSTREAM both publish `0.0.33`, so **no version read distinguishes them** —
 * a citation naming only that spec is as unfalsifiable as no citation at all,
 * one level less obvious.
 *
 * That is not a hypothetical about this field; it is its measured history. The
 * guard written to prevent it — *"a citation names a VERSION or a COMMIT, not
 * just a package"* — used `/(\d+\.\d+\.\d+|commit\s+[0-9a-f]{7,})/`, which
 * **rejects `pi-acp` and PASSES `pi-acp@^0.0.33`**. It caught one level and
 * stopped one short of the next. Before that, J1 put the same reconciliation in
 * a **prose comment** beside the field, and *a prose comment is not the field a
 * checker reads*.
 *
 * ⇒ **The remedy is a type, not a stricter regex.** Each arm below makes its own
 * blind spot a REQUIRED field, so the honest-but-ambiguous citation stays
 * expressible — it is sometimes exactly what acpx resolves — but **can no longer
 * be written silently.**
 *
 * ## Ruling v3, which this encodes
 *
 * *A version field is not identity on any harness; identity is the spawn path
 * RESOLVED TO A COMMIT (`/workspace/.runtime/info.json`, or a lane build record:
 * commit + sha256 of the entry file). The spawning line is the pointer, never the
 * identity.* Corroborated rather than asserted: `initialize.agentInfo` reported
 * codex-acp `0.0.45` **unchanged** across `bb17b22 → 42987b87` (CLI 0.144.1 →
 * 0.153.3), so believing the adapter's own version report re-creates this defect
 * one layer down.
 *
 * ⚠️ **Every arm is PLAIN SERIALISABLE DATA on purpose.** Whether this belongs on
 * the exposed descriptor is deferred (brick `86984522`); projecting it later must
 * stay **one line** in {@link deriveHarnessCapabilities}, never a reshaping. Do
 * not add a method, a `symbol`, or a class instance to any arm.
 */
export type HarnessAdapterIdentity =
  /**
   * The strong form: the spawn path resolves to a commit. This is what
   * `/workspace/.runtime/info.json` gives for every BOOTSTRAPPED adapter.
   */
  | {
      kind: "resolved-commit";
      /** How the artifact is spoken about, e.g. `codex-acp 0.0.45`. */
      spec: string;
      /** The commit the spawn path resolves to. */
      commit: string;
      /** sha256 of the entry file, where a lane built the adapter itself. */
      entrySha256?: string;
    }
  /**
   * The honest-but-ambiguous form, and **NOT a lesser citation**: it is what an
   * adapter npx-resolves at spawn, where there is **no commit to cite**.
   *
   * ⚠️ **WHICH ADAPTERS THOSE ARE IS NOT FIXED — IT CHANGES WHEN A BOOTSTRAP
   * SHIPS.** Measured 2026-09-05, `info.json` carried `acpx`, `acpx-ui`,
   * `claude-agent-acp`, `claude-pty-acp`, `codex-acp` and not `pi-acp`.
   * **Re-measured on devbox 2026-09-06T23:00Z it carries `pi` and
   * `pi-acp` too** (`pi-acp` → `af431c6e`, `state: ok`, `ref: main`), because the
   * `e50f051` bootstrap built the fork onto the fleet that morning. So pi now
   * has BOTH a resolvable commit and an npx fallback, and it
   * needs a citation for each — see {@link HarnessMeasurementSource.cellOverrides}
   * and `test/harness-measurement-citations.test.ts` (brick 82a18653).
   *
   * ⇒ This arm is CORRECT for a form that is genuinely npx-resolved. What was
   * wrong before was that its blind spot went unstated, so
   * {@link cannotDistinguish} is REQUIRED.
   */
  | {
      kind: "package-range";
      /** The spec acpx resolves, e.g. `pi-acp@^0.0.33`. Must match the registry. */
      spec: string;
      /**
       * **What this spec does NOT separate.** Required, because a range that
       * cannot name its own ambiguity is the defect this union replaced.
       */
      cannotDistinguish: string;
    }
  /**
   * Never measured on any build. Shares the file's existing vocabulary: the
   * reason begins `not measured:` and names the probe nobody ran.
   */
  | { kind: "not-measured"; reason: string };

/**
 * The nativai `pi-acp` FORK's build record — the identity of the adapter five of
 * pi's cells were actually proven on (brick ef5999ca / B5).
 *
 * ## ⚠️ ADVANCED `eb17203` → `af431c6` ONLY AFTER RE-MEASURING (brick 71ec9e54)
 *
 * The `e50f051` bootstrap built the fork onto the fleet on 2026-09-06 and the
 * deployed commit moved one ahead of the cited one, so this constant went stale
 * **by an act of ours, with nothing reporting it.** It was NOT simply bumped:
 * advancing a citation to a commit nobody measured produces a stale claim wearing
 * a fresh SHA, which is strictly worse than an honestly out-of-date one — the
 * exact move this field exists to prevent.
 *
 * **What was measured, on devbox 2026-09-06T23:2xZ, against the DEPLOYED
 * artifact** (`/opt/pi-acp` → `/workspace/.runtime/pi-acp`, `info.json` `pi-acp`
 * = `af431c6e`, repo `HEAD` agreeing, worktree clean, entry sha256
 * `711536aac8a9939e…`):
 *
 * 1. **The delta is ONE commit** (`af431c6`, "surface pi's turn error instead of
 *    reporting a silent empty end_turn"), touching `src/acp/agent.ts` and
 *    `src/acp/session.ts` only. Of its **72 changed source lines, ZERO** mention
 *    `session/set_model`, `session/fork`, `forkAtMessageIndex`, `usage_update` or
 *    `servedEffort` — with `turnError` firing on 14 of them as the control that
 *    the check can find a term at all. The single overlap is cosmetic:
 *    `piUsageToAcp(session.takeTurnUsage())` is spread **identically**, the return
 *    statement merely reformatted to append an optional `_meta.piAcp.turnError`.
 * 2. **At the WIRE**, against the deployed binary in an isolated `HOME`:
 *    `session/set_model` → `-32602` (dispatched, "Unknown sessionId"),
 *    `session/fork` → `-32602` (dispatched, zod on `cwd`), and the **control**
 *    `session/definitely_not_a_method` → **`-32601` Method not found** on the same
 *    connection. `-32601` is precisely upstream's answer to the first two, so the
 *    discriminator is shown able to fire.
 *
 * ⇒ **No cell's answer differs at `af431c6`.** `model.mechanism` and
 * `fork.supported` are re-measured at the wire; `fork.atIndex` and
 * `usageReporting` rest on (1) — exhaustive over the delta, but **source tier, not
 * wire**: re-proving them needs real turns and a credential, which was not minted.
 * That limit is the honest scope of this bump.
 *
 * Commit plus the entry file's sha256 is what ruling v3 prescribes, and it is what
 * a version string cannot do here: **the fork's `package.json` says `0.0.33`,
 * identical to upstream's.**
 *
 * That the fork needs its own citation at all is structural: pi has TWO reachable
 * launch forms, so **the block names the npx fallback and these cells name the
 * build the claims were proven on** — different builds, both cited (brick
 * 82a18653).
 */
const PI_FORK_BUILD: HarnessAdapterIdentity = {
  kind: "resolved-commit",
  spec: "nativai/pi-acp fork (publishes 0.0.33, indistinguishable from upstream by version)",
  commit: "af431c6",
  entrySha256: "711536aac8a9939e",
};

// The fork build that introduced MID-TURN STEERING (brick 7daa105e): a concurrent
// session/prompt during an active turn is steered into pi's running agent loop and
// acked immediately (`_meta.piAcp.steered`). Cited separately from PI_FORK_BUILD
// because a box running the older fork build af431c6 still has NO steer support —
// the cell is true only from this commit on. Distinguishing the two builds matters:
// both publish 0.0.33, so the commit + entry sha ARE the identity.
const PI_FORK_STEER_BUILD: HarnessAdapterIdentity = {
  kind: "resolved-commit",
  spec: "nativai/pi-acp fork with mid-turn steer (w8/pi-steer-midturn)",
  commit: "0ecae6f",
  entrySha256: "71aa9af8af6abfaa",
};

/** Where a harness block's claims come from, and how to re-derive it. */
export interface HarnessMeasurementSource {
  /**
   * The ADAPTER IDENTITY the block's claims were proven against — **what acpx
   * RESOLVES**, which is the question the anti-drift check asks.
   */
  adapter: HarnessAdapterIdentity;
  /**
   * The UNDERLYING harness binary, where it differs from the adapter and has its
   * own version. Two things go stale independently — pi-acp is not pi, and
   * codex-acp is not the codex CLI — so conflating them would let one move while
   * the citation still looked current.
   */
  harness?: string;
  /**
   * How to re-derive the identity above on any box, so the citation can be
   * CHECKED rather than trusted.
   */
  source: string;
  /**
   * Cells whose claim was proven on a **DIFFERENT build** than {@link adapter},
   * keyed by dotted path into this block (`"model.mechanism"`, `"fork.supported"`).
   *
   * ## ⚠️ THIS EXISTS BECAUSE A BLOCK-LEVEL CITATION IS RIGHT BY ACCIDENT
   *
   * J1, measured: pi's block cites upstream's spec while the comment above its
   * cells says *"EVERY CELL BELOW DESCRIBES THE nativai pi-acp FORK"*. The
   * machine-readable field named one build, the cells described another, and only
   * prose reconciled them. **A per-cell claim carries a per-cell citation.**
   *
   * ⚠️ **Add one ONLY where the cell's proving build genuinely differs.** An
   * override equal to its block is dead weight that goes stale silently — and a
   * cell whose *commentary* is build-specific but whose *value* is not does NOT
   * get one (`primerChannel` is the worked example: the fork changes the
   * mechanism, but `config-file` is the correct coarse category on both builds).
   * **A citation tracks the CLAIM, not the commentary.**
   */
  cellOverrides?: Readonly<Record<string, HarnessAdapterIdentity>>;
}

/**
 * ⚠️ THE THREE LISTS BELOW ARE THE HINGE. They say what ACPX ITSELF ROUTES
 * today — not what the harness is capable of. `HARNESS_FACTS` records the
 * harness's mechanism (measured); these lists record whether acpx has an apply
 * path for that mechanism. The derived booleans are the AND of the two, which is
 * what makes a declared capability incapable of outliving — or preceding — the
 * shipped code.
 *
 * ⚠️ DO NOT "simplify" a derived field to a literal in `HARNESS_FACTS`, and do
 * not extend a list here without landing the apply-path branch in the SAME
 * commit. `test/harness-capabilities.test.ts` pins both directions behaviourally:
 * it calls acpx's real model gate with each harness's advertised shape and
 * requires the answer to agree with `MODEL_MECHANISMS_ROUTED_BY_ACPX`, so
 * adding the entry without the branch goes red, and adding the branch without
 * the entry goes red too.
 */
export const MODEL_MECHANISMS_ROUTED_BY_ACPX: readonly ModelMechanism[] = [
  // `applyRequestedModelIfAdvertised` → `assertRequestedModelSupported`
  // (src/acp/model-support.ts:52-81): the generic path needs an advertised ACP
  // `models` array plus `session/set_model`.
  "set-model",
  // The depth suffix rides inside the model id; acpx forwards the id opaquely
  // and the adapter parses the bracket (MAP §4.2). A live re-pin is accepted and
  // takes effect from the next turn.
  "compose-into-id",
  // ⚠️ `config-option` IS DELIBERATELY ABSENT, AND RE-ADDING IT IS NOT A ONE-LINE
  // CHANGE. acpx has NO model-as-config-option apply path: the branch, its
  // validate-before-persist guard and the per-session `canSetModelLive`
  // refinement were all removed with the last harness that needed them. Adding
  // the entry back without landing that branch in the SAME commit re-creates the
  // silent-brick defect verbatim — a `set model` that reports success, persists a
  // value the adapter can never apply, and leaves the session unrecoverable
  // INCLUDING by setting the model back. The trap and what a re-implementation
  // must handle: brick://2b02ccd3.
];

export const DEPTH_MECHANISMS_ROUTED_BY_ACPX: readonly DepthMechanism[] = [
  // `persistAndApplyRequestedEffort` gates on an advertised `effort` config
  // option (src/session/config-option-application.ts) and
  // `applyConfigOptionIfAdvertised` additionally requires `type === "select"`.
  "config-option",
  // B3: `persistAndApplyRequestedEffort` dispatches to `applyDepthAsMode`, which
  // projects the canonical rung onto the advertised ACP mode ladder and issues
  // `session/set_mode` (I2 R8 — Pi advertises `configOptions: null` and carries
  // thinking level on the mode selector). Landed in the SAME commit as the arm.
  "mode",
];

export const ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX: readonly ArbitraryModelSupport[] = [
  // ⚠️ THIS ENTRY AND ITS ROUTING LANDED IN ONE COMMIT — brick 007eaac8 (Daniel's
  // founding item 6). It is the reason this array is no longer empty, and the
  // reason it must not be edited on its own: the ROUTE that serves the band is
  // `resolveOpenRouterRouteModel` (src/acp/openrouter-routing.ts), which asks
  // `deriveAcceptsArbitraryModelIds` — THIS array — before it will route
  // anything. Declaration and routing are therefore literally the same
  // predicate, not two lists that have to be kept in step (the failure mode the
  // `provisioned` warning below is about). Remove `via-shim` here and claude
  // stops both offering the band AND taking the route, in one edit, with no
  // window where it offers a band acpx does not serve.
  //
  // What "routed" means for `via-shim`, precisely (CONCEPTION §7.4, §11 Q1 —
  // answered in brick 007eaac8 `conception/CONCEPTION-L7-via-shim-routing.md`):
  // a picker-chosen OpenRouter slug is served OUT OF BAND by the per-session
  // OpenRouter shim (`OR_MODEL`), paid for by the BOX key in
  // `~/.acpx/providers.json` — not by a profile's account — and the ACP-side
  // model apply is suppressed, because claude-agent-acp advertises only its own
  // aliases and would refuse the slug. The legacy `--profile` route (the
  // profile's own model on the profile's own account) is untouched.
  "via-shim",
  //
  // ⚠️ `provisioned` IS NOT LISTED HERE EVEN THOUGH acpx PROVISIONS FOR THE
  // HARNESS THAT DECLARES IT — and that is the correction, not an omission.
  // Provisioning is answered PER HARNESS, because each harness has its own config
  // format and its own merge semantics: pi's `models-store.json` merges by id
  // (brick ef5999ca), a measurement taken against pi's format alone. Listing the
  // KIND would switch a harness on from a measurement taken against a config
  // format it does not share, and its picker would offer a band acpx did not
  // provision for. The per-harness array is the seam.
];

/**
 * The harnesses acpx actually generates a catalogue fragment for.
 *
 * One measurement per harness, never one per kind — see the warning above. A
 * harness enters this list when its config format's merge semantics have been
 * measured AND `applyHarnessConfigDir` is passed `provisionModelId` for it.
 *
 * ## ⚠️ EDITING THIS ARRAY CHANGES WHAT ACPX SHIPS, NOT ONLY WHAT IT DECLARES
 *
 * Two things read it, and they used to be independent (brick cba6fa92):
 *
 *   1. **the DECLARATION** — {@link deriveAcceptsArbitraryModelIds}, i.e. whether
 *      the picker offers an arbitrary-slug band for the harness; and
 *   2. **the ROUTING** — `applyHarnessConfigDirEnv` in `src/acp/client.ts`, i.e.
 *      whether a spawn is actually handed `provisionModelId` and a catalogue
 *      fragment is actually written.
 *
 * The routing used to be a hardcoded `harnessIdForAgentCommand(…) === "pi"`
 * literal in `client.ts`, so the two could disagree: this array said the picker
 * offers the band while the spawn wrote nothing, or the reverse — a harness added
 * here got a red row and no shipped behaviour change. **Both now go through
 * {@link harnessProvisionsModelCatalogue}, so this array is the single place such
 * an edit lands.** That is the whole point; do not re-inline either read.
 *
 * ⇒ **An entry added here PROVISIONS AT SPAWN TIME immediately.** It needs its own
 * merge-vs-replace measurement first — the argument is in the block above and in
 * `test/harness-capabilities.test.ts`'s "the SHIPPED per-harness provisioning
 * list …" row. Pinned in BOTH directions, on the shipped defaults and through a
 * real adapter spawn, by `test/harness-config-dir-spawn-env.test.ts` →
 * *"the SHIPPED provisioning list is what the spawn routes on"*.
 */
export const ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR: readonly HarnessId[] = [
  // pi — `models-store.json` is measured to merge BY ID (brick ef5999ca): same id
  // replaces, new id appends, and `writePiModelsStore` copies the box's own
  // catalogue forward before upserting.
  "pi",
];

/**
 * Whether acpx generates a catalogue fragment for this harness — the ONE read of
 * {@link ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR}, shared by the declaration and
 * the spawn-time routing so the two cannot drift apart (brick cba6fa92).
 *
 * `undefined` is `false`: an adapter acpx cannot classify is not a harness whose
 * config format has been measured, and provisioning writes a harness-specific
 * file — there is nothing to write it into.
 *
 * Parameterised on the list, like {@link deriveCanSetModelLive}, so a test can
 * hand it a synthetic one and watch the answer flip — the property that proves
 * every consumer is a derivation and not a literal.
 */
export function harnessProvisionsModelCatalogue(
  harness: HarnessId | undefined,
  provisionedFor: readonly HarnessId[] = ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR,
): boolean {
  return harness !== undefined && provisionedFor.includes(harness);
}

/** Mechanisms that are a LIVE model change at all, once acpx routes them. */
const LIVE_MODEL_MECHANISMS: ReadonlySet<ModelMechanism> = new Set([
  "set-model",
  "config-option",
  "compose-into-id",
]);

/**
 * Mechanisms that are a live DEPTH change. `compose-into-id` is excluded on
 * purpose: for codex the depth is a property of the model id, so a depth control
 * cannot move it — `set effort` is a silent no-op there because codex never
 * advertises a selectable `effort` (MAP §4.4). Changing codex depth means
 * changing the model id.
 */
const LIVE_DEPTH_MECHANISMS: ReadonlySet<DepthMechanism> = new Set(["config-option", "mode"]);

/**
 * Whether the model can be changed on a live session.
 *
 * Exported and parameterised so a test can hand it a synthetic routed-mechanism
 * list and watch the answer flip — the property that proves this is a derivation
 * and not a literal (program TEST-PLAN `G1-CFG-04`).
 */
export function deriveCanSetModelLive(
  mechanism: ModelMechanism,
  routedMechanisms: readonly ModelMechanism[] = MODEL_MECHANISMS_ROUTED_BY_ACPX,
): boolean {
  return LIVE_MODEL_MECHANISMS.has(mechanism) && routedMechanisms.includes(mechanism);
}

/**
 * Whether the thinking depth can be changed on a live session. Same shape as
 * {@link deriveCanSetModelLive}, plus one term: a `config-option` mechanism is
 * only live if the option is actually in the `session/new` advertisement acpx
 * reads — see {@link HarnessDepthSupport.configOptionAdvertisedAtSessionNew}.
 */
export function deriveCanSetDepthLive(
  depth: HarnessDepthSupport,
  routedMechanisms: readonly DepthMechanism[] = DEPTH_MECHANISMS_ROUTED_BY_ACPX,
): boolean {
  if (!LIVE_DEPTH_MECHANISMS.has(depth.mechanism)) {
    return false;
  }
  if (!routedMechanisms.includes(depth.mechanism)) {
    return false;
  }
  return depth.mechanism !== "config-option" || depth.configOptionAdvertisedAtSessionNew;
}

/** Whether an id outside the harness's own catalogue can be used (CONCEPTION §7.4). */
export function deriveAcceptsArbitraryModelIds(
  support: ArbitraryModelSupport,
  harness?: HarnessId,
  routedSupport: readonly ArbitraryModelSupport[] = ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX,
  provisionedFor: readonly HarnessId[] = ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR,
): boolean {
  if (support === "none") {
    return false;
  }
  if (support === "provisioned") {
    return harnessProvisionsModelCatalogue(harness, provisionedFor);
  }
  return support === "native" || routedSupport.includes(support);
}

/** `(source, id)` → the `"source:id"` key the picker and the favorites store use (C5 §8.1). */
export function deriveDefaultModelKey(defaultModel: HarnessDefaultModel): string {
  return `${defaultModel.source}:${defaultModel.id}`;
}

/** Facts → the full descriptor. The only place the derived fields are produced. */
export function deriveHarnessCapabilities(facts: HarnessCapabilityFacts): HarnessCapabilities {
  const canSetModelLive = deriveCanSetModelLive(facts.model.mechanism);
  return {
    id: facts.id,
    label: facts.label,
    canSetModelLive,
    canSetDepthLive: deriveCanSetDepthLive(facts.depth),
    liveModelChangeReason: canSetModelLive ? null : facts.liveModelChangeBlockedReason,
    supportsProfiles: facts.supportsProfiles,
    supportsOutputStyles: facts.supportsOutputStyles,
    acceptsArbitraryModelIds: deriveAcceptsArbitraryModelIds(facts.arbitraryModelSupport, facts.id),
    defaultModelKey: deriveDefaultModelKey(facts.defaultModel),
    // The three hand-written booleans ride through unchanged; only their reasons
    // are derived — null IFF the boolean is true, the same rule
    // `liveModelChangeReason` follows one line above.
    supportsSessionClear: facts.supportsSessionClear,
    sessionClearReason: facts.supportsSessionClear ? null : facts.sessionClearBlockedReason,
    canSetCredentialLive: facts.canSetCredentialLive,
    credentialLiveReason: facts.canSetCredentialLive ? null : facts.credentialLiveBlockedReason,
    supportsModelDegrade: facts.supportsModelDegrade,
    modelDegradeReason: facts.supportsModelDegrade ? null : facts.modelDegradeBlockedReason,
    arbitraryModelSupport: facts.arbitraryModelSupport,
    model: { ...facts.model },
    depth: { ...facts.depth },
    credential: {
      tier: facts.credential.tier,
      ...(facts.credential.providers ? { providers: [...facts.credential.providers] } : {}),
    },
    fork: { ...facts.fork },
    midTurnSteering: facts.midTurnSteering,
    primerChannel: facts.primerChannel,
    usageReporting: facts.usageReporting,
    promptImages: facts.promptImages,
  };
}

/**
 * The declared table. Hand-written facts only — every cell traces to a findings
 * row or a `file:line`.
 */
export const HARNESS_FACTS: Record<HarnessId, HarnessCapabilityFacts> = {
  claude: {
    id: "claude",
    label: "claude",
    measuredAgainst: {
      // Built into the image, so the COMMIT is the identity — the package
      // version (0.39.0) is not bumped per build and would not distinguish two
      // images. Both read from the deployed artifact, not from a document.
      adapter: {
        kind: "resolved-commit",
        spec: "claude-agent-acp 0.39.0",
        commit: "0d5ab3ab",
      },
      source:
        "node -p require('/opt/claude-agent-acp/package.json').version + git -C /opt/claude-agent-acp rev-parse --short HEAD",
    },
    supportsProfiles: true,
    supportsOutputStyles: true, // MAP §3.1 — harness-sourced list, create/resume only
    // CONCEPTION §7.4. The shim's model came from the PROFILE until brick
    // 007eaac8; it now also takes a picker-chosen slug on the box key
    // (src/acp/openrouter-routing.ts). `via-shim` is in
    // ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX as of that commit, so this cell now
    // derives `acceptsArbitraryModelIds: true`.
    arbitraryModelSupport: "via-shim",
    model: {
      // `query.setModel(...)` on the SDK object, claude-agent-acp src/acp-agent.ts:1990-2019 (MAP §3.1)
      mechanism: "set-model",
      // SDK-queried `initializationResult.models` + two hardcoded injections (MAP §3.1)
      catalogue: "acp",
      // MEASURED 2026-09-06 on TWO live turns against the deployed
      // `/opt/claude-agent-acp` (brick c4da2ff2): the wire id is the bare alias.
      //   (a) session 8686e427 — acpx sent `opus`; the adapter advertised
      //       `default | opus[1m] | sonnet | haiku | opus | fable`.
      //   (b) a completed turn on an isolated rig — acpx sent `sonnet`, the turn
      //       ended `end_turn`, and Claude Code's OWN transcript recorded
      //       `message.model = claude-sonnet-5`.
      // ⚠️ `claude-sonnet-5` is the SERVED api model, NOT the wire id. Two model
      // ids appear in that file and only one is the one to send; they are told
      // apart by the field's ROLE (what acpx SENT vs what the provider SERVED),
      // never by position. Shipping the served id would put a string the
      // catalogue does not contain into the picker.
      idForm: "bare",
    },
    depth: {
      // `{id:"effort", category:"thought_level", type:"select"}`, claude-agent-acp :3939-3947 (MAP §3.1)
      mechanism: "config-option",
      // values = `default` + `ModelInfo.supportedEffortLevels` (MAP §3.1)
      ladder: "per-model",
      // Advertised unconditionally at `session/new` (MAP §3.1) — which is why
      // acpx's `--reasoning-effort` works for claude today.
      configOptionAdvertisedAtSessionNew: true,
    },
    // `subscription` and `openrouter` auth modes both force adapter `claude`
    // (src/config/profiles.ts:145-156).
    credential: { tier: "profile", providers: ["claude-subscription", "openrouter"] },
    // `sessionCapabilities.fork` claude-agent-acp :839; acpx resolves the Claude
    // transcript UUID for the requested index (src/acp/client.ts:204-218,
    // src/acp/claude-fork-index.ts) and refuses loudly when it cannot.
    fork: { supported: true, atIndex: "exact" },
    midTurnSteering: true, // src/acp/mid-turn-injection-support.ts:5-20
    primerChannel: "system-prompt", // `_meta.systemPrompt`, resolvePrimerChannel (src/acp/agent-command.ts)
    usageReporting: true, // MAP §3.1 — `usage_update`
    promptImages: true, // MAP §3.1 — `promptCapabilities.image: true`
    // ⚠️ STATED RESIDUAL — THIS `true` IS NOT FULLY MEASURED, AND THE CONTRACT
    // CANNOT SAY SO ON THE WIRE. `<field>Reason` is null IFF its boolean is true,
    // so a `false` carries provenance and a `true` carries none. That asymmetry is
    // real, it is the descriptor owner's recorded ruling (2026-09-05: emit `true`,
    // do not change the six keys — the consumer is already coding against
    // null-IFF-true, and moving it for one cell's provenance would break a contract
    // two lanes have built on), and the fix belongs to the adapter-identity
    // citation work in brick 4791a88c, not here. Which is why the split is written
    // HERE, at the cell, and not only in a report: this is where the next reader
    // looks.
    //
    // MEASURED in the harness
    // binary both Claude adapters drive (`claude --version` = 2.1.251 at
    // /home/node/.local/share/claude/versions/2.1.251; `grep -ao` 2026-09-05, with
    // a positive control on "Claude Code" = 4427 hits and a planted negative = 0):
    //   name:"clear",description:"Start a new session with empty context; previous
    //   session stays on disk (resumable with /resume)"
    // — so `/clear` is a real slash command of the harness, not text it answers.
    // PARTIALLY measured on the remaining link, and the evidence is inside acpx:
    // `isSlashCommandRecord` (src/acp/claude-fork-index.ts:330-342) classifies
    // Claude transcript records whose content begins `<command-name>` /
    // `<local-command-stdout>` / `<local-command-stderr>` / `<command-message>` —
    // the wrappers Claude Code writes when it EXECUTES a slash command, not when
    // it answers text. acpx carries that classifier because such records occur on
    // the very path this cell is about, so the SDK path demonstrably executes
    // slash commands rather than prompting with them.
    // STILL NOT measured: that `/clear` SPECIFICALLY is among them and that it
    // clears context (the adapter has ZERO `/clear` occurrences in
    // /opt/claude-agent-acp/dist, control `session/new` = 6 — it forwards the text
    // untouched, so nothing acpx-side names the command). `true` is what
    // acpx-ui has shipped for claude since before this descriptor existed
    // (agentCapabilities.ts R1 at 6a45e58); this brick must not change claude
    // behaviour, and flipping it to false would remove a working control.
    supportsSessionClear: true,
    sessionClearBlockedReason:
      "This harness does not execute /clear as a slash command, so the text would be answered as an ordinary message and the context would stay.",
    // MEASURED, and dispatched on the ADAPTER: `switchSessionAccount` — the one
    // credential-move seam, reached by `acpx <agent> set profile` via
    // `setSessionProfile` (src/cli/session/session-control.ts:343-377) — admits a
    // record only through `assertClaudeFamilySeam`
    // (src/runtime/engine/account-seam.ts:111-120 → `isClaudeFamilyAgent`,
    // src/acp/agent-command.ts:226-232, whose set is {claude, claude-pty}). The move
    // is a record edit + transcript port + owner restart, so the SESSION survives
    // even though the adapter process does not — which is what "live" means here.
    // A `subscription` profile has a transcript anchor (`credentialSource`,
    // src/config/profiles.ts:854-865), so `requireAnchor` (:82-90) passes.
    canSetCredentialLive: true,
    credentialLiveBlockedReason:
      "acpx's credential move is Claude-family only: this session's adapter has no Claude account to move and no Claude transcript to port.",
    // MEASURED end to end in source at this commit: the degrade fires ONLY inside
    // the subscription failover engine — `resolveFailoverRecord`
    // (src/cli/session/runtime.ts:1367-1378) → `failoverEnabledForRecord`
    // (src/runtime/engine/failover.ts:582-590, needs a profile with a non-null
    // `transcriptAnchorDir`) → `prepareFableShortCircuit` (:372-393, needs
    // `isFableModel` + a `rate_limit` trigger) → `applyFableDegrade` (:337-339,
    // src/session/fable-degrade.ts:79-86). A `subscription` profile satisfies the
    // anchor and Fable is offerable here, so claude is the harness the path was
    // built for (brick://4d517be2).
    supportsModelDegrade: true,
    modelDegradeBlockedReason:
      "acpx's Fable→Opus degrade runs only inside the Claude-subscription failover engine, which does not reach this harness.",
    defaultModel: { source: "claude-subscription", id: "default" }, // C5 §8.4's own example
    liveModelChangeBlockedReason:
      "acpx has no live model path for this harness; recreate the session with a different --model.",
  },

  codex: {
    id: "codex",
    measuredAgainst: {
      // TWO versions, because they move independently: the adapter, and the
      // codex CLI bundled UNDER it. Citing only one would let the other drift
      // while the citation still read as current.
      //
      // ⚠️ THE FIRST RE-TAKE PROVED THE POINT OF THE COMMIT FIELD. At the
      // 0.153.3 boundary the adapter's PACKAGE VERSION did not move — it is
      // 0.0.45 before and after — while the commit went `bb17b22` → `42987b87`
      // and the bundled CLI went 0.144.1 → 0.153.3. A citation carrying only the
      // package version would have read as current across a bump that changed
      // the harness's depth vocabulary. This is the same limit spelled out for
      // claude-pty, arriving on a harness that does have a real version.
      //
      // ⚠️ The box's own `codex` on PATH is a DIFFERENT build from the one the
      // adapter bundles (measured: 0.144.6 on PATH against 0.144.1 bundled,
      // before the bump). Reading the CLI on PATH would cite a binary these
      // claims were never measured against.
      adapter: {
        kind: "resolved-commit",
        spec: "codex-acp 0.0.45",
        commit: "42987b87",
      },
      harness: "@openai/codex 0.153.3 (bundled at /opt/codex-acp/node_modules/@openai/codex)",
      source:
        "node -p require('/opt/codex-acp/package.json').version + node -p require('/opt/codex-acp/node_modules/@openai/codex/package.json').version",
    },
    label: "codex",
    // A `chatgpt` profile is bound to codex (src/config/profiles.ts:145-156,
    // re-asserted at spawn src/acp/auth-env.ts:1213-1226). Note acpx-ui's LIVE
    // profile-switch route stays gated to claude/claude-pty (CONCEPTION §9.2).
    supportsProfiles: true,
    supportsOutputStyles: false, // MAP §3.1 — zero `outputStyle` references in codex-acp
    arbitraryModelSupport: "none", // CONCEPTION §7.4 — fixed backend; ids are `family[effort]`
    model: {
      // app-server model × effort cross-product into `model[effort]` ids; acpx
      // forwards the id opaquely and codex-acp parses the bracket (MAP §3.1, §4.2).
      // The pin is stored for the NEXT turn (codex-acp CodexAcpServer.ts:406-447).
      mechanism: "compose-into-id",
      catalogue: "acp", // app-server-queried `listModels`, paginated (MAP §3.1)
      // NO provider prefix — codex ids are `family[effort]` and a BARE FAMILY IS
      // REFUSED. The bracket is not stated here: `depth.mechanism ===
      // "compose-into-id"` below already says it, and one fact in two cells is
      // one fact that can disagree with itself.
      idForm: "bare",
    },
    depth: {
      // No `effort` config option at all — only a `fastMode` boolean; effort
      // rides inside the model id (MAP §3.1). So the depth CONTROL cannot move
      // it: `set effort` is a silent no-op for codex (MAP §4.4).
      mechanism: "compose-into-id",
      // the cross-product is per model — `gpt-5.6-luna[ultra]` is rejected when
      // luna tops out at max (src/acp/model-support.ts:9-11)
      ladder: "per-model",
      configOptionAdvertisedAtSessionNew: false, // MAP §3.1 — no `effort` option at all, only `fastMode`
    },
    credential: { tier: "profile", providers: ["chatgpt"] },
    // ⚠️ MEASURED CORRECTION, and it contradicts CONCEPTION §8's prose ("Codex's
    // loud refusal") and brick 276594c2's title. codex-acp DOES implement
    // at-index truncation: app-server `thread/fork` followed by a
    // `threadRollback({numTurns: totalTurns - turnsToKeep})` (MAP §3.2, commit
    // 989a802). Verified on the DEPLOYED build this box's registry launches —
    // `/opt/codex-acp/dist/index.js` contains `threadRollback({`,
    // `numTurnsToDrop = totalTurns - turnsToKeep` and `numTurns: numTurnsToDrop`
    // (2026-09-04, `grep -a`). The "fork-at-index is not supported yet" string in
    // the same bundle belongs to `hasUnsupportedForkTruncation`, which rejects
    // eight OTHER truncation vocabularies; the exact `_meta.acpx.forkAtMessageIndex`
    // shape acpx sends (src/acp/client.ts:218) is the one it honours.
    // ⚠️ It is NOT `exact`, and that distinction is the point of the field:
    // the truncation is TURN-granular — `turnsToKeep = floor(forkAtMessageIndex
    // / 2)` (2 acpx messages = 1 Codex turn, MAP §3.2), so a request to fork at
    // message 7 silently lands at message 6. Encoding that as `exact` would
    // reproduce, inside the table built to end silent-wrong-answer forks, the
    // very bug it exists to end. `ignored` is equally false (a truncation DOES
    // happen) and so is `unsupported` (nothing is refused). Fourth value added
    // by WS-core's call, 2026-09-04, on this evidence; the rounding rule is
    // carried as DATA so the UI can say where the fork will land.
    fork: {
      supported: true,
      atIndex: "turn-granular",
      atIndexGranularityMessages: 2,
      atIndexRounding: "down",
    },
    midTurnSteering: true, // src/acp/mid-turn-injection-support.ts:5-20
    primerChannel: "developer-instructions", // `_meta.codex.developerInstructions` (MAP §3.1)
    usageReporting: true, // MAP §3.1 — from app-server `thread/tokenUsage/updated`
    promptImages: true, // MAP §3.1 — `image:true`
    // NOT MEASURED. codex-acp forwards the prompt to the app-server
    // (CodexCli.ts / CodexJsonRpcConnection.ts, MAP §3.4); the codex CLI has its own
    // slash-command surface, and nobody has sent `/clear` through this adapter to
    // see whether it reaches it. ⚠️ The adapter bundle's one apparent `/clear` hit
    // is a SUBSTRING FALSE POSITIVE — `case "thread/goal/cleared":`
    // (/opt/codex-acp/dist/index.js, `grep -rao` 2026-09-05). It is recorded here
    // because it reads as evidence at a glance and is not; the same probe's
    // claude-pty "hit" was `set/clear ACPX_PARENT_SESSION_URL` in a sourcemap.
    supportsSessionClear: false,
    sessionClearBlockedReason:
      "not measured: no probe has sent /clear as a prompt through codex-acp to the codex app-server to see whether it is executed as a slash command.",
    // MEASURED, and it is the cell that proves `supportsProfiles` is a DIFFERENT
    // question: codex is `supportsProfiles: true` (a `chatgpt` profile binds to it
    // at creation) and still cannot move credential live, for two independent
    // reasons. (1) `assertClaudeFamilySeam` (src/runtime/engine/account-seam.ts:111-120)
    // refuses every non-{claude, claude-pty} adapter BEFORE any work, and throws
    // rather than no-ops on purpose. (2) Even inside the seam, `requireAnchor`
    // (:82-90) would refuse: `transcriptAnchorDir` returns null for `chatgpt`
    // (src/config/profiles.ts:854-865) — there is no Claude transcript to port.
    canSetCredentialLive: false,
    credentialLiveBlockedReason:
      "acpx's credential move is Claude-family only. A chatgpt profile binds at creation but has no portable transcript anchor, so it cannot be moved on a running session — recreate the session on the other profile.",
    // MEASURED: the degrade lives only inside the failover engine, and codex never
    // enters it. `failoverEnabledForRecord` (src/runtime/engine/failover.ts:582-590)
    // requires a profile with a non-null `transcriptAnchorDir`, which is null for
    // `chatgpt` (src/config/profiles.ts:854-865) — the same carve-out that once
    // killed every codex turn in ~13 ms (brick://792ad0a4, now generalised at
    // failover.ts:520-554). Independently, Fable is an Anthropic model and codex's
    // catalogue is the OpenAI app-server cross-product, so there is nothing to
    // degrade from.
    supportsModelDegrade: false,
    modelDegradeBlockedReason:
      "acpx's Fable→Opus degrade runs only inside the Claude-subscription failover engine, which a chatgpt-profile session never enters; and Fable is not in this harness's catalogue.",
    defaultModel: { source: "chatgpt", id: "default" },
    liveModelChangeBlockedReason:
      "acpx has no live model path for this harness; recreate the session with a different --model.",
  },

  pi: {
    id: "pi",
    measuredAgainst: {
      // ⚠️ THE BLOCK THAT PROVES WHY THIS FIELD EXISTS. `model.mechanism:
      // "set-model"` below was measured on pi-acp 0.0.26 and is FALSE on 0.0.33,
      // which answers `-32601 Method not found`. The comment said "proven three
      // ways" and named no version, so nothing in the file could show the claim
      // had expired. F-12's runtime learning is what corrects it live; this is
      // what makes it checkable at all.
      adapter: {
        kind: "package-range",
        spec: "pi-acp@^0.0.33",
        // ⚠️⚠️ THIS IS THE FIELD THE WHOLE UNION EXISTS FOR. `^0.0.33` on a 0.0.x
        // range pins exactly, and it STILL does not identify a build: the nativai
        // fork and upstream BOTH publish 0.0.33. Measured on 8af293e, both arms in
        // one run, the resolved adapter command printed first: the FORK answers
        // `session/set_model` rc=0 and forks; UPSTREAM answers -32601 to both — and
        // NO VERSION READ SEPARATES THEM. Under the old `adapter: string` this spec
        // satisfied the guard; the required field below is what stops that.
        cannotDistinguish:
          "the nativai pi-acp FORK from UPSTREAM pi-acp — both publish 0.0.33, so no version read separates them. Which one runs is decided by resolvePiAcpCommand (src/agent-registry.ts): `node /opt/pi-acp/dist/index.js` when that path exists, else this npx range. THIS SPEC CITES THE FALLBACK ARM ONLY, and which arm a box takes is box state, not a property of this file: measured 2026-09-05 devbox had no /opt/pi-acp and resolved UPSTREAM; the e50f051 bootstrap built the fork onto all five boxes on 2026-09-06, so they now resolve the FORK, whose commit is cited in cellOverrides (brick 82a18653). Cells whose truth differs between the two carry their own cellOverrides.",
      },
      harness: "@earendil-works/pi-coding-agent 0.84.4",
      source:
        "ACP_ADAPTER_PACKAGE_RANGES.pi in src/agent-registry.ts + the pi binary's own --version",
      // ⚠️ THE FIVE CELLS J1 CAUGHT. The block citation above names what acpx
      // RESOLVES on this box — UPSTREAM. These five were proven on the nativai
      // FORK, and are FALSE upstream. Before this they were reconciled only by
      // the prose comment below `label`, and "a prose comment is not the field a
      // checker reads": the machine-readable field said upstream while the cells
      // described the fork — right by accident and wrong by intent.
      //
      // ⚠️ FIVE, NOT "the pi block". `primerChannel` is deliberately absent: the
      // fork does change the mechanism (it reads PI_ACP_APPEND_SYSTEM_PROMPT_FILE
      // instead of re-pointing PI_CODING_AGENT_DIR, brick ac86eb34) but
      // `config-file` stays the correct coarse category on BOTH builds, so the
      // VALUE does not diverge. `canSetCredentialLive` and `supportsModelDegrade`
      // are likewise absent — their own comments record that they dispatch on
      // adapter KIND, which is `pi` for the fork and upstream alike. An override
      // equal to its block is dead weight that goes stale silently.
      //
      // ⚠️ CITED BY BUILD RECORD — commit plus the sha256 of the entry file —
      // because that is the build these cells were PROVEN on. The superseded
      // wording gave a different reason ("no box installs the fork today"), and
      // that reason expired on 2026-09-06 when the bootstrap put `/opt/pi-acp` on
      // all five boxes; the citation did not, because a deployment does not
      // re-prove anything. It was re-measured against the deployed `af431c6` and
      // advanced there — see PI_FORK_BUILD for what was measured at the wire and
      // what rests on the delta alone (bricks 82a18653, 71ec9e54).
      cellOverrides: {
        "model.mechanism": PI_FORK_BUILD,
        "fork.supported": PI_FORK_BUILD,
        "fork.atIndex": PI_FORK_BUILD,
        usageReporting: PI_FORK_BUILD,
        liveModelChangeBlockedReason: PI_FORK_BUILD,
        // Mid-turn steering is FORK-ONLY by construction, and NEWER-fork-only:
        // upstream pi-acp 0.0.33 and fork builds through af431c6 queue a concurrent
        // session/prompt behind the active turn (turnQueue); the steer feature lands
        // in the fork at 0ecae6f (brick 7daa105e, 2026-09-09).
        midTurnSteering: PI_FORK_STEER_BUILD,
      },
    },
    label: "pi",
    // ⚠️ EVERY CELL BELOW DESCRIBES THE **nativai `pi-acp` FORK** (B5, brick
    // ef5999ca), which `agent-registry.ts` launches from `/opt/pi-acp` when the
    // box has it. Against UPSTREAM `pi-acp@0.0.33` the `fork`, `set-model` and
    // `usageReporting` cells are all FALSE — measured, in one run, on one
    // session: `session/set_model` and `session/fork` both answer
    // `-32601 Method not found` there. A box still falling back to upstream
    // therefore advertises three capabilities its adapter refuses at the wire;
    // that drift is what `G4-PI-01` (the SPAWN LINE, not the registry string)
    // exists to catch.
    supportsProfiles: false, // MAP §2.2 — no AuthMode maps to a fourth harness
    supportsOutputStyles: false, // not a Pi concept (I2 R11)
    // B5: pi's `models-store.json` MERGES BY ID with the bundled catalogue and a
    // generated entry is honoured (measured, pi 0.84.4: 333 → 334 offered models,
    // planted slug served, catalogue intact). The generator lives in
    // `harness-config-dir.ts` and carries the mandatory `lastModified` stamp.
    arbitraryModelSupport: "provisioned",
    model: {
      // Live via ACP `session/set_model`. ⚠️ THE HISTORY OF THIS CELL IS THE
      // REASON IT NOW NAMES A BUILD: it was TRUE for pi-acp 0.0.26, went FALSE at
      // 0.0.33 with nothing failing, and is TRUE again in the fork — because the
      // ACP SDK dropped `session/set_model` from `AGENT_METHODS` between 0.12 and
      // 0.26, orphaning the adapter's handler, and the fork re-routes it through
      // the SDK's `extMethod` seam. Measured end to end on the fork (pi 0.84.4,
      // SDK 0.26.0): the call returns, and the session's context window moves
      // 262,144 → 1,024,000 across the switch, which is what proves the MODEL
      // changed rather than the call merely returning.
      mechanism: "set-model",
      catalogue: "acp", // `session/new`/`session/load` return `models.availableModels`
      // MEASURED: pi's own transcript stores `provider` and `modelId`
      // SEPARATELY (`provider="openrouter"`, `modelId="moonshotai/kimi-k2-thinking"`)
      // and the id acpx sends is the two rejoined — the catalogue row's
      // `source + "/" + id`. Corroborated by pi's `available_models`
      // advertisement on this box, every row of which is `openrouter/<slug>`,
      // and by the session store — e.g. `openrouter/qwen/qwen3-coder-flash`.
      idForm: "source-prefixed",
    },
    depth: {
      // I2 R8: thinking level rides the ACP MODE selector; `configOptions` is
      // null, so acpx's `--reasoning-effort` (gated on an advertised `effort`
      // config option) can never apply. `acpx pi set-mode <level>` does work.
      mechanism: "mode",
      // ⚠️ `acp` IS NOW LOAD-BEARING, NOT A HEDGE. Pi's ladder is per MODEL: pi
      // resolves a level through the catalogue entry's `thinkingLevelMap`
      // (`effort = map[level] === undefined ? level : map[level]`, an explicit
      // `null` meaning NO reasoning parameter is sent), and measured across pi
      // 0.84.4's 374-model OpenRouter catalogue, 185 models carry no map at all
      // while the rest collapse differently — no two-line table can describe it.
      // The fork advertises one rung per DISTINCT served value and states that
      // value on `_meta.piAcp.servedEffort`; `depth-projection.ts` READS it
      // instead of remembering it.
      ladder: "acp",
      configOptionAdvertisedAtSessionNew: false, // I2 R8/R11 — `configOptions` is null; depth rides `modes`
    },
    credential: { tier: "box-provider", providers: ["openrouter"] }, // I2 R6 — plain OPENROUTER_API_KEY
    // B5: the fork implements `session/fork` on pi's JSONL session tree (the SDK
    // already dispatched it; upstream simply had no handler), and honours
    // `_meta.acpx.forkAtMessageIndex` by truncating the copied JSONL after the
    // nth message record. Proven two-way on real turns: the source recalls both
    // planted facts, the fork truncated at index 2 recalls the first and answers
    // UNKNOWN for the second — from a SEPARATE adapter process that resolved it
    // by `session/load`, so it is the file that carries the history.
    // ⚠️ THE INDEX MAPPING IS VERIFIED ON BOTH SIDES, because "exact" is a claim
    // about two counts agreeing. acpx's side: `ensureAgentMessage`
    // (src/session/conversation-model.ts:358-369) REUSES the last entry when it is
    // already an Agent entry, so a whole turn — text, tool uses, tool results —
    // accumulates into ONE Agent entry until a User entry intervenes.
    //
    // `exact` is claimed on a MEASURED basis, not on the fork returning success:
    // the fork counts the index in CLIENT messages (a `user` record, or an
    // `assistant` record that closes a turn), because pi's JSONL writes THREE
    // records for one tool-using turn — assistant(toolCall), toolResult,
    // assistant — where the client counts one. Counting records instead would
    // land three records early on a session with one tool call and still report
    // success.
    fork: { supported: true, atIndex: "exact" },
    // ⚠️ FLIPPED 2026-09-09 (brick 7daa105e) — was `false` per I2 R3 (measured
    // 2026-09-03 against a pi-acp that queued concurrent prompts). The nativai
    // fork now STEERS: a concurrent session/prompt during an active turn is handed
    // to pi's running agent loop (pi RPC `steer` — delivered after the current tool
    // calls finish, before the next LLM call) and resolves immediately with a
    // steer-ack `_meta.piAcp.steered`. Verified live on devbox (rig sessions
    // 01a0876e pre-fix / post-fix rerun, claude control 22e5220a). TRUE ONLY ON THE
    // FORK: upstream pi-acp still queues concurrent prompts, so a box without
    // /opt/pi-acp would see the injected prompt land post-turn — see the
    // `cellOverrides["midTurnSteering"]` build citation.
    midTurnSteering: true, // pi-acp fork commit carrying steer (w8/pi-steer-midturn); src/acp/mid-turn-injection-support.ts:5-20
    // ⚠️ THE FORK ADDS A PRIMER CHANNEL THAT DOES NOT MOVE pi's DATA DIR, and
    // that distinction is the whole point: `PI_CODING_AGENT_DIR` is pi's DATA dir
    // as well as its config dir, so re-pointing it for a primer took the session
    // store with it (brick ac86eb34). The fork reads
    // `PI_ACP_APPEND_SYSTEM_PROMPT_FILE` and passes `--append-system-prompt` to
    // pi. `config-file` remains correct as the descriptor's coarse category —
    // acpx still writes a file and points the adapter at it — and the file it
    // writes (`APPEND_SYSTEM.md`) keeps working on upstream.
    primerChannel: "config-file",
    // B5: the fork carries pi's own per-message accounting over ACP — live
    // `usage_update` notifications (cumulative cost) and `session/prompt.usage`
    // per turn. Upstream carries none of it although pi's JSONL has it all
    // (I2 R12).
    usageReporting: true,
    promptImages: true, // I2 R11 — `promptCapabilities: {image:true, audio:false, embeddedContext:false}`
    // NOT MEASURED, AND ITS TRUTH DEPENDS ON WHICH pi-acp IS RUNNING — say that
    // rather than pick one. ⚠️ A VERSION FIELD CANNOT SETTLE IT: the nativai fork
    // and upstream BOTH report `0.0.33`, so no version read separates them;
    // identity is the spawn path resolved to a commit. Measured on devbox
    // 2026-09-06T23:00Z: `/opt/pi-acp/dist/index.js` EXISTS here, so this box
    // resolves the FORK — the 2026-09-05 reading of this same line said the
    // opposite, which is the point: the answer is box state and moves under the
    // file. Pi's own TUI has slash commands, but nobody has sent
    // `/clear` as a PROMPT through either adapter, and the fork could add handling
    // upstream does not have. I2 R3/R11 enumerated pi's ACP surface for a different
    // question (`configOptions: null`, depth on `modes`) and no session-clear method
    // appeared; that is an absence in someone else's enumeration, not a probe.
    supportsSessionClear: false,
    sessionClearBlockedReason:
      "not measured: no probe has sent /clear as a prompt through pi-acp, and the answer may differ between the nativai fork and upstream — which no version read distinguishes, since both report 0.0.33.",
    // MEASURED, and — unlike the cell above — INDEPENDENT of which pi-acp is
    // running, because the gate dispatches on the ADAPTER KIND, which is `pi` for
    // the fork and for upstream alike (`acpAdapterKind`, the one classifier). Pi's
    // credential is the box's OpenRouter key in the adapter environment
    // (`credential.tier: "box-provider"`, I2 R6): no `AuthMode` maps to this adapter
    // (src/config/profiles.ts:145-156), so there is no profile to move to, and
    // `assertClaudeFamilySeam` (src/runtime/engine/account-seam.ts:111-120) refuses
    // the record before any work. I2 §5 measured the damage when that gate was
    // missing: a persisted Claude `account_switch` made every turn after the first
    // die demanding a Claude transcript pi can never produce.
    canSetCredentialLive: false,
    credentialLiveBlockedReason:
      "Pi authenticates from the box's OpenRouter key in the adapter environment, not from a per-session credential acpx can move; changing it means a new session on a box configured with the other key.",
    // MEASURED at this commit, and likewise fork-independent: `selectedProfileId`
    // (src/runtime/engine/failover.ts:520-554) returns undefined for a non-Claude
    // adapter before reading any stored profile, so `failoverEnabledForRecord`
    // (:582-590) is false and the engine that owns the degrade never runs for a pi
    // record. ⚠️ POST-FIX claim — I2 §5 measured the pre-generalisation behaviour,
    // where the registry-default Claude subscription leaked onto pi records.
    supportsModelDegrade: false,
    modelDegradeBlockedReason:
      "acpx's Fable→Opus degrade runs only inside the Claude-subscription failover engine, which a non-Claude adapter never enters.",
    defaultModel: { source: "openrouter", id: "default" },
    // Never rendered while `canSetModelLive` is true (which it is, for the fork —
    // the mechanism is `set-model`). It is what a box still on the upstream
    // fallback would need to say, so it names the cause rather than the symptom.
    liveModelChangeBlockedReason:
      "This session is running the upstream pi-acp, whose session/set_model is not reachable by the current ACP SDK. The nativai fork restores it; recreate the session once the box has /opt/pi-acp.",
  },
};

/**
 * What a session's adapter actually advertised, as it is already stored on the
 * record (`acpx.config_options`, src/types.ts:533). Deliberately NOT a new
 * persisted field — CONCEPTION §9.3's transform-leg checklist is a guard here,
 * not a task.
 */
export interface HarnessRuntimeAdvertisement {
  configOptions?: SessionConfigOption[];
}

/** A `select`-typed config option with the given id is advertised. */
function advertisesSelectableOption(
  advertised: SessionConfigOption[] | undefined,
  configId: string,
): boolean {
  return (advertised ?? []).some((option) => option.id === configId && option.type === "select");
}

/**
 * A `--at-index` fork the harness would not honour (B0.2, brick
 * https://acpx.devbox.nativai.de/?brick=276594c2). Carries the descriptor value
 * so the caller sees WHICH honesty failure this is.
 */
export class ForkAtIndexUnsupportedError extends Error {
  constructor(
    readonly harness: HarnessId,
    readonly atIndex: ForkAtIndexSupport,
    message: string,
  ) {
    super(message);
    this.name = "ForkAtIndexUnsupportedError";
  }
}

/**
 * REFUSE a truncating fork the harness will not perform — and ONLY that.
 *
 * ⚠️ THE SCOPE OF THIS REFUSAL IS EXACTLY `'ignored'` AND `'unsupported'`. Do
 * not widen it to `'turn-granular'`: codex DOES truncate, at a coarser boundary,
 * and refusing it would ship a NEW defect under a bug-fix label. Codex proceeds
 * and reports the effective landing index (see {@link resolveForkLandingIndex});
 * that honesty is what the refusal is for here, not a refusal of its own.
 * (Three `brick note`s on 276594c2, 2026-09-04, correcting that brick's own
 * stale title, which still says codex is unsupported.)
 *
 * - `'ignored'` — **no harness today.** The branch exists for an adapter that
 *   accepts `sessions copy --at-index N`, returns success, and SILENTLY
 *   FULL-COPIES — a truncation that did not happen, displayed as if it had.
 *   Such a harness's PLAIN fork stays available (`fork.supported` is true); only
 *   the truncating variant lies, which is what the refusal below is scoped to.
 * - `'unsupported'` — **no harness today.** ⚠️ Pi occupied this branch while
 *   acpx launched UPSTREAM pi-acp, which advertises no fork capability at all
 *   (the string `fork` occurs zero times in 0.0.26 and 0.0.33, I2 R4). The
 *   nativai fork implements `session/fork` on pi's JSONL session tree and
 *   honours `_meta.acpx.forkAtMessageIndex`, so pi is `'exact'` now (brick
 *   ef5999ca). **The branch is kept because the descriptor value still exists and
 *   a harness can re-enter it** — including pi itself on a box that has not yet
 *   installed the fork, which is why the message names the adapter rather than
 *   the harness.
 *
 * A harness the descriptor does not know is NOT refused: acpx has no claim to
 * make about it, and inventing one would be the same defect in the other
 * direction.
 */
export function assertForkAtIndexHonoured(
  agentCommand: string | undefined,
  requestedIndex: number | undefined,
): void {
  if (requestedIndex === undefined) {
    return; // no truncation requested; a full copy is honest for every harness
  }
  const harness = harnessIdForAgentCommand(agentCommand);
  if (harness === undefined) {
    return;
  }
  const fork = HARNESS_FACTS[harness].fork;
  if (fork.atIndex !== "ignored" && fork.atIndex !== "unsupported") {
    return;
  }
  const detail =
    fork.atIndex === "ignored"
      ? `its adapter accepts the index and silently full-copies, so the fork would carry the WHOLE source history while the record claimed a truncation at ${requestedIndex}`
      : `its adapter advertises no fork capability at all`; // e.g. pi on a box still running upstream pi-acp
  throw new ForkAtIndexUnsupportedError(
    harness,
    fork.atIndex,
    `Refusing --at-index ${requestedIndex} for agent "${harness}": ` +
      `fork.atIndex == "${fork.atIndex}" — ${detail}. ` +
      (fork.supported
        ? "A full copy (omit --at-index) is supported and honest."
        : "This harness cannot fork at all."),
  );
}

/**
 * The index a `--at-index <requested>` fork will ACTUALLY land on for this
 * agent command — the value that must be RECORDED and DISPLAYED, never the
 * request (row `G1-FRK-01`).
 *
 * ⚠️ Every consumer calls this; nobody re-derives `floor(index / 2)`. The
 * rounding rule is DATA in the descriptor precisely so the table and the
 * behaviour cannot drift apart again, and a caller that recomputes it by hand is
 * itself a consumer that has drifted.
 *
 * Falls back to the request when the harness is unknown or the rule does not
 * apply — the request is then the best claim acpx can honestly make.
 */
export function resolveEffectiveForkIndex(
  agentCommand: string | undefined,
  requestedIndex: number,
): number {
  const harness = harnessIdForAgentCommand(agentCommand);
  if (harness === undefined) {
    return requestedIndex;
  }
  return resolveForkLandingIndex(HARNESS_FACTS[harness].fork, requestedIndex) ?? requestedIndex;
}

/**
 * The declared descriptor for one harness, refined by what a session's adapter
 * actually advertised when a session is supplied.
 *
 * The declared table is the answer for an agent type with NO SESSION YET — which
 * is why a session-record-only design fails acpx-ui's create dialog (CONCEPTION
 * §8). With a session in hand, the advertisement can only NARROW the answer,
 * never widen it: a capability acpx cannot route does not become routable
 * because an adapter mentioned it. `test/harness-capabilities.test.ts` asserts
 * that one-way property across every harness and every advertisement shape.
 */
export function resolveHarnessCapabilities(
  id: HarnessId,
  advertisement?: HarnessRuntimeAdvertisement,
): HarnessCapabilities {
  const declared = deriveHarnessCapabilities(HARNESS_FACTS[id]);
  if (!advertisement) {
    return declared;
  }

  const options = advertisement.configOptions;
  const capabilities: HarnessCapabilities = { ...declared };

  // A config-option mechanism is only live if THIS session advertises the option
  // it needs. A per-model `effort` ladder is the load-bearing case: it is
  // advertised only when the currently-selected model reasons, so it is absent
  // at `session/new` under a non-reasoning default.
  if (
    capabilities.canSetDepthLive &&
    HARNESS_FACTS[id].depth.mechanism === "config-option" &&
    !advertisesSelectableOption(options, "effort")
  ) {
    capabilities.canSetDepthLive = false;
  }

  return capabilities;
}

/**
 * Whether a `--reasoning-effort` request can reach this harness AT ALL — i.e.
 * whether acpx has an apply path for the harness's depth mechanism.
 *
 * This is the predicate the CLI's "ignoring for agent X" warning dispatches on,
 * replacing a hard-coded `name === "claude" || name === "claude-pty"` gate
 * (CONCEPTION §9.1, §2.5). The name gate was wrong in both directions at once:
 * the APPLY path is already capability-gated (an advertised `effort` config
 * option, `src/session/config-option-application.ts:252`), so a harness that
 * does advertise `effort` got the value applied **and** was told on stderr that
 * it had been ignored.
 *
 * ⚠️ Deliberately **not** `canSetDepthLive`. That answers a narrower question —
 * *can this SESSION change depth right now* — which a harness with a per-model
 * ladder answers `false` purely because its default (non-reasoning) model does
 * not advertise `effort` at `session/new`. Warning "ignored" on that basis would
 * be wrong the moment a reasoning model is pinned. The question here is the
 * mechanism's, not the session's.
 *
 * `false` for an id acpx cannot route: codex (`compose-into-id` — depth rides
 * inside the model id, so the depth CONTROL cannot move it) and pi (`mode` —
 * acpx's depth path has no mode arm; `acpx pi set-mode <level>` is the verb that
 * does work).
 */
export function isDepthRequestRoutable(id: HarnessId): boolean {
  return DEPTH_MECHANISMS_ROUTED_BY_ACPX.includes(HARNESS_FACTS[id].depth.mechanism);
}

/**
 * The one-line reason `--reasoning-effort` cannot reach this harness, for the
 * CLI warning. `null` when it can. Kept beside the mechanism table so the
 * message cannot drift from the fact it explains.
 */
export function depthRequestUnroutableReason(id: HarnessId): string | null {
  if (isDepthRequestRoutable(id)) {
    return null;
  }
  const mechanism = HARNESS_FACTS[id].depth.mechanism;
  if (mechanism === "compose-into-id") {
    return "its depth rides inside the model id — set it via --model '<model>[depth]'";
  }
  if (mechanism === "mode") {
    return `its depth is an ACP mode — set it via 'acpx ${id} set-mode <level>'`;
  }
  return "it declares no thinking-depth mechanism";
}

/** The whole declared table, in `HARNESS_IDS` order. */
export function listHarnessCapabilities(): HarnessCapabilities[] {
  return HARNESS_IDS.map((id) => deriveHarnessCapabilities(HARNESS_FACTS[id]));
}

/** `true` when `value` names a harness this table declares. */
export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * The descriptor row for a session's stored `agent_command`, or `undefined` for
 * a command no detector recognises.
 *
 * ⚠️ It delegates to {@link acpAdapterKind} rather than matching command strings
 * itself. There is exactly ONE adapter classifier in acpx and this is not a
 * second one — B0.1b spent a night collapsing four copies of that question, and
 * a lookup that re-derived the answer here would be the fifth.
 *
 * `undefined` is the honest answer for an unknown adapter and callers must treat
 * it as *"acpx cannot say"*, never as a default row: answering with a
 * neighbouring harness's capabilities is how a control gets offered for a
 * session that cannot honour it.
 */
export function harnessIdForAgentCommand(agentCommand: string | undefined): HarnessId | undefined {
  if (!agentCommand?.trim()) {
    return undefined;
  }
  const kind = acpAdapterKind(agentCommand);
  return kind !== undefined && isHarnessId(kind) ? kind : undefined;
}

/**
 * The MODEL mechanism acpx should dispatch on for a session's `agent_command`,
 * or `undefined` for an adapter the descriptor does not classify.
 *
 * ⚠️ `undefined` means *"acpx cannot say"* and the caller must fall through to
 * the pre-existing generic path — NOT substitute a default mechanism. An
 * unrecognised adapter that got routed down the config-option arm would be
 * handed a `session/set_config_option` it never advertised.
 */
export function modelMechanismForAgentCommand(
  agentCommand: string | undefined,
): ModelMechanism | undefined {
  const harness = harnessIdForAgentCommand(agentCommand);
  return harness === undefined ? undefined : HARNESS_FACTS[harness].model.mechanism;
}

/** The DEPTH mechanism for a session's `agent_command`. Same `undefined` contract. */
export function depthMechanismForAgentCommand(
  agentCommand: string | undefined,
): DepthMechanism | undefined {
  const harness = harnessIdForAgentCommand(agentCommand);
  return harness === undefined ? undefined : HARNESS_FACTS[harness].depth.mechanism;
}

/**
 * Whether acpx has an apply path for `mechanism` today — the routing half of
 * every derived capability, exposed so an apply path can ask the same question
 * the descriptor asks rather than re-deriving it from a list membership test.
 */
export function acpxRoutesModelMechanism(mechanism: ModelMechanism | undefined): boolean {
  return mechanism !== undefined && MODEL_MECHANISMS_ROUTED_BY_ACPX.includes(mechanism);
}

/** Depth twin of {@link acpxRoutesModelMechanism}. */
export function acpxRoutesDepthMechanism(mechanism: DepthMechanism | undefined): boolean {
  return mechanism !== undefined && DEPTH_MECHANISMS_ROUTED_BY_ACPX.includes(mechanism);
}
