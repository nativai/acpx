import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { SessionRecord } from "../../types.js";

export const BRICK_CLI_TIMEOUT_MS = 3_000;
export const BRICK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_BRICK_POOL_DIR = "/wisdom/Operating System/Bricks";

type BrickExecOptions = {
  timeoutMs?: number;
};

type BrickShowUnavailable = {
  kind: "unavailable";
  reason: string;
};

type BrickShowDefinitiveFailure = {
  kind: "not-found" | "ambiguous";
};

type BrickShowResult =
  | { kind: "resolved"; brickId: string }
  | BrickShowUnavailable
  | BrickShowDefinitiveFailure;

export function isBrickUuid(value: string): boolean {
  return BRICK_UUID_RE.test(value.trim().toLowerCase());
}

export function brickPoolDir(): string {
  const override = process.env.ACPX_BRICK_POOL_DIR?.trim();
  return override && override.length > 0 ? override : DEFAULT_BRICK_POOL_DIR;
}

export function resolveExistingBrickPath(brickId: string): string | null {
  const normalized = brickId.trim().toLowerCase();
  if (!BRICK_UUID_RE.test(normalized)) {
    return null;
  }
  const candidate = path.join(brickPoolDir(), normalized);
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export async function resolveBrickFlagRef(
  ref: string,
  options: BrickExecOptions = {},
): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("--brick must not be empty");
  }

  const result = await runBrickShow(trimmed, options.timeoutMs ?? BRICK_CLI_TIMEOUT_MS);
  if (result.kind === "resolved") {
    return result.brickId;
  }
  throwForDefinitiveBrickFailure(result, trimmed);

  return acceptUuidWhenBrickCliUnavailable(trimmed, unavailableBrickShowReason(result));
}

export async function stampBrickSessionStarted(
  brickId: string,
  acpxRecordId: string,
  options: BrickExecOptions = {},
): Promise<void> {
  const normalized = brickId.trim().toLowerCase();
  if (!BRICK_UUID_RE.test(normalized)) {
    return;
  }
  try {
    await execBrick(["stamp", normalized, "session-started", "--by", `session:${acpxRecordId}`], {
      timeoutMs: options.timeoutMs ?? BRICK_CLI_TIMEOUT_MS,
    });
  } catch (error) {
    process.stderr.write(
      `[acpx] warning: brick stamp failed for ${normalized}: ${describeExecError(error)}\n`,
    );
  }
}

export async function maybeStampBrickLink(record: SessionRecord): Promise<void> {
  const brickId = record.metadata?.brick?.trim().toLowerCase();
  if (!brickId || !BRICK_UUID_RE.test(brickId)) {
    return;
  }
  await stampBrickSessionStarted(brickId, record.acpxRecordId);
}

export async function warnIfBrickDoesNotResolve(brickId: string): Promise<void> {
  const normalized = brickId.trim().toLowerCase();
  if (!BRICK_UUID_RE.test(normalized)) {
    return;
  }
  const result = await runBrickShow(normalized, BRICK_CLI_TIMEOUT_MS);
  if (result.kind === "not-found") {
    process.stderr.write(`[acpx] warning: brick does not resolve in the pool: ${normalized}\n`);
  }
}

async function runBrickShow(ref: string, timeoutMs: number): Promise<BrickShowResult> {
  try {
    const { stdout } = await execBrick(["show", ref, "--json"], { timeoutMs });
    const parsed: unknown = JSON.parse(stdout);
    const brickId = readBrickId(parsed);
    if (!brickId) {
      return { kind: "unavailable", reason: "show returned no usable brick id" };
    }
    return { kind: "resolved", brickId };
  } catch (error) {
    const code = execErrorCode(error);
    if (code === 3) {
      return { kind: "not-found" };
    }
    if (code === 5) {
      return { kind: "ambiguous" };
    }
    return { kind: "unavailable", reason: describeExecError(error) };
  }
}

function readBrickId(value: unknown): string | undefined {
  const envelope = asRecord(value);
  if (envelope?.ok !== true) {
    return undefined;
  }
  const data = asRecord(envelope.data);
  const brick = asRecord(data?.brick);
  const id = brick?.id;
  if (typeof id !== "string") {
    return undefined;
  }
  const normalized = id.trim().toLowerCase();
  return BRICK_UUID_RE.test(normalized) ? normalized : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function throwForDefinitiveBrickFailure(result: BrickShowResult, ref: string): void {
  if (result.kind === "not-found") {
    throw new InvalidArgumentError(`--brick refers to unknown brick: ${ref}`);
  }
  if (result.kind === "ambiguous") {
    throw new InvalidArgumentError(
      `--brick is ambiguous: ${ref} — pass slug__uuid8 or the full uuid`,
    );
  }
}

function acceptUuidWhenBrickCliUnavailable(ref: string, reason: string): string {
  const normalized = ref.toLowerCase();
  if (BRICK_UUID_RE.test(normalized)) {
    process.stderr.write(
      `[acpx] warning: brick CLI unavailable (${reason}) — --brick accepted unvalidated: ${normalized}\n`,
    );
    return normalized;
  }
  throw new InvalidArgumentError(
    `--brick ${JSON.stringify(ref)}: non-uuid refs need the brick CLI on PATH (${reason}). Pass the full uuid instead.`,
  );
}

function unavailableBrickShowReason(result: BrickShowResult): string {
  return result.kind === "unavailable" ? result.reason : "unavailable";
}

function execBrick(
  args: string[],
  options: Required<BrickExecOptions>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "brick",
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function execErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

// eslint-disable-next-line complexity -- execFile failures have several known shapes; keeping the formatter centralized avoids lossy warnings
function describeExecError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "unparseable JSON";
  }
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const errorLike = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    message?: unknown;
    stderr?: unknown;
  };
  if (errorLike.killed === true) {
    return `timed out${typeof errorLike.signal === "string" ? ` (${errorLike.signal})` : ""}`;
  }
  const code =
    typeof errorLike.code === "number" || typeof errorLike.code === "string"
      ? errorLike.code
      : undefined;
  if (code === "ENOENT") {
    return "not found";
  }
  const stderr = typeof errorLike.stderr === "string" ? errorLike.stderr.trim() : "";
  if (code !== undefined) {
    return `exited with code ${code}${stderr ? `: ${stderr}` : ""}`;
  }
  if (typeof errorLike.message === "string") {
    return errorLike.message;
  }
  return JSON.stringify(error) ?? "unknown error";
}
