/**
 * C2: the caller-identity variables, and the ONLY case they travel — an agent caused the call through
 * the pass-through (C6.2). Light module: `routed-branches.ts` (loaded before the placement step) and
 * `routed-call.ts` share it.
 *
 * How acpx on the control pod knows an agent caused the call: the atrium server starts it for a
 * passed-through command with the caller's identity in its environment ("the one place where the
 * server passes a caller's identity to acpx", C6.2), and strips the identity from every delivery it
 * spawns itself (`withoutCallerIdentity`). So these variables are present in a control-pod acpx's
 * environment exactly when an agent caused its call. Nothing else of the environment is read here.
 */
export const CALLER_IDENTITY_VARS = [
  "ACPX_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
] as const;

export type CallerIdentity = Partial<Record<(typeof CALLER_IDENTITY_VARS)[number], string>>;

/** The identity variables set (non-empty) in `env`; an empty object when none is. */
export function callerIdentityFrom(env: NodeJS.ProcessEnv): CallerIdentity {
  const out: CallerIdentity = {};
  for (const name of CALLER_IDENTITY_VARS) {
    const value = env[name]?.trim();
    if (value) {
      out[name] = value;
    }
  }
  return out;
}
