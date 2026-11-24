#!/usr/bin/env node
// brick 4bf088a7 — a FAKE pi-acp that implements DESIGN §3 (the fork-after-entry wire) over a REAL pi
// JSONL file, so acpx's tests drive the whole `sessions copy` path without lane P's build.
//
// ⚠️ ITS PATH IS PART OF THE FIXTURE: acpx classifies an adapter by command (`isPiAcpCommand` needs a
// `pi-acp` path segment), and a synthetic command such as `agent` proves nothing about Pi
// (PROJECT.md: the fixtures use shapes no real record carries). This one is spawned as
// `node …/pi-acp/bin/index.js` (a `pi-acp` path segment is what `isPiAcpCommand` keys on; `dist/` itself is gitignored).
//
// It follows lane P's PLAN (brick 86b9fce4) on the wire facts: refusals are -32602 with
// `error.data.code`; the echo `_meta.piAcp.forkedAfterEntryId` is null on the index and whole-copy
// paths; `forkAfterEntryId: null` is FORK_ENTRY_INVALID; both fields together are FORK_CUT_AMBIGUOUS;
// a pi that opens the fork file appends its own `thinking_level_change` AFTER the cut entry.
//
// Options (argv): --source-file <jsonl>  --ops-log <file>  --out-dir <dir>
//                 --no-advertise      (today's pi-acp c68eb7fc: fork supported, no entry-id capability)
//                 --drop-echo         (advertises, ignores the id and full-copies: the dangerous shape)
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

type Options = {
  sourceFile: string;
  opsLog: string;
  outDir: string;
  advertise: boolean;
  dropEcho: boolean;
};

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string => {
    const at = argv.indexOf(flag);
    return at === -1 ? "" : (argv[at + 1] ?? "");
  };
  return {
    sourceFile: value("--source-file"),
    opsLog: value("--ops-log"),
    outDir: value("--out-dir"),
    advertise: !argv.includes("--no-advertise"),
    dropEcho: argv.includes("--drop-echo"),
  };
}

type PiLine = {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown; toolCallId?: string };
};

function refuse(code: string, sessionId: string, entryId: unknown, message: string): never {
  throw RequestError.invalidParams({ code, sessionId, entryId }, `${code}: ${message}`);
}

class FakePiAcp implements Agent {
  constructor(
    private readonly options: Options,
    _connection: AgentSideConnection,
  ) {}

  private record(op: Record<string, unknown>): void {
    if (this.options.opsLog) {
      appendFileSync(this.options.opsLog, `${JSON.stringify(op)}\n`);
    }
  }

  async initialize(): Promise<InitializeResponse> {
    this.record({ method: "initialize" });
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentInfo: { name: "pi-acp", version: "0.0.33" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        sessionCapabilities: {
          fork: this.options.advertise ? { _meta: { piAcp: { forkAfterEntryId: 1 } } } : {},
        },
      },
    };
  }

  async authenticate(): Promise<void> {
    return;
  }

  async newSession(): Promise<NewSessionResponse> {
    this.record({ method: "session/new" });
    return { sessionId: `fake-pi-new-${process.pid}` };
  }

  async loadSession(): Promise<LoadSessionResponse> {
    return {};
  }

  async prompt(): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    return;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const meta = (params._meta ?? {}) as { acpx?: Record<string, unknown> };
    const acpx = meta.acpx ?? {};
    this.record({ method: "session/fork", meta: params._meta ?? null });
    const hasEntry = "forkAfterEntryId" in acpx;
    const hasIndex = "forkAtMessageIndex" in acpx;
    const sessionId = `fake-pi-fork-${process.pid}-${Date.now()}`;
    if (hasEntry && hasIndex) {
      refuse("FORK_CUT_AMBIGUOUS", params.sessionId, acpx.forkAfterEntryId, "both cut fields");
    }
    const lines = readFileSync(this.options.sourceFile, "utf8").split("\n");
    const kept = hasEntry
      ? this.keepThroughEntry(lines, acpx.forkAfterEntryId, params.sessionId)
      : hasIndex
        ? this.keepThroughVisible(lines, Number(acpx.forkAtMessageIndex))
        : lines;
    // A pi that opens the fork file appends its own non-message entry after the cut.
    const out = path.join(this.options.outDir, `${sessionId}.jsonl`);
    mkdirSync(this.options.outDir, { recursive: true });
    const tail = JSON.stringify({ type: "thinking_level_change", id: "ffffffff", parentId: null });
    writeFileSync(out, `${kept.filter((l) => l.trim()).join("\n")}\n${tail}\n`);
    const echoed = hasEntry && !this.options.dropEcho ? String(acpx.forkAfterEntryId) : null;
    return { sessionId, _meta: { piAcp: { forkedAfterEntryId: echoed } } };
  }

  /** §3: validate, then keep every line up to and including the entry. */
  private keepThroughEntry(lines: string[], entryId: unknown, sessionId: string): string[] {
    if (typeof entryId !== "string" || entryId === "") {
      refuse(
        "FORK_ENTRY_INVALID",
        sessionId,
        entryId,
        "forkAfterEntryId must be a non-empty string",
      );
    }
    if (this.options.dropEcho) {
      return lines; // the dangerous adapter: it advertised the capability and then ignores the id
    }
    const parsed = lines.map((l) => (l.trim() ? (JSON.parse(l) as PiLine) : undefined));
    const at = parsed.findIndex((p) => p?.id === entryId && p.type !== "session");
    if (at === -1) {
      refuse("FORK_ENTRY_NOT_FOUND", sessionId, entryId, "no such entry");
    }
    const byId = new Map(parsed.flatMap((p) => (p?.id ? [[p.id, p] as const] : [])));
    const onPath = new Set<string>();
    for (let cur = parsed.findLast((p) => p?.id && p.type !== "session"); cur?.id; ) {
      onPath.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (!onPath.has(entryId)) {
      refuse("FORK_ENTRY_OFF_PATH", sessionId, entryId, "not on the leaf path");
    }
    const calls = new Set<string>();
    for (const p of parsed.slice(0, at + 1)) {
      const parts = Array.isArray(p?.message?.content)
        ? (p.message.content as { type?: string; id?: string }[])
        : [];
      parts.filter((c) => c.type === "toolCall" && c.id).forEach((c) => calls.add(c.id as string));
      if (p?.message?.toolCallId) {
        calls.delete(p.message.toolCallId);
      }
    }
    const answeredLater = parsed
      .slice(at + 1)
      .some((p) => p?.message?.toolCallId && calls.has(p.message.toolCallId));
    if (answeredLater) {
      refuse(
        "FORK_ENTRY_SPLITS_TOOL_CALL",
        sessionId,
        entryId,
        "splits a tool call from its result",
      );
    }
    return lines.slice(0, at + 1);
  }

  /** The legacy index rule (pi-acp c68eb7fc): through the n-th client-visible record. */
  private keepThroughVisible(lines: string[], n: number): string[] {
    let seen = 0;
    for (const [i, l] of lines.entries()) {
      const p = l.trim() ? (JSON.parse(l) as PiLine) : undefined;
      const parts = Array.isArray(p?.message?.content)
        ? (p.message.content as { type?: string }[])
        : [];
      const role = p?.message?.role;
      if (role === "user" || (role === "assistant" && !parts.some((c) => c.type === "toolCall"))) {
        seen += 1;
        if (seen >= n) {
          return lines.slice(0, i + 1);
        }
      }
    }
    return lines;
  }
}

const options = parseOptions(process.argv.slice(2));
const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = new AgentSideConnection((c) => new FakePiAcp(options, c), stream);
void connection;
