import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { piBoxSessionDirFor } from "../src/acp/harness-config-dir.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionMessage } from "../src/types.js";
import { type Fixture, toJsonl } from "./pi-cut-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick 4bf088a7 — the source staging both Pi-cut wire tests share: a derived fixture written the way
// acpx (record + messages log) and pi (JSONL in the box store) store it, and a FAKE pi-acp command in
// classified as Pi by its `pi-acp` path segment, as `node /opt/pi-acp/dist/index.js` is (a synthetic command would never be classified as Pi).

export const FAKE_PI_ACP = fileURLToPath(
  new URL("./fake-pi-acp/pi-acp/bin/index.js", import.meta.url),
);

export type Staged = {
  id: string;
  cwd: string;
  agentCommand: string;
  ops: string;
  outDir: string;
  piFile: string;
};

/** The source record (acpx history + pi file) of `fixture`, written the way acpx and pi store them. */
export async function stage(
  homeDir: string,
  fixture: Fixture,
  adapterFlags: string[] = [],
  entries: SessionMessage[] = fixture.entries,
  pi: string = toJsonl(fixture.pi),
): Promise<Staged> {
  const id = fixture.id;
  const cwd = path.join(homeDir, "work");
  const acpSessionId = `acp-${id}`;
  const env = { ...process.env, ACPX_PI_BOX_AGENT_DIR: path.join(homeDir, "pi-agent") };
  const dir = piBoxSessionDirFor(cwd, env);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const piFile = path.join(dir, `2026-01-01T00-00-00-000Z_${acpSessionId}.jsonl`);
  await fs.writeFile(piFile, `${pi}\n`);
  const ops = path.join(homeDir, "adapter-ops.ndjson");
  const outDir = path.join(homeDir, "adapter-out");
  const agentCommand = [
    "node",
    JSON.stringify(FAKE_PI_ACP),
    "--source-file",
    JSON.stringify(piFile),
    "--ops-log",
    JSON.stringify(ops),
    "--out-dir",
    JSON.stringify(outDir),
    ...adapterFlags,
  ].join(" ");
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await fs.writeFile(path.join(sessionDir, `${id}.messages.ndjson`), payload, "utf8");
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({ acpxRecordId: id, acpSessionId, agentCommand, cwd, messages: [] }),
  );
  serialized.messages_log = {
    v: 1,
    count: entries.length,
    base_index: fixture.baseIndex,
    bytes: Buffer.byteLength(payload),
  };
  await fs.writeFile(path.join(sessionDir, `${id}.json`), `${JSON.stringify(serialized)}\n`);
  return { id, cwd, agentCommand, ops, outDir, piFile };
}

export type AdapterOp = { method: string; meta?: { acpx?: Record<string, unknown> } | null };

export async function adapterOps(s: Staged): Promise<AdapterOp[]> {
  const raw = await fs.readFile(s.ops, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AdapterOp);
}

export const forkOps = async (s: Staged): Promise<AdapterOp[]> =>
  (await adapterOps(s)).filter((op) => op.method === "session/fork");

export async function forkFiles(s: Staged): Promise<string[]> {
  return await fs.readdir(s.outDir).catch(() => []);
}
