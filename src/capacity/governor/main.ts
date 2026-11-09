import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { queueBaseDir } from "../../cli/queue/paths.js";
import { queueOwnerTokenState } from "../../process-tree-reap.js";
import { sessionBaseDir } from "../../session/persistence/session-base-dir.js";
import { CAPACITY_CONSTANTS } from "../constants.js";
import { DEFAULT_ATRIUM_URL, Notifier, type NotifyFetch } from "./notify.js";
import {
  ClickHouseWriter,
  clickHouseConfig,
  type FetchLike,
  resolveBoxIdentity,
} from "./record.js";
import { Governor, parseGovernorArgs } from "./run.js";
import { parallelScanner } from "./scan.js";
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
  // The reader threads exist before the first scan and for the governor's life (§16: nothing created or
  // imported inside the loop). Each sets its own nice: Linux nice is per thread.
  const readers = parallelScanner({
    readers: CAPACITY_CONSTANTS.governor.scanReaders,
    nice: CAPACITY_CONSTANTS.governor.nice,
    stuckMs: CAPACITY_CONSTANTS.governor.scanReaderStuckMs,
    log,
  });
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
      scanner: readers.scan,
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
    let timer: NodeJS.Timeout | undefined;
    let immediate: NodeJS.Immediate | undefined;
    let done = false;
    const end = (code: number): void => {
      done = true;
      clearTimeout(timer);
      clearImmediate(immediate);
      clearInterval(watcher);
      void finish(code).then(resolve);
    };
    // One scan; the next is scheduled by the cadence — or brought forward by the pid watcher below.
    // Both run on this one thread, so a scan never overlaps another.
    const loop = (): void => {
      clearTimeout(timer);
      clearImmediate(immediate);
      immediate = undefined;
      if (done) {
        return;
      }
      if (stopping) {
        end(0);
        return;
      }
      let next = CAPACITY_CONSTANTS.governor.scanIntervalMs;
      try {
        const outcome = governor.tick();
        if ("exitCode" in outcome) {
          end(outcome.exitCode);
          return;
        }
        next = outcome.nextMs;
      } catch (error) {
        log(
          `process-governor: scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // §19 D6: the trigger already met again ⇒ the next tick at once — ONE setImmediate per completed tick,
      // so the event loop turns between ticks; otherwise the cadence's delay.
      if (governor.reTickDue()) {
        immediate = setImmediate(loop);
      } else {
        timer = setTimeout(loop, next);
      }
    };
    // §19 D3: ≥ pidWatchTrigger pids allocated since the last 50 ms tick ⇒ scan NOW (and fast mode).
    const watcher = setInterval(() => {
      if (!done && governor.pidWatch()) {
        loop();
      }
    }, CAPACITY_CONSTANTS.governor.pidWatchIntervalMs);
    loop();
  });
}

void main().then((code) => {
  process.exit(code);
});
