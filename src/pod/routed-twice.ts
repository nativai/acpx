import type { OutputMode } from "./command-classes.js";

/**
 * A-8 `routed_twice` — ONE helper for both callers (block A3's pass-through and block A6's routed
 * branches): a command that arrived over the routed channel (`ACPX_ROUTED=1`, set by the transport on
 * every command a routed call runs in an agent pod) is never routed again — no pass-through to
 * atrium, no second routed call. Light module (node builtins only): `src/cli.ts` loads both branch
 * modules before the placement step runs.
 */

/** C2's per-call marker. */
export const ROUTED_MARKER_ENV = "ACPX_ROUTED";

export function isRoutedCall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ROUTED_MARKER_ENV] === "1";
}

/** `acpx: REFUSED reason=routed_twice` — exit 2: a command that was routed would be routed again. */
export const ROUTED_TWICE_REFUSAL = {
  exitCode: 2,
  lines: [
    "acpx: REFUSED reason=routed_twice",
    "This command arrived over the control pod's routed channel (ACPX_ROUTED=1) and would be routed again; it is refused rather than looped. Nothing was started.",
  ] as [string, string],
};

/** Prints the refusal in the placement step's wire format (both lines in text mode, line 1 otherwise) and returns its exit code. */
export function refuseRoutedTwice(output: OutputMode, write: (line: string) => void): number {
  for (const line of output === "text"
    ? ROUTED_TWICE_REFUSAL.lines
    : [ROUTED_TWICE_REFUSAL.lines[0]]) {
    write(line);
  }
  return ROUTED_TWICE_REFUSAL.exitCode;
}
