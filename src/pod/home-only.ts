/**
 * A-44 / A-45 (bricks b3879529, 25e97206): WHICH HARNESSES ARE HOME-ONLY ON THIS BOX — one function, read by
 * both the utility pod's key (`utilityKeyFor`: `util-home` / `util-pool`) and a session's placement
 * (`sessionTarget`: `home` / `auto`), so sessions and one-shots switch together.
 *
 *   codex  always home-only in phase 1 (its home is mounted directly in home-placed pods; K8).
 *   pi     home-only UNTIL BLOCK P1 IS ON THE BOX: pi writes its session JSONL under its data and session
 *          directory even for a one-shot `exec` (`PI_CODING_AGENT_DIR` is pi's data dir; a missing session
 *          dir hangs pi), and pool pods have no read-write Pi store before P1.
 *
 * ⚠️ THE CONDITION IS A PER-BOX FACT, NEVER AN ACPX RELEASE. One acpx release runs on boxes with and without
 * P1, so removing `pi` from a constant would move Pi to the pool on a box that cannot host it. The fact is
 * {@link BoxFacts.p1OnBox}, read by {@link readBoxFacts}; P1's brief defines the real signal — until it does
 * the reader answers "not on the box", so `pi` stays home-only. DO NOT turn this into a version check.
 * `test/pod-home-only.test.ts` holds the rows, including "the release alone never moves Pi".
 *
 * LIGHT MODULE: no imports (`routed-branches.ts` and `utility-branch.ts` load it before the placement step).
 */

export type BoxFacts = {
  /** Block P1 (the Pi store for pool pods) is on THIS box. */
  p1OnBox: boolean;
};

/**
 * This box's facts. P1's per-box signal (to be defined by P1's brief) is read HERE and nowhere else; until
 * it exists the answer is `p1OnBox: false`. The only other input is a test seam, honoured solely under
 * `node --test` (`NODE_TEST_CONTEXT`, the precedent of `ACPX_POD_TEST_HOME`): `ACPX_TEST_P1_ON_BOX=1`.
 */
export function readBoxFacts(env: NodeJS.ProcessEnv = process.env): BoxFacts {
  return { p1OnBox: Boolean(env.NODE_TEST_CONTEXT) && env.ACPX_TEST_P1_ON_BOX === "1" };
}

/** True for a harness that may run only in a home-placed pod on this box. */
export function isHomeOnlyHarness(
  harness: string | undefined,
  box: BoxFacts = readBoxFacts(),
): boolean {
  return harness === "codex" || (harness === "pi" && !box.p1OnBox);
}
