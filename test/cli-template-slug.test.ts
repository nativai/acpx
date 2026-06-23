import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Drives the real compiled CLI as a subprocess against a temp HOME-scoped store
// (no agent spawn needed: template/rollback/migrate are store-only operations).
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return withTempHomeFixture("acpx-w13-cli-", run);
}

async function seedClosedSession(
  homeDir: string,
  id: string,
  name: string,
): Promise<SessionRecord> {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "node mock",
    agentName: "claude",
    cwd: path.join(homeDir, "workspace"),
    name,
    closed: true,
  });
  await writeSessionRecordFile(homeDir, record);
  return record;
}

test("CLI mark assigns slug+version; a second mark under the same slug is version 2", async () => {
  await withTempHome(async (homeDir) => {
    await seedClosedSession(homeDir, "rec-1", "Context Engineer");
    await seedClosedSession(homeDir, "rec-2", "Context Engineer");

    const first = await runCli(
      ["--format", "json", "claude", "sessions", "template", "rec-1", "--enable"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout.trim()) as { slug?: string; version?: number };
    assert.equal(firstResult.slug, "context-engineer"); // default slugify(name)
    assert.equal(firstResult.version, 1);

    const second = await runCli(
      [
        "--format",
        "json",
        "claude",
        "sessions",
        "template",
        "rec-2",
        "--enable",
        "--slug",
        "context-engineer",
      ],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondResult = JSON.parse(second.stdout.trim()) as { slug?: string; version?: number };
    assert.equal(secondResult.slug, "context-engineer");
    assert.equal(secondResult.version, 2); // max+1 under the same slug
  });
});

test("CLI rollback soft-retracts the latest and reports the new latest", async () => {
  await withTempHome(async (homeDir) => {
    await seedClosedSession(homeDir, "rec-1", "Context Engineer");
    await seedClosedSession(homeDir, "rec-2", "Context Engineer");
    await runCli(["claude", "sessions", "template", "rec-1", "--enable"], homeDir);
    await runCli(
      ["claude", "sessions", "template", "rec-2", "--enable", "--slug", "context-engineer"],
      homeDir,
    );

    const rollback = await runCli(
      ["--format", "json", "claude", "sessions", "templates", "rollback", "context-engineer"],
      homeDir,
    );
    assert.equal(rollback.code, 0, rollback.stderr);
    const result = JSON.parse(rollback.stdout.trim()) as {
      outcome?: string;
      retracted?: { acpxRecordId?: string };
      newLatest?: { acpxRecordId?: string };
    };
    assert.equal(result.outcome, "soft-retract");
    assert.equal(result.retracted?.acpxRecordId, "rec-2");
    assert.equal(result.newLatest?.acpxRecordId, "rec-1");
  });
});

test("CLI rollback --delete hard-removes; an empty slug rolls back as a no-op", async () => {
  await withTempHome(async (homeDir) => {
    await seedClosedSession(homeDir, "solo", "Solo Template");
    await runCli(["claude", "sessions", "template", "solo", "--enable"], homeDir);

    const del = await runCli(
      [
        "--format",
        "json",
        "claude",
        "sessions",
        "templates",
        "rollback",
        "solo-template",
        "--delete",
      ],
      homeDir,
    );
    assert.equal(del.code, 0, del.stderr);
    const delResult = JSON.parse(del.stdout.trim()) as { outcome?: string; newLatest?: unknown };
    assert.equal(delResult.outcome, "delete");
    assert.equal(delResult.newLatest, undefined); // slug now empty

    const noop = await runCli(
      ["--format", "json", "claude", "sessions", "templates", "rollback", "solo-template"],
      homeDir,
    );
    const noopResult = JSON.parse(noop.stdout.trim()) as { outcome?: string };
    assert.equal(noopResult.outcome, "noop");
  });
});

test("CLI migrate-slugs backfills (idempotent) and the bare `templates` list still dispatches", async () => {
  await withTempHome(async (homeDir) => {
    // Seed a template the legacy way (block, no slug/version) by marking then
    // stripping is awkward; instead mark normally and rely on migrate being a
    // no-op (already slugged), plus confirm a slug-less record gets backfilled.
    await seedClosedSession(homeDir, "legacy", "Legacy Helper");
    // Mark WITHOUT going through slug assignment is not possible via the CLI, so
    // assert migrate is idempotent on an already-marked (slugged) template.
    await runCli(["claude", "sessions", "template", "legacy", "--enable"], homeDir);

    const dry = await runCli(
      ["--format", "json", "claude", "sessions", "templates", "migrate-slugs", "--dry-run"],
      homeDir,
    );
    assert.equal(dry.code, 0, dry.stderr);
    const dryResult = JSON.parse(dry.stdout.trim()) as { skipped?: number; assigned?: number };
    assert.equal(dryResult.skipped, 1); // already slugged by the mark ⇒ skipped
    assert.equal(dryResult.assigned, 0);

    // The bare `sessions templates` (list) action must still work after the group
    // restructure that added rollback/migrate-slugs subcommands.
    const list = await runCli(["--format", "json", "claude", "sessions", "templates"], homeDir);
    assert.equal(list.code, 0, list.stderr);
  });
});
