// brick f61391ac — SHARED-SESSION-TMP ROOT SCOPING. Same mechanism as
// `session-tmp-test-root.ts` and `box-env-scrub.ts`, but the stakes are higher,
// which is why it is a separate, explicit step rather than a footnote on tier 1.
//
// `ensureSessionSharedTmpDir` (src/acp/session-shared-tmp-dir.ts) defaults to
// `/workspace/.session-scratch` — a REAL, PERSISTENT root on the box's PVC. Tier
// 1's root is `/tmp`: pod-local and wiped on restart, so unscoped test debris
// there is untidy and self-correcting. Debris HERE is neither. It sits on the
// tight filesystem (192 GB, 75% used as measured 2026-09-30), it survives pod
// restarts, and it is indistinguishable from a live session's scratch directory
// to anyone looking — including the sweeper, which will dutifully keep it for a
// full 7 days because the suite just touched it.
//
// Dozens of rows across this suite call `buildAgentSpawnOptions` /
// `buildAgentEnvironment` with a synthetic `acpxRecordId` ("child-id", a fixture
// UUID, …), and every one of them now creates a tier-2 directory as a side
// effect. So the root is pinned once per test-file child process from the
// `--import` preload — by construction, not by asking every row to opt in.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_SHARED_TMP_ROOT_ENV } from "../src/acp/session-shared-tmp-dir.js";

/**
 * Point {@link SESSION_SHARED_TMP_ROOT_ENV} at a fresh throwaway directory for
 * this process. Returns the directory so a test file that wants to inspect what
 * `ensureSessionSharedTmpDir` actually wrote can do so without re-deriving the
 * path.
 *
 * ⚠️ The throwaway lives under the SYSTEM temp dir, deliberately NOT under the
 * real tier-2 root: a fixture root inside the swept area would be swept.
 */
export function scopeSessionSharedTmpRootForTests(env: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(join(tmpdir(), "acpx-session-shared-tmp-test-"));
  env[SESSION_SHARED_TMP_ROOT_ENV] = dir;
  return dir;
}
