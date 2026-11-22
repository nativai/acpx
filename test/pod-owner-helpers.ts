import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_NAMESPACE, makePod, makeServiceAccountDir, type KitPod } from "./pod-kit/two-pods.js";

/**
 * A4's test world: one process standing as a POD, through the product's own seams only —
 * `ACPX_POD_TEST_HOME` (the stand-in `/home/node`; `.nv-agent` inside it makes an agent pod),
 * `ACPX_POD_TEST_HOSTNAME`, `NV_POD_*`, `ACPX_POD_SA_DIR` and `ACPX_POD_API_URL`. Every one is
 * honoured only under `NODE_TEST_CONTEXT`, which `node --test` sets. `ACPX_STATE_HOME` is always the
 * sandbox: no probe here may touch the box's real `~/.acpx`.
 */

export type PodWorld = {
  root: string;
  /** The stand-in `/home/node`; the canonical state home is `<home>/.acpx`. */
  home: string;
  saDir: string;
  pod: KitPod;
};

const POD_VARS = [
  "NV_POD_NAME",
  "NV_POD_UID",
  "NV_NODE_NAME",
  "NV_AGENT_PLACEMENT",
  "NV_RUNTIME_RELEASES",
  "ACPX_OWNER_PLACEMENT",
  "ACPX_POD_TEST_HOME",
  "ACPX_POD_TEST_HOSTNAME",
  "ACPX_POD_TEST_PID1_ENVIRON",
  "ACPX_POD_SA_DIR",
  "ACPX_POD_API_URL",
  "ACPX_STATE_HOME",
  "ACPX_ROUTED",
  "ACPX_ROUTED_CONTRACT",
  "ACPX_ROUTED_CALL_ID",
  "ACPX_ROUTED_DEADLINE_MS",
  "ACPX_ROUTED_PAYLOAD",
  "ACPX_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
] as const;

/** The key and the pod name of a session, the way the broker names them. */
export function agentPodNameFor(key: string): string {
  return `ag-${key}`;
}

export function makeWorld(label: string, options: { podName?: string } = {}): PodWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `a4-${label}-`));
  const pod = makePod(label);
  if (options.podName) {
    pod.name = options.podName;
  }
  return {
    root,
    home: fs.mkdtempSync(path.join(root, "home-")),
    saDir: makeServiceAccountDir(root),
    pod,
  };
}

export function writePlaceFile(world: PodWorld, content: string): void {
  fs.writeFileSync(path.join(world.home, ".nv-agent"), content);
}

export type WorldEnv = {
  /** Stand in an agent pod: the place file names `podName`. Default: the control pod (no file). */
  place?: "agent-pod" | "control";
  /** Identity variables present (default true). */
  identity?: boolean;
  podMode?: boolean;
  extra?: Record<string, string | undefined>;
};

/** The environment patch for one process standing in `world`; `undefined` removes a variable. */
export function worldEnv(
  world: PodWorld,
  options: WorldEnv = {},
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = Object.fromEntries(
    POD_VARS.map((name) => [name, undefined]),
  );
  patch.ACPX_POD_TEST_HOME = world.home;
  patch.ACPX_POD_SA_DIR = world.saDir;
  patch.ACPX_STATE_HOME = world.home;
  patch.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || "child-v8";
  if (options.identity !== false) {
    patch.NV_POD_NAME = world.pod.name;
    patch.NV_POD_UID = world.pod.uid;
    patch.NV_NODE_NAME = world.pod.node;
  }
  if (options.podMode) {
    patch.ACPX_OWNER_PLACEMENT = "pod";
  }
  if (options.place === "agent-pod") {
    writePlaceFile(world, `${world.pod.name}\n`);
  }
  return { ...patch, ...options.extra };
}

/** Runs `run` with `patch` applied to `process.env`, restoring every touched variable after. */
export async function withEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    saved.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

export { KIT_NAMESPACE };
