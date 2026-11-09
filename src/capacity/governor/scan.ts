import fs from "node:fs";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";
import { parseGovProcStat, type GovProc } from "./classify.js";

/**
 * CONCEPTION 5d7a23b6 §4.2 cadence, §19 D5 "kill on crossing, mid-scan" — the governor's `/proc` scan.
 *
 * STREAMING: `/proc` is listed batch by batch while it is read (opendir), not snapshotted up front, so a
 * pid born during the scan with a higher number than the cursor is still read — a storm that was below
 * 128 when the scan began is counted past 128 in the SAME scan (brick 07f4fde2 profile: a scan that began
 * at ~100 storm members took 215 ms and could not decide; the next one saw 650).
 *
 * VISIT: every parsed entry is handed to `visit` as it arrives; returning true stops the scan (the
 * crossing kill). Such a scan is `stopped` and its map is a PARTIAL view: it must never stand in for a
 * full scan (classification forgets sessions it does not see).
 *
 * 🛑 Only reading happens here. Counting, the decision, the guard and every signal stay with the caller,
 * on the main thread.
 */

/** `byPid` is the scan's own (partial) map: the crossing kill may add a leader it reads fresh. */
export type ScanVisit = (entry: GovProc, byPid: Map<number, GovProc>) => boolean;

export type GovScan = {
  readonly measured: boolean;
  readonly byPid: Map<number, GovProc>;
  /** `visit` stopped the scan: `byPid` is partial. */
  readonly stopped: boolean;
  /** Every reader finished; false when a stuck reader's share was left out (parallel scanner only). */
  readonly complete: boolean;
};

export type ProcScanner = (visit?: ScanVisit) => GovScan;

const DIGITS = /^\d+$/u;
const DEFAULT_PROC_ROOT = "/proc";

function readStat(procRoot: string, pid: number): GovProc | undefined {
  try {
    const entry = parseGovProcStat(fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
    return entry?.pid === pid ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** One `/proc/<pid>/stat`, fresh (a leader the partial view has not reached yet). */
export function readOneProc(procRoot: string, pid: number): GovProc | undefined {
  return readStat(procRoot, pid);
}

/** On the real `/proc` a scan that does not contain this process is not our pid namespace: unmeasured. */
function isMeasured(procRoot: string, byPid: ReadonlyMap<number, GovProc>): boolean {
  return byPid.size > 0 && (procRoot !== DEFAULT_PROC_ROOT || byPid.has(process.pid));
}

/** The synchronous streaming scanner: one thread, every read in turn (tests; the fallback). */
export function streamingScanner(procRoot: string): ProcScanner {
  return (visit) => {
    const byPid = new Map<number, GovProc>();
    let stopped = false;
    let dir: fs.Dir | undefined;
    try {
      dir = fs.opendirSync(procRoot, { bufferSize: 64 });
      for (let d = dir.readSync(); d !== null && !stopped; d = dir.readSync()) {
        const entry = DIGITS.test(d.name) ? readStat(procRoot, Number(d.name)) : undefined;
        if (entry) {
          byPid.set(entry.pid, entry);
          stopped = visit?.(entry, byPid) === true;
        }
      }
    } catch {
      // an unreadable /proc is an unmeasured scan
    } finally {
      dir?.closeSync();
    }
    return { measured: isMeasured(procRoot, byPid), byPid, stopped, complete: true };
  };
}

// ---------------------------------------------------------------------------
// the parallel scanner: N reader threads (brick 07f4fde2)
// ---------------------------------------------------------------------------

/** Control words shared with the readers: the scan generation, a post counter, the stopped generation. */
const GEN = 0;
const SEQ = 1;
const STOP = 2;

/**
 * A reader thread. It waits for a new scan generation, streams `/proc` itself and reads the `stat` of
 * every pid with `pid % count === index`, posting the raw text. It quits a generation early when the main
 * thread stopped it (the crossing kill) or a newer one began. Plain CommonJS for `eval: true`: nothing is
 * imported at scan time, so a refresh rewriting `dist/` cannot break a running reader (§7.2, §16).
 */
const READER_SOURCE = `
const fs = require("node:fs");
const os = require("node:os");
const { workerData } = require("node:worker_threads");
const { ctl, port, index, count, procRoot, nice } = workerData;
const post = (gen, pid, text) => { port.postMessage([gen, pid, text]); Atomics.add(ctl, ${SEQ}, 1); Atomics.notify(ctl, ${SEQ}); };
let niceNote;
try { os.setPriority(0, nice); niceNote = "nice " + os.getPriority(0); } catch (error) { niceNote = "could not set nice " + nice + " (" + ((error && error.info && error.info.code) || (error && error.code) || String(error)) + ")"; }
post(0, -2, niceNote);
let gen = 0;
for (;;) {
  Atomics.wait(ctl, ${GEN}, gen);
  gen = Atomics.load(ctl, ${GEN});
  let dir;
  try {
    dir = fs.opendirSync(procRoot, { bufferSize: 64 });
    for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
      if (Atomics.load(ctl, ${GEN}) !== gen || Atomics.load(ctl, ${STOP}) === gen) break;
      if (!/^\\d+$/.test(d.name) || Number(d.name) % count !== index) continue;
      let text;
      try { text = fs.readFileSync(procRoot + "/" + d.name + "/stat", "utf8"); } catch { continue; }
      post(gen, Number(d.name), text);
    }
  } catch {}
  try { if (dir) dir.closeSync(); } catch {}
  post(gen, -1, null);
}
`;

type Reader = {
  readonly port: MessagePort;
  /** The thread is up (it posted its nice note); a reader still booting is not waited for. */
  booted: boolean;
  doneGen: number;
  /** When it last posted anything: silence is measured from here, across scans. */
  heardAt: number;
  stuckLogged: boolean;
};

/** How long start-up waits for every reader thread to boot before scanning without the late ones. */
const BOOT_WAIT_MS = 5000;

export type ParallelScannerOptions = {
  readonly procRoot?: string;
  /** Fixed reader count, created once here — never inside the loop. */
  readonly readers: number;
  /** Each reader sets its own nice (Linux nice is per thread) and reports it; a refusal is logged. */
  readonly nice: number;
  /** A reader silent this long inside a full scan is left out of it (logged); the scan completes. */
  readonly stuckMs: number;
  readonly log: (line: string) => void;
  readonly now?: () => number;
};

export type ParallelScanner = { readonly scan: ProcScanner; readonly close: () => Promise<void> };

type Collect = {
  readonly gen: number;
  readonly byPid: Map<number, GovProc>;
  readonly pending: Set<number>;
  readonly visit: ScanVisit | undefined;
  stopped: boolean;
  /** Readers left out of this scan (still blocked in an earlier one, or silent past `stuckMs`). */
  left: number;
};

/**
 * ⚠️ WHY THREADS (brick 07f4fde2 profile, 2026-11-09): `read()` of `/proc/<pid>/stat` BLOCKS in the kernel
 * (wchan `do_task_stat`) for 50–466 ms when the target is a storm process mid-exec and starved — a priority
 * inversion that no nice value fixes. A single-threaded scan stalls on every such entry while the storm
 * keeps forking. Here a blocked read stalls only its own reader; the others keep delivering, so the 128th
 * member is counted without waiting for it. DO NOT "simplify" back to one synchronous loop: it is the stall
 * this replaced. Row: "parallel scanner: a reader blocked on a read …".
 */
export function parallelScanner(options: ParallelScannerOptions): ParallelScanner {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const now = options.now ?? (() => performance.now());
  const ctl = new Int32Array(new SharedArrayBuffer(12));
  const workers: Worker[] = [];
  const readers: Reader[] = [];
  for (let index = 0; index < options.readers; index += 1) {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(READER_SOURCE, {
      eval: true,
      workerData: { ctl, port: port2, index, count: options.readers, procRoot, nice: options.nice },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    });
    worker.on("error", (error: Error) => {
      options.log(`process-governor: scan reader ${index} failed: ${error.message}`);
    });
    worker.unref();
    workers.push(worker);
    readers.push({ port: port1, booted: false, doneGen: 0, heardAt: now(), stuckLogged: false });
  }
  const fallback = streamingScanner(procRoot);
  let gen = 0;

  const accept = (c: Collect, pid: number, text: string) => {
    const entry = parseGovProcStat(text);
    if (entry?.pid === pid) {
      c.byPid.set(pid, entry);
      c.stopped = c.visit?.(entry, c.byPid) === true;
    }
  };

  const handle = (c: Collect, i: number, [g, pid, text]: [number, number, string | null]) => {
    if (pid === -2) {
      readers[i].booted = true;
      options.log(`process-governor: scan reader ${i}: ${text}`);
    } else if (pid === -1) {
      readers[i].doneGen = Math.max(readers[i].doneGen, g);
      readers[i].stuckLogged = false;
      if (g === c.gen) {
        c.pending.delete(i);
      }
    } else if (g === c.gen && text !== null) {
      accept(c, pid, text);
    }
  };

  /** Everything posted so far; true when anything arrived. */
  const drain = (c: Collect): boolean => {
    let got = false;
    for (let i = 0; i < readers.length && !c.stopped; i += 1) {
      for (let m = receiveMessageOnPort(readers[i].port); m; ) {
        got = true;
        readers[i].heardAt = now();
        handle(c, i, m.message as [number, number, string | null]);
        m = c.stopped ? undefined : receiveMessageOnPort(readers[i].port);
      }
    }
    return got;
  };

  /** Readers silent for `stuckMs` leave the scan (logged); the wait for the others is bounded the same way. */
  const dropStuck = (c: Collect): number => {
    let nextMs = options.stuckMs;
    for (const i of c.pending) {
      const silent = now() - readers[i].heardAt;
      if (silent >= options.stuckMs) {
        c.pending.delete(i);
        c.left += 1;
        readers[i].stuckLogged = true;
        options.log(
          `process-governor: scan reader ${i} silent > ${options.stuckMs} ms (a blocked /proc read); scan completed without its share`,
        );
      } else {
        nextMs = Math.min(nextMs, options.stuckMs - silent);
      }
    }
    return Math.max(1, nextMs);
  };

  /** Who takes part: readers done with the previous scan. One still blocked in it is left out at once. */
  const enlist = (c: Collect) => {
    // Earlier scans' leftovers: done marks and notes count, their entries are stale and dropped.
    drain({ ...c, gen: -1, visit: undefined, pending: new Set() });
    readers.forEach((r, i) => {
      // A reader still inside an earlier scan is waited for only while it is not yet silent past the
      // bound (it is just finishing); one already silent that long is in a blocked read: counted without.
      if (r.booted && r.doneGen === gen - 1) {
        r.heardAt = now(); // idle until now: its silence starts with this scan
        c.pending.add(i);
        return;
      }
      if (r.booted && now() - r.heardAt < options.stuckMs) {
        c.pending.add(i);
        return;
      }
      c.left += 1;
      if (!r.stuckLogged) {
        r.stuckLogged = true;
        options.log(
          `process-governor: scan reader ${i} still blocked in an earlier /proc read; scanning without its share`,
        );
      }
    });
  };

  /** Count what arrives until every enlisted reader is done, left out, or `visit` stopped the scan. */
  const collect = (c: Collect) => {
    while (!c.stopped && c.pending.size > 0) {
      const seq = Atomics.load(ctl, SEQ);
      if (!drain(c) && !c.stopped) {
        const waitMs = dropStuck(c);
        if (c.pending.size > 0) {
          Atomics.wait(ctl, SEQ, seq, waitMs);
        }
      }
    }
  };

  // Start-up (never inside the loop): wait, bounded, until every reader thread is up and reported its nice.
  const awaitBoot = () => {
    const boot: Collect = {
      gen: -1,
      byPid: new Map(),
      pending: new Set(),
      visit: undefined,
      stopped: false,
      left: 0,
    };
    const bootStarted = now();
    while (readers.some((r) => !r.booted) && now() - bootStarted < BOOT_WAIT_MS) {
      const seq = Atomics.load(ctl, SEQ);
      if (!drain(boot)) {
        Atomics.wait(ctl, SEQ, seq, 50);
      }
    }
    for (const [i, r] of readers.entries()) {
      if (!r.booted) {
        options.log(
          `process-governor: scan reader ${i} not up after ${BOOT_WAIT_MS} ms; scanning without it`,
        );
      }
    }
  };
  awaitBoot();

  const scan: ProcScanner = (visit) => {
    gen += 1;
    const c: Collect = {
      gen,
      byPid: new Map(),
      pending: new Set(),
      visit,
      stopped: false,
      left: 0,
    };
    enlist(c);
    if (c.pending.size === 0) {
      return fallback(visit); // every reader stuck: one thread reads it all, as before 07f4fde2
    }
    Atomics.store(ctl, GEN, gen);
    Atomics.notify(ctl, GEN);
    collect(c);
    if (c.stopped) {
      Atomics.store(ctl, STOP, gen); // readers quit this generation at their next entry
    }
    return {
      measured: isMeasured(procRoot, c.byPid),
      byPid: c.byPid,
      stopped: c.stopped,
      complete: !c.stopped && c.left === 0,
    };
  };

  return {
    scan,
    // Bounded: a reader blocked in a kernel read cannot be terminated until the read returns.
    close: async () => {
      await Promise.race([
        Promise.all(workers.map((w) => w.terminate())),
        new Promise((resolve) => setTimeout(resolve, 1000).unref()),
      ]);
    },
  };
}
