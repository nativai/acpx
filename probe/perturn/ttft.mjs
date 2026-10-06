/**
 * Time-to-first-token floor per harness, derived from the proxy's own frame logs.
 *
 * METHOD. Both logs are written by the SAME proxy process, so both timestamps come from
 * one clock with no cross-process skew. For each `session/prompt` frame seen going
 * client->agent, the floor is the delta to the FIRST subsequent agent->client
 * `session/update` carrying an `agent_message_chunk`.
 *
 * WHAT THIS IS A FLOOR OF. It measures adapter + harness + model time, observed from the
 * point where acpx has finished writing the request. That is exactly the interval a
 * per-turn resolve would be spending its budget against, which is why this is the
 * falsifier for a resolve-budget figure.
 *
 * WHAT IT IS NOT. It is not a benchmark of any harness, it is a handful of observations on
 * a shared, loaded box (devbox load swings 2-4x within minutes), and no two harnesses here
 * answered the same question at the same moment. Order-of-magnitude only.
 */
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "probe/perturn/frames";

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

const stems = new Set(
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".c2a.jsonl"))
    .map((name) => name.slice(0, -".c2a.jsonl".length)),
);

for (const stem of [...stems].sort()) {
  const c2aFile = path.join(dir, `${stem}.c2a.jsonl`);
  const a2cFile = path.join(dir, `${stem}.a2c.jsonl`);
  if (!fs.existsSync(a2cFile)) {
    continue;
  }
  const prompts = readJsonl(c2aFile).filter((entry) => entry.promptFrame);
  if (prompts.length === 0) {
    continue;
  }
  const chunks = readJsonl(a2cFile).filter((entry) => {
    if (!entry.line.includes("session/update")) {
      return false;
    }
    try {
      return JSON.parse(entry.line)?.params?.update?.sessionUpdate === "agent_message_chunk";
    } catch {
      return false;
    }
  });
  for (const prompt of prompts) {
    const first = chunks.find((chunk) => chunk.t >= prompt.t);
    console.log(
      `${stem.split("-").slice(0, -2).join("-").padEnd(18)} injected=${String(prompt.injected).padEnd(5)} blocks=${prompt.promptFrame.params.prompt.length} ttft_ms=${first ? first.t - prompt.t : "NO-CHUNK-OBSERVED"}`,
    );
  }
}
