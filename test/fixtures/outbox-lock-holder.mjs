/**
 * Holds the session outbox's SQLite write lock from a SEPARATE PROCESS until told to
 * release over IPC. Modelled on `b14-lock-holder.mjs`, which is hard-gated to the
 * `/workspace/bricksdb-b14-selftest/` HOME and so cannot be pointed at a test temp store.
 *
 * Used by `outbox-write-ordering.test.ts` as a POSITIVE CONTROL: it proves the harness can
 * produce `outbox-busy` at all, so an in-process row that comes back green is
 * distinguishable from an in-process row that was never capable of going red.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const marker = process.argv[3];

// Refuse anything outside the OS temp dir — this must never be pointed at a real store.
const tempRoot = fs.realpathSync(os.tmpdir());
if (!file || !marker) {
  process.exit(2);
}
if (!fs.realpathSync(path.dirname(file)).startsWith(tempRoot)) {
  process.exit(2);
}

const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
fs.writeFileSync(marker, "ACTED=1");

process.on("message", () => {
  db.exec("COMMIT");
  db.close();
  process.exit(0);
});
