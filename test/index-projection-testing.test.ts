import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// Brick e17c571e: `index-projection-testing` — a TEST-ONLY module that holds the session index lock from another
// process. It is built as its own entry; the production projection entry stays at its seven names and never
// reaches it. Walks and loads the BUILT files (`pnpm test` builds dist/ first).

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const PROJECTION = path.join(DIST, "index-projection.js");
const TESTING = path.join(DIST, "index-projection-testing.js");

const KEYS = `
const mod = await import(process.argv[1]);
console.log(JSON.stringify(Object.keys(mod).sort()));
`;

function keysOf(file: string): string[] {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", KEYS, pathToFileURL(file).href],
      { encoding: "utf8" },
    ),
  ) as string[];
}

test("the testing module is built and exports exactly the lock holders", () => {
  assert.ok(fs.existsSync(TESTING), `${TESTING} missing — run \`pnpm run build\` (pnpm test does)`);
  assert.deepEqual(keysOf(TESTING), ["holdSessionIndexLock", "withSessionIndexLock"]);
});

test("the production projection entry is NOT widened and never reaches the testing module", () => {
  // The surface (the agreed seven names) — test/index-projection-module.test.ts holds it too; here the negative:
  const keys = keysOf(PROJECTION);
  for (const name of ["holdSessionIndexLock", "withSessionIndexLock"]) {
    assert.equal(
      keys.includes(name),
      false,
      `${name} must not be exported by the projection entry`,
    );
  }
  assert.equal(keys.length, 7);
  // Neither the entry nor any chunk it imports (a relative specifier) names the testing module.
  const seen = new Set<string>();
  const stack = [PROJECTION];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'](\.[^"']+)["']/gu)) {
      const target = path.resolve(path.dirname(file), match[1] ?? "");
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        stack.push(target);
      }
    }
  }
  assert.ok(seen.size >= 2, "positive control: the walk followed the entry's imports");
  assert.deepEqual(
    [...seen].filter((file) => file.includes("index-projection-testing")),
    [],
  );
  // And the source: the projection entry does not import it.
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../src/index-projection.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("index-projection-testing"), false);
});

function recordText(id: string): string {
  return JSON.stringify(
    serializeSessionRecordForDisk(
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: `acp-${id}`,
        agentCommand: "agent",
        cwd: "/tmp/hold",
      }),
      { messages: "split-tail" },
    ),
  );
}

function holder(dir: string, ms: number): { child: ChildProcess; held: Promise<void> } {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `const { holdSessionIndexLock } = await import(${JSON.stringify(pathToFileURL(TESTING).href)});
       await holdSessionIndexLock(${JSON.stringify(dir)}, ${String(ms)}, () => console.log("held"));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const held = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) {
        resolve();
      }
    });
    child.on("exit", () => reject(new Error("the holder ended before it held the lock")));
  });
  return { child, held };
}

test("another process holds index.json.lock: the lock file names the holder's pid; a second process's batch waits for it, ends in IndexLockTimeoutError after the bound, and writes nothing", async () => {
  await withTempHome("acpx-index-lock-holder-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "hold-1.json"), recordText("hold-1"));
    // Longer than the 20 s bound, so the contender really times out rather than being let in.
    const { child, held } = holder(dir, 27_000);
    try {
      await held;
      const lock = JSON.parse(await fsp.readFile(path.join(dir, "index.json.lock"), "utf8")) as {
        pid: number;
      };
      assert.equal(lock.pid, child.pid, "the lock file names the holder's pid");
      const started = Date.now();
      const contender = spawn(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `const mod = await import(${JSON.stringify(pathToFileURL(PROJECTION).href)});
           try { await mod.projectRecordFilesIntoIndex(${JSON.stringify(dir)}, ["hold-1.json"]); console.log("RETURNED"); }
           catch (error) { console.log(mod.isIndexLockTimeout(error) ? "TIMEOUT" : "OTHER " + String(error)); }`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let out = "";
      contender.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      await new Promise<void>((resolve) => contender.on("exit", () => resolve()));
      const waited = Date.now() - started;
      assert.equal(out.trim(), "TIMEOUT", out);
      assert.ok(waited >= 19_000, `the contender WAITED for the bound (${waited} ms)`);
      assert.equal(
        fs.existsSync(path.join(dir, "index.json")),
        false,
        "the timed-out batch wrote nothing: no index.json",
      );
      assert.equal(child.exitCode, null, "the holder still held the lock throughout");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("positive control: with the lock free the same batch projects (so the timeout above was the held lock)", async () => {
  await withTempHome("acpx-index-lock-free-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "free-1.json"), recordText("free-1"));
    const { projectRecordFilesIntoIndex, sessionIndexPath } =
      await import("../src/index-projection.js");
    assert.deepEqual(await projectRecordFilesIntoIndex(dir, ["free-1.json"]), { files: 1 });
    assert.equal(fs.existsSync(sessionIndexPath(dir)), true);
  });
});
