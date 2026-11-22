import { InvalidArgumentError, type Command } from "commander";
import { lockHostPlace } from "../pod/identity.js";
import { placeOf, readPodFileWithWitness } from "../pod/placement.js";
import {
  answerScreenLease,
  SCREEN_LEASE_DEFAULT_TTL_S,
  type ScreenLeaseAnswer,
} from "../pod/screen-lease.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { requireExplicitSessionRecord } from "./session-selector.js";

/**
 * `acpx __screen-lease --session-id <record id> --ttl-s <n>` — C12.1 (A-30, block A12). HIDDEN, like
 * `__queue-owner`: its only caller is the atrium server. Class `owner-if-pod` (`src/pod/command-classes.ts`):
 * on the control pod it is the routed call when the API server shows a pod for the key and otherwise
 * runs HERE, where it answers `no_pod` from the record; in the session's own pod it runs here and
 * answers `leased` / `no_terminal`. It never asks the broker, never talks to the owner, and writes
 * only the pod-local lease file (`src/pod/screen-lease.ts`).
 *
 * ⚠️ THE VERB IS `argv[1]` — NO OPTION BEFORE IT. The pod's ssh entry recognises a lease call by
 * `argv[1]` and marks it `view=1` so the idle loop never counts it (IM6). A call with an option in
 * front would be an ordinary call there, so a viewer would keep a pod alive; acpx therefore refuses
 * that shape instead of accepting it silently (`test/pod-screen-lease.test.ts`).
 *
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS: this one, and `"__screen-lease"` in
 * `TOP_LEVEL_VERBS` (`src/cli-core.ts`) — plus its class and grammar rows (`command-classes.ts`,
 * `command-grammar.ts`), in the same commit.
 */

export const SCREEN_LEASE_VERB = "__screen-lease";

type ScreenLeaseFlags = { sessionId?: string; ttlS?: number };

function parseTtlS(value: string): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new InvalidArgumentError("--ttl-s must be a whole number of seconds");
  }
  return Number(value);
}

/** The verb must be the first argument acpx received: `process.argv[2]`, i.e. commander's `rawArgs[2]`. */
function refuseOptionBeforeVerb(command: Command): void {
  // commander keeps the argv it parsed on the root as `rawArgs` (public at runtime, absent from its typings).
  const rawArgs = (command.parent as { rawArgs?: string[] } | null)?.rawArgs ?? process.argv;
  if (rawArgs[2] !== SCREEN_LEASE_VERB) {
    throw new InvalidArgumentError(
      `${SCREEN_LEASE_VERB} must be the first argument — an option before it is refused (the pod's entry recognises a lease call by argv[1])`,
    );
  }
}

async function handleScreenLease(
  flags: ScreenLeaseFlags,
  command: Command,
  config: ResolvedAcpxConfig,
) {
  refuseOptionBeforeVerb(command);
  if (flags.sessionId === undefined) {
    throw new InvalidArgumentError(`${SCREEN_LEASE_VERB} needs --session-id <record id>`);
  }
  const record = await requireExplicitSessionRecord(
    { sessionId: flags.sessionId },
    config.defaultAgent,
  );
  // Only a host that is in an agent pod has a place to read; a workbench, a rig or a suite is "control".
  const place =
    lockHostPlace() === "agent-pod"
      ? placeOf(readPodFileWithWitness(), record.acpxRecordId)
      : "control";
  if (place === "other-pod") {
    // The placement step passes such a call through; reaching here means it was bypassed.
    throw new Error(
      `${SCREEN_LEASE_VERB}: session ${record.acpxRecordId} is not this pod's session — nothing was written`,
    );
  }
  const answer: ScreenLeaseAnswer = answerScreenLease({
    recordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId ?? "",
    agentCommand: record.agentCommand ?? "",
    ttlS: flags.ttlS ?? SCREEN_LEASE_DEFAULT_TTL_S,
    place,
    now: Date.now(),
  });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

export function registerScreenLeaseCommand(parent: Command, config: ResolvedAcpxConfig): void {
  parent
    .command(SCREEN_LEASE_VERB, { hidden: true })
    .description("Hold or renew the screen lease of a terminal session (atrium only; C12.1)")
    .option("--session-id <id>", "The session's record id")
    .option("--ttl-s <seconds>", "The lease's life, clamped to 5-120 (default 30)", parseTtlS)
    .action(async function (this: Command, flags: ScreenLeaseFlags) {
      await handleScreenLease(flags, this, config);
    });
}
