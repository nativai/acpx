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
 * TEST-ONLY SEAM. Names the directory treated as the canonical home in place of `/home/node` —
 * both for the canonical-home rule and for where `.nv-agent` is read — so a test makes "control-role
 * host with the canonical state home" true by the code's own design (COMMON.md, precedent
 * `ACPX_OS_COMPAT_LINK`, brick 78623030).
 *
 * ⚠️ HONOURED ONLY UNDER `node --test` (`NODE_TEST_CONTEXT`). DO NOT "simplify" this to read the
 * variable unconditionally: on a box that would let any process declare a temp dir canonical and
 * switch pod mode on outside the canonical home, which C1.1 forbids. Held by
 * `test/pod-placement.test.ts` ("the seam is ignored outside node --test").
 */
export const TEST_CANONICAL_HOME_ENV = "ACPX_TEST_POD_CANONICAL_HOME";

export type Place = "control" | "own-pod" | "other-pod";

/**
 * `pod`: pod mode. `off`: today's behaviour, byte-identical. `refuse`: the switch is honoured on this
 * host but the pod identity is missing — fail-closed, neither mode (C1.1 amendment, program HoD
 * 2026-11-21: a control-pod lock holder without a `pod` field is judged breakable by an agent pod at
 * once — the spike's 8–49 ms takeover).
 */
export type PodModeVerdict =
  | { mode: "pod" }
  | {
      mode: "off";
      why: "switch-unset" | "not-control-role" | "state-home-override" | "non-canonical-home";
    }
  | { mode: "refuse"; reason: "pod_identity_missing" };

/** The downward-API pod uid (C3.1/C8). */
export const POD_UID_ENV = "NV_POD_UID";

/** What the switch is decided from; injectable so each rule has a test that needs no box. */
export type HostFacts = {
  env: NodeJS.ProcessEnv;
  controlRole: boolean;
  homedir: string;
};

export function canonicalHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_TEST_CONTEXT === undefined) {
    return CANONICAL_HOME;
  }
  const seam = env[TEST_CANONICAL_HOME_ENV]?.trim();
  return seam ? seam : CANONICAL_HOME;
}

/**
 * C1.1: `ACPX_OWNER_PLACEMENT=pod` is honoured only when the host is control-role AND the state home
 * in use is the canonical one — no `ACPX_STATE_HOME` override (an empty value is no override, exactly
 * as every state-path resolver reads it: `ACPX_STATE_HOME || os.homedir()`), and the home itself is
 * the canonical home. Anything else — a workbench, a suite, a rig — behaves as today.
 */
export function podModeVerdict(facts: HostFacts): PodModeVerdict {
  if (facts.env[OWNER_PLACEMENT_ENV] !== OWNER_PLACEMENT_POD) {
    return { mode: "off", why: "switch-unset" };
  }
  if (!facts.controlRole) {
    return { mode: "off", why: "not-control-role" };
  }
  if (facts.env.ACPX_STATE_HOME) {
    return { mode: "off", why: "state-home-override" };
  }
  if (path.resolve(facts.homedir) !== path.resolve(canonicalHome(facts.env))) {
    return { mode: "off", why: "non-canonical-home" };
  }
  if (podUid(facts.env) === undefined) {
    return { mode: "refuse", reason: "pod_identity_missing" };
  }
  return { mode: "pod" };
}

/**
 * This pod's uid, or undefined. ⚠️ THE ONE PLACE acpx reads `NV_POD_UID` until A5's
 * `src/pod/identity.ts` lands on `agent-pods`; then this delegates to it. A whitespace-only value is
 * missing.
 */
export function podUid(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[POD_UID_ENV]?.trim();
  return value ? value : undefined;
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
