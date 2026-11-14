import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyAtriumOsEnvironment,
  armAtriumOsNotice,
  boxDefaultOsRoot,
  clearAtriumOsNotice,
  formatPrimerErrorStamp,
  isOsCompatLinkInPlace,
  LEGACY_OS_ROOT,
  normaliseStoredChoice,
  OS_BIN_MARKER,
  processOsRoot,
  resetAtriumOsWarningsForTests,
  resolveOsChoiceForCreate,
  resolveOsRevision,
  takeAtriumOsNotice,
  validateOsChoice,
} from "../src/acp/atrium-os.js";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { resolveSessionPrimerCommand } from "../src/acp/session-primer.js";
import { applySnapshotOsObservation } from "../src/runtime/engine/lifecycle.js";
import type { SessionRecord } from "../src/types.js";

// P3a §1–§4 (spec /wisdom/Bricks/f87fa15b-…/conception/IMPLEMENTATION-SPEC.md). Every guarantee here
// carries a committed negative case beside it.

const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * An OS root fixture. Explicit choices must live under /workspace/ and carry no dot-folder (§1.4), and
 * some worktrees on these boxes ARE dot-folders, so accepted fixtures go under /workspace/projects/temp.
 * The directory name carries a space, like the real `Operating System`.
 */
function makeOsRoot(
  base: string,
  name: string,
  opts: { bin?: boolean; marker?: boolean; agentsMd?: boolean } = {},
): string {
  const root = path.join(base, `${name} OS`);
  fs.mkdirSync(root, { recursive: true });
  if (opts.agentsMd !== false) {
    fs.writeFileSync(path.join(root, "agents.md"), `# ${name}\n`);
  }
  if (opts.bin !== false) {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "send-message.sh"), "#!/bin/sh\necho ok\n", {
      mode: 0o755,
    });
    if (opts.marker !== false) {
      fs.writeFileSync(path.join(root, "bin", OS_BIN_MARKER), "");
    }
  }
  return root;
}

function withWorkspaceDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const parent = "/workspace/projects/temp";
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "acpx-atrium-os-test-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function withTmpDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-atrium-os-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
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

const NO_OS_ENV = {
  ATRIUM_OS: undefined,
  ATRIUM_OS_DEFAULT: undefined,
  ACPX_AGENT_OS_BIN: undefined,
};

// ── the box default root (§3.2) ───────────────────────────────────────────────────────────────────

test("boxDefaultOsRoot: nothing set → the legacy literal", () => {
  assert.equal(boxDefaultOsRoot({}), "/wisdom/Operating System");
  assert.equal(LEGACY_OS_ROOT, "/wisdom/Operating System");
});

test("boxDefaultOsRoot: ATRIUM_OS_DEFAULT wins, normalised; ATRIUM_OS never feeds it", () => {
  assert.equal(
    boxDefaultOsRoot({ ATRIUM_OS_DEFAULT: "/opt/atrium-os/current/" }),
    "/opt/atrium-os/current",
  );
  // NEGATIVE: a session's own ATRIUM_OS is not the box default (v5 §3 invariant).
  assert.equal(boxDefaultOsRoot({ ATRIUM_OS: "/workspace/x" }), LEGACY_OS_ROOT);
});

test("T17 boxDefaultOsRoot: the ACPX_AGENT_OS_BIN alias gives dirname(bin) when ATRIUM_OS_DEFAULT is unset", () => {
  assert.equal(
    boxDefaultOsRoot({ ACPX_AGENT_OS_BIN: "/r/os/Operating System/bin" }),
    "/r/os/Operating System",
  );
  assert.equal(
    boxDefaultOsRoot({ ATRIUM_OS_DEFAULT: "/a", ACPX_AGENT_OS_BIN: "/r/os/Operating System/bin" }),
    "/a",
  );
});

test("T17 negative: an alias whose basename is not bin is ignored, with a once-per-process note", () => {
  resetAtriumOsWarningsForTests();
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(boxDefaultOsRoot({ ACPX_AGENT_OS_BIN: "/r/os/scripts" }), LEGACY_OS_ROOT);
    assert.equal(boxDefaultOsRoot({ ACPX_AGENT_OS_BIN: "/r/os/scripts" }), LEGACY_OS_ROOT);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.filter((line) => line.includes("ACPX_AGENT_OS_BIN")).length, 1);
});

test("processOsRoot: ATRIUM_OS, else the box default", () => {
  assert.equal(processOsRoot({ ATRIUM_OS: "/workspace/b/" }), "/workspace/b");
  assert.equal(processOsRoot({ ATRIUM_OS_DEFAULT: "/d" }), "/d");
  assert.equal(processOsRoot({}), LEGACY_OS_ROOT);
});

test("normaliseStoredChoice: absent, default, empty and whitespace all read as default", () => {
  for (const raw of [undefined, null, "", "  ", "default", " default "]) {
    assert.equal(normaliseStoredChoice(raw), undefined, JSON.stringify(raw));
  }
  assert.equal(normaliseStoredChoice("/workspace/x"), "/workspace/x");
  // NEGATIVE: the choice keyword is case-sensitive — "Default" is a (bad) path, not default.
  assert.equal(normaliseStoredChoice("Default"), "Default");
});

// ── validation (§1.4) ─────────────────────────────────────────────────────────────────────────────

test("T4 validateOsChoice accepts a /workspace OS root and stores it normalised, never realpath'd", async () => {
  await withWorkspaceDir((dir) => {
    const root = makeOsRoot(dir, "wt");
    const link = path.join(dir, "current");
    fs.symlinkSync(root, link);
    assert.deepEqual(validateOsChoice(`${root}/`), { ok: true, choice: root });
    assert.deepEqual(validateOsChoice(link), { ok: true, choice: link });
    // relative, resolved against the given cwd
    assert.deepEqual(validateOsChoice(path.basename(root), { cwd: dir }), {
      ok: true,
      choice: root,
    });
  });
});

test("T4 validateOsChoice: default, empty and the box default itself store nothing", () => {
  assert.deepEqual(validateOsChoice("default"), { ok: true });
  assert.deepEqual(validateOsChoice(""), { ok: true });
  assert.deepEqual(validateOsChoice("/wisdom/Operating System", { env: {} }), { ok: true });
  assert.deepEqual(
    validateOsChoice("/opt/atrium-os/current", {
      env: { ATRIUM_OS_DEFAULT: "/opt/atrium-os/current" },
    }),
    {
      ok: true,
    },
  );
});

test("T4 validateOsChoice refuses /tmp, a dot-folder, ':', a dir without agents.md, a relative path outside the roots", async () => {
  await withWorkspaceDir(async (dir) => {
    const noAgents = makeOsRoot(dir, "bare", { agentsMd: false });
    const dotted = path.join(dir, ".hidden");
    makeOsRoot(dotted, "x");
    await withTmpDir((tmp) => {
      const tmpRoot = makeOsRoot(tmp, "tmp");
      const cases: [string, RegExp, string?][] = [
        [tmpRoot, /not under/],
        [path.join(dotted, "x OS"), /dot-folders/],
        [`${dir}/a:b`, /':'/],
        [`${dir}/a\nb`, /control character/],
        [noAgents, /agents\.md/],
        ["some/relative", /not under/, tmp],
        [path.join(dir, "missing"), /agents\.md/],
      ];
      for (const [raw, reason, cwd] of cases) {
        const result = validateOsChoice(raw, { cwd });
        assert.equal(result.ok, false, raw);
        assert.match(result.ok ? "" : result.reason, reason, raw);
      }
    });
  });
});

// ── the env at the single start point (§3.3) ──────────────────────────────────────────────────────

test("T3 M1 PATH: parent on OS A, child on OS B → B's bin first, A's marked bin stripped", async () => {
  await withWorkspaceDir((dir) => {
    const a = makeOsRoot(dir, "A");
    const b = makeOsRoot(dir, "B");
    const env: NodeJS.ProcessEnv = { PATH: `${a}/bin:${BASE_PATH}`, ATRIUM_OS: a };
    const outcome = applyAtriumOsEnvironment(env, b);
    assert.deepEqual(outcome, { root: b, choice: b, fallback: undefined });
    assert.equal(env.ATRIUM_OS, b);
    assert.equal(env.PATH, `${b}/bin:${BASE_PATH}`);
    // `command -v send-message.sh` in the child resolves inside B
    const resolved = execFileSync("sh", ["-c", "command -v send-message.sh"], { env })
      .toString()
      .trim();
    assert.equal(resolved, `${b}/bin/send-message.sh`);
  });
});

test("T3 negative: an UNMARKED bin of another root stays (the strip keys on the marker)", async () => {
  await withWorkspaceDir((dir) => {
    const a = makeOsRoot(dir, "A", { marker: false });
    const b = makeOsRoot(dir, "B");
    const env: NodeJS.ProcessEnv = { PATH: `${BASE_PATH}:${a}/bin` };
    applyAtriumOsEnvironment(env, b);
    assert.equal(env.PATH, `${b}/bin:${BASE_PATH}:${a}/bin`);
  });
});

test("T3 negative: a root without bin/ prepends nothing, and still strips marked bins", async () => {
  await withWorkspaceDir((dir) => {
    const a = makeOsRoot(dir, "A");
    const b = makeOsRoot(dir, "B", { bin: false });
    const env: NodeJS.ProcessEnv = { PATH: `${a}/bin:${BASE_PATH}` };
    applyAtriumOsEnvironment(env, b);
    assert.equal(env.ATRIUM_OS, b);
    assert.equal(env.PATH, BASE_PATH);
  });
});

test("the PATH rebuild drops duplicates of the own bin (trailing slash too) and keeps empty / relative entries", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B", { marker: false });
    const env: NodeJS.ProcessEnv = { PATH: `${BASE_PATH}::rel/bin:${b}/bin/:${b}/bin` };
    applyAtriumOsEnvironment(env, b);
    assert.equal(env.PATH, `${b}/bin:${BASE_PATH}::rel/bin`);
  });
});

test("an unset or empty PATH becomes the bin, or stays as it was when there is no bin", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B");
    const unset: NodeJS.ProcessEnv = {};
    applyAtriumOsEnvironment(unset, b);
    assert.equal(unset.PATH, `${b}/bin`);
    const noBin = makeOsRoot(dir, "C", { bin: false });
    const empty: NodeJS.ProcessEnv = { PATH: "" };
    applyAtriumOsEnvironment(empty, noBin);
    assert.equal(empty.PATH, "");
  });
});

test("T14 ATRIUM_OS is always written: an inherited value (another session's OS) never survives", async () => {
  await withWorkspaceDir((dir) => {
    const a = makeOsRoot(dir, "A");
    const box = makeOsRoot(dir, "box");
    const env: NodeJS.ProcessEnv = { ATRIUM_OS: a, ATRIUM_OS_DEFAULT: box, PATH: `${a}/bin` };
    const outcome = applyAtriumOsEnvironment(env, undefined);
    assert.equal(outcome.root, box);
    assert.equal(env.ATRIUM_OS, box);
    assert.equal(env.PATH, `${box}/bin`);
  });
});

test("T15 ATRIUM_OS_DEFAULT is never written from a choice; ACPX_AGENT_OS_BIN is never exported", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B");
    const withDefault: NodeJS.ProcessEnv = { ATRIUM_OS_DEFAULT: "/opt/atrium-os/current" };
    applyAtriumOsEnvironment(withDefault, b);
    assert.equal(withDefault.ATRIUM_OS_DEFAULT, "/opt/atrium-os/current");
    const without: NodeJS.ProcessEnv = {};
    applyAtriumOsEnvironment(without, b);
    assert.equal("ATRIUM_OS_DEFAULT" in without, false);
    assert.equal("ACPX_AGENT_OS_BIN" in without, false);
  });
});

test("T10 a stored path that is not an OS root falls back to the box default and says so", async () => {
  await withWorkspaceDir((dir) => {
    const box = makeOsRoot(dir, "box");
    const missing = path.join(dir, "gone OS");
    const env: NodeJS.ProcessEnv = { ATRIUM_OS_DEFAULT: box, PATH: BASE_PATH };
    const outcome = applyAtriumOsEnvironment(
      env,
      missing,
      () => new Date("2026-11-14T20:00:00.000Z"),
    );
    assert.equal(outcome.root, box);
    assert.deepEqual(outcome.fallback, { at: "2026-11-14T20:00:00.000Z", missing });
    assert.equal(env.ATRIUM_OS, box);
    // NEGATIVE: the path restored → no fallback, the path applies.
    makeOsRoot(dir, "gone");
    const again: NodeJS.ProcessEnv = { ATRIUM_OS_DEFAULT: box };
    const restored = applyAtriumOsEnvironment(again, missing);
    assert.equal(restored.fallback, undefined);
    assert.equal(restored.root, missing);
  });
});

test("buildAgentSpawnOptions applies the session's OS as the env's last step and reports the outcome", async () => {
  await withWorkspaceDir((dir) => {
    const a = makeOsRoot(dir, "A");
    const b = makeOsRoot(dir, "B");
    withProcessEnv({ ...NO_OS_ENV, ATRIUM_OS: a, PATH: `${a}/bin:${BASE_PATH}` }, () => {
      let reported: unknown;
      const { env } = buildAgentSpawnOptions(
        "/tmp",
        undefined,
        { acpxRecordId: "r1", osChoice: b },
        undefined,
        "claude",
        undefined,
        (outcome) => {
          reported = outcome;
        },
      );
      assert.equal(env.ATRIUM_OS, b);
      assert.equal(env.PATH?.split(":")[0], `${b}/bin`);
      assert.equal(env.PATH?.split(":").includes(`${a}/bin`), false);
      assert.deepEqual(reported, { root: b, choice: b, fallback: undefined });
    });
  });
});

test("T28 neutral: nothing set → ATRIUM_OS is the literal, and the OS bin moves from last to first", () => {
  const legacyBin = "/wisdom/Operating System/bin";
  withProcessEnv({ ...NO_OS_ENV, PATH: `${BASE_PATH}:${legacyBin}` }, () => {
    const { env } = buildAgentSpawnOptions(
      "/tmp",
      undefined,
      { acpxRecordId: "r1" },
      undefined,
      "claude",
    );
    assert.equal(env.ATRIUM_OS, LEGACY_OS_ROOT);
    // Same entries as the old append produced, the OS bin first (measured present on devbox).
    const expected = fs.existsSync(legacyBin) ? `${legacyBin}:${BASE_PATH}` : BASE_PATH;
    assert.equal(env.PATH, expected);
  });
});

// ── the primer command (§3.5) ─────────────────────────────────────────────────────────────────────

test("T16 primer command: explicit ACPX_SESSION_PRIMER_COMMAND wins, else $ATRIUM_OS/Harnesses/shared/session-context.sh", () => {
  assert.equal(
    resolveSessionPrimerCommand({
      ACPX_SESSION_PRIMER_COMMAND: "/x/p.sh",
      ATRIUM_OS: "/workspace/b",
    }),
    "/x/p.sh",
  );
  assert.equal(
    resolveSessionPrimerCommand({ ATRIUM_OS: "/workspace/b" }),
    "/workspace/b/Harnesses/shared/session-context.sh",
  );
  // NEGATIVE / neutrality: nothing set → byte-identical to the pre-P3a literal.
  assert.equal(
    resolveSessionPrimerCommand({}),
    "/wisdom/Operating System/Harnesses/shared/session-context.sh",
  );
  assert.equal(
    resolveSessionPrimerCommand({ ACPX_SESSION_PRIMER_COMMAND: "  " }),
    "/wisdom/Operating System/Harnesses/shared/session-context.sh",
  );
});

// ── revision (§1.3) ───────────────────────────────────────────────────────────────────────────────

test("resolveOsRevision: releases/<40-hex> → that hex; a git worktree → HEAD; a live folder → null", async () => {
  await withTmpDir(async (dir) => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    const release = path.join(dir, "releases", hex);
    fs.mkdirSync(release, { recursive: true });
    const current = path.join(dir, "current");
    fs.symlinkSync(release, current);
    assert.equal(await resolveOsRevision(current), hex);

    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
        .toString()
        .trim();
    git("init", "-q");
    git("-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "x");
    assert.equal(await resolveOsRevision(repo), git("rev-parse", "HEAD"));

    const live = path.join(dir, "live");
    fs.mkdirSync(live);
    assert.equal(await resolveOsRevision(live), null);
    assert.equal(await resolveOsRevision(path.join(dir, "missing")), null);
  });
});

// ── C11 refuse keying (§4.5) ──────────────────────────────────────────────────────────────────────

test("T19 isOsCompatLinkInPlace: a symlink → true; a real directory or nothing → false", async () => {
  await withTmpDir((dir) => {
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    const link = path.join(dir, "Operating System");
    fs.symlinkSync(target, link);
    assert.equal(isOsCompatLinkInPlace(link), true);
    assert.equal(isOsCompatLinkInPlace(target), false);
    assert.equal(isOsCompatLinkInPlace(path.join(dir, "missing")), false);
  });
});

// ── the notice store (§4.4) ───────────────────────────────────────────────────────────────────────

test("the OS notice is delivered once per arming, both kinds together, and a cleared kind is gone", () => {
  armAtriumOsNotice("rec-1", "fallback", "F");
  armAtriumOsNotice("rec-1", "primer", "P");
  assert.equal(takeAtriumOsNotice("rec-1"), "F\n\nP");
  // NEGATIVE: a second turn after one spawn carries no notice.
  assert.equal(takeAtriumOsNotice("rec-1"), undefined);
  armAtriumOsNotice("rec-2", "primer", "P");
  clearAtriumOsNotice("rec-2", "primer");
  assert.equal(takeAtriumOsNotice("rec-2"), undefined);
  // no record id (a creation spawn) arms nothing
  armAtriumOsNotice(undefined, "primer", "P");
  assert.equal(takeAtriumOsNotice(undefined), undefined);
});

test("formatPrimerErrorStamp: ISO time + one-line reason, capped at 200 chars", () => {
  const stamp = formatPrimerErrorStamp(
    `exited 1:\n${"x".repeat(400)}`,
    new Date("2026-11-14T20:00:00.000Z"),
  );
  assert.match(stamp, /^2026-11-14T20:00:00\.000Z exited 1: x+$/);
  assert.equal(stamp.length, "2026-11-14T20:00:00.000Z ".length + 200);
});

// ── creation precedence (§2.1) ────────────────────────────────────────────────────────────────────

test("creation rule 1: --os validated; a refusal stops the create; --os default beats every rule", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B");
    assert.deepEqual(resolveOsChoiceForCreate({ explicit: b, creation: "plain" }), {
      ok: true,
      choice: b,
      warnings: [],
    });
    const refused = resolveOsChoiceForCreate({ explicit: "/tmp/x", creation: "plain" });
    assert.equal(refused.ok, false);
    assert.deepEqual(
      resolveOsChoiceForCreate({
        explicit: "default",
        creation: "successor",
        sourceChoice: b,
        parentChoice: b,
      }),
      { ok: true, choice: undefined, warnings: [] },
    );
  });
});

test("creation rule 2 (M7): a successor takes the SOURCE's choice even when its parent is default", () => {
  const result = resolveOsChoiceForCreate({
    creation: "successor",
    sourceChoice: "/workspace/os/wt",
    parentChoice: null,
  });
  assert.deepEqual(result, { ok: true, choice: "/workspace/os/wt", warnings: [] });
  // NEGATIVE: a fork of a DEFAULT source made by an override caller stays default.
  assert.deepEqual(
    resolveOsChoiceForCreate({
      creation: "copy",
      sourceChoice: null,
      parentChoice: "/workspace/x",
    }),
    {
      ok: true,
      choice: undefined,
      warnings: [],
    },
  );
});

test("creation rule 3 beats rule 4: a child of a default parent ignores the caller's ATRIUM_OS", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B");
    assert.deepEqual(
      resolveOsChoiceForCreate({ creation: "plain", parentChoice: null, env: { ATRIUM_OS: b } }),
      {
        ok: true,
        choice: undefined,
        warnings: [],
      },
    );
    assert.deepEqual(
      resolveOsChoiceForCreate({
        creation: "plain",
        parentChoice: "default",
        env: { ATRIUM_OS: b },
      }),
      {
        ok: true,
        choice: undefined,
        warnings: [],
      },
    );
    assert.deepEqual(resolveOsChoiceForCreate({ creation: "plain", parentChoice: b, env: {} }), {
      ok: true,
      choice: b,
      warnings: [],
    });
  });
});

test("creation rule 4: no local parent → the caller's ATRIUM_OS when it differs from the box default", async () => {
  await withWorkspaceDir((dir) => {
    const b = makeOsRoot(dir, "B");
    assert.deepEqual(resolveOsChoiceForCreate({ creation: "plain", env: { ATRIUM_OS: b } }), {
      ok: true,
      choice: b,
      warnings: [],
    });
    // equal to the box default → nothing stored (scenario 1)
    assert.deepEqual(
      resolveOsChoiceForCreate({ creation: "plain", env: { ATRIUM_OS: b, ATRIUM_OS_DEFAULT: b } }),
      {
        ok: true,
        choice: undefined,
        warnings: [],
      },
    );
    // an invalid value warns and falls to default — never refuses the create
    const invalid = resolveOsChoiceForCreate({ creation: "exec", env: { ATRIUM_OS: "/tmp/nope" } });
    assert.equal(invalid.ok, true);
    assert.equal(invalid.ok && invalid.choice, undefined);
    assert.match(
      invalid.ok ? invalid.warnings.join("") : "",
      /ATRIUM_OS=\/tmp\/nope is not a usable OS root/,
    );
  });
});

test("T8 a template copy warns when the template was baked under another OS, and only then", () => {
  const differs = resolveOsChoiceForCreate({
    creation: "template",
    parentChoice: null,
    template: { id: "tpl-1", choice: "/workspace/os/x" },
    env: {},
  });
  assert.equal(differs.ok && differs.choice, undefined);
  assert.match(
    differs.ok ? differs.warnings.join("") : "",
    /template tpl-1 was baked under OS \/workspace\/os\/x; this copy runs on default/,
  );
  const same = resolveOsChoiceForCreate({
    creation: "template",
    template: { id: "tpl-1" },
    env: {},
  });
  assert.deepEqual(same, { ok: true, choice: undefined, warnings: [] });
});

// ── the lifecycle-snapshot leg (§1.6) ─────────────────────────────────────────────────────────────

test("applySnapshotOsObservation: string sets, null deletes, undefined leaves; no os touches nothing", () => {
  const record = {
    acpxRecordId: "r",
    metadata: { atrium_os: "/w", atrium_os_primer_error: "t e" },
  } as unknown as SessionRecord;
  applySnapshotOsObservation(record, {
    revision: "a".repeat(40),
    fallbackAt: null,
    primerError: undefined,
  });
  assert.deepEqual(record.metadata, {
    atrium_os: "/w",
    atrium_os_primer_error: "t e",
    atrium_os_revision: "a".repeat(40),
  });
  applySnapshotOsObservation(record, { revision: null, fallbackAt: "2026", primerError: null });
  assert.deepEqual(record.metadata, { atrium_os: "/w", atrium_os_fallback: "2026" });
  applySnapshotOsObservation(record, undefined);
  assert.deepEqual(record.metadata, { atrium_os: "/w", atrium_os_fallback: "2026" });
  // NEUTRAL: a default session with nothing observed keeps NO metadata at all.
  const bare = { acpxRecordId: "b" } as unknown as SessionRecord;
  applySnapshotOsObservation(bare, { revision: null, fallbackAt: null, primerError: null });
  assert.equal(bare.metadata, undefined);
});
