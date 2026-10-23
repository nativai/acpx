import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const file = process.argv[2];
const marker = process.argv[3];
// The test mints a per-run `spawn-ledger-selftest-*` root (brick://db8f8b28): refuse any other path.
const inSelftestRoot = (candidate) =>
  candidate?.split("/").some((segment) => segment.startsWith("spawn-ledger-selftest-"));
if (!inSelftestRoot(file) || !inSelftestRoot(marker)) {
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
