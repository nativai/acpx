import { randomUUID } from "node:crypto";
import { acpAdapterKind } from "../acp/agent-command.js";
import { CapacityRefusedError } from "../errors.js";
import type { CapacityRefusalReason, FinalReportWhy } from "../types.js";
import { readPodInfo } from "./budget.js";
import { type Harness, isHarness, MIB } from "./constants.js";
import {
  ADMISSION_BUSY_RETRY_AFTER_S,
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
import { finalReportSupported, readWaiting, type WaitingQueue } from "./waiting.js";

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
  return ` ${w} waiting item${w === 1 ? " is" : "s are"} queued for room ahead of new agent sessions and start${w === 1 ? "s" : ""} first.`;
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
function retryAfterOf(reason: CapacityRefusalReason): number {
  return reason === "admission_busy" ? ADMISSION_BUSY_RETRY_AFTER_S : 60;
}

function tokenFields(
  reason: CapacityRefusalReason,
  snapshot: CapacitySnapshot | undefined,
  queuedAhead: number,
): string[] {
  return [
    `reason=${reason}`,
    "nothing_started=true",
    "protocol=1",
    ...(snapshot ? snapshotTokenFields(snapshot) : []),
    `retry_after_s=${retryAfterOf(reason)}`,
    `queued_ahead=${queuedAhead}`,
  ];
}

export function capacityRefusal(
  reason: CapacityRefusalReason,
  snapshot?: CapacitySnapshot,
  queuedAhead: number = snapshot?.waiting.count ?? 0,
): CapacityRefusedError {
  const retryAfterS = retryAfterOf(reason);
  return new CapacityRefusedError({
    tokenLine: `acpx: REFUSED ${tokenFields(reason, snapshot, queuedAhead).join(" ")}`,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The WAKE gate (brick 2b3b259f, CONCEPTION A1 §3–§5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A message to a session whose owner was released after idle (or died) cold-starts a new owner —
 * the same ~450 MiB as a create, which v1 never checked. {@link admitWake} is that check: the same
 * lock, the same `readCapacity` and ledger, the same `--need 1` test as {@link admitCreate}. It runs
 * where `sendSession` would spawn an owner (the only owner-start point in acpx) and behind
 * `acpx capacity admit-wake`, atrium's pre-admission before it stores a message.
 *
 * WHO IS GATED (§3.2, §4.3) — {@link wakeClassOf}, the one mapping:
 *   - `admit-wake --class delivery|automation` (atrium's word for the request) decides first;
 *   - else `ACPX_ADMISSION_CLASS` (atrium's runner spawns): `delivery`, `automation`, `spawn` are gated,
 *     `interactive` (an authenticated human) is NEVER gated — logged with a lock-free reading;
 *   - else INFERRED, as for creates: an agent identity inside a live owner's tree is `spawn` — an
 *     agent's own `acpx prompt`. No identity (a shell outside any agent, an older atrium) is not gated.
 *   ⚠️ `delivery` IS GATED HERE, unlike for a create (where an agent's create through atrium's API stays
 *   ungated, e8abe1e8 §13.4): an agent's message must be refused at once (Daniel, 2026-11-06).
 *
 * NEVER GATED: a live or starting target (the caller checks the lease first; a target found live
 * under the lock reads `not-needed`); a fresh handover successor ({@link isFreshSuccessor}); a closed
 * record carrying `--message-id` (its owner refuses it, B3); an unconfigured or unmeasured box; any
 * lock or ledger I/O fault (fail open). Only lock CONTENTION refuses (`admission_busy`).
 *
 * THE REFUSAL TEXT HAS ONE AUTHOR — {@link wakeRefusal}, below. `acpx prompt` prints it, `admit-wake`
 * returns it, atrium's 503 relays it verbatim and `send-message.sh` prints that field (§5).
 */

export type WakeTarget = {
  readonly id: string;
  readonly agentCommand: string;
  readonly seatId?: string;
  readonly holderActive?: boolean;
  readonly holderOrdinal?: number;
  readonly lastPromptAt?: string;
};

/** atrium's family verdict on the sender (contract note 2026-11-06 17:55Z); acpx computes none. */
export type SenderRole = "leaf" | "orchestrator";

export type WakeAdmissionRequest = {
  readonly verb: "prompt" | "capacity admit-wake";
  readonly target: WakeTarget;
  /** `admit-wake --class`. Absent ⇒ `ACPX_ADMISSION_CLASS`, else inferred. */
  readonly flagClass?: "delivery" | "automation";
  /** The sending session's record id, for the decision log. */
  readonly sender?: string;
  readonly senderRole?: SenderRole;
  /** The sender is on another box: the recipient-box wording (§5.1 d). */
  readonly crossBox?: boolean;
  /** A closed record prompted with `--message-id`: its owner refuses it (B3) — logged, never gated. */
  readonly closedWithMessageId?: boolean;
  /** The target seat's display name, read only when refusing. */
  readonly seatName?: () => Promise<string | undefined>;
};

/** What `admit-wake --format json` returns as `refusal` (CONCEPTION §4.1, contract note 17:55Z). */
export type WakeRefusal = {
  /** The FULL product text: the token line, the sentences, and (admit-wake only) the pre-S1 hint. */
  readonly message: string;
  readonly tokenLine: string;
  readonly reason: CapacityRefusalReason;
  readonly retryAfterS: number;
  readonly queuedAhead: number;
  readonly box: string | null;
  readonly live: number | null;
  readonly starting: number | null;
  readonly freeSlots: number | null;
  readonly needMib: number | null;
  readonly finalReport: { readonly offered: boolean; readonly why: FinalReportWhy };
};

export type WakeDecision =
  | { readonly decision: "not-needed" }
  | { readonly decision: "not-gated"; readonly why: string }
  | {
      readonly decision: "admitted" | "already-reserved";
      readonly key: string;
      readonly expiresAt: string;
    }
  | {
      readonly decision: "refused";
      readonly error: CapacityRefusedError;
      readonly refusal: WakeRefusal;
    };

type WakeClass = {
  readonly value: AdmissionClass;
  readonly source: "flag" | "env" | "inferred";
};

/**
 * The one mapping from who asks to a wake's admission class (§3.2's class table). `undefined` = not
 * gated and not logged: no class was sent and no agent identity is present — a shell outside any
 * agent, or an older atrium's runner, which strips the caller identity and sends no class (skew-safe).
 */
function wakeClassOf(request: WakeAdmissionRequest, env: NodeJS.ProcessEnv): WakeClass | undefined {
  if (request.flagClass !== undefined) {
    return { value: request.flagClass, source: "flag" };
  }
  const explicit = explicitClass?.value;
  if (explicit !== undefined) {
    return { value: explicit, source: "env" };
  }
  return hasAgentIdentity(env) ? { value: "spawn", source: "inferred" } : undefined;
}

type WakeContext = {
  readonly request: WakeAdmissionRequest;
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly cls: WakeClass;
  /** `automation` gets the gross figures; every other gated wake sizes as an agent (net of W). */
  readonly capacityClass: CapacityClass;
  readonly harness: Harness;
};

const MINUTE_MS = 60_000;

/**
 * Make-room instrumentation (§3.4, review #11): live owners by `now − last_used_at`. An
 * approximation — a long turn that started earlier reads "idle" — enough to decide §10(a) on data.
 * The three always sum to `live`; an unreadable `last_used_at` counts as recent.
 */
function idleFields(snapshot: CapacitySnapshot, nowMs: number): Record<string, number> {
  const counts = { liveRecent: 0, liveIdle2to5m: 0, liveIdleGe5m: 0 };
  for (const tree of snapshot.owners.trees) {
    const ageMs = nowMs - Date.parse(tree.facts?.lastUsedAt ?? "");
    if (ageMs >= 5 * MINUTE_MS) {
      counts.liveIdleGe5m += 1;
    } else if (ageMs >= 2 * MINUTE_MS) {
      counts.liveIdle2to5m += 1;
    } else {
      counts.liveRecent += 1;
    }
  }
  return counts;
}

/** Who asked, and for whom — the fixed part of every wake decision line (C12). */
function wakeIdentityFields(ctx: WakeContext): Record<string, unknown> {
  const { request } = ctx;
  return {
    target: request.target.id,
    targetSeat: request.target.seatId ?? null,
    verb: request.verb,
    class: ctx.cls.value,
    classSource: ctx.cls.source,
    ...(explicitClass && !explicitClass.value ? { invalidClass: explicitClass.raw } : {}),
    caller: ctx.env.ACPX_SESSION_URL ?? ctx.env.ACPX_SESSION_RECORD_ID ?? null,
    callerPid: process.pid,
    sender: request.sender ?? null,
    senderRole: request.senderRole ?? null,
    crossBox: request.crossBox === true,
    harness: ctx.harness,
  };
}

function wakeLogLine(
  ctx: WakeContext,
  decision: string,
  snapshot: CapacitySnapshot | undefined,
  extra: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const reading = snapshot
    ? {
        waiting: snapshot.waiting.count,
        ...snapshotFields(snapshot, ctx.harness),
        ...idleFields(snapshot, now.getTime()),
      }
    : {};
  return {
    ts: now.toISOString(),
    kind: "wake",
    decision,
    ...wakeIdentityFields(ctx),
    ...reading,
    ...extra,
  };
}

async function logWake(
  ctx: WakeContext,
  decision: string,
  snapshot: CapacitySnapshot | undefined,
  extra: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  await appendDecisionLog(ctx.dir, wakeLogLine(ctx, decision, snapshot, extra, now), now);
}

/**
 * §3.3 (review #13) — exactly the `sessions handover` shape, all three: the target is its seat's
 * ACTIVE holder; a LIVE owner holds the same seat with a LOWER ordinal (its predecessor, whose turn
 * runs the handover); the target has never had a turn. Mail to a retired holder, a later wake of an
 * active holder whose predecessor lingers, and an activation whose predecessor is dead are wakes.
 * Rows: "successor:" in test/capacity-wake.test.ts.
 */
export function isFreshSuccessor(target: WakeTarget, snapshot: CapacitySnapshot): boolean {
  const ordinal = target.holderOrdinal;
  if (target.holderActive !== true || target.lastPromptAt || !target.seatId) {
    return false;
  }
  return (
    ordinal !== undefined &&
    snapshot.owners.trees.some((tree) => {
      const facts = tree.facts;
      return (
        tree.sessionId !== target.id &&
        facts !== undefined &&
        facts.seatId === target.seatId &&
        facts.holderOrdinal !== undefined &&
        facts.holderOrdinal < ordinal
      );
    })
  );
}

function wakeNotGatedReason(ctx: WakeContext, snapshot: CapacitySnapshot): string | undefined {
  if (ctx.cls.source === "inferred" && !snapshot.owners.trees.some((tree) => tree.self)) {
    return "not-in-owner-tree";
  }
  if (isFreshSuccessor(ctx.request.target, snapshot)) {
    return "successor";
  }
  return snapshot.verdict === "unconfigured" || snapshot.verdict === "unmeasured"
    ? snapshot.verdict
    : undefined;
}

type WakeVerdict =
  | { readonly kind: "not-needed" }
  | { readonly kind: "not-gated"; readonly why: string }
  | { readonly kind: "already-reserved"; readonly entry: PendingEntry }
  | { readonly kind: "admitted"; readonly entry: PendingEntry }
  | { readonly kind: "refused"; readonly reason: CapacityRefusalReason };

/**
 * "Already reserved" (§3.2): a live, still-charged, unspent entry for this very session — a create's
 * first turn, an automation create's first prompt, atrium's route pre-admission before its runner's
 * prompt, or a second concurrent prompt to the same released session. Admitted without a new entry,
 * so one wake is charged once.
 */
function reservedFor(
  targetId: string,
  entries: readonly PendingEntry[],
  reservations: ReturnType<typeof reservationsOf>,
  liveIds: ReadonlySet<string>,
): PendingEntry | undefined {
  const { keptKeys } = partitionPending(reservations, liveIds);
  const keys = new Set(
    reservations
      .filter((r) => r.sessionId === targetId && !r.spent && keptKeys.has(r.key))
      .map((r) => r.key),
  );
  return entries.find((entry) => keys.has(entry.key));
}

type WakeReading = {
  readonly now: Date;
  readonly entries: readonly PendingEntry[];
  readonly reservations: ReturnType<typeof reservationsOf>;
  readonly snapshot: CapacitySnapshot;
  readonly liveIds: ReadonlySet<string>;
};

function judgeWake(ctx: WakeContext, reading: WakeReading): WakeVerdict {
  const { target } = ctx.request;
  const { snapshot } = reading;
  if (reading.liveIds.has(target.id)) {
    return { kind: "not-needed" };
  }
  const why = wakeNotGatedReason(ctx, snapshot);
  if (why !== undefined) {
    return { kind: "not-gated", why };
  }
  const reserved = reservedFor(target.id, reading.entries, reading.reservations, reading.liveIds);
  if (reserved) {
    return { kind: "already-reserved", entry: reserved };
  }
  if (!needMet(snapshot, 1)) {
    return { kind: "refused", reason: reasonOf(snapshot, ctx.harness) };
  }
  const entry = newEntry({
    key: `wake:${target.id}`,
    sessionId: target.id,
    harness: ctx.harness,
    bytes: snapshot.reserveNewBytes[ctx.harness],
    admissionClass: ctx.cls.value,
    origin: ctx.request.verb,
    now: reading.now,
    kind: "wake",
  });
  return { kind: "admitted", entry };
}

function wakeVerdictExtra(verdict: WakeVerdict): Record<string, unknown> {
  switch (verdict.kind) {
    case "not-gated":
      return { why: verdict.why };
    case "refused":
      return { reason: verdict.reason };
    case "admitted":
    case "already-reserved":
      return { key: verdict.entry.key };
    default:
      return {};
  }
}

/** Lock to unlock: read, decide, prune and write the ledger, log. Nothing slower happens here. */
async function decideWakeUnderLock(
  ctx: WakeContext,
): Promise<{ verdict: WakeVerdict; snapshot: CapacitySnapshot }> {
  const now = new Date();
  const sources = capacitySourcesFromEnv(ctx.env);
  const entries = liveEntries(await readLedgerFile(ctx.dir), now.getTime());
  const reservations = reservationsOf(entries, sources.sessionsDir);
  const snapshot = readCapacity({
    agent: ctx.harness,
    sources,
    pending: reservations,
    waiting: readWaiting(ctx.dir, now),
    admissionClass: ctx.capacityClass,
    now,
  });
  const liveIds = new Set(snapshot.owners.trees.map((tree) => tree.sessionId));
  const verdict = judgeWake(ctx, { now, entries, reservations, snapshot, liveIds });
  const { keptKeys } = partitionPending(reservations, liveIds);
  const kept = entries.filter((entry) => keptKeys.has(entry.key));
  if (verdict.kind === "admitted") {
    const others = kept.filter((entry) => entry.key !== verdict.entry.key);
    await writeLedgerFile(ctx.dir, [...others, verdict.entry]);
  } else if (kept.length !== entries.length) {
    await writeLedgerFile(ctx.dir, kept);
  }
  await logWake(ctx, verdict.kind, snapshot, wakeVerdictExtra(verdict), now);
  return { verdict, snapshot };
}

// ── The refusal text: written ONCE, here (CONCEPTION §5.1) ────────────────────────────────────────

const FINAL_REPORT_LINE =
  "acpx: only if you have finished your work, will do no further work, and will close yourself right after this send: send it with 'send-message.sh --final-report' instead — it is held and delivered when room frees. Orchestrators, and any agent that will keep working, must not use it.";
const NOT_FOR_YOU_LINE =
  "acpx: (--final-report is only for a finished agent's last message before it closes itself; you have open sub-sessions, so it is not for you.)";
const RETRY_LINE =
  "acpx: retry later — after one of your own sessions finishes, or after you close one you are done with — and never in a loop; 'acpx capacity --need 1' says when there is room.";
/** The pre-S1 hint (CONCEPTION §5.3; contract note 17:55Z): admit-wake's answer only, only when offered. */
export const PRE_S1_HINT = "(If your send-message.sh does not know --final-report, retry later.)";
const WAKE_BUSY_LINE =
  "acpx: other session starts held the box's admission lock for 5 s. Nothing was started or queued. Retry in a few seconds; 'acpx capacity' shows the room left.";

type WakeTextInput = {
  readonly reason: CapacityRefusalReason;
  readonly snapshot: CapacitySnapshot | undefined;
  readonly queuedAhead: number;
  readonly target: WakeTarget;
  readonly seatName: string | undefined;
  readonly harness: Harness;
  readonly senderRole: SenderRole | undefined;
  readonly crossBox: boolean;
  readonly finalReportSupported: boolean;
  readonly withHint: boolean;
};

/**
 * Line 4 (§5.1 a–c; contract note 17:55Z), in order: a busy lock offers nothing; no fresh capability
 * marker names nothing (an atrium that cannot hold the send must never be pointed at); no sender
 * role — atrium could not judge, or a bare `acpx prompt`, the orchestrator's verb (R2-1) — names
 * nothing; an orchestrator is told "not for you"; only a leaf is offered the flag.
 */
export function finalReportOffer(input: {
  readonly reason: CapacityRefusalReason;
  readonly finalReportSupported: boolean;
  readonly senderRole: SenderRole | undefined;
  readonly crossBox: boolean;
}): { offered: boolean; why: FinalReportWhy } {
  if (input.reason === "admission_busy") {
    return { offered: false, why: "admission-busy" };
  }
  if (!input.finalReportSupported) {
    return { offered: false, why: "no-capability" };
  }
  if (input.senderRole === undefined) {
    return { offered: false, why: "no-sender" };
  }
  if (input.senderRole === "orchestrator") {
    return { offered: false, why: "orchestrator" };
  }
  return { offered: true, why: input.crossBox ? "cross-box" : "leaf" };
}

function whoOf(target: WakeTarget, seatName: string | undefined): string {
  const session = `session ${target.id.slice(0, 8)}`;
  return seatName ? `${seatName} (${session})` : session;
}

function waitingTail(snapshot: CapacitySnapshot, queuedAhead: number): string {
  if (snapshot.class !== "spawn" || queuedAhead === 0) {
    return "";
  }
  const one = queuedAhead === 1;
  return ` ${queuedAhead} waiting item${one ? " takes" : "s take"} the next free slots first.`;
}

function wakeNoRoomLine(input: WakeTextInput, snapshot: CapacitySnapshot): string {
  const who = whoOf(input.target, input.seatName);
  const nothing = `Nothing was started or queued.${waitingTail(snapshot, input.queuedAhead)}`;
  if (input.reason === "memory_pressure") {
    return `acpx: no memory to wake ${who} right now: the box is stalling on memory (PSI full avg10 ${snapshot.pressure.psiFullAvg10 ?? "?"} %). ${nothing}`;
  }
  if (input.reason === "node_pressure") {
    return `acpx: no memory to wake ${who}: the box is borrowing above its memory request and the node it shares has too little left (${gib(snapshot.pressure.nodeAvailableBytes)} available). ${nothing}`;
  }
  const needMib = Math.round(snapshot.reserveNewBytes[input.harness] / MIB);
  return (
    `acpx: no memory to wake ${who}: it has no running agent process (released after idle, or ` +
    `stopped), and starting one needs ~${needMib} MiB the box does not have ` +
    `(${snapshot.owners.live} live, ${snapshot.owners.starting} starting; ` +
    `${gib(snapshot.chargedBytes)} charged of a ${gib(snapshot.budgetBytes)} budget). ${nothing}`
  );
}

function wakeRetryLine(input: WakeTextInput, snapshot: CapacitySnapshot): string {
  return input.crossBox
    ? `acpx: the recipient's box (${snapshot.box}) has no room right now; retry later, never in a loop — your own box's 'acpx capacity' cannot see it.`
    : RETRY_LINE;
}

function finalReportLine(why: FinalReportWhy, offered: boolean): string[] {
  if (offered) {
    return [FINAL_REPORT_LINE];
  }
  return why === "orchestrator" ? [NOT_FOR_YOU_LINE] : [];
}

function wakeSentences(
  input: WakeTextInput,
  offer: { offered: boolean; why: FinalReportWhy },
): string[] {
  const { snapshot } = input;
  if (input.reason === "admission_busy" || !snapshot) {
    return [WAKE_BUSY_LINE];
  }
  return [
    wakeNoRoomLine(input, snapshot),
    wakeRetryLine(input, snapshot),
    ...finalReportLine(offer.why, offer.offered),
  ];
}

/**
 * THE wake refusal (CONCEPTION §5.1, §5.2): line 1 = the v1 token line + `wake=<record id>`
 * (additive; `protocol=1`), then the sentences. The error is what `acpx prompt` throws (text mode
 * prints every line; JSON mode carries the sentences as `data.message`); `refusal` is what
 * `admit-wake` returns, whose `message` atrium's 503 relays byte for byte.
 */
export function wakeRefusal(input: WakeTextInput): {
  error: CapacityRefusedError;
  refusal: WakeRefusal;
} {
  const { snapshot, reason, queuedAhead } = input;
  const retryAfterS = retryAfterOf(reason);
  const tokenSnapshot = reason === "admission_busy" ? undefined : snapshot;
  const tokenLine = `acpx: REFUSED ${[...tokenFields(reason, tokenSnapshot, queuedAhead), `wake=${input.target.id}`].join(" ")}`;
  const offer = finalReportOffer(input);
  const sentence = wakeSentences(input, offer).join("\n");
  const hint = input.withHint && offer.offered ? `\n${PRE_S1_HINT}` : "";
  const error = new CapacityRefusedError({
    tokenLine,
    sentence,
    detail: {
      reason,
      nothingStarted: true,
      retryAfterS,
      queuedAhead,
      ...(tokenSnapshot ? { capacity: tokenSnapshot } : {}),
      message: sentence,
      wake: { sessionId: input.target.id, seatId: input.target.seatId ?? null },
      finalReport: offer,
    },
  });
  return {
    error,
    refusal: {
      message: `${tokenLine}\n${sentence}${hint}`,
      tokenLine,
      reason,
      retryAfterS,
      queuedAhead,
      ...refusalFigures(tokenSnapshot, input.harness),
      finalReport: offer,
    },
  };
}

type RefusalFigures = Pick<WakeRefusal, "box" | "live" | "starting" | "freeSlots" | "needMib">;

function refusalFigures(snapshot: CapacitySnapshot | undefined, harness: Harness): RefusalFigures {
  if (!snapshot) {
    return { box: null, live: null, starting: null, freeSlots: null, needMib: null };
  }
  return {
    box: snapshot.box,
    live: snapshot.owners.live,
    starting: snapshot.owners.starting,
    freeSlots: snapshot.freeSlots?.[harness] ?? 0,
    needMib: Math.round(snapshot.reserveNewBytes[harness] / MIB),
  };
}

async function refusedWake(
  ctx: WakeContext,
  reason: CapacityRefusalReason,
  snapshot: CapacitySnapshot | undefined,
  queuedAhead: number,
): Promise<WakeDecision> {
  let seatName: string | undefined;
  try {
    seatName = await ctx.request.seatName?.();
  } catch {
    seatName = undefined; // display-only: a label never changes a decision
  }
  const { error, refusal } = wakeRefusal({
    reason,
    snapshot,
    queuedAhead,
    target: ctx.request.target,
    seatName,
    harness: ctx.harness,
    senderRole: ctx.request.senderRole,
    crossBox: ctx.request.crossBox === true,
    finalReportSupported: finalReportSupported(ctx.dir),
    withHint: ctx.request.verb === "capacity admit-wake",
  });
  return { decision: "refused", error, refusal };
}

async function toWakeDecision(
  ctx: WakeContext,
  result: { verdict: WakeVerdict; snapshot: CapacitySnapshot },
): Promise<WakeDecision> {
  const { verdict, snapshot } = result;
  switch (verdict.kind) {
    case "not-needed":
      return { decision: "not-needed" };
    case "not-gated":
      return { decision: "not-gated", why: verdict.why };
    case "refused":
      return await refusedWake(ctx, verdict.reason, snapshot, snapshot.waiting.count);
    default:
      return {
        decision: verdict.kind,
        key: verdict.entry.key,
        expiresAt: verdict.entry.expiresAt,
      };
  }
}

async function decideWake(ctx: WakeContext): Promise<WakeDecision> {
  let result: { verdict: WakeVerdict; snapshot: CapacitySnapshot };
  try {
    result = await withAdmissionLock(ctx.dir, () => decideWakeUnderLock(ctx));
  } catch (error) {
    if (!(error instanceof AdmissionLockTimeoutError)) {
      failOpen("lock or ledger", error);
      return { decision: "not-gated", why: "fail-open" };
    }
    const waiting = readWaiting(ctx.dir);
    await logWake(ctx, "refused", undefined, { reason: "admission_busy", waiting: waiting.count });
    return await refusedWake(ctx, "admission_busy", undefined, waiting.count);
  }
  return await toWakeDecision(ctx, result);
}

/**
 * An authenticated human's wake (class `interactive`, §10 b): never gated, never held, never warned —
 * but logged with a LOCK-FREE reading (the `acpx capacity` probe path), so an over-budget human start
 * is visible (review #12). One census; the admission lock is never touched.
 */
async function admitInteractiveWake(ctx: WakeContext): Promise<WakeDecision> {
  const now = new Date();
  const snapshot = readCapacity({
    agent: ctx.harness,
    sources: capacitySourcesFromEnv(ctx.env),
    pending: await readPendingReservationsForProbe(ctx.env),
    waiting: readWaiting(ctx.dir, now),
    admissionClass: "spawn",
    now,
  });
  const measured = snapshot.verdict !== "unconfigured" && snapshot.verdict !== "unmeasured";
  await logWake(
    ctx,
    "not-gated",
    snapshot,
    {
      why: "interactive",
      overBudget: measured && (snapshot.freeSlotsInteractive?.[ctx.harness] ?? 0) < 1,
      guard: snapshot.bindingGuard?.[ctx.harness] ?? null,
    },
    now,
  );
  return { decision: "not-gated", why: "interactive" };
}

/**
 * Admit the wake of a session whose owner is not running, or refuse it. Never throws for a
 * decision: a refusal is `{decision: "refused", error, refusal}` — `sendSession` throws the error
 * (exit 75), `admit-wake` prints the refusal. The caller has already found no live or starting owner.
 */
export async function admitWake(
  request: WakeAdmissionRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WakeDecision> {
  const cls = wakeClassOf(request, env);
  if (cls === undefined) {
    return { decision: "not-gated", why: "no-class" };
  }
  const ctx: WakeContext = {
    request,
    env,
    dir: admissionDir(env),
    cls,
    capacityClass: cls.value === "automation" ? "automation" : "spawn",
    harness: newcomerHarness(request.target.agentCommand),
  };
  if (request.closedWithMessageId) {
    await logWake(ctx, "not-gated", undefined, { why: "closed" });
    return { decision: "not-gated", why: "closed" };
  }
  if (cls.value === "interactive") {
    return await admitInteractiveWake(ctx);
  }
  if (!readPodInfo(capacitySourcesFromEnv(env).podinfoDir).present) {
    await logWake(ctx, "not-gated", undefined, { why: "unconfigured" });
    return { decision: "not-gated", why: "unconfigured" }; // no lock on an unconfigured box (§3.3)
  }
  return await decideWake(ctx);
}
