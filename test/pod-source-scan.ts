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

// ⚠️ THE SPELLINGS THE SCAN KNOWS ARE ITS WHOLE WORLD (TE LOW-4): a reader that reaches the process table
// through a helper this list does not name is invisible to it. Name a new helper here when one is added.
const PROCESS_TABLE_HELPERS = [
  "isRecordedPidPossiblyAlive",
  "sessionOwnedByLiveProcess",
  "scanLiveProcesses",
  "isPidAlive",
  "isProcessAlive",
  "isProcessDefinitelyDead",
  "observeProcessIncarnation",
  "readProcessBirthIdentity",
  "scanLivePids",
  "pidObservedLive",
  "listLiveGroupMembers",
].join("|");
const PROCESS_TABLE_READER = new RegExp(
  // `/proc` as a path literal, `procRoot`, `kill(<anything>, 0)` (the pid expression may hold parentheses,
  // `kill(Number(x), 0)`), or one of the helpers above.
  `["'\`]/proc(?:["'\`/]|\\b)|\\bprocRoot\\b|\\.kill\\([^;]*?,\\s*0\\s*\\)|\\b(?:${PROCESS_TABLE_HELPERS})\\b`,
);
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

// A pid mixed into a name: in a template (`${process.pid}`), by concatenation (`"." + process.pid`,
// `process.pid + "."`) or through `String(…)` / `.toString()`.
const PID_IN_NAME =
  /\$\{\s*(?:String\()?process\.pid\b|[+]\s*(?:String\()?process\.pid\b|\bprocess\.pid(?:\.toString\(\))?\s*[+]|String\(\s*process\.pid\s*\)/;
const TEMP_WORD = /tmp|temp/i;
const RANDOM_PART = /randomUUID|randomBytes|uniqueTempPath/;

/**
 * Temp names built from `process.pid` whose STATEMENT (the text up to the next `;`, so a name split over
 * several lines is one subject) carries no random part. The helper `uniqueTempPath` is the one place such
 * a name is built correctly; any other statement that mixes the pid into a temp-looking name without a
 * random call is flagged — per OCCURRENCE, not per file. Reported as `file:line` of the pid.
 */
export function findPidOnlyTempNames(root: string): string[] {
  const hits: string[] = [];
  for (const file of listSourceFiles(root)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    let line = 1;
    for (const statement of code.split(";")) {
      const pid = PID_IN_NAME.exec(statement);
      if (pid && TEMP_WORD.test(statement) && !RANDOM_PART.test(statement)) {
        const pidLine = line + statement.slice(0, pid.index).split("\n").length - 1;
        hits.push(`${path.relative(root, file)}:${pidLine}`);
      }
      line += statement.split("\n").length - 1;
    }
  }
  return hits;
}
