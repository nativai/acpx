/**
 * The ONE narrow accessor through which the catalogue reaches acpx's
 * per-harness capability table (C4 `CONCEPTION.md` §8).
 *
 * That table — `src/acp/harness-capabilities.ts`, a `HarnessCapabilities[]` — is
 * being built by a sibling lane and is NOT on `dev` yet. Until it lands this
 * returns an EMPTY table, and an empty table makes every model's `availability`
 * an empty map: present and explicit, never a guessed value. When the table
 * lands, `readHarnessCapabilities` starts returning it and the join in
 * `catalogue.ts` lights up with no other change.
 *
 * ⚠️ THE TYPE BELOW IS A STRUCTURAL SUBTYPE, NOT A COPY OF THE §8 STRUCT — and
 * that is deliberate, because §8's struct is still moving (its `fork.atIndex`
 * gained a fourth value and its permission field was deleted on 2026-09-03
 * evening). A hand-copied interface would compile while drifting, which is worse
 * than no stub at all. So this declares ONLY the two fields the availability
 * join reads, and every other field of the real table — fork, the derived
 * live-switch booleans, the primer channel, usage reporting — is a no-op here by
 * construction, because none of them bears on WHICH MODELS an agent can run,
 * which is the only question this join answers. Widening it is a decision to
 * take deliberately, not a convenience.
 */

export type AvailabilityCapability = {
  /** Agent type id — `claude` | `claude-pty` | `codex` | `opencode` | `pi`. */
  id: string;
  /** False ⇒ the OpenRouter band is locked for this agent type (C5 §8.4). */
  acceptsArbitraryModelIds: boolean;
};

let override: AvailabilityCapability[] | null = null;

/**
 * Test seam. Production has exactly one caller and it passes nothing, so the
 * empty table is what ships until the sibling lane's table is merged in.
 */
export function setHarnessCapabilitiesForTesting(table: AvailabilityCapability[] | null): void {
  override = table;
}

export function readHarnessCapabilities(): AvailabilityCapability[] {
  return override ?? [];
}
