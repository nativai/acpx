// brick ceca191f — SESSION-TMP ROOT SCOPING, same coverage argument and same
// mechanism as `box-env-scrub.ts`'s override scrub.
//
// `ensureSessionTmpDir` (src/acp/session-tmp-dir.ts) defaults to `/tmp`
// (SPEC.md v2) — self-cleaning on pod restart, so disk accumulation is not a
// concern the way it was under v1's `/workspace`-rooted design. The reason to
// scope it in tests is narrower now, but still real: `/tmp` on this box is a
// shared, heavily-populated scratch space (~300 payload files from many
// concurrent agents, per SPEC.md's own motivating measurement), and dozens of
// existing rows across this suite call `buildAgentSpawnOptions` /
// `buildAgentEnvironment` with a synthetic `acpxRecordId` ("child-id", a
// fixture UUID, …), each creating a directory there as a side effect. Left
// unscoped, a targeted test run would litter the box's real, shared `/tmp`
// with test debris (`acpx-child-id`, etc.) indistinguishable from real
// sessions' directories to anyone else looking.
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
