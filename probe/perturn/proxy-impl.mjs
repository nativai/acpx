/**
 * A transparent ACP adapter proxy — the measurement instrument for M1b/M1c and M2.
 *
 * It is spawned by acpx IN PLACE OF the real adapter (via the `ACPX_*_ACP_COMMAND`
 * env seams, `src/agent-registry.ts:118-131`), spawns the real adapter itself, and
 * pipes both directions through verbatim. Because ACP framing over stdio is ndjson —
 * `JSON.stringify(message) + "\n"`, `@agentclientprotocol/sdk/dist/stream.js:67`, read
 * side `split("\n")` at `:29` — every frame is one line, so byte-faithful logging and
 * line-level rewriting are both exact.
 *
 * ⚠️ WHY THE PROXY MUST LIVE IN A TOKEN-NAMED DIRECTORY. acpx classifies a session by
 * its agent COMMAND STRING, not by asking the adapter: `acpAdapterKind`
 * (`src/acp/agent-command.ts:216`) and `harnessIdForAgentCommand` route on a path
 * SEGMENT equal to the adapter token (`src/acp/adapter-token.ts:46`, brick://5a7cf1f0).
 * A proxy at a path with no such segment would classify as an UNKNOWN adapter and
 * silently change the primer channel, the Codex cap gate and the config-dir leg — so the
 * capture would not be a baseline of anything. Each `adapters/<token>/` directory puts
 * the real token in its own segment, which keeps every classifier's answer identical to
 * the real command's.
 *
 * TWO ARMS, selected by a FILE, not by env: env does not survive a queue-owner respawn
 * between turns, a file does. If `<token>.inject` exists next to the launching script,
 * its contents are appended to every `session/prompt` as one extra text content block.
 * Absent ⇒ pure pass-through. Same instrument, same session, both arms.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** adapter token -> the real adapter command acpx would have launched on this box. */
const TARGETS = {
  "claude-agent-acp": ["node", ["/opt/claude-agent-acp/dist/index.js"]],
  "codex-acp": ["node", ["/opt/codex-acp/dist/index.js"]],
  "pi-acp": ["node", ["/opt/pi-acp/dist/index.js"]],
  "claude-pty-acp": ["node", ["/opt/claude-pty-acp/dist/index.js"]],
};

/** Line-splitting pump. `onLine` returns the text to forward, newline-free. */
function pump(source, sink, onLine) {
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      sink.write(`${onLine(line)}\n`);
    }
  });
  source.on("end", () => {
    if (buffer.length > 0) {
      sink.write(onLine(buffer));
    }
    sink.end();
  });
}

export function runProxy(token) {
  const target = TARGETS[token];
  if (!target) {
    process.stderr.write(`[perturn-proxy] no target for token ${token}\n`);
    process.exit(64);
  }

  const frameDir = process.env.PERTURN_FRAME_DIR || path.join(ROOT, "frames");
  fs.mkdirSync(frameDir, { recursive: true });
  const stamp = `${token}-${process.pid}-${Date.now()}`;
  const outLog = fs.createWriteStream(path.join(frameDir, `${stamp}.c2a.jsonl`), { flags: "a" });
  const inLog = fs.createWriteStream(path.join(frameDir, `${stamp}.a2c.jsonl`), { flags: "a" });
  // The literal bytes acpx wrote, before any parsing or rewriting on our side.
  const rawOut = fs.createWriteStream(path.join(frameDir, `${stamp}.c2a.raw`), { flags: "a" });
  const injectFile = path.join(ROOT, "inject", `${token}.inject`);

  const note = (event, extra) =>
    process.stderr.write(`[perturn-proxy ${token}] ${event}${extra ? ` ${extra}` : ""}\n`);

  note("start", `target=${target[0]} ${target[1].join(" ")} frames=${frameDir}/${stamp}.*`);

  const child = spawn(target[0], [...target[1], ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  child.on("error", (error) => {
    note("spawn-error", String(error));
    process.exit(70);
  });

  // Two placements, two files, so one instrument measures both shapes without a rebuild.
  // `<token>.prepend` is the shape the design ships (CONCEPTION §7.1: the turn-context block
  // goes FIRST so the user's own words stay last and most salient, and so the injected text
  // cannot read as "the user also said this"). `<token>.append` is the secondary shape.
  const readInjection = (kind) => {
    try {
      return fs.readFileSync(`${injectFile}.${kind}`, "utf8");
    } catch {
      return undefined;
    }
  };

  // client -> agent. The only direction we ever rewrite.
  pump(process.stdin, child.stdin, (line) => {
    rawOut.write(`${line}\n`);
    if (line.trim().length === 0) {
      return line;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      outLog.write(`${JSON.stringify({ t: Date.now(), unparsed: line })}\n`);
      return line;
    }
    if (parsed?.method !== "session/prompt") {
      outLog.write(`${JSON.stringify({ t: Date.now(), frame: parsed })}\n`);
      return line;
    }
    const prepend = readInjection("prepend");
    const append = readInjection("append");
    const rawBytes = Buffer.byteLength(line, "utf8");
    if ((prepend === undefined && append === undefined) || !Array.isArray(parsed?.params?.prompt)) {
      outLog.write(
        `${JSON.stringify({ t: Date.now(), promptFrame: parsed, injected: false, rawBytes })}\n`,
      );
      return line;
    }
    parsed.params.prompt = [
      ...(prepend === undefined ? [] : [{ type: "text", text: prepend }]),
      ...parsed.params.prompt,
      ...(append === undefined ? [] : [{ type: "text", text: append }]),
    ];
    const rewritten = JSON.stringify(parsed);
    const placement = prepend === undefined ? "append" : append === undefined ? "prepend" : "both";
    outLog.write(
      `${JSON.stringify({
        t: Date.now(),
        promptFrame: parsed,
        injected: true,
        placement,
        injectionChars: (prepend?.length ?? 0) + (append?.length ?? 0),
        rawBytes,
        sentBytes: Buffer.byteLength(rewritten, "utf8"),
      })}\n`,
    );
    note("injected", `${placement} into session/prompt`);
    return rewritten;
  });

  // agent -> client. Never rewritten; logged so the model's own words land on disk.
  pump(child.stdout, process.stdout, (line) => {
    if (line.trim().length > 0) {
      inLog.write(`${JSON.stringify({ t: Date.now(), line })}\n`);
    }
    return line;
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    note("child-exit", `code=${code} signal=${signal}`);
    outLog.end();
    inLog.end();
    rawOut.end();
    process.exit(code === null ? 1 : code);
  });
}
