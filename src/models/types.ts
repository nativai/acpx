/**
 * The model catalogue's payload types.
 *
 * Shape adopted from C5 `UI-DESIGN.md` §8.1 and C4 `CONCEPTION.md` §7.2. Every
 * derivation these types express happens ONCE, here in acpx, and is served to
 * every caller (acpx-ui, the CLI, an agent reading `acpx models --json`).
 * Daniel's ruling of 2026-09-03 22:58:57Z — "ACPX needs to be the basis for all
 * of this" — is what forbids a caller re-deriving any of it.
 */

/** Where a model is reached — the first half of the `(source, id)` unit of choice (C5 D2). */
export type ModelSource =
  | "openrouter"
  | "claude-subscription"
  | "claude-home"
  | "chatgpt"
  | "claude-pty";

/**
 * The canonical thinking-depth vocabulary (C4 §6.1). Ordered weakest → strongest.
 * `none` is the off-rung; `ultra` is advertised by no OpenRouter model today but
 * IS advertised by codex's Sol/Terra families, so the ordering table has to stay
 * total over all eight tokens or a harness ladder sorts wrongly.
 */
export const CANONICAL_DEPTH_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CanonicalDepthLevel = (typeof CANONICAL_DEPTH_LEVELS)[number];

/**
 * What the depth control must render (C5 §4.6) and what C4 §6.2's projection
 * consumes as the target ladder `L`. Derived server-side; the raw OpenRouter
 * `reasoning` object is never shipped to a caller.
 */
export type DepthDescriptor =
  | {
      kind: "ladder";
      /** The model's own rungs, in canonical order. Never empty. */
      levels: CanonicalDepthLevel[];
      /**
       * The rung preselected by the control. `null` means "the harness's own
       * default applies" — for a native ladder acpx does not statically know the
       * harness default, and inventing one would be a lie the UI would render.
       */
      default: CanonicalDepthLevel | null;
      /** True ⇒ there is no off-rung; the control omits its "Default" row. */
      mandatory: boolean;
    }
  | {
      kind: "boolean";
      /**
       * ⚠️ THREE STATES, NOT TWO — `null` means UPSTREAM WAS SILENT, and it is not
       * the same as `false`. Measured on the full live population: OpenRouter
       * omits `reasoning.default_enabled` on 109 of the 146 boolean rows and
       * states it on 37 (7 false, 30 true). Collapsing absent → `false` would
       * make the depth switch render a preselected "Off" on 109 models where
       * OpenRouter says NOTHING — a claim we would be inventing. Deriving
       * server-side is worth doing precisely because the information reaches one
       * place intact; the renderer decides what to show for `null`.
       */
      defaultEnabled: boolean | null;
      mandatory: boolean;
    }
  | { kind: "none" };

export type BillingKind = "metered" | "plan" | "free" | "variable";

export type ModelBilling = {
  kind: BillingKind;
  /** USD per 1M prompt tokens. `null` unless kind === "metered". */
  inPerM: number | null;
  /** USD per 1M completion tokens. `null` unless kind === "metered". */
  outPerM: number | null;
  /**
   * USD per 1M cached-prompt-READ tokens. `null` when the upstream row does not
   * quote one — which is NOT the same as zero, and must not be rendered or
   * summed as zero.
   *
   * ⚠️ **Added for brick 6253611b, and the reason is a measurement, not
   * symmetry:** cached tokens are not a rounding error on the harnesses that
   * report them. One production pi session shows `cacheRead: 18,884` against
   * `input: 2,928` — a 6:1 ratio. Pricing a session on prompt+completion alone
   * therefore understates it badly, and an understated figure presented without
   * qualification is the same defect class this brick exists to remove.
   */
  cacheReadPerM: number | null;
  /** USD per 1M cache-WRITE tokens. `null` when not quoted; see `cacheReadPerM`. */
  cacheWritePerM: number | null;
  /** Which credential pays. */
  account: string;
};

export type ModelBadge = "free" | "alias" | "batch" | "newest";

/** A machine token plus the human string a row prints (C5 §8.1 note 2). */
export type UnavailableReason = {
  reason: string;
  message: string;
};

export type AgentAvailability = {
  ok: boolean;
  reason?: string;
  message?: string;
  /**
   * **THE ID THAT DETERMINES WHICH MODEL SERVES THE SESSION** — what a caller
   * sends as `--model` / `sessionOptions.model` for THIS model on THIS agent
   * type.
   *
   * ⚠️ **THE DEFINITION IS "DETERMINES WHICH MODEL SERVES", NOT "THE STRING SENT
   * ON THE ACP WIRE", AND THE DIFFERENCE IS NOT PEDANTRY.** This field was first
   * derived as the wire id, which was correct for the five seats it was measured
   * on — and stops being well-formed the moment a route exists where the two
   * diverge. On **claude via the OpenRouter shim** they do: the picker's **slug**
   * is what selects the model, while the id travelling the ACP wire to the
   * adapter stays a **claude alias** (the adapter must accept one; the shim
   * rewrites the outbound model regardless). Read as "the wire id" that seat has
   * TWO answers; read as this, it has one — **the slug** — because the alias is
   * an implementation detail of the shim route.
   *
   * The two coincide on four routes and diverge on one. **A definition that only
   * holds for the seats that existed when it was written** is exactly the class
   * of comment this wording replaces. (Ruled by the acpx lead 2026-09-06 on L7's
   * finding; bricks c4da2ff2 / 007eaac8.)
   *
   * Present IFF {@link ok}. The invariant is structural, the same
   * null-when-the-boolean-is-true rule the harness descriptor's reasons follow:
   * a model this agent refuses has no id to send, and shipping one invites a
   * caller to send it.
   *
   * ⚠️ **NOT ALWAYS `id`, AND NOT DERIVABLE FROM `source`.** Measured on every
   * harness (brick c4da2ff2): pi takes `source + "/" + id`,
   * claude and claude-pty take the bare `id`, and codex takes `family[rung]`
   * with **a bare family refused**. So the obvious caller-side rule
   * `source === "openrouter" ? \`openrouter/${id}\` : id` is right for one
   * harnesses and silently wrong for a third — which is exactly why the answer
   * is computed here and shipped, keyed on the `(model, agent)` PAIR that it is
   * actually a property of. See `src/models/wire-model-id.ts`.
   */
  modelId?: string;
};

export type CatalogueModel = {
  /** `source:id` — the unit of choice AND the favorite key (C5 D2). */
  key: string;
  source: ModelSource;
  /** Exactly what `--model` takes. */
  id: string;
  name: string;
  /** Band grouping — derived here so the UI and the CLI band identically. */
  vendor: string;
  description: string | null;
  contextLength: number | null;
  tools: boolean;
  billing: ModelBilling;
  depth: DepthDescriptor;
  badges: ModelBadge[];
  aliasTarget: { id: string; name: string | null } | null;
  /**
   * Other catalogue keys that are the same weights. Intra-OpenRouter only, via
   * `canonical_slug` (C4 §11a answer 5 defers the cross-source alias map).
   */
  equivalentTo: string[];
  /** Epoch SECONDS, as OpenRouter reports it. `null` for harness-native rows. */
  createdAt: number | null;
  /** False ⇒ a session cannot run on it, whatever the agent type. */
  selectable: boolean;
  /** Empty when `selectable`. Never dropped from the list — C5 D6. */
  unavailableReasons: UnavailableReason[];
  /**
   * Per agent type. An EMPTY map means acpx has no harness-capability table yet
   * (the `hp-ws-core` lane owns it) — present and explicit, never a guess.
   */
  availability: Record<string, AgentAvailability>;
  /** Starred on THIS box (`~/.acpx/ui-prefs.db`). */
  favorite: boolean;
  /** ISO-8601 when `favorite`, else `null`. */
  favoritedAt: string | null;
};

export type SelectabilityCounts = {
  total: number;
  selectable: number;
  unavailable: number;
};

export type CatalogueCounts = SelectabilityCounts & {
  /**
   * The same arithmetic over the OpenRouter rows ALONE. It is split out because
   * that is the number the conception's derivation reproduces (292 selectable of
   * 425/426), and because a caller asserting it should never have to subtract
   * acpx's own harness rows to get there.
   */
  openRouter: SelectabilityCounts;
};

export type ModelCatalogue = {
  /** ISO-8601 of the fetch the OpenRouter rows came from. */
  /**
   * ⚠️ WHEN THE ROWS WERE FETCHED, NOT WHEN A FETCH WAS LAST ATTEMPTED — and
   * `null` when no successful fetch has ever happened.
   *
   * Stamping "now" on a FAILED attempt made the two freshness fields together
   * say "fetched a second ago, and not stale" about a catalogue missing 426 of
   * its 448 rows: the envelope failed in the REASSURING direction, with only
   * `error` carrying the truth. A field named for when data was fetched must
   * describe the data it travels with. The two failure modes now read
   * coherently:
   *   cache + failed refresh → the OLD successful time, `stale: true`, `error` set
   *   no cache + failed      → `null`,                  `stale: false`, `error` set
   */
  fetchedAt: string | null;
  /** True when served from cache after a failed refresh. */
  stale: boolean;
  /** Human-readable when the upstream fetch failed. */
  error: string | null;
  /**
   * WHETHER THE PER-AGENT AVAILABILITY ABOVE IS NARROWED BY THE BOX KEY, OR MERELY
   * UNCHECKED (brick ecfb0461).
   *
   * 🛑 **A CONSUMER CANNOT TELL "NARROWED" FROM "UNKNOWN" WITHOUT THIS, AND THE
   * DIFFERENCE IS THE WHOLE ANSWER TO "WHAT MAY I USE?".** Under fail-open an
   * unreadable key answer leaves every row `ok: true` — a catalogue that looks
   * *identical* to a box whose key genuinely allows everything. So `acpx models list`
   * was reporting ~310 available models, unhedged, on a cold / corrupt / 401'd read,
   * and `/api/models` handed the picker no way to qualify it.
   *
   * The spawn path already said so (`formatEntitlementUnknown` on stderr). This is
   * the same statement on the READ path, which is the surface an agent actually
   * queries.
   *
   * ⚠️ **`source` IS THE DISCRIMINATOR, NOT `note`.** The picker is a machine: it
   * keys on `source === "unknown"` and never on prose, because the wording is tuned
   * for an agent to read and is expected to change.
   */
  entitlement: CatalogueEntitlement;
  counts: CatalogueCounts;
  models: CatalogueModel[];
};

/** How well the catalogue knows what the box's OpenRouter key allows. */
export type CatalogueEntitlement = {
  /**
   * `"key"`     — the set came from the key's own answer, so the per-agent
   *               availability above is genuinely narrowed to it.
   * `"unknown"` — acpx could not establish it and **narrowed nothing**. Every
   *               OpenRouter row reads available; that is fail-open, not a claim
   *               that the key allows them. The key still refuses at call time.
   */
  source: "key" | "unknown";
  /** The set was read, but from a cache older than its TTL. */
  stale: boolean;
  /**
   * Why it is `unknown` or `stale`, in one sentence — for a human. **Never parse
   * it**; branch on `source` / `stale`. `null` when the set is known and fresh.
   */
  note: string | null;
};
