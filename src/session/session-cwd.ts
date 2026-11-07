import { statSync } from "node:fs";
import { acpAdapterKind } from "../acp/agent-command.js";
import { resolveSessionRoot } from "../config/session-root.js";
import { SessionCwdMissingError } from "../errors.js";

/**
 * A session whose working directory is gone is REFUSED (`SESSION_CWD_MISSING`), never given a
 * re-created empty folder and never run somewhere else (brick 45917618 §5.6). Called at the single
 * adapter spawn site (`AcpClient.spawnAgentProcess`) AND at the start of every queue-owner turn
 * (`runQueuedTask`), so a session behaves the same whether its owner is cold or still warm when the
 * folder goes (HoD ruling, 2026-11-06).
 *
 * ⚠️ DO NOT "HEAL" THIS WITH A `mkdirSync(cwd, { recursive: true })`. It looks like a kindness and
 * it is the bug: it resurrects a reaped worktree path as a plain directory inside a repo tree, and
 * the agent then works in an empty folder with its conversation intact and no error anywhere.
 * `test/session-root-cli.test.ts` (E1, cold and warm owner) asserts the folder is still absent.
 */
export function assertSessionCwdExists(params: {
  cwd: string;
  sessionId?: string;
  agentCommand: string;
}): void {
  if (!sessionCwdIsMissing(params.cwd)) {
    return;
  }
  throw new SessionCwdMissingError({
    cwd: params.cwd,
    sessionId: params.sessionId?.trim() || undefined,
    piSource: acpAdapterKind(params.agentCommand) === "pi",
    root: sessionRootOrUndefined(),
  });
}

/**
 * MISSING means: the path does not exist (`ENOENT`), a component is not a directory (`ENOTDIR`), or
 * it exists and is not a directory. Any OTHER stat failure (`EACCES`, `EIO`, a stale NFS handle …)
 * is uncertainty, and the turn proceeds — never refuse a session on a reading we cannot trust
 * (CONCEPTION v1.4 §5.6). `test/session-cwd.test.ts` pins all three.
 */
export function sessionCwdIsMissing(
  cwd: string,
  stat: (target: string) => { isDirectory(): boolean } = statSync,
): boolean {
  try {
    return !stat(cwd).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

function sessionRootOrUndefined(): string | undefined {
  try {
    return resolveSessionRoot().root ?? undefined;
  } catch {
    return undefined;
  }
}
