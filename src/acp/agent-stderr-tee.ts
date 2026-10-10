import { StringDecoder } from "node:string_decoder";

// Bounded copy of an adapter's stderr for the queue owner's `<id>.owner.log`
// (brick 7c06a855). Without it, acpx dropped adapter stderr unless --verbose, so
// when codex-acp died 8× mid-turn on 2026-10-10 with exit code 1, the owner log
// held only "agent exit observed: code=1" and the uncaught-exception stack Node
// printed on the adapter's stderr was gone (RCA: brick e7e7d2ab).
//
// One instance per adapter PROCESS. Every complete line is written with
// AGENT_STDERR_PREFIX so it can never be mistaken for acpx's own `[acpx]` lines.
//
// ⚠️ THE CAP COUNTS BYTES WRITTEN TO THE OWNER LOG — prefix + line + newline —
// NOT raw adapter bytes. Counting raw bytes looks equivalent and is not: the
// prefix is per LINE, so 300 KB of blank lines became a 4.3 MB owner.log from one
// adapter (TE finding F1). Growth per adapter process is therefore at most
// `capBytes` + one truncation line + one tail block (a header line plus at most
// `tailBytes` of prefixed lines), pinned by the "many empty lines" rows.
//
// Past the cap it writes one truncation line and stops teeing; if the process
// then dies unexpectedly mid-prompt, the end of its stderr is written once both
// the exit is known and the stream has ended, so a crash stack is never lost
// behind the cap. The sink must be best-effort; this class never throws.

export const AGENT_STDERR_PREFIX = "[agent-stderr] ";
export const AGENT_STDERR_CAP_BYTES = 256 * 1024;
export const AGENT_STDERR_TAIL_BYTES = 8 * 1024;

const PREFIX_BYTES = Buffer.byteLength(AGENT_STDERR_PREFIX);

export class AgentStderrTee {
  private writtenBytes = 0;
  private totalBytes = 0;
  private truncated = false;
  private ended = false;
  private unexpectedExit = false;
  private tailWritten = false;
  private pendingLine = "";
  private tail: Buffer = Buffer.alloc(0);
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly sink: (text: string) => void,
    private readonly capBytes = AGENT_STDERR_CAP_BYTES,
    private readonly tailBytes = AGENT_STDERR_TAIL_BYTES,
  ) {}

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (bytes.length === 0 || this.ended) {
      return;
    }
    this.totalBytes += bytes.length;
    this.rememberTail(bytes);
    if (!this.truncated) {
      this.emit(this.teeText(this.decoder.write(bytes)));
    }
  }

  private teeText(decoded: string): string {
    const lines = (this.pendingLine + decoded).split("\n");
    this.pendingLine = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      out += this.formatLine(line);
      if (this.truncated) {
        return out;
      }
    }
    return out + this.flushOversizedPendingLine();
  }

  // An unterminated line that can no longer fit is flushed now, so a newline-free
  // flood cannot grow `pendingLine` without bound.
  private flushOversizedPendingLine(): string {
    const pending = this.pendingLine;
    return pending.length > 0 && lineBytes(pending) > this.capBytes - this.writtenBytes
      ? this.formatLine(pending)
      : "";
  }

  /** The adapter's stderr stream closed: flush a trailing partial line. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (!this.truncated) {
      const rest = this.pendingLine + this.decoder.end();
      this.pendingLine = "";
      if (rest.length > 0) {
        this.emit(this.formatLine(rest));
      }
    }
    this.maybeWriteTail();
  }

  /** The adapter died unexpectedly mid-prompt (the `unexpectedDuringPrompt=true` path). */
  noteUnexpectedExit(): void {
    this.unexpectedExit = true;
    this.maybeWriteTail();
  }

  // One prefixed line, counted against the cap. A line that does not fit is cut
  // to the room left (on a UTF-8 boundary) and followed by the truncation line.
  private formatLine(line: string): string {
    const size = lineBytes(line);
    if (this.writtenBytes + size <= this.capBytes) {
      this.writtenBytes += size;
      return `${AGENT_STDERR_PREFIX}${line}\n`;
    }
    this.truncated = true;
    this.pendingLine = "";
    const room = this.capBytes - this.writtenBytes - PREFIX_BYTES - 1;
    const head = room > 0 ? utf8Prefix(line, room) : "";
    const partial = head.length > 0 ? `${AGENT_STDERR_PREFIX}${head}\n` : "";
    this.writtenBytes += Buffer.byteLength(partial);
    return `${partial}[acpx] agent stderr truncated after ${formatKb(this.capBytes)}\n`;
  }

  private maybeWriteTail(): void {
    if (!this.truncated || !this.ended || !this.unexpectedExit || this.tailWritten) {
      return;
    }
    this.tailWritten = true;
    const block = prefixedTail(this.tail.toString("utf8"), this.tailBytes);
    this.emit(
      `[acpx] agent stderr tail (last ${block.rawBytes} of ${this.totalBytes} bytes) after unexpected exit:\n${block.text}`,
    );
  }

  private rememberTail(bytes: Buffer): void {
    const joined = this.tail.length === 0 ? bytes : Buffer.concat([this.tail, bytes]);
    this.tail =
      joined.length > this.tailBytes
        ? Buffer.from(joined.subarray(joined.length - this.tailBytes))
        : joined;
  }

  private emit(text: string): void {
    if (text.length === 0) {
      return;
    }
    try {
      this.sink(text);
    } catch {
      // best effort: logging must never break exit handling
    }
  }
}

type TailBlock = { text: string; rawBytes: number };

// The newest lines of `raw`, prefixed, while their WRITTEN size fits in `budget`:
// the crash stack sits at the very end, and short lines must not inflate the block.
function prefixedTail(raw: string, budget: number): TailBlock {
  const lines = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
  let text = "";
  let rawBytes = 0;
  let left = budget;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const size = lineBytes(line);
    if (size > left) {
      return text.length > 0 ? { text, rawBytes } : lineEndBlock(line, left);
    }
    text = `${AGENT_STDERR_PREFIX}${line}\n${text}`;
    left -= size;
    rawBytes += size - PREFIX_BYTES;
  }
  return { text, rawBytes };
}

/** The end of one line too long for the tail budget. */
function lineEndBlock(line: string, budget: number): TailBlock {
  if (budget <= PREFIX_BYTES + 1) {
    return { text: "", rawBytes: 0 };
  }
  const end = utf8Suffix(line, budget - PREFIX_BYTES - 1);
  return { text: `${AGENT_STDERR_PREFIX}${end}\n`, rawBytes: Buffer.byteLength(end) };
}

/** Bytes one line costs in the owner log: prefix + content + newline. */
function lineBytes(line: string): number {
  return PREFIX_BYTES + Buffer.byteLength(line) + 1;
}

/** The longest leading part of `text` that fits in `maxBytes`, never splitting a character. */
function utf8Prefix(text: string, maxBytes: number): string {
  return new StringDecoder("utf8").write(Buffer.from(text, "utf8").subarray(0, maxBytes));
}

/** The longest trailing part of `text` that fits in `maxBytes`, never splitting a character. */
function utf8Suffix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.max(0, bytes.length - maxBytes);
  // Skip UTF-8 continuation bytes (10xxxxxx) so the slice starts on a character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function formatKb(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}
