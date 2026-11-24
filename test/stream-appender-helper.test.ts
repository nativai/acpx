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
const APPEND_CALL =
  /\b(appendFile|appendFileSync|createWriteStream|appendInParts)\s*\(|\bopen(Sync)?\s*\([^)]*["'`]a\+?["'`]/;

export function streamAppendViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [file, raw] of files) {
    const text = code(raw);
    if (!STREAM_PATH_TOKEN.test(text)) {
      continue;
    }
    const role = STREAM_PATH_USERS[file];
    if (role === undefined) {
      violations.push(`${file}: builds or uses the stream path but is not a registered user`);
    } else if (role === "no-append" && APPEND_CALL.test(text)) {
      violations.push(`${file}: a stream-path user that may not append, appends`);
    }
  }
  for (const [file, raw] of files) {
    if (file !== "session/events.ts" && /\bappendInParts\s*\(/.test(code(raw))) {
      violations.push(`${file}: calls appendInParts outside the helper module`);
    }
  }
  return violations;
}

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
  assert.deepEqual(streamAppendViolations(files), []);
});

test("63.4 SCAN negatives: a planted append past the helper is red, in every shape", () => {
  const base = realSources();
  const plant = (name: string, text: string): string[] =>
    streamAppendViolations(new Map([...base, [name, text]]));
  assert.deepEqual(
    plant(
      "cli/new-appender.ts",
      `import { sessionEventActivePath } from "../session/event-log.js";\nawait appendFile(sessionEventActivePath(id), line, "utf8");`,
    ).length,
    1,
    "a NEW module that appends to the stream path",
  );
  assert.equal(
    plant(
      "cli/aliased.ts",
      `const p = sessionEventActivePath(id);\nawait fs.appendFile(\n  p,\n  line,\n);`,
    ).length,
    1,
    "an alias, a multi-line call",
  );
  assert.equal(
    plant("cli/by-eventlog.ts", `fs.appendFileSync(record.eventLog.active_path, line);`).length,
    1,
    "through the record's own active_path",
  );
  assert.equal(
    plant("cli/direct-parts.ts", `await appendInParts(somePath, data);`).length,
    1,
    "appendInParts outside the helper module",
  );
  assert.equal(
    plant(
      "session/export.ts",
      `${base.get("session/export.ts")}\nfs.appendFileSync(sessionEventActivePath(i), l);`,
    ).length,
    1,
    "a registered READER that starts appending",
  );
  assert.deepEqual(
    plant(
      "cli/comment-only.ts",
      `// appendFile(sessionEventActivePath(id)) is what the old code did`,
    ),
    [],
    "a comment is not a use",
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

test("63.3 negative: a file of whole lines and blank lines logs and counts nothing", () => {
  const written: string[] = [];
  const spy = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  resetPerfMetrics();
  try {
    const events = parseStreamPayload(
      `${JSON.stringify(frame(1))}\n\n${JSON.stringify(frame(2))}\n`,
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
