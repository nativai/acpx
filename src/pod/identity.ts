import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * This process's pod (C3.1 `pod` field sources, C3.2 lock body) — brick 8d85cb47.
 *
 * Read from the downward API (`NV_POD_NAME`, `NV_POD_UID`, `NV_NODE_NAME`) and the service-account
 * namespace file. Absent outside a pod — and absent on a control pod whose Deployment does not yet
 * carry those variables (every box until its switch commit): there the lock body has no `pod` field
 * and today's rules apply unchanged (C3.2 row 3; program HoD constraint 2026-11-21).
 *
 * 🛑 THE IDENTITY GOES INTO A LOCK BODY ONLY IN POD MODE (`ACPX_OWNER_PLACEMENT=pod`, C1.1). A
 * workbench or rig is a pod too, but C1.1 says acpx behaves there as today; stamping its pod into
 * a lock would change how the control pod judges its holders on a box that was never switched.
 * `lockPodIdentity` is that gate; `ownPodIdentity` is the raw read (for the death proof's namespace
 * and the sweep).
 *
 * TEST SEAM: two pod identities over one state directory are two processes with different
 * `NV_POD_*` (test/pod-kit/two-pods.ts). The service-account directory is overridable by
 * `ACPX_POD_SA_DIR`, honoured ONLY under `NODE_TEST_CONTEXT` (precedent `ACPX_OS_COMPAT_LINK`), so
 * setting it on a box cannot redirect a real death proof.
 */

export type PodRef = { name: string; uid: string; node?: string; namespace?: string };
export type PodIdentity = PodRef;

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

/** This process's pod from `env`, or undefined when name or uid is missing. Never throws. */
export function ownPodIdentity(env: NodeJS.ProcessEnv = process.env): PodIdentity | undefined {
  const name = nonEmpty(env[POD_NAME_ENV]);
  const uid = nonEmpty(env[POD_UID_ENV]);
  if (!name || !uid) {
    return undefined;
  }
  const node = nonEmpty(env[NODE_NAME_ENV]);
  const namespace = readServiceAccountFile("namespace", env);
  return { name, uid, ...(node ? { node } : {}), ...(namespace ? { namespace } : {}) };
}

/** The pod a lock body names: this process's pod, in pod mode only (see the 🛑 above). */
export function lockPodIdentity(env: NodeJS.ProcessEnv = process.env): PodIdentity | undefined {
  return env[OWNER_PLACEMENT_ENV] === "pod" ? ownPodIdentity(env) : undefined;
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
