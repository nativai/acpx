import { spawn } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";
import { brickChildEnv } from "../bricks-credential.js";
// ONE definition of the pool default for this repo. This file used to carry its own PRIVATE copy of
// the string — so the two acpx sites could (and did) drift together onto a path removed 2026-07-22,
// and fixing either one alone would have left the other resolving the dead path with nothing
// failing. See the note on the constant itself.
import { brickPoolDir } from "../cli/session/brick-link.js";

export const BRICK_CONTEXT_TIMEOUT_MS = 5_000;
export const BRICK_CONTEXT_MAX_BYTES = 32_768;

const BRICK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type BrickContextOptions = {
  timeoutMs?: number;
  // The child session's OWN acpx record id. When provided, it is passed to `brick context`
  // as `--session <id>` so the rendered "Your workspace" line names the child's own agent
  // folder — never the spawner's, which the queue-owner's ambient $ACPX_SESSION_URL carries.
  sessionId?: string;
};

export async function resolveBrickContext(
  brickId: string,
  options: BrickContextOptions = {},
): Promise<string | undefined> {
  const normalized = brickId.trim().toLowerCase();
  if (!BRICK_UUID_RE.test(normalized)) {
    return undefined;
  }
  return await execBrickContext(
    normalized,
    options.timeoutMs ?? BRICK_CONTEXT_TIMEOUT_MS,
    options.sessionId,
  );
}

function execBrickContext(
  brickId: string,
  timeoutMs: number,
  sessionId?: string,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    const args = sessionId
      ? ["context", brickId, "--session", sessionId, "--format", "inject"]
      : ["context", brickId, "--format", "inject"];
    try {
      child = spawn("brick", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // ⚠️ THIS `env` IS NOT OPTIONAL, AND ITS ABSENCE LOOKED LIKE NOTHING. Until B1 this spawn
        // passed no `env` at all, so the brick CLI — and everything it spawns — inherited
        // `process.env` WHOLESALE, realm credential included. There was no error and no warning;
        // the child worked perfectly. This path never reaches `auth-env.ts`'s delete list, so the
        // contract's prefix-strip remedy could not cover it: the list is never consulted here.
        env: brickChildEnv(),
      });
    } catch (error) {
      warnBrickContext(brickId, `spawn failed: ${describeError(error)}`);
      resolve(undefined);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      warnBrickContext(brickId, `timed out after ${timeoutMs}ms`);
      finish(undefined);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutChunks.push(buffer);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      warnBrickContext(brickId, `exec error: ${describeError(error)}`);
      finish(undefined);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim();
        warnBrickContext(brickId, `exited with code ${code ?? "null"}${tail ? `: ${tail}` : ""}`);
        finish(undefined);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
      if (stdout.toString("utf8").trim().length === 0) {
        warnBrickContext(brickId, "produced empty output");
        finish(undefined);
        return;
      }
      finish(formatContextOutput(brickId, stdout));
    });
  });
}

function formatContextOutput(brickId: string, stdout: Buffer): string {
  if (stdout.length <= BRICK_CONTEXT_MAX_BYTES) {
    return stdout.toString("utf8");
  }
  const prefix = decodeUtf8Prefix(stdout, BRICK_CONTEXT_MAX_BYTES);
  return `${prefix}\n\n[acpx: brick context truncated at 32 KiB — full content at ${path.join(brickPoolDir(), brickId, "CONTENT.md")}]`;
}

function decodeUtf8Prefix(buffer: Buffer, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(buffer.length, maxBytes); end >= 0; end -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // Try the previous byte until the prefix ends on a valid code point.
    }
  }
  return "";
}

// `brickPoolDir` is imported from brick-link.ts, not redefined here. It used to be a second copy
// of the same four lines - the very duplication that let the dead pool path live in two places.

function warnBrickContext(brickId: string, reason: string): void {
  process.stderr.write(
    `[acpx] brick context unavailable (${brickId}): ${reason}; continuing without brick context\n`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
