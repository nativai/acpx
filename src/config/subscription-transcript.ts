import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Port a session's Claude transcript JSONL from one subscription's config dir to
// another, so a close+reopen on the target account resumes WITH context.
//
// The Claude conversation transcript is stored PER-ACCOUNT, keyed by
// CLAUDE_CONFIG_DIR, at <configDir>/projects/<cwdHash>/<acpSessionId>.jsonl. A
// close+reopen on a different subscription resumes against an account whose
// projects/ tree lacks that JSONL → the SDK throws "No conversation found" and
// acpx silently starts a fresh empty session (all context lost). The JSONL is
// account-agnostic in content (no oauth/org binding embedded — see CONCEPTION
// §0 / evidence.md §C), so a verbatim copy under the same acpSessionId resumes
// cleanly under the new account. This one-file copy IS the whole portability
// layer. Idempotent + overwrite-safe.

/**
 * Derive the per-cwd directory segment Claude uses under `projects/`. This is
 * the single source of truth for the layout acpx already hard-codes in
 * `src/cli/session/runtime.ts` (claudeSubagentDir) — keep them in lockstep.
 */
export function transcriptCwdHash(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Absolute path to a session's transcript JSONL inside a given CLAUDE_CONFIG_DIR.
 * Layout: <configDir>/projects/<cwdHash>/<acpSessionId>.jsonl (the `<acpSessionId>/`
 * dir holding `subagents/` is a sibling and is NOT load-bearing for top-level
 * resume).
 */
export function transcriptJsonlPath(configDir: string, cwd: string, acpSessionId: string): string {
  return path.join(configDir, "projects", transcriptCwdHash(cwd), `${acpSessionId}.jsonl`);
}

/**
 * Copy the transcript JSONL from `srcConfigDir` to `dstConfigDir` for the given
 * cwd + acpSessionId. Creates the destination `projects/<cwdHash>/` dir. If the
 * source JSONL is absent (fresh session, never prompted) this is a no-op and
 * returns `{ copied: false, reason: "no-source" }`. Overwrite-safe (copyFile
 * truncates the destination).
 */
export async function portTranscript(args: {
  srcConfigDir: string;
  dstConfigDir: string;
  cwd: string;
  acpSessionId: string;
}): Promise<{ copied: boolean; reason?: string }> {
  const src = transcriptJsonlPath(args.srcConfigDir, args.cwd, args.acpSessionId);
  const dst = transcriptJsonlPath(args.dstConfigDir, args.cwd, args.acpSessionId);

  if (src === dst) {
    return { copied: false, reason: "same-dir" };
  }

  await mkdir(path.dirname(dst), { recursive: true });

  try {
    await copyFile(src, dst);
  } catch (error) {
    if (isNotFound(error)) {
      return { copied: false, reason: "no-source" };
    }
    throw error;
  }

  return { copied: true };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
