import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
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
  type BrokerAgentsResult,
  type BrokerClientOptions,
  WAKE_BOUND_MS,
} from "./broker-client.js";
import { CALLER_IDENTITY_VARS, type CallerIdentity } from "./caller-identity.js";
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

export { CALLER_IDENTITY_VARS };

export type RoutedClass = "owner-ensure" | "owner-if-pod" | "one-shot";

/** What the API server says about the session's pod (A5's death proof / a pod lookup answers this). */
export type AgentPodLookup = (key: string) => Promise<
  | {
      state: "exists";
      uid: string;
      ready: boolean;
      /**
       * The Ready condition's `lastTransitionTime` as the API server reports it (epoch ms); absent =
       * unknown. C2 amendment A-1: the `agent_unreachable` bound is counted from THIS, in every case
       * — a later call never saw the broker's `ready` line.
       */
      readyAtMs?: number;
      /** The pod's IP, when the API server gave it: the transport connects to it (`--address`). */
      ip?: string;
      /**
       * The pod's `runtime.nativai.de/releases` annotation, parsed (A-43 (b)). ABSENT = the pod has none or
       * it cannot be read — which counts as lacking every optional tool.
       */
      releases?: Record<string, string>;
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
  /** A function is evaluated only when the broker is about to be asked (it may read the box's base URL). */
  sessionUrl?: string | (() => string | undefined);
  sessionName?: string;
  brick?: string;
};

export type RoutedCallOptions = {
  class: RoutedClass;
  /** The target's key: `agentPodKey(sessionId)`, or `util-pool` / `util-home` for a one-shot. */
  key: string;
  target: RoutedCallTarget;
  /**
   * A-43: the AGENT the call is about is Pi although its target is a utility pod (a one-shot, a probe). Sessions
   * name Pi in `target.harness`; this is the one-shot's way to say it. See {@link needsPi}.
   */
  agentIsPi?: boolean;
  /** acpx's arguments, executed in the pod. A function when the argv names the payload file. */
  argv: string[] | ((payloadPath: string | undefined) => string[]);
  cwd: string;
  /** A prompt's text or content blocks. */
  payload?: string | Uint8Array;
  /** The caller's own deadline — `one-shot` only. */
  deadlineMs?: number;
  /**
   * `one-shot` only: when the caller's clock started — epoch ms on the same clock as `now` (`Date.now()` unless a
   * test injects one) — for a caller that did work BEFORE this call which must count against it: the utility
   * branch's capacity read (M1 F-B). Default: now. The deadline is `startedAtMs + deadlineMs`, and the broker's
   * wake bound is what is left of it after that work (`wakeBoundFor`), so the work before the call pushes
   * neither past its own bound.
   */
  startedAtMs?: number;
  /** Caller identity — set ONLY when an agent caused the call through the pass-through (C2). */
  callerIdentity?: CallerIdentity;
  /** The caller's environment: read for `ACPX_LOCKED_BY`, `PATH`, `HOME`; nothing else is forwarded. */
  env: NodeJS.ProcessEnv;
  /**
   * `owner-ensure`: C9's `releases`, as `resolveReleases()` answers. Default: resolved when the
   * broker is about to be asked. A required tool whose link cannot be resolved fails the call before
   * the broker is called (`ROUTED outcome=not_run reason=release_unresolved tool=<name>`).
   */
  releases?: ResolveReleasesResult;
  /** The API server's view of the pod. Required for `owner-ensure` and `owner-if-pod`. */
  lookup?: AgentPodLookup;
  /** `one-shot` only: the uid the caller expects (the pod's, from its lookup). */
  expectUid?: string;
  callId?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
  /**
   * Receives the partial stderr of a call whose outcome is unknown (it is dropped from the output
   * so the ROUTED line is first, never lost silently). Default: appended to `routed-calls.log`
   * beside the payload directory.
   */
  debug?: (entry: { callId: string; reason: string; stderr: string }) => void;
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

/**
 * The admission class → the broker's class (C4). Only a PERSON's action passes the reserve, so only
 * `interactive` (atrium: an authenticated human actor, or a person's wakeup trigger; acpx: no
 * declared class = a person at a terminal) maps to `interactive`. `delivery` is atrium's class for
 * an agent's, unattributed or unknown sender — the class atrium already turns into `spawn` for a
 * create (`sessionCreate.ts` createClass) — and `automation` is a system actor.
 * Evidence: reports/CLASS-MAPPING.md.
 */
export function brokerClassOf(
  admissionClass: string | undefined,
  routed: RoutedClass,
): BrokerAgentClass {
  if (routed === "one-shot") {
    return "utility";
  }
  if (admissionClass === "delivery") {
    return "spawn";
  }
  if (admissionClass === "spawn" || admissionClass === "automation") {
    return admissionClass;
  }
  return "interactive";
}

/**
 * A-7 / C4: the box's two utility pods, by the key of their routed-call address (`ag-util-pool`,
 * `ag-util-home`). Class `one-shot` may start these and NOTHING else; they belong to no session and
 * no seat (A-10).
 */
export const UTILITY_KEYS = ["util-pool", "util-home"] as const;
export type UtilityKey = (typeof UTILITY_KEYS)[number];

export function isUtilityKey(key: string): key is UtilityKey {
  return (UTILITY_KEYS as readonly string[]).includes(key);
}

/** The placement a utility pod's key names — never `auto` (a probe never waits for a new machine). */
export function utilityPlacementOf(key: string): AgentPlacement {
  if (!isUtilityKey(key)) {
    throw new UtilityScopeError(`key ${JSON.stringify(key)} is not a utility pod`);
  }
  return key === "util-pool" ? "pool" : "home";
}

/** The refusal of C1.2's A-7: a one-shot asked for anything but its utility pod — a programming error, nothing is sent. */
export class UtilityScopeError extends Error {
  constructor(what: string) {
    super(`A-7: class one-shot may start the box's utility pod and nothing else (${what})`);
    this.name = "UtilityScopeError";
  }
}

function assertUtilityTarget(options: RoutedCallOptions): void {
  if (options.target.harness !== "utility") {
    throw new UtilityScopeError(`harness ${options.target.harness}`);
  }
  utilityPlacementOf(options.key);
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
  const temp = `${final}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, final);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
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

type EnsuredPod = { uid: string; ip?: string };

function sessionUrlField(value: RoutedCallTarget["sessionUrl"]): { sessionUrl?: string } {
  const url = typeof value === "function" ? value() : value;
  return url ? { sessionUrl: url } : {};
}

/**
 * C7.2's `wake=<record id>`: the session whose message waits. A utility pod belongs to no session
 * (A-10), so its refusals carry no `wake` — a probe is not a message that stays queued.
 */
function wakeOf(options: RoutedCallOptions): string | undefined {
  return options.target.harness === "utility" ? undefined : options.target.sessionId;
}

function brokerRequestOf(
  options: RoutedCallOptions,
  releases: Record<string, string>,
): BrokerAgentRequest {
  const { target } = options;
  // A-10: a utility pod belongs to no session and no seat — neither field is sent.
  const owner =
    target.harness === "utility" ? {} : { sessionId: target.sessionId, seat: target.seat };
  return {
    contract: AGENT_BROKER_CONTRACT,
    ...owner,
    harness: target.harness,
    placement:
      target.harness === "utility" ? utilityPlacementOf(options.key) : (target.placement ?? "auto"),
    class: brokerClassOf(target.admissionClass, options.class),
    releases,
    ...sessionUrlField(target.sessionUrl),
    ...(target.sessionName ? { sessionName: target.sessionName } : {}),
    ...(target.brick ? { brick: target.brick } : {}),
  };
}

type BrokerContext = {
  /** The figures read started at `pool-at-maximum`, when it has settled; else undefined. */
  agents: () => BrokerAgentsResult | undefined;
  brokerOptions: { origin: string; fetchImpl?: typeof fetch; wakeBoundMs: number };
  box: string;
  wake: string | undefined;
  callId: string;
};

/**
 * The wake bound passed with the Job still on its way (C2 table: pod_starting, or agent_cap at the
 * maximum). `agents` is the `GET /v1/agents` read that was started when the broker first said
 * `pool-at-maximum` — it runs INSIDE the wake bound, so this path answers within the bound; an answer
 * that has not arrived by now counts as no answer.
 */
function wakeBoundRefusal(
  phase: BrokerStep | undefined,
  ctx: BrokerContext,
  agents: BrokerAgentsResult | undefined,
): Error {
  if (phase !== "pool-at-maximum") {
    return podStartingRefusal({ phase: phase ?? "scheduling", wake: ctx.wake });
  }
  if (!agents?.ok) {
    return admissionBusyRefusal({ utility: ctx.wake === undefined });
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
): Promise<EnsuredPod> {
  if (answer.kind === "ready") {
    return { uid: answer.uid, ip: answer.ip };
  }
  if (answer.kind === "refused") {
    throw brokerRefusal(answer, ctx);
  }
  if (answer.kind === "error" && answer.reason === "deleted") {
    // C4: the pod this POST was following was deleted by a concurrent DELETE (a close, a recover, the
    // A-16 rollback). NEVER retried here: atrium holds the delivery and re-drives it as a NEW call,
    // which meets the session as it then is.
    throw podStartingRefusal({ phase: "turnover", wake: ctx.wake });
  }
  if (answer.kind === "error") {
    const reason = `broker_${answer.reason.replace(/[^\w-]/g, "_")}`;
    throw new RoutedCallError({ outcome: "not_run", reason, callId: ctx.callId });
  }
  if (answer.kind === "unavailable") {
    throw admissionBusyRefusal({ utility: ctx.wake === undefined });
  }
  throw wakeBoundRefusal(answer.phase, ctx, ctx.agents());
}

/**
 * TEST SEAM, honoured ONLY under `node --test` (`NODE_TEST_CONTEXT`): a shorter wake bound for the
 * rows that hold a call at it. In production the bound is `WAKE_BOUND_MS` and nothing in the
 * environment moves it (held by test/pod-routed-branches.test.ts "seams…").
 */
function testWakeBoundMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.NODE_TEST_CONTEXT ? Number(env.ACPX_TEST_WAKE_BOUND_MS) : Number.NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** C9: the names to send, or the named failure that stops the call BEFORE the broker is called. */
function releasesOrFail(options: RoutedCallOptions, callId: string): Record<string, string> {
  const releases = options.releases ?? resolveReleases();
  if (!releases.ok) {
    throw new RoutedCallError({
      outcome: "not_run",
      reason: "release_unresolved",
      tool: releases.tool,
      callId,
    });
  }
  // A-46: a name that is not a release name never goes out, whoever resolved it — a bad pin fails HERE,
  // before the broker, not at the pod's start.
  const badTool = Object.entries(releases.releases).find(([, name]) => !isReleaseName(name))?.[0];
  if (badTool !== undefined) {
    throw new RoutedCallError({
      outcome: "not_run",
      reason: "release_unresolved",
      tool: badTool,
      callId,
    });
  }
  // A-41: `pi` is optional in `releases`, so a Pi session on a box without it is refused HERE — named,
  // before the broker — instead of getting a pod whose adapter cannot start. Claude and Codex are unaffected.
  if (needsPi(options) && releases.releases.pi === undefined) {
    throw piUnresolved(callId);
  }
  return releases.releases;
}

/** A-43 (a): a call whose AGENT is Pi — a Pi session, or a one-shot on the Pi harness — needs `pi` in the pod's releases. */
function needsPi(options: RoutedCallOptions): boolean {
  return options.target.harness === "pi" || options.agentIsPi === true;
}

/** A-43 (b): a Pi one-shot is not routed to a Ready utility pod whose releases annotation lacks `pi` (or cannot be read). */
function refuseReadyPodWithoutPi(
  options: RoutedCallOptions,
  releases: Record<string, string> | undefined,
  callId: string,
): void {
  if (options.class === "one-shot" && needsPi(options) && !isReleaseName(releases?.pi)) {
    throw piUnresolved(callId);
  }
}

/**
 * THE release-name grammar (C9, A-46): the entrypoint's rule (`runtime-links.sh`) plus a 128-character bound —
 * it starts with a letter or digit (so never `.`, `..` or a hidden name), has no path separator and no `+`,
 * and is never `previous`. A release name ends up in a path, so every place that reads or sends one asks THIS.
 * Every bootstrap name (`<sha>-<stamp>[-in-place]`) passes. An empty or odd value is NOT a release.
 */
export const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isReleaseName(value: string | undefined): value is string {
  return value !== undefined && RELEASE_NAME.test(value) && value !== "previous";
}

/** The one named line for a Pi call that cannot have `pi` (A-42/A-43): no new public reason. */
function piUnresolved(callId: string): RoutedCallError {
  return new RoutedCallError({
    outcome: "not_run",
    reason: "release_unresolved",
    tool: "pi",
    callId,
  });
}

/**
 * The wake bound of THIS call: the bound (`WAKE_BOUND_MS`, a seam's or the caller's) less the time the caller
 * already spent since `startedAtMs` — the utility branch's capacity read (M1 F-B fix round 2) — never below
 * zero. At zero the broker is not waited for, and the answer is the typed refusal a run-out bound gives today.
 * Without `startedAtMs` nothing is subtracted.
 */
function wakeBoundFor(options: RoutedCallOptions): number {
  const bound = options.broker?.wakeBoundMs ?? testWakeBoundMs(options.env) ?? WAKE_BOUND_MS;
  if (options.startedAtMs === undefined) {
    return bound;
  }
  return Math.max(0, bound - ((options.now ?? Date.now)() - options.startedAtMs));
}

async function askBroker(options: RoutedCallOptions, callId: string): Promise<EnsuredPod> {
  const releases = releasesOrFail(options, callId);
  const sources = readAgentBrokerOriginSources();
  const origin = options.broker?.origin ?? resolveAgentBrokerOrigin(options.env, sources);
  if (!origin) {
    throw admissionBusyRefusal({ utility: options.target.harness === "utility" });
  }
  const brokerOptions = {
    origin,
    fetchImpl: options.broker?.fetchImpl,
    wakeBoundMs: wakeBoundFor(options),
  };
  let agentsRead: BrokerAgentsResult | undefined;
  const answer = await ensureAgentPod(options.key, brokerRequestOf(options, releases), {
    ...brokerOptions,
    // Started WHEN the pool is at its maximum, in parallel with the rest of the wait: it must not
    // run after the wake bound (L-3).
    onStep: (step) => {
      if (step === "pool-at-maximum") {
        void getAgents(brokerOptions).then((result) => {
          agentsRead = result;
        });
      }
    },
  });
  const ctx: BrokerContext = {
    agents: () => agentsRead,
    brokerOptions,
    box: boxOfNamespace(namespaceFromSources(sources)),
    wake: wakeOf(options),
    callId,
  };
  return await brokerAnswerOutcome(answer, ctx);
}

/**
 * `owner-ensure` (C4): ask the broker only when the API server does not show a READY pod for the
 * key. Returns the pod's uid and when it became Ready, or throws the refusal the caller exits with.
 */
async function ensureOwnerPod(options: RoutedCallOptions, callId: string): Promise<EnsuredPod> {
  if (!options.lookup) {
    throw new Error("routed owner-ensure needs a pod lookup");
  }
  const found = await options.lookup(options.key);
  if (found.state === "unknown") {
    throw admissionBusyRefusal({ utility: options.target.harness === "utility" });
  }
  if (found.state === "exists" && found.ready) {
    // A-43 (b): a READY utility pod serves the key, so the broker is skipped and the release check in
    // `releasesOrFail` never runs. If that pod's annotation lacks `pi` (or cannot be read) a Pi call is not
    // routed to it. A session's own pod needs no such check: the pod is not replaced, its idle loop ends it.
    refuseReadyPodWithoutPi(options, found.releases, callId);
    return { uid: found.uid, ip: found.ip };
  }
  return await askBroker(options, callId);
}

/**
 * The classes that may START a pod: `owner-ensure` a session's, `one-shot` its utility pod (A-7) —
 * never the other's. Both ask the API server first and the broker only when it shows no ready pod.
 */
async function resolveEnsured(options: RoutedCallOptions, callId: string): Promise<EnsuredPod> {
  if (options.class === "one-shot") {
    assertUtilityTarget(options);
    return options.expectUid ? { uid: options.expectUid } : await ensureOwnerPod(options, callId);
  }
  // A utility pod belongs to no session: only a one-shot reaches it.
  if (options.target.harness === "utility" || isUtilityKey(options.key)) {
    throw new UtilityScopeError("owner-ensure asked for a utility pod");
  }
  return await ensureOwnerPod(options, callId);
}

/** The pod the call goes to, by class — or `no_pod` for `owner-if-pod` with none. */
async function resolvePod(
  options: RoutedCallOptions,
  callId: string,
): Promise<EnsuredPod | "no_pod"> {
  if (options.class !== "owner-if-pod") {
    return await resolveEnsured(options, callId);
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
  return { uid: found.uid, ip: found.ip };
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
  /** The pod's IP from the broker's `ready` line or the API server; anything but an IP is not passed. */
  address: string | undefined;
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
    ...(input.address !== undefined && isIP(input.address) !== 0
      ? ["--address", input.address]
      : []),
    ...(input.payloadPath ? ["--payload", input.payloadPath] : []),
    "--",
    ...input.argv,
  ];
}

async function dispatch(
  options: RoutedCallOptions,
  pod: EnsuredPod,
  ctx: {
    callId: string;
    now: () => number;
    payloadPath: string | undefined;
    /** C2 (stream HoD, 2026-11-21): the deadline counts from the CALL START, the broker POST included. */
    callStartMs: number;
    debug: NonNullable<RoutedCallOptions["debug"]>;
  },
): Promise<RoutedCallResult> {
  const stderr = options.stderr ?? process.stderr;
  const argv = typeof options.argv === "function" ? options.argv(ctx.payloadPath) : options.argv;
  const run = await runTransport({
    transportPath: options.transportPath ?? defaultTransportPath(options.env),
    args: transportArgs({
      key: options.key,
      callId: ctx.callId,
      deadlineAtMs: ctx.callStartMs + deadlineFor(options),
      expectUid: pod.uid,
      address: pod.ip,
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
  return await settle(run, {
    callId: ctx.callId,
    wake: wakeOf(options),
    stderr,
    readyAt: async () => {
      const found = await options.lookup?.(options.key);
      return found?.state === "exists" ? found.readyAtMs : undefined;
    },
    now: ctx.now,
    debug: ctx.debug,
  });
}

/** The deadline's start: the caller's own clock start when it gave one (`startedAtMs`), else now. */
function callStartOf(options: RoutedCallOptions, now: () => number): number {
  return options.startedAtMs ?? now();
}

/**
 * Runs one routed call. Resolves with the command's exit code once its output has been relayed, or
 * `no_pod` for an `owner-if-pod` call with no pod; THROWS the refusal (`CapacityRefusedError`,
 * exit 75) or `RoutedCallError` (exit 1) that C2's table makes of everything else.
 */
export async function runRoutedCall(options: RoutedCallOptions): Promise<RoutedCallResult> {
  const callId = options.callId ?? randomUUID();
  const now = options.now ?? Date.now;
  const callStartMs = callStartOf(options, now);
  const payloadDir = options.payloadDir ?? ROUTED_PAYLOAD_DIR;

  if (!isUnderSharedRoot(options.cwd)) {
    throw new RoutedCallError({ outcome: "not_run", reason: "cwd_not_shared", callId });
  }
  const pod = await resolvePod(options, callId);
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
    const debug =
      options.debug ?? appendDroppedStderr(path.join(path.dirname(payloadDir), "routed-calls.log"));
    return await dispatch(options, pod, { callId, now, payloadPath, callStartMs, debug });
  } finally {
    removeQuietly(payloadPath);
  }
}

/** The default debug sink: one JSON line per call whose partial stderr was dropped. Best effort. */
function appendDroppedStderr(file: string): NonNullable<RoutedCallOptions["debug"]> {
  return (entry) => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        call_id: entry.callId,
        reason: entry.reason,
        dropped_stderr: entry.stderr.slice(0, 8192),
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // A debug log that cannot be written must not change the call's outcome.
    }
  };
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
  wake: string | undefined;
  stderr: NodeJS.WritableStream;
  /**
   * When this pod became Ready, read from the API server on demand (only a transport
   * `agent_unreachable` asks); unknown counts as past the unreachable bound.
   */
  readyAt: () => Promise<number | undefined>;
  now: () => number;
  debug: NonNullable<RoutedCallOptions["debug"]>;
};

/** The pod is ending, or its contract is older than the call needs (C2 table, row 4). */
function isTurnover(exitCode: number, reason: string): boolean {
  return (
    (exitCode === 75 && reason === "agent_ending") || (exitCode === 69 && reason === "contract")
  );
}

/** The transport refused before anything was sent: what C2's table makes of each reason. */
async function refusalOutcome(
  exitCode: number,
  reason: string,
  ctx: SettleContext,
): Promise<Error> {
  if (isTurnover(exitCode, reason)) {
    return podStartingRefusal({ phase: "turnover", wake: ctx.wake });
  }
  // C2 amendment A-1: only within the bound counted from the pod's Ready condition; unknown = past it.
  // No pod is ever deleted because it cannot be reached.
  if (exitCode === 75 && reason === "agent_unreachable") {
    const readyAtMs = await ctx.readyAt();
    if (readyAtMs !== undefined && ctx.now() - readyAtMs <= AGENT_UNREACHABLE_BOUND_MS) {
      return podStartingRefusal({ phase: "starting", wake: ctx.wake });
    }
  }
  // 64 / 69 otherwise, and any reason C2 does not list: nothing ran, exit 1.
  return new RoutedCallError({ outcome: "not_run", reason, callId: ctx.callId });
}

/** 124 / 255: the request may have run. The command's partial stderr goes to the debug sink. */
function unknownOutcome(run: TransportRun, exitCode: number, ctx: SettleContext): Error {
  const reason = exitCode === 124 ? "deadline" : "connection";
  if (run.heldStderr.length > 0) {
    ctx.debug({ callId: ctx.callId, reason, stderr: run.heldStderr.toString("utf8") });
  }
  return new RoutedCallError({ outcome: "unknown", reason, callId: ctx.callId });
}

/**
 * C2's outcome table. For an unknown outcome the command's partial stderr is dropped from the
 * output, not relayed: the atrium server finds the `acpx: ROUTED ` token by its head and exit code (A-53), and
 * a half-run command's own stderr would only bury it.
 */
async function settle(run: TransportRun, ctx: SettleContext): Promise<RoutedCallResult> {
  if (run.spawnError !== undefined) {
    throw new RoutedCallError({
      outcome: "not_run",
      reason: "transport_unavailable",
      callId: ctx.callId,
    });
  }
  // Killed by a signal after it started: the request may have been sent.
  const exitCode = run.exitCode ?? 255;
  const refusal = transportRefusalReason(exitCode, run.firstStderrLine);
  if (refusal !== undefined) {
    throw await refusalOutcome(exitCode, refusal, ctx);
  }
  if (exitCode === 124 || exitCode === 255) {
    throw unknownOutcome(run, exitCode, ctx);
  }
  if (run.heldStderr.length > 0) {
    ctx.stderr.write(run.heldStderr);
  }
  return { kind: "completed", exitCode, callId: ctx.callId };
}

/**
 * C9: the release directory name each tool's link points to NOW. The required / optional split is
 * `runtime-links.sh`'s `LINKS` table (stream HoD, agreed with infra; A-12, A-40, A-41): a tool marked
 * `optional` there — `pi-extensions`, `pi` and `claude-pty-acp` — is named when its control-pod link
 * resolves and is release-shaped, and OMITTED when the link is absent; a PRESENT link that is not
 * release-shaped still fails the call, like a required tool's. A required tool that cannot be resolved
 * fails the call before the broker is asked.
 *
 * ⚠️ THE OPTIONAL SET IS HELD IN THREE COPIES THAT MUST AGREE (A-40): the link table's `optional` rows
 * (the source), the broker's `OPTIONAL_RELEASE_TOOLS` and this one. A box may lack an optional tool's
 * release only once all three carry it. `test/pod-routed-call.test.ts` ("the three copies") compares this
 * one with the fake broker kit's.
 */
export const RELEASE_TOOLS_REQUIRED = [
  "acpx",
  "acpx-ui",
  "claude-agent-acp",
  "codex-acp",
  "pi-acp",
] as const;
// `pi-home` is not a release tool and is never sent. `claude-pty-acp` is optional, NOT dropped (A-40):
// since A-39 no pod runs the terminal harness, but a failed build of its retired repo must not fail every
// owner-ensure on the box, and a revival would otherwise have to undo a drop in three places.
export const RELEASE_TOOLS_OPTIONAL = ["pi-extensions", "pi", "claude-pty-acp"] as const;

export type ResolveReleasesResult =
  | { ok: true; releases: Record<string, string> }
  | { ok: false; tool: string };

/** `.releases/<tool>/<name>` (relative or absolute) → `<name>`; undefined for any other shape. */
export function releaseNameOf(target: string, tool: string): string | undefined {
  const parts = target.split("/").filter((part) => part.length > 0);
  const name = parts.at(-1);
  const shaped = parts.at(-3) === ".releases" && parts.at(-2) === tool;
  return shaped && isReleaseName(name) ? name : undefined;
}

/** The link's target; `null` when NOTHING is there (ENOENT); `undefined` when something is there that cannot be read as a link. */
function readLinkOrUndefined(file: string): string | null | undefined {
  try {
    return fs.readlinkSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

export function resolveReleases(runtimeDir = "/data/runtime"): ResolveReleasesResult {
  const releases: Record<string, string> = {};
  for (const tool of [...RELEASE_TOOLS_REQUIRED, ...RELEASE_TOOLS_OPTIONAL]) {
    const target = readLinkOrUndefined(path.join(runtimeDir, tool));
    // An optional tool is omitted only when its link is ABSENT; a present one that is not release-shaped
    // (a directory, a foreign link) fails like a required tool's (A-40).
    if (target === null && (RELEASE_TOOLS_OPTIONAL as readonly string[]).includes(tool)) {
      continue;
    }
    const name = typeof target === "string" ? releaseNameOf(target, tool) : undefined;
    if (name === undefined) {
      return { ok: false, tool };
    }
    releases[tool] = name;
  }
  return { ok: true, releases };
}
