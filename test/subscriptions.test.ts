import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findSubscription,
  loadSubscriptionRegistry,
  resolveSubscriptionConfigDir,
} from "../src/config/subscriptions.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-subs-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("loadSubscriptionRegistry parses entries and default, applying configDir defaults", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = path.join(homeDir, "registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        default: "sub2",
        subscriptions: [
          { id: "sub1", label: "One", configDir: "/custom/sub1" },
          { id: "sub2", label: "Two" }, // configDir omitted -> default
        ],
      }),
    );

    const registry = loadSubscriptionRegistry({ homeDir, registryPath });
    assert.equal(registry.default, "sub2");
    assert.deepEqual(registry.subscriptions, [
      { id: "sub1", label: "One", configDir: "/custom/sub1" },
      { id: "sub2", label: "Two", configDir: path.join(homeDir, ".acpx", "subscriptions", "sub2") },
    ]);
  });
});

test("resolveSubscriptionConfigDir returns configDir for known id, undefined for unknown", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = path.join(homeDir, "registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        default: "sub1",
        subscriptions: [{ id: "sub1", label: "One", configDir: "/custom/sub1" }],
      }),
    );

    assert.equal(resolveSubscriptionConfigDir("sub1", { homeDir, registryPath }), "/custom/sub1");
    assert.equal(resolveSubscriptionConfigDir("nope", { homeDir, registryPath }), undefined);
  });
});

test("loadSubscriptionRegistry returns empty registry when file is missing or malformed", async () => {
  await withTempDir(async (homeDir) => {
    const missing = loadSubscriptionRegistry({
      homeDir,
      registryPath: path.join(homeDir, "absent.json"),
    });
    assert.deepEqual(missing, { subscriptions: [] });

    const malformedPath = path.join(homeDir, "bad.json");
    await fs.writeFile(malformedPath, "{ not json");
    const malformed = loadSubscriptionRegistry({ homeDir, registryPath: malformedPath });
    assert.deepEqual(malformed, { subscriptions: [] });
  });
});

test("loadSubscriptionRegistry drops invalid entries and duplicate ids", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = path.join(homeDir, "registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        subscriptions: [
          { id: "sub1", label: "One", configDir: "/a" },
          { id: "", label: "blank-id" }, // dropped: empty id
          { label: "no-id" }, // dropped: missing id
          { id: "sub1", label: "Dup", configDir: "/b" }, // dropped: duplicate id
        ],
      }),
    );

    const registry = loadSubscriptionRegistry({ homeDir, registryPath });
    assert.equal(registry.subscriptions.length, 1);
    assert.equal(findSubscription("sub1", registry)?.configDir, "/a");
  });
});
