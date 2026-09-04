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
 * The type below is deliberately STRUCTURAL and minimal — only the two fields
 * the availability join actually reads. `HarnessCapabilities` from §8 satisfies
 * it, so pointing this at the real table is a one-line change and no field of
 * theirs is second-guessed here.
 */

export type AvailabilityCapability = {
  /** Agent type id — `claude` | `claude-pty` | `codex` | `opencode` | `pi`. */
  id: string;
  /** False ⇒ the OpenRouter band is locked for this agent type (C5 §8.4). */
  acceptsArbitraryModelIds: boolean;
  /** Shown beside the padlock when a control is refused; may be absent. */
  liveModelChangeReason?: string | null;
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
