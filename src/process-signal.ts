import {
  identityScope,
  observeProcessIncarnation,
  type ProcessBirthIdentity,
} from "./process-identity.js";

/**
 * THE one way acpx signals a RECORDED pid (brick ae547131 §8.0) — a queue owner from its lease, an
 * adapter from `record.pid`. Every SIGTERM, every SIGKILL escalation and every group sweep goes
 * through here, so "is this number still the process we recorded?" is asked in exactly one place,
 * immediately before each `process.kill`.
 *
 * It refuses unless the identity is present, its scope is LOCAL (same boot, pid namespace and time
 * namespace as this reader), and `observeProcessIncarnation` says `matching` right now. Upstream's
 * analogue is `dispatchVerifiedQueueOwnerSignal` (openclaw/acpx c4f3a9d1, 44a0a18e).
 *
 * 🛑 DO NOT ADD A "pid is alive and looks like node" FALLBACK. That was `isLikelyMatchingProcess`,
 * which matched any process with a `node` argv entry and returned TRUE when /proc could not be read
 * — after a container restart it signalled whatever now held the number (atrium, another agent).
 * No identity ⇒ no signal (`test/close-adapter-kill.test.ts`, T32a).
 */
export type VerifiedSignalOutcome =
  | "signalled"
  | "gone"
  | "refused:no-identity"
  | "refused:foreign"
  | "refused:unverified";

function refusalForScope(
  identity: ProcessBirthIdentity | undefined,
): VerifiedSignalOutcome | undefined {
  if (!identity) {
    return "refused:no-identity";
  }
  const scope = identityScope(identity);
  if (scope === "unverified") {
    return "refused:unverified";
  }
  // `other-boot` is allowed through: its observation is `gone`, never a signal.
  return scope === "local" || scope === "other-boot" ? undefined : "refused:foreign";
}

export function signalVerifiedProcess(
  pid: number,
  identity: ProcessBirthIdentity | undefined,
  signal: NodeJS.Signals,
): VerifiedSignalOutcome {
  const refused = refusalForScope(identity);
  if (refused !== undefined) {
    return refused;
  }
  const incarnation = observeProcessIncarnation(pid, identity as ProcessBirthIdentity);
  if (incarnation === "gone") {
    return "gone";
  }
  if (incarnation !== "matching") {
    return "refused:unverified";
  }
  try {
    process.kill(pid, signal);
    return "signalled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "refused:unverified";
  }
}

const EXIT_POLL_MS = 50;

/** True once `identity` is no longer `matching` at `pid` (it exited, or the number moved on). */
export async function waitForIdentityExit(
  pid: number,
  identity: ProcessBirthIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (observeProcessIncarnation(pid, identity) !== "matching") {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
}

export type VerifiedTerminateOutcome = {
  /** The process was verified and signalled at least once. */
  signalled: boolean;
  /** It is provably no longer that process (exited, or was never it). */
  gone: boolean;
  /** Why nothing was signalled, when nothing was. */
  refused?: Exclude<VerifiedSignalOutcome, "signalled" | "gone">;
};

/**
 * SIGTERM → grace → RE-VERIFY → SIGKILL → grace, each signal through {@link signalVerifiedProcess}.
 * The re-verify before SIGKILL is the point: a process that exited during the grace frees its pid
 * number, and the escalation must not land on whatever took it.
 */
export async function terminateVerifiedProcess(
  pid: number,
  identity: ProcessBirthIdentity | undefined,
  graceMs: number,
): Promise<VerifiedTerminateOutcome> {
  const term = signalVerifiedProcess(pid, identity, "SIGTERM");
  if (term !== "signalled") {
    return term === "gone"
      ? { signalled: false, gone: true }
      : { signalled: false, gone: false, refused: term };
  }
  const verified = identity as ProcessBirthIdentity;
  if (await waitForIdentityExit(pid, verified, graceMs)) {
    return { signalled: true, gone: true };
  }
  const kill = signalVerifiedProcess(pid, verified, "SIGKILL");
  if (kill === "gone") {
    return { signalled: true, gone: true };
  }
  return { signalled: true, gone: await waitForIdentityExit(pid, verified, graceMs) };
}
