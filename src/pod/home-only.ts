/**
 * A-44 / A-45 (bricks b3879529, 25e97206): WHICH HARNESSES ARE HOME-ONLY ON THIS BOX — one function, read by
 * both the utility pod's key (`utilityKeyFor`: `util-home` / `util-pool`) and a session's placement
 * (`sessionTarget`: `home` / `auto`) and the capacity answer (`placementAsked`), so sessions and one-shots
 * switch together.
 *
 *   codex  always home-only in phase 1 (its home is mounted directly in home-placed pods; K8).
 *   pi     home-only UNLESS THE BOX SAYS P1 IS ON IT: pi writes its session JSONL under its data and session
 *          directory even for a one-shot `exec` (`PI_CODING_AGENT_DIR` is pi's data dir; a missing session
 *          dir hangs pi), and a pool pod has a read-write Pi store only where the box's `pi store` setting
 *          rendered one (brick e9f71106, P1 contract §1-2).
 *
 * THE SIGNAL (P1 contract §2): the environment variable `ACPX_PI_PLACEMENT`, rendered by the box's own
 * config into every process that runs acpx on that box (control container, home and pool templates).
 *   `pool`                  ⇒ P1 is on the box: pi leaves the home-only set.
 *   absent, empty, `home`   ⇒ not on the box (the default, and the UNDO: `pi placement: home`).
 *   anything else           ⇒ not on the box, plus ONE named warning on stderr per process.
 *
 * ⚠️ THE CONDITION IS A PER-BOX FACT, NEVER AN ACPX RELEASE. One acpx release runs on boxes with and without
 * P1, so removing `pi` from a constant would move Pi to the pool on a box that cannot host it. The fact is
 * {@link BoxFacts.p1OnBox}, read by {@link readBoxFacts} and NOWHERE ELSE. DO NOT turn this into a version
 * check, and do not read `ACPX_PI_PLACEMENT` at a call site: a second reader is how sessions and one-shots
 * would disagree. `test/pod-home-only.test.ts` holds the rows, including "the release alone never moves Pi".
 *
 * LIGHT MODULE: no imports (`routed-branches.ts` and `utility-branch.ts` load it before the placement step).
 */

export type BoxFacts = {
  /** Block P1 (the Pi store for pool pods) is on THIS box. */
  p1OnBox: boolean;
};

/** The P1 per-box signal's name (contract §2). Exported for the tests and the warning only. */
export const PI_PLACEMENT_ENV = "ACPX_PI_PLACEMENT";

let warnedUnknownPlacement = false;

/**
 * This box's facts. `ACPX_PI_PLACEMENT=pool` ⇒ `p1OnBox: true` (see the header). The only other input is a
 * test seam, honoured solely under `node --test` (`NODE_TEST_CONTEXT`, the precedent of
 * `ACPX_POD_TEST_HOME`): `ACPX_TEST_P1_ON_BOX=1`.
 *
 * ⚠️ AN UNKNOWN VALUE IS "NOT ON THE BOX", NEVER "POOL". A typo (`Pool`, `pool `, `on`) fails toward the
 * placement that cannot lose a transcript; the warning is what makes the typo visible.
 */
export function readBoxFacts(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(line),
): BoxFacts {
  const seam = Boolean(env.NODE_TEST_CONTEXT) && env.ACPX_TEST_P1_ON_BOX === "1";
  const value = env[PI_PLACEMENT_ENV];
  if (value === "pool") {
    return { p1OnBox: true };
  }
  if (value !== undefined && value !== "" && value !== "home" && !warnedUnknownPlacement) {
    warnedUnknownPlacement = true;
    warn(
      `[acpx] warning: ${PI_PLACEMENT_ENV}=${JSON.stringify(value)} is not "pool" or "home"; ` +
        `treating it as "home" (Pi sessions stay in home-placed pods)\n`,
    );
  }
  return { p1OnBox: seam };
}

/** Tests only: forget that the once-per-process warning was written. */
export function resetPiPlacementWarningForTests(): void {
  warnedUnknownPlacement = false;
}

/** True for a harness that may run only in a home-placed pod on this box. */
export function isHomeOnlyHarness(
  harness: string | undefined,
  box: BoxFacts = readBoxFacts(),
): boolean {
  return harness === "codex" || (harness === "pi" && !box.p1OnBox);
}
