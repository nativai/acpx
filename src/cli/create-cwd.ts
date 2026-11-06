import path from "node:path";
import type { Command } from "commander";
import { resolveSessionRoot, sessionRootOverrideNotice } from "../config/session-root.js";

/**
 * The CLI half of the fixed session root (brick 45917618, CONCEPTION c53cbd97 §5.3). It decides
 * only what the caller is TOLD — the guarantee is the library seam (`effectiveCreateCwd` in
 * `createSessionWithClient`, `runOnce`, import, the runtime library), exactly as the permission
 * flags announce here and are enforced in `AcpClient` (`cli/flags.ts` `resolvePermissionMode`).
 */

export function optionValueSourceWithGlobals(
  command: Command,
  optionName: string,
): string | undefined {
  let current: Command | null = command;
  while (current) {
    const source = current.getOptionValueSource(optionName);
    if (source !== undefined) {
      return source;
    }
    current = current.parent;
  }
  return undefined;
}

export function cwdFlagIsExplicit(command: Command): boolean {
  const source = optionValueSourceWithGlobals(command, "cwd");
  return source !== undefined && source !== "default";
}

/** Each line is emitted at most ONCE per process — same reasoning as `warnInertPermissionFlag`. */
let inertCwdWarned = false;
let overrideNoticeShown = false;

/** Test seam: the two lines warn once per process, so tests must reset them. */
export function resetCreateCwdWarnings(): void {
  inertCwdWarned = false;
  overrideNoticeShown = false;
}

export type CreateCwdResolution = {
  /** The cwd the create will get — the session root whenever enforcement is on. */
  cwd: string;
  /** The explicit request that was overridden, resolved; absent when nothing was overridden. */
  requestedCwd?: string;
};

/**
 * Decide and announce a create's cwd.
 *
 * - `explicitRequest`: the explicitly given directory, or `undefined` when none was given.
 * - `fallback`: today's default when nothing is enforced — the invocation cwd for a fresh session,
 *   the SOURCE's cwd for a copy or a `--from` successor (§5.2 E5).
 * - `flagLabel`: how the line names the flag (`--cwd`, or `sessions import --cwd`).
 *
 * ⚠️ NOT suppressed by plain `--format json` or `quiet`, only by `--json-strict`, whose shipped
 * contract is an EMPTY stderr; `requestedCwd` in the JSON result is the machine signal there.
 */
export function resolveCreateCwd(params: {
  explicitRequest: string | undefined;
  fallback: string;
  jsonStrict?: boolean;
  flagLabel?: string;
}): CreateCwdResolution {
  const sessionRoot = resolveSessionRoot();
  announceOverride(params.jsonStrict === true);
  const requested =
    params.explicitRequest === undefined ? undefined : path.resolve(params.explicitRequest);
  if (!sessionRoot.enforced) {
    return { cwd: requested ?? path.resolve(params.fallback) };
  }
  if (requested === undefined || requested === sessionRoot.root) {
    return { cwd: sessionRoot.root };
  }
  if (!params.jsonStrict) {
    warnInertCwd(params.flagLabel ?? "--cwd", requested, sessionRoot.root);
  }
  return { cwd: sessionRoot.root, requestedCwd: requested };
}

function announceOverride(jsonStrict: boolean): void {
  const notice = sessionRootOverrideNotice();
  if (notice && !jsonStrict && !overrideNoticeShown) {
    overrideNoticeShown = true;
    process.stderr.write(notice);
  }
}

function warnInertCwd(flagLabel: string, requested: string, root: string): void {
  if (inertCwdWarned) {
    return;
  }
  inertCwdWarned = true;
  process.stderr.write(
    `[acpx] ${flagLabel} ${requested} does not apply to new sessions: every new session starts ` +
      `in ${root} (fixed session root, Daniel 2026-11-06). Name the folder in the prompt; the ` +
      `agent can cd into it.\n`,
  );
}

/** `resolveCreateCwd` for the global `--cwd` flag of `command`. */
export function resolveCreateCwdFromFlags(params: {
  command: Command;
  cwdFlag: string;
  fallback?: string;
  jsonStrict?: boolean;
}): CreateCwdResolution {
  return resolveCreateCwd({
    explicitRequest: cwdFlagIsExplicit(params.command) ? params.cwdFlag : undefined,
    fallback: params.fallback ?? params.cwdFlag,
    jsonStrict: params.jsonStrict,
  });
}
