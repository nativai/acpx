// brick 4bf088a7 (TEST-PLAN §1 (ii)) — turn a REAL session record (acpx history + pi JSONL) into a
// committed fixture that keeps the proof's answers and none of the content.
//
// What is kept: every entry kind, every User id, every ToolUse/tool_result id, every pi
// id/parentId/role/stopReason/toolCall.id/toolCallId, the pi line order (line numbers are answers),
// and every TEXT RELATION the proof reads — equal, suffix, contained, trimmed prefix, head-64,
// length (the 8,000/4,000 caps) — because each word is replaced by a same-length word whose i-th
// character is a salted hash of the word's first i+1 characters: equal words stay equal, a prefix
// of a word maps to the prefix of its image, whitespace is kept (the proof squashes it away), and
// the content is gone. Tool inputs and results are dropped. The salt is random per run and never
// stored, so the derivation cannot be re-run to undo itself.
//
// THE EQUIVALENCE CHECK IS THE POINT: the proof runs over EVERY cut of the real record and of the
// derived fixture, and the two answers must be identical (entry id, line, context end or refusal).
// A record that fails is NOT written — the real-record suite (test/pi-cut-real-records.integration.ts)
// still covers it. The real record's answers are stored in the fixture (`answers`), so the committed
// suite re-proves "derived == real" forever without a raw record in git.
//
// Usage: node scripts/derive-pi-cut-fixture.mjs <dist-test root> <ids file> <out dir>
// Env:   ACPX_STATE_HOME / ACPX_PI_BOX_AGENT_DIR point at the (symlinked copy of the) frozen snapshot.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, idsFile, outDir] = process.argv.slice(2);
if (!root || !idsFile || !outDir) {
  console.error("usage: derive-pi-cut-fixture.mjs <dist-test root> <ids file> <out dir>");
  process.exit(2);
}
const load = async (rel) => await import(pathToFileURL(path.join(root, rel)).href);
const { resolveSessionRecord } = await load("src/session/persistence/repository.js");
const { readFullSourceHistory, resolveForkCutIndex } = await load(
  "src/cli/session/fork-at-log-index.js",
);
const { locatePiSessionTranscript } = await load("src/acp/harness-config-dir.js");
const { resolvePiForkCutByRecord } = await load("src/acp/pi-fork-anchor.js");

const PI_COMMAND = "node /opt/pi-acp/dist/index.js";
const TEXT_CAP = 8000;
const THINK_CAP = 4000;
const salt = randomBytes(16).toString("hex");
const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-+=:;,!?#@%&*~^<>/|()[]{}$";

const wordCache = new Map();
function mapWord(word) {
  const cached = wordCache.get(word);
  if (cached !== undefined) {
    return cached;
  }
  let out = "";
  for (let i = 0; i < word.length; i += 1) {
    const h = createHash("sha256")
      .update(`${salt}\u0000${word.slice(0, i + 1)}`)
      .digest();
    out += ALPHABET[h.readUInt16BE(0) % ALPHABET.length];
  }
  wordCache.set(word, out);
  return out;
}

const squash = (text) => text.replace(/\s+/gu, "");
/** Squashed keys of every block acpx trimmed: a pi text that starts with one stays whole (its prefix IS the relation). */
let protectedKeys = [];
/** Per-text compression: keep the first and last K characters (Infinity = keep all). */
let keepEnds = Infinity;

function isProtected(text) {
  const key = squash(text);
  return protectedKeys.some((k) => key.startsWith(k) || k.startsWith(key));
}

/** Same-length image of `text`; a block acpx trimmed (`cap` long, ending "...") keeps its dots. */
function anonymize(text, cap) {
  const trimmed = cap !== undefined && text.length === cap && text.endsWith("...");
  const body = trimmed ? text.slice(0, -3) : text;
  const mapped = body
    .split(/(\s+)/u)
    .map((piece) => (/^\s+$/u.test(piece) ? " ".repeat(piece.length) : mapWord(piece)))
    .join("");
  const whole = trimmed || isProtected(text) || mapped.length <= 2 * keepEnds + 1;
  const kept = whole ? mapped : `${mapped.slice(0, keepEnds)}\u00a7${mapped.slice(-keepEnds)}`;
  return trimmed ? `${kept}...` : kept;
}

const inertToolUse = (id) => ({
  id,
  name: "tool",
  raw_input: "",
  input: {},
  is_input_complete: true,
});
const inertToolResult = (id) => ({
  tool_use_id: id,
  tool_name: "tool",
  is_error: false,
  content: { Text: "" },
});

function deriveEntry(entry) {
  if (entry === "Resume") {
    return entry;
  }
  if ("User" in entry) {
    return {
      User: {
        id: entry.User.id,
        content: entry.User.content.flatMap((block) =>
          "Text" in block ? [{ Text: anonymize(block.Text, TEXT_CAP) }] : [],
        ),
      },
    };
  }
  const agent = entry.Agent;
  return {
    Agent: {
      content: agent.content.flatMap((block) => {
        if ("ToolUse" in block) {
          return [{ ToolUse: inertToolUse(block.ToolUse.id) }];
        }
        if ("Text" in block) {
          return [{ Text: anonymize(block.Text, TEXT_CAP) }];
        }
        if ("Thinking" in block) {
          return [{ Thinking: { text: anonymize(block.Thinking.text, THINK_CAP) } }];
        }
        return [];
      }),
      tool_results: Object.fromEntries(
        Object.keys(agent.tool_results).map((id) => [id, inertToolResult(id)]),
      ),
      ...(agent.terminal_error === undefined ? {} : { terminal_error: { message: "terminal" } }),
      ...(agent.synthetic === undefined ? {} : { synthetic: true }),
    },
  };
}

const partsOf = (content) =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.filter((p) => p && typeof p === "object")
      : [];

/** One fixture line: an object, "" for a blank line, "{" for an unparseable (half-written) one — same line numbers. */
function derivePiLine(raw) {
  if (!raw.trim()) {
    return "";
  }
  let line;
  try {
    line = JSON.parse(raw);
  } catch {
    return "{";
  }
  if (line === null || typeof line !== "object") {
    return "{";
  }
  if (line.type === "session") {
    return { type: "session", version: 3, id: "fixture", cwd: "/workspace" };
  }
  const base = { type: line.type, id: line.id, parentId: line.parentId ?? null };
  if (line.type !== "message") {
    return base;
  }
  const m = line.message ?? {};
  const parts = partsOf(m.content);
  if (m.role === "user") {
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => anonymize(p.text));
    return {
      ...base,
      message: { role: "user", content: text.map((t) => ({ type: "text", text: t })) },
    };
  }
  if (m.role === "toolResult") {
    return {
      ...base,
      message: {
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: "tool",
        content: [{ type: "text", text: "" }],
        isError: false,
      },
    };
  }
  const content = parts.flatMap((p) => {
    if (p.type === "text" && typeof p.text === "string") {
      return [{ type: "text", text: anonymize(p.text) }];
    }
    if (p.type === "thinking" && typeof p.thinking === "string") {
      return [{ type: "thinking", thinking: anonymize(p.thinking) }];
    }
    return p.type === "toolCall"
      ? [{ type: "toolCall", id: p.id, name: "tool", arguments: {} }]
      : [];
  });
  return { ...base, message: { role: m.role, content, stopReason: m.stopReason } };
}

/** pi-acp's index truncation TODAY (the line the old cut ends at) — kept as the "before" witness. */
function indexCutLine(piContent, n) {
  const rows = [];
  piContent.split("\n").forEach((text, i) => {
    try {
      const r = JSON.parse(text);
      if (r && r.type !== "session" && typeof r.id === "string") {
        rows.push({ ...r, line: i + 1 });
      }
    } catch {
      /* skipped, as pi skips it */
    }
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = [];
  for (let cur = rows.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    path.push(cur);
  }
  path.reverse();
  let seen = 0;
  for (const row of path) {
    const m = row.type === "message" ? row.message : undefined;
    const parts = partsOf(m?.content);
    const visible =
      m?.role === "user" || (m?.role === "assistant" && !parts.some((p) => p.type === "toolCall"));
    if (visible) {
      seen += 1;
      if (seen >= n) {
        return row.line;
      }
    }
  }
  return path.at(-1)?.line;
}

function answers(content, messages, baseIndex) {
  const out = [];
  for (let n = baseIndex + 1; n <= baseIndex + messages.length; n += 1) {
    if (resolveForkCutIndex(PI_COMMAND, messages, n, baseIndex) !== n) {
      continue; // a batch-snapped position: never reaches the proof
    }
    const end = n - baseIndex;
    const cut = {
      atLogIndex: n,
      window: messages.slice(Math.max(0, end - 200), end),
      before: messages.slice(0, end),
      after: messages.slice(end),
    };
    try {
      const r = resolvePiForkCutByRecord(content, cut);
      out.push({
        n,
        entryId: r.entryId,
        line: r.line,
        ...(r.contextEndLogIndex === undefined ? {} : { contextEndLogIndex: r.contextEndLogIndex }),
      });
    } catch (error) {
      out.push({ n, refused: JSON.parse(error.message).reason });
    }
  }
  return out;
}

fs.mkdirSync(outDir, { recursive: true });
const ids = fs
  .readFileSync(idsFile, "utf8")
  .split("\n")
  .map((l) => l.split(" ")[0])
  .filter(Boolean);
let failed = 0;
const toJsonl = (pi) => pi.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
const trimmedKeys = (messages) =>
  messages.flatMap((entry) => {
    const texts =
      entry === "Resume"
        ? []
        : "User" in entry
          ? entry.User.content.flatMap((b) => ("Text" in b ? [[b.Text, TEXT_CAP]] : []))
          : entry.Agent.content.flatMap((b) =>
              "Text" in b
                ? [[b.Text, TEXT_CAP]]
                : "Thinking" in b
                  ? [[b.Thinking.text, THINK_CAP]]
                  : [],
            );
    return texts
      .filter(([text, cap]) => text.length === cap && text.endsWith("..."))
      .map(([text]) => squash(text.slice(0, -3)));
  });

/** Try the smallest text compression whose derived answers equal the real ones on EVERY cut. */
const ATTEMPTS = [8, 24, 64, 200, 800, Infinity];
for (const id of ids) {
  const record = await resolveSessionRecord(id);
  const history = await readFullSourceHistory(record);
  const located = locatePiSessionTranscript({ cwd: record.cwd, acpSessionId: record.acpSessionId });
  const content = fs.readFileSync(located.path, "utf8");
  const realAnswers = answers(content, history.messages, history.baseIndex);
  protectedKeys = trimmedKeys(history.messages);
  let written = false;
  let lastMismatch = "";
  for (const attempt of ATTEMPTS) {
    keepEnds = attempt;
    const derivedEntries = history.messages.map(deriveEntry);
    const derivedPi = content.split("\n").map(derivePiLine);
    const derivedAnswers = answers(toJsonl(derivedPi), derivedEntries, history.baseIndex);
    const differing = realAnswers.filter(
      (a, i) => JSON.stringify(a) !== JSON.stringify(derivedAnswers[i]),
    );
    if (differing.length > 0 || realAnswers.length !== derivedAnswers.length) {
      lastMismatch = `K=${attempt}: ${differing.length}/${realAnswers.length} cuts differ, first n=${differing[0]?.n}`;
      continue;
    }
    const fixture = {
      id,
      baseIndex: history.baseIndex,
      keepEnds: Number.isFinite(attempt) ? attempt : null,
      entries: derivedEntries,
      pi: derivedPi,
      answers: realAnswers.map((a) => ({ ...a, indexCutLine: indexCutLine(content, a.n) })),
    };
    const file = path.join(outDir, `${id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fixture)}\n`);
    console.log(
      `${id.slice(0, 8)} cuts=${realAnswers.length} entries=${derivedEntries.length} pi=${derivedPi.length} K=${attempt} bytes=${fs.statSync(file).size}`,
    );
    written = true;
    break;
  }
  if (!written) {
    failed += 1;
    console.error(`NOT WRITTEN ${id}: ${lastMismatch}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
