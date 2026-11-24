import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "../src/perf-metrics.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import {
  appendStreamText,
  appendStreamTextSync,
  listSessionEvents,
  parseStreamPayload,
  SessionEventWriter,
} from "../src/session/events.js";
import { exportSession } from "../src/session/export.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { frame, frameNumbers, seedRecord, shapeOf, withTempHome } from "./stream-appender-kit.js";

// brick 3f33cc2d, rows for code that exists only with the fix (they do not compile on 57004dd5): the
// helper itself, the one-helper scan (A-63 row 63.4) and the readers' count-and-log of a damaged line
// (A-63 row 63.3). The production-path rows are in `stream-appenders.test.ts`.

const SRC_ROOT = new URL("../../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Strips `//` and block comments, so a comment naming an identifier is not a use of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Where the stream's active path may be built, and what each may do with it. Everything else is red.
 * BY CONSTRUCTION: the path comes from `sessionEventActivePath` / `activeEventPath` / `eventLog.active_path`
 * only; a module that is not on this list cannot be appending to the stream, whatever it calls.
 */
const STREAM_PATH_USERS: Record<string, "helper" | "no-append"> = {
  "session/events.ts": "helper",
  "session/event-log.ts": "no-append", // builds the path
  "session/import.ts": "no-append", // creates a NEW session's file with `writeFile`: no writer can exist yet
  "session/export.ts": "no-append", // reads
  "session/persistence/index.ts": "no-append", // the session index carries the record's active_path
  "session/persistence/parse.ts": "no-append", // parses the record's active_path field
};
const STREAM_PATH_TOKEN =
  /\b(sessionEventActivePath|activeEventPath|sessionEventSegmentPath|segmentEventPath)\b|eventLog\??\.active_path|\.active_path\b/;
/** Text that builds a stream file name by hand (a path that does not come from the tokens above). */
const HAND_BUILT_STREAM = /stream\.ndjson|\.stream\.\$\{|\.stream\.\d/;
/** The only functions of the helper module that may append, each reviewed (the helper and its two tail writers). */
const HELPER_APPEND_FUNCTIONS = new Set([
  "appendInParts",
  "closeDeadTail",
  "appendClosingTailSync",
  "appendStepSync",
]);
/** The only exported appenders of events.ts: a new one is a new way to append a caller-given path. */
const HELPER_EXPORTED_APPENDERS = ["appendInParts", "appendStreamText", "appendStreamTextSync"];

/** The text between the parenthesis that opens at `openIndex` and its match (strings and nesting respected). */
function balancedArgs(text: string, openIndex: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quote !== undefined) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openIndex + 1, i);
      }
    }
  }
  return text.slice(openIndex + 1);
}

/** Every append shape in `text`, with where it starts: a call by name, an open in append mode, a write with an append flag, O_APPEND. */
function appendShapes(text: string): { shape: string; at: number }[] {
  const found: { shape: string; at: number }[] = [];
  for (const match of text.matchAll(
    /\b(appendFile|appendFileSync|createWriteStream|appendInParts)\s*\(/g,
  )) {
    found.push({ shape: match[1] ?? "append", at: match.index });
  }
  for (const match of text.matchAll(/\b(open|openSync|writeFile|writeFileSync)\s*\(/g)) {
    const args = balancedArgs(text, match.index + match[0].length - 1);
    if (/["'`]a[+sx]?["'`]|\bO_APPEND\b/.test(args)) {
      found.push({ shape: `${match[1]} in append mode`, at: match.index });
    }
  }
  for (const match of text.matchAll(/\bO_APPEND\b/g)) {
    found.push({ shape: "O_APPEND", at: match.index });
  }
  return found;
}

function enclosingFunction(text: string, at: number): string {
  const before = text.slice(0, at);
  const all = [...before.matchAll(/\bfunction\s+(\w+)/g)];
  return all.at(-1)?.[1] ?? "(top level or a method)";
}

export function streamAppendViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [file, raw] of files) {
    const text = code(raw);
    const shapes = appendShapes(text);
    const role = STREAM_PATH_USERS[file];
    if (STREAM_PATH_TOKEN.test(text)) {
      if (role === undefined) {
        violations.push(`${file}: builds or uses the stream path but is not a registered user`);
      } else if (role === "no-append" && shapes.length > 0) {
        violations.push(`${file}: a stream-path user that may not append, appends`);
      }
    }
    if (file === "session/events.ts") {
      for (const { shape, at } of shapes) {
        if (shape === "appendInParts") {
          continue; // the helper's own flush, called from its own writer
        }
        const owner = enclosingFunction(text, at);
        if (!HELPER_APPEND_FUNCTIONS.has(owner)) {
          violations.push(
            `${file}: a raw ${shape} inside ${owner}, outside the helper's own functions`,
          );
        }
      }
      const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(append\w*)/g)].map(
        (m) => m[1],
      );
      if (
        JSON.stringify(exported.toSorted()) !== JSON.stringify(HELPER_EXPORTED_APPENDERS.toSorted())
      ) {
        violations.push(
          `${file}: the exported appenders are ${exported.join(", ")}, not the reviewed set`,
        );
      }
      continue;
    }
    if (shapes.some(({ shape }) => shape === "O_APPEND") && !O_APPEND_REVIEWED.has(file)) {
      violations.push(`${file}: O_APPEND outside the helper module`);
    }
    if (shapes.some(({ shape }) => shape === "appendInParts")) {
      violations.push(`${file}: calls appendInParts outside the helper module`);
    }
    if (
      HAND_BUILT_STREAM.test(text) &&
      role === undefined &&
      shapes.length > 0 &&
      !HAND_BUILT_REVIEWED.has(file)
    ) {
      violations.push(
        `${file}: names a stream file by hand and appends (${shapes.map((x) => x.shape).join(", ")})`,
      );
    }
  }
  return violations;
}

/** Modules that use O_APPEND, reviewed: each appends to its OWN ledger file, none to a session stream. */
const O_APPEND_REVIEWED = new Set<string>(["capacity/governor/notify.ts", "cli/message-ledger.ts"]);

/** Modules that name stream files by hand and also append, reviewed: their appends are not to a stream. */
const HAND_BUILT_REVIEWED = new Set<string>([]);

function realSources(): Map<string, string> {
  return new Map(
    sourceFiles(SRC_ROOT).map((file) => [
      path.relative(SRC_ROOT, file),
      fs.readFileSync(file, "utf8"),
    ]),
  );
}

test("63.4 SCAN: no source file but the helper module appends to a session's stream (discovering)", () => {
  const files = realSources();
  assert.ok(files.size > 100, `the scan found the source tree (${files.size} files)`);
  const users = [...files]
    .filter(([, text]) => STREAM_PATH_TOKEN.test(code(text)))
    .map(([file]) => file);
  assert.ok(users.includes("session/events.ts"), "positive control: the helper module is found");
  const helperAppends = appendShapes(code(files.get("session/events.ts") ?? ""));
  assert.ok(helperAppends.length >= 4, "positive control: the scan sees the helper's own appends");
  assert.deepEqual(streamAppendViolations(files), []);
});

test("63.4 SCAN negatives: a planted append past the helper is red, in every shape (plants go into a COPY of the source map)", () => {
  const base = realSources();
  const events = base.get("session/events.ts") ?? "";
  const plant = (name: string, text: string): string[] =>
    streamAppendViolations(new Map([...base, [name, text]]));
  const plantInto = (name: string, extra: string): string[] =>
    streamAppendViolations(new Map([...base, [name, `${base.get(name) ?? ""}\n${extra}`]]));
  const red = (violations: string[], why: string): void => {
    assert.equal(violations.length, 1, `${why}: ${violations.join(" | ")}`);
  };
  red(
    plant(
      "cli/new-appender.ts",
      `import { sessionEventActivePath } from "../session/event-log.js";\nawait appendFile(sessionEventActivePath(id), line, "utf8");`,
    ),
    "a NEW module that appends to the stream path",
  );
  red(
    plant(
      "cli/aliased.ts",
      `const p = sessionEventActivePath(id);\nawait fs.appendFile(\n  p,\n  line,\n);`,
    ),
    "an alias, a multi-line call",
  );
  red(
    plant("cli/by-eventlog.ts", `fs.appendFileSync(record.eventLog.active_path, line);`),
    "through the record's own active_path",
  );
  red(
    plant("cli/direct-parts.ts", `await appendInParts(somePath, data);`),
    "appendInParts outside",
  );
  red(
    plantInto("session/export.ts", `fs.appendFileSync(sessionEventActivePath(i), l);`),
    "a registered READER that starts appending",
  );
  // The shapes the 3f33cc2d TE found the first scan missed (L-D):
  red(
    plantInto(
      "session/import.ts",
      `await fs.writeFile(sessionEventActivePath(i), l, { flag: "a" });`,
    ),
    "F: writeFile with the append flag, in a registered module",
  );
  red(
    plant(
      "cli/open-nested.ts",
      `const fh = await fs.open(sessionEventActivePath(sessionId), "a");`,
    ),
    "G: open(path(x), 'a'), nested parentheses",
  );
  red(
    plant(
      "cli/open-multiline.ts",
      `const fh = openSync(\n  join(dir, "x"),\n  "a+",\n);\nconst p = sessionEventActivePath(i);`,
    ),
    "G: a multi-line open in append mode next to the path",
  );
  red(
    plant("cli/o-append.ts", `fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);`),
    "H: O_APPEND",
  );
  red(
    plant(
      "cli/hand-built.ts",
      "const p = path.join(dir, `${id}.stream.ndjson`);\nawait fs.appendFile(p, line);",
    ),
    "I: a hand-built <id>.stream.ndjson path",
  );
  assert.ok(
    streamAppendViolations(
      new Map([
        ...base,
        [
          "session/events.ts",
          `${events}\nexport async function appendToAnyPath(file: string, line: string) { await fs.appendFile(file, line); }`,
        ],
      ]),
    ).some((violation) => violation.includes("exported appenders")),
    "J: a new exported appender of a caller-given path inside events.ts is red",
  );
  red(
    streamAppendViolations(
      new Map([
        ...base,
        [
          "session/events.ts",
          `${events}\nfunction quietly(id: string, line: string) { return fs.appendFile(activeEventPath(id), line); }`,
        ],
      ]),
    ),
    "K: a raw append inside events.ts, outside the helper's own functions",
  );
  assert.deepEqual(
    plant(
      "cli/comment-only.ts",
      `// appendFile(sessionEventActivePath(id)) is what the old code did`,
    ),
    [],
    "a comment is not a use",
  );
  assert.deepEqual(
    plant(
      "cli/helper-call.ts",
      `import { appendStreamText } from "../session/events.js";\nawait appendStreamText(id, line);`,
    ),
    [],
    "negative: a module that calls the helper is not an appender",
  );
});

// ---- A-80 row 80.1's scan, beside 63.4: no append to a session's stream or owner log on a control-role host passes
// without the proof (`streamWriteVerdict`, src/pod/stream-write-guard.ts). DISCOVERING and BY CONSTRUCTION.

/** The text of the `{ … }` block that follows the parameter list of the function whose header matches `header`. */
function functionBody(text: string, header: RegExp): string | undefined {
  const match = header.exec(text);
  if (!match) {
    return undefined;
  }
  const argsStart = match.index + match[0].length - 1;
  const args = balancedArgs(text, argsStart);
  const open = text.indexOf("{", argsStart + args.length + 1);
  if (open < 0) {
    return undefined;
  }
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }
  return undefined;
}

const VERDICT_CALL = /\b(streamWriteVerdict(Sync)?|divertedBeforeWrite)\s*\(/;
const GUARD_MODULE = "pod/stream-write-guard.ts";
/** Files that name the owner log and append, each reviewed: why none of them is a foreign write. */
const OWNER_LOG_APPEND_REVIEWED: Record<string, string> = {
  "cli/session/queue-owner-process.ts":
    "opens the fd a spawning owner takes as its stdio: the OWNER is the writer, behind assertBridgeMayStartHere",
};

export function guardViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  const events = code(files.get("session/events.ts") ?? "");
  const entries: [string, RegExp][] = [
    ["SessionEventWriter.open", /static\s+async\s+open\s*\(/],
    ...[...events.matchAll(/export\s+(?:async\s+)?function\s+(append\w*)\s*\(/g)]
      .map((m) => m[1] ?? "")
      .filter((name) => name !== "appendInParts")
      .map((name): [string, RegExp] => [name, new RegExp(`function\\s+${name}\\s*\\(`)]),
  ];
  for (const [name, header] of entries) {
    const body = functionBody(events, header);
    if (body === undefined) {
      violations.push(`session/events.ts: cannot find the entry ${name}`);
    } else if (!VERDICT_CALL.test(body)) {
      violations.push(
        `session/events.ts: the entry ${name} writes without asking streamWriteVerdict`,
      );
    }
  }
  // The async entry asks through `divertedBeforeWrite`; that helper must itself ask the proof.
  const asker = functionBody(events, /function\s+divertedBeforeWrite\s*\(/);
  if (asker === undefined || !/\bstreamWriteVerdict\s*\(/.test(asker)) {
    violations.push("session/events.ts: divertedBeforeWrite does not ask streamWriteVerdict");
  }
  for (const [file, raw] of files) {
    const text = code(raw);
    if (file === GUARD_MODULE || !/\bqueueOwnerLogPath\b|\.owner\.log\b/.test(text)) {
      continue;
    }
    const shapes = appendShapes(text);
    if (shapes.length > 0 && OWNER_LOG_APPEND_REVIEWED[file] === undefined) {
      violations.push(
        `${file}: names the owner log and appends (${shapes.map((x) => x.shape).join(", ")}) outside appendOwnerLogLine`,
      );
    }
  }
  return violations;
}

test("80.1 SCAN: every append entry of the helper module asks the C3.3 proof first, and only the guard module appends to an owner log (discovering)", () => {
  const files = realSources();
  const events = code(files.get("session/events.ts") ?? "");
  assert.ok(
    [...events.matchAll(/export\s+(?:async\s+)?function\s+(append\w*)/g)].length >= 3,
    "positive control: the scan finds the exported appenders",
  );
  assert.ok(
    functionBody(events, /static\s+async\s+open\s*\(/)?.includes("acquireEventsLock"),
    "positive control: it reads the open body",
  );
  assert.ok(
    code(files.get(GUARD_MODULE) ?? "").includes("fs.appendFile"),
    "positive control: the owner log's raw append is in the guard module",
  );
  const named = [...files].filter(
    ([file, text]) =>
      file !== GUARD_MODULE &&
      /\bqueueOwnerLogPath\b|\.owner\.log\b/.test(code(text)) &&
      appendShapes(code(text)).length > 0,
  );
  assert.deepEqual(
    named.map(([file]) => file).toSorted(),
    Object.keys(OWNER_LOG_APPEND_REVIEWED).toSorted(),
    "positive control: the scan finds the reviewed owner-log append, and nothing else",
  );
  assert.deepEqual(guardViolations(files), []);
});

test("80.1 SCAN negatives: an entry without the proof, a new unguarded appender, and a raw owner-log append are each red", () => {
  const base = realSources();
  const events = base.get("session/events.ts") ?? "";
  const withEvents = (text: string): string[] =>
    guardViolations(new Map([...base, ["session/events.ts", text]]));
  const plant = (name: string, text: string): string[] =>
    guardViolations(new Map([...base, [name, text]]));
  assert.equal(
    withEvents(events.replace("streamWriteVerdictSync(sessionId)", "alwaysHere(sessionId)")).length,
    1,
    "the sync entry loses its proof",
  );
  assert.equal(
    withEvents(events.replace("await streamWriteVerdict(record.acpxRecordId)", "alwaysHere()"))
      .length,
    1,
    "SessionEventWriter.open loses its proof",
  );
  assert.equal(
    withEvents(
      `${events}\nexport async function appendMore(sessionId: string, text: string) { await appendStreamTextSync(sessionId, text); }`,
    ).length,
    1,
    "a NEW exported appender that does not ask",
  );
  assert.equal(
    plant(
      "cli/new-owner-log.ts",
      `import { queueOwnerLogPath } from "./session/queue-owner-process.js";\nawait fs.appendFile(queueOwnerLogPath(id), line);`,
    ).length,
    1,
    "a raw append to the owner log outside the guard module",
  );
  assert.equal(
    plant(
      "cli/by-hand.ts",
      "const log = path.join(dir, `${id}.owner.log`);\nfs.appendFileSync(log, line);",
    ).length,
    1,
    "an owner log named by hand",
  );
  assert.deepEqual(
    plant(
      "cli/uses-guard.ts",
      `import { queueOwnerLogPath } from "./session/queue-owner-process.js";\nawait appendOwnerLogLine(id, queueOwnerLogPath(id), line);`,
    ),
    [],
    "negative: a module that goes through the guard is not an appender",
  );
});

test("63.3 a damaged line is skipped, COUNTED and LOGGED by listSessionEvents and by the export reader, once per process and line", async () => {
  await withTempHome("acpx-appender-reader-", async (homeDir) => {
    const id = "damaged-reader";
    await seedRecord(homeDir, id);
    const active = sessionEventActivePath(id);
    await fsp.writeFile(
      active,
      `${JSON.stringify(frame(1))}\n{"jsonrpc":"2.0","method":"session/upd\n${JSON.stringify(frame(2))}\n`,
    );
    const written: string[] = [];
    const spy = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
    resetPerfMetrics();
    try {
      assert.deepEqual(frameNumbers(await listSessionEvents(id)), [1, 2]);
      const logged = written.filter((line) => line.includes("damaged line"));
      assert.equal(logged.length, 1, "logged");
      assert.ok(logged[0]?.includes(active), "the log names the file");
      assert.ok(logged[0]?.includes("skipped 1 damaged line(s)"), "and the count");
      assert.ok(logged[0]?.includes("byte offset 70"), "and where");
      assert.equal(getPerfMetricsSnapshot().counters["session.events.damaged_line"], 1, "counted");

      await listSessionEvents(id);
      assert.equal(
        written.filter((line) => line.includes("damaged line")).length,
        1,
        "a second read of the same line stays quiet on stderr",
      );
      assert.equal(
        getPerfMetricsSnapshot().counters["session.events.damaged_line"],
        2,
        "but is still counted",
      );

      const out = path.join(homeDir, "export.json");
      const before = written.length;
      await exportSession({ sessionId: id }, out);
      const exported = JSON.parse(await fsp.readFile(out, "utf8")) as { history?: unknown[] };
      assert.equal(exported.history?.length, 2, "the export keeps the good frames");
      assert.equal(
        getPerfMetricsSnapshot().counters["session.events.damaged_line"],
        3,
        "the export reader counts it too, through the same parser",
      );
      assert.equal(written.slice(before).filter((line) => line.includes("damaged line")).length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});

test("63.3 / 66.4 negative: a file of whole lines, empty lines and WHITESPACE-ONLY lines logs and counts nothing (C10: a whitespace-only line is complete and carries no event)", () => {
  const written: string[] = [];
  const spy = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  resetPerfMetrics();
  try {
    const events = parseStreamPayload(
      `${JSON.stringify(frame(1))}\n\n   \n\t \n${JSON.stringify(frame(2))}\n`,
      "/x/clean",
    );
    assert.equal(events.length, 2);
    assert.deepEqual(written, []);
    assert.equal(getPerfMetricsSnapshot().counters["session.events.damaged_line"], undefined);
  } finally {
    spy.mock.restore();
  }
});

test("a stream lock THIS process holds, with no multi-part write of its own in flight, is nobody's live line: the appender closes the tail at once", async () => {
  await withTempHome("acpx-appender-selfheld-", async (homeDir) => {
    const id = "self-held";
    await seedRecord(homeDir, id);
    const writer = await SessionEventWriter.open(await resolveSessionRecord(id));
    const active = sessionEventActivePath(id);
    await fsp.writeFile(active, `${JSON.stringify(frame(1))}\n{"jsonrpc":"2.0","meth`);
    const startedAt = Date.now();
    appendStreamTextSync(id, `${JSON.stringify(frame(2))}\n`);
    await appendStreamText(id, `${JSON.stringify(frame(3))}\n`);
    assert.ok(Date.now() - startedAt < 500, "no wait");
    await writer.close({ checkpoint: false });
    const shape = shapeOf(await fsp.readFile(active, "utf8"));
    assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 1, empty: 0 });
    assert.deepEqual(frameNumbers(await listSessionEvents(id)), [1, 2, 3]);
  });
});
