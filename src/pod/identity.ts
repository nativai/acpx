import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isControlPod } from "../config/control-pod.js";
import {
  effectivePodEnv,
  podModeVerdict,
  readPodFileWithWitness,
  TEST_HOME_ENV,
} from "./placement.js";

/**
 * This process's pod (C3.1 `pod` field sources, C3.2 lock body) — brick 8d85cb47.
 *
 * Read from the downward API (`NV_POD_NAME`, `NV_POD_UID`, `NV_NODE_NAME`) and the service-account
 * namespace file — ALL FOUR, or there is no identity (C1.1 A-5). Absent outside a pod — and absent
 * on a control pod whose Deployment does not yet carry those variables (every box until the commit
 * that pins the pod-mode image): there a lock body has no `pod` field and today's rules apply
 * unchanged (C3.2 row 3; program HoD constraint 2026-11-21).
 *
 * A PROCESS THAT KNOWS ITS POD WRITES `pod` INTO EVERY LOCK BODY, IN OR OUT OF POD MODE (C1.1 A-5):
 * so the rollback window — agent pods alive beside a control pod back in local mode — keeps the
 * cross-pod rules. ⚠️ A pod's HOSTNAME IS NOT ITS NAME: the workbench template sets `spec.hostname`
 * (`wb-<seat>` for the pod `wb-<seat>-fjkrd`, measured 2026-11-21), so the name comes only from
 * `NV_POD_NAME`, never from `os.hostname()`.
 *
 * TEST SEAM: two pod identities over one state directory are two processes with different
 * `NV_POD_*` (test/pod-kit/two-pods.ts). The service-account directory is overridable by
 * `ACPX_POD_SA_DIR`, honoured ONLY under `NODE_TEST_CONTEXT` (precedent `ACPX_OS_COMPAT_LINK`), so
 * setting it on a box cannot redirect a real death proof.
 */

export type PodRef = { name: string; uid: string; node?: string; namespace?: string };
export type PodIdentity = { name: string; uid: string; node: string; namespace: string };

export const POD_NAME_ENV = "NV_POD_NAME";
export const POD_UID_ENV = "NV_POD_UID";
export const NODE_NAME_ENV = "NV_NODE_NAME";
export const OWNER_PLACEMENT_ENV = "ACPX_OWNER_PLACEMENT";
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const POD_SA_DIR_ENV = "ACPX_POD_SA_DIR";

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The service-account directory: the real one, or the test seam under `NODE_TEST_CONTEXT`. */
export function serviceAccountDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env[POD_SA_DIR_ENV]);
  return env.NODE_TEST_CONTEXT && override ? override : SERVICE_ACCOUNT_DIR;
}

/** A file of the service-account directory, trimmed, or undefined when absent/empty. */
export function readServiceAccountFile(
  name: "token" | "namespace",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    return nonEmpty(readFileSync(path.join(serviceAccountDir(env), name), "utf8"));
  } catch {
    return undefined;
  }
}

/** This process's pod from `env` — all four sources, else undefined. Never throws. */
export function ownPodIdentity(env: NodeJS.ProcessEnv = process.env): PodIdentity | undefined {
  const name = nonEmpty(env[POD_NAME_ENV]);
  const uid = nonEmpty(env[POD_UID_ENV]);
  const node = nonEmpty(env[NODE_NAME_ENV]);
  const namespace = readServiceAccountFile("namespace", env);
  return name && uid && node && namespace ? { name, uid, node, namespace } : undefined;
}

/**
 * WHERE AM I, for the lock rules (C1.1, C3.2 A-4). `control`: a control-role host without the agent
 * pod's place file `.nv-agent`; `agent-pod`: a control-role host WITH it (an unreadable file counts
 * as an agent pod — the fail-safe side); `elsewhere`: anything else (a workbench, a suite, a rig).
 * The place file and the seam are A1's (`src/pod/placement.ts`): one reading of "where am I". Test
 * seam `ACPX_POD_TEST_HOME` (C1.1 A-6, under `NODE_TEST_CONTEXT` only): `<dir>` stands in for
 * `/home/node` and the host counts as control-role.
 */
export type LockHostPlace = "control" | "agent-pod" | "elsewhere";

/**
 * The seam's directory, or undefined. ⚠️ TRUTHINESS, NOT `!== undefined`: an EMPTY
 * `NODE_TEST_CONTEXT` honours no seam anywhere (stream HoD ruling, A1's F5 class) — the same test as
 * `serviceAccountDir` and the death proof's `ACPX_POD_API_URL`. Pinned by
 * `test/pod-lock-primitive.test.ts` "an EMPTY NODE_TEST_CONTEXT honours no seam".
 */
export function podTestHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.NODE_TEST_CONTEXT ? nonEmpty(env[TEST_HOME_ENV]) : undefined;
}

export function lockHostPlace(env: NodeJS.ProcessEnv = process.env): LockHostPlace {
  const seam = podTestHome(env);
  if (!seam && !isControlPod(env)) {
    return "elsewhere";
  }
  // A-28: an agent pod by EITHER witness (the place file, the kernel hostname `ag-…`), for ANY state
  // home — the lock and lease writer's rule (A-25) takes both. The seam is honoured inside.
  return readPodFileWithWitness(env).kind === "absent" ? "control" : "agent-pod";
}

/**
 * C1.1 A-5 / A-26: pod mode is REQUESTED here — A1's verdict is `pod` or `refuse` (the switch, a
 * control-role host, the state home resolving to the canonical one, the switch read from the
 * process or else PID 1, or the place file standing for it). The lock module refuses to write a body
 * without `pod` in that state (`PodIdentityMissingError`).
 */
export function podModeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    podModeVerdict({ env, controlRole: isControlPod(env), homedir: os.homedir() }).mode !== "off"
  );
}

/**
 * The pod a lock body names: this process's pod whenever it knows it (C1.1 A-5) — from its own
 * environment first, and on a control-role host what that lacks from PID 1 (A-26 (b)).
 */
export function lockPodIdentity(env: NodeJS.ProcessEnv = process.env): PodIdentity | undefined {
  return ownPodIdentity(effectivePodEnv(env));
}

/** A `pod` field as read from a lock body or lease: name and uid required, the rest optional. */
export function parsePodRef(value: unknown): PodRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = value as Record<string, unknown>;
  const name = nonEmpty(field.name);
  const uid = nonEmpty(field.uid);
  if (!name || !uid) {
    return undefined;
  }
  const node = nonEmpty(field.node);
  const namespace = nonEmpty(field.namespace);
  return { name, uid, ...(node ? { node } : {}), ...(namespace ? { namespace } : {}) };
}

/**
 * What a lock body or lease says about its holder's pod (C3.2, A-68). The KEY decides, never the parsed
 * value: a body that has a `pod` key carries `pod`, whatever it holds. `unreadable` is a key whose value
 * names no pod (`null`, a string, `{}`, no `name` or no `uid`): that holder lives in ANOTHER pod, on every
 * host, so no reader judges it by pid, birth identity or age, and C3.3 cannot fetch it (`unknown`).
 * Only `absent` — no `pod` key at all — is a holder of the control pod, judged by C3.2's pid row.
 * ⚠️ DO NOT read "no pod" from a `parsePodRef` result: a newer writer's `pod` shape that an older reader
 * cannot parse would then turn into a pid verdict on a living pod's body (the second owner the soak
 * measures). `test/pod-lease-judge-malformed-pod.test.ts` holds both judges to this one predicate.
 */
export type PodField = { kind: "absent" } | { kind: "pod"; pod: PodRef } | { kind: "unreadable" };

export function podFieldOf(body: Record<string, unknown> | undefined): PodField {
  if (!body || !Object.hasOwn(body, "pod")) {
    return { kind: "absent" };
  }
  const pod = parsePodRef(body.pod);
  return pod ? { kind: "pod", pod } : { kind: "unreadable" };
}
