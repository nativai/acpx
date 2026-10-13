import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import { withSessionIndexLock } from "../src/session/persistence/index-lock.js";
import {
  LockOrderError,
  readSeatStore,
  SeatLockTimeoutError,
  seatStoreLockPath,
  seatStorePath,
  withSeatStoreWrite,
  type SeatRecord,
} from "../src/session/persistence/seat-store.js";

// brick ae547131 §6.3 — T17 (⊗: d9ab5c0d writes seats.json while another process holds the
// index lock past 2 s, because the seat store rode index.json.lock and its proceed-unlocked fallback).

const SEAT_ID = "22222222-2222-4222-8222-222222222222";
const seatStoreModule = pathToFileURL(
  path.join(import.meta.dirname, "../src/session/persistence/seat-store.js"),
).href;

function seat(nextOrdinal: number): SeatRecord {
  return {
    seatId: SEAT_ID,
    createdAt: "2026-10-13T00:00:00.000Z",
    activeHolderId: "holder-a",
    nextOrdinal,
    closedAt: null,
    name: undefined,
    brickId: undefined,
    favorite: false,
  };
}

async function seedSeat(dir: string): Promise<void> {
  await withSeatStoreWrite(dir, () => ({
    mutation: { kind: "write", seats: new Map([[SEAT_ID, seat(1)]]) },
    result: undefined,
  }));
}

async function tempSessionDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "acpx-seat-lock-"));
}

test("T17 seat lock: a live holder of seats.json.lock makes the writer fail at ~20 s, store untouched", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const dir = await tempSessionDir();
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  try {
    await seedSeat(dir);
    const before = await fs.readFile(seatStorePath(dir), "utf8");
    assert.ok(holder.pid);
    const identity = readProcessBirthIdentity(holder.pid);
    assert.ok(identity);
    const lockBody = JSON.stringify({
      pid: holder.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
      processIdentity: serializeProcessBirthIdentity(identity),
    });
    await fs.writeFile(seatStoreLockPath(dir), lockBody);
    const startedAt = Date.now();
    let mutated = false;
    await assert.rejects(
      withSeatStoreWrite(dir, () => {
        mutated = true;
        return { mutation: { kind: "write", seats: new Map([[SEAT_ID, seat(99)]]) }, result: 0 };
      }),
      (error: unknown) => error instanceof SeatLockTimeoutError,
    );
    const waited = Date.now() - startedAt;
    assert.ok(waited >= 19_500 && waited < 25_000, `waited ${waited} ms`);
    assert.equal(mutated, false, "the mutation ran without the seat lock");
    assert.equal(await fs.readFile(seatStorePath(dir), "utf8"), before, "seats.json changed");
    assert.equal(await fs.readFile(seatStoreLockPath(dir), "utf8"), lockBody, "live lock broken");
  } finally {
    holder.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("T17 lock order: a seat write inside an index-lock hold throws LockOrderError", async () => {
  const dir = await tempSessionDir();
  try {
    await assert.rejects(
      withSessionIndexLock(dir, async () => {
        await withSeatStoreWrite(dir, () => ({ mutation: { kind: "no-change" }, result: 0 }));
      }),
      (error: unknown) => error instanceof LockOrderError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** One 0a seat writer in its OWN process: allocates the seat's next ordinal under the seat lock. */
function mintInChild(dir: string): Promise<number> {
  const script = `
    const m = await import(${JSON.stringify(seatStoreModule)});
    const ordinal = await m.withSeatStoreWrite(${JSON.stringify(dir)}, (store) => {
      const current = store.seats.get(${JSON.stringify(SEAT_ID)});
      const seats = new Map(store.seats);
      seats.set(current.seatId, { ...current, nextOrdinal: current.nextOrdinal + 1 });
      return { mutation: { kind: "write", seats }, result: current.nextOrdinal };
    });
    process.stdout.write(String(ordinal));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("exit", (code) =>
      code === 0 ? resolve(Number(out)) : reject(new Error(`mint child exited ${code}`)),
    );
  });
}

/**
 * A PRE-0a seat writer: it knows only index.json.lock ({pid,ts}, `wx`) and gives up after 2 s and
 * writes anyway. The 0a writers' transitional inner index hold is what excludes it.
 */
function pre0aMintInChild(dir: string): Promise<void> {
  const script = `
    const fs = require("node:fs/promises");
    const path = require("node:path");
    (async () => {
      const lock = path.join(${JSON.stringify(dir)}, "index.json.lock");
      const store = path.join(${JSON.stringify(dir)}, "seats.json");
      const deadline = Date.now() + 2000;
      let locked = false;
      while (Date.now() < deadline) {
        try {
          await fs.writeFile(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: "wx" });
          locked = true;
          break;
        } catch { await new Promise((r) => setTimeout(r, 20)); }
      }
      const raw = JSON.parse(await fs.readFile(store, "utf8"));
      const row = raw[${JSON.stringify(SEAT_ID)}];
      row.next_ordinal += 1;
      await fs.writeFile(store + ".pre0a.tmp", JSON.stringify(raw));
      await fs.rename(store + ".pre0a.tmp", store);
      if (locked) await fs.unlink(lock);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: "inherit" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`pre-0a child exited ${code}`)),
    );
  });
}

test("T17 concurrency: 5 cross-process mints + a pre-0a writer never lose a CAS or reissue an ordinal", async () => {
  const dir = await tempSessionDir();
  try {
    await seedSeat(dir);
    const raw = JSON.parse(await fs.readFile(seatStorePath(dir), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(raw[SEAT_ID]?.next_ordinal, 1, "fixture: on-disk key is next_ordinal");
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => mintInChild(dir)),
      pre0aMintInChild(dir),
    ]);
    const ordinals = results.filter((value): value is number => typeof value === "number");
    assert.equal(ordinals.length, 5);
    assert.equal(new Set(ordinals).size, 5, `an ordinal was reissued: ${ordinals.join(",")}`);
    const store = await readSeatStore(dir);
    assert.equal(store.seats.get(SEAT_ID)?.nextOrdinal, 1 + 5 + 1, "a mint was lost");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
