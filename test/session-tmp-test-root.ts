// brick ceca191f — SESSION-TMP ROOT SCOPING, same coverage argument and same
// mechanism as `box-env-scrub.ts`'s override scrub.
//
// `ensureSessionTmpDir` (src/acp/session-tmp-dir.ts) defaults to
// `/workspace/.tmp` — a REAL, PVC-backed, disk-constrained directory on every
// dev box (88% full, which is the whole reason this feature ships with a
// reaper). Dozens of existing rows across this suite call
// `buildAgentSpawnOptions` / `buildAgentEnvironment` with a synthetic
// `acpxRecordId` ("child-id", a fixture UUID, …), and every one of them now
// creates a directory as a side effect. Left unscoped, running this suite
// would litter the box's real scratch root with test debris on every run —
// the exact class of leak this whole feature exists to stop, self-inflicted by
// the suite that tests it.
//
// So this is scoped the same way `ACPX_HARNESS_CONFIG_DIR_ROOT` scopes the
// harness-config-dir sweep for tests: point `ACPX_SESSION_TMP_ROOT` at a
// throwaway directory under the SYSTEM temp dir, once per test-file child
// process, from the `--import` preload — by construction, not by asking every
// row to opt in.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_TMP_ROOT_ENV } from "../src/acp/session-tmp-dir.js";

/**
 * Point {@link SESSION_TMP_ROOT_ENV} at a fresh throwaway directory for this
 * process. Returns the directory so a test file that wants to inspect what
 * `ensureSessionTmpDir` actually wrote can do so without re-deriving the path.
 */
export function scopeSessionTmpRootForTests(env: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(join(tmpdir(), "acpx-session-tmp-test-"));
  env[SESSION_TMP_ROOT_ENV] = dir;
  return dir;
}
