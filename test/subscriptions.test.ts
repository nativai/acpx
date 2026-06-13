import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chooseSubscriptionConfigDir,
  findSubscription,
  loadSubscriptionRegistry,
  resolveSubscriptionConfigDir,
} from "../src/config/subscriptions.js";
import type { SubscriptionRegistry } from "../src/config/subscriptions.js";

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
      { id: "sub1", label: "One", configDir: "/custom/sub1", account: "sub1" },
      {
        id: "sub2",
        label: "Two",
        configDir: path.join(homeDir, ".acpx", "subscriptions", "sub2"),
        account: "sub2",
      },
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

// --- chooseSubscriptionConfigDir: the PURE resolver (explicit → default → none) ---
// dirExists is stubbed so these are fully deterministic and host-independent.

const RESOLVER_EXISTING_DIRS = new Set(["/cfg/sub1", "/cfg/sub2"]);
const resolverDirExists = (dir: string): boolean => RESOLVER_EXISTING_DIRS.has(dir);

function resolverRegistry(overrides: Partial<SubscriptionRegistry> = {}): SubscriptionRegistry {
  return {
    subscriptions: [
      { id: "sub1", label: "One", configDir: "/cfg/sub1", account: "sub1" },
      { id: "sub2", label: "Two", configDir: "/cfg/sub2", account: "sub2" },
      { id: "subGone", label: "Gone", configDir: "/cfg/gone", account: "subGone" }, // configDir never "exists"
    ],
    ...overrides,
  };
}

test("chooseSubscriptionConfigDir: explicit valid wins (even when a valid default exists)", () => {
  const choice = chooseSubscriptionConfigDir(
    "sub1",
    resolverRegistry({ default: "sub2" }),
    resolverDirExists,
  );
  assert.deepEqual(choice, { configDir: "/cfg/sub1", source: "explicit" });
});

test("chooseSubscriptionConfigDir: explicit unknown, no default → no configDir, explicitRejection:unknown", () => {
  const choice = chooseSubscriptionConfigDir("nope", resolverRegistry(), resolverDirExists);
  assert.deepEqual(choice, { explicitRejection: { kind: "unknown", id: "nope" } });
});

test("chooseSubscriptionConfigDir: explicit unknown, default valid → default dir, source:default, carries explicitRejection:unknown", () => {
  const choice = chooseSubscriptionConfigDir(
    "nope",
    resolverRegistry({ default: "sub2" }),
    resolverDirExists,
  );
  assert.deepEqual(choice, {
    configDir: "/cfg/sub2",
    source: "default",
    explicitRejection: { kind: "unknown", id: "nope" },
  });
});

test("chooseSubscriptionConfigDir: explicit missing-dir, default valid → default dir, carries explicitRejection:missing-dir", () => {
  const choice = chooseSubscriptionConfigDir(
    "subGone",
    resolverRegistry({ default: "sub2" }),
    resolverDirExists,
  );
  assert.deepEqual(choice, {
    configDir: "/cfg/sub2",
    source: "default",
    explicitRejection: { kind: "missing-dir", id: "subGone", configDir: "/cfg/gone" },
  });
});

test("chooseSubscriptionConfigDir: unselected, default valid → default dir, source:default (no rejection)", () => {
  const expected = { configDir: "/cfg/sub2", source: "default" };
  assert.deepEqual(
    chooseSubscriptionConfigDir(null, resolverRegistry({ default: "sub2" }), resolverDirExists),
    expected,
  );
  assert.deepEqual(
    chooseSubscriptionConfigDir(
      undefined,
      resolverRegistry({ default: "sub2" }),
      resolverDirExists,
    ),
    expected,
  );
  // whitespace-only explicit id is treated as unselected (trimmed away)
  assert.deepEqual(
    chooseSubscriptionConfigDir("   ", resolverRegistry({ default: "sub2" }), resolverDirExists),
    expected,
  );
});

test("chooseSubscriptionConfigDir: unselected, no default → empty choice (no configDir, no rejection)", () => {
  assert.deepEqual(chooseSubscriptionConfigDir(null, resolverRegistry(), resolverDirExists), {});
});

test("chooseSubscriptionConfigDir: unselected, default set but id not registered → defaultUnusable:unknown", () => {
  const choice = chooseSubscriptionConfigDir(
    null,
    resolverRegistry({ default: "ghost" }),
    resolverDirExists,
  );
  assert.deepEqual(choice, { defaultUnusable: { kind: "unknown", id: "ghost" } });
});

test("chooseSubscriptionConfigDir: unselected, default set but dir missing → defaultUnusable:missing-dir", () => {
  const choice = chooseSubscriptionConfigDir(
    null,
    resolverRegistry({ default: "subGone" }),
    resolverDirExists,
  );
  assert.deepEqual(choice, {
    defaultUnusable: { kind: "missing-dir", id: "subGone", configDir: "/cfg/gone" },
  });
});

test("chooseSubscriptionConfigDir: default dirExists arg falls back to real fs check when omitted", async () => {
  await withTempDir(async (dir) => {
    const present = path.join(dir, "present");
    await fs.mkdir(present);
    const registry: SubscriptionRegistry = {
      default: "d",
      subscriptions: [
        { id: "d", label: "Present", configDir: present, account: "d" },
        { id: "x", label: "Absent", configDir: path.join(dir, "absent"), account: "x" },
      ],
    };
    // dirExists omitted → uses subscriptionConfigDirExists (existsSync) against real temp dirs.
    assert.deepEqual(chooseSubscriptionConfigDir("d", registry), {
      configDir: present,
      source: "explicit",
    });
    assert.deepEqual(chooseSubscriptionConfigDir("x", registry), {
      configDir: present,
      source: "default",
      explicitRejection: { kind: "missing-dir", id: "x", configDir: path.join(dir, "absent") },
    });
  });
});
