import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Tier-0 kit piece (lane A5, brick 8d85cb47): TWO POD IDENTITIES OVER ONE DIRECTORY.
 *
 * A pod, to acpx, is the downward API (`NV_POD_NAME`, `NV_POD_UID`, `NV_NODE_NAME`), the
 * service-account directory (namespace, token, CA) and pod mode (`ACPX_OWNER_PLACEMENT=pod`). A test
 * gets two pods by running two PROCESSES with two such environments over one shared state
 * directory. The service-account directory is the product's seam `ACPX_POD_SA_DIR`, honoured only
 * under `NODE_TEST_CONTEXT` (`src/pod/identity.ts`) — which `node --test` sets and every child
 * spawned here inherits. Point `apiUrl` at a fake API server (lane X1's `test/pod-kit/fake-apiserver`)
 * to answer the death proof; without one every proof is `unknown`.
 *
 * Over the shared `/workspace` NFS the same environments make two MACHINES: one process on the
 * control pod, one through `workbench-exec` (A5's cross-machine run).
 */

export type KitPod = { name: string; uid: string; node: string; namespace: string };

export const KIT_NAMESPACE = "dev-kit";
export const KIT_TOKEN = "kit-service-account-token";

/** A fresh pod identity; `label` makes it readable in a lock body. */
export function makePod(label: string, node = `node-${label}`): KitPod {
  return { name: `ag-${label}`, uid: randomUUID(), node, namespace: KIT_NAMESPACE };
}

/** A service-account directory (`token`, `namespace`) under `root`, for `ACPX_POD_SA_DIR`. */
export function makeServiceAccountDir(root: string, namespace = KIT_NAMESPACE): string {
  const dir = path.join(root, "serviceaccount");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token"), `${KIT_TOKEN}\n`);
  fs.writeFileSync(path.join(dir, "namespace"), `${namespace}\n`);
  return dir;
}

export type PodEnvOptions = {
  saDir: string;
  /** Base URL of a fake API server (`ACPX_POD_API_URL`). */
  apiUrl?: string;
  /** Default true: `ACPX_OWNER_PLACEMENT=pod`, so lock bodies name the pod. */
  podMode?: boolean;
  /** State home shared by both pods (`ACPX_STATE_HOME`). */
  stateHome?: string;
};

/** The environment of a process in `pod` — the parent's env with the pod's variables on top. */
export function podEnv(pod: KitPod | undefined, options: PodEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["NV_POD_NAME", "NV_POD_UID", "NV_NODE_NAME", "ACPX_OWNER_PLACEMENT"]) {
    delete env[name];
  }
  env.NODE_TEST_CONTEXT ??= "child-v8";
  env.ACPX_POD_SA_DIR = options.saDir;
  if (options.apiUrl) {
    env.ACPX_POD_API_URL = options.apiUrl;
  } else {
    delete env.ACPX_POD_API_URL;
  }
  if (options.stateHome) {
    env.ACPX_STATE_HOME = options.stateHome;
  }
  if (pod) {
    env.NV_POD_NAME = pod.name;
    env.NV_POD_UID = pod.uid;
    env.NV_NODE_NAME = pod.node;
    if (options.podMode !== false) {
      env.ACPX_OWNER_PLACEMENT = "pod";
    }
  }
  return env;
}

export type PodRun = { code: number | null; stdout: string; stderr: string };

/** Runs `node <script> ...args` as a process in `pod`; resolves when it exits. */
export function runInPod(
  pod: KitPod | undefined,
  script: string,
  args: string[],
  options: PodEnvOptions & { timeoutMs?: number },
): Promise<PodRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: podEnv(pod, options),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
