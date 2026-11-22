import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atriumDbDirFor,
  loadWakeupLiveness,
  wakeupsDbPathFor,
} from "../src/session/archive/liveness.js";
import { removeTempHome } from "./temp-home.js";

// brick 6b93b95e (atrium S6): the archive-liveness reader of `wakeups.db` honours the database
// directory — ACPX_UI_DB_DIR, else the `dir` of `<root>/.db-dir.json`, else `<root>` (today) — opens it
// read-only and NEVER creates it (a stray file of a registered name at the old place is set aside by atrium).

type Db = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
  close: () => void;
};

function makeWakeupsDb(dir: string, sessionId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wakeups.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string) => Db;
  };
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE wakeups (callback_url TEXT, status TEXT)");
  db.prepare("INSERT INTO wakeups (callback_url, status) VALUES (?, ?)").run(
    `http://x/api/sessions/${sessionId}/message`,
    "pending",
  );
  db.close();
  return file;
}

async function withRoot<T>(
  run: (root: string, hotDir: string) => Promise<T>,
  envDir?: (root: string) => string,
): Promise<T> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dbdir-")));
  const hotDir = path.join(root, "sessions");
  fs.mkdirSync(hotDir, { recursive: true });
  const saved = process.env.ACPX_UI_DB_DIR;
  delete process.env.ACPX_UI_DB_DIR;
  if (envDir) {
    process.env.ACPX_UI_DB_DIR = envDir(root);
  }
  try {
    return await run(root, hotDir);
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_UI_DB_DIR;
    } else {
      process.env.ACPX_UI_DB_DIR = saved;
    }
    await removeTempHome(root);
  }
}

function idsOf(result: Awaited<ReturnType<typeof loadWakeupLiveness>>): string[] {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.status === "ok" ? [...result.ids] : [];
}

test("neither set (today): the database is `<root>/wakeups.db`", async () => {
  await withRoot(async (root, hotDir) => {
    makeWakeupsDb(root, "in-root");
    assert.equal(wakeupsDbPathFor(hotDir), path.join(root, "wakeups.db"));
    assert.deepEqual(idsOf(await loadWakeupLiveness(hotDir)), ["in-root"]);
  });
});

test("ACPX_UI_DB_DIR set: that directory is read, not the root's (a decoy at the old place is ignored)", async () => {
  await withRoot(
    async (root, hotDir) => {
      makeWakeupsDb(root, "decoy-at-old-place");
      makeWakeupsDb(path.join(root, "elsewhere"), "in-env-dir");
      assert.deepEqual(idsOf(await loadWakeupLiveness(hotDir)), ["in-env-dir"]);
    },
    (root) => path.join(root, "elsewhere"),
  );
});

test("pointer only: the `dir` of `.db-dir.json` is read, not the root's", async () => {
  await withRoot(async (root, hotDir) => {
    makeWakeupsDb(root, "decoy-at-old-place");
    const target = path.join(root, "db-home");
    makeWakeupsDb(target, "in-pointer-dir");
    fs.writeFileSync(path.join(root, ".db-dir.json"), JSON.stringify({ dir: target }));
    assert.equal(atriumDbDirFor(hotDir), target);
    assert.deepEqual(idsOf(await loadWakeupLiveness(hotDir)), ["in-pointer-dir"]);
  });
});

test("order: ACPX_UI_DB_DIR beats the pointer", async () => {
  await withRoot(
    async (root, hotDir) => {
      makeWakeupsDb(path.join(root, "from-pointer"), "pointer-loses");
      makeWakeupsDb(path.join(root, "from-env"), "env-wins");
      fs.writeFileSync(
        path.join(root, ".db-dir.json"),
        JSON.stringify({ dir: path.join(root, "from-pointer") }),
      );
      assert.deepEqual(idsOf(await loadWakeupLiveness(hotDir)), ["env-wins"]);
    },
    (root) => path.join(root, "from-env"),
  );
});

test("NEGATIVE: no file is created at the old place — env set, pointer set, or nothing anywhere", async () => {
  await withRoot(
    async (root, hotDir) => {
      assert.deepEqual(await loadWakeupLiveness(hotDir), { status: "absent" });
      assert.equal(fs.existsSync(path.join(root, "wakeups.db")), false, "env set, db absent");
    },
    (root) => path.join(root, "elsewhere"),
  );
  await withRoot(async (root, hotDir) => {
    fs.writeFileSync(
      path.join(root, ".db-dir.json"),
      JSON.stringify({ dir: path.join(root, "gone") }),
    );
    assert.deepEqual(await loadWakeupLiveness(hotDir), { status: "absent" });
    assert.equal(fs.existsSync(path.join(root, "wakeups.db")), false, "pointer set, db absent");
    assert.equal(
      fs.existsSync(path.join(root, "gone")),
      false,
      "the target directory is not created either",
    );
  });
  await withRoot(async (root, hotDir) => {
    assert.deepEqual(await loadWakeupLiveness(hotDir), { status: "absent" });
    assert.equal(fs.existsSync(path.join(root, "wakeups.db")), false, "neither, db absent");
  });
});

test("NEGATIVE: a pointer that is unparsable, empty, or names a relative directory is no pointer — today's place", async () => {
  await withRoot(async (root, hotDir) => {
    for (const body of [
      "{not json",
      JSON.stringify({}),
      JSON.stringify({ dir: "" }),
      JSON.stringify({ dir: "relative/dir" }),
    ]) {
      fs.writeFileSync(path.join(root, ".db-dir.json"), body);
      assert.equal(atriumDbDirFor(hotDir), root, body);
    }
  });
});
