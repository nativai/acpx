// brick://db8f8b28 — the independent witness for "nothing a spawn-ledger test started is still alive".
//
// It identifies by what a spawned process CANNOT shed: the throwaway HOME the fixtures hand every CLI
// child (`env: { PATH, HOME }`), and the cwd of the owner/adapter it grows. Deliberately NOT by
// `ACPX_TEST_OWNER_TAG`: that tag is what the reaper kills by, and a reaper that matches nothing looks
// exactly like one that worked — so the witness must not share the reaper's blind spot. (Measured on
// origin/dev efda04ad: the fixtures' `{ PATH, HOME }` env stripped the tag, the owner was setsid'd to
// ppid 1 and lived on for the 30-minute idle default.)

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export type SelftestProcess = { pid: number; comm: string; via: "HOME" | "cwd" };

function under(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isZombie(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return raw.slice(raw.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

/** Every live process (not this one, zombies excluded) whose HOME or cwd lies under `root`. */
export function processesUnder(root: string): SelftestProcess[] {
  const found: SelftestProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isZombie(pid)) {
      continue;
    }
    let via: SelftestProcess["via"] | undefined;
    try {
      const home = readFileSync(`/proc/${entry}/environ`, "utf8")
        .split("\0")
        .find((item) => item.startsWith("HOME="));
      if (home !== undefined && under(home.slice("HOME=".length), root)) {
        via = "HOME";
      }
    } catch {
      // unreadable environ ⇒ not identified by HOME; the cwd leg below may still name it
    }
    if (via === undefined) {
      try {
        if (under(readlinkSync(`/proc/${entry}/cwd`), root)) {
          via = "cwd";
        }
      } catch {
        // unreadable cwd ⇒ not ours to name
      }
    }
    if (via !== undefined) {
      let comm = "?";
      try {
        comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim();
      } catch {
        // exited between the scan and here
      }
      found.push({ pid, comm, via });
    }
  }
  return found;
}
