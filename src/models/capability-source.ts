/**
 * The ONE narrow accessor through which the catalogue reaches acpx's
 * per-harness capability table (C4 `CONCEPTION.md` §8).
 *
 * That table is `src/acp/harness-capabilities.ts`. This module PROJECTS it down
 * to the two fields the availability join reads, and the catalogue never sees
 * anything else.
 *
 * ⚠️ THE PROJECTION IS THE POINT — DO NOT "SIMPLIFY" IT TO
 * `return listHarnessCapabilities()`. It compiles: `HarnessCapabilities`
 * structurally satisfies `AvailabilityCapability`, so the shortcut type-checks
 * and every test still passes. What it silently changes is what FLOWS: the
 * catalogue would then hold live references to the whole §8 struct — fork,
 * the derived live-switch booleans, the primer channel, usage reporting — none
 * of which bears on WHICH MODELS an agent can run, which is the only question
 * this join answers. That struct is also still moving (its `fork.atIndex` gained
 * a fourth value and its permission field was deleted on 2026-09-03 evening), so
 * a widened flow drifts under a green build. The `.map` below is what makes the
 * narrowing true by construction rather than by convention, and
 * `test/models-capability-source.test.ts` pins it: the returned rows must carry
 * EXACTLY the fields listed on {@link AvailabilityCapability}, so restoring the
 * shortcut goes red. Widening this is a decision to take deliberately and
 * report, not a convenience while you are in here.
 *
 * ## THE ONE WIDENING SO FAR, AND THE CRITERION IT WAS ADMITTED UNDER
 *
 * 2026-09-06, brick c4da2ff2: two fields → five. The three added are
 * `arbitraryModelSupport`, `idForm` and `depthFusedIntoId`.
 *
 * **They were admitted against this file's own criterion, not against a
 * precedent** — a precedent generalises, a criterion discriminates. The
 * criterion is *does this cell bear on WHICH MODELS an agent can run, or on
 * HOW that model must be named to it*:
 *
 *   - `arbitraryModelSupport` — WHY a model is unavailable, split honestly. A
 *     harness whose backend is genuinely fixed (`none`) and one whose support
 *     exists but is not yet wired by acpx (`via-shim`, an unrouted
 *     `provisioned`) are two different answers, and collapsing them reported
 *     acpx's own unfinished plumbing as a fact about the harness's backend.
 *   - `idForm` — the id acpx must send is `source`-prefixed for two harnesses
 *     and bare for three; without it no caller can name a model to an agent.
 *   - `depthFusedIntoId` — the other half of that same id (codex's `[rung]`),
 *     without which the id is refused outright.
 *
 * ⇒ **The pinning test still asserts the EXACT field set.** A future accidental
 * widening still goes red; that property is what the narrowing bought and it is
 * deliberately not spent here.
 *
 * History, because the previous version of this comment became false and cost a
 * measurement to rediscover: this returned an EMPTY table while the table was
 * being built by a sibling lane, and said so. The table landed on
 * `program/harness-integration` and the accessor was never pointed at it, so
 * every model's `availability` stayed `{}` — which `isAvailableForAgent`
 * (`src/models/matcher.ts`) reads as "no capability table yet, so OFFER IT".
 * Measured 2026-09-04 at `a5ba50fe`: all 453 rows carried a 0-key availability
 * map and 294 OpenRouter rows banded into `acpx models --agent claude` for a
 * session that can serve 6 ids
 * (brick://db554b05 `reports/MEASUREMENT.md`).
 */

import { listHarnessCapabilities } from "../acp/harness-capabilities.js";
import type { ArbitraryModelSupport, ModelIdForm } from "../acp/harness-capabilities.js";

export type AvailabilityCapability = {
  /** Agent type id — `claude` | `codex` | `pi`. */
  id: string;
  /** False ⇒ the OpenRouter band is locked for this agent type (C5 §8.4). */
  acceptsArbitraryModelIds: boolean;
  /**
   * WHY the band is locked, so the join can say which of two very different
   * things is true: the backend is fixed, or acpx has not wired the support the
   * harness has. Never collapsed — see the widening note in the file header.
   */
  arbitraryModelSupport: ArbitraryModelSupport;
  /** How a row's `(source, id)` becomes the id this harness accepts. */
  idForm: ModelIdForm;
  /** True ⇒ the harness fuses the thinking rung into the model id (codex). */
  depthFusedIntoId: boolean;
};

let override: AvailabilityCapability[] | null = null;

/**
 * Test seam. Production passes nothing and gets the real table below; a test
 * passes a synthetic one to watch the join's answer change, and `null` restores
 * the real table.
 */
export function setHarnessCapabilitiesForTesting(table: AvailabilityCapability[] | null): void {
  override = table;
}

export function readHarnessCapabilities(): AvailabilityCapability[] {
  return (
    override ??
    listHarnessCapabilities().map((harness) => ({
      id: harness.id,
      acceptsArbitraryModelIds: harness.acceptsArbitraryModelIds,
      arbitraryModelSupport: harness.arbitraryModelSupport,
      idForm: harness.model.idForm,
      // Read from the DEPTH mechanism, which is where the descriptor already
      // states it — not restated as its own cell, so the two cannot disagree.
      depthFusedIntoId: harness.depth.mechanism === "compose-into-id",
    }))
  );
}
