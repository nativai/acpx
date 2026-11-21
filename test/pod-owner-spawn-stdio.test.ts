import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildQueueOwnerSpawnOptions } from "../src/cli/session/queue-owner-process.js";

// T1's requirement on acpx (ap-transport a19d7631, decision 3): the pod-side entry stops relaying the
// routed command's output 1 s after the command exits, so the detached queue owner that a routed
// `prompt` starts must NEVER inherit the command's stdout/stderr — it gets /dev/null or its own log
// file — and must stand in its own process group (outside the deadline's group kill).

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a6-owner-stdio-"));

const PROBE = `
const fs = require("node:fs");
const link = (n) => { try { return fs.readlinkSync("/proc/self/fd/" + n); } catch { return null; } };
const stat = fs.readFileSync("/proc/self/stat", "utf8");
const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
fs.writeFileSync(process.env.A6_PROBE_OUT, JSON.stringify({ fd0: link(0), fd1: link(1), fd2: link(2), pid: process.pid, pgrp }));
`;

type Seen = {
  fd0: string | null;
  fd1: string | null;
  fd2: string | null;
  pid: number;
  pgrp: number;
};

async function ownerSeenFds(logFd: number | null): Promise<Seen> {
  const out = path.join(fs.mkdtempSync(path.join(ROOT, "run-")), "seen.json");
  process.env.A6_PROBE_OUT = out;
  const options = buildQueueOwnerSpawnOptions("{}", logFd);
  const child = spawn(process.execPath, ["-e", PROBE], options);
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await exited;
  delete process.env.A6_PROBE_OUT;
  return JSON.parse(fs.readFileSync(out, "utf8")) as Seen;
}

test("owner spawn: with no log, stdio is /dev/null and the owner stands in its own process group", async () => {
  const seen = await ownerSeenFds(null);
  assert.equal(seen.fd0, "/dev/null");
  assert.equal(seen.fd1, "/dev/null");
  assert.equal(seen.fd2, "/dev/null");
  assert.equal(
    seen.pgrp,
    seen.pid,
    "detached: its own group, outside the routed command's deadline kill",
  );
});

test("owner spawn: with a log, stdout and stderr are the owner's OWN log file, never the caller's pipes", async () => {
  const log = path.join(ROOT, "owner.log");
  const fd = fs.openSync(log, "a");
  try {
    const seen = await ownerSeenFds(fd);
    assert.equal(seen.fd0, "/dev/null");
    assert.equal(seen.fd1, log);
    assert.equal(seen.fd2, log);
    assert.equal(seen.pgrp, seen.pid);
  } finally {
    fs.closeSync(fd);
  }
});

test("owner spawn: the options never name an inheriting stdio (negative: inherit / pipe / fd 1 or 2 of the caller)", () => {
  for (const logFd of [null, 7]) {
    const { stdio, detached } = buildQueueOwnerSpawnOptions("{}", logFd);
    assert.equal(detached, true);
    const entries = typeof stdio === "string" ? [stdio, stdio, stdio] : stdio;
    for (const entry of entries) {
      assert.notEqual(entry, "inherit");
      assert.notEqual(entry, "pipe");
      assert.ok(
        entry === "ignore" || (typeof entry === "number" && entry === logFd),
        String(entry),
      );
    }
  }
});
