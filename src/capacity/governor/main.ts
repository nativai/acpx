import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { queueBaseDir } from "../../cli/queue/paths.js";
import { queueOwnerTokenState } from "../../process-tree-reap.js";
import { sessionBaseDir } from "../../session/persistence/repository.js";
import { CAPACITY_CONSTANTS } from "../constants.js";
import { DEFAULT_ATRIUM_URL, Notifier, type NotifyFetch } from "./notify.js";
import {
  ClickHouseWriter,
  clickHouseConfig,
  type FetchLike,
  resolveBoxIdentity,
} from "./record.js";
import { Governor, parseGovernorArgs } from "./run.js";
import { governorDir } from "./status.js";
import { realSignaller } from "./sweep.js";

/**
 * The governor daemon's entry file (CONCEPTION 5d7a23b6 §7.2) → `dist/capacity/governor/main.js`.
 *
 * 🛑 NOT A CLI VERB. The control entrypoint's supervised loop runs this file with `node` from `/`;
 * an acpx build without the verb would read `acpx governor run` as an AGENT NAME and could deliver
 * "run" as a prompt (F19). The production start takes no argv.
 */

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStatus(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const env = process.env;
  const args = parseGovernorArgs(process.argv.slice(2), env);
  if ("error" in args) {
    log(`process-governor: REFUSED — ${args.error}`);
    return 2;
  }
  const testMode = env.ACPX_GOVERNOR_TEST === "1";
  const identity = resolveBoxIdentity(env, testMode);
  const dir = governorDir(env);
  const clickhouse = new ClickHouseWriter(
    clickHouseConfig({
      env,
      testMode,
      allowed: true,
      box: identity,
      fetchImpl: fetch as unknown as FetchLike,
      captureFile: `${dir}/clickhouse-rows.ndjson`,
    }),
    log,
  );
  const governor = new Governor(
    {
      procRoot: "/proc",
      cgroupRoot: "/sys/fs/cgroup",
      queueDir: queueBaseDir(),
      sessionsDir: sessionBaseDir(),
      dir,
      now: () => Date.now(),
      signal: realSignaller,
      sleepSync,
      notifier: new Notifier({
        atriumUrl: env.ACPX_GOVERNOR_ATRIUM_URL || DEFAULT_ATRIUM_URL,
        outboxDir: `${dir}/outbox`,
        fetchImpl: fetch as unknown as NotifyFetch,
        constants: CAPACITY_CONSTANTS.governor,
        log,
      }),
      clickhouse,
      log,
      readStatus,
      tokenState: (pid) => queueOwnerTokenState(pid),
      selfPid: process.pid,
      uid: os.userInfo().uid,
      entryFile: fileURLToPath(import.meta.url),
    },
    {
      constants: CAPACITY_CONSTANTS,
      testMode,
      testRig: args.testRig,
      limitBytes: args.limitBytes,
      box: identity.box ?? "",
      clickhouseAllowed: true,
    },
  );
  const started = governor.start();
  if ("exitCode" in started) {
    return started.exitCode;
  }
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  const finish = async (code: number): Promise<number> => {
    governor.shutdown();
    await Promise.race([governor.settle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    return code;
  };
  return new Promise((resolve) => {
    const loop = (): void => {
      if (stopping) {
        void finish(0).then(resolve);
        return;
      }
      let next = CAPACITY_CONSTANTS.governor.scanIntervalMs;
      try {
        const outcome = governor.tick();
        if ("exitCode" in outcome) {
          void finish(outcome.exitCode).then(resolve);
          return;
        }
        next = outcome.nextMs;
      } catch (error) {
        log(
          `process-governor: scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      setTimeout(loop, next);
    };
    loop();
  });
}

void main().then((code) => {
  process.exit(code);
});
