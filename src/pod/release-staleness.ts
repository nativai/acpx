import fs from "node:fs";
import path from "node:path";
import { lockHostPlace } from "./identity.js";
import { acpxReleaseOf } from "./owner-pod.js";
import { testRuntimeDir } from "./routed-branches.js";
import { releaseNameOf } from "./routed-call.js";

/**
 * C9 "Staleness" (block A11): in an agent pod acpx's deploy-staleness token is "`releases.acpx` is not
 * the release `/data/runtime/acpx` points to". The pod's own pinned release is the one the broker
 * wrote into `NV_RUNTIME_RELEASES` (`acpxReleaseOf`: the process's value first, PID 1's when it is
 * missing — A-35); the box's current release is the one the control side's `acpx` link names now.
 *
 * ⚠️ NOT THE INFO.JSON SHA, NOT THE ENTRY-POINT HASH. In a pod pinned to an older release the box's
 * `info.json` is already NEWER at the owner's start, so a token captured from it equals itself
 * forever (never stale), and the pinned entry point never changes. Held by
 * `test/pod-release-staleness.test.ts` ("info.json differs, release equal → not stale").
 */

/** True only inside an agent pod (place file or `ag-` hostname — the witness every pod rule uses). */
export function inAgentPod(env: NodeJS.ProcessEnv): boolean {
  return lockHostPlace(env) === "agent-pod";
}

/** The release directory name the box's `acpx` link points to NOW; undefined when it cannot be read as one. */
export function currentAcpxRelease(env: NodeJS.ProcessEnv): string | undefined {
  const runtimeDir = testRuntimeDir(env) ?? "/data/runtime";
  try {
    return releaseNameOf(fs.readlinkSync(path.join(runtimeDir, "acpx")), "acpx");
  } catch {
    // Absent, or something there that is not a link: no answer, so never "stale" (fail safe).
    return undefined;
  }
}

/**
 * The staleness probe of an owner that runs in an agent pod: the pinned release is captured once, the
 * link is read at every call. Either side unknown → `false`: an owner is recycled only on a positive
 * difference, never for a lack of evidence.
 */
export function createPodReleaseStalenessProbe(env: NodeJS.ProcessEnv): () => boolean {
  const pinned = acpxReleaseOf(env);
  return () => {
    if (pinned === undefined) {
      return false;
    }
    const current = currentAcpxRelease(env);
    return current !== undefined && current !== pinned;
  };
}
