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
 * THE SIGNAL (P1 contract §2, amended 2026-11-28 by the authority's question 2eb92fea — the control must learn
 * the placement WITHOUT a restart):
 *   1. the environment variable `ACPX_PI_PLACEMENT` — agent pods get it from their template. When it is
 *      PRESENT (even empty) it decides and the file is NOT read;
 *   2. else the file `/etc/nativai/release-pins/pi-placement` — a key of the box's release-pins ConfigMap,
 *      mounted on the control as a directory, so the kubelet updates it in place. Read on EVERY call (no
 *      cache beyond the call), whitespace trimmed. Its path moves only under the test seam
 *      (`NODE_TEST_CONTEXT` + `ACPX_TEST_PI_PLACEMENT_FILE`), never by a production variable.
 *   Values, either source:
 *   `pool`                            ⇒ P1 is on the box: pi leaves the home-only set.
 *   empty, `home`, missing/unreadable ⇒ not on the box (the default, and the UNDO: `pi placement: home`).
 *   anything else                     ⇒ not on the box, plus ONE named warning on stderr per process.
 *
 * ⚠️ THE CONDITION IS A PER-BOX FACT, NEVER AN ACPX RELEASE. One acpx release runs on boxes with and without
 * P1, so removing `pi` from a constant would move Pi to the pool on a box that cannot host it. The fact is
 * {@link BoxFacts.p1OnBox}, read by {@link readBoxFacts} and NOWHERE ELSE. DO NOT turn this into a version
 * check, and do not read `ACPX_PI_PLACEMENT` or the file at a call site: a second reader is how sessions,
 * one-shots and the capacity answer would disagree. `test/pod-home-only.test.ts` holds the rows, including "the release alone never moves Pi".
 *
 * LIGHT MODULE: no acpx imports (`routed-branches.ts` and `utility-branch.ts` load it before the placement
 * step); `node:fs` only, for the file.
 */

import { readFileSync } from "node:fs";

export type BoxFacts = {
  /** Block P1 (the Pi store for pool pods) is on THIS box. */
  p1OnBox: boolean;
};

/** The P1 per-box signal's name (contract §2). Exported for the tests and the warning only. */
export const PI_PLACEMENT_ENV = "ACPX_PI_PLACEMENT";

/** The control's source when the env is absent: a key of the release-pins ConfigMap (contract §2 amended). */
export const PI_PLACEMENT_FILE = "/etc/nativai/release-pins/pi-placement";

let warnedUnknownPlacement = false;

/**
 * This box's facts: `p1OnBox` is the P1 signal (see the header) read NOW, from the env or else the file. The
 * only other input is a test seam, honoured solely under `node --test` (`NODE_TEST_CONTEXT`, the precedent of
 * `ACPX_POD_TEST_HOME`): `ACPX_TEST_P1_ON_BOX=1`.
 *
 * ⚠️ AN UNKNOWN VALUE IS "NOT ON THE BOX", NEVER "POOL". A typo (`Pool`, `on`) fails toward the placement that
 * cannot lose a transcript; the warning is what makes the typo visible.
 * ⚠️ DO NOT CACHE THE FILE. A flip of the ConfigMap must move the next session without a restart of the
 * control; a module-level cache is exactly the restart the authority ruled out.
 */
export function readBoxFacts(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(line),
): BoxFacts {
  const signal = placementSignal(env);
  if (signal.value === "pool") {
    return { p1OnBox: true };
  }
  warnUnknownPlacementOnce(signal, warn);
  return { p1OnBox: Boolean(env.NODE_TEST_CONTEXT) && env.ACPX_TEST_P1_ON_BOX === "1" };
}

type PlacementSignal = { source: string; value: string | undefined };

/** The env when present (even empty), else the file's trimmed content; `undefined` = no file / unreadable. */
function placementSignal(env: NodeJS.ProcessEnv): PlacementSignal {
  const fromEnv = env[PI_PLACEMENT_ENV];
  if (fromEnv !== undefined) {
    return { source: PI_PLACEMENT_ENV, value: fromEnv };
  }
  const file = placementFile(env);
  try {
    return { source: file, value: readFileSync(file, "utf8").trim() };
  } catch {
    return { source: file, value: undefined };
  }
}

function placementFile(env: NodeJS.ProcessEnv): string {
  const seam = env.ACPX_TEST_PI_PLACEMENT_FILE;
  return env.NODE_TEST_CONTEXT && seam ? seam : PI_PLACEMENT_FILE;
}

/** Empty and `home` (and no file) are the documented "not on the box"; anything else is named, once. */
function warnUnknownPlacementOnce(signal: PlacementSignal, warn: (line: string) => void): void {
  const { value } = signal;
  if (value === undefined || value === "" || value === "home" || warnedUnknownPlacement) {
    return;
  }
  warnedUnknownPlacement = true;
  warn(
    `[acpx] warning: ${signal.source}=${JSON.stringify(value)} is not "pool" or "home"; ` +
      `treating it as "home" (Pi sessions stay in home-placed pods)\n`,
  );
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
