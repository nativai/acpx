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
  counts: CatalogueCounts;
  models: CatalogueModel[];
};
