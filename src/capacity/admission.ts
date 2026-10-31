import { randomUUID } from "node:crypto";
import { acpAdapterKind } from "../acp/agent-command.js";
import { CapacityRefusedError } from "../errors.js";
import type { CapacityRefusalReason } from "../types.js";
import { readPodInfo } from "./budget.js";
import { type Harness, isHarness, MIB } from "./constants.js";
import {
  type AdmissionClass,
  AdmissionLockTimeoutError,
  admissionDir,
  appendDecisionLog,
  boundEntry,
  liveEntries,
  newEntry,
  type PendingEntry,
  readLedgerFile,
  reservationsOf,
  withAdmissionLock,
  writeLedgerFile,
} from "./ledger.js";
import { partitionPending } from "./pending.js";
import {
  type CapacityClass,
  type CapacitySnapshot,
  capacitySourcesFromEnv,
  needMet,
  readCapacity,
} from "./reading.js";
import { readWaiting, type WaitingQueue } from "./waiting.js";

/**
 * The create gate (CONCEPTION f7587c86 §6.1 A2, AMENDMENT 2026-10-29): `sessions new`, `sessions
 * copy` / fork / by-the-way and `sessions new --from-template` call {@link admitCreate} BEFORE any
 * record, seat or transient adapter exists. It admits exactly when `acpx capacity --agent <h>
 * --need 1` would say "met" — same `readCapacity`, same fresh readings, same ledger — and otherwise
 * throws {@link CapacityRefusedError} (exit 75) with nothing created.
 *
 * WHO IS GATED: an AGENT creating a session (class `spawn`) and AUTOMATION (class `automation`,
 * CONCEPTION e8abe1e8 §3.2.1 — atrium's wakeup and brick-trigger creates, which wait in atrium's
 * queue when refused). Same check (`--need 1` on the agent figures, the human reserve kept back),
 * same reservation, same exit 75 with nothing created; `spawn` figures are net of the queued
 * automation (`reading.ts`), `automation` figures gross. `automation` is never INFERRED: only atrium,
 * which parks a refused create instead of failing it, sends it.
 *   1. `ACPX_ADMISSION_CLASS`, when set to a known class, decides: `spawn` and `automation` are
 *      gated, `interactive` and `delivery` are not. It is read
 *      once at CLI start and DELETED from the environment (`takeAdmissionClassFromEnv`), so it never
 *      reaches an owner, a harness or an agent's shell (§16). An acpx that predates it ignores it —
 *      why it is an env var and not a flag (review finding 1).
 *   2. Absent, the class is INFERRED: `spawn` iff the caller carries an agent identity
 *      (`ACPX_SESSION_RECORD_ID` / `ACPX_SESSION_URL`) AND runs inside a live owner's process tree
 *      (the census's `self`). Everything else — atrium's own creates, wakeups, brick triggers, a
 *      human's shell — is not gated.
 *
 * ⚠️ DO NOT DROP EITHER HALF OF THE INFERENCE.
 *   - Identity alone is not enough: an identity variable that leaked into ATRIUM's environment (an
 *     atrium restarted from an agent shell) would make every atrium create an "agent" create, refused
 *     before any atrium knows what exit 75 means. Atrium runs under the entrypoint supervisor
 *     (dumb-init → bash → node), never inside an owner tree, so ancestry is what keeps it ungated.
 *   - Ancestry alone is not enough: the brick CLI's local-mode trigger create runs INSIDE an agent's
 *     tree and sends no class, and it must stay ungated: its failure path would lose the run
 *     (CONCEPTION e8abe1e8 §4.3). acpx-ui strips the caller identity from every create it spawns
 *     (`withoutCallerIdentity`), which is what tells that create apart.
 *   Rows: "class: …" in test/capacity-admission.test.ts.
 *
 * NEVER GATED, whatever the class: a handover successor — `--from <id>` while <id>'s owner is live
 * (it is the caller's own session under `sessions handover`). An unconfigured box (no podinfo) and
 * an unmeasured one fail OPEN, and so does any lock I/O fault; only lock CONTENTION refuses
 * (`admission_busy`, §3.3).
 */

const ADMISSION_CLASSES: readonly AdmissionClass[] = [
  "interactive",
  "delivery",
  "automation",
  "spawn",
];

type ExplicitClass = { readonly raw: string; readonly value: AdmissionClass | undefined };
let explicitClass: ExplicitClass | undefined;

/**
 * Reads `ACPX_ADMISSION_CLASS` once and deletes it from `env`. Called first thing in the CLI's
 * `main`, before anything can be spawned: the queue owner inherits `...process.env`
 * (`queue-owner-process.ts`), so a class left in place would reach every harness and every `acpx`
 * an agent runs from its shell — and would mark the AGENT's own creates with ATRIUM's class.
 */
export function takeAdmissionClassFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.ACPX_ADMISSION_CLASS;
  if (raw === undefined) {
    return;
  }
  delete env.ACPX_ADMISSION_CLASS;
  const value = raw.trim();
  explicitClass = {
    raw,
    value: (ADMISSION_CLASSES as readonly string[]).includes(value)
      ? (value as AdmissionClass)
      : undefined,
  };
}

function hasAgentIdentity(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ACPX_SESSION_RECORD_ID?.trim() || env.ACPX_SESSION_URL?.trim());
}

/** The newcomer's harness; an unknown command is reserved at the LARGEST `r_new` (rounds up, §9). */
function newcomerHarness(agentCommand: string): Harness {
  const kind = acpAdapterKind(agentCommand);
  return kind !== undefined && isHarness(kind) ? kind : "claude";
}

export type CreateAdmissionRequest = {
  /** For the decision log: which verb asked. */
  readonly verb: string;
  readonly agentCommand: string;
  /** `--record-id`, when the caller minted it. */
  readonly recordId?: string;
  /** `--from <id>`: a succession, never gated while <id>'s owner is live. */
  readonly successorOf?: string;
};

/** An admitted create's reservation. Bind it to the record once it exists; release it on failure. */
export type AdmissionTicket = {
  readonly key: string;
  bind(sessionId: string): Promise<void>;
  release(): Promise<void>;
};

type Decision =
  | { readonly kind: "not-gated"; readonly why: string }
  | { readonly kind: "admitted"; readonly entry: PendingEntry }
  | { readonly kind: "refused"; readonly error: CapacityRefusedError };

const gib = (bytes: number | null): string =>
  bytes === null ? "?" : `${(bytes / (1024 * MIB)).toFixed(2)} GiB`;

function reasonOf(snapshot: CapacitySnapshot, harness: Harness): CapacityRefusalReason {
  const guard = snapshot.bindingGuard?.[harness];
  if (guard === "G4") {
    return "memory_pressure";
  }
  return guard === "G3" ? "node_pressure" : "no_capacity";
}

/** For an agent (class `spawn`): the queued automation that takes the next free slots first. */
function queuedClause(snapshot: CapacitySnapshot): string {
  const w = snapshot.waiting.count;
  if (snapshot.class !== "spawn" || w === 0) {
    return "";
  }
  return ` ${w} automation session${w === 1 ? " is" : "s are"} queued for room ahead of new agent sessions and start${w === 1 ? "s" : ""} first.`;
}

function refusalSentence(
  reason: CapacityRefusalReason,
  snapshot: CapacitySnapshot | undefined,
): string {
  if (reason === "admission_busy" || !snapshot) {
    const nothing = "Nothing was started or queued.";
    return `acpx: other session creations held the box's admission lock for 5 s. ${nothing} Retry in a few seconds; 'acpx capacity' shows the room left.`;
  }
  const nothing = `Nothing was started or queued.${queuedClause(snapshot)}`;
  if (reason === "memory_pressure") {
    return `acpx: the box is stalling on memory right now (PSI full avg10 ${snapshot.pressure.psiFullAvg10 ?? "?"} %). ${nothing} See 'acpx capacity'; retry in a minute.`;
  }
  if (reason === "node_pressure") {
    return `acpx: the box is borrowing above its memory request and the node it shares has too little left (${gib(snapshot.pressure.nodeAvailableBytes)} available). ${nothing} See 'acpx capacity'; close sessions you have finished with, or retry later.`;
  }
  return (
    `acpx: the box has no memory for another agent session (${snapshot.owners.live} live, ` +
    `${snapshot.owners.starting} starting; ${gib(snapshot.chargedBytes)} charged of a ` +
    `${gib(snapshot.budgetBytes)} budget). ${nothing} See 'acpx capacity'; close sessions you ` +
    `have finished with, or retry when one finishes.`
  );
}

function snapshotTokenFields(snapshot: CapacitySnapshot): string[] {
  return [
    `box=${snapshot.box}`,
    `basis=${snapshot.basis}`,
    `free_slots=${snapshot.freeSlots?.[snapshot.agent] ?? 0}`,
    `need_mib=${Math.round(snapshot.reserveNewBytes[snapshot.agent] / MIB)}`,
    "releasable_mib=0",
  ];
}

/**
 * The refusal. `queued_ahead=<W>` (CONCEPTION e8abe1e8 §3.2.5) is APPENDED last on every token line,
 * `admission_busy` included: the queued automation the gate saw at decision time (for an
 * `automation` create, the whole queue, itself included). Additive — `protocol=1` keeps its meaning.
 */
export function capacityRefusal(
  reason: CapacityRefusalReason,
  snapshot?: CapacitySnapshot,
  queuedAhead: number = snapshot?.waiting.count ?? 0,
): CapacityRefusedError {
  const retryAfterS = reason === "admission_busy" ? 5 : 60;
  const fields = [
    `reason=${reason}`,
    "nothing_started=true",
    "protocol=1",
    ...(snapshot ? snapshotTokenFields(snapshot) : []),
    `retry_after_s=${retryAfterS}`,
    `queued_ahead=${queuedAhead}`,
  ];
  return new CapacityRefusedError({
    tokenLine: `acpx: REFUSED ${fields.join(" ")}`,
    sentence: refusalSentence(reason, snapshot),
    detail: {
      reason,
      nothingStarted: true,
      retryAfterS,
      queuedAhead,
      ...(snapshot ? { capacity: snapshot } : {}),
    },
  });
}

type GateContext = {
  readonly request: CreateAdmissionRequest;
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly explicit: AdmissionClass | undefined;
  /** `automation` only when sent explicitly; every other gated create sizes as `spawn`. */
  readonly capacityClass: CapacityClass;
  readonly harness: Harness;
};

function snapshotFields(snapshot: CapacitySnapshot, harness: Harness): Record<string, unknown> {
  return {
    box: snapshot.box,
    basis: snapshot.basis,
    verdict: snapshot.verdict,
    rNew: snapshot.reserveNewBytes[harness],
    budget: snapshot.budgetBytes,
    committed: snapshot.committedBytes,
    charged: snapshot.chargedBytes,
    pending: snapshot.pendingBytes,
    freeSlots: snapshot.freeSlots?.[harness] ?? null,
    bindingGuard: snapshot.bindingGuard?.[harness] ?? null,
    live: snapshot.owners.live,
    starting: snapshot.owners.starting,
    cpuPsiSomeAvg10: snapshot.pressure.cpuPsiSomeAvg10,
    nodeLoad1: snapshot.pressure.nodeLoad1,
  };
}

function logLine(
  ctx: GateContext,
  decision: string,
  snapshot: CapacitySnapshot | undefined,
  extra: Record<string, unknown>,
  waiting: WaitingQueue,
): Record<string, unknown> {
  const invalid = explicitClass && !explicitClass.value ? { invalidClass: explicitClass.raw } : {};
  return {
    ts: new Date().toISOString(),
    decision,
    class: ctx.explicit ?? "spawn",
    classSource: ctx.explicit ? "env" : "inferred",
    ...invalid,
    verb: ctx.request.verb,
    caller: ctx.env.ACPX_SESSION_URL ?? ctx.env.ACPX_SESSION_RECORD_ID ?? null,
    callerPid: process.pid,
    harness: ctx.harness,
    waiting: waiting.count,
    ...(snapshot ? snapshotFields(snapshot, ctx.harness) : {}),
    ...extra,
  };
}

/** Why this create is not gated after all, once the reading is in hand — or undefined. */
function notGatedReason(
  ctx: GateContext,
  snapshot: CapacitySnapshot,
  liveIds: ReadonlySet<string>,
): string | undefined {
  if (!ctx.explicit && !snapshot.owners.trees.some((tree) => tree.self)) {
    return "not-in-owner-tree";
  }
  if (ctx.request.successorOf !== undefined && liveIds.has(ctx.request.successorOf)) {
    return "successor";
  }
  return snapshot.verdict === "unconfigured" || snapshot.verdict === "unmeasured"
    ? snapshot.verdict
    : undefined;
}

/** The decision on a gated create: `acpx capacity --need 1`'s own test, nothing else. */
function admitOrRefuse(ctx: GateContext, snapshot: CapacitySnapshot, now: Date): Decision {
  if (!needMet(snapshot, 1)) {
    return { kind: "refused", error: capacityRefusal(reasonOf(snapshot, ctx.harness), snapshot) };
  }
  const entry = newEntry({
    key: ctx.request.recordId ?? `adm-${randomUUID()}`,
    sessionId: ctx.request.recordId,
    harness: ctx.harness,
    bytes: snapshot.reserveNewBytes[ctx.harness],
    admissionClass: ctx.capacityClass,
    origin: ctx.request.verb,
    now,
  });
  return { kind: "admitted", entry };
}

function decisionExtra(decision: Decision): Record<string, unknown> {
  if (decision.kind === "not-gated") {
    return { why: decision.why };
  }
  return decision.kind === "refused"
    ? { reason: decision.error.capacityRefusal.reason }
    : { key: decision.entry.key };
}

/** Everything between lock and unlock (§5 steps 1–5): read, decide, write the entry and the log. */
async function decideUnderLock(ctx: GateContext): Promise<Decision> {
  const now = new Date();
  const sources = capacitySourcesFromEnv(ctx.env);
  const entries = liveEntries(await readLedgerFile(ctx.dir), now.getTime());
  const reservations = reservationsOf(entries, sources.sessionsDir);
  const waiting = readWaiting(ctx.dir, now);
  const snapshot = readCapacity({
    agent: ctx.harness,
    sources,
    pending: reservations,
    waiting,
    admissionClass: ctx.capacityClass,
    now,
  });
  const liveIds = new Set(snapshot.owners.trees.map((tree) => tree.sessionId));
  const why = notGatedReason(ctx, snapshot, liveIds);
  const decision: Decision =
    why === undefined ? admitOrRefuse(ctx, snapshot, now) : { kind: "not-gated", why };
  // The SAME partition the reading charged by (`pending.ts`): what it no longer counts is pruned.
  const { keptKeys } = partitionPending(reservations, liveIds);
  const kept = entries.filter((entry) => keptKeys.has(entry.key));
  if (decision.kind === "admitted" || kept.length !== entries.length) {
    await writeLedgerFile(ctx.dir, decision.kind === "admitted" ? [...kept, decision.entry] : kept);
  }
  await appendDecisionLog(
    ctx.dir,
    logLine(ctx, decision.kind, snapshot, decisionExtra(decision), waiting),
    now,
  );
  return decision;
}

function failOpen(stage: string, error: unknown): undefined {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[acpx] WARNING: session admission ${stage} failed (${message}); admitting without a check\n`,
  );
  return undefined;
}

function ticketFor(dir: string, key: string): AdmissionTicket {
  const update = async (change: (entries: PendingEntry[]) => PendingEntry[]) => {
    try {
      await withAdmissionLock(dir, async () => {
        await writeLedgerFile(dir, change(await readLedgerFile(dir)));
      });
    } catch {
      // Best effort: an unbound entry is dropped once its admitter exits, an unreleased one at its
      // TTL — both only ever over-reserve for a while, never under-reserve.
    }
  };
  return {
    key,
    // Bound ⇒ the reservation outlives this CLI until its session runs or its class TTL ends
    // (`pending.ts`): atrium prompts the record from ANOTHER process, maybe after a restart.
    bind: (sessionId) =>
      update((entries) =>
        entries.map((entry) =>
          entry.key === key ? boundEntry(entry, sessionId, new Date()) : entry,
        ),
      ),
    release: () => update((entries) => entries.filter((entry) => entry.key !== key)),
  };
}

/** The checks that need no lock and no reading: an undefined result means "not gated". */
function gateContextFor(
  request: CreateAdmissionRequest,
  env: NodeJS.ProcessEnv,
): GateContext | undefined {
  const explicit = explicitClass?.value;
  const gatedClass =
    explicit === undefined
      ? hasAgentIdentity(env)
      : explicit === "spawn" || explicit === "automation";
  if (!gatedClass) {
    return undefined;
  }
  if (!readPodInfo(capacitySourcesFromEnv(env).podinfoDir).present) {
    return undefined; // unconfigured box: nothing is ever refused (§3.3), and no lock is taken
  }
  return {
    request,
    env,
    dir: admissionDir(env),
    explicit,
    capacityClass: explicit === "automation" ? "automation" : "spawn",
    harness: newcomerHarness(request.agentCommand),
  };
}

async function decide(ctx: GateContext): Promise<Decision | undefined> {
  try {
    return await withAdmissionLock(ctx.dir, () => decideUnderLock(ctx));
  } catch (error) {
    if (!(error instanceof AdmissionLockTimeoutError)) {
      return failOpen("lock or ledger", error);
    }
    // The waiting dir needs no lock (temp + rename writes), so even a busy refusal says what waits.
    const waiting = readWaiting(ctx.dir);
    await appendDecisionLog(
      ctx.dir,
      logLine(ctx, "refused", undefined, { reason: "admission_busy" }, waiting),
      new Date(),
    );
    return {
      kind: "refused",
      error: capacityRefusal("admission_busy", undefined, waiting.count),
    };
  }
}

/**
 * Admit an agent's create, or throw {@link CapacityRefusedError}. Returns a ticket when a
 * reservation was written, `undefined` when this create is not gated (or the gate failed open).
 */
export async function admitCreate(
  request: CreateAdmissionRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdmissionTicket | undefined> {
  const ctx = gateContextFor(request, env);
  const decision = ctx ? await decide(ctx) : undefined;
  if (decision?.kind === "refused") {
    throw decision.error;
  }
  return ctx && decision?.kind === "admitted" ? ticketFor(ctx.dir, decision.entry.key) : undefined;
}

/** The ledger's live reservations, read WITHOUT the lock (temp+rename writes) — for `acpx capacity`. */
export async function readPendingReservationsForProbe(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReturnType<typeof reservationsOf>> {
  try {
    return reservationsOf(
      liveEntries(await readLedgerFile(admissionDir(env)), Date.now()),
      capacitySourcesFromEnv(env).sessionsDir,
    );
  } catch {
    return [];
  }
}

/** The waiting dir the gate reads, for `acpx capacity` — the same queue, the same freshness rule. */
export function readWaitingForProbe(env: NodeJS.ProcessEnv = process.env): WaitingQueue {
  return readWaiting(admissionDir(env));
}
