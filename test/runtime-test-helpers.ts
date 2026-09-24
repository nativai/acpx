import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionStore } from "../src/runtime.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { beginIsolatedHarnessConfigDirRoot } from "./config-dir-root-isolation.js";
import { installOwnerReaper } from "./owner-reaper.js";

// brick://113073b8 — stamp this test-file process's unique owner tag and register
// the teardown reap. MUST run at module load: every test file reaches this module
// before any test body executes, so every `__queue-owner` the file later spawns —
// in process or through a `runCli` subprocess — inherits the tag and is reapable.
installOwnerReaper();

export type MakeSessionRecordOptions = {
  defaultName?: boolean;
  defaultAcpx?: boolean;
  resolveCwd?: boolean;
};

export function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
  options: MakeSessionRecordOptions = {},
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const defaultName = options.defaultName ?? true;
  const defaultAcpx = options.defaultAcpx ?? true;
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentName: overrides.agentName,
    agentCommand: overrides.agentCommand,
    cwd: options.resolveCwd === false ? overrides.cwd : path.resolve(overrides.cwd),
    name: overrides.name ?? (defaultName ? overrides.acpxRecordId : undefined),
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    favorite: overrides.favorite,
    favoritedAt: overrides.favoritedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    lastAgentUnexpectedDuringPrompt: overrides.lastAgentUnexpectedDuringPrompt,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx ?? (defaultAcpx ? {} : undefined),
    // ⚠️ THIS PROJECTION IS AN ALLOWLIST, AND AN OVERRIDE MISSING FROM IT IS
    // SILENTLY DROPPED — the fixture compiles, the test runs, and the field the
    // test is ABOUT is simply not there. The lineage block below was added
    // (brick c99f9994) after a set of re-parent tests seeded `parentSessionId`
    // and every one of them measured a parentless record instead. Adding a field
    // to `SessionRecord`? Add it HERE too, or no test can ever seed it.
    kind: overrides.kind,
    parentSessionId: overrides.parentSessionId,
    parentSessionUrl: overrides.parentSessionUrl,
    parentSetAt: overrides.parentSetAt,
    spawnedBySessionId: overrides.spawnedBySessionId,
    forkedFromSessionId: overrides.forkedFromSessionId,
    forkedAtMessageIndex: overrides.forkedAtMessageIndex,
    forkedAtMessageIndexRequested: overrides.forkedAtMessageIndexRequested,
    metadata: overrides.metadata,
    importedFrom: overrides.importedFrom,
    template: overrides.template,
    // SEATS (C2, brick 5ad22d5d) — same allowlist hazard the comment above
    // names; this exact miss (fields silently dropped by this fixture helper,
    // not by production code) cost a false-negative on the set-parent
    // parentSeatId invariant test during B1's own implementation.
    seatId: overrides.seatId,
    holderOrdinal: overrides.holderOrdinal,
    holderActive: overrides.holderActive,
    parentSeatId: overrides.parentSeatId,
  };
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * ⚠️ Pins BOTH `ACPX_STATE_HOME` and `HOME` to the same temp path, and both are
 * required. `sessionBaseDir()` reads `process.env.ACPX_STATE_HOME || os.homedir()`
 * — `ACPX_STATE_HOME` WINS — so a helper that pinned only `HOME` would run every
 * test against whatever `ACPX_STATE_HOME` pointed at *while reading as isolated*.
 * That was this helper until brick://dd4cb0e8: safe purely because the var happens
 * to be unset on the dev boxes, i.e. isolated by luck rather than by construction,
 * and the tests it isolates include a suite that DELETES session records.
 * `assertTempHomePath` enforces the same pair, so a call site cannot get one
 * without the other.
 */
export async function withTempHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T>,
): Promise<T> {
  const originalHome = process.env.HOME;
  const originalStateHome = process.env.ACPX_STATE_HOME;
  const originalFetch = globalThis.fetch;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.HOME = tempHome;
  process.env.ACPX_STATE_HOME = tempHome;
  // ⚠️ THE STORE AND THE CONFIG-DIR ROOT ARE TWO SEPARATE ISOLATIONS, and pinning
  // the store does not scope the sweep: `sessions prune` sweeps `tmpdir()`, which
  // no HOME reaches. Without this line every prune the suite runs walks the box's
  // real /tmp (brick 0bac6a00, `config-dir-root-isolation.ts`).
  const restoreConfigDirRoot = beginIsolatedHarnessConfigDirRoot(tempHome);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "http://127.0.0.1:3456/api/usage/codex/quota") {
      return new Response(
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          secondary: { windowMinutes: 10_080, usedPercent: 0, elapsed: false },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return await originalFetch(input, init);
  };

  try {
    return await run(tempHome);
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ACPX_STATE_HOME", originalStateHome);
    globalThis.fetch = originalFetch;
    restoreConfigDirRoot();
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original == null) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

export function assertTempHomeActive(): string {
  const home = process.env.HOME;
  assertTempHomePath(home);
  return home;
}

export function assertTempHomePath(homeDir: string | undefined): asserts homeDir is string {
  if (!isUnderTmpdir(homeDir)) {
    throw new Error("test attempted to touch the acpx session store without a temp HOME");
  }
  // ACPX_STATE_HOME takes PRECEDENCE over HOME in sessionBaseDir(), so guarding
  // only the HOME path leaves the store resolution unguarded. A test that pins
  // HOME to a temp dir while ACPX_STATE_HOME still points at a real one reads as
  // isolated and is not.
  const stateHome = process.env.ACPX_STATE_HOME ?? "";
  if (stateHome !== "" && !isUnderTmpdir(stateHome)) {
    throw new Error(
      `test attempted to touch the acpx session store with ACPX_STATE_HOME outside the temp dir (${stateHome}) — it overrides HOME in sessionBaseDir()`,
    );
  }
}

// Plain boolean, deliberately not a `dir is string` type predicate: as a predicate
// its NEGATIVE branch narrows an already-`string` argument to `never`, which then
// trips restrict-template-expressions in the error message below.
function isUnderTmpdir(dir: string | undefined): boolean {
  return Boolean(dir) && path.resolve(dir ?? "").startsWith(path.resolve(os.tmpdir()) + path.sep);
}

export function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

export async function writeSessionRecordFile(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  assertTempHomePath(homeDir);
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class InMemorySessionStore implements AcpSessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly savedRecordIds: string[] = [];

  constructor(initialRecords: SessionRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.acpxRecordId, structuredClone(record));
    }
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: SessionRecord): Promise<void> {
    this.savedRecordIds.push(record.acpxRecordId);
    this.records.set(record.acpxRecordId, structuredClone(record));
  }
}

export function createRuntimeOptions(params: {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry?: AcpAgentRegistry;
  timeoutMs?: number;
}): AcpRuntimeOptions {
  return {
    cwd: params.cwd,
    sessionStore: params.sessionStore,
    timeoutMs: params.timeoutMs,
    agentRegistry: params.agentRegistry ?? {
      resolve(agentName: string) {
        return `${agentName} --acp`;
      },
      list() {
        return ["codex"];
      },
    },
    permissionMode: "approve-reads",
  };
}
