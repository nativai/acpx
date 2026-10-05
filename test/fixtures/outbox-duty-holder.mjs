/**
 * An INTERMITTENT holder of the session outbox's SQLite write lock, from a SEPARATE
 * PROCESS, driven over IPC (brick://b8e251eb F2). It starts with the lock FREE and
 * takes / drops it on command, so a test can pin one duty cycle of the production
 * contention shape (7d717c8a: one owner held the lock ~97 % of the time in bursts)
 * to an exact point in the turn instead of to a timer:
 *
 *   send {cmd:"hold"}    → BEGIN IMMEDIATE, replies {held:true}
 *   send {cmd:"release"} → COMMIT,          replies {held:false}
 *   send {cmd:"exit"}    → releases if held, exits 0
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];

// Refuse anything outside the OS temp dir — this must never be pointed at a real store.
const tempRoot = fs.realpathSync(os.tmpdir());
if (!file || !fs.realpathSync(path.dirname(file)).startsWith(tempRoot)) {
  process.exit(2);
}

const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=10000");
let held = false;

process.on("message", (message) => {
  const cmd = message && typeof message === "object" ? message.cmd : undefined;
  if (cmd === "hold" && !held) {
    db.exec("BEGIN IMMEDIATE");
    held = true;
  } else if ((cmd === "release" || cmd === "exit") && held) {
    db.exec("COMMIT");
    held = false;
  }
  if (cmd === "exit") {
    db.close();
    process.exit(0);
  }
  process.send({ held });
});
process.send({ ready: true });
