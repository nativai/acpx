import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listSessionRecordFiles } from "../../session/persistence/index.js";
import { parseSessionRecord } from "../../session/persistence/parse.js";
import { deriveAgentFolders, isSafePathSegment } from "./agent-folder.js";

/**
 * C7 (brick 09197f03) — the `/wisdom` FILESYSTEM migration: carry each agent folder a SEATED session
 * already wrote into the seat-keyed path `<brick>/agents/<seat8>/holders/<session8>/`.
 *
 * (The SESSION STORE's migration is B10's; this one is the filesystem's.)
 *
 * ## 🛑 KEYED ON THE DIRECTORY'S OWN SHAPE — NEVER ON `$ACPX_AGENT_FOLDER` ALONE
 *
 * Measured over the first 120 bricks carrying an `agents/` dir: the `<name>-<id8>` form was created 321
 * times and is non-empty only 20 (6%); the full-uuid form is non-empty 110 of 127 (87%). The naive design
 * — move what `$ACPX_AGENT_FOLDER` named — therefore moves EMPTY directories in ~94% of cases and leaves
 * the artifacts behind, because the env var was documented as the source of truth and the primer taught
 * agents the uuid form instead. So this walks `<pool>/<brick>/agents/<dir>` and classifies each directory by its
 * OWN name:
 *
 *   `<full-uuid>`          → the record with that id
 *   `<anything>-<id8>`     → the single record whose id starts with `id8`
 *   bare `<id8>`           → likewise (unless it is already a C7 seat folder — see `alreadyC7`)
 *
 * and then by what the resolved record carries:
 *
 *   no seat                → `untouchedSeatless` (a seat path is never invented)
 *   seat, directory empty  → removed (`removedEmpty`)
 *   seat, non-empty        → carried into the C7 holder folder (`moved`)
 *
 * Zero or several records for an id8 ⇒ `unresolved` / `ambiguous`, both untouched, as is anything whose name
 * matches no form (`other`). Nothing is ever overwritten or dropped: a merge into an existing target keeps
 * a name collision as `<name>.from-<srcdir>`.
 *
 * ## Dry-run is the DEFAULT and the plan is computed identically in both modes
 *
 * `apply: false` classifies and plans but touches nothing. The classification is a pure function of the
 * pool listing and the session store, so a second `apply` finds every carried folder already inside a seat
 * folder (`alreadyC7`) and reports zero moves and zero removals.
 *
 * 🛑 Never run `apply` against a shared pool without the owner's go: a pool on `/wisdom` is shared between
 * boxes, and records absent from THIS box's store classify `unresolved` (left alone) rather than guessed.
 */

export type AgentFolderMigrationOptions = {
  pool: string;
  sessionsDir: string;
  apply: boolean;
};

export type AgentFolderMigrationCounts = {
  moved: number;
  removedEmpty: number;
  untouchedSeatless: number;
  unresolved: number;
  ambiguous: number;
  other: number;
  alreadyC7: number;
  /** C7 link: uuid-form dirs of seated sessions that are (or, in a dry run, would be) left as a symlink. */
  linked: number;
  /** A uuid-form entry that is ALREADY the right symlink — what makes a second `--apply` a no-op. */
  alreadyLinked: number;
};

export type AgentFolderMigrationAction = {
  action: "move" | "remove-empty";
  brick: string;
  from: string;
  to?: string;
  /** The uuid-form path is replaced by a relative symlink to the holder folder. */
  link?: boolean;
};

export type AgentFolderMigrationReport = {
  mode: "dry-run" | "apply";
  pool: string;
  sessionsDir: string;
  counts: AgentFolderMigrationCounts;
  actions: AgentFolderMigrationAction[];
  /** An action that threw under `--apply`. The run continues; a re-run picks up what is left. */
  errors: Array<{ from: string; message: string }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_FORM_RE = /^.+-([0-9a-f]{8})$/;
const BARE_ID8_RE = /^[0-9a-f]{8}$/;
const ID8_LENGTH = 8;

type StoredSession = { id: string; seatId: string };
type Population = {
  byId: Map<string, StoredSession>;
  byId8: Map<string, StoredSession[]>;
  seatId8s: Set<string>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDirOrThrow(dir: string, what: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Fail CLOSED: an unreadable input must never read as a clean, empty report.
    throw new Error(
      `agent-folders migrate: ${what} not readable: ${dir} (${describeError(error)})`,
      {
        cause: error,
      },
    );
  }
}

async function readStoredSession(
  sessionsDir: string,
  file: string,
): Promise<StoredSession | undefined> {
  try {
    const record = parseSessionRecord(
      JSON.parse(await fs.readFile(path.join(sessionsDir, file), "utf8")),
    );
    if (!record || !isSafePathSegment(record.acpxRecordId)) {
      return undefined;
    }
    return { id: record.acpxRecordId, seatId: record.seatId?.trim() ?? "" };
  } catch {
    // an unreadable record resolves nothing; its directories classify `unresolved` (untouched)
    return undefined;
  }
}

async function readPopulation(sessionsDir: string): Promise<Population> {
  let files: string[];
  try {
    files = await listSessionRecordFiles(sessionsDir);
  } catch (error) {
    throw new Error(
      `agent-folders migrate: sessions directory not readable: ${sessionsDir} (${describeError(error)})`,
      { cause: error },
    );
  }
  const population: Population = { byId: new Map(), byId8: new Map(), seatId8s: new Set() };
  for (const file of files) {
    const session = await readStoredSession(sessionsDir, file);
    if (!session) {
      continue;
    }
    population.byId.set(session.id, session);
    const id8 = session.id.slice(0, ID8_LENGTH);
    population.byId8.set(id8, [...(population.byId8.get(id8) ?? []), session]);
    if (session.seatId.length > 0) {
      population.seatId8s.add(session.seatId.slice(0, ID8_LENGTH));
    }
  }
  return population;
}

async function isDirectory(target: string): Promise<boolean> {
  return await fs.stat(target).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

async function exists(target: string): Promise<boolean> {
  return await fs.lstat(target).then(
    () => true,
    () => false,
  );
}

type Resolution =
  | { kind: "session"; session: StoredSession }
  | { kind: "alreadyC7" | "unresolved" | "ambiguous" | "other" };

/** A bare id8 that is a known SEAT's id8 and holds `holders/` is a C7 seat folder (made by a previous run or a live agent). */
async function isSeatFolder(name: string, dir: string, population: Population): Promise<boolean> {
  return (
    BARE_ID8_RE.test(name) &&
    population.seatId8s.has(name) &&
    (await isDirectory(path.join(dir, "holders")))
  );
}

function resolveById8(id8: string, population: Population): Resolution {
  const candidates = population.byId8.get(id8) ?? [];
  if (candidates.length === 0) {
    return { kind: "unresolved" };
  }
  return candidates.length === 1
    ? { kind: "session", session: candidates[0] }
    : { kind: "ambiguous" };
}

async function resolveDirectory(
  name: string,
  dir: string,
  population: Population,
): Promise<Resolution> {
  if (UUID_RE.test(name)) {
    const session = population.byId.get(name);
    return session ? { kind: "session", session } : { kind: "unresolved" };
  }
  const id8 = BARE_ID8_RE.test(name) ? name : NAME_FORM_RE.exec(name)?.[1];
  if (id8 === undefined) {
    return { kind: "other" };
  }
  // This is what makes a second `--apply` a no-op: carried folders are seat folders, not sources.
  if (await isSeatFolder(name, dir, population)) {
    return { kind: "alreadyC7" };
  }
  return resolveById8(id8, population);
}

/** Where `name` lands in `destDir` without overwriting anything already there. */
async function freeName(destDir: string, name: string, label: string): Promise<string> {
  const base = `${name}.from-${label}`;
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}.${attempt}`;
    if (!(await exists(path.join(destDir, candidate)))) {
      return path.join(destDir, candidate);
    }
  }
}

/** Merge `srcDir` into `destDir`: rename what is absent, recurse into directories on both sides, keep every collision. */
async function mergeDirectory(srcDir: string, destDir: string, label: string): Promise<void> {
  for (const entry of (await fs.readdir(srcDir, { withFileTypes: true })).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (!(await exists(to))) {
      await fs.rename(from, to);
    } else if (entry.isDirectory() && (await isDirectory(to))) {
      await mergeDirectory(from, to, label);
      await fs.rmdir(from);
    } else {
      await fs.rename(from, await freeName(destDir, entry.name, label));
    }
  }
}

async function carryDirectory(source: string, target: string, label: string): Promise<void> {
  let from = source;
  // A bare id8 directory whose id8 is ALSO its own seat id8 would have to move INTO itself.
  if (target.startsWith(`${source}${path.sep}`)) {
    from = `${source}.c7-migrating`;
    await fs.rename(source, from);
  }
  if (!(await exists(target))) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(from, target);
    return;
  }
  await mergeDirectory(from, target, label);
  await fs.rmdir(from);
}

type Classified =
  | { count: "untouchedSeatless" | "unresolved" | "ambiguous" | "other" | "alreadyC7" }
  | { action: AgentFolderMigrationAction; empty: boolean };

async function classifyDirectory(
  entry: Dirent,
  brick: string,
  brickPath: string,
  population: Population,
): Promise<Classified> {
  if (!entry.isDirectory()) {
    return { count: "other" };
  }
  const dir = path.join(brickPath, "agents", entry.name);
  const resolution = await resolveDirectory(entry.name, dir, population);
  if (resolution.kind !== "session") {
    return { count: resolution.kind };
  }
  const { session } = resolution;
  if (session.seatId.length === 0 || !isSafePathSegment(session.seatId)) {
    return { count: "untouchedSeatless" };
  }
  if ((await fs.readdir(dir)).length === 0) {
    return { action: { action: "remove-empty", brick, from: dir }, empty: true };
  }
  const to = deriveAgentFolders({
    brickPath,
    sessionId: session.id,
    seatId: session.seatId,
  }).agentFolder;
  return { action: { action: "move", brick, from: dir, to }, empty: false };
}

async function executeAction(action: AgentFolderMigrationAction, label: string): Promise<void> {
  if (action.to === undefined) {
    await fs.rmdir(action.from);
  } else {
    await carryDirectory(action.from, action.to, label);
  }
}

type MigrationState = {
  counts: AgentFolderMigrationCounts;
  actions: AgentFolderMigrationAction[];
  errors: Array<{ from: string; message: string }>;
};

async function migrateBrick(
  options: AgentFolderMigrationOptions,
  brick: string,
  population: Population,
  state: MigrationState,
): Promise<void> {
  const brickPath = path.join(options.pool, brick);
  const agentsDir = path.join(brickPath, "agents");
  if (!(await isDirectory(agentsDir))) {
    return;
  }
  // Listed ONCE, up front: folders this loop creates (`<seat8>/`) are never re-read as sources.
  for (const entry of (await readDirOrThrow(agentsDir, "agents directory")).toSorted(byName)) {
    const classified = await classifyDirectory(entry, brick, brickPath, population);
    if ("count" in classified) {
      state.counts[classified.count] += 1;
      continue;
    }
    try {
      if (options.apply) {
        await executeAction(classified.action, entry.name);
      }
    } catch (error) {
      state.errors.push({ from: classified.action.from, message: describeError(error) });
      continue;
    }
    state.actions.push(classified.action);
    state.counts[classified.empty ? "removedEmpty" : "moved"] += 1;
  }
}

export async function migrateAgentFolders(
  options: AgentFolderMigrationOptions,
): Promise<AgentFolderMigrationReport> {
  const state: MigrationState = {
    counts: {
      moved: 0,
      removedEmpty: 0,
      untouchedSeatless: 0,
      unresolved: 0,
      ambiguous: 0,
      other: 0,
      alreadyC7: 0,
      linked: 0,
      alreadyLinked: 0,
    },
    actions: [],
    errors: [],
  };
  const population = await readPopulation(options.sessionsDir);
  const bricks = await readDirOrThrow(options.pool, "pool");
  for (const brick of bricks.filter((entry) => entry.isDirectory()).toSorted(byName)) {
    await migrateBrick(options, brick.name, population, state);
  }
  return {
    mode: options.apply ? "apply" : "dry-run",
    pool: options.pool,
    sessionsDir: options.sessionsDir,
    ...state,
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
