// Shared fixtures of the A-65 rows (unknown-top-level-fields*.test.ts). Imports nothing that is new in A-65,
// so the behavioural rows compile and run against the tree before the fix.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath } from "./runtime-test-helpers.js";

/** Top-level keys a newer release might add. The snake_case one is the contract's own example. */
export const PLANTED: Readonly<Record<string, unknown>> = {
  te_unknown_future_field: { placement: "pod", nested: { n: [1, 2, { x: null }] }, flag: true },
  teCamelField: "camel",
  "Odd-Key 1": 7,
  "a.b": [true, false],
  "": "empty-key",
};
export const PLANTED_META = { te_unknown_meta: "meta-value" };

export type Raw = Record<string, unknown> & { metadata?: Record<string, string>; title?: unknown };

export async function readRaw(homeDir: string, id: string): Promise<Raw> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Raw;
}

export async function writeRaw(homeDir: string, id: string, raw: Raw): Promise<void> {
  await fs.writeFile(sessionFilePath(homeDir, id), `${JSON.stringify(raw)}\n`, "utf8");
}

/** Adds the planted keys (and the unknown metadata key) to the record file as a newer release would. */
export async function plant(homeDir: string, id: string): Promise<void> {
  const raw = await readRaw(homeDir, id);
  for (const [key, value] of Object.entries(PLANTED)) {
    Object.defineProperty(raw, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  raw.metadata = { ...raw.metadata, ...PLANTED_META };
  await writeRaw(homeDir, id, raw);
}

/** Byte-equal: the serialized value of every planted key and of the unknown metadata key is unchanged. */
export function assertPlantedKept(raw: Raw, label: string): void {
  for (const [key, value] of Object.entries(PLANTED)) {
    assert.ok(Object.hasOwn(raw, key), `${label}: top-level key ${JSON.stringify(key)} is gone`);
    assert.equal(JSON.stringify(raw[key]), JSON.stringify(value), `${label}: ${key} changed`);
  }
  assert.equal(
    raw.metadata?.te_unknown_meta,
    PLANTED_META.te_unknown_meta,
    `${label}: metadata key`,
  );
}

export function newRecord(
  homeDir: string,
  id: string,
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
    ...extra,
  });
}

/** A record on disk with the planted keys, read back through the parser (so it carries them). */
export async function seeded(homeDir: string, id: string): Promise<SessionRecord> {
  await writeSessionRecord(newRecord(homeDir, id, { metadata: { own: "1" } }));
  await plant(homeDir, id);
  return await resolveSessionRecord(id);
}
