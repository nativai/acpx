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

// Real-process end-to-end: a detached owner (group leader) → adapter → SDK → bg
// job, FOUR levels deep in one process group — faithful to the real Claude spine
// (owner → adapter → SDK binary → the /bin/sh -c tool job the model backgrounded).
// The real `ps` scan must enumerate the whole group and the classifier must return
// exactly the depth-4 bg job (child of the SDK, ∉ {owner, adapter}) while excluding
// the resting owner→adapter→SDK spine. A recursive chain fixture builds the tree so
// nothing false-passes on a too-shallow tree (the depth-3-vs-4 distinction is load
// bearing: a job that IS a direct child of the adapter is the SDK position and must
// be excluded). Mirrors queue-lease-store.test.ts's detached-group process helpers.
test("listProcessGroupMembers + liveBackgroundWorkPids identify a real depth-4 background job", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async (homeDir) => {
    // chain.cjs: at depth N>0 spawn a depth-(N-1) child (same group) and append
    // "<N>:<childPid>" to the out file; at depth 0 just idle (the leaf bg job).
    const chainPath = path.join(homeDir, "chain.cjs");
    await fs.writeFile(
      chainPath,
      "const{spawn}=require('node:child_process');const fs=require('node:fs');" +
        "const depth=Number(process.argv[2]);const out=process.argv[3];" +
        "if(depth>0){const c=spawn(process.execPath,[__filename,String(depth-1),out],{stdio:'ignore'});" +
        "fs.appendFileSync(out,depth+':'+c.pid+'\\n');}" +
        "setInterval(()=>{},1000);",
      "utf8",
    );
    const outFile = path.join(homeDir, "chain.out");
    // owner = depth-3 root: owner(3) → adapter(2) → sdk(1) → job(0/leaf).
    const owner = spawn(process.execPath, [chainPath, "3", outFile], {
      stdio: "ignore",
      detached: true,
    });
    await once(owner, "spawn");
    const ownerPid = owner.pid;

    // Wait until all three interior levels have logged their child pids.
    const readChain = async (): Promise<Map<number, number>> => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          const raw = await fs.readFile(outFile, "utf8");
          const map = new Map<number, number>();
          for (const line of raw.split("\n")) {
            const m = line.trim().match(/^(\d+):(\d+)$/);
            if (m) {
              map.set(Number(m[1]), Number(m[2]));
            }
          }
          if (map.has(3) && map.has(2) && map.has(1)) {
            return map;
          }
        } catch {
          // not written yet
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return new Map();
    };

    let adapterPid = 0;
    let sdkPid = 0;
    let jobPid = 0;
    try {
      assert(ownerPid && Number.isInteger(ownerPid));
      const chain = await readChain();
      adapterPid = chain.get(3) ?? 0; // owner's child
      sdkPid = chain.get(2) ?? 0; // adapter's child
      jobPid = chain.get(1) ?? 0; // sdk's child — the depth-4 bg job
      assert(adapterPid > 0, "adapter pid captured");
      assert(sdkPid > 0, "sdk pid captured");
      assert(jobPid > 0, "bg job pid captured");

      const members = listProcessGroupMembers(ownerPid);
      const memberPids = new Set(members.map((m) => m.pid));
      assert(memberPids.has(ownerPid), "owner is a group member");
      assert(memberPids.has(adapterPid), "adapter is a group member");
      assert(memberPids.has(sdkPid), "sdk is a group member");
      assert(memberPids.has(jobPid), "bg job is a group member");

      const work = liveBackgroundWorkPids(ownerPid, adapterPid, members);
      assert(work.includes(jobPid), "the depth-4 bg job is counted as work");
      assert(!work.includes(ownerPid), "the owner is not work");
      assert(!work.includes(adapterPid), "the adapter is not work");
      assert(!work.includes(sdkPid), "the SDK binary (adapter's direct child) is not work");
    } finally {
      for (const pid of [jobPid, sdkPid, adapterPid, ownerPid]) {
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
