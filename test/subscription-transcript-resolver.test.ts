import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeTranscriptConfigDir,
  ensureTranscriptAtActiveConfigDir,
  transcriptJsonlPath,
} from "../src/config/subscription-transcript.js";
import type { SubscriptionRegistry } from "../src/config/subscriptions.js";

// Resolver hotfix (brick://f5aabb1d, completes brick://08ac840f).
//
// `subscriptionIdFromRecord` (private) is exercised through its only public
// callers `activeTranscriptConfigDir` / `ensureTranscriptAtActiveConfigDir`.
// The CLI folds `--subscription` into the UNIFIED `session_options.profile`
// slot for ~96% of the fleet, and the adapter (`applyProfileAuth` →
// `applySubscriptionConfigDir(profileId)`, auth-env.ts:1242) resolves a
// subscription-authMode profile by feeding the PROFILE id into the SAME
// `chooseSubscriptionConfigDir` this resolver uses. Reading `.subscription`
// ALONE therefore resolved the WRONG (registry-default) transcript dir for the
// profile-based majority — the resolver must prefer `.profile`.

const CWD = "/work/proj";
const ACP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SubOptions = {
  profile?: string;
  subscription?: string;
};

/** Transcript-bearing record carrying the given unified account-selection options. */
function record(options: SubOptions): {
  cwd: string;
  acpSessionId: string;
  acpx: { session_options: SubOptions };
} {
  return { cwd: CWD, acpSessionId: ACP_ID, acpx: { session_options: options } };
}

/**
 * Build a temp home with a real on-disk configDir per subscription id (so
 * `subscriptionConfigDirExists` — an `existsSync` probe — honors the explicit
 * selection) and an in-memory registry pointing at them. `defaultId` is the
 * registry default that a mis-resolution would fall back to.
 */
async function withRegistry(
  ids: string[],
  defaultId: string,
  run: (env: {
    homeDir: string;
    registry: SubscriptionRegistry;
    configDir: (id: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resolver-"));
  try {
    const dirs = new Map<string, string>();
    for (const id of ids) {
      const dir = path.join(homeDir, ".acpx", "subscriptions", id);
      await fs.mkdir(dir, { recursive: true });
      dirs.set(id, dir);
    }
    const registry: SubscriptionRegistry = {
      default: defaultId,
      subscriptions: ids.map((id) => ({
        id,
        label: id,
        configDir: dirs.get(id) as string,
        account: id,
      })),
    };
    await run({
      homeDir,
      registry,
      configDir: (id) => dirs.get(id) as string,
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function writeTranscript(
  configDir: string,
  isoTail: string,
  marker: string,
): Promise<string> {
  const jsonlPath = transcriptJsonlPath(configDir, CWD, ACP_ID);
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
  await fs.writeFile(
    jsonlPath,
    `{"type":"user","timestamp":"2026-07-16T00:00:00.000Z","text":"start"}\n` +
      `{"type":"assistant","timestamp":"${isoTail}","text":"${marker}"}\n`,
  );
  return jsonlPath;
}

async function lastTimestamp(filePath: string): Promise<string | undefined> {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const lines = text.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ts = JSON.parse(lines[i]).timestamp as unknown;
      if (typeof ts === "string") {
        return ts;
      }
    } catch {
      /* keep walking back */
    }
  }
  return undefined;
}

// --- subscriptionIdFromRecord resolution (via activeTranscriptConfigDir) ---

test("resolver: profile-based record (no .subscription) resolves the PROFILE's dir, not the registry default", async () => {
  // subN is a NON-default sub selected via session_options.profile — the ~96% case.
  await withRegistry(
    ["subDefault", "subN"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const resolved = activeTranscriptConfigDir(record({ profile: "subN" }), {
        homeDir,
        registry,
      });
      assert.equal(resolved, configDir("subN"), "must resolve subN, the profile's own dir");
      assert.notEqual(
        resolved,
        configDir("subDefault"),
        "must NOT fall back to the registry default",
      );
    },
  );
});

test("resolver: profile takes precedence over subscription when both are set", async () => {
  await withRegistry(
    ["subP", "subS", "subDefault"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const resolved = activeTranscriptConfigDir(
        record({ profile: "subP", subscription: "subS" }),
        { homeDir, registry },
      );
      assert.equal(resolved, configDir("subP"), "profile is the canonical unified slot; it wins");
    },
  );
});

test("resolver: legacy .subscription-only record still resolves that subscription's dir", async () => {
  await withRegistry(
    ["subS", "subDefault"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const resolved = activeTranscriptConfigDir(record({ subscription: "subS" }), {
        homeDir,
        registry,
      });
      assert.equal(
        resolved,
        configDir("subS"),
        "the ~62 legacy .subscription sessions keep working",
      );
    },
  );
});

test("resolver: neither profile nor subscription set → registry default's dir", async () => {
  await withRegistry(
    ["subDefault", "subOther"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const resolved = activeTranscriptConfigDir(record({}), { homeDir, registry });
      assert.equal(resolved, configDir("subDefault"));
    },
  );
});

test("resolver: empty/whitespace profile is skipped in favor of a set subscription", async () => {
  await withRegistry(
    ["subS", "subDefault"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const resolved = activeTranscriptConfigDir(record({ profile: "   ", subscription: "subS" }), {
        homeDir,
        registry,
      });
      assert.equal(
        resolved,
        configDir("subS"),
        "nonEmptyTrimmed skips the blank profile, then honors .subscription",
      );
    },
  );
});

test("resolver: an unknown profile id (not in registry) falls back to the default, as an unknown sub did before", async () => {
  await withRegistry(["subDefault"], "subDefault", async ({ homeDir, registry, configDir }) => {
    // Validation is inherent: chooseSubscriptionConfigDir looks the id up in the
    // registry, so a non-subscription profile finds no dir and falls back.
    const resolved = activeTranscriptConfigDir(record({ profile: "not-a-sub" }), {
      homeDir,
      registry,
    });
    assert.equal(resolved, configDir("subDefault"));
  });
});

// --- end-to-end: the profile-based session's freshest transcript reaches the
//     dir the adapter actually resumes from (subN), not the default. ---

test("end-to-end: freshest segment ports into the PROFILE's resume dir for a profile-based session", async () => {
  // subN (profile, NON-default) holds a STALE tail; the registry default holds a
  // FRESHER segment. The adapter resumes subN (applyProfileAuth feeds the profile
  // id into chooseSubscriptionConfigDir), so protection is real only if the
  // freshest content lands in subN's dir.
  await withRegistry(
    ["subDefault", "subN"],
    "subDefault",
    async ({ homeDir, registry, configDir }) => {
      const T1 = "2026-07-17T18:21:00.000Z"; // subN stale checkpoint
      const T2 = "2026-07-20T10:00:00.000Z"; // fresher segment (in the default dir)
      const subNPath = await writeTranscript(configDir("subN"), T1, "STALE-SUBN");
      await writeTranscript(configDir("subDefault"), T2, "FRESH-DEFAULT");

      const registryPath = path.join(homeDir, ".acpx", "subscriptions", "registry.json");
      await fs.writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });

      await ensureTranscriptAtActiveConfigDir(record({ profile: "subN" }), {
        homeDir,
        registryPath,
      });

      // The dir the adapter resumes from (subN) must now carry the fresh tail.
      assert.equal(
        await lastTimestamp(subNPath),
        T2,
        "subN (the real resume dir) must hold the freshest segment",
      );
    },
  );
});
