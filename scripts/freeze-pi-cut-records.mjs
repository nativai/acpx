// brick 4bf088a7 (DESIGN Q1) — freeze real session records as a READ-ONLY snapshot OUTSIDE git.
//
// The affected records hold the owner's messages and raw tool output, so they are never committed
// anywhere (this repo, /wisdom). This copies, from the live store and by READ only, per id:
//   <out>/state/.acpx/sessions[-archive]/<id>.{json,messages.ndjson[.zst],…}   (the record's files)
//   <out>/pi-agent/sessions/<slug>/<file>.jsonl                                (the pi file the product locates)
// then makes every file 0444 and writes MANIFEST.sha256. The real-record suite runs against it with
//   ACPX_STATE_HOME=<out>/state  ACPX_PI_BOX_AGENT_DIR=<out>/pi-agent  ACPX_PI_CUT_REAL_FIXTURES=<out>
//
// Usage: node scripts/freeze-pi-cut-records.mjs <dist-test root> <ids file> <out dir>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, idsFile, out] = process.argv.slice(2);
if (!root || !idsFile || !out) {
  console.error("usage: freeze-pi-cut-records.mjs <dist-test root> <ids file> <out dir>");
  process.exit(2);
}
const load = async (rel) => await import(pathToFileURL(path.join(root, rel)).href);
const { resolveSessionRecord } = await load("src/session/persistence/repository.js");
const { locatePiSessionTranscript } = await load("src/acp/harness-config-dir.js");
const { sessionBaseDir } = await load("src/session/persistence.js");

if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
  console.error(`refusing: ${out} already holds files (a frozen snapshot is never overwritten)`);
  process.exit(2);
}
const live = sessionBaseDir();
const liveArchive = path.join(path.dirname(live), "sessions-archive");
const ids = fs
  .readFileSync(idsFile, "utf8")
  .split("\n")
  .map((l) => l.split(" ")[0])
  .filter(Boolean);
const manifest = [];
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  manifest.push(to);
};
for (const id of ids) {
  const record = await resolveSessionRecord(id);
  for (const [dir, destName] of [
    [live, "sessions"],
    [liveArchive, "sessions-archive"],
  ]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir).filter((n) => n.startsWith(`${id}.`))) {
      copy(path.join(dir, name), path.join(out, "state", ".acpx", destName, name));
    }
  }
  const located = locatePiSessionTranscript({ cwd: record.cwd, acpSessionId: record.acpSessionId });
  if (!located) {
    console.error(`no pi file for ${id}`);
    process.exit(1);
  }
  copy(
    located.path,
    path.join(out, "pi-agent", "sessions", path.basename(path.dirname(located.path)), located.name),
  );
}
const lines = manifest
  .toSorted((a, b) => a.localeCompare(b))
  .map(
    (f) =>
      `${createHash("sha256").update(fs.readFileSync(f)).digest("hex")}  ${path.relative(out, f)}`,
  );
fs.writeFileSync(path.join(out, "MANIFEST.sha256"), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(out, "IDS.txt"), `${ids.join("\n")}\n`);
for (const f of [...manifest, path.join(out, "MANIFEST.sha256"), path.join(out, "IDS.txt")]) {
  fs.chmodSync(f, 0o444);
}
console.log(`froze ${ids.length} records, ${manifest.length} files into ${out}`);
