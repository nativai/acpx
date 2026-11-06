import path from "node:path";
import { AcpxOperationalError } from "../errors.js";
import { isControlPod } from "./control-pod.js";

/**
 * The fixed session root (brick 45917618, CONCEPTION c53cbd97 §5.1): every NEW agent session on a
 * control pod starts here, whatever directory its spawner stands in (Daniel, 2026-11-06, option C).
 * A code constant on purpose — no per-box state, no config key.
 */
export const CONTROL_POD_SESSION_ROOT = "/workspace";

export const SESSION_ROOT_ENV = "ACPX_SESSION_ROOT";

export type SessionRoot =
  | { enforced: true; root: string; source: "control-pod" | "env" }
  | { enforced: false; root: null; source: "env-off" | "not-control-pod" };

/**
 * ⚠️ `ACPX_SESSION_ROOT` is the seam for workbench-hosted rigs and tests ONLY — never set on a box.
 * A rig runs on the workbench, whose image marker reads `workbench`, so without the variable a rig
 * silently tests the old behaviour (§5.1, R11). An EMPTY value switches enforcement off (legacy
 * fixtures). A relative value is refused rather than resolved against some guessed base.
 */
export function resolveSessionRoot(
  env: NodeJS.ProcessEnv = process.env,
  controlPod: boolean = isControlPod(env),
): SessionRoot {
  if (Object.hasOwn(env, SESSION_ROOT_ENV)) {
    const value = (env[SESSION_ROOT_ENV] ?? "").trim();
    if (value === "") {
      return { enforced: false, root: null, source: "env-off" };
    }
    if (!path.isAbsolute(value)) {
      throw new AcpxOperationalError(
        `${SESSION_ROOT_ENV}=${JSON.stringify(value)} is not an absolute path; set it to an ` +
          `absolute directory, to the empty string (enforcement off), or unset it`,
        { outputCode: "USAGE", detailCode: "SESSION_ROOT_INVALID", origin: "cli" },
      );
    }
    return { enforced: true, root: path.resolve(value), source: "env" };
  }
  if (controlPod) {
    return { enforced: true, root: CONTROL_POD_SESSION_ROOT, source: "control-pod" };
  }
  return { enforced: false, root: null, source: "not-control-pod" };
}

/**
 * THE one decision of a new session's cwd (§5.2). Every create seam — `createSessionWithClient`,
 * `runOnce`, import, the runtime library, the transient probes — routes its cwd through here, and
 * `test/session-root-create-sites.test.ts` fails on a create site that does not.
 */
export function effectiveCreateCwd(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sessionRoot = resolveSessionRoot(env);
  return sessionRoot.enforced ? sessionRoot.root : path.resolve(requested);
}

/** The stderr line that makes the escape hatch visible on a control pod, or `undefined`. */
export function sessionRootOverrideNotice(
  env: NodeJS.ProcessEnv = process.env,
  controlPod: boolean = isControlPod(env),
): string | undefined {
  const sessionRoot = resolveSessionRoot(env, controlPod);
  if (!controlPod || (sessionRoot.source !== "env" && sessionRoot.source !== "env-off")) {
    return undefined;
  }
  const value = (env[SESSION_ROOT_ENV] ?? "").trim();
  return (
    `[acpx] ${SESSION_ROOT_ENV}=${value === "" ? "(empty)" : value} overrides the fixed session ` +
    `root on this control pod (test and rig use only)\n`
  );
}
