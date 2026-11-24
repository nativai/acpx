import fs from "node:fs";
import path from "node:path";
import type { RecordAnchoredCut } from "../src/acp/claude-fork-anchor.js";
import type { SessionMessage } from "../src/types.js";

// brick 4bf088a7 — fixtures and an INDEPENDENT checker for the Pi cut proof tests.
//
// The fixtures are `scripts/derive-pi-cut-fixture.mjs` output: content-free copies of real records
// whose per-cut answers were proved EQUAL to the real record's, and stored in `answers`
// (TEST-PLAN §1 (ii)). The checker below deliberately shares no code with `pi-fork-anchor.ts`: it
// matches by equality/suffix and tool ids only, so a bug in the proof's richer matching cannot hide
// itself from it (the prototype's "independent check", DESIGN §2.6).

export type Answer = {
  n: number;
  entryId?: string;
  line?: number;
  contextEndLogIndex?: number;
  refused?: string;
  /** the line today's `forkAtMessageIndex = n` truncation ends at */
  indexCutLine?: number;
};

export type Fixture = {
  id: string;
  baseIndex: number;
  keepEnds: number | null;
  entries: SessionMessage[];
  pi: (string | Record<string, unknown>)[];
  answers: Answer[];
};

export const FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures", "pi-fork-anchor");

export function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as Fixture);
}

export function loadFixture(idPrefix: string): Fixture {
  const found = loadFixtures().find((f) => f.id.startsWith(idPrefix));
  if (!found) {
    throw new Error(
      `no derived fixture ${idPrefix} (it failed its equivalence check, or was not derived)`,
    );
  }
  return found;
}

export const toJsonl = (pi: Fixture["pi"]): string =>
  pi.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");

export function cutAt(fixture: Fixture, n: number, entries = fixture.entries): RecordAnchoredCut {
  const end = n - fixture.baseIndex;
  return {
    atLogIndex: n,
    window: entries.slice(Math.max(0, end - 200), end),
    before: entries.slice(0, end),
    after: entries.slice(end),
  };
}

// ---- the independent checker -------------------------------------------------------------------

type PiEntry = {
  id: string;
  line: number;
  role: string | undefined;
  text: string;
  ids: string[];
};

const squash = (s: string): string => s.replace(/\s+/gu, "");

export function piEntries(content: string): PiEntry[] {
  const rows: (PiEntry & { parentId: string | null })[] = [];
  content.split("\n").forEach((text, index) => {
    try {
      const row = JSON.parse(text) as {
        type?: string;
        id?: string;
        parentId?: string | null;
        message?: { role?: string; content?: unknown; toolCallId?: string };
      };
      if (!row || row.type === "session" || typeof row.id !== "string") {
        return;
      }
      const parts = Array.isArray(row.message?.content)
        ? (row.message.content as { type?: string; text?: string; id?: string }[])
        : [];
      rows.push({
        id: row.id,
        parentId: row.parentId ?? null,
        line: index + 1,
        role: row.message?.role,
        text: squash(
          parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(""),
        ),
        ids: [
          ...parts.filter((p) => p.type === "toolCall" && p.id).map((p) => p.id as string),
          ...(row.message?.toolCallId ? [row.message.toolCallId] : []),
        ],
      });
    } catch {
      // a half-written line, as pi skips it
    }
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: PiEntry[] = [];
  for (let cur = rows.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    chain.push(cur);
  }
  return chain.toReversed();
}

function userText(entry: SessionMessage): { text: string; trimmed: boolean } | undefined {
  if (entry === "Resume" || !("User" in entry)) {
    return undefined;
  }
  const raw = entry.User.content.map((b) => ("Text" in b ? b.Text : "")).join("");
  const trimmed = raw.length >= 8000 && raw.endsWith("...");
  return { text: squash(trimmed ? raw.slice(0, -3) : raw), trimmed };
}

function toolIds(entries: readonly SessionMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry === "Resume" || !("Agent" in entry)) {
      continue;
    }
    entry.Agent.content.forEach((b) => "ToolUse" in b && ids.add(b.ToolUse.id));
    Object.keys(entry.Agent.tool_results).forEach((id) => ids.add(id));
  }
  return ids;
}

export type Violations = { a: number; b: number; c: number };

/**
 * What a fork that keeps pi's file through `throughLine` holds that the copy (the record's first
 * `n - base` entries) does not, and what it lacks that the copy has:
 *   a — a pi user entry no copied User accounts for (equality / suffix; a trimmed text: contains);
 *   b — a tool id only the parent's LATER entries carry;
 *   c — a copied User that pi received, before `contextEnd`, that the fork does not hold.
 */
export function violations(
  fixture: Fixture,
  n: number,
  throughLine: number,
  contextEndLogIndex?: number,
): Violations {
  const { before, after } = cutAt(fixture, n);
  return violationsOf(
    { before, after, baseIndex: fixture.baseIndex, piContent: toJsonl(fixture.pi) },
    throughLine,
    contextEndLogIndex,
  );
}

export type CutInput = {
  before: readonly SessionMessage[];
  after: readonly SessionMessage[];
  baseIndex: number;
  piContent: string;
};

export function violationsOf(
  input: CutInput,
  throughLine: number,
  contextEndLogIndex?: number,
): Violations {
  const { before, after } = input;
  const path = piEntries(input.piContent);
  const fork = path.filter((e) => e.line <= throughLine);
  const users = before.flatMap((e) => userText(e) ?? []);
  const a = fork.filter(
    (e) =>
      e.role === "user" &&
      !users.some(
        (u) =>
          e.text === u.text || e.text.endsWith(u.text) || (u.trimmed && e.text.includes(u.text)),
      ),
  ).length;
  const pastIds = toolIds(before);
  const onlyLater = new Set([...toolIds(after)].filter((id) => !pastIds.has(id)));
  const b = fork.filter((e) => e.ids.some((id) => onlyLater.has(id))).length;
  const upto =
    contextEndLogIndex === undefined ? before.length : contextEndLogIndex - input.baseIndex;
  const c = before
    .slice(0, upto)
    .flatMap((e) => userText(e) ?? [])
    .filter((u) => path.some((e) => e.role === "user" && e.text.includes(u.text)))
    .filter((u) => !fork.some((e) => e.role === "user" && e.text.includes(u.text))).length;
  return { a, b, c };
}

/**
 * The line pi-acp's index truncation TODAY (`forkAtMessageIndex = n`) ends at: through the n-th
 * client-visible record — a user, or an assistant record that carries no tool call.
 */
export function indexCutLineOf(piContent: string, n: number): number | undefined {
  const { visible, last } = piVisibleLines(piContent);
  // past the last visible record the index keeps the whole file
  return n <= visible.length ? visible[n - 1] : last;
}

function piVisibleLines(content: string): { visible: number[]; last: number | undefined } {
  const rows = content.split("\n").flatMap((text, index) => {
    try {
      const row = JSON.parse(text) as {
        type?: string;
        id?: string;
        parentId?: string | null;
        message?: { role?: string; content?: unknown };
      };
      return row && row.type !== "session" && typeof row.id === "string"
        ? [{ id: row.id, parentId: row.parentId ?? null, line: index + 1, message: row.message }]
        : [];
    } catch {
      return [];
    }
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: typeof rows = [];
  for (let cur = rows.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    chain.push(cur);
  }
  const ordered = chain.toReversed();
  return {
    visible: ordered
      .filter((row) => {
        const parts = Array.isArray(row.message?.content)
          ? (row.message.content as { type?: string }[])
          : [];
        const role = row.message?.role;
        return (
          role === "user" || (role === "assistant" && !parts.some((p) => p.type === "toolCall"))
        );
      })
      .map((row) => row.line),
    last: ordered.at(-1)?.line,
  };
}

export const totalViolations = (v: Violations): number => v.a + v.b + v.c;

// ---- small hand-built shapes -------------------------------------------------------------------

export const user = (id: string, text: string): SessionMessage => ({
  User: { id, content: [{ Text: text }] },
});

export const agentText = (text: string): SessionMessage => ({
  Agent: { content: [{ Text: text }], tool_results: {} },
});

export const agentTool = (toolId: string, text = ""): SessionMessage => ({
  Agent: {
    content: [
      ...(text ? [{ Text: text }] : []),
      {
        ToolUse: {
          id: toolId,
          name: "tool",
          raw_input: "",
          input: {},
          is_input_complete: true,
        },
      },
    ],
    tool_results: {
      [toolId]: {
        tool_use_id: toolId,
        tool_name: "tool",
        is_error: false,
        content: { Text: "" },
      },
    },
  },
});

type PiSpec =
  | { user: string }
  | { assistant: string }
  | { call: string; text?: string }
  | { result: string }
  | { raw: Record<string, unknown> };

/** A pi file from a list of entries in order: ids e1, e2, … chained by parentId; the header is line 1. */
export function piFile(specs: PiSpec[]): string {
  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id: "s", cwd: "/w" }];
  specs.forEach((spec, i) => {
    if ("raw" in spec) {
      lines.push(spec.raw);
      return;
    }
    const id = `e${i + 1}`;
    const parentId = i === 0 ? null : `e${i}`;
    const message =
      "user" in spec
        ? { role: "user", content: [{ type: "text", text: spec.user }] }
        : "assistant" in spec
          ? { role: "assistant", content: [{ type: "text", text: spec.assistant }] }
          : "call" in spec
            ? {
                role: "assistant",
                content: [
                  ...(spec.text ? [{ type: "text", text: spec.text }] : []),
                  { type: "toolCall", id: spec.call, name: "tool", arguments: {} },
                ],
              }
            : {
                role: "toolResult",
                toolCallId: spec.result,
                content: [{ type: "text", text: "" }],
              };
    lines.push({ type: "message", id, parentId, message });
  });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
