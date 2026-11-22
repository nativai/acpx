import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueKeyForSession } from "../cli/queue/paths.js";
import { isControlPod } from "../config/control-pod.js";
import { acpxStateRoot } from "../session/persistence/session-base-dir.js";
import { ownPodIdentity } from "./identity.js";

/**
 * C1.1 — the switch and "where am I" (CONTRACTS-r4 C1.1, brick b479441f).
 *
 * ⚠️ THIS MODULE IS LOADED BEFORE THE REST OF ACPX (`src/cli.ts`), so its import graph must stay
 * light: node builtins, `config/control-pod.ts`, `cli/queue/paths.ts`,
 * `session/persistence/session-base-dir.ts`. A heavy import here is paid by
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
  /** PID 1's environment, the four named facts only (A-26). Injected by tests; absent ⇒ the real one. */
  pid1?: () => PodFacts | undefined;
  /** The kernel hostname (A-28's second witness). Injected by tests; absent ⇒ the real one. */
  hostname?: () => string;
};

/**
 * A-26 (b): the switch and the pod's identity are facts of the POD. The four names a process may
 * lack — and PID 1 (set by the Deployment or template, unchangeable by any process of the pod) still
 * carries.
 */
export const POD_FACT_NAMES = [
  OWNER_PLACEMENT_ENV,
  "NV_POD_NAME",
  "NV_POD_UID",
  "NV_NODE_NAME",
] as const;
/**
 * Two more facts of the pod that A-26's rule covers (program HoD §11 #2): the lease's placement
 * (`pool` | `home`, C3.1) and the pod's pinned release names (C9 — the staleness token reads them).
 * They do not decide pod mode, so `podFactValue` reads them on demand; PID 1 is read at most once
 * per process for all six.
 */
export const EXTRA_POD_FACT_NAMES = ["NV_AGENT_PLACEMENT", "NV_RUNTIME_RELEASES"] as const;
export type ExtraPodFactName = (typeof EXTRA_POD_FACT_NAMES)[number];
export type PodFacts = Partial<Record<(typeof POD_FACT_NAMES)[number] | ExtraPodFactName, string>>;
/** The test stand-in for PID 1's environ (a file, NUL-separated like the real one) — seam only. */
export const PID1_STAND_IN_ENV = "ACPX_POD_TEST_PID1_ENVIRON";
/** The test stand-in for the kernel hostname (A-28) — seam only; the real one is not read there. */
export const HOSTNAME_STAND_IN_ENV = "ACPX_POD_TEST_HOSTNAME";
/** An agent pod's hostname is `ag-<key>` or `ag-util-<placement>` (C4); a control pod's never is. */
export const AGENT_HOSTNAME_PREFIX = "ag-";

/**
 * ⚠️ A NON-EMPTY `NODE_TEST_CONTEXT` (node's runner sets `child` / `child-v8`), the same test as
 * A5's service-account seam (`serviceAccountDir`), so the two seams the predicate reads agree on
 * an empty value (F5): `NODE_TEST_CONTEXT=""` honours neither.
 */
function testHome(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.NODE_TEST_CONTEXT) {
    return undefined;
  }
  const seam = env[TEST_HOME_ENV]?.trim();
  return seam ? seam : undefined;
}

export function canonicalHome(env: NodeJS.ProcessEnv = process.env): string {
  return testHome(env) ?? CANONICAL_HOME;
}

/**
 * A path with its symlinks resolved (C1.1 A-5 compares the state home "resolved"): the realpath of
 * its deepest existing ancestor, plus the rest — so a not-yet-created `.acpx` under a symlinked home
 * still resolves through the link.
 */
export function resolvedPath(
  p: string,
  realpath: (dir: string) => string = fs.realpathSync,
  depth = 0,
): string {
  const absolute = path.resolve(p);
  const rest: string[] = [];
  for (let dir = absolute; ; dir = path.dirname(dir)) {
    try {
      return path.join(realpath(dir), ...rest);
    } catch {
      // A DANGLING symlink (F6): acpx would create its target THROUGH the link, so follow it.
      const link = danglingLinkTarget(dir);
      if (link !== undefined && depth < 40) {
        return resolvedPath(
          path.join(path.resolve(path.dirname(dir), link), ...rest),
          realpath,
          depth + 1,
        );
      }
      if (dir === path.dirname(dir)) {
        return absolute;
      }
      rest.unshift(path.basename(dir));
    }
  }
}

function danglingLinkTarget(p: string): string | undefined {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `.acpx` directory acpx will actually use, from acpx's own resolver — CALLED, not re-derived
 * (ruled by the stream HoD after atrium S7's finding, 2026-11-21): an empty `ACPX_STATE_HOME` is
 * ignored, a whitespace-only one is a relative path (so never the canonical home).
 */
export function stateRoot(facts: HostFacts): string {
  return acpxStateRoot(facts.env, facts.homedir);
}

/**
 * The named facts out of an environ blob, FILTERED AT READ TIME: nothing else of it is kept, and
 * nothing here ever prints it (PID 1's environ is a credential dump on these boxes).
 */
function factsOf(blob: string): PodFacts {
  const facts: PodFacts = {};
  for (const entry of blob.split("\0")) {
    const eq = entry.indexOf("=");
    const name = eq > 0 ? entry.slice(0, eq) : "";
    if (
      (POD_FACT_NAMES as readonly string[]).includes(name) ||
      (EXTRA_POD_FACT_NAMES as readonly string[]).includes(name)
    ) {
      facts[name as keyof PodFacts] = entry.slice(eq + 1);
    }
  }
  return facts;
}

let memoPid1: { facts: PodFacts | undefined } | undefined;

/** The REAL PID 1's four facts, read once per process (it cannot change); undefined if unreadable. */
function readRealPid1(): PodFacts | undefined {
  if (memoPid1 === undefined) {
    try {
      memoPid1 = { facts: factsOf(fs.readFileSync("/proc/1/environ", "utf8")) };
    } catch {
      memoPid1 = { facts: undefined };
    }
  }
  return memoPid1.facts;
}

/** The stand-in under the honoured seam: the file `ACPX_POD_TEST_PID1_ENVIRON` names, else nothing. */
function readStandIn(env: NodeJS.ProcessEnv): PodFacts | undefined {
  const file = env[PID1_STAND_IN_ENV]?.trim();
  try {
    return file ? factsOf(fs.readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ⚠️ UNDER THE HONOURED SEAM NOTHING OF THE REAL POD IS READ — not its place file, not its PID 1:
 * the seam's directory and the process's environment are the whole world, and a test gives PID 1 a
 * stand-in (`facts.pid1`, or the file named by `ACPX_POD_TEST_PID1_ENVIRON`). `NODE_TEST_CONTEXT`
 * alone is no seam (H1): a leaked one leaves the real PID 1 in force.
 */
function pid1Of(facts: HostFacts): PodFacts | undefined {
  if (facts.pid1) {
    return facts.pid1();
  }
  return testHome(facts.env) !== undefined ? readStandIn(facts.env) : readRealPid1();
}

/**
 * A-26 (b): the process's environment with what it LACKS filled from PID 1 — own value first, and
 * only the value `pod` is the switch, so any other switch value counts as missing and PID 1 is asked
 * (a process cannot opt out). Control-role hosts only; a workbench, a rig or a suite behaves as
 * today. PID 1 is read only when the process lacks something, so a process that carries everything
 * costs no read. `switchNeeded` is false where the place file already stands for the switch.
 */
export function effectiveEnv(facts: HostFacts, switchNeeded = true): NodeJS.ProcessEnv {
  if (!facts.controlRole && testHome(facts.env) === undefined) {
    return facts.env;
  }
  const missing = missingFacts(facts.env, switchNeeded);
  const pid1 = missing.length === 0 ? undefined : pid1Of(facts);
  return pid1 === undefined ? facts.env : overlay(facts.env, missing, pid1);
}

/** The names the process lacks; any switch value but `pod` counts as lacking (no opt-out). */
function missingFacts(env: NodeJS.ProcessEnv, switchNeeded: boolean): string[] {
  return POD_FACT_NAMES.filter((name) =>
    name === OWNER_PLACEMENT_ENV
      ? switchNeeded && env[name] !== OWNER_PLACEMENT_POD
      : !env[name]?.trim(),
  );
}

function overlay(env: NodeJS.ProcessEnv, missing: string[], pid1: PodFacts): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const name of missing) {
    const value = pid1[name as keyof PodFacts]?.trim();
    const isSwitch = name === OWNER_PLACEMENT_ENV;
    if (value && (!isSwitch || value === OWNER_PLACEMENT_POD)) {
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * A-26's rule for one extra fact (`NV_AGENT_PLACEMENT`, `NV_RUNTIME_RELEASES`): on a control-role
 * host the process's own value counts first; one that is missing or empty there is taken from PID 1's
 * environment, read filtered to the named variables and never printed. A workbench, a rig or a suite
 * (not control-role, no seam) has only its own. Under the honoured seam nothing real is read — the
 * stand-in or nothing (`HostFacts.pid1`, `ACPX_POD_TEST_PID1_ENVIRON`).
 */
export function podFactValue(
  name: ExtraPodFactName,
  facts: HostFacts = liveHostFacts(process.env),
): string | undefined {
  if (facts.env[name]?.trim()) {
    return facts.env[name];
  }
  return mayAskPid1(facts) ? nonBlank(pid1Of(facts)?.[name]) : undefined;
}

/** Control-role hosts, and hosts under the honoured seam (its stand-in), may ask PID 1. */
function mayAskPid1(facts: HostFacts): boolean {
  return facts.controlRole || testHome(facts.env) !== undefined;
}

function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** `effectiveEnv` for this host and `env` (live facts) — the env the identity readers should see. */
export function effectivePodEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return effectiveEnv(liveHostFacts(env), false);
}

/**
 * ⚠️ UNDER THE HONOURED SEAM THE REAL HOSTNAME IS NOT READ (A-28), like the real place file and PID 1:
 * the stand-in (`facts.hostname`, or `ACPX_POD_TEST_HOSTNAME`) or nothing. `NODE_TEST_CONTEXT` alone
 * is no seam.
 */
function kernelHostname(env: NodeJS.ProcessEnv, injected?: () => string): string {
  if (injected) {
    return injected();
  }
  return testHome(env) !== undefined ? (env[HOSTNAME_STAND_IN_ENV] ?? "") : os.hostname();
}

/**
 * A-28: this host's place from its TWO witnesses — the place file and the kernel hostname. A mount
 * protects the file against the pod's user, not against a process with a file tree of its own, so
 * `ag-…` as the hostname also says agent pod:
 *
 *   place file names a pod            → that pod (any hostname)
 *   missing/empty/unreadable + `ag-…` → `place-missing`: an agent pod that cannot say which
 *   empty/unreadable + other hostname → `unreadable`: another agent pod, as in A-25
 *   missing + other hostname          → `absent`: the control pod
 */
export function resolvePodFile(file: AgentPodFile, hostname: string): AgentPodFile {
  if (file.kind === "pod") {
    return file;
  }
  return hostname.startsWith(AGENT_HOSTNAME_PREFIX) ? { kind: "place-missing" } : file;
}

/** The place file read, then resolved by the hostname witness. Control-role hosts only call this. */
export function readPodFileWithWitness(
  env: NodeJS.ProcessEnv = process.env,
  hostname?: () => string,
): AgentPodFile {
  const file = readAgentPodFile(agentPodFilePath(env));
  // Read the hostname only where it can change the answer: a place that names a pod needs none.
  return file.kind === "pod" ? file : resolvePodFile(file, kernelHostname(env, hostname));
}

/**
 * C1.1 (with A-5, A-6, A-26): pod mode is decided from the POD's facts.
 * - A workbench, a rig or a suite (not control-role, no seam): `off`, nothing read.
 * - On a control-role host that carries the place file (an agent pod) the place file stands for the
 *   switch: `ACPX_OWNER_PLACEMENT` is not consulted. With the box's canonical state home that is pod
 *   mode, or `refuse` when the pod cannot be named; a caller's own state home behaves as today.
 * - Otherwise (the control pod) `ACPX_OWNER_PLACEMENT=pod`, from the process or else PID 1, is the
 *   switch — same state-home and identity rules (A-5). An unswitched control pod reads PID 1 once and
 *   answers `off`, byte-identical to before.
 */
export function podModeVerdict(facts: HostFacts): PodModeVerdict {
  const seam = testHome(facts.env);
  if (!facts.controlRole && seam === undefined) {
    const claimed = facts.env[OWNER_PLACEMENT_ENV] === OWNER_PLACEMENT_POD;
    return { mode: "off", why: claimed ? "not-control-role" : "switch-unset" };
  }
  // A-28: an agent pod by EITHER witness — the place file exists, or the hostname starts with `ag-`.
  const carriesPlaceFile = readPodFileWithWitness(facts.env, facts.hostname).kind !== "absent";
  const env = effectiveEnv(facts, !carriesPlaceFile);
  if (!carriesPlaceFile && env[OWNER_PLACEMENT_ENV] !== OWNER_PLACEMENT_POD) {
    return { mode: "off", why: "switch-unset" };
  }
  return stateHomeAndIdentity(facts, env, seam !== undefined);
}

/** The rules that follow a switched (or place-filed) control-role host: state home, then identity. */
function stateHomeAndIdentity(
  facts: HostFacts,
  env: NodeJS.ProcessEnv,
  underSeam: boolean,
): PodModeVerdict {
  // A-5 "resolved": the realpath of the `.acpx` directory in use against the canonical one's.
  const root = resolvedPath(stateRoot(facts));
  if (root !== resolvedPath(path.join(canonicalHome(facts.env), ".acpx"))) {
    // Under the seam a state home outside the sandbox refuses: the seam leads only into it.
    return underSeam
      ? { mode: "refuse", reason: "test_seam_outside_sandbox" }
      : { mode: "off", why: "non-canonical-state-home" };
  }
  return podIdentityComplete(env)
    ? { mode: "pod" }
    : { mode: "refuse", reason: "pod_identity_missing" };
}

/**
 * C1.1 A-5: the process can name its pod — `NV_POD_NAME`, `NV_POD_UID`, `NV_NODE_NAME` and the
 * service-account namespace file, all four. Delegates to A5's `ownPodIdentity` (`./identity.ts`),
 * the one reader of those sources (and of its `ACPX_POD_SA_DIR` test seam).
 */
export function podIdentityComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  return ownPodIdentity(env) !== undefined;
}

function liveHostFacts(env: NodeJS.ProcessEnv): HostFacts {
  return { env, controlRole: isControlPod(env), homedir: os.homedir() };
}

/**
 * The verdict for this host and `env`, decided now (not memoised) — the in-process export atrium
 * loads with the class table (`dist/pod/command-classes.js`), so its spawn-state, stream and lock
 * gates use acpx's predicate rather than a twin (brick b479441f reports/EXPORT-class-table.md).
 */
export function podModeVerdictNow(env: NodeJS.ProcessEnv = process.env): PodModeVerdict {
  return podModeVerdict(liveHostFacts(env));
}

let memoVerdict: PodModeVerdict | undefined;

/** Decided once per process (C1.1). A non-control-role host reads nothing; a control-role one reads its place file and, if the process lacks a fact, PID 1 once (A-26). */
export function podMode(): PodModeVerdict {
  if (memoVerdict === undefined) {
    const env = process.env;
    memoVerdict = podModeVerdictNow(env);
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
  | { kind: "unreadable" }
  /**
   * A-28: the kernel hostname says agent pod (`ag-…`) but the place file is missing, empty or
   * unreadable — an agent pod that cannot say WHICH. Only `readPodFileWithWitness` produces it.
   */
  | { kind: "place-missing" };

export function readAgentPodFile(file: string): AgentPodFile {
  try {
    // A-28: readers compare the place file with SURROUNDING WHITESPACE stripped — the downward API
    // writes no trailing newline, the ssh entry strips the same way, and the two must agree. An
    // existing but EMPTY file is still an agent pod (`unreadable`, the fail-safe side).
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
  memoPodFile ??= readPodFileWithWitness();
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
