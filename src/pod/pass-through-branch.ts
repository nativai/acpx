import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { atriumRequest } from "./atrium-exchange.js";
import {
  callHome,
  callHomeAnswerTimeoutMs,
  callHomeUnknownFailure,
  atriumAwayFailure,
  doorRefusedFailure,
  emitCallHomeFailure,
  enterCallHomeMode,
  PASS_THROUGH_DEADLINE_MS,
  waitingLine,
  type CallHomeOutcome,
} from "./call-home.js";
import type { Classification, OutputMode } from "./command-classes.js";
import {
  buildPassThroughCall,
  PassThroughUsageError,
  type PassThroughCall,
} from "./pass-through-args.js";
import {
  registerBranchHandler,
  type BranchContext,
  type PlacementDecision,
} from "./placement-step.js";
import { judgeChild, spawnVerdictChild, verdictOf, type ChildRunner } from "./verdict-child.js";

/**
 * A3 — the pass-through client and the message route, no direct path (CONTRACTS-r4 C6.1, C6.2, C7.2;
 * brick 7eb9686f). Registers A1's two branches `pass-through` and `message-route`.
 *
 * ⚠️ KEEP THIS MODULE LIGHT: `src/cli.ts` imports it before the placement step runs (node builtins,
 * `placement-step.ts`, `call-home.ts`, `atrium-exchange.ts`, `command-classes.ts`); the heavy CLI is
 * loaded only inside a handler.
 *
 * NOTHING TAKES A DIRECT PATH. Whatever atrium (or its absence) answers, neither branch ever falls
 * through to today's local code: a create, a box-wide store write or a command about another session
 * runs on the control pod or does not run; a prompt for another session reaches atrium's message
 * queue or fails after the 600 s call-home budget.
 *
 * ⚠️ NO `cwd` IS SENT (A-9). The server runs a passed-through command in its fixed session root; a
 * client that sent one would suggest a re-rooting nobody does. A file argument travels as bytes
 * (`stdin_b64`), or — a path the control pod reads itself — as an absolute path. Held by
 * `test/pod-pass-through.test.ts` ("sends no cwd").
 */

export {
  ABSOLUTIZED_PATH_FLAGS,
  BRIEF_SHARED_ROOTS,
  buildPassThroughCall,
  MAX_STDIN_BYTES,
  NO_RECORD_ID_CREATE_PATHS,
  PassThroughUsageError,
  RECORD_ID_CREATE_PATHS,
  STDIN_FILE_FLAGS,
  type PassThroughCall,
  type PassThroughInput,
} from "./pass-through-args.js";

// ─── the marker: a routed command is never routed twice (A-8) — one helper, shared with block A6 ──

import {
  isRoutedCall,
  refuseRoutedTwice,
  ROUTED_MARKER_ENV,
  ROUTED_TWICE_REFUSAL,
} from "./routed-twice.js";

export { isRoutedCall, ROUTED_MARKER_ENV, ROUTED_TWICE_REFUSAL };

// ─── the handler ──────────────────────────────────────────────────────────────────────────────

export type PassThroughIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** The server's origin: the ladder of `acpx-ui-internal-origin.ts`, loopback forwarder last (C6.1). */
async function atriumBase(env: NodeJS.ProcessEnv): Promise<string> {
  const { resolveAtriumLocalOrigin, readAcpxUiInternalOriginSources } =
    await import("../acp/acpx-ui-internal-origin.js");
  return resolveAtriumLocalOrigin(env, readAcpxUiInternalOriginSources());
}

type AnswerBody = {
  exit?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  error?: unknown;
  reason?: unknown;
  message?: unknown;
};

function asBody(value: unknown): AnswerBody {
  return typeof value === "object" && value !== null ? (value as AnswerBody) : {};
}

/**
 * K5 (brick 46b827ba): a target atrium says is no session — or two — is answered by the control pod's own code:
 * the same argv run in a read-only child with the verdict armed, relayed ONLY when the child confirms it is read-only
 * and ends in an answer (`verdict-child.ts`). Returns the exit code, or undefined to keep the door's refusal.
 */
function verdictAnswerFor(
  status: number,
  body: AnswerBody,
  deps: {
    io: PassThroughIo;
    context: BranchContext;
    classification: Classification;
    env: NodeJS.ProcessEnv;
    runChild: ChildRunner;
  },
): number | undefined {
  const verdict = verdictOf(status, body, deps.classification);
  if (verdict === undefined) {
    return undefined;
  }
  const judged = judgeChild(deps.runChild({ argv: deps.context.argv, verdict, env: deps.env }));
  if (!judged.relay) {
    return undefined;
  }
  deps.io.stdout(judged.stdout);
  deps.io.stderr(judged.stderr);
  return judged.exit;
}

/** Print what atrium answered, or the failure it amounts to; returns the exit code. */
async function finishAnswered(
  outcome: Extract<CallHomeOutcome, { kind: "answered" }>,
  call: PassThroughCall,
  deps: {
    output: OutputMode;
    io: PassThroughIo;
    context: BranchContext;
    classification: Classification;
    env: NodeJS.ProcessEnv;
    runChild: ChildRunner;
  },
): Promise<number> {
  const body = asBody(outcome.body);
  if (outcome.status === 200 && typeof body.exit === "number") {
    deps.io.stdout(typeof body.stdout === "string" ? body.stdout : "");
    deps.io.stderr(typeof body.stderr === "string" ? body.stderr : "");
    return body.exit;
  }
  const answered = verdictAnswerFor(outcome.status, body, deps);
  if (answered !== undefined) {
    return answered;
  }
  // A 4xx is a refusal by the door (a 400 class-not-passable, a 403 caller gate): FINAL, never
  // retried. Any other answer (a 500, a body that is not `{exit}`): the command may have run.
  const failure =
    outcome.status >= 400 && outcome.status < 500
      ? doorRefusedFailure(outcome.status, body.error, body.reason)
      : callHomeUnknownFailure("connection", call.callId, call.advice);
  emitCallHomeFailure(failure, deps.output, deps.context.write, deps.context.writeStdout);
  return failure.exitCode;
}

export type PassThroughRun = {
  decision: PlacementDecision & { kind: "branch" };
  context: BranchContext;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: PassThroughIo;
  /** Test seams: the origin and the exchange. */
  origin?: string;
  send?: typeof atriumRequest;
  readStdin?: () => Buffer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the verdict child (default: this CLI under the Node permission model). */
  runChild?: ChildRunner;
};

const defaultIo: PassThroughIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** A guard's refusal lines, in the placement step's wire format: both lines in text mode, line 1 otherwise. */
function refuseLines(
  decision: PlacementDecision & { kind: "branch" },
  context: BranchContext,
  lines: readonly [string, string],
  exitCode: number,
): number {
  for (const line of decision.output === "text" ? lines : [lines[0]]) {
    context.write(line);
  }
  return exitCode;
}

/** The request, or the refusal number when it cannot be built (nothing was sent). */
function buildCallOrRefuse(run: PassThroughRun, env: NodeJS.ProcessEnv): PassThroughCall | number {
  const { decision, context } = run;
  const classification = decision.classification;
  if (classification.kind !== "classified") {
    // Unreachable by the decision's own types; fail closed.
    return refuseLines(
      decision,
      context,
      ROUTED_TWICE_REFUSAL.lines,
      ROUTED_TWICE_REFUSAL.exitCode,
    );
  }
  try {
    return buildPassThroughCall({
      argv: context.argv,
      commandPath: classification.path,
      commandClass: classification.class,
      operandIndexes: classification.operandIndexes,
      env,
      cwd: run.cwd ?? process.cwd(),
      readFile: (file) => fs.readFileSync(file),
      readStdin: run.readStdin ?? (() => fs.readFileSync(0)),
      mintId: randomUUID,
    });
  } catch (error) {
    if (!(error instanceof PassThroughUsageError)) {
      throw error;
    }
    return refuseLines(
      decision,
      context,
      [
        `acpx: REFUSED reason=${error.reason} nothing_started=true protocol=1`,
        `${error.message}; nothing was started.`,
      ],
      2,
    );
  }
}

/** Post the call through the call-home loop. */
async function sendCall(
  run: PassThroughRun,
  env: NodeJS.ProcessEnv,
  call: PassThroughCall,
  output: OutputMode,
): Promise<CallHomeOutcome> {
  const url = `${run.origin ?? (await atriumBase(env))}/api/acpx/call`;
  const send = run.send ?? atriumRequest;
  return await callHome({
    send: () =>
      send({
        method: "POST",
        url,
        headers: { "x-source-session": env.ACPX_SESSION_URL?.trim() || "anonymous" },
        body: call.body,
        env,
        answerTimeoutMs: callHomeAnswerTimeoutMs(PASS_THROUGH_DEADLINE_MS, env),
      }),
    env,
    // O-4: a caller's own tool timeout fires long before the budget ends; say what the wait is doing.
    ...(output === "json-strict"
      ? {}
      : {
          onWait: (info: Parameters<typeof waitingLine>[0]) => run.context.write(waitingLine(info)),
        }),
    ...(run.now ? { now: run.now } : {}),
    ...(run.sleep ? { sleep: run.sleep } : {}),
  });
}

export async function runPassThrough(run: PassThroughRun): Promise<number> {
  const env = run.env ?? process.env;
  const { decision, context } = run;
  if (isRoutedCall(env)) {
    return refuseRoutedTwice(decision.output, context.write, context.writeStdout);
  }
  const call = buildCallOrRefuse(run, env);
  if (typeof call === "number") {
    return call;
  }
  const outcome = await sendCall(run, env, call, decision.output);
  if (outcome.kind === "answered") {
    return await finishAnswered(outcome, call, {
      output: decision.output,
      io: run.io ?? defaultIo,
      context,
      classification: decision.classification,
      env,
      runChild: run.runChild ?? spawnVerdictChild,
    });
  }
  const failure =
    outcome.kind === "away"
      ? atriumAwayFailure(outcome.waitedMs)
      : callHomeUnknownFailure(outcome.reason, call.callId, call.advice);
  emitCallHomeFailure(failure, decision.output, context.write, context.writeStdout);
  return failure.exitCode;
}

registerBranchHandler("pass-through", async (decision, context) => {
  return await runPassThrough({ decision, context });
});

/**
 * `message-route`: a prompt for another session. acpx loads its world as usual and the prompt path
 * goes to atrium's message routes in call-home mode (`src/cli/prompt-routing.ts`,
 * `routed-prompt.ts`): the budget, no `atrium.json`, no direct fallback.
 */
const NOT_ROUTABLE_PROMPT_OPTIONS = ["--batch-file", "--message-id"] as const;

/**
 * The first of atrium's own delivery options among the argv's OPTIONS, or undefined. Only options
 * count: everything after `--` is prompt text (O-1).
 */
export function notRoutableOption(argv: readonly string[]): string | undefined {
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  return NOT_ROUTABLE_PROMPT_OPTIONS.find((flag) =>
    options.some((token) => token === flag || token.startsWith(`${flag}=`)),
  );
}

registerBranchHandler("message-route", async (decision, context) => {
  const refuseWith = (lines: readonly [string, string], exitCode: number): number =>
    refuseLines(decision, context, lines, exitCode);
  if (isRoutedCall()) {
    return refuseRoutedTwice(decision.output, context.write, context.writeStdout);
  }
  // atrium's own delivery spawns (`--message-id`, `--batch-file`) run in the RECIPIENT's pod, over the
  // routed channel; one reaching another pod's message route is a misroute, not a caller's prompt.
  const option = notRoutableOption(context.argv);
  if (option !== undefined) {
    return refuseWith(
      [
        `acpx: REFUSED reason=prompt_option_not_routable nothing_started=true protocol=1 option=${option}`,
        `${option} belongs to atrium's own delivery and cannot be sent from an agent pod to another session; nothing was started.`,
      ],
      2,
    );
  }
  enterCallHomeMode();
  const { realpathSync } = await import("node:fs");
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  if (entry) {
    const { buildQueueOwnerArgOverride } = await import("../cli/session/queue-owner-process.js");
    const queueOwnerArgOverride = buildQueueOwnerArgOverride(entry);
    if (queueOwnerArgOverride) {
      process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
    }
  }
  const { main } = await import("../cli-core.js");
  await main(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
});
