import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { CAPACITY_CONSTANTS } from "../capacity/constants.js";
import {
  cachedTokenState,
  classifySessions,
  entrypointSid,
  type GovProc,
  isExemptTerminal,
  loadGroupMemory,
  parseGovProcStat,
  type SessionView,
} from "../capacity/governor/classify.js";
import type { GovernorEvent } from "../capacity/governor/record.js";
import {
  governorDir,
  type GovernorHeartbeat,
  type GovernorLiveness,
  heartbeatProcessAlive,
  readGovernorLiveness,
  readHeartbeat,
} from "../capacity/governor/status.js";
import { verifiedLeaseOwners } from "../capacity/leases.js";
import { capacitySourcesFromEnv } from "../capacity/reading.js";
import { scanProcTable } from "../process-tree-reap.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";

/**
 * `acpx governor status` and `acpx governor scan` (CONCEPTION 5d7a23b6 §7.2) — READ-ONLY views of the
 * runaway process-tree governor. The daemon itself is NEVER started through this parser: it runs from
 * its own entry file, `dist/capacity/governor/main.js` (F19).
 *
 * `scan` runs the governor's classifier once and prints every session's placement — no signal, no
 * event, no state written. It reads only `/proc/<pid>/stat`, and `cmdline` through the match-only
 * queue-owner check; nothing but comm names and numbers is printed.
 */

const RECENT_EVENTS = 10;
const TAIL_BYTES = 256 * 1024;

function tailEvents(file: string, limit: number): GovernorEvent[] {
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const events: GovernorEvent[] = [];
  for (const line of text.split("\n").slice(-limit - 1)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") {
        events.push(parsed as GovernorEvent);
      }
    } catch {
      // a partial first line of the tail
    }
  }
  return events.slice(-limit);
}

export type GovernorStatus = GovernorLiveness & {
  readonly action: "governor_status";
  readonly configured: {
    readonly mode: string;
    readonly governTerminals: boolean;
    readonly maxGroupProcesses: number;
  };
  readonly heartbeat: GovernorHeartbeat | null;
  readonly recentEvents: GovernorEvent[];
};

export function governorStatusJson(dir: string, nowMs: number): GovernorStatus {
  return {
    action: "governor_status",
    configured: {
      mode: CAPACITY_CONSTANTS.governor.mode,
      governTerminals: CAPACITY_CONSTANTS.governor.governTerminals,
      maxGroupProcesses: CAPACITY_CONSTANTS.governor.maxGroupProcesses,
    },
    ...readGovernorLiveness(dir, nowMs),
    heartbeat: readHeartbeat(dir) ?? null,
    recentEvents: tailEvents(path.join(dir, "events.ndjson"), RECENT_EVENTS),
  };
}

function heartbeatLine(status: GovernorStatus): string {
  const hb = status.heartbeat;
  if (!hb) {
    return "governor: no heartbeat (not running on this box, or never started)";
  }
  const reason = hb.observeReason ? ` (${hb.observeReason})` : "";
  return (
    `governor: ${status.alive ? "alive" : "NOT ALIVE"} · pid ${hb.pid} · mode ${hb.mode}${reason}` +
    ` · last scan ${hb.lastScanAt} (${hb.scanMs} ms) · ${hb.killsLast24h} kill(s) in 24 h`
  );
}

const dash = (value: string | number | null): string =>
  value === null || value === "" ? "-" : String(value);

function writeStatusText(status: GovernorStatus): void {
  const lines = [heartbeatLine(status)];
  for (const event of status.recentEvents) {
    lines.push(
      `  ${event.captured_at}Z ${event.action} ${dash(event.rule)} kind=${dash(event.session_kind)} ` +
        `processes=${dash(event.processes)} notify=${dash(event.notify_status)} event=${event.event_id}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The system session as `scan` sees it: the live governor's own, else PID 1's earliest child's. */
function systemSidFor(
  byPid: ReadonlyMap<number, GovProc>,
  dir: string,
): { sid: number | undefined; source: string } {
  const hb = readHeartbeat(dir);
  const governor = hb && heartbeatProcessAlive(hb) ? byPid.get(hb.pid) : undefined;
  if (governor) {
    return { sid: governor.sid, source: "governor" };
  }
  return { sid: entrypointSid(byPid), source: "pid1-earliest-child" };
}

function commCounts(view: SessionView): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of view.members) {
    counts.set(m.comm, (counts.get(m.comm) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 5);
}

function placementFields(view: SessionView): Record<string, unknown> {
  const placement = view.record.placement;
  if (!placement.governed) {
    return {
      governed: false,
      kind: null,
      reason: placement.reason,
      exempt: false,
      attribution: null,
    };
  }
  return {
    governed: true,
    kind: placement.kind,
    reason: null,
    exempt: isExemptTerminal(placement, CAPACITY_CONSTANTS.governor.governTerminals),
    attribution: placement.attribution.label,
    sessionId: placement.attribution.sessionId ?? null,
    seatId: placement.attribution.seatId ?? null,
  };
}

function sessionRow(view: SessionView): Record<string, unknown> {
  return {
    sid: view.sid,
    ...placementFields(view),
    processes: view.members.length,
    threads: view.threads,
    orphaned: view.orphaned,
    leader: view.leader ? { comm: view.leader.comm, tty: view.leader.ttyNr !== 0 } : null,
    commTop: commCounts(view),
  };
}

export function governorScanJson(dir: string, nowMs: number): Record<string, unknown> {
  const sources = capacitySourcesFromEnv();
  const scan = scanProcTable(sources.procRoot, parseGovProcStat);
  const system = systemSidFor(scan.byPid, dir);
  const owners = verifiedLeaseOwners({
    queueDir: sources.queueDir,
    sessionsDir: sources.sessionsDir,
    procRoot: sources.procRoot,
    nowMs,
    freshMs: CAPACITY_CONSTANTS.leaseFreshMs,
  });
  const memory = loadGroupMemory(path.join(dir, "groups.json"));
  const { sessions } = classifySessions(
    scan.byPid,
    {
      systemSid: system.sid ?? -1,
      leaseOwners: new Map(
        owners.map((o) => [o.pid, { sessionId: o.sessionId, seatId: o.seatId }]),
      ),
      tokenState: cachedTokenState(sources.procRoot, () => scan.byPid),
    },
    memory,
    nowMs,
  );
  const rows = [...sessions.values()]
    .map(sessionRow)
    .toSorted((a, b) => Number(b.processes) - Number(a.processes));
  return {
    action: "governor_scan",
    measured: scan.measured,
    systemSid: system.sid ?? null,
    systemSidSource: system.source,
    processes: scan.byPid.size,
    sessions: rows,
  };
}

function writeScanText(scan: Record<string, unknown>): void {
  const lines = [
    `scan: ${String(scan.processes)} processes · system sid ${String(scan.systemSid)} (${String(scan.systemSidSource)})${scan.measured ? "" : " · UNMEASURED"}`,
  ];
  for (const row of scan.sessions as Array<Record<string, unknown>>) {
    const label = row.governed
      ? `${String(row.kind)}${row.exempt ? " (exempt)" : ""} ${String(row.attribution)}`
      : `ungoverned:${String(row.reason)}`;
    const comms = (row.commTop as Array<[string, number]>).map(([c, n]) => `${c}×${n}`).join(" ");
    lines.push(`  sid ${String(row.sid)} · ${label} · ${String(row.processes)} proc · ${comms}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS: this one, and `"governor"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`). Without the second, `acpx governor …` is absorbed as an AGENT NAME and, in a
 * session-bearing cwd, the rest of the line becomes a prompt delivery (F19).
 */
export function registerGovernorCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const governor = parent
    .command("governor")
    .description(
      "The runaway process-tree governor on this box (read-only): status, or one classification scan",
    );
  governor
    .command("status")
    .description("Liveness, mode and the latest events of this box's governor")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command) {
      const { format } = resolveGlobalFlags(this, config);
      const status = governorStatusJson(governorDir(), Date.now());
      if (!emitJsonResult(format, status)) {
        writeStatusText(status);
      }
    });
  governor
    .command("scan")
    .description("Classify every session on this box once (no action taken)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command) {
      const { format } = resolveGlobalFlags(this, config);
      const scan = governorScanJson(governorDir(), Date.now());
      if (!emitJsonResult(format, scan)) {
        writeScanText(scan);
      }
    });
}
