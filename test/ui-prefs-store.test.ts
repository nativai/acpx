import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultUiPrefsDbPath,
  isSqliteExperimentalWarning,
  openUiPrefsStore,
} from "../src/models/ui-prefs-store.js";

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-uiprefs-")), "ui-prefs.db");
}

test("path: ACPX_UI_PREFS_DB overrides, ACPX_STATE_HOME moves the whole .acpx tree", () => {
  const before = { db: process.env.ACPX_UI_PREFS_DB, home: process.env.ACPX_STATE_HOME };
  try {
    delete process.env.ACPX_UI_PREFS_DB;
    process.env.ACPX_STATE_HOME = "/tmp/acpx-state-probe";
    assert.equal(defaultUiPrefsDbPath(), "/tmp/acpx-state-probe/.acpx/ui-prefs.db");
    process.env.ACPX_UI_PREFS_DB = "/tmp/elsewhere/prefs.db";
    assert.equal(defaultUiPrefsDbPath(), "/tmp/elsewhere/prefs.db");
  } finally {
    process.env.ACPX_UI_PREFS_DB = before.db;
    process.env.ACPX_STATE_HOME = before.home;
    if (before.db === undefined) {
      delete process.env.ACPX_UI_PREFS_DB;
    }
    if (before.home === undefined) {
      delete process.env.ACPX_STATE_HOME;
    }
  }
});

test("open: creates the directory and the schema, and is safe to re-open", () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-uiprefs-")), "deep", "p.db");
  const first = openUiPrefsStore(dbPath);
  first.addFavorite("openrouter", "a/x");
  first.close();

  const second = openUiPrefsStore(dbPath);
  assert.equal(second.isFavorite("openrouter", "a/x"), true, "the star must survive a re-open");
  second.close();
});

test("star and unstar are IDEMPOTENT — a double-click never needs reconciling", () => {
  const store = openUiPrefsStore(tempDb());
  store.addFavorite("openrouter", "a/x");
  store.addFavorite("openrouter", "a/x");
  assert.equal(store.listFavorites().length, 1);
  store.removeFavorite("openrouter", "a/x");
  store.removeFavorite("openrouter", "a/x");
  assert.equal(store.listFavorites().length, 0);
  store.close();
});

test("a favorite is keyed by (source, id) — the same id under two sources is two stars", () => {
  const store = openUiPrefsStore(tempDb());
  store.addFavorite("claude-subscription", "opus", 1);
  store.addFavorite("openrouter", "anthropic/claude-opus-5", 2);
  assert.deepEqual(store.favoriteKeys(), [
    "openrouter:anthropic/claude-opus-5",
    "claude-subscription:opus",
  ]);
  // Unstarring one door leaves the other starred.
  store.removeFavorite("openrouter", "anthropic/claude-opus-5");
  assert.deepEqual(store.favoriteKeys(), ["claude-subscription:opus"]);
  store.close();
});

test("ordering is most-recently-starred first, computed in the store", () => {
  const store = openUiPrefsStore(tempDb());
  store.addFavorite("openrouter", "a/first", 1_000);
  store.addFavorite("openrouter", "a/second", 2_000);
  store.addFavorite("openrouter", "a/third", 3_000);
  assert.deepEqual(store.favoriteKeys(), [
    "openrouter:a/third",
    "openrouter:a/second",
    "openrouter:a/first",
  ]);
  assert.equal(store.listFavorites()[0]?.favoritedAt, new Date(3_000).toISOString());
  store.close();
});

test("last_used_model is one row per agent type, overwritten in place", () => {
  const store = openUiPrefsStore(tempDb());
  assert.equal(store.getLastUsedModel("claude"), undefined);
  store.setLastUsedModel("claude", "openrouter:a/x", 1_000);
  store.setLastUsedModel("claude", "claude-subscription:opus", 2_000);
  store.setLastUsedModel("codex", "chatgpt:gpt-5.6-sol", 3_000);
  assert.equal(store.getLastUsedModel("claude")?.modelKey, "claude-subscription:opus");
  assert.equal(store.getLastUsedModel("codex")?.modelKey, "chatgpt:gpt-5.6-sol");
  store.close();
});

/**
 * THE reason this store is a database (C4 §7.5, acceptance criterion §15.7).
 * Two independent processes writing a whole JSON document is a lost update by
 * construction — and the loss is silent. Here both writers are live at once and
 * each one's star must survive the other's.
 */
test("TWO WRITERS: stars written by two open connections compose, neither erases the other", () => {
  const dbPath = tempDb();
  const uiWriter = openUiPrefsStore(dbPath);
  const cliWriter = openUiPrefsStore(dbPath);

  uiWriter.addFavorite("openrouter", "from/the-ui", 1_000);
  cliWriter.addFavorite("openrouter", "from/the-cli", 2_000);

  assert.deepEqual(uiWriter.favoriteKeys(), ["openrouter:from/the-cli", "openrouter:from/the-ui"]);
  assert.deepEqual(cliWriter.favoriteKeys(), uiWriter.favoriteKeys());

  // And an unstar through one writer is a per-ROW delete, not a document rewrite.
  cliWriter.removeFavorite("openrouter", "from/the-cli");
  assert.deepEqual(uiWriter.favoriteKeys(), ["openrouter:from/the-ui"]);

  uiWriter.close();
  cliWriter.close();
});

test("TWO PROCESSES: a star written by a child process is visible to this one", () => {
  const dbPath = tempDb();
  const store = openUiPrefsStore(dbPath);
  store.addFavorite("openrouter", "from/this-process", 1_000);

  const script = `
    const { openUiPrefsStore } = await import(${JSON.stringify(
      path.resolve(process.cwd(), "dist-test/src/models/ui-prefs-store.js"),
    )});
    const s = openUiPrefsStore(${JSON.stringify(dbPath)});
    s.addFavorite("openrouter", "from/the-child", 2000);
    s.close();
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });

  assert.deepEqual(store.favoriteKeys(), [
    "openrouter:from/the-child",
    "openrouter:from/this-process",
  ]);
  store.close();
});

// ── The ExperimentalWarning suppression, and its positive control ────────────

test("the warning filter matches ONLY node:sqlite's ExperimentalWarning", () => {
  assert.equal(
    isSqliteExperimentalWarning(
      Object.assign(new Error("SQLite is an experimental feature"), {
        name: "ExperimentalWarning",
      }),
      [],
    ),
    true,
  );
  // A different experimental warning is NOT ours to silence.
  assert.equal(
    isSqliteExperimentalWarning(
      Object.assign(new Error("Fetch API is an experimental feature"), {
        name: "ExperimentalWarning",
      }),
      [],
    ),
    false,
  );
  // Neither is a deprecation, however it is phrased.
  assert.equal(
    isSqliteExperimentalWarning(
      Object.assign(new Error("SQLite thing is deprecated"), { name: "DeprecationWarning" }),
      [],
    ),
    false,
  );
  // The string form carries the name as the second argument.
  assert.equal(
    isSqliteExperimentalWarning("SQLite is experimental", ["ExperimentalWarning"]),
    true,
  );
});

/**
 * The half that matters: opening the store must not print node:sqlite's
 * ExperimentalWarning — AND an unrelated warning emitted afterwards must still
 * reach stderr. The second assertion is the positive control; without it this
 * test passes just as well against a blanket `--no-warnings`, which is exactly
 * the fix that must not be taken.
 */
test("opening the store is stderr-clean, and does NOT silence other warnings", () => {
  const dbPath = tempDb();
  const script = `
    const { openUiPrefsStore } = await import(${JSON.stringify(
      path.resolve(process.cwd(), "dist-test/src/models/ui-prefs-store.js"),
    )});
    const store = openUiPrefsStore(${JSON.stringify(dbPath)});
    store.addFavorite("openrouter", "a/x");
    store.close();
    process.emitWarning("a canary that must survive", "ExperimentalWarning");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(
    run.stderr.includes("SQLite is an experimental feature"),
    false,
    `node:sqlite's warning leaked to stderr: ${run.stderr}`,
  );
  assert.ok(
    run.stderr.includes("a canary that must survive"),
    `the canary was swallowed — this suppression is too broad: ${run.stderr}`,
  );
});

test("last-used: the whole map is readable, and is EMPTY rather than an error when unset", () => {
  const store = openUiPrefsStore(tempDb());
  assert.deepEqual(store.listLastUsedModels(), []);
  store.setLastUsedModel("codex", "chatgpt:gpt-5.6-sol", 2_000);
  store.setLastUsedModel("claude", "openrouter:a/x", 1_000);
  assert.deepEqual(
    store.listLastUsedModels().map((entry) => [entry.agentType, entry.modelKey]),
    [
      ["claude", "openrouter:a/x"],
      ["codex", "chatgpt:gpt-5.6-sol"],
    ],
  );
  store.close();
});
