// brick c92f6bdc, Fix A — the background-work inventory (process-group scan,
// adapter-anchored). The idle gate must treat live background process-group work
// as "not idle" (peer of hasActiveTurn). This suite pins the pure classifier
// `liveBackgroundWorkPids` (owner + adapter + their direct children excluded;
// everything at depth >= 3 from the owner is model-spawned work) both against
// deterministic injected snapshots and against a real detached 3-deep group.
//
// Why depth >= 3, not a command-name allowlist (DESIGN §3.1): the resting Claude
// spine is owner -> adapter -> SDK binary (a clean linear chain). A `/bin/sh -c`
// tool job and everything it spawns is a grandchild of the SDK binary — depth >= 3
// — and stays in the group even after its `claude`-binary parent dies (reparented
// ppid still not in {ownerPid, adapterPid}). See DESIGN §2.1 for the falsified
// terminal-manager premise this replaces.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  type ProcessGroupMember,
  listProcessGroupMembers,
  liveBackgroundWorkPids,
} from "../src/process-group-inventory.js";
import { withTempHome } from "./queue-test-helpers.js";

const OWNER = 1000;
const ADAPTER = 1001;
const PS_PROBE = 1002; // a `ps` child of the owner (the scan itself) — must be excluded
const SDK = 1003; // the persistent claude SDK binary, direct child of the adapter
const SH_JOB = 1004; // /bin/sh -c "...long..." — the backgrounded tool command (work)
const SH_GRANDCHILD = 1005; // a descendant of the sh job (still work)

// The resting spine + a live background job, as a synthetic ps snapshot.
function snapshotWithWork(): ProcessGroupMember[] {
  return [
    { pid: OWNER, ppid: 1 }, // owner (group leader), parented to init
    { pid: ADAPTER, ppid: OWNER }, // adapter — direct child of owner
    { pid: PS_PROBE, ppid: OWNER }, // the ps scan itself — direct child of owner
    { pid: SDK, ppid: ADAPTER }, // SDK binary — direct child of adapter
    { pid: SH_JOB, ppid: SDK }, // backgrounded /bin/sh -c — depth 3 → WORK
    { pid: SH_GRANDCHILD, ppid: SH_JOB }, // its descendant — depth 4 → WORK
  ];
}

test("liveBackgroundWorkPids: depth>=3 group members are work; the resting spine is excluded", () => {
  const work = liveBackgroundWorkPids(OWNER, ADAPTER, snapshotWithWork());
  assert.deepEqual(
    work.sort((a, b) => a - b),
    [SH_JOB, SH_GRANDCHILD],
    "the backgrounded job and its descendant count as work; owner/adapter/ps-probe/SDK do not",
  );
});

test("liveBackgroundWorkPids: only the resting spine (owner + adapter + SDK + ps probe) ⇒ no work", () => {
  const resting: ProcessGroupMember[] = [
    { pid: OWNER, ppid: 1 },
    { pid: ADAPTER, ppid: OWNER },
    { pid: PS_PROBE, ppid: OWNER },
    { pid: SDK, ppid: ADAPTER },
  ];
  assert.deepEqual(liveBackgroundWorkPids(OWNER, ADAPTER, resting), []);
});

test("liveBackgroundWorkPids: a reparented job whose claude-binary parent died is still work", () => {
  // The SDK binary (SH_JOB's grandparent chain) is gone; the sh job reparented to
  // the owner's group leader? No — on Linux it reparents to init/subreaper, but it
  // stays in the owner's PROCESS GROUP (pgid unchanged). Its ppid is now init (1),
  // which is NOT in {ownerPid, adapterPid} ⇒ still counted. This is the robustness
  // the depth-based rule buys over a parent-chain walk.
  const reparented: ProcessGroupMember[] = [
    { pid: OWNER, ppid: 1 },
    { pid: ADAPTER, ppid: OWNER },
    { pid: SH_JOB, ppid: 1 }, // reparented after `claude` died, still group-resident
  ];
  assert.deepEqual(liveBackgroundWorkPids(OWNER, ADAPTER, reparented), [SH_JOB]);
});

test("liveBackgroundWorkPids: adapterPid undefined degrades safely (only owner + direct children excluded)", () => {
  // Adapter not yet up. The scan excludes the owner and its direct children only.
  // Anything deeper (the adapter subtree) counts as work → errs toward staying warm
  // (bounded by the cap). No false-idle.
  const members: ProcessGroupMember[] = [
    { pid: OWNER, ppid: 1 },
    { pid: ADAPTER, ppid: OWNER }, // direct child of owner → excluded
    { pid: SDK, ppid: ADAPTER }, // depth 2 from owner → counted (adapter unknown)
  ];
  assert.deepEqual(liveBackgroundWorkPids(OWNER, undefined, members), [SDK]);
});

test("liveBackgroundWorkPids: an empty snapshot ⇒ no work (never throws)", () => {
  assert.deepEqual(liveBackgroundWorkPids(OWNER, ADAPTER, []), []);
});

// Real-process end-to-end: a detached owner (group leader) -> adapter -> bg job,
// three levels deep, in one process group. The real `ps` scan must enumerate them
// and the classifier must return exactly the depth-3 bg job. Mirrors
// queue-lease-store.test.ts's detached-group process helpers.
test("listProcessGroupMembers + liveBackgroundWorkPids identify a real depth-3 background job", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async (homeDir) => {
    const adapterPidFile = path.join(homeDir, "adapter.pid");
    const jobPidFile = path.join(homeDir, "job.pid");
    // owner spawns "adapter"; "adapter" spawns "bg job". Each writes its child's pid.
    const script =
      "const{spawn}=require('node:child_process');const fs=require('node:fs');" +
      "const adapter=spawn(process.execPath,['-e'," +
      "\"const{spawn}=require('node:child_process');const fs=require('node:fs');" +
      "const job=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      'fs.writeFileSync(process.argv[1],String(job.pid));setInterval(()=>{},1000);"' +
      ",process.argv[2]],{stdio:'ignore'});" +
      "fs.writeFileSync(process.argv[1],String(adapter.pid));setInterval(()=>{},1000);";
    const owner = spawn(process.execPath, ["-e", script, adapterPidFile, jobPidFile], {
      stdio: "ignore",
      detached: true,
    });
    await once(owner, "spawn");
    const ownerPid = owner.pid;

    const readPid = async (file: string): Promise<number> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const raw = (await fs.readFile(file, "utf8")).trim();
          const parsed = Number(raw);
          if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
          }
        } catch {
          // pid file not written yet
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return 0;
    };

    let adapterPid = 0;
    let jobPid = 0;
    try {
      assert(ownerPid && Number.isInteger(ownerPid));
      adapterPid = await readPid(adapterPidFile);
      jobPid = await readPid(jobPidFile);
      assert(adapterPid > 0, "adapter pid captured");
      assert(jobPid > 0, "bg job pid captured");

      const members = listProcessGroupMembers(ownerPid);
      const memberPids = new Set(members.map((m) => m.pid));
      assert(memberPids.has(ownerPid), "owner is a group member");
      assert(memberPids.has(adapterPid), "adapter is a group member");
      assert(memberPids.has(jobPid), "bg job is a group member");

      const work = liveBackgroundWorkPids(ownerPid, adapterPid, members);
      assert(work.includes(jobPid), "the depth-3 bg job is counted as work");
      assert(!work.includes(ownerPid), "the owner is not work");
      assert(!work.includes(adapterPid), "the adapter is not work");
    } finally {
      for (const pid of [jobPid, adapterPid, ownerPid]) {
        if (pid && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  });
});
