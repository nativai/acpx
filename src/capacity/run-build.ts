import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapacityRefusedError } from "../errors.js";
import { readProcessBirthIdentity, serializeProcessBirthIdentity } from "../process-identity.js";
import { effectiveRoomBytes, measureProcessTreeBytes } from "./build.js";
import { committedFromMemoryStat, parseFlatKeyed } from "./cgroup.js";
import { MIB } from "./constants.js";
import {
  AdmissionLockTimeoutError,
  admissionDir,
  appendDecisionLog,
  buildExpiry,
  liveEntries,
  newBuildEntry,
  type PendingEntry,
  readLedgerFile,
  reservationsOf,
  withAdmissionLock,
  writeLedgerFile,
} from "./ledger.js";
import { partitionPending, type PendingReservation } from "./pending.js";
import { type CapacitySnapshot, capacitySourcesFromEnv, readCapacity } from "./reading.js";
import { readWaiting } from "./waiting.js";

/**
 * `acpx capacity run-build [--bytes <MiB>] [--wait <s>] -- <command> [args…]` — a release build is
 * admitted like a session (CONCEPTION 25479d40 §3.2, option B).
 *
 *   1. Reserve at once: a ledger entry `build:<uuid>`, kind `build`, class `maintenance`, `waiting`.
 *   2. Its bytes count in `P` for every gated admission (no class split, R9); humans are never gated.
 *   3. Every 5 s, under the admission lock, the build test (`build.ts`): room for the build plus ½M
 *      under R2's line, and on a borrowing box under the node guard too (R7). `expiresAt` re-stamped.
 *   4. When it holds: `building`, the child's pid + birth identity recorded, one decision line, and
 *      the child runs in its OWN process group, lowered to `nice 10` + `ionice -c3` (this process
 *      stays at normal priority and counts its own RSS, R11). Re-stamped every minute (R6).
 *   5. Child exits → entry removed, peak logged, exit with the child's code. TERM/INT/HUP → the
 *      child's process group is killed, then the entry removed (R3). SIGKILL → the entry stays while
 *      the build child lives (`pending.ts`).
 *   6. No room within `--wait` → entry removed, exit 75 `no_room_for_build`, NOTHING RUN.
 *   7. Nested (`ACPX_BUILD_ADMITTED` set): run at once, no second reservation.
 *
 * 🛑 STATIC IMPORTS ONLY — in this module and everything it reaches after the child starts. The child
 * rebuilds acpx itself (`tsdown --clean` empties `dist/`), so a lazy `import()` that runs after it
 * starts can find its chunk gone or replaced by a different build (§3.2 step 7). Row "run-build:
 * the shipped module graph reaches no dynamic import" in test/capacity-run-build.test.ts.
 */

export const BUILD_ADMITTED_ENV = "ACPX_BUILD_ADMITTED";

export type RunBuildRequest = {
  readonly command: string;
  readonly args: readonly string[];
  /** The build's estimate (the CLI defaults it to `BUILD_CONSTANTS.buildReserveBytes`). */
  readonly bytes: number;
  readonly waitS: number;
  readonly env?: NodeJS.ProcessEnv;
};

export type RunBuildOutcome =
  | "built"
  | "nested"
  | "unadmitted"
  | "signalled"
  | "denied"
  | "spawn-failed";

export type RunBuildResult = {
  readonly outcome: RunBuildOutcome;
  readonly exitCode: number;
  readonly key: string | null;
  readonly signal: string | null;
  readonly waitedS: number;
  readonly durationS: number | null;
  readonly bytes: number;
  readonly committedAtStartBytes: number | null;
  readonly committedAtPeakBytes: number | null;
  readonly peakRiseBytes: number | null;
  readonly peakTreeBytes: number | null;
};

const EVALUATE_MS = 5000;
const RESTAMP_MS = 60_000;
const PROGRESS_MS = 60_000;
const SAMPLE_C_MS = 100;
const SAMPLE_TREE_MS = 1000;
const STOP_TERM_GRACE_MS = 3000;
const STOP_KILL_GRACE_MS = 1500;

/** Test seams (a fixture run cannot wait 5 s per tick or a minute per re-stamp); unset in production. */
function intervalFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  return raw && /^[1-9]\d*$/u.test(raw) ? Number(raw) : fallback;
}

const HANDLED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

const gibOf = (bytes: number): string => (Math.max(0, bytes) / (1024 * MIB)).toFixed(1);
const mibOf = (bytes: number): number => Math.round(bytes / MIB);

function say(line: string): void {
  process.stderr.write(`[run-build] ${line}\n`);
}

function signalExitCode(signal: string): number {
  const number = (os.constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 1);
}

function clock(iso: string | undefined): string {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? "?" : `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

function durationText(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `promise`, or `fallback()` after `ms` — whichever settles first; the timer is CLEARED either way.
 * ⚠️ DO NOT RACE AGAINST A PLAIN `sleep()`. The losing timer stays armed and holds the event loop:
 * `run-build` lingered 3 s after a SIGTERM-stopped build and up to 5 s after a signal while waiting
 * (measured in a workbench). Row "run-build exits promptly after SIGTERM" in
 * test/capacity-run-build.test.ts.
 */
async function within<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** An executable on PATH, or undefined. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir || ".", name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

/**
 * The child's priority wrapper: `nice -n 10` and `ionice -t -c3` (`-t`: run it even where the idle
 * class cannot be set), each only where present. Both exec, so the child's pid is the build's.
 */
function priorityPrefix(env: NodeJS.ProcessEnv): string[] {
  const prefix: string[] = [];
  const nice = onPath("nice", env);
  if (nice) {
    prefix.push(nice, "-n", "10");
  }
  const ionice = onPath("ionice", env);
  if (ionice && spawnSync(ionice, ["-t", "-c3", "true"], { stdio: "ignore" }).status === 0) {
    prefix.push(ionice, "-t", "-c3");
  }
  return prefix;
}

// ── the child ────────────────────────────────────────────────────────────────────────────────────

type Child = {
  readonly pid: number;
  /** Resolves with the child's exit; never rejects. */
  readonly exited: Promise<Exit>;
};

/**
 * Spawn the child in its OWN process group (`detached` = a new session, whose pgid is its pid), stdio
 * inherited, with `ACPX_BUILD_ADMITTED=<key>` so a nested `run-build` does not reserve twice.
 * undefined when it could not be started at all.
 */
function startChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  key: string,
): Child | undefined {
  let child: ChildProcess;
  try {
    child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "inherit",
      env: { ...env, [BUILD_ADMITTED_ENV]: key },
    });
  } catch (error) {
    say(`cannot start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", (error) => {
      say(`cannot start ${argv[0]}: ${error.message}`);
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return child.pid === undefined ? undefined : { pid: child.pid, exited };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the group is already gone
  }
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= until) {
      return false;
    }
    await sleep(100);
  }
  return true;
}

/** TERM the child's whole process group, then KILL what is left after a grace (AC-7: gone in 5 s). */
async function stopGroup(pgid: number): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, STOP_TERM_GRACE_MS)) {
    return;
  }
  signalGroup(pgid, "SIGKILL");
  await waitGroupGone(pgid, STOP_KILL_GRACE_MS);
}

/** The child's exit, or a synthetic one when even SIGKILL did not reap it in time (D state). */
async function exitedWithin(child: Child, ms: number): Promise<Exit> {
  return await within(child.exited, ms, (): Exit => ({ code: null, signal: "SIGKILL" }));
}

function exitCodeOf(exit: Exit): number {
  if (exit.code !== null) {
    return exit.code;
  }
  return exit.signal ? signalExitCode(exit.signal) : 1;
}

// ── signals ──────────────────────────────────────────────────────────────────────────────────────

type Signals = {
  /** The first catchable signal received, if any. */
  received(): HandledSignal | undefined;
  /** Resolves on the next signal (at once if one already arrived). */
  next(): Promise<HandledSignal>;
  dispose(): void;
};

function trapSignals(): Signals {
  let first: HandledSignal | undefined;
  const waiters: Array<(signal: HandledSignal) => void> = [];
  const handlers = HANDLED_SIGNALS.map((signal) => {
    const handler = () => {
      first ??= signal;
      for (const waiter of waiters.splice(0)) {
        waiter(signal);
      }
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    received: () => first,
    next: () =>
      first !== undefined
        ? Promise.resolve(first)
        : new Promise<HandledSignal>((resolve) => waiters.push(resolve)),
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}

/** The child's exit, or the first signal to this process — whichever comes first. */
async function exitOrSignal(
  child: Child,
  signals: Signals,
): Promise<{ readonly exit?: Exit; readonly signal?: HandledSignal }> {
  return await Promise.race([
    child.exited.then((exit) => ({ exit })),
    signals.next().then((signal) => ({ signal })),
  ]);
}

// ── the ledger, under the lock ───────────────────────────────────────────────────────────────────

type Ctx = {
  readonly key: string;
  readonly bytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly argv: readonly string[];
  /** The command's basename — the only part of its argv ever logged (an argv can carry a secret). */
  readonly label: string;
};

type Evaluation =
  | { readonly kind: "waits"; readonly snapshot: CapacitySnapshot }
  | {
      readonly kind: "held";
      readonly snapshot: CapacitySnapshot;
      readonly other: PendingReservation;
    }
  | {
      readonly kind: "started";
      readonly snapshot: CapacitySnapshot;
      readonly child: Child | undefined;
      readonly entry: PendingEntry;
    };

type LedgerView = {
  readonly now: Date;
  readonly entries: readonly PendingEntry[];
  readonly snapshot: CapacitySnapshot;
  readonly mine: PendingEntry | undefined;
  /** Every OTHER entry the shared partition still charges — what a write keeps. */
  readonly others: readonly PendingEntry[];
  /** Another live release build's reservation (K4: the ledger holds at most one). */
  readonly other: PendingReservation | undefined;
};

/** The gate's own read (`liveEntries` → `reservationsOf` → `readCapacity`), as a long-lived reader. */
async function readLedgerView(ctx: Ctx): Promise<LedgerView> {
  const now = new Date();
  const sources = capacitySourcesFromEnv(ctx.env);
  const entries = liveEntries(await readLedgerFile(ctx.dir), now.getTime());
  const reservations = reservationsOf(entries, sources.sessionsDir);
  const snapshot = readCapacity({
    agent: "claude",
    sources,
    pending: reservations,
    waiting: readWaiting(ctx.dir, now),
    admissionClass: "spawn",
    now,
    buildBytes: ctx.bytes,
    countReader: true,
  });
  const liveIds = new Set(snapshot.owners.trees.map((tree) => tree.sessionId));
  const { keptKeys, builds } = partitionPending(reservations, liveIds);
  return {
    now,
    entries,
    snapshot,
    mine: entries.find((entry) => entry.key === ctx.key),
    others: entries.filter((entry) => entry.key !== ctx.key && keptKeys.has(entry.key)),
    other: builds.find((build) => build.key !== ctx.key),
  };
}

/** The entry once its child runs: `building`, the child's pid + birth identity, `C` at the start. */
function buildingEntry(base: PendingEntry, child: Child, view: LedgerView): PendingEntry {
  const identity = readProcessBirthIdentity(child.pid);
  const committed = view.snapshot.committedBytes;
  return {
    ...base,
    expiresAt: buildExpiry(view.now),
    phase: "building",
    buildPid: child.pid,
    ...(identity ? { buildIdentity: serializeProcessBirthIdentity(identity) } : {}),
    buildStartedAt: view.now.toISOString(),
    ...(committed === null ? {} : { committedAtStartBytes: committed }),
  };
}

/**
 * One evaluation (§3.2 step 3): read, test, prune, write — and when the test holds, start the child
 * INSIDE the lock, so the entry that turns `building` carries the child's pid in the same write.
 */
async function evaluateUnderLock(ctx: Ctx): Promise<Evaluation> {
  const view = await readLedgerView(ctx);
  const { snapshot, others, other } = view;
  if (other !== undefined) {
    if (others.length !== view.entries.length) {
      await writeLedgerFile(ctx.dir, others);
    }
    return { kind: "held", snapshot, other };
  }
  const base = view.mine ?? newBuildEntry({ key: ctx.key, bytes: ctx.bytes, now: view.now });
  if (!snapshot.build.fits) {
    await writeLedgerFile(ctx.dir, [...others, { ...base, expiresAt: buildExpiry(view.now) }]);
    return { kind: "waits", snapshot };
  }
  const child = startChild(ctx.argv, ctx.env, ctx.key);
  if (child === undefined) {
    await writeLedgerFile(ctx.dir, others);
    return { kind: "started", snapshot, child, entry: base };
  }
  const entry = buildingEntry(base, child, view);
  await writeLedgerFile(ctx.dir, [...others, entry]);
  return { kind: "started", snapshot, child, entry };
}

/** Best effort: an entry left behind is dropped once both of its processes are gone (`pending.ts`). */
async function removeEntry(ctx: Ctx): Promise<void> {
  try {
    await withAdmissionLock(ctx.dir, async () => {
      const entries = await readLedgerFile(ctx.dir);
      if (entries.some((entry) => entry.key === ctx.key)) {
        await writeLedgerFile(
          ctx.dir,
          entries.filter((entry) => entry.key !== ctx.key),
        );
      }
    });
  } catch {
    // see above
  }
}

async function restamp(ctx: Ctx, entry: PendingEntry): Promise<void> {
  try {
    await withAdmissionLock(ctx.dir, async () => {
      const entries = await readLedgerFile(ctx.dir);
      const others = entries.filter((e) => e.key !== ctx.key);
      const mine = entries.find((e) => e.key === ctx.key) ?? entry;
      await writeLedgerFile(ctx.dir, [...others, { ...mine, expiresAt: buildExpiry(new Date()) }]);
    });
  } catch {
    // the next minute retries; a missed re-stamp still has the rest of its 10 min
  }
}

/**
 * Re-stamp `expiresAt` while building (R6), and put the entry back if an older reader pruned it. One
 * at a time, and never after `stop()`: a late re-stamp would resurrect a removed entry.
 */
function restamper(ctx: Ctx, entry: PendingEntry): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(
    () => {
      inFlight = inFlight.then(() => (stopped ? undefined : restamp(ctx, entry)));
    },
    intervalFromEnv(ctx.env, "ACPX_RUN_BUILD_RESTAMP_MS", RESTAMP_MS),
  );
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

// ── the decision log ─────────────────────────────────────────────────────────────────────────────

function snapshotLogFields(snapshot: CapacitySnapshot | undefined): Record<string, unknown> {
  if (!snapshot) {
    return {};
  }
  return {
    box: snapshot.box,
    verdict: snapshot.verdict,
    budget: snapshot.budgetBytes,
    limit: snapshot.limitBytes,
    committed: snapshot.committedBytes,
    charged: snapshot.chargedBytes,
    pending: snapshot.pendingBytes,
    live: snapshot.owners.live,
    buildFits: snapshot.build.fits,
    buildRoom: snapshot.build.roomBytes,
    buildNodeRoom: snapshot.build.nodeRoomBytes,
    buildGrowth: snapshot.build.growthBytes,
    cpuPsiSomeAvg10: snapshot.pressure.cpuPsiSomeAvg10,
    nodeLoad1: snapshot.pressure.nodeLoad1,
  };
}

/** One `kind: "build"` line in the admission decision log (best effort, like every decision line). */
async function logBuild(
  ctx: Ctx,
  decision: string,
  snapshot: CapacitySnapshot | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  await appendDecisionLog(
    ctx.dir,
    {
      ts: now.toISOString(),
      kind: "build",
      decision,
      class: "maintenance",
      key: ctx.key,
      bytes: ctx.bytes,
      command: ctx.label,
      caller: ctx.env.ACPX_SESSION_URL ?? ctx.env.ACPX_SESSION_RECORD_ID ?? null,
      callerPid: process.pid,
      ...snapshotLogFields(snapshot),
      ...extra,
    },
    now,
  );
}

// ── the refusal (CONCEPTION 25479d40 §5.2) ───────────────────────────────────────────────────────

type RefusalInput = {
  readonly bytes: number;
  readonly waitS: number;
  readonly waitedS: number;
  readonly snapshot: CapacitySnapshot | undefined;
  readonly other: PendingReservation | undefined;
};

const orUnknown = (value: string | number | null | undefined): string | number => value ?? "?";

function refusalTokens(input: RefusalInput, room: number | null): string[] {
  const { snapshot } = input;
  const nodeRoom = snapshot?.build.nodeRoomBytes ?? null;
  return [
    "reason=no_room_for_build",
    "nothing_started=true",
    "protocol=1",
    `box=${orUnknown(snapshot?.box)}`,
    `need_mib=${mibOf(input.bytes)}`,
    `room_mib=${room === null ? "?" : mibOf(Math.max(0, room))}`,
    `waited_s=${input.waitedS}`,
    `live=${orUnknown(snapshot?.owners.live)}`,
    ...additiveTokens(nodeRoom, input.other),
  ];
}

/** Additive, after the specified fields: the node term when it applies, and who held the slot (K4). */
function additiveTokens(nodeRoom: number | null, other: PendingReservation | undefined): string[] {
  return [
    ...(nodeRoom === null ? [] : [`node_room_mib=${mibOf(Math.max(0, nodeRoom))}`]),
    ...(other ? [`held_by=${other.key}`] : []),
  ];
}

function refusalWhy(input: RefusalInput, room: number | null): string {
  const { other, snapshot } = input;
  if (other) {
    return `another release build held this box's build reservation (${other.key}, ${other.build?.phase ?? "?"} since ${clock(other.build?.since)})`;
  }
  if (!snapshot || room === null) {
    return "the box's admission lock stayed busy";
  }
  const node = snapshot.build.nodeRoomBytes === room ? " on the node this box borrows from" : "";
  return `${snapshot.owners.live} sessions live; ${gibOf(room)} of the ${gibOf(input.bytes)} GiB it needs was free${node}`;
}

function noRoomRefusal(input: RefusalInput): CapacityRefusedError {
  const room = input.snapshot ? effectiveRoomBytes(input.snapshot.build) : null;
  const sentence =
    `acpx: the box had no room for the release build within ${durationText(input.waitS)} (${refusalWhy(input, room)}). ` +
    `Nothing was changed. New agent work, held while it waited, is admitted again now. Retry ` +
    `later: 'acpx capacity --need-build' says when it fits.`;
  return new CapacityRefusedError({
    tokenLine: `acpx: REFUSED ${refusalTokens(input, room).join(" ")}`,
    sentence,
    detail: {
      reason: "no_room_for_build",
      nothingStarted: true,
      retryAfterS: 300,
      queuedAhead: input.snapshot?.waiting.count ?? 0,
      ...(input.snapshot ? { capacity: input.snapshot } : {}),
    },
  });
}

// ── building ─────────────────────────────────────────────────────────────────────────────────────

function emptyResult(
  outcome: RunBuildOutcome,
  exitCode: number,
  key: string | null,
  bytes: number,
  waitedS: number,
  signal: string | null = null,
): RunBuildResult {
  return {
    outcome,
    exitCode,
    key,
    signal,
    waitedS,
    durationS: null,
    bytes,
    committedAtStartBytes: null,
    committedAtPeakBytes: null,
    peakRiseBytes: null,
    peakTreeBytes: null,
  };
}

/** `C` from `memory.stat` alone — the 100 ms sampler's one read. */
function readCommittedBytes(cgroupRoot: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(cgroupRoot, "memory.stat"), "utf8");
    return committedFromMemoryStat(parseFlatKeyed(raw))?.committedBytes;
  } catch {
    return undefined;
  }
}

type Peaks = { committed: number | undefined; tree: number };

/** 100 ms samples of `C`, 1 s samples of the build tree (§3.3 calibration); stop() ends both. */
function samplePeaks(
  ctx: Ctx,
  pid: number,
  start: number | undefined,
): { peaks: Peaks; stop(): void } {
  const sources = capacitySourcesFromEnv(ctx.env);
  const peaks: Peaks = { committed: start, tree: 0 };
  const sampleC = () => {
    const now = readCommittedBytes(sources.cgroupRoot);
    if (now !== undefined && (peaks.committed === undefined || now > peaks.committed)) {
      peaks.committed = now;
    }
  };
  const sampleTree = () => {
    peaks.tree = Math.max(peaks.tree, measureProcessTreeBytes(sources.procRoot, pid));
  };
  sampleC();
  sampleTree();
  const c = setInterval(sampleC, SAMPLE_C_MS);
  const tree = setInterval(sampleTree, SAMPLE_TREE_MS);
  return {
    peaks,
    stop: () => {
      clearInterval(c);
      clearInterval(tree);
    },
  };
}

type Finished = {
  readonly exit: Exit;
  readonly signal: HandledSignal | undefined;
  readonly durationS: number;
  readonly peaks: Peaks;
};

/** Run the started child to its end — or stop its process group on TERM/INT/HUP (R3). */
async function superviseChild(
  ctx: Ctx,
  child: Child,
  entry: PendingEntry,
  signals: Signals,
): Promise<Finished> {
  const startMs = Date.now();
  const sampler = samplePeaks(ctx, child.pid, entry.committedAtStartBytes);
  const stamps = restamper(ctx, entry);
  const first = await exitOrSignal(child, signals);
  if (first.signal !== undefined) {
    say(`${first.signal}: stopping the release build's process group (pid ${child.pid})`);
    await stopGroup(child.pid);
  }
  const exit = first.exit ?? (await exitedWithin(child, STOP_TERM_GRACE_MS));
  await stamps.stop();
  sampler.stop();
  await removeEntry(ctx);
  return {
    exit,
    signal: first.signal ?? signals.received(),
    durationS: Math.round((Date.now() - startMs) / 1000),
    peaks: sampler.peaks,
  };
}

function peaksOf(peaks: Peaks, start: number | undefined) {
  const peakC = peaks.committed ?? null;
  return {
    committedAtStartBytes: start ?? null,
    committedAtPeakBytes: peakC,
    peakRiseBytes: peakC !== null && start !== undefined ? peakC - start : null,
    peakTreeBytes: peaks.tree,
  };
}

function finishedResult(
  ctx: Ctx,
  f: Finished,
  start: number | undefined,
  waitedS: number,
): RunBuildResult {
  return {
    outcome: f.signal ? "signalled" : "built",
    exitCode: f.signal ? signalExitCode(f.signal) : exitCodeOf(f.exit),
    key: ctx.key,
    signal: f.signal ?? f.exit.signal ?? null,
    waitedS,
    durationS: f.durationS,
    bytes: ctx.bytes,
    ...peaksOf(f.peaks, start),
  };
}

async function runChildToEnd(
  ctx: Ctx,
  started: Extract<Evaluation, { kind: "started" }>,
  signals: Signals,
  waitedS: number,
): Promise<RunBuildResult> {
  const { child, entry, snapshot } = started;
  if (!child) {
    await logBuild(ctx, "spawn-failed", snapshot);
    return emptyResult("spawn-failed", 127, ctx.key, ctx.bytes, waitedS);
  }
  const start = entry.committedAtStartBytes;
  const room = effectiveRoomBytes(snapshot.build) ?? 0;
  say(
    `starting the release build after ${waitedS} s (room ${gibOf(room)} GiB, needs ${gibOf(ctx.bytes)} GiB): ` +
      `${ctx.label}, pid ${child.pid}, its own process group, nice 10`,
  );
  await logBuild(ctx, "started", snapshot, {
    buildPid: child.pid,
    waitedS,
    committedAtStart: start ?? null,
  });
  const finished = await superviseChild(ctx, child, entry, signals);
  const result = finishedResult(ctx, finished, start, waitedS);
  await logBuild(ctx, finished.signal ? "signalled" : "done", undefined, {
    buildPid: child.pid,
    exitCode: finished.exit.code,
    exitSignal: finished.exit.signal,
    signal: finished.signal ?? null,
    waitedS,
    durationS: result.durationS,
    committedAtStart: result.committedAtStartBytes,
    committedAtPeak: result.committedAtPeakBytes,
    peakRise: result.peakRiseBytes,
    peakTree: result.peakTreeBytes,
  });
  const how = finished.signal
    ? `stopped (${finished.signal})`
    : `finished: exit ${result.exitCode}`;
  const rise = result.peakRiseBytes === null ? "?" : mibOf(result.peakRiseBytes);
  say(
    `release build ${how} after ${result.durationS} s; C rose by ${rise} MiB at peak, ` +
      `build tree peak ${mibOf(finished.peaks.tree)} MiB`,
  );
  return result;
}

/** A command that takes no reservation of its own: nested, or the gate failed open. */
async function runUnadmitted(
  ctx: Ctx,
  outcome: "nested" | "unadmitted",
  signals: Signals,
  argv: readonly string[],
  key: string,
): Promise<RunBuildResult> {
  const child = startChild(argv, ctx.env, key);
  if (!child) {
    return emptyResult("spawn-failed", 127, key, ctx.bytes, 0);
  }
  const first = await exitOrSignal(child, signals);
  if (first.signal !== undefined) {
    await stopGroup(child.pid);
    await exitedWithin(child, STOP_TERM_GRACE_MS);
    return emptyResult("signalled", signalExitCode(first.signal), key, ctx.bytes, 0, first.signal);
  }
  const exit = first.exit ?? { code: 1, signal: null };
  return emptyResult(outcome, exitCodeOf(exit), key, ctx.bytes, 0, exit.signal);
}

// ── waiting ──────────────────────────────────────────────────────────────────────────────────────

function isStatusProbe(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--status" || arg === "--is-running");
}

/**
 * K4: when the command is `refresh.sh`, ask it first whether a refresh already runs — until the
 * control pin the wrapper sits OUTSIDE refresh.sh's flock, and would otherwise wait out its deadline
 * only to meet `DENIED`. Any answer but 75 (idle, or a script without `--status`) proceeds as normal.
 */
function refreshAlreadyRunning(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (path.basename(command) !== "refresh.sh" || isStatusProbe(args)) {
    return undefined;
  }
  const probe = spawnSync(command, ["--status"], {
    env,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return probe.status === 75 ? probe.stdout.trim() || "running" : undefined;
}

function heldText(other: PendingReservation): string {
  const build = other.build;
  return `${other.key}, ${orUnknown(build?.phase)} since ${clock(build?.since)}, pid ${orUnknown(build?.admitterPid)}`;
}

function progressLine(last: Evaluation | undefined, bytes: number, minutesLeft: number): string {
  const left = `${minutesLeft} min left`;
  if (last === undefined) {
    return `waiting for the box's admission lock; ${left}`;
  }
  if (last.kind === "held") {
    return `waiting: another release build holds this box's build reservation (${heldText(last.other)}); ${left}`;
  }
  const room = effectiveRoomBytes(last.snapshot.build);
  return `waiting for room for the release build: ${room === null ? "?" : gibOf(room)} of ${gibOf(bytes)} GiB free; new agent work is held; ${left}`;
}

type Tick =
  | { readonly kind: "evaluated"; readonly evaluation: Evaluation | undefined }
  | { readonly kind: "fail-open"; readonly message: string };

/** One locked evaluation; lock CONTENTION is a skipped tick, any other lock fault fails open. */
async function tick(ctx: Ctx): Promise<Tick> {
  try {
    return {
      kind: "evaluated",
      evaluation: await withAdmissionLock(ctx.dir, () => evaluateUnderLock(ctx)),
    };
  } catch (error) {
    if (error instanceof AdmissionLockTimeoutError) {
      return { kind: "evaluated", evaluation: undefined };
    }
    return { kind: "fail-open", message: error instanceof Error ? error.message : String(error) };
  }
}

type WaitState = {
  readonly t0: number;
  readonly deadline: number;
  last: Evaluation | undefined;
  lastProgressMs: number;
  loggedWaiting: boolean;
};

async function signalledWhileWaiting(
  ctx: Ctx,
  signal: HandledSignal,
  state: WaitState,
  waitedS: number,
): Promise<RunBuildResult> {
  await removeEntry(ctx);
  await logBuild(ctx, "signalled", state.last?.snapshot, { signal, waitedS, phase: "waiting" });
  say(`${signal} while waiting for room: nothing was run, and the reservation is removed`);
  return emptyResult("signalled", signalExitCode(signal), ctx.key, ctx.bytes, waitedS, signal);
}

async function refuseAtDeadline(
  ctx: Ctx,
  request: RunBuildRequest,
  state: WaitState,
  waitedS: number,
): Promise<never> {
  await removeEntry(ctx);
  const other = state.last?.kind === "held" ? state.last.other : undefined;
  await logBuild(ctx, "refused", state.last?.snapshot, {
    reason: "no_room_for_build",
    waitedS,
    heldBy: other?.key ?? null,
  });
  throw noRoomRefusal({
    bytes: ctx.bytes,
    waitS: request.waitS,
    waitedS,
    snapshot: state.last?.snapshot,
    other,
  });
}

/** After a tick that did not start the build: the first waiting log line, and a line a minute. */
async function reportWaiting(ctx: Ctx, state: WaitState, now: number): Promise<void> {
  const { last } = state;
  if (last !== undefined && !state.loggedWaiting) {
    state.loggedWaiting = true;
    await logBuild(ctx, "waiting", last.snapshot, {
      heldBy: last.kind === "held" ? last.other.key : null,
    });
  }
  if (now - state.lastProgressMs >= PROGRESS_MS) {
    state.lastProgressMs = now;
    say(progressLine(last, ctx.bytes, Math.ceil((state.deadline - now) / 60_000)));
  }
}

async function waitAndBuild(
  ctx: Ctx,
  request: RunBuildRequest,
  signals: Signals,
): Promise<RunBuildResult> {
  const t0 = Date.now();
  const state: WaitState = {
    t0,
    deadline: t0 + request.waitS * 1000,
    last: undefined,
    lastProgressMs: Number.NEGATIVE_INFINITY,
    loggedWaiting: false,
  };
  const tickMs = intervalFromEnv(ctx.env, "ACPX_RUN_BUILD_TICK_MS", EVALUATE_MS);
  for (;;) {
    const waitedS = Math.round((Date.now() - t0) / 1000);
    const signal = signals.received();
    if (signal !== undefined) {
      return await signalledWhileWaiting(ctx, signal, state, waitedS);
    }
    const result = await tick(ctx);
    if (result.kind === "fail-open") {
      // An instrument fault (EACCES, ENOSPC, EROFS) fails OPEN, loudly, as the create gate does.
      process.stderr.write(
        `[acpx] WARNING: release build admission failed (${result.message}); running it without a reservation\n`,
      );
      await logBuild(ctx, "fail-open", undefined, { error: result.message });
      return await runUnadmitted(ctx, "unadmitted", signals, ctx.argv, ctx.key);
    }
    if (result.evaluation?.kind === "started") {
      return await runChildToEnd(ctx, result.evaluation, signals, waitedS);
    }
    state.last = result.evaluation ?? state.last;
    const now = Date.now();
    if (now >= state.deadline) {
      return await refuseAtDeadline(ctx, request, state, waitedS);
    }
    await reportWaiting(ctx, state, now);
    await within(signals.next(), Math.min(tickMs, state.deadline - now), () => undefined);
  }
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────

async function runBuildTrapped(
  ctx: Ctx,
  request: RunBuildRequest,
  signals: Signals,
): Promise<RunBuildResult> {
  const nestedKey = ctx.env[BUILD_ADMITTED_ENV]?.trim();
  if (nestedKey) {
    // K12: a nested call (or anyone who sets the variable) skips admission — the log names it.
    await logBuild(ctx, "nested", undefined, { admittedKey: nestedKey });
    const argv = [request.command, ...request.args];
    return await runUnadmitted(ctx, "nested", signals, argv, nestedKey);
  }
  const running = refreshAlreadyRunning(request.command, request.args, ctx.env);
  if (running !== undefined) {
    await logBuild(ctx, "denied", undefined, { refreshStatus: running });
    process.stderr.write(
      `[run-build] DENIED: another refresh is already running (${running}); nothing was reserved or run — retry when it has finished (refresh.sh --status). Exit 75.\n`,
    );
    return emptyResult("denied", 75, null, ctx.bytes, 0);
  }
  return await waitAndBuild(ctx, request, signals);
}

/**
 * Run `request.command` once the box has room for a release build (CONCEPTION 25479d40 §3.2). Returns
 * the result to exit with; THROWS the `no_room_for_build` refusal (nothing run) at the deadline.
 */
export async function runBuild(request: RunBuildRequest): Promise<RunBuildResult> {
  const env = request.env ?? process.env;
  const ctx: Ctx = {
    key: `build:${randomUUID()}`,
    bytes: request.bytes,
    env,
    dir: admissionDir(env),
    argv: [...priorityPrefix(env), request.command, ...request.args],
    label: path.basename(request.command),
  };
  const signals = trapSignals();
  try {
    return await runBuildTrapped(ctx, request, signals);
  } finally {
    signals.dispose();
  }
}
