import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renderRemovePlanText,
  resolvePurgeDir,
  type SubscriptionRemovePlan,
} from "../src/cli/subscriptions-command.js";
import { removeProfileFromRegistry } from "../src/config/subscriptions.js";
import { SubscriptionPurgeOutsideRootError } from "../src/errors.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-subs-remove-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

type WriteRegistryOptions = {
  default?: string;
  profiles?: unknown[];
  subscriptions?: unknown[];
  quarantined?: unknown[];
};

function subscriptionProfile(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    label: `Claude Max 20x - ${id}`,
    authMode: "subscription",
    adapter: "claude",
    account: id,
    credentialSource: `/home/node/.acpx/subscriptions/${id}`,
    ...extra,
  };
}

async function writeRegistry(dir: string, options: WriteRegistryOptions): Promise<string> {
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 3,
      ...(options.default !== undefined ? { default: options.default } : {}),
      ...(options.profiles !== undefined ? { profiles: options.profiles } : {}),
      ...(options.subscriptions !== undefined ? { subscriptions: options.subscriptions } : {}),
      ...(options.quarantined !== undefined ? { quarantined: options.quarantined } : {}),
    }),
  );
  return registryPath;
}

async function readRegistry(registryPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, unknown>;
}

test("removeProfileFromRegistry drops the entry and preserves every sibling", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub3",
      profiles: [
        subscriptionProfile("sub1"),
        subscriptionProfile("sub2"),
        subscriptionProfile("sub3"),
      ],
    });

    const result = removeProfileFromRegistry("sub1", { homeDir, registryPath });

    assert.ok(result);
    assert.equal(result.subscription, "sub1");
    assert.equal(result.wasDefault, false);
    assert.equal(result.newDefault, "sub3");
    assert.deepEqual(result.remaining, ["sub2", "sub3"]);

    const document = await readRegistry(registryPath);
    assert.deepEqual(
      (document.profiles as { id: string }[]).map((entry) => entry.id),
      ["sub2", "sub3"],
    );
    assert.equal(document.default, "sub3");
    assert.equal(document.version, 3);
  });
});

test("removeProfileFromRegistry repoints the default via setDefault", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub1",
      profiles: [subscriptionProfile("sub1"), subscriptionProfile("sub2")],
    });

    const result = removeProfileFromRegistry("sub1", {
      homeDir,
      registryPath,
      setDefault: "sub2",
    });

    assert.ok(result);
    assert.equal(result.wasDefault, true);
    assert.equal(result.newDefault, "sub2");
    assert.equal((await readRegistry(registryPath)).default, "sub2");
  });
});

test("removeProfileFromRegistry clears the default when no replacement is given", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub1",
      profiles: [subscriptionProfile("sub1"), subscriptionProfile("sub2")],
    });

    const result = removeProfileFromRegistry("sub1", { homeDir, registryPath });

    assert.ok(result);
    assert.equal(result.wasDefault, true);
    assert.equal(result.newDefault, null);
    assert.equal("default" in (await readRegistry(registryPath)), false);
  });
});

test("removeProfileFromRegistry preserves sibling lock metadata and quarantined entries", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub2",
      profiles: [
        subscriptionProfile("sub1"),
        subscriptionProfile("sub2", {
          locked: true,
          lockedAt: "2026-08-05T10:00:00.000Z",
          lockedBy: "daniel",
        }),
      ],
      quarantined: [{ reason: "bad entry", entry: { id: "broken" } }],
    });

    removeProfileFromRegistry("sub1", { homeDir, registryPath });

    const document = await readRegistry(registryPath);
    const [survivor] = document.profiles as Record<string, unknown>[];
    assert.equal(survivor?.id, "sub2");
    assert.equal(survivor?.locked, true);
    assert.equal(survivor?.lockedAt, "2026-08-05T10:00:00.000Z");
    assert.equal(survivor?.lockedBy, "daniel");
    assert.deepEqual(document.quarantined, [{ reason: "bad entry", entry: { id: "broken" } }]);
  });
});

test("removeProfileFromRegistry removes a claude-home bridge, which the subscriptions view hides", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub1",
      profiles: [
        subscriptionProfile("sub1"),
        {
          id: "bridge1",
          label: "Claude Bridge (claude-pty)",
          authMode: "claude-home",
          adapter: "claude-pty",
          account: "bridge1",
          credentialSource: null,
          homePath: "/home/node/.acpx/subscriptions/bridge1",
        },
      ],
    });

    const result = removeProfileFromRegistry("bridge1", { homeDir, registryPath });

    assert.ok(result);
    assert.deepEqual(result.remaining, ["sub1"]);
    assert.equal(result.wasDefault, false);
    assert.equal(result.newDefault, "sub1");
  });
});

test("removeProfileFromRegistry also drops a legacy v1 subscriptions[] entry", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub2",
      subscriptions: [
        { id: "sub1", label: "One", configDir: "/custom/sub1" },
        { id: "sub2", label: "Two", configDir: "/custom/sub2" },
      ],
    });

    const result = removeProfileFromRegistry("sub1", { homeDir, registryPath });

    assert.ok(result);
    const document = await readRegistry(registryPath);
    assert.deepEqual(
      (document.subscriptions as { id: string }[]).map((entry) => entry.id),
      ["sub2"],
    );
  });
});

test("removeProfileFromRegistry returns undefined for an unknown id and leaves the file untouched", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = await writeRegistry(homeDir, {
      default: "sub1",
      profiles: [subscriptionProfile("sub1")],
    });
    const before = await fs.readFile(registryPath, "utf8");

    assert.equal(removeProfileFromRegistry("nope", { homeDir, registryPath }), undefined);
    assert.equal(await fs.readFile(registryPath, "utf8"), before);
  });
});

test("removeProfileFromRegistry returns undefined when there is no registry", async () => {
  await withTempDir(async (homeDir) => {
    const registryPath = path.join(homeDir, "registry.json");
    assert.equal(removeProfileFromRegistry("sub1", { homeDir, registryPath }), undefined);
  });
});

async function withStateHome(run: (homeDir: string) => void): Promise<void> {
  await withTempDir(async (homeDir) => {
    const previous = process.env.ACPX_STATE_HOME;
    process.env.ACPX_STATE_HOME = homeDir;
    try {
      run(homeDir);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_STATE_HOME;
      } else {
        process.env.ACPX_STATE_HOME = previous;
      }
    }
  });
}

test("resolvePurgeDir accepts a dir strictly inside ~/.acpx/subscriptions", async () => {
  await withStateHome((homeDir) => {
    const target = path.join(homeDir, ".acpx", "subscriptions", "sub1");
    assert.equal(resolvePurgeDir("sub1", target, true), target);
  });
});

test("resolvePurgeDir returns null when --purge was not asked for", async () => {
  await withStateHome((homeDir) => {
    const target = path.join(homeDir, ".acpx", "subscriptions", "sub1");
    assert.equal(resolvePurgeDir("sub1", target, false), null);
    assert.equal(resolvePurgeDir("sub1", null, true), null);
  });
});

test("resolvePurgeDir refuses a dir outside the subscriptions root", async () => {
  await withStateHome((homeDir) => {
    for (const outside of [
      path.join(homeDir, "PRECIOUS"),
      path.join(homeDir, ".acpx", "subscriptions"),
      path.join(homeDir, ".acpx", "subscriptions", "..", "sessions"),
      "/",
      homeDir,
    ]) {
      assert.throws(
        () => resolvePurgeDir("evil", outside, true),
        SubscriptionPurgeOutsideRootError,
        `expected refusal for ${outside}`,
      );
    }
  });
});

function plan(overrides: Partial<SubscriptionRemovePlan> = {}): SubscriptionRemovePlan {
  return {
    action: "subscription_remove",
    subscription: "sub1",
    label: "Claude Max 20x - 1",
    authMode: "subscription",
    account: "sub1",
    wasDefault: false,
    newDefault: "sub3",
    configDir: "/home/node/.acpx/subscriptions/sub1",
    purgedDir: null,
    pinnedTotal: 0,
    pinnedOpen: 0,
    reassignedTo: null,
    reassignedCount: 0,
    remaining: ["sub2", "sub3"],
    dryRun: false,
    ...overrides,
  };
}

test("renderRemovePlanText reports a dry run without claiming the removal happened", () => {
  const text = renderRemovePlanText(plan({ dryRun: true }));
  assert.match(text, /^would remove subscription: sub1/);
  assert.match(
    text,
    /kept at \/home\/node\/\.acpx\/subscriptions\/sub1 \(pass --purge to delete\)/,
  );
});

test("renderRemovePlanText spells out a dangling-pin removal and a re-pin", () => {
  const dangling = renderRemovePlanText(plan({ pinnedTotal: 114, pinnedOpen: 66 }));
  assert.match(dangling, /114 pinned; 66 open — left dangling \(will fail to spawn\)/);

  const repinned = renderRemovePlanText(
    plan({ pinnedTotal: 114, pinnedOpen: 66, reassignedTo: "sub5", reassignedCount: 114 }),
  );
  assert.match(repinned, /114 pinned; 114 re-pinned to sub5/);
});

test("renderRemovePlanText flags an unset default as the ~/.claude fallthrough", () => {
  const text = renderRemovePlanText(plan({ wasDefault: true, newDefault: null }));
  assert.match(text, /default {6}<none — unselected spawns fall back to ~\/\.claude>/);
});
