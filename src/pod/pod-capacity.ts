import { type Harness, HARNESSES } from "../capacity/constants.js";
import { verdictFor, type Verdict } from "../capacity/formula.js";
import { ACPX_FEATURES, type CapacityClass } from "../capacity/reading.js";
import { NO_WAITING, type WaitingQueue } from "../capacity/waiting.js";
import {
  type BrokerAgentsSnapshot,
  boxOfNamespace,
  getAgents,
  namespaceFromSources,
  readAgentBrokerOriginSources,
  resolveAgentBrokerOrigin,
} from "./broker-client.js";
import type { AgentPlacement } from "./broker-client.js";
import { type BoxFacts, isHomeOnlyHarness, readBoxFacts } from "./home-only.js";
import { podMode, thisPodFile } from "./placement.js";
import type { AgentCapWhy } from "./pod-refusal.js";

/**
 * Block A9 — capacity in the pod plane (C7, C4's `GET /v1/agents`). In pod mode the room for another
 * agent is not the control pod's memory: it is the broker's cap, the namespace's pod quota and — for a
 * harness that is home-only on this box — the home cap. `acpx capacity`, `admit-wake` and `--need`
 * answer from ONE read of the broker, and no number is decided here: `live`, `cap`, `reserve`, the
 * quota and the home cap are the broker's (D2 sets them per box); the only constant below is C7.2's
 * waiting-line factor, which the contract names as its start value.
 *
 * ⚠️ WHAT THIS DOES NOT DO: it never reads the control pod's cgroup, `/etc/podinfo`, the process table
 * or the admission ledger. A pod's memory is the cluster's concern (scheduling plus the quota); a
 * reservation ledger for pods would be a second source of truth beside the broker. `acpx capacity
 * --need-build` is the exception that stays local — a release build runs on the control pod.
 */

/** C7.2 start value: the line is full when more sessions wait than 2 × the cap (set at milestone 3). */
export const WAITING_LINE_FACTOR = 2;

/** Pod mode, on the control pod: the one place whose capacity verbs answer from the broker. */
export function isControlPlaneInPodMode(): boolean {
  return podMode().mode === "pod" && thisPodFile().kind === "absent";
}

export type AgentsFigures =
  | { readonly ok: true; readonly agents: BrokerAgentsSnapshot; readonly box: string }
  | { readonly ok: false; readonly detail: string; readonly box: string };

/**
 * One `GET /v1/agents`. Never throws: a broker that does not answer is `ok: false`. `exclude` is the bare pod key of
 * the session being woken (the wake gate only): its own starting Job is left out of the figures. The target-less
 * probes (`capacity`, `--need`, the waiting line, the utility branch) pass none and send no query.
 */
export async function readAgentsFigures(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  exclude?: string,
): Promise<AgentsFigures> {
  const sources = readAgentBrokerOriginSources();
  const box = boxOfNamespace(namespaceFromSources(sources));
  const origin = resolveAgentBrokerOrigin(env, sources);
  if (!origin) {
    return { ok: false, detail: "no broker address", box };
  }
  const answer = await getAgents({ origin, fetchImpl, exclude });
  return answer.ok
    ? { ok: true, agents: answer.agents, box }
    : { ok: false, detail: answer.detail, box };
}

export type PodRoom = {
  /** New sessions of the harness that fit now — net of what waits first, for class `spawn`. */
  readonly slots: number;
  /** The same before the waiting items are taken off. */
  readonly gross: number;
  /** What binds when `gross` is 0 (`cap` also when only the waiting items take the last slot). */
  readonly why: AgentCapWhy | undefined;
  readonly room: { readonly cap: number; readonly quota: number; readonly home: number | null };
  /** Where the broker will put the pod — the home cap binds exactly when this is `home`. */
  readonly placedAt: "pool" | "home";
  /** The harness is home-only on this box, from the SAME box facts `placedAt` was computed with. */
  readonly homeOnly: boolean;
};

/**
 * What acpx asks the broker for (A-45): `home` for a home-only harness, `auto` otherwise.
 * ⚠️ THE SAME READER AS A SESSION'S PLACEMENT (`routed-branches.ts` `sessionTarget`) AND A ONE-SHOT'S POD KEY
 * (`utility-branch.ts`): `readBoxFacts` over the process env, which also reads the release-pins file on the
 * control (P1). A capacity answer that read the box differently would report room under the wrong cap.
 * Rows: `test/pod-capacity.test.ts` → "P1: capacity and placement agree after a file flip …".
 */
export function placementAsked(harness: Harness, box: BoxFacts = readBoxFacts()): AgentPlacement {
  return isHomeOnlyHarness(harness, box) ? "home" : "auto";
}

/**
 * WHERE THE BROKER WILL PUT THE POD (A-49, `broker.py` `target_for`): everything goes home while it forces
 * `placement.forced = "home"` — `pool` requests included; `auto` goes home while the pool template is not
 * usable (`pool.state ≠ ready`), else to the pool; an explicit `home` or `pool` stays as asked.
 * ⚠️ THE CAPACITY ANSWER MUST NEVER REPORT ROOM THE BROKER WILL REFUSE FOR THIS PLACEMENT: the home cap
 * binds every request placed home, whatever harness it is. Rows: `test/pod-capacity.test.ts` "A-49".
 */
export function placedAt(agents: BrokerAgentsSnapshot, asked: AgentPlacement): "pool" | "home" {
  if (agents.placement.forced === "home") {
    return "home";
  }
  if (asked === "auto") {
    return agents.pool.state === "ready" ? "pool" : "home";
  }
  return asked;
}

/**
 * C4: a request of any class but `interactive` is refused at `live ≥ cap − reserve`; the namespace's
 * quota counts pods; a request placed home also needs room under the home cap. The binding one names the
 * `why` of C7.2's `agent_cap` line. `spawn` slots are net of the items waiting for room (they start
 * first, as in `readCapacity`); `automation` is gross.
 */
export function podRoom(
  agents: BrokerAgentsSnapshot,
  options: {
    harness: Harness;
    admissionClass: CapacityClass | "interactive";
    waitingCount: number;
    /** What the request asks for; default: what acpx asks for this harness (`placementAsked`). */
    asked?: AgentPlacement;
    /** This box's facts, read ONCE by the caller for a whole answer; default: read now. */
    box?: BoxFacts;
  },
): PodRoom {
  const box = options.box ?? readBoxFacts();
  const reserve = options.admissionClass === "interactive" ? 0 : agents.reserve;
  const cap = agents.cap - reserve - agents.live;
  const quota = agents.quota.hard - agents.quota.used;
  const target = placedAt(agents, options.asked ?? placementAsked(options.harness, box));
  const home = target === "home" ? agents.home.cap - agents.home.live : null;
  const gross = Math.max(0, Math.min(cap, quota, home ?? Number.POSITIVE_INFINITY));
  const deduction = options.admissionClass === "spawn" ? options.waitingCount : 0;
  const slots = Math.max(0, gross - deduction);
  return {
    slots,
    gross,
    why: slots > 0 ? undefined : whyOf(gross, cap, quota),
    room: { cap, quota, home },
    placedAt: target,
    homeOnly: isHomeOnlyHarness(options.harness, box),
  };
}

/** The binding limit when nothing fits; `cap` also when only the items already waiting take the room. */
function whyOf(gross: number, cap: number, quota: number): AgentCapWhy {
  if (gross > 0 || cap <= 0) {
    return "cap";
  }
  return quota <= 0 ? "quota" : "home_full";
}

const WHY_SENTENCE: Record<AgentCapWhy, string> = {
  cap: "the box's agent cap is reached",
  quota: "the box's pod quota is used up",
  "pool-at-maximum": "the agent pool is at its maximum",
  home_full: "the home machine's cap for home-only harnesses is reached",
  "waiting-line": "the line of sessions waiting for a pod is full",
};

/** The reason a `--need N` verdict prints, with the broker's own figures. */
export function podNeedReason(
  agents: BrokerAgentsSnapshot,
  harness: Harness,
  need: number,
  room: PodRoom,
): string {
  const figures =
    `live ${agents.live} of cap ${agents.cap} (${agents.reserve} kept for people), ` +
    `quota ${agents.quota.used}/${agents.quota.hard}, home ${agents.home.live}/${agents.home.cap}`;
  const why = room.why === undefined ? "" : ` — ${WHY_SENTENCE[room.why]}`;
  return `${room.slots} new ${harness} session(s) fit; ${need} needed (${figures})${why}${homePlacementClause(agents, room)}`;
}

/** Said only when the pod goes home although the harness could use the pool: the home cap binds it, and why. */
function homePlacementClause(agents: BrokerAgentsSnapshot, room: PodRoom): string {
  if (room.placedAt !== "home" || room.homeOnly) {
    return "";
  }
  return agents.placement.forced === "home"
    ? "; the broker forces every pod home, so the home cap applies"
    : `; the pool is not ready (${agents.pool.state}), so the broker places it home and the home cap applies`;
}

export function podNeedMet(room: PodRoom, need: number): boolean {
  return room.slots >= need;
}

export type PodCapacitySnapshot = {
  readonly action: "capacity";
  readonly schema: 1;
  readonly features: readonly string[];
  readonly box: string;
  readonly class: CapacityClass;
  readonly waiting: WaitingQueue;
  readonly measuredAt: string;
  readonly agent: Harness;
  /** The plane the figures come from; the control pod's memory basis does not apply. */
  readonly basis: "pod";
  readonly verdict: Verdict;
  readonly freeSlots: Record<Harness, number>;
  readonly freeSlotsInteractive: Record<Harness, number>;
  /** There is no make-room step in the pod plane: the same as `freeSlots`. */
  readonly slotsAfterMakeRoom: Record<Harness, number>;
  readonly bindingGuard: Record<Harness, AgentCapWhy | null>;
  /** Where the broker will put a pod of each harness (A-49): the home cap binds those placed home. */
  readonly placedAt: Record<Harness, "pool" | "home">;
  readonly pod: BrokerAgentsSnapshot;
  readonly warnings: readonly string[];
};

function perHarness<T>(read: (harness: Harness) => T): Record<Harness, T> {
  return Object.fromEntries(HARNESSES.map((harness) => [harness, read(harness)])) as Record<
    Harness,
    T
  >;
}

export function podCapacitySnapshot(input: {
  agents: BrokerAgentsSnapshot;
  box: string;
  agent: Harness;
  admissionClass: CapacityClass;
  waiting?: WaitingQueue;
  now?: Date;
  /** This box's facts for the whole answer; default: read once, now. */
  boxFacts?: BoxFacts;
}): PodCapacitySnapshot {
  const waiting = input.waiting ?? NO_WAITING;
  // ONE read for the whole answer: a release-pins file flipping mid-answer must not split it.
  const box = input.boxFacts ?? readBoxFacts();
  const rooms = perHarness((harness) =>
    podRoom(input.agents, {
      harness,
      admissionClass: input.admissionClass,
      waitingCount: waiting.count,
      box,
    }),
  );
  const interactive = perHarness(
    (harness) =>
      podRoom(input.agents, { harness, admissionClass: "interactive", waitingCount: 0, box }).slots,
  );
  const freeSlots = perHarness((harness) => rooms[harness].slots);
  return {
    action: "capacity",
    schema: 1,
    features: ACPX_FEATURES,
    box: input.box,
    class: input.admissionClass,
    waiting,
    measuredAt: (input.now ?? new Date()).toISOString(),
    agent: input.agent,
    basis: "pod",
    verdict: verdictFor(freeSlots[input.agent], interactive[input.agent]),
    freeSlots,
    freeSlotsInteractive: interactive,
    slotsAfterMakeRoom: freeSlots,
    bindingGuard: perHarness((harness) => rooms[harness].why ?? null),
    placedAt: perHarness((harness) => rooms[harness].placedAt),
    pod: input.agents,
    warnings: [],
  };
}

/** The text form: what binds, in the broker's numbers, then the pool's state. */
export function renderPodCapacityLines(snapshot: PodCapacitySnapshot): string[] {
  const { pod, agent } = snapshot;
  const slots = snapshot.freeSlots[agent];
  const bound = snapshot.bindingGuard[agent];
  return [
    `${snapshot.box} · pod plane (the broker's live figures; the control pod's memory does not apply)`,
    `${snapshot.verdict}: ${slots} new ${agent} session${slots === 1 ? "" : "s"} ` +
      `(live ${pod.live} of cap ${pod.cap}; ${pod.reserve} kept for people; quota ${pod.quota.used}/${pod.quota.hard}; ` +
      `home ${pod.home.live}/${pod.home.cap}; bound by ${bound ?? "none"})`,
    `pool: ${pod.pool.state}`,
  ];
}
