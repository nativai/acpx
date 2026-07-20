import { execFileSync } from "node:child_process";

// brick c92f6bdc, Fix A — the work-inventory source for the owner's work-aware
// idleness gate. The queue owner is spawned `detached: true`
// (queue-owner-process.ts), so it is its own process-group leader and every
// descendant — the adapter, the SDK binary, and every command the model runs —
// shares its group. This module answers "is there live background work under me?"
// by scanning that group, WITHOUT relying on the terminal-manager (which is EMPTY
// for Claude sessions: the SDK runs Bash tools in-process, never via ACP
// terminal/create — see DESIGN §2.1, the falsified original premise).

export type ProcessGroupMember = { pid: number; ppid: number };

// Enumerate live members of the process group led by `pgid`, with parent pids.
// `readMembers` is an injectable seam so the classifier + callers unit-test
// without spawning real processes; the default is the real `ps` scan below.
// Mirrors the existing `ps` usage at terminal-manager.ts (pid,pgid) and
// queue-owner-runtime.ts (pgid of self), extended with ppid so depth is derivable.
export function listProcessGroupMembers(
  pgid: number,
  readMembers: () => ProcessGroupMember[] = () => readProcessGroupMembersFromPs(pgid),
): ProcessGroupMember[] {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) {
    return [];
  }
  return readMembers();
}

function readProcessGroupMembersFromPs(pgid: number): ProcessGroupMember[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // ps unavailable / errored → report no members. The caller (the idle gate)
    // treats "no work" as releasable, but a failed scan there errs safe: the
    // North-Star hasActiveTurn gate and the graceful drain still apply, and a
    // genuinely-running foreground turn is protected by the turn gate regardless.
    return [];
  }

  const members: ProcessGroupMember[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const memberPgid = Number(match[3]);
    if (
      Number.isInteger(pid) &&
      Number.isInteger(ppid) &&
      Number.isInteger(memberPgid) &&
      pid > 0 &&
      memberPgid === pgid
    ) {
      members.push({ pid, ppid });
    }
  }
  return members;
}

// The work inventory. A live group member is background WORK iff it is neither the
// owner nor the adapter, AND not a direct child of either — i.e. everything at
// depth >= 3 from the owner (DESIGN §3.1):
//   workPids = { m : m.pid ∉ {ownerPid, adapterPid} ∧ m.ppid ∉ {ownerPid, adapterPid} }
// This excludes the entire resting Claude spine WITHOUT a brittle command-name
// allowlist:
//   - the owner            (pid === ownerPid)
//   - the adapter          (pid === adapterPid)
//   - the `ps` probe + any other direct child of the owner (ppid === ownerPid)
//   - the SDK binary + any other direct child of the adapter (ppid === adapterPid)
// while INCLUDING a `/bin/sh -c` tool job and all its descendants (they chain to
// the SDK binary, ∉ the excluded set), even after the `claude`-binary parent dies
// (the job stays in the group; its reparented ppid is still ∉ the set), and robust
// to the SDK binary restarting (a new direct child of the adapter → still excluded).
//
// If `adapterPid` is undefined (adapter not yet up), the scan degrades to
// "owner + its direct children excluded" — safe: at worst it counts the adapter
// subtree as work → stays warm, bounded by the §3.3 cap. Never false-idle.
//
// Limitation (bounded, DESIGN §7 Fork-2; precision follow-up brick://01535b18):
// an MCP server (child of the SDK binary → depth 3) or a leaked sub-agent `claude`
// (depth 3) is counted as work → false-BUSY. Acceptable: it errs toward staying
// warm and the cap bounds it. Validated for the Claude adapter's clean 3-proc
// topology; other adapters (Codex/PTY) may nest differently.
export function liveBackgroundWorkPids(
  ownerPid: number,
  adapterPid: number | undefined,
  members: ProcessGroupMember[],
): number[] {
  const anchors = new Set<number>([ownerPid]);
  if (adapterPid !== undefined) {
    anchors.add(adapterPid);
  }
  const workPids: number[] = [];
  for (const member of members) {
    if (anchors.has(member.pid) || anchors.has(member.ppid)) {
      continue;
    }
    workPids.push(member.pid);
  }
  return workPids;
}
