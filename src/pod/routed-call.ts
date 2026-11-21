import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentHarness,
  type BrokerEnsureResult,
  type BrokerStep,
  type AgentPlacement,
  type BrokerAgentClass,
  type BrokerAgentRequest,
  AGENT_BROKER_CONTRACT,
  boxOfNamespace,
  ensureAgentPod,
  getAgents,
  namespaceFromSources,
  readAgentBrokerOriginSources,
  resolveAgentBrokerOrigin,
  type BrokerClientOptions,
  WAKE_BOUND_MS,
} from "./broker-client.js";
import {
  admissionBusyRefusal,
  agentCapRefusal,
  podStartingRefusal,
  RoutedCallError,
  type AgentCapWhy,
} from "./pod-refusal.js";

/**
 * C2 — the routed call, caller side: one acpx invocation executed inside an agent pod on behalf of
 * a caller on the control pod. acpx shells out to T1's transport (`agent-exec`, see
 * `reports/TRANSPORT-INTERFACE.md` of brick fff06400); everything around the transport — the broker
 * ensure (C4), the payload file, the per-call values, the outcome table — is here.
 *
 * AT MOST ONCE: this module never re-sends. A call whose outcome is unknown is reported as such
 * (`ROUTED outcome=unknown`); the atrium server repeats it with the same message id.
 */

export const ROUTED_CONTRACT_VERSION = 1;
/** C2 deadlines by class. One named constant each: fault-run calibration may still move them. */
export const OWNER_ENSURE_DEADLINE_MS = 45_000;
export const OWNER_IF_POD_DEADLINE_MS = 20_000;
/**
 * C2 amendment (program HoD): a transport `75 agent_unreachable` is held as `pod_starting
 * phase=starting` only this long after the pod became Ready; past it the call fails as not_run.
 */
export const AGENT_UNREACHABLE_BOUND_MS = 60_000;
export const ROUTED_PAYLOAD_DIR = "/home/node/.acpx/routed";
export const ROUTED_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000;
export const SHARED_ROOTS = [
  "/workspace",
  "/wisdom",
  "/spaces",
  "/opt/atrium-os",
  "/home/node/.acpx",
] as const;

export const AGENT_EXEC_COMMAND = "agent-exec";

/** The caller-identity variables C2 lets travel — and only when an agent caused the call. */
export const CALLER_IDENTITY_VARS = [
  "ACPX_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
] as const;

export type RoutedClass = "owner-ensure" | "owner-if-pod" | "one-shot";

/** What the API server says about the session's pod (A5's death proof / a pod lookup answers this). */
export type AgentPodLookup = (key: string) => Promise<
  | {
      state: "exists";
      uid: string;
      ready: boolean;
      /** When the API server says the pod became Ready (epoch ms). Absent = unknown. */
      readyAtMs?: number;
    }
  | { state: "absent" }
  | { state: "unknown" }
>;

export type RoutedCallTarget = {
  sessionId: string;
  seat: string;
  harness: AgentHarness;
  /** Default `auto`. */
  placement?: AgentPlacement;
  /** The caller's admission class, as declared (`declaredAdmissionClass()`); absent = a person. */
  admissionClass?: string;
  sessionUrl?: string;
  sessionName?: string;
  brick?: string;
};

export type RoutedCallOptions = {
  class: RoutedClass;
  /** The target's key: `agentPodKey(sessionId)`, or `util-pool` / `util-home` for a one-shot. */
  key: string;
  target: RoutedCallTarget;
  /** acpx's arguments, executed in the pod. A function when the argv names the payload file. */
  argv: string[] | ((payloadPath: string | undefined) => string[]);
  cwd: string;
  /** A prompt's text or content blocks. */
  payload?: string | Uint8Array;
  /** The caller's own deadline — `one-shot` only. */
  deadlineMs?: number;
  /** Caller identity — set ONLY when an agent caused the call through the pass-through (C2). */
  callerIdentity?: Partial<Record<(typeof CALLER_IDENTITY_VARS)[number], string>>;
  /** The caller's environment: read for `ACPX_LOCKED_BY`, `PATH`, `HOME`; nothing else is forwarded. */
  env: NodeJS.ProcessEnv;
  /** `owner-ensure`: the release names of C9 (`resolveReleases`). */
  releases?: Record<string, string>;
  /** The API server's view of the pod. Required for `owner-ensure` and `owner-if-pod`. */
  lookup?: AgentPodLookup;
  /** `one-shot` only: the uid the caller expects (the pod's, from its lookup). */
  expectUid?: string;
  callId?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
  /** Test seams. */
  transportPath?: string;
  payloadDir?: string;
  broker?: Pick<BrokerClientOptions, "origin" | "fetchImpl" | "wakeBoundMs">;
};

export type RoutedCallResult =
  /** The command ran in the pod; its stdout/stderr were relayed; this is its exit code. */
  | { kind: "completed"; exitCode: number; callId: string }
  /** `owner-if-pod` and no pod: the caller answers from the record. Nothing was sent. */
  | { kind: "no_pod" };

/** The admission class → the broker's class (C4). `delivery` and a person are `interactive`. */
export function brokerClassOf(
  admissionClass: string | undefined,
  routed: RoutedClass,
): BrokerAgentClass {
  if (routed === "one-shot") {
    return "utility";
  }
  if (admissionClass === "spawn" || admissionClass === "automation") {
    return admissionClass;
  }
  return "interactive";
}

export function agentPodKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

export function isUnderSharedRoot(cwd: string): boolean {
  if (!path.isAbsolute(cwd)) {
    return false;
  }
  const normalized = path.posix.normalize(cwd);
  return SHARED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/**
 * The environment the transport process gets: EXACTLY the C2 per-call values that are the caller's
 * to give, plus what any process needs to run. `ACPX_ROUTED*` are never here (the transport sets
 * them from its flags); a caller's own copy of them, its secrets, its other settings, and its
 * identity (unless an agent caused the call) do not travel. The transport applies an allow-list
 * too — this is the first of two walls.
 */
export function buildTransportEnv(input: {
  env: NodeJS.ProcessEnv;
  admissionClass?: string;
  callerIdentity?: RoutedCallOptions["callerIdentity"];
}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined && value.length > 0) {
      out[name] = value;
    }
  };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME"] as const) {
    put(name, input.env[name]);
  }
  put("ACPX_ADMISSION_CLASS", input.admissionClass);
  put("ACPX_LOCKED_BY", input.env.ACPX_LOCKED_BY);
  for (const name of CALLER_IDENTITY_VARS) {
    put(name, input.callerIdentity?.[name]);
  }
  return out;
}

/** Sweeps payloads (and half-written temp files) older than one hour. Best effort, never throws. */
export function sweepRoutedPayloads(
  dir: string,
  nowMs: number,
  maxAgeMs = ROUTED_PAYLOAD_MAX_AGE_MS,
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/\.payload(\.tmp-\d+)?$/.test(name)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
      }
    } catch {
      // Gone already, or not ours to remove: either way not this call's problem.
    }
  }
}

/** Temp name, then rename; mode 0600 whatever the umask. */
export function writeRoutedPayload(
  dir: string,
  callId: string,
  content: string | Uint8Array,
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = path.join(dir, `${callId}.payload`);
  const temp = `${final}.tmp-${process.pid}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, final);
  return final;
}

const REFUSAL_LINE_RE = /^[\w.-]+: REFUSED reason=(\S+) command_not_run=true(?:\s|$)/;

/**
 * The transport's own refusals are told from the command's by exit code AND the first stderr line:
 * a pod-side `acpx: REFUSED reason=…` (exit 75) is the command's own and passes through.
 */
export function transportRefusalReason(
  exitCode: number,
  firstStderrLine: string,
): string | undefined {
  if (exitCode !== 64 && exitCode !== 69 && exitCode !== 75) {
    return undefined;
  }
  return REFUSAL_LINE_RE.exec(firstStderrLine)?.[1];
}

const STDERR_HOLD_LIMIT = 256 * 1024;

type TransportRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  /** stderr not yet written (everything, for the buffered classes). */
  heldStderr: Buffer;
  firstStderrLine: string;
};

function runTransport(input: {
  transportPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  holdAllStderr: boolean;
}): Promise<TransportRun> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(input.transportPath, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
        heldStderr: Buffer.alloc(0),
        firstStderrLine: "",
      });
      return;
    }
    let held: Buffer = Buffer.alloc(0);
    let streaming = false;
    let firstLine = "";
    let settled = false;
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = (
      ["SIGINT", "SIGTERM", "SIGHUP"] as const
    ).map((signal) => [signal, forward(signal)]);
    for (const [signal, handler] of handlers) {
      process.on(signal, handler);
    }
    const finish = (run: Omit<TransportRun, "heldStderr" | "firstStderrLine">) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      resolve({ ...run, heldStderr: held, firstStderrLine: firstLine });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      input.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (streaming) {
        input.stderr.write(chunk);
        return;
      }
      held = Buffer.concat([held, chunk]);
      if (firstLine === "" && held.includes(0x0a)) {
        firstLine = held.subarray(0, held.indexOf(0x0a)).toString("utf8");
      }
      const releaseAtFirstLine = !input.holdAllStderr && held.includes(0x0a);
      // Hold only until the first line is known (a transport refusal is one line), or — for the
      // short classes — until the call ends, so a first-line verdict can still go in front.
      if (
        held.length > STDERR_HOLD_LIMIT ||
        (releaseAtFirstLine && !isRefusalCandidate(firstLine))
      ) {
        input.stderr.write(held);
        held = Buffer.alloc(0);
        streaming = true;
      }
    });
    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      if (firstLine === "" && held.length > 0) {
        firstLine = held.toString("utf8").split("\n", 1)[0] ?? "";
      }
      finish({ exitCode: code, signal });
    });
  });
}

function isRefusalCandidate(firstLine: string): boolean {
  return REFUSAL_LINE_RE.test(firstLine);
}

type EnsuredPod = { uid: string; readyAtMs: number | undefined };

function brokerRequestOf(
  options: RoutedCallOptions,
  releases: Record<string, string>,
): BrokerAgentRequest {
  const { target } = options;
  return {
    contract: AGENT_BROKER_CONTRACT,
    sessionId: target.sessionId,
    seat: target.seat,
    harness: target.harness,
    placement: target.placement ?? "auto",
    class: brokerClassOf(target.admissionClass, options.class),
    releases,
    ...(target.sessionUrl ? { sessionUrl: target.sessionUrl } : {}),
    ...(target.sessionName ? { sessionName: target.sessionName } : {}),
    ...(target.brick ? { brick: target.brick } : {}),
  };
}

type BrokerContext = {
  brokerOptions: { origin: string; fetchImpl?: typeof fetch; wakeBoundMs: number };
  box: string;
  wake: string;
  callId: string;
};

/** The wake bound passed with the Job still on its way (C2 table: pod_starting, or agent_cap at the maximum). */
async function wakeBoundRefusal(phase: BrokerStep | undefined, ctx: BrokerContext): Promise<Error> {
  if (phase !== "pool-at-maximum") {
    return podStartingRefusal({ phase: phase ?? "scheduling", wake: ctx.wake });
  }
  const agents = await getAgents(ctx.brokerOptions);
  if (!agents.ok) {
    return admissionBusyRefusal();
  }
  return agentCapRefusal({
    live: agents.agents.live,
    cap: agents.agents.cap,
    box: ctx.box,
    why: "pool-at-maximum",
    wake: ctx.wake,
  });
}

function brokerRefusal(
  answer: Extract<BrokerEnsureResult, { kind: "refused" }>,
  ctx: BrokerContext,
): Error {
  if (answer.reason === "too_big") {
    // The pod cannot fit any machine: no wait heals it, so it is not a "retry later" refusal.
    return new RoutedCallError({
      outcome: "not_run",
      reason: "broker_too_big",
      callId: ctx.callId,
    });
  }
  const why: AgentCapWhy = answer.reason === "agent_cap" ? "cap" : answer.reason;
  return agentCapRefusal({ live: answer.live, cap: answer.cap, box: ctx.box, why, wake: ctx.wake });
}

async function brokerAnswerOutcome(
  answer: BrokerEnsureResult,
  ctx: BrokerContext,
  now: () => number,
): Promise<EnsuredPod> {
  if (answer.kind === "ready") {
    return { uid: answer.uid, readyAtMs: now() };
  }
  if (answer.kind === "refused") {
    throw brokerRefusal(answer, ctx);
  }
  if (answer.kind === "error") {
    const reason = `broker_${answer.reason.replace(/[^\w-]/g, "_")}`;
    throw new RoutedCallError({ outcome: "not_run", reason, callId: ctx.callId });
  }
  if (answer.kind === "unavailable") {
    throw admissionBusyRefusal();
  }
  throw await wakeBoundRefusal(answer.phase, ctx);
}

async function askBroker(
  options: RoutedCallOptions,
  callId: string,
  now: () => number,
): Promise<EnsuredPod> {
  const sources = readAgentBrokerOriginSources();
  const origin = options.broker?.origin ?? resolveAgentBrokerOrigin(options.env, sources);
  if (!origin) {
    throw admissionBusyRefusal();
  }
  if (!options.releases) {
    throw new RoutedCallError({ outcome: "not_run", reason: "releases_unresolved", callId });
  }
  const brokerOptions = {
    origin,
    fetchImpl: options.broker?.fetchImpl,
    wakeBoundMs: options.broker?.wakeBoundMs ?? WAKE_BOUND_MS,
  };
  const answer = await ensureAgentPod(
    options.key,
    brokerRequestOf(options, options.releases),
    brokerOptions,
  );
  const ctx: BrokerContext = {
    brokerOptions,
    box: boxOfNamespace(namespaceFromSources(sources)),
    wake: options.target.sessionId,
    callId,
  };
  return await brokerAnswerOutcome(answer, ctx, now);
}

/**
 * `owner-ensure` (C4): ask the broker only when the API server does not show a READY pod for the
 * key. Returns the pod's uid and when it became Ready, or throws the refusal the caller exits with.
 */
async function ensureOwnerPod(
  options: RoutedCallOptions,
  callId: string,
  now: () => number,
): Promise<EnsuredPod> {
  if (!options.lookup) {
    throw new Error("routed owner-ensure needs a pod lookup");
  }
  const found = await options.lookup(options.key);
  if (found.state === "unknown") {
    throw admissionBusyRefusal();
  }
  if (found.state === "exists" && found.ready) {
    return { uid: found.uid, readyAtMs: found.readyAtMs };
  }
  return await askBroker(options, callId, now);
}

/** The pod the call goes to, by class — or `no_pod` for `owner-if-pod` with none. */
async function resolvePod(
  options: RoutedCallOptions,
  callId: string,
  now: () => number,
): Promise<EnsuredPod | "no_pod"> {
  if (options.class === "owner-ensure") {
    return await ensureOwnerPod(options, callId, now);
  }
  if (options.class === "one-shot") {
    if (!options.expectUid) {
      throw new Error("a routed one-shot needs the pod's uid");
    }
    return { uid: options.expectUid, readyAtMs: undefined };
  }
  if (!options.lookup) {
    throw new Error("routed owner-if-pod needs a pod lookup");
  }
  const found = await options.lookup(options.key);
  if (found.state === "absent") {
    return "no_pod";
  }
  if (found.state === "unknown") {
    throw admissionBusyRefusal();
  }
  return { uid: found.uid, readyAtMs: found.readyAtMs };
}

function deadlineFor(options: RoutedCallOptions): number {
  const byClass: Record<RoutedClass, number | undefined> = {
    "owner-ensure": OWNER_ENSURE_DEADLINE_MS,
    "owner-if-pod": OWNER_IF_POD_DEADLINE_MS,
    "one-shot": options.deadlineMs,
  };
  const deadlineMs = byClass[options.class];
  if (deadlineMs === undefined || !(deadlineMs > 0)) {
    throw new Error("a routed one-shot needs its own deadline");
  }
  return deadlineMs;
}

function transportArgs(input: {
  key: string;
  callId: string;
  deadlineAtMs: number;
  expectUid: string;
  payloadPath: string | undefined;
  argv: string[];
}): string[] {
  return [
    "--key",
    input.key,
    "--call-id",
    input.callId,
    "--contract",
    String(ROUTED_CONTRACT_VERSION),
    "--deadline-ms",
    String(input.deadlineAtMs),
    "--expect-uid",
    input.expectUid,
    ...(input.payloadPath ? ["--payload", input.payloadPath] : []),
    "--",
    ...input.argv,
  ];
}

async function dispatch(
  options: RoutedCallOptions,
  pod: EnsuredPod,
  ctx: { callId: string; now: () => number; payloadPath: string | undefined },
): Promise<RoutedCallResult> {
  const stderr = options.stderr ?? process.stderr;
  const argv = typeof options.argv === "function" ? options.argv(ctx.payloadPath) : options.argv;
  const run = await runTransport({
    transportPath: options.transportPath ?? defaultTransportPath(options.env),
    args: transportArgs({
      key: options.key,
      callId: ctx.callId,
      deadlineAtMs: ctx.now() + deadlineFor(options),
      expectUid: pod.uid,
      payloadPath: ctx.payloadPath,
      argv,
    }),
    cwd: options.cwd,
    env: buildTransportEnv({
      env: options.env,
      admissionClass: options.target.admissionClass,
      callerIdentity: options.callerIdentity,
    }),
    stdout: options.stdout ?? process.stdout,
    stderr,
    holdAllStderr: options.class !== "one-shot",
  });
  return settle(run, {
    callId: ctx.callId,
    wake: options.target.sessionId,
    stderr,
    readyAtMs: pod.readyAtMs,
    nowMs: ctx.now(),
  });
}

/**
 * Runs one routed call. Resolves with the command's exit code once its output has been relayed, or
 * `no_pod` for an `owner-if-pod` call with no pod; THROWS the refusal (`CapacityRefusedError`,
 * exit 75) or `RoutedCallError` (exit 1) that C2's table makes of everything else.
 */
export async function runRoutedCall(options: RoutedCallOptions): Promise<RoutedCallResult> {
  const callId = options.callId ?? randomUUID();
  const now = options.now ?? Date.now;
  const payloadDir = options.payloadDir ?? ROUTED_PAYLOAD_DIR;

  if (!isUnderSharedRoot(options.cwd)) {
    throw new RoutedCallError({ outcome: "not_run", reason: "cwd_not_shared", callId });
  }
  const pod = await resolvePod(options, callId, now);
  if (pod === "no_pod") {
    return { kind: "no_pod" };
  }
  deadlineFor(options);

  sweepRoutedPayloads(payloadDir, now());
  let payloadPath: string | undefined;
  try {
    if (options.payload !== undefined) {
      payloadPath = writeRoutedPayload(payloadDir, callId, options.payload);
    }
    return await dispatch(options, pod, { callId, now, payloadPath });
  } finally {
    removeQuietly(payloadPath);
  }
}

function removeQuietly(file: string | undefined): void {
  if (!file) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // Already swept or never written.
  }
}

function defaultTransportPath(env: NodeJS.ProcessEnv): string {
  const seam = env.NODE_TEST_CONTEXT !== undefined ? env.ACPX_AGENT_EXEC?.trim() : undefined;
  return seam || AGENT_EXEC_COMMAND;
}

type SettleContext = {
  callId: string;
  wake: string;
  stderr: NodeJS.WritableStream;
  /** When this pod became Ready, if known; unknown counts as past the unreachable bound. */
  readyAtMs: number | undefined;
  nowMs: number;
};

/** The pod is ending, or its contract is older than the call needs (C2 table, row 4). */
function isTurnover(exitCode: number, reason: string): boolean {
  return (
    (exitCode === 75 && reason === "agent_ending") || (exitCode === 69 && reason === "contract")
  );
}

/** The transport refused before anything was sent: what C2's table makes of each reason. */
function refusalOutcome(exitCode: number, reason: string, ctx: SettleContext): Error {
  if (isTurnover(exitCode, reason)) {
    return podStartingRefusal({ phase: "turnover", wake: ctx.wake });
  }
  // C2 amendment: only within the bound counted from the pod's Ready; unknown Ready = past it.
  const insideBound =
    ctx.readyAtMs !== undefined && ctx.nowMs - ctx.readyAtMs <= AGENT_UNREACHABLE_BOUND_MS;
  if (exitCode === 75 && reason === "agent_unreachable" && insideBound) {
    return podStartingRefusal({ phase: "starting", wake: ctx.wake });
  }
  // 64 / 69 otherwise, and any reason C2 does not list: nothing ran, exit 1.
  return new RoutedCallError({ outcome: "not_run", reason, callId: ctx.callId });
}

/**
 * C2's outcome table. For an unknown outcome the command's partial stderr is dropped, not relayed:
 * the ROUTED line must be the first stderr line, which the atrium server reads.
 */
function settle(run: TransportRun, ctx: SettleContext): RoutedCallResult {
  const { callId } = ctx;
  if (run.spawnError !== undefined) {
    throw new RoutedCallError({ outcome: "not_run", reason: "transport_unavailable", callId });
  }
  // Killed by a signal after it started: the request may have been sent.
  const exitCode = run.exitCode ?? 255;
  const refusal = transportRefusalReason(exitCode, run.firstStderrLine);
  if (refusal !== undefined) {
    throw refusalOutcome(exitCode, refusal, ctx);
  }
  if (exitCode === 124 || exitCode === 255) {
    const reason = exitCode === 124 ? "deadline" : "connection";
    throw new RoutedCallError({ outcome: "unknown", reason, callId });
  }
  if (run.heldStderr.length > 0) {
    ctx.stderr.write(run.heldStderr);
  }
  return { kind: "completed", exitCode, callId };
}

/** C9: the release directory name each tool's link points to NOW. */
export const RELEASE_TOOLS_REQUIRED = [
  "acpx",
  "acpx-ui",
  "claude-agent-acp",
  "codex-acp",
  "claude-pty-acp",
  "pi",
  "pi-acp",
] as const;
export const RELEASE_TOOLS_OPTIONAL = ["pi-extensions"] as const;

export type ResolveReleasesResult =
  | { ok: true; releases: Record<string, string> }
  | { ok: false; tool: string };

/** `.releases/<tool>/<name>` (relative or absolute) → `<name>`; undefined for any other shape. */
function releaseNameOf(target: string, tool: string): string | undefined {
  const parts = target.split("/").filter((part) => part.length > 0);
  const name = parts.at(-1);
  const shaped = parts.at(-3) === ".releases" && parts.at(-2) === tool;
  return shaped ? name : undefined;
}

function readLinkOrUndefined(file: string): string | undefined {
  try {
    return fs.readlinkSync(file);
  } catch {
    return undefined;
  }
}

export function resolveReleases(runtimeDir = "/data/runtime"): ResolveReleasesResult {
  const releases: Record<string, string> = {};
  for (const tool of [...RELEASE_TOOLS_REQUIRED, ...RELEASE_TOOLS_OPTIONAL]) {
    const target = readLinkOrUndefined(path.join(runtimeDir, tool));
    if (target === undefined && (RELEASE_TOOLS_OPTIONAL as readonly string[]).includes(tool)) {
      continue;
    }
    const name = target === undefined ? undefined : releaseNameOf(target, tool);
    if (name === undefined) {
      return { ok: false, tool };
    }
    releases[tool] = name;
  }
  return { ok: true, releases };
}
