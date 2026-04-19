/**
 * One-shot cleanup for orphaned ("ghost") ACPX session JSONs.
 *
 * Ghost sessions are empty JSON records created by
 *   `acpx claude sessions ensure --name X`
 * or
 *   `acpx claude sessions new --name X`
 * when no subsequent `prompt -s X "..."` ever ran. They clutter the
 * session list in the UI but carry no real conversation data.
 *
 * Deletion criteria (ALL must match):
 *   - `last_seq` is 0 or missing
 *   - `messages` array is empty or missing
 *   - matching `<id>.stream.ndjson` is missing OR 0 bytes
 *   - `last_write_at` (inside `event_log`) is null/missing
 *   - `last_prompt_at` is null/missing
 *
 * Note: `closed` is deliberately NOT a protection by itself. Users
 * routinely close ghost sessions from the UI because they look useless;
 * those closed-but-empty records are exactly what we want to clean up.
 * A closed session with real data (`last_seq > 0` or `messages.length > 0`)
 * is still kept because the other criteria catch it.
 *
 * Index pruning: the acpx-ui server reads sessions from `index.json`
 * (the registry), not by scanning the directory. So deleting the JSON
 * files alone isn't enough — the UI keeps showing phantoms. In --apply
 * mode, this script also rewrites `index.json` to remove the entries
 * for deleted sessions (atomic via tmp + rename).
 *
 * Critical: some sessions have empty `messages` arrays in the JSON but
 * REAL conversation data in their NDJSON stream file. Those are a
 * separate bug (NDJSON reconciliation failure) and must NOT be touched.
 * The stream-file-size check protects them.
 *
 * Usage (from the repo root):
 *   pnpm exec tsx scripts/cleanup-ghost-sessions.ts            # dry run (default)
 *   pnpm exec tsx scripts/cleanup-ghost-sessions.ts --apply    # actually delete
 *   pnpm exec tsx scripts/cleanup-ghost-sessions.ts --dir <p>  # override sessions dir
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SessionJson = {
  schema?: string;
  acpx_record_id?: string;
  acp_session_id?: string;
  name?: string;
  last_seq?: number;
  last_prompt_at?: string | null;
  last_used_at?: string | null;
  closed?: boolean;
  messages?: unknown[];
  event_log?: {
    active_path?: string;
    last_write_at?: string | null;
    last_write_error?: unknown;
  };
};

type StreamStatus = "missing" | "empty" | "nonempty";

type Candidate = {
  filename: string;
  id: string;
  name: string | undefined;
  acpxRecordId: string | undefined;
  lastSeq: number;
  streamStatus: StreamStatus;
  streamSize: number;
  streamPath: string;
  lockPath: string;
  hasLock: boolean;
  jsonPath: string;
};

type SkipReason =
  | "not-a-session-json"
  | "parse-error"
  | "has-messages"
  | "has-last-seq"
  | "has-last-prompt-at"
  | "has-last-write-at"
  | "stream-has-data";

type SkipEntry = {
  filename: string;
  reason: SkipReason;
  detail?: string;
};

type Args = {
  apply: boolean;
  dir: string;
};

function parseArgs(argv: string[]): Args {
  let apply = false;
  let dir = path.join(os.homedir(), ".acpx", "sessions");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dir") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--dir requires a path argument");
      }
      dir = next;
      i++;
    } else if (arg === "-h" || arg === "--help") {
      // eslint-disable-next-line no-console
      console.log(
        [
          "Usage: pnpm exec tsx scripts/cleanup-ghost-sessions.ts [--apply] [--dir <path>]",
          "",
          "Default behavior is DRY RUN (no filesystem changes). Pass --apply to delete.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, dir };
}

function isSessionJsonFilename(filename: string): boolean {
  if (!filename.endsWith(".json")) {
    return false;
  }
  if (filename === "index.json") {
    return false;
  }
  // Full session JSON files are "<uuid>.json" (no nested ".stream." etc.)
  const base = filename.slice(0, -".json".length);
  if (base.includes(".")) {
    return false;
  }
  return true;
}

function statSize(p: string): number | null {
  try {
    const s = fs.statSync(p);
    return s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function classifyStream(streamPath: string): { status: StreamStatus; size: number } {
  const size = statSize(streamPath);
  if (size === null) {
    return { status: "missing", size: 0 };
  }
  if (size === 0) {
    return { status: "empty", size: 0 };
  }
  return { status: "nonempty", size };
}

function isGhost(session: SessionJson): { ghost: true } | { ghost: false; reason: SkipReason } {
  // Intentionally NOT treating `closed: true` as a protection: users
  // routinely close ghost sessions from the UI because they look useless.
  // Real closed conversations are still protected by the other checks
  // (non-empty messages, last_seq > 0, non-empty stream).
  if (Array.isArray(session.messages) && session.messages.length > 0) {
    return { ghost: false, reason: "has-messages" };
  }
  if (typeof session.last_seq === "number" && session.last_seq > 0) {
    return { ghost: false, reason: "has-last-seq" };
  }
  if (session.last_prompt_at != null) {
    return { ghost: false, reason: "has-last-prompt-at" };
  }
  const lastWriteAt = session.event_log?.last_write_at;
  if (lastWriteAt != null) {
    return { ghost: false, reason: "has-last-write-at" };
  }
  return { ghost: true };
}

function formatSkipReason(reason: SkipReason): string {
  switch (reason) {
    case "not-a-session-json":
      return "not a session JSON file";
    case "parse-error":
      return "failed to parse JSON";
    case "has-messages":
      return "session has non-empty messages array";
    case "has-last-seq":
      return "session has last_seq > 0";
    case "has-last-prompt-at":
      return "session has last_prompt_at set";
    case "has-last-write-at":
      return "session event_log has last_write_at set";
    case "stream-has-data":
      return "stream file has data (protected: possibly NDJSON reconciliation bug)";
  }
}

function tryUnlink(p: string, apply: boolean): { attempted: boolean; ok: boolean; error?: string } {
  if (!fs.existsSync(p)) {
    return { attempted: false, ok: true };
  }
  if (!apply) {
    return { attempted: true, ok: true };
  }
  try {
    fs.unlinkSync(p);
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, error: (err as Error).message };
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    // eslint-disable-next-line no-console
    console.error(`Sessions directory not found: ${dir}`);
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log(`ACPX ghost-session cleanup`);
  // eslint-disable-next-line no-console
  console.log(`Mode:      ${args.apply ? "APPLY (will delete)" : "DRY RUN (no changes)"}`);
  // eslint-disable-next-line no-console
  console.log(`Directory: ${dir}`);
  // eslint-disable-next-line no-console
  console.log("");

  const entries = fs.readdirSync(dir);
  const candidates: Candidate[] = [];
  const skipped: SkipEntry[] = [];
  let scanned = 0;

  for (const filename of entries) {
    if (!isSessionJsonFilename(filename)) {
      continue;
    }
    scanned++;

    const jsonPath = path.join(dir, filename);
    let session: SessionJson;
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      session = JSON.parse(raw) as SessionJson;
    } catch (err) {
      skipped.push({
        filename,
        reason: "parse-error",
        detail: (err as Error).message,
      });
      continue;
    }

    // Must at least look like an acpx session record.
    if (session.schema !== "acpx.session.v1") {
      skipped.push({
        filename,
        reason: "not-a-session-json",
        detail: `schema=${session.schema ?? "<none>"}`,
      });
      continue;
    }

    const id = filename.slice(0, -".json".length);
    const streamPath = path.join(dir, `${id}.stream.ndjson`);
    const lockPath = path.join(dir, `${id}.stream.lock`);
    const { status: streamStatus, size: streamSize } = classifyStream(streamPath);

    const ghostCheck = isGhost(session);
    if (!ghostCheck.ghost) {
      skipped.push({ filename, reason: ghostCheck.reason });
      continue;
    }

    // Stream-file protection: non-empty stream overrides every other signal.
    if (streamStatus === "nonempty") {
      skipped.push({
        filename,
        reason: "stream-has-data",
        detail: `name=${session.name ?? "<unnamed>"}, stream=${streamSize} bytes`,
      });
      continue;
    }

    const hasLock = fs.existsSync(lockPath);
    candidates.push({
      filename,
      id,
      name: session.name,
      acpxRecordId: session.acpx_record_id,
      lastSeq: typeof session.last_seq === "number" ? session.last_seq : 0,
      streamStatus,
      streamSize,
      streamPath,
      lockPath,
      hasLock,
      jsonPath,
    });
  }

  // Print matched candidates.
  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No ghost sessions found.");
  } else {
    // eslint-disable-next-line no-console
    console.log(`Matched ${candidates.length} ghost session(s):`);
    // eslint-disable-next-line no-console
    console.log("");
    for (const c of candidates) {
      const streamLabel = c.streamStatus === "missing" ? "missing" : `empty (0 bytes)`;
      // eslint-disable-next-line no-console
      console.log(
        [
          `  - id:              ${c.id}`,
          `    name:            ${c.name ?? "<unnamed>"}`,
          `    acpx_record_id:  ${c.acpxRecordId ?? "<none>"}`,
          `    last_seq:        ${c.lastSeq}`,
          `    stream file:     ${streamLabel}`,
          `    lock file:       ${c.hasLock ? "present" : "absent"}`,
        ].join("\n"),
      );
      // eslint-disable-next-line no-console
      console.log("");
    }
  }

  // Summary of skips by reason.
  const skipCounts = new Map<SkipReason, number>();
  for (const s of skipped) {
    skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
  }

  // eslint-disable-next-line no-console
  console.log("Summary:");
  // eslint-disable-next-line no-console
  console.log(`  Scanned:  ${scanned} session JSON file(s)`);
  // eslint-disable-next-line no-console
  console.log(`  Matched:  ${candidates.length}`);
  // eslint-disable-next-line no-console
  console.log(`  Skipped:  ${skipped.length}`);
  if (skipCounts.size > 0) {
    // eslint-disable-next-line no-console
    console.log("  Skip reasons:");
    for (const [reason, count] of skipCounts) {
      // eslint-disable-next-line no-console
      console.log(`    - ${reason} (${formatSkipReason(reason)}): ${count}`);
    }
  }

  // List the "stream-has-data" skips explicitly — those are the
  // protected NDJSON-reconciliation-bug sessions and Daniel wants to
  // see them at a glance.
  const protectedSkips = skipped.filter((s) => s.reason === "stream-has-data");
  if (protectedSkips.length > 0) {
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log(`Protected (empty messages[] but non-empty stream — NDJSON reconciliation bug):`);
    for (const s of protectedSkips) {
      // eslint-disable-next-line no-console
      console.log(`  - ${s.filename}  ${s.detail ?? ""}`);
    }
  }

  // Execute deletions when --apply.
  if (args.apply && candidates.length > 0) {
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Deleting...");
    let deletedJson = 0;
    let deletedStreams = 0;
    let deletedLocks = 0;
    const failures: { path: string; error: string }[] = [];

    for (const c of candidates) {
      // Re-verify stream is still 0-byte-or-missing immediately before
      // deletion, in case something wrote to it between scan and apply.
      const recheck = classifyStream(c.streamPath);
      if (recheck.status === "nonempty") {
        failures.push({
          path: c.streamPath,
          error: `stream file grew to ${recheck.size} bytes between scan and apply — SKIPPED`,
        });
        continue;
      }

      const jsonRes = tryUnlink(c.jsonPath, true);
      if (jsonRes.attempted && jsonRes.ok) {
        deletedJson++;
      }
      if (jsonRes.attempted && !jsonRes.ok) {
        failures.push({ path: c.jsonPath, error: jsonRes.error ?? "unknown" });
      }

      const streamRes = tryUnlink(c.streamPath, true);
      if (streamRes.attempted && streamRes.ok) {
        deletedStreams++;
      }
      if (streamRes.attempted && !streamRes.ok) {
        failures.push({ path: c.streamPath, error: streamRes.error ?? "unknown" });
      }

      const lockRes = tryUnlink(c.lockPath, true);
      if (lockRes.attempted && lockRes.ok) {
        deletedLocks++;
      }
      if (lockRes.attempted && !lockRes.ok) {
        failures.push({ path: c.lockPath, error: lockRes.error ?? "unknown" });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`  JSON files deleted:   ${deletedJson}`);
    // eslint-disable-next-line no-console
    console.log(`  Stream files deleted: ${deletedStreams}`);
    // eslint-disable-next-line no-console
    console.log(`  Lock files deleted:   ${deletedLocks}`);

    // Prune index.json so the UI stops listing the deleted sessions.
    // The server's GET /api/sessions iterates `index.entries`; a session
    // whose JSON is gone but whose entry remains will still appear in the
    // sidebar (as an `awaiting_input` phantom).
    const indexPath = path.join(dir, "index.json");
    const deletedFilenames = new Set(candidates.map((c) => c.filename));
    if (fs.existsSync(indexPath) && deletedFilenames.size > 0) {
      try {
        const raw = fs.readFileSync(indexPath, "utf8");
        const indexData = JSON.parse(raw) as {
          schema?: string;
          files?: string[];
          entries?: { file?: string }[];
        };
        const beforeFiles = indexData.files?.length ?? 0;
        const beforeEntries = indexData.entries?.length ?? 0;
        if (Array.isArray(indexData.files)) {
          indexData.files = indexData.files.filter((f) => !deletedFilenames.has(f));
        }
        if (Array.isArray(indexData.entries)) {
          indexData.entries = indexData.entries.filter(
            (e) => typeof e.file !== "string" || !deletedFilenames.has(e.file),
          );
        }
        const afterFiles = indexData.files?.length ?? 0;
        const afterEntries = indexData.entries?.length ?? 0;
        const tmpPath = `${indexPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2), "utf8");
        fs.renameSync(tmpPath, indexPath);
        // eslint-disable-next-line no-console
        console.log(
          `  index.json pruned:    files ${beforeFiles} -> ${afterFiles}, entries ${beforeEntries} -> ${afterEntries}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`  index.json prune FAILED: ${(err as Error).message}`);
        failures.push({ path: indexPath, error: (err as Error).message });
      }
    }

    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`  Failures:             ${failures.length}`);
      for (const f of failures) {
        // eslint-disable-next-line no-console
        console.log(`    - ${f.path}: ${f.error}`);
      }
      process.exitCode = 1;
    }
  } else if (!args.apply && candidates.length > 0) {
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("DRY RUN — no files were modified. Re-run with --apply to delete.");
  }
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`cleanup-ghost-sessions failed: ${(err as Error).message}`);
  process.exit(2);
}
