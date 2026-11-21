import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentPodName, TEST_HOME_ENV } from "../src/pod/placement.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// Shared by the A3 tests (brick 7eb9686f): an AGENT POD for the real CLI in a child process, by the
// product's own seam (`ACPX_POD_TEST_HOME`, A-6) — a stand-in `/home/node` holding `.nv-agent` — with
// the call-home door (`ACPX_UI_INTERNAL_URL`) aimed at lane X1's recorded atrium.

export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

export function tmpDir(prefix = "acpx-a3-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The pod's own session — the pod is named for it. Everything else is "another session". */
export const POD_SESSION = "aaaaaaaa-1111-4222-8333-444444444444";
export const OTHER_SESSION = "cccccccc-0000-4000-8000-000000000a99";

export type AgentPodHome = { home: string; podName: string };

/** A stand-in `/home/node` of the agent pod of `POD_SESSION`. */
export function agentPodHome(podSession: string = POD_SESSION): AgentPodHome {
  const home = tmpDir();
  const podName = agentPodName(podSession);
  fs.writeFileSync(path.join(home, ".nv-agent"), `${podName}\n`);
  return { home, podName };
}

/** Add a record to the pod's state home, the way acpx's tests write one. */
export async function addRecord(home: string, recordId: string, acpId: string): Promise<void> {
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: recordId,
      acpSessionId: acpId,
      agentCommand: "agent",
      cwd: home,
    }),
  );
}

function saDir(): string {
  const dir = tmpDir("acpx-a3-sa-");
  fs.writeFileSync(path.join(dir, "namespace"), "dev-kit\n");
  return dir;
}

/** The child's environment: an agent pod (pod mode, complete identity), calling home to `atriumUrl`. */
export function agentPodEnv(
  home: string,
  atriumUrl: string,
  over: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ACPX_OWNER_PLACEMENT: "pod",
    NV_POD_NAME: "ag-test",
    NV_POD_UID: "uid-1",
    NV_NODE_NAME: "node-a",
    ACPX_POD_SA_DIR: saDir(),
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child",
    [TEST_HOME_ENV]: home,
    ACPX_UI_INTERNAL_URL: atriumUrl,
    // the caller: an agent of this pod
    ACPX_SESSION_URL: `https://atrium.example/?session=${POD_SESSION}`,
    ACPX_SEAT_URL: "https://atrium.example/?seat=11111111-1111-4111-8111-111111111111",
    ACPX_SESSION_RECORD_ID: POD_SESSION,
    ...over,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  delete env.ACPX_STATE_HOME;
  delete env.ACPX_ROUTED;
  // The test runner is itself an agent: scrub the identity and the inheritables it brought along.
  for (const name of [
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_SUBSCRIPTION",
    "ATRIUM_OS",
    "ACPX_ADMISSION_CLASS",
    "ACPX_UI_BASE_URL",
  ]) {
    if (!(name in over)) {
      delete env[name];
    }
  }
  if ("ACPX_ROUTED" in over) {
    env.ACPX_ROUTED = over.ACPX_ROUTED;
  }
  return env;
}

export type ChildRun = { status: number | null; stdout: string; stderr: string; ms: number };

/** ASYNC: the recorded atrium lives in THIS process, so the event loop must keep turning. */
export function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<ChildRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const killer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** Every file under `dir`, relative, with its bytes' length — to prove "nothing was written". */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}`);
      }
    }
  };
  walk(dir);
  return out.toSorted();
}
