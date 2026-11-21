import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueKeyForSession } from "../cli/queue/paths.js";
import { isControlPod } from "../config/control-pod.js";

/**
 * C1.1 — the switch and "where am I" (CONTRACTS-r4 C1.1, brick b479441f).
 *
 * ⚠️ THIS MODULE IS LOADED BEFORE THE REST OF ACPX (`src/cli.ts`), so its import graph must stay
 * light: node builtins, `config/control-pod.ts`, `cli/queue/paths.ts`. A heavy import here is paid by
 * every acpx invocation on the box and defeats "route before loading the world" (CONCEPTION r4 §12).
 * Held by `test/pod-command-classes.test.ts` ("the light graph").
 */

export const OWNER_PLACEMENT_ENV = "ACPX_OWNER_PLACEMENT";
export const OWNER_PLACEMENT_POD = "pod";
/** The box's canonical home; the state home in use must be `<this>/.acpx`. */
export const CANONICAL_HOME = "/home/node";
/** The file an agent pod owns: it holds the pod's hostname, `ag-<key>` (C1.1, C8). */
export const AGENT_POD_FILE_NAME = ".nv-agent";
/**
 * TEST SEAM (C1.1 A-6): `ACPX_POD_TEST_HOME=<dir>` stands in for `/home/node` — the canonical
 * state home is `<dir>/.acpx`, the place file is `<dir>/.nv-agent`, and the host counts as
 * control-role; the pod's identity still comes from `NV_POD_*` as in production. It can only lead
 * into a sandbox: with the seam set, a state home outside `<dir>` refuses (`podModeVerdict`), so the
 * seam never changes how the real `/home/node/.acpx` is treated.
 *
 * ⚠️ HONOURED ONLY UNDER `node --test` (`NODE_TEST_CONTEXT`). DO NOT "simplify" this to read the
 * variable unconditionally: on a box that would let any process declare a temp dir canonical and
 * the host control-role. Held by `test/pod-placement.test.ts` ("the seam is honoured only under
 * node --test").
 */
export const TEST_HOME_ENV = "ACPX_POD_TEST_HOME";

/** The pod identity C1.1 requires (A-5): the downward API and the service-account namespace. */
export const POD_NAME_ENV = "NV_POD_NAME";
export const POD_UID_ENV = "NV_POD_UID";
export const NODE_NAME_ENV = "NV_NODE_NAME";
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
/** A5's seam for the service-account directory (`src/pod/identity.ts` on ap/a5-pod-lock). */
export const POD_SA_DIR_ENV = "ACPX_POD_SA_DIR";

export type Place = "control" | "own-pod" | "other-pod";

/**
 * `pod`: pod mode. `off`: today's behaviour, byte-identical. `refuse`: the switch is honoured on this
 * host but the pod identity is missing — fail-closed, neither mode (C1.1 amendment, program HoD
 * 2026-11-21: a control-pod lock holder without a `pod` field is judged breakable by an agent pod at
 * once — the spike's 8–49 ms takeover).
 */
export type PodModeVerdict =
  | { mode: "pod" }
  | { mode: "off"; why: "switch-unset" | "not-control-role" | "non-canonical-state-home" }
  | { mode: "refuse"; reason: "pod_identity_missing" | "test_seam_outside_sandbox" };

/** What the switch is decided from; injectable so each rule has a test that needs no box. */
export type HostFacts = {
  env: NodeJS.ProcessEnv;
  controlRole: boolean;
  homedir: string;
};

function testHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NODE_TEST_CONTEXT === undefined) {
    return undefined;
  }
  const seam = env[TEST_HOME_ENV]?.trim();
  return seam ? seam : undefined;
}

export function canonicalHome(env: NodeJS.ProcessEnv = process.env): string {
  return testHome(env) ?? CANONICAL_HOME;
}

/** A path with symlinks resolved where it exists (C1.1 A-5 compares the state home "resolved"). */
function resolvedPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The home acpx's state lives under — exactly how every state-path resolver reads it. */
export function stateHome(facts: HostFacts): string {
  return facts.env.ACPX_STATE_HOME || facts.homedir;
}

/**
 * C1.1 (with A-5, A-6): `ACPX_OWNER_PLACEMENT=pod` is honoured only when the host is control-role
 * AND the state home in use resolves to the canonical one (`/home/node/.acpx`; an `ACPX_STATE_HOME`
 * that resolves there stays in pod mode) AND the process can name its pod. With the first two and
 * no pod identity: `refuse` — never either mode. Anything else — a workbench, a suite, a rig —
 * behaves as today.
 */
export function podModeVerdict(facts: HostFacts): PodModeVerdict {
  if (facts.env[OWNER_PLACEMENT_ENV] !== OWNER_PLACEMENT_POD) {
    return { mode: "off", why: "switch-unset" };
  }
  const seam = testHome(facts.env);
  if (!facts.controlRole && seam === undefined) {
    return { mode: "off", why: "not-control-role" };
  }
  const home = resolvedPath(stateHome(facts));
  if (home !== resolvedPath(canonicalHome(facts.env))) {
    // Under the seam a state home outside the sandbox refuses: the seam leads only into it.
    return seam === undefined
      ? { mode: "off", why: "non-canonical-state-home" }
      : { mode: "refuse", reason: "test_seam_outside_sandbox" };
  }
  if (!podIdentityComplete(facts.env)) {
    return { mode: "refuse", reason: "pod_identity_missing" };
  }
  return { mode: "pod" };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function serviceAccountNamespace(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.NODE_TEST_CONTEXT ? nonEmpty(env[POD_SA_DIR_ENV]) : undefined;
  try {
    return nonEmpty(
      fs.readFileSync(path.join(override ?? SERVICE_ACCOUNT_DIR, "namespace"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/**
 * C1.1 A-5: the process can name its pod — `NV_POD_NAME`, `NV_POD_UID`, `NV_NODE_NAME` and the
 * service-account namespace file, every one present and non-blank. ⚠️ THE ONE PLACE A1 reads the
 * identity; once A5's `src/pod/identity.ts` is on `agent-pods` this delegates to it (A5 reads the
 * same sources with the same `ACPX_POD_SA_DIR` seam, but treats node and namespace as optional —
 * the switch requires all four).
 */
export function podIdentityComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    nonEmpty(env[POD_NAME_ENV]) !== undefined &&
    nonEmpty(env[POD_UID_ENV]) !== undefined &&
    nonEmpty(env[NODE_NAME_ENV]) !== undefined &&
    serviceAccountNamespace(env) !== undefined
  );
}

function liveHostFacts(env: NodeJS.ProcessEnv): HostFacts {
  return { env, controlRole: isControlPod(env), homedir: os.homedir() };
}

let memoVerdict: PodModeVerdict | undefined;

/** Decided once per process (C1.1). The switch is read first, so pod-off reads nothing else. */
export function podMode(): PodModeVerdict {
  if (memoVerdict === undefined) {
    const env = process.env;
    memoVerdict =
      env[OWNER_PLACEMENT_ENV] === OWNER_PLACEMENT_POD
        ? podModeVerdict(liveHostFacts(env))
        : { mode: "off", why: "switch-unset" };
  }
  return memoVerdict;
}

export function isPodMode(): boolean {
  return podMode().mode === "pod";
}

/**
 * What `.nv-agent` says about this process's pod: `absent` (the control pod), the pod name it
 * holds, or `unreadable`. ⚠️ ONLY ENOENT IS "ABSENT". A file that exists but cannot be read, or is
 * empty, is NOT the control pod: reading it as one would make an agent pod act as the control pod
 * (open routed calls, write the box-wide stores). It is "another agent pod" — the fail-safe side.
 */
export type AgentPodFile =
  | { kind: "absent" }
  | { kind: "pod"; name: string }
  | { kind: "unreadable" };

export function readAgentPodFile(file: string): AgentPodFile {
  try {
    const name = fs.readFileSync(file, "utf8").trim();
    return name ? { kind: "pod", name } : { kind: "unreadable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
}

export function agentPodFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(canonicalHome(env), AGENT_POD_FILE_NAME);
}

let memoPodFile: AgentPodFile | undefined;

/** Read once per process (C1.1). */
export function thisPodFile(): AgentPodFile {
  memoPodFile ??= readAgentPodFile(agentPodFilePath());
  return memoPodFile;
}

/** The session key: SHA-256 hex of the session id, first 24 chars — the lease's key (C2, C3.1). */
export function sessionKey(sessionId: string): string {
  return queueKeyForSession(sessionId);
}

export function agentPodName(sessionId: string): string {
  return `ag-${sessionKey(sessionId)}`;
}

/**
 * C1.1's three places. `targetSessionId` is the record id of the session the command is about;
 * absent (no target, or not yet resolved) can never be "own pod".
 */
export function placeOf(podFile: AgentPodFile, targetSessionId: string | undefined): Place {
  if (podFile.kind === "absent") {
    return "control";
  }
  if (
    podFile.kind === "pod" &&
    targetSessionId !== undefined &&
    podFile.name === agentPodName(targetSessionId)
  ) {
    return "own-pod";
  }
  return "other-pod";
}

/**
 * The tripwire behind C1.2's "nothing starts a bridge on a control-role host in pod mode". The
 * placement step routes every bridge-starting class away from the control pod; this is the second,
 * independent line at the two spawn sites (the adapter: `AcpClient.spawnAgentProcess`; the owner:
 * `spawnQueueOwnerProcess`), so a command whose class is WRONG still cannot start one there.
 * Pod-identity refusal counts too (fail-closed). Outside pod mode it is a no-op.
 *
 * ⚠️ NO BYPASS FLAG. Held by `test/pod-placement.test.ts` ("the spawn tripwire").
 */
export class BridgeOnControlPodError extends Error {
  readonly stderrLine: string;
  constructor(what: "adapter" | "owner") {
    const line = `acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=${what}`;
    super(
      `${line}\nIn pod mode nothing starts an agent ${what} on the control pod; this command reached a spawn site it must not.`,
    );
    this.stderrLine = line;
  }
}

export function assertBridgeMayStartHere(what: "adapter" | "owner"): void {
  if (podMode().mode !== "off" && thisPodFile().kind === "absent") {
    throw new BridgeOnControlPodError(what);
  }
}
