import { StringDecoder } from "node:string_decoder";

// Bounded copy of an adapter's stderr for the queue owner's `<id>.owner.log`
// (brick 7c06a855). Without it, acpx dropped adapter stderr unless --verbose, so
// when codex-acp died 8× mid-turn on 2026-10-10 with exit code 1, the owner log
// held only "agent exit observed: code=1" and the uncaught-exception stack Node
// printed on the adapter's stderr was gone (RCA: brick e7e7d2ab).
//
// One instance per adapter PROCESS. Every complete line is written with
// AGENT_STDERR_PREFIX so it can never be mistaken for acpx's own `[acpx]` lines.
// Past `capBytes` it writes one truncation line and stops teeing; if the process
// then dies unexpectedly, the last `tailBytes` are written once both the exit is
// known and the stream has ended, so a crash stack is never lost behind the cap.
// The sink must be best-effort; this class never throws out of a call.

export const AGENT_STDERR_PREFIX = "[agent-stderr] ";
export const AGENT_STDERR_CAP_BYTES = 256 * 1024;
export const AGENT_STDERR_TAIL_BYTES = 8 * 1024;

export class AgentStderrTee {
  private teedBytes = 0;
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
    if (this.truncated) {
      return;
    }
    const room = this.capBytes - this.teedBytes;
    const taken = bytes.length <= room ? bytes : bytes.subarray(0, room);
    this.teedBytes += taken.length;
    const text = this.pendingLine + this.decoder.write(taken);
    const lastNewline = text.lastIndexOf("\n");
    this.pendingLine = text.slice(lastNewline + 1);
    let out = lastNewline >= 0 ? prefixLines(text.slice(0, lastNewline)) : "";
    if (taken.length < bytes.length) {
      // The cap fell inside this chunk: flush the partial line, then say so once.
      this.truncated = true;
      out += this.takePendingLine();
      out += `[acpx] agent stderr truncated after ${formatKb(this.capBytes)}\n`;
    }
    this.emit(out);
  }

  /** The adapter's stderr stream closed: flush a trailing partial line. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (!this.truncated) {
      this.emit(this.takePendingLine());
    }
    this.maybeWriteTail();
  }

  /** The adapter died unexpectedly mid-prompt (the `unexpectedDuringPrompt=true` path). */
  noteUnexpectedExit(): void {
    this.unexpectedExit = true;
    this.maybeWriteTail();
  }

  private maybeWriteTail(): void {
    if (!this.truncated || !this.ended || !this.unexpectedExit || this.tailWritten) {
      return;
    }
    this.tailWritten = true;
    const text = this.tail.toString("utf8");
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    this.emit(
      `[acpx] agent stderr tail (last ${this.tail.length} of ${this.totalBytes} bytes) after unexpected exit:\n` +
        prefixLines(body),
    );
  }

  private takePendingLine(): string {
    const rest = this.pendingLine + this.decoder.end();
    this.pendingLine = "";
    return rest.length > 0 ? `${AGENT_STDERR_PREFIX}${rest}\n` : "";
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

function prefixLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `${AGENT_STDERR_PREFIX}${line}\n`)
    .join("");
}

function formatKb(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}
