import { admissionDir } from "../capacity/ledger.js";
import { readWaiting, type WaitingQueue } from "../capacity/waiting.js";
import type { CapacityRefusedError } from "../errors.js";
import { readAgentsFigures, WAITING_LINE_FACTOR } from "./pod-capacity.js";
import { agentCapRefusal } from "./pod-refusal.js";

/**
 * ⚠️ A MODULE OF ITS OWN, NOT PART OF `create-plan.ts`: that file is imported by the session record
 * parser, very low in the module graph, and these imports (`capacity/…`, the broker client) reach the
 * session store again — a cycle that surfaced as `Cannot access 'DURABLE_OVERLAY_FIELDS' before
 * initialization` in 37 unrelated test files (A9's first full suite). Keep `create-plan.ts` light.
 */

/**
 * C1.3: a record-only create is never refused for room. The one refusal is the box's waiting line
 * (`acpx: REFUSED reason=agent_cap … why=waiting-line`, C7.2): more sessions waiting for a pod than
 * {@link WAITING_LINE_FACTOR} × the cap. What waits is the waiting dir atrium publishes (a held message,
 * one item per session that needs a pod — the same queue `acpx capacity` lists); the cap is the
 * broker's (`GET /v1/agents`, block A9).
 *
 * ⚠️ IT FAILS OPEN, ON PURPOSE: a broker that does not answer cannot make a create refuse — "never
 * refused for capacity" is the rule and the line is its single exception, so only a line SEEN to be full
 * refuses. An empty queue never asks the broker at all (`test/pod-capacity.test.ts` holds both).
 */
export type WaitingLineRefusal = { live: number; cap: number; box: string };

export async function waitingLineRefusal(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; waiting?: WaitingQueue } = {},
): Promise<WaitingLineRefusal | undefined> {
  const env = options.env ?? process.env;
  const waiting = options.waiting ?? readWaiting(admissionDir(env));
  if (waiting.count === 0) {
    return undefined;
  }
  const figures = await readAgentsFigures(env, options.fetchImpl);
  if (!figures.ok || waiting.count <= WAITING_LINE_FACTOR * figures.agents.cap) {
    return undefined;
  }
  return { live: figures.agents.live, cap: figures.agents.cap, box: figures.box };
}

/**
 * The C7.2 line for that one refusal — exit 75 (`CAPACITY`), line 1 the machine token, line 2 one
 * sentence; nothing was created. A `CapacityRefusedError`, so the token also reaches STDERR in
 * `--format json` mode, where atrium reads it (a plain operational error prints it only inside the JSON).
 */
export function waitingLineRefusalError(refusal: WaitingLineRefusal): CapacityRefusedError {
  return agentCapRefusal({ ...refusal, why: "waiting-line" });
}

/** C1.3 — the create gate in pod mode: never "no room", only the waiting line. */
export async function admitRecordOnlyCreate(): Promise<void> {
  const refusal = await waitingLineRefusal();
  if (refusal) {
    throw waitingLineRefusalError(refusal);
  }
}
