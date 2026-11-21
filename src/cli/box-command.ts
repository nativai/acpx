import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { BOX_RUNTIME_STATUS_FILE } from "../pod/pass-through-args.js";
import { acpxStateRoot } from "../session/persistence/session-base-dir.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";

/**
 * `acpx box refresh` — release the box (A-17, CONTRACTS-r4 C1.2 "Releasing a box is a `control-store`
 * verb"; brick f2fde405). On the control pod it starts `/opt/bootstrap/refresh.sh` DETACHED and
 * returns at once with the paths of its log (under the state home, so an agent pod can read it) and of
 * the runtime-status record. From an agent pod the class table passes it through like every
 * `control-store` command (A3): no ssh hop into the control pod.
 *
 * The script's own rules stay — acpx adds none: one refresh at a time (a second is refused within
 * ~0.3 s with the holder named, exit 75) and the build's admission under `capacity run-build`. A
 * refusal therefore arrives INSIDE the short grace this verb waits: if the script has already ended
 * then, its exit code and first lines are passed through; otherwise the release is running and the
 * verb says so and exits 0.
 *
 * Who may release: any session of the box. No new permission; the CALLER IS RECORDED — in a record
 * file beside the log, and in the log's first line — and the script itself names the caller from the
 * environment this verb hands it (`ACPX_SESSION_URL`, `ACPX_SEAT_URL`; the pass-through puts the
 * caller's identity there, C6.2).
 */

const RELEASE_SCRIPT = "/opt/bootstrap/refresh.sh";
/** How long the verb waits for a fast refusal before it calls the release started. */
const GRACE_MS = 2_000;
const FIRST_LINES = 5;

/**
 * ⚠️ The script, the status file and the grace are fixed in production. A test points them elsewhere
 * through these variables, honoured ONLY under a NON-EMPTY `NODE_TEST_CONTEXT` (the rule of the
 * `ACPX_POD_TEST_HOME` and call-home seams): no environment can redirect a real release to another
 * program. Held by `test/box-refresh.test.ts`.
 */
function testOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return (env.NODE_TEST_CONTEXT ?? "") !== "" && env[name] ? env[name] : undefined;
}

export function boxRefreshSettings(env: NodeJS.ProcessEnv): {
  script: string;
  runtimeStatus: string;
  graceMs: number;
} {
  return {
    script: testOverride(env, "ACPX_BOX_REFRESH_SCRIPT") ?? RELEASE_SCRIPT,
    runtimeStatus:
      testOverride(env, "ACPX_BOX_REFRESH_STATUS_FILE") ??
      env.NV_BOX_RUNTIME_STATUS_FILE ??
      BOX_RUNTIME_STATUS_FILE,
    graceMs: Number(testOverride(env, "ACPX_BOX_REFRESH_GRACE_MS")) || GRACE_MS,
  };
}

export type BoxRefreshResult =
  | { started: true; pid: number; log: string; record: string; runtimeStatus: string }
  | {
      started: false;
      exitCode: number;
      firstLines: string[];
      log: string;
      record: string;
      runtimeStatus: string;
    };

type Caller = { session_url?: string; seat_url?: string; record_id?: string };

function callerOf(env: NodeJS.ProcessEnv): Caller {
  const pick = (name: string) => env[name]?.trim() || undefined;
  return {
    ...(pick("ACPX_SESSION_URL") ? { session_url: pick("ACPX_SESSION_URL") } : {}),
    ...(pick("ACPX_SEAT_URL") ? { seat_url: pick("ACPX_SEAT_URL") } : {}),
    ...(pick("ACPX_SESSION_RECORD_ID") ? { record_id: pick("ACPX_SESSION_RECORD_ID") } : {}),
  };
}

function firstLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .slice(1, 1 + FIRST_LINES);
  } catch {
    return [];
  }
}

/** Resolves with the exit code if `child` ends within `graceMs`, else `undefined` (still running). */
function exitWithin(child: ChildProcess, graceMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), graceMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 128 : 1));
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}

/** The release's record and log, created under the state home; the caller is on disk before anything runs. */
function openRelease(
  stateRoot: string,
  startedAt: Date,
  settings: ReturnType<typeof boxRefreshSettings>,
  caller: Caller,
): { fd: number; log: string; record: string } {
  const dir = path.join(stateRoot, "box-refresh");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(
    dir,
    `refresh-${startedAt.toISOString().replace(/[-:.]/gu, "")}-${process.pid}`,
  );
  const log = `${base}.log`;
  const record = `${base}.json`;
  fs.writeFileSync(
    record,
    `${JSON.stringify({ started_at: startedAt.toISOString(), caller, script: settings.script, log, runtime_status: settings.runtimeStatus })}\n`,
  );
  const fd = fs.openSync(log, "a");
  fs.writeSync(
    fd,
    `[acpx box refresh] ${startedAt.toISOString()} caller session=${caller.session_url ?? "-"} seat=${caller.seat_url ?? "-"}\n`,
  );
  return { fd, log, record };
}

export async function startBoxRefresh(
  options: { env?: NodeJS.ProcessEnv; stateRoot?: string; now?: Date } = {},
): Promise<BoxRefreshResult> {
  const env = options.env ?? process.env;
  const settings = boxRefreshSettings(env);
  const { fd, log, record } = openRelease(
    options.stateRoot ?? acpxStateRoot(),
    options.now ?? new Date(),
    settings,
    callerOf(env),
  );
  const child = spawn(settings.script, [], { detached: true, stdio: ["ignore", fd, fd], env });
  child.unref();
  fs.closeSync(fd);
  const code = await exitWithin(child, settings.graceMs);
  const runtimeStatus = settings.runtimeStatus;
  return code === undefined
    ? { started: true, pid: child.pid ?? 0, log, record, runtimeStatus }
    : { started: false, exitCode: code, firstLines: firstLines(log), log, record, runtimeStatus };
}

function writeText(result: BoxRefreshResult): void {
  if (result.started) {
    process.stdout.write(
      `box refresh started (pid ${result.pid})\nlog: ${result.log}\nrecord: ${result.record}\nruntime-status: ${result.runtimeStatus}\n`,
    );
    return;
  }
  for (const line of result.firstLines) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(
    `box refresh: the script ended at once with exit ${result.exitCode}; log: ${result.log}\n`,
  );
}

export function registerBoxCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const box = parent.command("box").description("This box's own release (control-store verbs)");
  box
    .command("refresh")
    .description(
      "Release this box: start /opt/bootstrap/refresh.sh detached and return its log path; a refusal (exit 75) is passed through",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      const { format } = resolveGlobalFlags(this, config);
      const result = await startBoxRefresh();
      const json = result.started
        ? {
            action: "box_refresh",
            started: true,
            pid: result.pid,
            log: result.log,
            record: result.record,
            runtime_status: result.runtimeStatus,
          }
        : {
            action: "box_refresh",
            started: false,
            exit: result.exitCode,
            first_lines: result.firstLines,
            log: result.log,
            record: result.record,
            runtime_status: result.runtimeStatus,
          };
      if (!emitJsonResult(format, json)) {
        writeText(result);
      }
      if (!result.started) {
        process.exitCode = result.exitCode;
      }
    });
}
