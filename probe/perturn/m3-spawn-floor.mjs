/**
 * M3 — the floor cost of a trivial subprocess spawn, in the SHAPE session-primer.ts uses.
 *
 * The shape being measured is taken from `src/acp/session-primer.ts:123-181`:
 *   spawn(command, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env })
 * then collect stdout to completion and resolve on `close`. That whole interval is what a
 * per-turn shell-command source would add to every turn, so that whole interval is measured
 * — not just the fork.
 *
 * ARMS, interleaved A/B/A/B rather than run in blocks, because devbox load swings 2-4x
 * within minutes and two arms run minutes apart compare windows rather than code:
 *   sh      — a 2-line /bin/sh script that echoes one line (the cheapest realistic executable)
 *   node    — a node script that echoes one line (the shape anyone would actually write)
 *   null-A  }  TWO ARMS OF IDENTICAL CODE. This is the NULL EXPERIMENT: whatever distance
 *   null-B  }  appears between these two is noise, and no reported delta below it is a result.
 *   inproc  — calling a JS function instead, i.e. the in-process provider alternative
 *
 * Reported as median, with min/max, over N interleaved rounds.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROUNDS = Number(process.argv[2] ?? 40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3-spawn-"));
const shScript = path.join(dir, "primer.sh");
const nodeScript = path.join(dir, "primer.mjs");
fs.writeFileSync(shScript, "#!/bin/sh\necho 'per-turn delta'\n", { mode: 0o755 });
fs.writeFileSync(nodeScript, "process.stdout.write('per-turn delta\\n');\n");

/** Exactly session-primer.ts's exec shape: spawn, collect stdout, resolve on close. */
function spawnOnce(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 && stdout.length > 0 ? resolve(stdout) : reject(new Error(`code=${code}`)),
    );
  });
}

function inProcess() {
  return "per-turn delta\n";
}

const arms = {
  sh: () => spawnOnce(shScript, []),
  "null-A": () => spawnOnce(shScript, []),
  "null-B": () => spawnOnce(shScript, []),
  node: () => spawnOnce(process.execPath, [nodeScript]),
  inproc: async () => inProcess(),
};

const samples = Object.fromEntries(Object.keys(arms).map((name) => [name, []]));

// Warm the page cache / dynamic linker so round 1 is not an outlier masquerading as a trend.
for (const run of Object.values(arms)) {
  await run();
}

for (let round = 0; round < ROUNDS; round++) {
  for (const [name, run] of Object.entries(arms)) {
    const started = process.hrtime.bigint();
    const out = await run();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (out !== "per-turn delta\n") {
      throw new Error(`${name} produced unexpected output ${JSON.stringify(out)}`);
    }
    samples[name].push(elapsedMs);
  }
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const fmt = (value) => value.toFixed(3).padStart(8);

console.log(`rounds=${ROUNDS}  interleaved A/B/A/B  node=${process.version}  host=${os.hostname()}`);
console.log("arm        median      p90       min       max");
for (const [name, values] of Object.entries(samples)) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `${name.padEnd(9)}${fmt(quantile(sorted, 0.5))}  ${fmt(quantile(sorted, 0.9))}  ${fmt(sorted[0])}  ${fmt(sorted[sorted.length - 1])}`,
  );
}

const med = (name) => {
  const sorted = [...samples[name]].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
};
const noiseFloor = Math.abs(med("null-A") - med("null-B"));
console.log("");
console.log(`NOISE FLOOR (|null-A - null-B| medians) = ${noiseFloor.toFixed(3)} ms`);
console.log(`sh    median - inproc median = ${(med("sh") - med("inproc")).toFixed(3)} ms`);
console.log(`node  median - inproc median = ${(med("node") - med("inproc")).toFixed(3)} ms`);
console.log(
  `A reported delta is only a result if it exceeds the noise floor above. sh clears it by ${(
    (med("sh") - med("inproc")) / (noiseFloor || 1e-9)
  ).toFixed(0)}x, node by ${((med("node") - med("inproc")) / (noiseFloor || 1e-9)).toFixed(0)}x.`,
);

fs.rmSync(dir, { recursive: true, force: true });
