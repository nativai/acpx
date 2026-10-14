/**
 * Same-record WRITER PAIRS across PROCESSES (brick eb4c8d06). Driven by
 * `test/outbox-writer-pairs.test.ts`; both roles share one isolated HOME.
 *
 *   owner <dir> <records>   — a queue owner's live checkpoint, the runtime's sequence
 *                             (`runtime.ts` LiveSessionCheckpoint save): pre-read the lifecycle
 *                             for its own merges, then `eventWriter.checkpoint()` =
 *                             `writeSessionRecord`. Round-robin over the
 *                             records, back to back, until `<dir>/stop` exists. Publishes
 *                             per-record write counts to `<dir>/owner.json`.
 *   pair <dir> <kind> <records> — applies ONE op per record (record i gets op i), then waits until
 *                             the owner has rewritten that record twice more and reads the disk:
 *                             an op whose effect is gone is a LOST UPDATE. Prints a JSON summary.
 *
 * kinds: writer (a second writer's read-modify-write + rename), close (`sessions close`),
 *        set-parent (`sessions set-parent`), ui-lifecycle (acpx-ui-style raw tmp + rename of
 *        favorite / name / metadata).
 */
import fs from "node:fs";
import path from "node:path";
import { closeSession } from "../../src/cli/session/session-control.js";
import { setSessionParent } from "../../src/cli/session/session-reparent.js";
import {
  parseSessionRecord,
  readPersistedLifecycle,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../src/session/persistence.js";
import type { SessionRecord } from "../../src/types.js";

const [role, dir, a3, a4] = process.argv.slice(2);
const sessionsDir = path.join(process.env.HOME ?? "", ".acpx", "sessions");
const recordFile = (id: string): string => path.join(sessionsDir, `${encodeURIComponent(id)}.json`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const recordId = (i: number): string => `pair-record-${i}`;

function readDisk(id: string): SessionRecord | null {
  return parseSessionRecord(JSON.parse(fs.readFileSync(recordFile(id), "utf8")));
}

async function runOwner(count: number): Promise<void> {
  const records: SessionRecord[] = [];
  for (let i = 0; i < count; i++) {
    records.push(await resolveSessionRecord(recordId(i)));
  }
  const writes = Array.from({ length: count }, () => 0);
  const errors: Record<string, number> = {};
  let turn = 0;
  while (!fs.existsSync(path.join(dir, "stop"))) {
    const i = turn++ % count;
    const record = records[i];
    try {
      await readPersistedLifecycle(record.acpxRecordId);
      record.messages.push({
        Agent: { content: [{ Text: `checkpoint ${turn}` }], tool_results: {} },
      });
      record.lastUsedAt = new Date().toISOString();
      await writeSessionRecord(record);
      writes[i]++;
    } catch (error) {
      const code = (error as { code?: string }).code ?? (error as Error).message;
      errors[code] = (errors[code] ?? 0) + 1;
    }
    const tmp = path.join(dir, `owner.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ writes, errors }));
    fs.renameSync(tmp, path.join(dir, "owner.json"));
    await sleep(5);
  }
}

function ownerWriteCounts(): number[] | undefined {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")) as { writes: number[] }
    ).writes;
  } catch {
    return undefined;
  }
}

function ownerWrites(i: number): number {
  return ownerWriteCounts()?.[i] ?? 0;
}

function ownerTotalWrites(): number {
  return (ownerWriteCounts() ?? []).reduce((sum, count) => sum + count, 0);
}

// `owner-stalled` means the owner STOPPED checkpointing — no write to ANY record for this long.
//
// ⚠️ NOT a deadline on the whole wait (brick 4fb1e3d3, gate red #1938). Two more rewrites of record i
// take two full round-robins, 2 × records = 40 owner checkpoints, so a flat 20 s deadline was a floor of
// 2 checkpoints/s on owner throughput — which a loaded box crosses with the owner healthy and the
// property held (lost 0/20, `owner-stalled` 1). Measured owner throughput on the workbench swings
// ~3× with box load (11–40/s), identical on main and dev. A progress window tracks the owner, not the box.
const OWNER_NO_PROGRESS_MS = 20_000;

/** Waits until record i has been rewritten twice after `after`; false only if the owner stalls. */
async function waitForTwoRewrites(i: number, after: number): Promise<boolean> {
  let lastTotal = ownerTotalWrites();
  let lastProgressAt = Date.now();
  while (ownerWrites(i) < after + 2) {
    const total = ownerTotalWrites();
    if (total !== lastTotal) {
      lastTotal = total;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= OWNER_NO_PROGRESS_MS) {
      return false;
    }
    await sleep(10);
  }
  return true;
}

/** Applies op i to record i and returns a check that is true while the op's effect survives. */
async function applyOp(kind: string, i: number): Promise<(r: SessionRecord | null) => boolean> {
  const id = recordId(i);
  if (kind === "writer") {
    const record = await resolveSessionRecord(id);
    record.metadata = { ...record.metadata, [`pair_${i}`]: "1" };
    await writeSessionRecord(record);
    return (r) => r?.metadata?.[`pair_${i}`] === "1";
  }
  if (kind === "close") {
    await closeSession(id);
    return (r) => r?.closed === true;
  }
  if (kind === "set-parent") {
    await setSessionParent({
      target: { kind: "session", sessionId: id },
      parent: { id: "pair-parent" },
    });
    return (r) => r?.parentSessionId === "pair-parent";
  }
  if (kind === "ui-lifecycle") {
    const raw = JSON.parse(fs.readFileSync(recordFile(id), "utf8")) as Record<string, unknown>;
    raw.favorite = true;
    raw.favorited_at = new Date().toISOString();
    raw.title = `ui-name-${i}`;
    raw.metadata = { ...(raw.metadata as Record<string, string> | undefined), [`ui_${i}`]: "1" };
    const tmp = `${recordFile(id)}.ui.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, recordFile(id));
    return (r) =>
      r?.favorite === true && r?.title === `ui-name-${i}` && r?.metadata?.[`ui_${i}`] === "1";
  }
  throw new Error(`unknown kind ${kind}`);
}

async function runPair(kind: string, count: number): Promise<void> {
  // Wait until the owner is actually checkpointing every record.
  while (Array.from({ length: count }, (_u, i) => ownerWrites(i)).some((w) => w < 1)) {
    await sleep(10);
  }
  let lost = 0;
  let observedWithOp = 0;
  const lostRecords: string[] = [];
  const opErrors: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    let survives: (r: SessionRecord | null) => boolean;
    try {
      survives = await applyOp(kind, i);
    } catch (error) {
      const code = (error as { code?: string }).code ?? (error as Error).message;
      opErrors[code] = (opErrors[code] ?? 0) + 1;
      continue;
    }
    if (survives(readDisk(recordId(i)))) {
      observedWithOp++;
    }
    if (!(await waitForTwoRewrites(i, ownerWrites(i)))) {
      opErrors["owner-stalled"] = (opErrors["owner-stalled"] ?? 0) + 1;
      continue;
    }
    if (!survives(readDisk(recordId(i)))) {
      lost++;
      lostRecords.push(recordId(i));
    }
  }
  process.stdout.write(
    `${JSON.stringify({ kind, ops: count, observedWithOp, lost, lostRecords, opErrors })}\n`,
  );
}

if (role === "owner") {
  await runOwner(Number(a3));
} else if (role === "pair") {
  await runPair(a3, Number(a4));
} else {
  process.exit(2);
}
