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
 *   - `I1 R<n>` — FINDINGS-opencode, brick 13ef680d (measured 2026-09-03 on devbox)
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

export const HARNESS_IDS = ["claude", "claude-pty", "codex", "opencode", "pi"] as const;

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
 *                  entirely for a non-reasoning model (I1 R8)
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
 *  - `ignored`       — the request is accepted and SILENTLY full-copies (I1 R4)
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
 * measured-available path for OpenCode (`opencode.json` `instructions`, I1 R9)
 * and Pi (`$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`, I2 R9), and B3 writes both —
 * see `src/acp/harness-config-dir.ts`.
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
  /** C5's model-source vocabulary: `openrouter | claude-subscription | claude-home | chatgpt | opencode-go`. */
  source: string;
  /**
   * The model id, or the literal `default` when acpx pins nothing and the
   * harness picks its own default.
   */
  id: string;
}

export interface HarnessModelSupport {
  mechanism: ModelMechanism;
  catalogue: ModelCatalogue;
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
   * `session/new` SNAPSHOT (src/session/config-option-application.ts:252), and
   * OpenCode advertises `effort` only when the CURRENTLY SELECTED model reasons,
   * which the default model does not (I1 R8). So a depth mechanism that is
   * routed in general still never fires there, and every test that pins a
   * reasoning model at creation would pass while the flag silently did nothing.
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
  // pi's and opencode's values were "measured" against no adapter at all and no
  // adapter swap could ever change them (brick 82a2aafd, discharging 29b8ce8a).

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
   * The honest-but-ambiguous form, and **NOT a lesser citation**: pi and opencode
   * are not bootstrapped components — they are npx-resolved at spawn, so there is
   * **no commit to cite**. Measured: `info.json` carries `acpx`, `acpx-ui`,
   * `claude-agent-acp`, `claude-pty-acp`, `codex-acp` and neither `pi-acp` nor
   * `opencode` (control: `has("codex-acp")` → true).
   *
   * ⇒ This arm is CORRECT for those two. What was wrong before was that its blind
   * spot went unstated, so {@link cannotDistinguish} is REQUIRED.
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
 * ⚠️ **NOT what any box launches today.** `/opt/pi-acp` exists on neither devbox
 * nor staging (measured 2026-09-05), so `resolvePiAcpCommand` falls back to the
 * npx range and every box resolves UPSTREAM. That is precisely why the fork needs
 * its own citation rather than being folded into pi's block: **the block names
 * what acpx resolves; these five cells name what the claim was proven on, and
 * today those are different builds.**
 *
 * Cited by BUILD RECORD because there is no `info.json` entry to resolve against
 * — the fork is a lane artifact at `/workspace/projects/pi-acp/b5-fork`, not a
 * bootstrapped component. Commit plus the entry file's sha256 is what ruling v3
 * prescribes for exactly that case, and it is what a version string cannot do
 * here: **the fork's `package.json` says `0.0.33`, identical to upstream's.**
 */
const PI_FORK_BUILD: HarnessAdapterIdentity = {
  kind: "resolved-commit",
  spec: "nativai/pi-acp fork (publishes 0.0.33, indistinguishable from upstream by version)",
  commit: "eb17203",
  entrySha256: "e296b0705630ffe1",
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
  // B3: `applyRequestedModelIfAdvertised` routes `model` through
  // `session/set_config_option` — the path `mode` already takes successfully
  // (I1 D2's own contrast) — for a harness whose model IS a config option.
  // Landed in the SAME commit as the branch, per the rule above; it is what
  // flips `opencode.canSetModelLive` to true with no edit to the table.
  "config-option",
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
  // Empty on purpose, and it must stay a KIND list rather than absorb the
  // provisioning answer. `via-shim` needs the OpenRouter shim to take a model
  // from the picker rather than from the profile (CONCEPTION §7.4, §11 Q1), which
  // has not shipped.
  //
  // ⚠️ `provisioned` IS NOT LISTED HERE EVEN THOUGH acpx NOW PROVISIONS FOR BOTH
  // HARNESSES THAT DECLARE IT — and that is the correction, not an omission.
  // Provisioning is answered PER HARNESS, because each harness has its own config
  // format and its own merge semantics: pi's `models-store.json` merges by id
  // (brick ef5999ca) and OpenCode's `provider.openrouter.models.<slug>`
  // deep-merges (brick 4c7a38b2) — two separate measurements, taken separately,
  // months of reasoning apart. Listing the KIND would have switched BOTH on from
  // whichever measurement landed first, and one of opencode's pickers would have
  // offered a band acpx did not provision for.
  //
  // ⚠️ THE FACT THAT BOTH ANSWERS CAME BACK `merge` IS NOT A REASON TO COLLAPSE
  // THIS BACK INTO A KIND LIST. The next harness to declare `provisioned` would
  // be switched on by a measurement taken against a config format it does not
  // share. The per-harness array is the seam; two agreeing data points do not
  // retire it.
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
 * merge-vs-replace measurement first — the argument, and the exact measurement
 * that licenses `"opencode"`, is in the block above and in
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
  // opencode — MEASURED 2026-09-06, brick 4c7a38b2,
  // `verification/evidence/B4-M1-opencode-config-merge-vs-replace.md`. OpenCode
  // 1.18.28 DEEP-MERGES `provider.openrouter.models.<slug>: {}`; it does not
  // replace. Both layers, on a scratch rig, each with its own control:
  //
  //   - over OPENCODE'S OWN catalogue entry: `moonshotai/kimi-k2-thinking` kept
  //     `capabilities.reasoning: true` (the field whose loss would have silently
  //     broken the advertised `effort` ladder — the exact hazard this array's
  //     previous comment named), plus name, family, cost, limit, release_date. A
  //     restore run with the config removed again returned the baseline exactly.
  //   - over a PRE-EXISTING USER ENTRY: a project-level `opencode.json` setting
  //     `name: "USER-MARKER-KIMI"` SURVIVED a session config declaring the same
  //     slug as `{}`. So provisioning at spawn time does not clobber a user's
  //     own provider config.
  //
  // The REPLACE outcome was not merely "reachable in principle" — it was rendered:
  // a bare `{}` on a slug OpenCode does not know produces a visible stub
  // (`reasoning: false`, cost 0, `limit.context` 0, empty family), which is
  // exactly what a replace would have made of the subject. It did not.
  "opencode",
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
    arbitraryModelSupport: "via-shim", // CONCEPTION §7.4 — the shim's model is fixed by the profile today
    model: {
      // `query.setModel(...)` on the SDK object, claude-agent-acp src/acp-agent.ts:1990-2019 (MAP §3.1)
      mechanism: "set-model",
      // SDK-queried `initializationResult.models` + two hardcoded injections (MAP §3.1)
      catalogue: "acp",
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

  "claude-pty": {
    id: "claude-pty",
    measuredAgainst: {
      // ⚠️ The deployed package version is the literal string `0.0.0-private`,
      // which distinguishes NOTHING between builds. The commit is the only
      // identity this adapter has, and recording that limit is the point — a
      // citation that cannot date a build should say so rather than look precise.
      adapter: {
        kind: "resolved-commit",
        spec: "claude-pty-acp 0.0.0-private",
        commit: "ce2a2e6",
      },
      source:
        "git -C /opt/claude-pty-acp rev-parse --short HEAD (the package version is a constant and cannot date a build)",
    },
    label: "claude-pty",
    supportsProfiles: true,
    supportsOutputStyles: true, // MAP §3.1 — create-time only, folded into the launch --settings JSON
    arbitraryModelSupport: "none", // CONCEPTION §7.4 — hardcoded [opus, sonnet, haiku]
    model: {
      // types `/model <id>` into the live TUI via tmux keystrokes, claude-pty-acp :4648-4688 (MAP §3.1)
      mechanism: "set-model",
      // `SUPPORTED_MODELS = [opus, sonnet, haiku]`, claude-pty-acp :149-154 (MAP §3.1)
      catalogue: "static",
    },
    depth: {
      // the ONLY config option it advertises, claude-pty-acp :148,155,714-722 (MAP §3.1)
      mechanism: "config-option",
      // `SUPPORTED_EFFORTS = [low, medium, high, xhigh, max]`, model-independent (MAP §3.1)
      ladder: "static",
      configOptionAdvertisedAtSessionNew: true, // MAP §3.1 — its ONLY config option, default `high`
    },
    // `claude-home` forces adapter `claude-pty` (src/config/profiles.ts:145-156);
    // `--subscription` is refused for it (src/acp/auth-env.ts:1152-1162).
    credential: { tier: "profile", providers: ["claude-home"] },
    // Physical transcript copy with INCLUSIVE truncation at a resolved Claude
    // transcript UUID (`copyForkTranscript` :1605-1636, `claudeUuidForAcpxForkIndex`
    // :1584-1604), and two loud refusals rather than a silent full copy (MAP §3.2).
    fork: { supported: true, atIndex: "exact" },
    midTurnSteering: true, // src/acp/mid-turn-injection-support.ts:5-20 (native TUI steering)
    primerChannel: "system-prompt", // `_meta.systemPrompt` re-applied on every (re)launch, :1889-1893
    usageReporting: true, // MAP §3.1 — same wire shape; cost derived from a pricing table
    promptImages: true, // MAP §3.1 — `image:true`
    // ⚠️ NOT MEASURED, AND THE TEMPTING ANSWER IS THE DANGEROUS ONE. The harness
    // binary is the SAME Claude Code 2.1.251 that defines `/clear` (see the claude
    // block), and this adapter drives it as a LIVE TUI where slash commands
    // certainly work — so "obviously true" is the reading that will suggest itself.
    // What nobody has measured is the only link that matters: whether a PROMPT
    // arrives at the TUI as typed input that the TUI then executes as a slash
    // command, or is routed some other way. `sendSlashCommand` exists in
    // claude-pty-acp for `/model` (MAP §3.1, :4648-4688) — which is evidence that a
    // prompt is NOT automatically a slash command, since one had to be built.
    // A wrong `true` here would show a "Clear context" button that draws a boundary
    // over history the harness still holds.
    supportsSessionClear: false,
    sessionClearBlockedReason:
      "not measured: no probe has sent /clear as a prompt through claude-pty-acp and checked whether the TUI executed it as a slash command or answered it as a message. The underlying Claude Code binary does define /clear.",
    // MEASURED, same seam as claude: `claude-pty` is in `CLAUDE_FAMILY_ADAPTER_KINDS`
    // (src/acp/agent-command.ts:192) so `assertClaudeFamilySeam` admits it, and a
    // `claude-home` profile's anchor is `<homePath>/.claude`
    // (src/config/profiles.ts:854-865), so `requireAnchor` passes. This is the
    // "unified SDK-subscription + claude-pty-bridge move" the handler's own comment
    // names (src/cli/command-handlers.ts:2283-2289).
    canSetCredentialLive: true,
    credentialLiveBlockedReason:
      "acpx's credential move is Claude-family only: this session's adapter has no Claude account to move and no Claude transcript to port.",
    // ⚠️ NOT MEASURED, AND THE TWO HALVES OF THE CHAIN DISAGREE — which is exactly
    // why this is a token and not a confident false. The GATE admits claude-pty: it
    // is Claude-family and a `claude-home` profile has a non-null anchor, so
    // `failoverEnabledForRecord` is true. The TRIGGER looks unreachable: the
    // degrade needs `isFableModel(session_options.model)`
    // (src/runtime/engine/failover.ts:383) and this adapter's catalogue is the
    // static [opus, sonnet, haiku] (MAP §3.1, claude-pty-acp:149-154), so no Fable
    // model should be pinnable — but whether acpx can STORE an unadvertised model
    // id on the record before the adapter rejects it is not measured, and the
    // fable-share probe reads the SUBSCRIPTION registry regardless of this
    // session's `claude-home` profile. Two readings, no probe: do not pick one.
    supportsModelDegrade: false,
    modelDegradeBlockedReason:
      "not measured: no probe has run a Fable-pinned claude-pty session through a rate-limit failover. The gate admits claude-home profiles, but the adapter's static [opus, sonnet, haiku] catalogue offers no Fable model to degrade FROM.",
    defaultModel: { source: "claude-home", id: "default" },
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

  opencode: {
    id: "opencode",
    measuredAgainst: {
      // Pinned by brick 0ededc52; before that the command carried NO version and
      // resolved `latest` at spawn on every box independently, so these claims
      // named no build at all — the defect this field exists for, in its purest
      // form. The pin is BARE, not `^1.18.28`: opencode-ai is a 1.x package and a
      // caret there is a RANGE (see `ACP_ADAPTER_PACKAGE_RANGES`).
      adapter: {
        kind: "package-range",
        spec: "opencode-ai@1.18.28",
        // ⚠️ NOT A LESSER CITATION — opencode is not a bootstrapped component.
        // Measured: `/workspace/.runtime/info.json` carries acpx, acpx-ui,
        // claude-agent-acp, claude-pty-acp and codex-acp, and NEITHER opencode
        // NOR pi-acp (control: `has("codex-acp")` -> true). It is npx-resolved at
        // spawn, so there is no commit to resolve to and `package-range` is the
        // honest form for what acpx actually resolves.
        cannotDistinguish:
          "the exact published tarball behind the pin — npx resolves 1.18.28 from the registry at spawn, so two boxes agreeing on this spec are not thereby proven to have run identical bytes. A commit becomes citable only if opencode is ever bootstrapped into /opt like the adapters above.",
      },
      source: "ACP_ADAPTER_PACKAGE_RANGES.opencode in src/agent-registry.ts",
    },
    label: "opencode",
    // No `AuthMode` maps to a fourth harness — the mapping is a closed switch,
    // not a table (MAP §2.2). Credentials reach OpenCode as box-provider env.
    supportsProfiles: false,
    supportsOutputStyles: false, // not an OpenCode concept (I1 R11 — configOptions are model/mode/effort)
    arbitraryModelSupport: "provisioned", // I1 R6 — declare `provider.openrouter.models.<id>` in opencode.json
    model: {
      // I1 R5/R11: model is an ACP config option (`configId: "model"`, 401
      // options, `type: select`), set via `session/set_config_option`. NO ACP
      // `models` array and NO `session/set_model`.
      mechanism: "config-option",
      catalogue: "acp", // the whole roster is enumerable from the handshake, with display names (I1 R11)
    },
    depth: {
      // I1 R8: reasoning effort is OpenCode's "variant", exposed as the ACP
      // config option `effort` (category `thought_level`).
      mechanism: "config-option",
      // I1 R8: the ladder differs per model (`low/high/max` vs `low/medium/high`)
      // and is ABSENT for a non-reasoning model — and it is not advertised at
      // `session/new` with the default model, which is why acpx must re-read the
      // advertised options AFTER applying the model.
      ladder: "per-model",
      // I1 R8, and this is the cell that makes `opencode.canSetDepthLive` false
      // today: at `session/new` with the default (non-reasoning) model the
      // `effort` option is ABSENT, so acpx's gate — which reads that snapshot —
      // is false and `--reasoning-effort` never applies. Flips to true when the
      // apply path re-reads the advertised options after applying the model.
      configOptionAdvertisedAtSessionNew: false,
    },
    credential: { tier: "box-provider", providers: ["openrouter"] }, // I1 R6 — OPENROUTER_API_KEY alone activates it
    // I1 R4: `sessionCapabilities: {close, fork, list, resume}` — the full fork
    // works today through acpx's generic path. But `--at-index N` is SILENTLY
    // ignored: the probe recorded `forkedAtMessageIndex: 2` while OpenCode's own
    // DB showed all 6 source messages copied. A truncation that did not happen.
    fork: { supported: true, atIndex: "ignored" },
    midTurnSteering: false, // src/acp/mid-turn-injection-support.ts:5-20 — not on the allow-list (I1 R3)
    // I1 R9: `_meta.systemPrompt.append` is accepted and SILENTLY IGNORED. The
    // working path is `opencode.json` `"instructions"` in a per-session config
    // dir — which B3 now writes (src/acp/harness-config-dir.ts), so the primer
    // reaches OpenCode in turn 1 and across a resume. THIS CELL IS THE GATE: only
    // a `config-file` harness is given a config dir, which is what keeps claude /
    // claude-pty / codex adapter environments untouched.
    primerChannel: "config-file",
    usageReporting: true, // I1 R12 — `usage_update` over ACP plus per-session cost/tokens in its store
    promptImages: true, // I1 R11 — `promptCapabilities: {embeddedContext:true, image:true}`
    // I1 R7: with no OpenRouter key the harness's own default is the Zen free
    // tier (`opencode/big-pickle`); with the box key present the intended door
    // is OpenRouter. acpx pins nothing, hence the `default` sentinel.
    // NOT MEASURED. OpenCode has its own slash-command surface in its TUI, but over
    // ACP acpx sends prompt text and nobody has checked whether the adapter routes
    // `/clear` to it or passes it to the model as a message. I1 R3/R11 enumerated
    // OpenCode's ACP surface (configOptions model/mode/effort) and no session-clear
    // method appeared, which is an absence in an enumeration made for another
    // question — not a probe of this one.
    supportsSessionClear: false,
    sessionClearBlockedReason:
      "not measured: no probe has sent /clear as a prompt through the opencode ACP adapter to see whether OpenCode executes it as a slash command.",
    // MEASURED, and it is a fact about the CREDENTIAL MECHANISM, not the name:
    // OpenCode's credential is the BOX's provider key in the adapter's environment
    // (`credential.tier: "box-provider"`, OPENROUTER_API_KEY alone activates it,
    // I1 R6) — there is no per-session credential object for acpx to move. Two
    // independent refusals confirm it: no `AuthMode` maps to this adapter at all
    // (`adapterForAuthMode` is a closed switch over {claude, claude-pty, codex},
    // src/config/profiles.ts:145-156, MAP §2.2 "a fourth harness cannot be given a
    // credential today"), and `assertClaudeFamilySeam`
    // (src/runtime/engine/account-seam.ts:111-120) refuses the record before any
    // work. I1 D1 measured what happens when that gate is missing: a Claude
    // account_switch written onto an OpenCode record makes the resume gate demand a
    // Claude SDK transcript JSONL that OpenCode can never produce, and every turn
    // after the first dies.
    canSetCredentialLive: false,
    credentialLiveBlockedReason:
      "OpenCode authenticates from the box's provider key in the adapter environment, not from a per-session credential acpx can move; changing it means a new session on a box configured with the other key.",
    // MEASURED at this commit: an OpenCode record never enters the failover engine,
    // so the degrade cannot reach it. `selectedProfileId`
    // (src/runtime/engine/failover.ts:520-554) returns undefined for a non-Claude
    // adapter BEFORE reading any stored profile, so `currentProfile` is undefined
    // and `failoverEnabledForRecord` (:582-590) is false. ⚠️ This is a POST-FIX
    // claim: I1 D1 measured the opposite on an older acpx, where the codex-only
    // carve-out had not been generalised and the registry-default Claude
    // subscription leaked onto OpenCode records. Cite the commit, not the finding.
    supportsModelDegrade: false,
    modelDegradeBlockedReason:
      "acpx's Fable→Opus degrade runs only inside the Claude-subscription failover engine, which a non-Claude adapter never enters.",
    defaultModel: { source: "openrouter", id: "default" },
    liveModelChangeBlockedReason:
      "OpenCode selects its model through session/set_config_option, which acpx does not route yet. acpx's generic path persists a value it can never apply and leaves the session unrecoverable (FINDINGS-opencode D2).",
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
          "the nativai pi-acp FORK from UPSTREAM pi-acp — both publish 0.0.33, so no version read separates them. Which one runs is decided by resolvePiAcpCommand (src/agent-registry.ts): `node /opt/pi-acp/dist/index.js` when that path exists, else this npx range. Measured 2026-09-05 on devbox: /opt/pi-acp DOES NOT EXIST, so this box resolves UPSTREAM. Cells whose truth differs between the two carry their own cellOverrides.",
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
      // ⚠️ THIS IS A LANE BUILD, NOT A DEPLOYED ONE. No box installs the fork
      // today (`/opt/pi-acp` absent on devbox and staging), so it is cited by its
      // BUILD RECORD — commit plus the sha256 of the entry file — exactly as
      // ruling v3 requires when there is no `info.json` entry to resolve.
      cellOverrides: {
        "model.mechanism": PI_FORK_BUILD,
        "fork.supported": PI_FORK_BUILD,
        "fork.atIndex": PI_FORK_BUILD,
        usageReporting: PI_FORK_BUILD,
        liveModelChangeBlockedReason: PI_FORK_BUILD,
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
    midTurnSteering: false, // src/acp/mid-turn-injection-support.ts:5-20 (I2 R3)
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
    // identity is the spawn path resolved to a commit. Measured 2026-09-05 on
    // devbox: `/opt/pi-acp` DOES NOT EXIST here, so this box resolves the
    // registry-pinned upstream `pi-acp@^0.0.33` — the fallback the `measuredAgainst`
    // warning above describes. Pi's own TUI has slash commands, but nobody has sent
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
 * - `'ignored'` — **OpenCode**. `sessions copy --at-index N` returns success and
 *   the adapter SILENTLY FULL-COPIES: I1 R4 measured acpx recording
 *   `forkedAtMessageIndex: 2` while OpenCode's own DB held all 6 source
 *   messages. A truncation that did not happen, displayed as if it had. Note the
 *   PLAIN fork is fine and stays available (`fork.supported` is true) — only the
 *   truncating variant lies.
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
  // it needs. OpenCode's `effort` is the load-bearing case: it is advertised
  // only when the currently-selected model reasons, and it is absent at
  // `session/new` with the default model (I1 R8).
  if (
    capabilities.canSetModelLive &&
    HARNESS_FACTS[id].model.mechanism === "config-option" &&
    !advertisesSelectableOption(options, "model")
  ) {
    capabilities.canSetModelLive = false;
    capabilities.liveModelChangeReason = HARNESS_FACTS[id].liveModelChangeBlockedReason;
  }
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
 * *can this SESSION change depth right now* — and is false for opencode purely
 * because the default (non-reasoning) model does not advertise `effort` at
 * `session/new`. Warning "ignored" on that basis would be wrong the moment a
 * reasoning model is pinned, which is exactly the contradiction being removed.
 * The question here is the mechanism's, not the session's.
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
 * unrecognised adapter that got routed down OpenCode's config-option arm would
 * be handed a `session/set_config_option` it never advertised.
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
