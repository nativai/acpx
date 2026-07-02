import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BRICK_CONTEXT_MAX_BYTES, resolveBrickContext } from "../src/acp/brick-context.js";
import {
  DEFAULT_BRICK_POOL_DIR,
  brickPoolDir,
  isBrickUuid,
  maybeStampBrickLink,
  resolveBrickFlagRef,
  resolveExistingBrickPath,
  stampBrickSessionStarted,
} from "../src/cli/session/brick-link.js";
import type { SessionRecord } from "../src/types.js";

const SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");
const NODE_DIR = path.dirname(process.execPath);
const X = "11111111-2222-3333-4444-555555555555";
const Y = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type EnvPatch = Record<string, string | undefined>;

async function withEnv(patch: EnvPatch, run: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readLog(logPath: string): Promise<string[][]> {
  const raw = await fs.readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

test("isBrickUuid accepts full uuid shape only", () => {
  assert.equal(isBrickUuid(X), true);
  assert.equal(isBrickUuid(X.toUpperCase()), true);
  assert.equal(isBrickUuid("11111111"), false);
  assert.equal(isBrickUuid("slug"), false);
  assert.equal(isBrickUuid("zzzzzzzz-2222-3333-4444-555555555555"), false);
});

test("resolveBrickFlagRef resolves through the shim and stores the returned uuid", async () => {
  await withTempDir("acpx-brick-log-", async (dir) => {
    const log = path.join(dir, "brick.log");
    await withEnv(
      {
        PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_ID: X,
        BRICK_SHIM_LOG: log,
      },
      async () => {
        assert.equal(await resolveBrickFlagRef("myslug"), X);
        assert.deepEqual(await readLog(log), [["show", "myslug", "--json"]]);
      },
    );
  });
});

test("resolveBrickFlagRef refuses definitive not-found and ambiguous responses", async () => {
  await withEnv(
    { PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "not-found" },
    async () => {
      await assert.rejects(() => resolveBrickFlagRef("nope"), /unknown brick: nope/);
    },
  );
  await withEnv(
    { PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "ambiguous" },
    async () => {
      await assert.rejects(() => resolveBrickFlagRef("dup"), /ambiguous: dup/);
    },
  );
});

test("resolveBrickFlagRef degrades to full-uuid only when the CLI is unavailable", async () => {
  await withTempDir("acpx-empty-path-", async (dir) => {
    await withEnv({ PATH: `${dir}:${NODE_DIR}`, BRICK_SHIM_MODE: undefined }, async () => {
      assert.equal(await resolveBrickFlagRef(Y.toUpperCase()), Y);
      await assert.rejects(() => resolveBrickFlagRef("slug"), /non-uuid refs need the brick CLI/);
    });
  });
});

test("resolveBrickFlagRef treats garbage, hanging, and non-uuid show output as unavailable", async () => {
  await withEnv(
    { PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "garbage" },
    async () => {
      assert.equal(await resolveBrickFlagRef(X), X);
      await assert.rejects(() => resolveBrickFlagRef("slug"), /non-uuid refs need the brick CLI/);
    },
  );

  await withEnv(
    {
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: "../../evil-path",
    },
    async () => {
      assert.equal(await resolveBrickFlagRef(X), X);
      await assert.rejects(() => resolveBrickFlagRef("slug"), /non-uuid refs need the brick CLI/);
    },
  );

  await withEnv(
    { PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "hang" },
    async () => {
      const started = Date.now();
      assert.equal(await resolveBrickFlagRef(X, { timeoutMs: 25 }), X);
      await assert.rejects(
        () => resolveBrickFlagRef("slug", { timeoutMs: 25 }),
        /non-uuid refs need the brick CLI/,
      );
      assert(Date.now() - started < 1_000);
    },
  );
});

test("resolveExistingBrickPath is a pure uuid join plus directory stat", async () => {
  await withTempDir("acpx-brick-pool-", async (pool) => {
    await fs.mkdir(path.join(pool, X));
    await fs.writeFile(path.join(pool, Y), "not a dir");
    await withEnv({ ACPX_BRICK_POOL_DIR: pool }, () => {
      assert.equal(resolveExistingBrickPath(X), path.join(pool, X));
      assert.equal(resolveExistingBrickPath(Y), null);
      assert.equal(resolveExistingBrickPath("11111111"), null);
      assert.equal(resolveExistingBrickPath("../../etc/passwd"), null);
    });
  });
  await withEnv({ ACPX_BRICK_POOL_DIR: undefined }, () => {
    assert.equal(brickPoolDir(), DEFAULT_BRICK_POOL_DIR);
  });
});

test("stamp helpers call brick stamp only for usable brick ids and never throw", async () => {
  await withTempDir("acpx-brick-log-", async (dir) => {
    const log = path.join(dir, "brick.log");
    await withEnv(
      { PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "ok", BRICK_SHIM_LOG: log },
      async () => {
        await stampBrickSessionStarted(X, "rec-1");
        await maybeStampBrickLink({
          acpxRecordId: "rec-2",
          metadata: { brick: X },
        } as unknown as SessionRecord);
        await maybeStampBrickLink({
          acpxRecordId: "rec-3",
          metadata: { brick: "garbage" },
        } as unknown as SessionRecord);
        assert.deepEqual(await readLog(log), [
          ["stamp", X, "session-started", "--by", "session:rec-1"],
          ["stamp", X, "session-started", "--by", "session:rec-2"],
        ]);
      },
    );
  });

  await withTempDir("acpx-empty-path-", async (dir) => {
    await withEnv({ PATH: `${dir}:${NODE_DIR}` }, async () => {
      await stampBrickSessionStarted(X, "rec-1");
    });
  });
});

test("resolveBrickContext resolves, degrades, uuid-gates, and truncates with a CONTENT.md footer", async () => {
  await withTempDir("acpx-brick-context-", async (dir) => {
    const log = path.join(dir, "brick.log");
    await withEnv(
      {
        PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_LOG: log,
        BRICK_SHIM_CONTEXT: "context block",
      },
      async () => {
        assert.equal(await resolveBrickContext(X), "context block");
        assert.equal(await resolveBrickContext("not-a-uuid"), undefined);
        assert.deepEqual(await readLog(log), [["context", X, "--format", "inject"]]);
      },
    );

    await withEnv(
      {
        PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_CONTEXT_MODE: "crash",
      },
      async () => {
        assert.equal(await resolveBrickContext(X), undefined);
      },
    );

    const payload = `${"a".repeat(BRICK_CONTEXT_MAX_BYTES - 1)}🙂tail`;
    const payloadFile = path.join(dir, "payload.txt");
    const pool = path.join(dir, "pool");
    await fs.writeFile(payloadFile, payload, "utf8");
    await withEnv(
      {
        PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_CONTEXT_MODE: undefined,
        BRICK_SHIM_CONTEXT_FILE: payloadFile,
        ACPX_BRICK_POOL_DIR: pool,
      },
      async () => {
        const out = await resolveBrickContext(X);
        assert.equal(typeof out, "string");
        assert.match(out ?? "", /brick context truncated at 32 KiB/);
        assert.match(out ?? "", new RegExp(`${X}/CONTENT\\.md`));
        assert.equal((out ?? "").includes("�"), false);
      },
    );
  });
});
