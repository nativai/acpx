import fs from "node:fs";
import path from "node:path";

// Block A11 / A-67: the two discovering checks (rows 67.4 and 67.5) find their subjects by SCANNING
// `src/`; nothing is registered. Each is proven by a test that plants a fresh subject in a temp tree and
// expects it flagged (`test/pod-proc-readers.test.ts`, `test/pod-temp-names.test.ts`).

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.toSorted();
}

/** Source text without comments, so a sentence about `/proc` in a comment is not a reader of it. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const PROCESS_TABLE_READER =
  /["'`]\/proc(?:["'`/]|\b)|\bprocRoot\b|\.kill\([^()]*,\s*0\s*\)|\b(?:isRecordedPidPossiblyAlive|sessionOwnedByLiveProcess|scanLiveProcesses|isPidAlive|isProcessAlive)\b/;
const CALLS_THE_SCOPE = /\b(?:localProofScope|proofScope|localProof)\b/;

export type ProcReaders = { scoped: string[]; unscoped: string[] };

/** Every file under `root` that reads this host's process table, split by whether it asks the scope. */
export function findProcessTableReaders(root: string): ProcReaders {
  const scoped: string[] = [];
  const unscoped: string[] = [];
  for (const file of listSourceFiles(root)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (!PROCESS_TABLE_READER.test(code)) {
      continue;
    }
    (CALLS_THE_SCOPE.test(code) ? scoped : unscoped).push(path.relative(root, file));
  }
  return { scoped, unscoped };
}

const PID_IN_NAME = /\$\{\s*(?:String\()?process\.pid\b/;
const TEMP_WORD = /tmp|temp/i;
const RANDOM_PART = /randomUUID|randomBytes|uniqueTempPath/;

/**
 * Temp names built from `process.pid` whose statement (the physical line) carries no random part. The
 * helper `uniqueTempPath` is the one place such a name is built correctly; any other line that mixes the
 * pid into a temp-looking name without a random call is flagged — per OCCURRENCE, not per file.
 */
export function findPidOnlyTempNames(root: string): string[] {
  const hits: string[] = [];
  for (const file of listSourceFiles(root)) {
    const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (PID_IN_NAME.test(line) && TEMP_WORD.test(line) && !RANDOM_PART.test(line)) {
        hits.push(`${path.relative(root, file)}:${index + 1}`);
      }
    });
  }
  return hits;
}
