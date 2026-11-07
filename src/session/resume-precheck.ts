import fs from "node:fs/promises";
import path from "node:path";
import { acpAdapterKind } from "../acp/agent-command.js";
import { locatePiSessionTranscript } from "../acp/harness-config-dir.js";
import {
  knownTranscriptConfigDirs,
  resolveExistingTranscriptPath,
} from "../config/subscription-transcript.js";
import { AcpxOperationalError } from "../errors.js";
import { sessionBaseDir, sessionRecordFileName } from "./persistence.js";

/**
 * `sessions new --resume-session` binds a record to an EXISTING harness conversation, and that
 * conversation keeps the folder it started in (HoD ruling 2026-11-06, CONCEPTION §5.2 N0). acpx
 * enforces that ITSELF, before any record is created or reused and before any adapter is spawned —
 * it must not rely on the adapter:
 *
 * ⚠️ THE CLAUDE ADAPTER DOES NOT MISS. It resumes a conversation by id from ANY project folder, so a
 * resume at the wrong cwd "succeeds", the new turns are appended to the transcript under the OLD
 * folder's slug, and the record at the new cwd can then never be copied or forked ("not found in
 * project directory"). Found by the test-engineer on the dev6 rig with real Claude (brick 8cf859f0,
 * B11); the earlier mock-only test could not see it, because the mock refused the resume itself.
 * `test/session-root-cli.test.ts` ("B11 (real transcript)") plants a real transcript in a temp Claude config dir.
 *
 * - Claude: the transcript must exist under the chosen cwd's slug in a known config dir (every
 *   registry subscription and the raw `~/.claude`).
 * - Pi: pi-acp finds a session only in the chosen cwd's own session dir (`PI_CODING_AGENT_SESSION_DIR`),
 *   so a resume elsewhere fails rather than splits; the same check turns that into the clear refusal.
 * - Codex: no check. `thread/resume` finds the thread by id and its rollout is not filed by cwd, so a
 *   record at any cwd stays copyable (copies fork by thread id) — there is no split to prevent.
 */
export async function refuseUnresumableConversation(params: {
  resumeSessionId: string;
  recordId: string;
  cwd: string;
  agentCommand: string;
}): Promise<void> {
  await refuseCwdChangeOfExistingRecord(params.recordId, params.cwd);
  const kind = acpAdapterKind(params.agentCommand);
  if (kind === "claude" && !(await claudeTranscriptExists(params.cwd, params.resumeSessionId))) {
    throw resumeNotFoundError(params.resumeSessionId, params.cwd);
  }
  if (
    kind === "pi" &&
    !locatePiSessionTranscript({ cwd: params.cwd, acpSessionId: params.resumeSessionId })
  ) {
    throw resumeNotFoundError(params.resumeSessionId, params.cwd);
  }
}

export function resumeNotFoundMessage(resumeSessionId: string, cwd: string): string {
  return (
    `Failed to resume ACP session ${resumeSessionId}: no such conversation was found for the ` +
    `folder ${cwd}. A conversation keeps the folder it started in — pass --cwd <the ` +
    `conversation's original folder>.`
  );
}

function resumeNotFoundError(resumeSessionId: string, cwd: string): AcpxOperationalError {
  return new AcpxOperationalError(resumeNotFoundMessage(resumeSessionId, cwd), {
    outputCode: "NO_SESSION",
    origin: "runtime",
  });
}

async function claudeTranscriptExists(cwd: string, acpSessionId: string): Promise<boolean> {
  for (const configDir of knownTranscriptConfigDirs()) {
    if (await resolveExistingTranscriptPath(configDir, cwd, acpSessionId)) {
      return true;
    }
  }
  return false;
}

/** A record never changes its cwd (§5.5): a resume onto an existing record must use its folder. */
async function refuseCwdChangeOfExistingRecord(recordId: string, cwd: string): Promise<void> {
  let existingCwd: unknown;
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(sessionBaseDir(), sessionRecordFileName(recordId)), "utf8"),
    ) as Record<string, unknown>;
    existingCwd = raw.cwd;
  } catch {
    return; // no such record (or unreadable): nothing to protect
  }
  if (typeof existingCwd === "string" && path.resolve(existingCwd) !== path.resolve(cwd)) {
    throw new AcpxOperationalError(
      `Session ${recordId} already exists in the folder ${existingCwd}, and a session never changes ` +
        `its folder. Resume it there (--cwd ${existingCwd}), or address the existing session with ` +
        `--session-id ${recordId}.`,
      { outputCode: "USAGE", detailCode: "RESUME_CWD_MISMATCH", origin: "cli" },
    );
  }
}
