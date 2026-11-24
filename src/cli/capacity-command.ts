import { type Command, InvalidArgumentError, Option } from "commander";
import {
  admitWake,
  cpuRefuses,
  readPendingReservationsForProbe,
  readWaitingForProbe,
  type WakeDecision,
} from "../capacity/admission.js";
import { BUILD_CONSTANTS, type Harness, HARNESSES, isHarness, MIB } from "../capacity/constants.js";
import { governorLivenessLine } from "../capacity/governor/status.js";
import {
  type AdmissionLockState,
  admissionDir,
  readAdmissionLockState,
} from "../capacity/ledger.js";
import {
  type CapacityClass,
  type CapacitySnapshot,
  ACPX_FEATURES,
  capacitySourcesFromEnv,
  needMet,
  needMetReason,
  readCapacity,
} from "../capacity/reading.js";
import { type RunBuildResult, runBuild } from "../capacity/run-build.js";
import type { BrokerAgentsSnapshot } from "../pod/broker-client.js";
import {
  isControlPlaneInPodMode,
  podCapacitySnapshot,
  podNeedMet,
  podNeedReason,
  podRoom,
  renderPodCapacityLines,
  type PodCapacitySnapshot,
  readAgentsFigures,
  type PodRoom,
} from "../pod/pod-capacity.js";
import { withHoldPromise } from "../pod/pod-refusal.js";
import { EXIT_CODES, type OutputFormat } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import { ownerMayBeRunning, wakeRequestFor } from "./session/wake-gate.js";

/**
 * `acpx capacity [--agent claude|codex|pi] [--need N] [--class spawn|automation]` — how many more
 * agent sessions fit in THIS box's control-pod memory (CONCEPTION f7587c86 §8.1). Read-only. It
 * reads the admission ledger the create gate writes, so creates in flight show as `pendingBytes` /
 * `owners.starting`, and the gate (`capacity/admission.ts`) admits exactly when `--need 1` here is
 * met for the same class.
 *
 * `--class` (CONCEPTION e8abe1e8 §3.2.4): `spawn` (default — an agent's view) reports slots net of
 * the automation sessions queued for room; `automation` (atrium's drainer probe) reports them gross.
 * Both list what waits (`waiting` in JSON, one `waiting:` line in text).
 *
 * Exit 0 on a successful reading (with `--need N`: at least N slots for `--agent`), 75 when
 * `--need N` is not met, 2 on usage, 1 on an internal error. An unconfigured or unmeasured box
 * exits 0 — fail open.
 */

type CapacityFlags = {
  agent?: Harness;
  need?: number;
  class?: CapacityClass;
  /** `--need-build` (CONCEPTION 25479d40 §5.1): exit 0 when `build.fits`, else 75. */
  needBuild?: boolean;
};

const CLASSES: readonly CapacityClass[] = ["spawn", "automation"];

function parseClass(value: string): CapacityClass {
  const trimmed = value.trim();
  if (!(CLASSES as readonly string[]).includes(trimmed)) {
    throw new InvalidArgumentError(`Expected one of: ${CLASSES.join(", ")}`);
  }
  return trimmed as CapacityClass;
}

function parseAgent(value: string): Harness {
  if (!isHarness(value)) {
    throw new InvalidArgumentError(`Expected one of: ${HARNESSES.join(", ")}`);
  }
  return value;
}

function parseNeed(value: string): number {
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return Number(value.trim());
}

const gib = (bytes: number): string => `${(bytes / (1024 * MIB)).toFixed(2)} GiB`;
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function headLine(s: CapacitySnapshot): string {
  const head = [s.box];
  if (s.verdict === "unconfigured") {
    head.push("UNCONFIGURED (no /etc/podinfo) — nothing is refused");
  } else {
    head.push(
      s.budgetBytes === null ? `basis ${s.basis}` : `budget ${gib(s.budgetBytes)} (${s.basis})`,
    );
  }
  if (s.requestBytes !== null) {
    head.push(`request ${gib(s.requestBytes)}`);
  }
  if (s.limitBytes !== null) {
    head.push(`limit ${gib(s.limitBytes)}`);
  }
  return head.join(" · ");
}

function slotLine(s: CapacitySnapshot, free: number, interactive: number): string {
  const agent = s.agent;
  const label = s.verdict === "unconfigured" ? "would fit" : s.verdict;
  return (
    `${label}: ${plural(free, `new ${agent} session`)} (${mib(s.reserveNewBytes[agent])} reserved ` +
    `each; +${Math.max(0, interactive - free)} kept for humans; bound by ` +
    `${s.bindingGuard?.[agent] ?? "?"})`
  );
}

const yours = (s: CapacitySnapshot): string =>
  s.owners.trees.some((tree) => tree.self) ? " (one is yours)" : "";

function chargeLine(s: CapacitySnapshot, charged: number, base: number): string {
  const ownerCharge = s.owners.trees.reduce((sum, tree) => sum + tree.chargedBytes, 0);
  const workingSet = s.workingSetBytes === null ? "" : ` · working set ${gib(s.workingSetBytes)}`;
  // A release build's reservation is in `pendingBytes` but never in `owners.starting` (R12).
  const buildCharge = s.build.holder?.chargedBytes ?? 0;
  const starting =
    s.owners.starting > 0
      ? ` + ${s.owners.starting} starting ${gib(s.pendingBytes - buildCharge)}`
      : "";
  const build = s.build.holder ? ` + release build ${gib(buildCharge)}` : "";
  return (
    `charged ${gib(charged)} = base ${gib(base)} + ${plural(s.owners.live, "owner")}${yours(s)} ` +
    `${gib(ownerCharge)}${starting}${build} · committed ${gib(s.committedBytes ?? 0)} (anon + kernel) · margin ` +
    `${gib(s.marginBytes ?? 0)}${workingSet}`
  );
}

function slotLines(s: CapacitySnapshot): string[] {
  if (!s.freeSlots || !s.freeSlotsInteractive || s.chargedBytes === null || s.baseBytes === null) {
    return [`${s.verdict}: no slot figure (see warnings) — nothing is refused`];
  }
  return [
    slotLine(s, s.freeSlots[s.agent], s.freeSlotsInteractive[s.agent]),
    chargeLine(s, s.chargedBytes, s.baseBytes),
  ];
}

/** `14:05Z` today (UTC), else `2026-10-30 23:58Z`; the raw value when it is not a date. */
function sinceLabel(since: string, now: Date): string {
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) {
    return since || "?";
  }
  const iso = at.toISOString();
  const time = `${iso.slice(11, 16)}Z`;
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? time : `${iso.slice(0, 10)} ${time}`;
}

const SHOWN_ITEMS = 5;

function itemLabel(item: CapacitySnapshot["waiting"]["items"][number]): string {
  if (item.kind === "delivery") {
    // atrium's label: `<sender seat> → <recipient seat>`, or `<N> messages → <recipient seat>`.
    return item.label || `messages → ${item.ref.slice(0, 8)}`;
  }
  if (item.kind === "wakeup") {
    return `wakeup ${item.label || item.ref}`;
  }
  if (item.kind === "trigger-run") {
    const label = item.label ? ` "${item.label}"` : "";
    return `brick run ${item.ref.slice(0, 6)}…${label}`;
  }
  return `${item.kind} ${item.label || item.ref}`;
}

/**
 * One line while anything waits for room — agent-facing wording (CONCEPTION e8abe1e8 §12.3; A1 §8:
 * held messages wait too, one item per session that needs waking, so the count is ITEMS).
 */
export function waitingLine(
  s: Pick<CapacitySnapshot, "waiting" | "class">,
  now: Date = new Date(),
): string | undefined {
  const { count, items } = s.waiting;
  if (count === 0) {
    return undefined;
  }
  const shown = items.slice(0, SHOWN_ITEMS).map(itemLabel);
  if (count > SHOWN_ITEMS) {
    shown.push(`+${count - SHOWN_ITEMS} more`);
  }
  const effect =
    s.class === "spawn"
      ? "atrium wakes them oldest first as room frees, each with everything waiting for it; the slots above already leave room for them"
      : "class automation: the slots above are gross, the queue orders itself";
  return (
    `waiting: ${count} queued for room since ` +
    `${sinceLabel(items[0]?.since ?? "", now)} (${shown.join(", ")}) — ${effect}`
  );
}

function pressureLine(s: CapacitySnapshot): string {
  const p = s.pressure;
  const parts: Array<string | undefined> = [
    p.psiFullAvg10 === null ? "PSI unreadable" : `pressure PSI full ${p.psiFullAvg10.toFixed(2)}`,
    p.nodeAvailableBytes === null
      ? undefined
      : `node available ${gib(p.nodeAvailableBytes)} (shared)`,
    p.cpuPsiSomeAvg10 === null ? undefined : `cpu PSI some ${p.cpuPsiSomeAvg10.toFixed(2)}`,
    p.nodeLoad1 === null ? undefined : `node load1 ${p.nodeLoad1.toFixed(2)}`,
    p.oomKillsSinceContainerStart === null
      ? undefined
      : `oom kills since container start ${p.oomKillsSinceContainerStart}`,
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
}

/**
 * `release build: …` (CONCEPTION 25479d40 §5.1): whether a release build fits now, and the one that
 * holds the reservation, if any.
 */
export function buildLine(s: CapacitySnapshot, now: Date = new Date()): string {
  const holder = s.build.holder;
  if (holder === null) {
    return `release build: ${s.build.reason}`;
  }
  const what = holder.phase === "building" ? "running" : "waiting for room";
  const pids = holder.buildPid === null ? `pid ${holder.pid}` : `build pid ${holder.buildPid}`;
  return (
    `release build: ${what} since ${sinceLabel(holder.since, now)} (${pids}; ` +
    `${gib(holder.chargedBytes)} of ${gib(holder.bytes)} still reserved) — another would: ${s.build.reason}`
  );
}

/** G5's state in one line; `busy` only warns, `saturated` says what is refused. */
export function cpuLine(s: CapacitySnapshot): string {
  const { cpu } = s;
  const pct = (value: number | null): string => (value === null ? "?" : `${Math.round(value)} %`);
  const figures = `some avg60 ${pct(cpu.someAvg60)}, avg300 ${pct(cpu.someAvg300)}; ${plural(cpu.cpus, "CPU")}`;
  if (cpu.state === "saturated") {
    const effect = cpu.refusesAgentCreates
      ? "new agent sessions are refused until it eases"
      : "not enforced on this box";
    return `cpu: saturated (${figures}) — ${effect}`;
  }
  return cpu.state === "busy"
    ? `cpu: busy (${figures}) — warning only; new agent sessions are still admitted`
    : `cpu: ok (${figures})`;
}

export function renderCapacityText(s: CapacitySnapshot): string {
  const waiting = waitingLine(s);
  const lines = [
    headLine(s),
    ...slotLines(s),
    ...(waiting ? [waiting] : []),
    buildLine(s),
    pressureLine(s),
    cpuLine(s),
    ...s.alternatives.map(
      (alt) =>
        `on the ${alt.basis} basis: budget ${gib(alt.budgetBytes)} → ` +
        plural(alt.freeSlots[s.agent], `new ${s.agent} session`),
    ),
    ...s.warnings.map((warning) => `⚠ ${warning}`),
    governorLivenessLine(s.governor, Date.parse(s.measuredAt)),
  ];
  return `${lines.join("\n")}\n`;
}

type NeedVerdict = { readonly met: boolean; readonly reason: string };

/**
 * `--need N` (TE defect D2, HoD decision P rev 2): a busy admission lock means a create starting now
 * is refused `admission_busy`, so the probe says NOT MET too — for every class, because "the probe
 * and an admitted create cannot disagree" is class-free. Except on an UNCONFIGURED box, whose gate
 * never takes the lock (`admission.ts`) and so is never refused for it.
 */
function needVerdict(
  snapshot: CapacitySnapshot,
  need: number,
  lock: AdmissionLockState,
): NeedVerdict {
  if (lock.busy && snapshot.verdict !== "unconfigured") {
    return {
      met: false,
      reason:
        `admission_busy: the box's admission lock is held by a live process, so creates are ` +
        `refused until it frees; retry after ${lock.retryAfterS ?? "?"} s`,
    };
  }
  if (needMet(snapshot, need) && cpuRefuses(snapshot)) {
    // G5 mirrors the create gate: only class `spawn` (an agent's fan-out probe), never atrium's
    // `--class automation` release probe (`cpuRefuses`).
    return {
      met: false,
      reason:
        `cpu_pressure: the box's CPU is saturated (some avg60 ${snapshot.cpu.someAvg60 ?? "?"} %, ` +
        `avg300 ${snapshot.cpu.someAvg300 ?? "?"} %), so a new agent session is refused; ` +
        `retry after 120 s`,
    };
  }
  return { met: needMet(snapshot, need), reason: needMetReason(snapshot, need) };
}

function lockLine(lock: AdmissionLockState): string | undefined {
  return lock.busy
    ? `admission lock: BUSY — held by a live process for 5 s or more; creates are refused admission_busy until it frees (retry after ${lock.retryAfterS ?? "?"} s)`
    : undefined;
}

type NeedRequest = { readonly need: number; readonly verdict: NeedVerdict };

/** `--need-build`: `build.fits`, with the build line's own reason (§5.1). */
function needBuildVerdict(snapshot: CapacitySnapshot): NeedVerdict {
  return { met: snapshot.build.fits, reason: snapshot.build.reason };
}

function writeCapacityText(
  snapshot: CapacitySnapshot,
  lock: AdmissionLockState,
  request: NeedRequest | undefined,
  buildRequest: NeedVerdict | undefined,
): void {
  process.stdout.write(renderCapacityText(snapshot));
  const busyLine = lockLine(lock);
  if (busyLine) {
    process.stdout.write(`${busyLine}\n`);
  }
  if (request) {
    const label = request.verdict.met ? "met (exit 0)" : "NOT MET (exit 75)";
    process.stdout.write(
      `need ${plural(request.need, `${snapshot.agent} slot`)}: ${label} — ${request.verdict.reason}\n`,
    );
  }
  if (buildRequest) {
    const label = buildRequest.met ? "met (exit 0)" : "NOT MET (exit 75)";
    process.stdout.write(`need build: ${label} — ${buildRequest.reason}\n`);
  }
}

/** The answer's JSON: its body plus the verdicts of `--need` and `--need-build`, when asked for. */
function withVerdicts(
  body: Record<string, unknown>,
  request: NeedRequest | undefined,
  buildRequest: NeedVerdict | undefined,
): Record<string, unknown> {
  const withNeed = request
    ? {
        ...body,
        need: request.need,
        needMet: request.verdict.met,
        needMetReason: request.verdict.reason,
      }
    : body;
  return buildRequest
    ? {
        ...withNeed,
        needBuild: true,
        needBuildMet: buildRequest.met,
        needBuildReason: buildRequest.reason,
      }
    : withNeed;
}

function writeCapacity(
  format: OutputFormat,
  snapshot: CapacitySnapshot,
  lock: AdmissionLockState,
  request: NeedRequest | undefined,
  buildRequest: NeedVerdict | undefined,
): void {
  const json = withVerdicts({ ...snapshot, admissionLock: lock }, request, buildRequest);
  if (emitJsonResult(format, json)) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${snapshot.slotsAfterMakeRoom?.[snapshot.agent] ?? snapshot.verdict}\n`);
    return;
  }
  writeCapacityText(snapshot, lock, request, buildRequest);
}

// ── pod mode (block A9, C7.3): the verbs answer from the broker's `GET /v1/agents` ─────────────────

type PodAnswer = {
  readonly body: Record<string, unknown>;
  readonly text: string[];
  readonly need: NeedRequest | undefined;
  readonly buildRequest: NeedVerdict | undefined;
};

/** The local reading, for `--need-build` alone: a release build runs on the control pod. */
function localBuildSnapshot(agent: Harness): CapacitySnapshot {
  return readCapacity({ agent, sources: capacitySourcesFromEnv() });
}

/**
 * The broker did not answer. The verb still ANSWERS, with `pod.available: false` — atrium reads the
 * `features` of every `capacity` answer (a field-less one reads "no features" and stops delivering
 * forks at a cut, `ACPX_FEATURES`), so an outage must not take them away. `--need` then holds: exit 75,
 * `needMetReason` beginning `admission_busy:` (the form atrium's probe already reads for a busy lock);
 * a plain `capacity` exits 0, as an unconfigured box does, with a warning.
 */
function podUnavailable(
  flags: CapacityFlags,
  figures: { box: string; detail: string },
  waiting: CapacitySnapshot["waiting"],
): PodAnswer {
  const warning = `the broker did not answer (${figures.detail}); the room for a pod cannot be read`;
  const reason = `admission_busy: ${warning}; retry after 5 s`;
  return {
    body: {
      action: "capacity",
      schema: 1,
      features: ACPX_FEATURES,
      box: figures.box,
      class: flags.class ?? "spawn",
      agent: flags.agent ?? "claude",
      basis: "pod",
      waiting,
      measuredAt: new Date().toISOString(),
      pod: { available: false, detail: figures.detail },
      warnings: [warning],
    },
    text: [`${figures.box} · pod plane: ⚠ ${warning}`],
    need:
      flags.need === undefined ? undefined : { need: flags.need, verdict: { met: false, reason } },
    buildRequest: undefined,
  };
}

/** `--need N` against the broker's room: met when that many new sessions of the harness fit. */
function podNeedOf(
  need: number | undefined,
  agents: BrokerAgentsSnapshot,
  agent: Harness,
  room: PodRoom,
): NeedRequest | undefined {
  return need === undefined
    ? undefined
    : {
        need,
        verdict: { met: podNeedMet(room, need), reason: podNeedReason(agents, agent, need, room) },
      };
}

function podTextOf(snapshot: PodCapacitySnapshot): string[] {
  const waiting = waitingLine(snapshot);
  return [...renderPodCapacityLines(snapshot), ...(waiting === undefined ? [] : [waiting])];
}

async function podAnswerFor(flags: CapacityFlags): Promise<PodAnswer> {
  const agent = flags.agent ?? "claude";
  const admissionClass = flags.class ?? "spawn";
  const waiting = readWaitingForProbe();
  const figures = await readAgentsFigures();
  if (!figures.ok) {
    return podUnavailable(flags, figures, waiting);
  }
  const snapshot = podCapacitySnapshot({
    agents: figures.agents,
    box: figures.box,
    agent,
    admissionClass,
    waiting,
  });
  const room = podRoom(figures.agents, {
    harness: agent,
    admissionClass,
    waitingCount: waiting.count,
  });
  // `--need-build` stays local: a release build runs on the control pod (the broker knows nothing of it).
  const build = flags.needBuild ? localBuildSnapshot(agent).build : undefined;
  return {
    body: build ? { ...snapshot, build } : snapshot,
    text: podTextOf(snapshot),
    need: podNeedOf(flags.need, figures.agents, agent, room),
    buildRequest: build ? { met: build.fits, reason: build.reason } : undefined,
  };
}

/** The `need …: met|NOT MET` lines of the text answer. */
function verdictLines(
  agent: Harness,
  need: NeedRequest | undefined,
  buildRequest: NeedVerdict | undefined,
): string[] {
  const label = (met: boolean) => (met ? "met (exit 0)" : "NOT MET (exit 75)");
  return [
    ...(need
      ? [
          `need ${plural(need.need, `${agent} slot`)}: ${label(need.verdict.met)} — ${need.verdict.reason}`,
        ]
      : []),
    ...(buildRequest ? [`need build: ${label(buildRequest.met)} — ${buildRequest.reason}`] : []),
  ];
}

function writePodCapacity(format: OutputFormat, answer: PodAnswer, agent: Harness): void {
  const { need, buildRequest } = answer;
  if (emitJsonResult(format, withVerdicts(answer.body, need, buildRequest))) {
    return;
  }
  if (format === "quiet") {
    const slots = (answer.body as Partial<PodCapacitySnapshot>).slotsAfterMakeRoom?.[agent];
    process.stdout.write(`${slots ?? "unavailable"}\n`);
    return;
  }
  process.stdout.write(
    `${[...answer.text, ...verdictLines(agent, need, buildRequest)].join("\n")}\n`,
  );
}

async function handlePodCapacity(
  flags: CapacityFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const answer = await podAnswerFor(flags);
  writePodCapacity(format, answer, flags.agent ?? "claude");
  if (!allMet([answer.need?.verdict, answer.buildRequest])) {
    process.exitCode = EXIT_CODES.CAPACITY;
  }
}

async function handleCapacity(
  flags: CapacityFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  if (isControlPlaneInPodMode()) {
    await handlePodCapacity(flags, command, config);
    return;
  }
  const { format } = resolveGlobalFlags(command, config);
  const snapshot = readCapacity({
    agent: flags.agent ?? "claude",
    sources: capacitySourcesFromEnv(),
    pending: await readPendingReservationsForProbe(),
    waiting: readWaitingForProbe(),
    admissionClass: flags.class ?? "spawn",
  });
  const lock = readAdmissionLockState(admissionDir());
  const request =
    flags.need === undefined
      ? undefined
      : { need: flags.need, verdict: needVerdict(snapshot, flags.need, lock) };
  const buildRequest = flags.needBuild ? needBuildVerdict(snapshot) : undefined;
  writeCapacity(format, snapshot, lock, request, buildRequest);
  if (!allMet([request?.verdict, buildRequest])) {
    process.exitCode = EXIT_CODES.CAPACITY;
  }
}

/** `--need N` and `--need-build` together: exit 75 when either asked-for verdict is not met. */
function allMet(verdicts: ReadonlyArray<NeedVerdict | undefined>): boolean {
  return verdicts.every((verdict) => verdict === undefined || verdict.met);
}

/**
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS: this one, and `"capacity"` in
 * `TOP_LEVEL_VERBS` (`src/cli-core.ts`). Without the second, `acpx capacity` is absorbed as an
 * AGENT NAME and, in a session-bearing cwd, the rest of the line becomes a prompt delivery.
 */
export function registerCapacityCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const capacity = parent
    .command("capacity")
    .description(
      "How many more agent sessions fit in this box's control-pod memory (read-only). " +
        "--need N exits 75 when fewer than N fit; an unconfigured box always exits 0.",
    )
    .option(
      "--agent <harness>",
      `Harness to size for: ${HARNESSES.join(", ")} (default claude)`,
      parseAgent,
    )
    .option("--need <n>", "Exit 75 unless at least n new sessions of --agent fit", parseNeed)
    .option(
      "--class <class>",
      "Whose slots: spawn (default; net of queued automation) or automation (gross)",
      parseClass,
    )
    .option(
      "--need-build",
      "Exit 75 unless a release build fits now (the `build` object's `fits`); 0 when it does",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    // Subcommands are registered BEFORE `program.exitOverride()` (cli-core `main`), so without
    // this commander exits a usage error with its own 1. Thrown, it reaches
    // `handleProgramParseError`, which maps it to USAGE ⇒ exit 2, as §8.1 and
    // docs/exit-codes.md promise. A script branching on 75 must be able to tell "no room"
    // from "I typed it wrong".
    .exitOverride((error) => {
      throw error;
    })
    .action(async function (this: Command, flags: CapacityFlags) {
      await handleCapacity(flags, this, config);
    });
  // A SUBCOMMAND of `capacity`, so `TOP_LEVEL_VERBS` needs no entry; the program's
  // `enablePositionalOptions()` (inherited) keeps `capacity --class spawn|automation` apart from
  // `admit-wake --class delivery|automation`. Rows "admit-wake: CLI" in test/capacity-wake.test.ts.
  registerAdmitWakeCommand(capacity, config);
  // `run-build`'s `passThroughOptions` needs positional options on its IMMEDIATE parent. The program
  // turns them on (inherited), but a bare `registerDefaultCommands` (a test, another embedder) does
  // not, and commander then throws at registration. Row "registration: `capacity` is in BOTH …" in
  // test/capacity.test.ts.
  capacity.enablePositionalOptions();
  registerRunBuildCommand(capacity, config);
}

// ── `acpx capacity run-build` (CONCEPTION 25479d40 §3.2) ─────────────────────────────────────────

type RunBuildFlags = { bytes?: number; wait?: number; format?: OutputFormat };

function parseMib(value: string): number {
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new InvalidArgumentError("Expected a positive integer (MiB)");
  }
  return Number(value.trim()) * MIB;
}

function parseSeconds(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new InvalidArgumentError("Expected a whole number of seconds");
  }
  return Number(value.trim());
}

export function runBuildJson(result: RunBuildResult): Record<string, unknown> {
  return { action: "run-build", schema: 1, ...result };
}

/**
 * Exit: the child's own code once it ran; 75 with `REFUSED reason=no_room_for_build` when no room
 * appeared within `--wait` (nothing run), or 75 with `DENIED` when `refresh.sh --status` says a
 * refresh already runs (K4); 128+n after TERM/INT/HUP; 2 on usage. The refusal is THROWN — before
 * any child ran — so it takes the CLI's ordinary capacity-refusal path (stderr token, JSON error).
 */
async function handleRunBuild(
  parts: string[],
  flags: RunBuildFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const [program, ...args] = parts;
  const result = await runBuild({
    command: program,
    args,
    bytes: flags.bytes ?? BUILD_CONSTANTS.buildReserveBytes,
    waitS: flags.wait ?? BUILD_CONSTANTS.buildWaitDefaultS,
  });
  emitJsonResult(format, runBuildJson(result));
  process.exitCode = result.exitCode;
}

function registerRunBuildCommand(capacity: Command, config: ResolvedAcpxConfig): void {
  capacity
    .command("run-build")
    .description(
      "Run a release build once this box has room for it, holding that room in the admission " +
        "ledger while it runs; exit 75 with nothing run if no room appears within --wait.",
    )
    .argument("<command...>", "The build command and its arguments, after --")
    .option(
      "--bytes <MiB>",
      `The build's memory estimate (default ${Math.round(BUILD_CONSTANTS.buildReserveBytes / MIB)})`,
      parseMib,
    )
    .option(
      "--wait <seconds>",
      `How long to wait for room (default ${BUILD_CONSTANTS.buildWaitDefaultS})`,
      parseSeconds,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    // Everything after the build command is ITS argv, never ours (`-- refresh.sh --status`).
    .passThroughOptions()
    .exitOverride((error) => {
      throw error;
    })
    .action(async function (this: Command, parts: string[], flags: RunBuildFlags) {
      await handleRunBuild(parts, flags, this, config);
    });
}

// ── `acpx capacity admit-wake` (brick 2b3b259f, CONCEPTION §4.1) ─────────────────────────────────

type AdmitWakeFlags = {
  sessionId: string;
  class: "delivery" | "automation";
  sender?: string;
  format?: OutputFormat;
};

function parseWakeClass(value: string): AdmitWakeFlags["class"] {
  const trimmed = value.trim();
  if (trimmed !== "delivery" && trimmed !== "automation") {
    throw new InvalidArgumentError("Expected one of: delivery, automation");
  }
  return trimmed;
}

/** The `--format json` answer — the contract atrium's `server/admitWake.ts` parses (IMPL-acpx.md). */
export function admitWakeJson(sessionId: string, decision: WakeDecision): Record<string, unknown> {
  return {
    action: "admit-wake",
    schema: 1,
    sessionId,
    decision: decision.decision,
    why: decision.decision === "not-gated" ? decision.why : null,
    key: "key" in decision ? decision.key : null,
    expiresAt: "expiresAt" in decision ? decision.expiresAt : null,
    refusal: decision.decision === "refused" ? decision.refusal : null,
  };
}

function writeAdmitWakeText(sessionId: string, decision: WakeDecision): void {
  if (decision.decision === "refused") {
    process.stderr.write(`${decision.refusal.message}\n`);
    return;
  }
  const why = decision.decision === "not-gated" ? ` (${decision.why})` : "";
  process.stdout.write(`admit-wake ${sessionId}: ${decision.decision}${why}\n`);
}

/**
 * Exit 0 for every non-refusal (`not-needed`, `not-gated`, `admitted`, `already-reserved`), 75 on a
 * refusal (`admission_busy` included), 2 on usage, the usual non-zero for an unknown session.
 * A closed record is NOT short-circuited: atrium asks before a `--reopen`, so a refusal reopens
 * nothing; it answers a closed target without `reopen` with its own 409 before ever calling.
 */
/**
 * A-79: `capacity admit-wake` is atrium's pre-admission verb — atrium holds what it is refused, so a pod-plane
 * refusal keeps the hold sentence and carries `queued: true`. The token line and exit code do not change.
 */
function withHeldRefusal(decision: WakeDecision): WakeDecision {
  if (decision.decision !== "refused") {
    return decision;
  }
  const held = withHoldPromise(decision.error);
  return held === decision.error
    ? decision
    : { ...decision, error: held, refusal: { ...decision.refusal, message: held.message } };
}

async function handleAdmitWake(
  flags: AdmitWakeFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const { resolveSessionRecord } = await import("../session/persistence.js");
  const record = await resolveSessionRecord(flags.sessionId);
  const decided: WakeDecision = (await ownerMayBeRunning(record.acpxRecordId))
    ? { decision: "not-needed" }
    : await admitWake(
        wakeRequestFor(record, {
          verb: "capacity admit-wake",
          flagClass: flags.class,
          sender: flags.sender,
        }),
      );
  const decision = withHeldRefusal(decided);
  if (!emitJsonResult(format, admitWakeJson(record.acpxRecordId, decision))) {
    writeAdmitWakeText(record.acpxRecordId, decision);
  } else if (decision.decision === "refused") {
    process.stderr.write(`${decision.refusal.tokenLine}\n`);
  }
  if (decision.decision === "refused") {
    process.exitCode = EXIT_CODES.CAPACITY;
  }
}

function registerAdmitWakeCommand(capacity: Command, config: ResolvedAcpxConfig): void {
  capacity
    .command("admit-wake")
    .description(
      "atrium's pre-admission before it stores a message for a session with no running agent " +
        "process: admits (and reserves) the owner start, or exits 75 with the refusal text.",
    )
    .requiredOption("--session-id <id>", "The recipient's session record id")
    .requiredOption(
      "--class <class>",
      "delivery (an agent's message) or automation",
      parseWakeClass,
    )
    .option("--sender <id>", "The sending session's record id (decision log)")
    // S3 (CONCEPTION §15.4): an atrium of the previous build still passes these two. They are
    // accepted and ignored for one release — the decision is the same with or without them.
    .addOption(new Option("--sender-role <role>").hideHelp())
    .addOption(new Option("--cross-box").hideHelp())
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .exitOverride((error) => {
      throw error;
    })
    .action(async function (this: Command, flags: AdmitWakeFlags) {
      await handleAdmitWake(flags, this, config);
    });
}
