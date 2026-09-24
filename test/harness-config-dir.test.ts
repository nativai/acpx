import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveAcceptsArbitraryModelIds,
  deriveHarnessCapabilities,
  HARNESS_FACTS,
  HARNESS_IDS,
} from "../src/acp/harness-capabilities.js";
import {
  applyHarnessConfigDir,
  describePiExtensionSeedFailure,
  pruneOrphanHarnessConfigDirs,
  removeHarnessConfigDir,
  rescueStrandedPiTranscriptForResume,
} from "../src/acp/harness-config-dir.js";
import { resetPiKnowledgeMemo } from "../src/acp/pi-model-knowledge.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { setHarnessConfigDir } from "../src/session/mode-preference.js";
import {
  modelSetMethodKnownUnsupported,
  setModelSetMethodUnsupported,
} from "../src/session/mode-preference.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { toSessionIndexEntry } from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// B3 deliverable 5 — ONE per-session config dir serving primer + model pin +
// catalogue fragment, GATED PER HARNESS off the descriptor.
//
// ⚠️ BOUNDARY (IR-15): these tests measure the env object acpx builds for the
// ADAPTER spawn. They CANNOT see the acpx-ui -> acpx boundary (that is RS-01's,
// and RS-01 is structurally blind to this change in both directions), and they
// do not prove the harness READ the files — that is the rig's job (RS-13).

const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY = "node /opt/claude-pty-acp/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";

function withTempRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "hp-b3-cfgdir-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 🛑 THE ENV EVERY PI PROVISIONING ROW MUST USE — it reads NOTHING from the box.
 *
 * ## Why this exists (brick ff298f02)
 *
 * `writePiModelsStore` makes its decision from TWO reads, and BOTH resolved
 * against the machine when the caller passed a scoped env:
 *
 *  - `readBoxPiOpenRouterModels` → `<HOME>/.pi/agent/models-store.json`, and with
 *    `HOME` unset that is the REAL `/home/node`;
 *  - `readPiAdvertisedModelIds` → `<HOME>/.acpx/pi-model-knowledge.json`, and on a
 *    miss it SPAWNS `pi`.
 *
 * So a row written as `const env = {}` asserted against whatever the box happened
 * to hold. Measured: an un-isolated probe left `/home/node/.pi/agent/models-store.json`
 * behind at 08:37:22Z on 2026-09-07 and the row below went RED for every lane on
 * this box for three hours; it went green again when the file was moved away.
 * **A unit test whose result depends on box state is itself the defect** — and it
 * is what made a differential unable to separate two causes, because the
 * contamination sat in BOTH arms.
 *
 * ⚠️ `PATH: ""` is not decoration. It states that no `pi` binary is resolvable,
 * which is what makes "no spawn happens here" a PROPERTY OF THE FIXTURE rather
 * than an accident of the box not having pi installed.
 *
 * The knowledge cache is written with no `binary` stamp deliberately: with no
 * resolvable binary there is nothing to compare it against, so freshness alone
 * decides and the injected ids are used verbatim.
 */
function piIsolatedEnv(
  root: string,
  options: { piKnows: string[]; boxCatalogue?: unknown[] },
): NodeJS.ProcessEnv {
  const boxHome = join(root, "box-home");
  mkdirSync(boxHome, { recursive: true });

  if (options.boxCatalogue) {
    const boxAgentDir = join(boxHome, ".pi", "agent");
    mkdirSync(boxAgentDir, { recursive: true });
    writeFileSync(
      join(boxAgentDir, "models-store.json"),
      JSON.stringify({ openrouter: { lastModified: 1, models: options.boxCatalogue } }),
    );
  }

  const cachePath = join(root, "pi-knowledge.json");
  writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), ids: options.piKnows }),
  );

  // The knowledge memo lives for the life of the process, and every row here
  // shares one. Without this, a row would measure the PREVIOUS row's answer.
  resetPiKnowledgeMemo();

  return { HOME: boxHome, ACPX_PI_KNOWLEDGE_CACHE: cachePath, PATH: "" };
}

// ── THE GUARDRAIL: the three Claude/codex agents gain NOTHING ────────────────

test("GUARDRAIL: claude, claude-pty and codex adapter envs are UNCHANGED", () => {
  withTempRoot((root) => {
    for (const agentCommand of [CLAUDE, CLAUDE_PTY, CODEX]) {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/node" };
      const before = JSON.stringify(env);
      const plan = applyHarnessConfigDir({
        env,
        agentCommand,
        sessionId: "s1",
        primer: "PRIMER-MARKER",
        model: "some-model",
        rootDir: root,
      });
      assert.equal(plan, undefined, `${agentCommand}: a config dir was planned`);
      // POPULATION PRINTED as an assertion, not a hope: the env must be the same
      // SIZE and the same CONTENT. A zero-length env would make "unchanged"
      // vacuously true, so the size is asserted against a known non-zero value.
      assert.equal(Object.keys(env).length, 2, `${agentCommand}: env population changed`);
      assert.equal(JSON.stringify(env), before, `${agentCommand}: env content changed`);
      // And nothing was written to disk for them at all.
      assert.deepEqual(readdirSync(root), [], `${agentCommand}: wrote files it should not have`);
    }
  });
});

test("the gate is the descriptor cell, not a hardcoded harness list", () => {
  // Exactly the harnesses declaring `config-file` get a dir — stated as a
  // population over ALL harnesses so a sixth cannot join silently.
  const gated = HARNESS_IDS.filter(
    (id) => HARNESS_FACTS[id].primerChannel === "config-file",
  ).toSorted();
  assert.deepEqual(gated, ["pi"]);
  withTempRoot((root) => {
    for (const id of HARNESS_IDS) {
      const env: NodeJS.ProcessEnv = {};
      const plan = applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY[id],
        sessionId: `s-${id}`,
        primer: "P",
        rootDir: root,
      });
      assert.equal(
        plan !== undefined,
        gated.includes(id),
        `${id}: gate disagrees with its primerChannel cell`,
      );
    }
  });
});

test("an agent command the descriptor cannot classify gets nothing", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: "some-unknown-adapter --acp",
      sessionId: "s1",
      primer: "P",
      rootDir: root,
    });
    assert.equal(plan, undefined);
    assert.deepEqual(Object.keys(env), ["PATH"]);
  });
});

test("the catalogue key strips the provider prefix — a prefixed key is never looked up", () => {
  withTempRoot((root) => {
    const env = piIsolatedEnv(root, { piKnows: [] });
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_2",
      provisionModelId: "openrouter/anthropic/claude-haiku-4.5",
      rootDir: root,
    });
    // Assert the var EXISTS before reading through it: without this the probe
    // could throw on undefined and read as a broken test rather than a missing
    // config dir.
    assert.ok(env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR unset — nothing to inspect");
    const store = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "models-store.json"), "utf8"),
    ) as { openrouter: { models: { id: string }[] } };
    const keys = store.openrouter.models.map((m) => m.id);
    assert.deepEqual(keys, ["anthropic/claude-haiku-4.5"]);
    // The failure this pins: an entry keyed `openrouter/...` is never looked up,
    // and the resulting local "model not found" reads exactly like the
    // un-provisioned case it was meant to fix.
    assert.equal(
      keys.some((key) => key.startsWith("openrouter/")),
      false,
    );
  });
});

// ── Pi ───────────────────────────────────────────────────────────────────────

test("pi gets PI_CODING_AGENT_DIR and an APPEND_SYSTEM.md primer", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi",
      primer: "NV-PI-PRIMER",
      rootDir: root,
    });
    assert.ok(plan);
    assert.deepEqual(plan.envNames, ["PI_CODING_AGENT_DIR"]);
    assert.ok(env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR unset — the session is NOT isolated");
    assert.equal(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "APPEND_SYSTEM.md"), "utf8"),
      "NV-PI-PRIMER",
    );
  });
});

// ── THE EXTENSIONS SEED (brick af6907f4): the box-level ~/.pi/agent/extensions
// dir must reach an acpx-spawned pi session WITHOUT per-session planting.

/**
 * The file-extension fixture's contents.
 *
 * ⚠️ IT MUST EXPORT A DEFAULT, AND THE MARKER ALONE IS NOT ENOUGH (brick 074a1bd9).
 * This fixture was `"// FILE-EXTENSION-MARKER\n"` — a comment-only module — which
 * is not merely unrepresentative of a real extension, it is the exact shape that
 * KILLS a live pi session: pi 0.84.4 refuses to start on a module with no default
 * export (`Extension does not export a valid factory function`, exit 1), and every
 * `acpx pi sessions new` on such a box failed. These rows stayed green through all
 * of it because they stop at the copy and never start a pi. A fixture that models
 * "a box deploy" must model one pi can actually LOAD; the non-loadable shape now
 * has a row of its own that says so out loud.
 */
const LOADABLE_EXTENSION_SOURCE = "// FILE-EXTENSION-MARKER\nexport default () => {}\n";

/** The measured killer: a module pi cannot load, because it exports no default. */
const NON_LOADABLE_EXTENSION_SOURCE = "export const notAFactory = 1\n";

/**
 * Fixture: a box HOME whose `.pi/agent/extensions/` holds exactly what a box
 * deploy would (a file extension, a subdir-with-index extension, and junk that
 * pi would NOT load). Returns the HOME path.
 */
function withBoxExtensions(root: string): string {
  const boxHome = join(root, "box-home");
  const extDir = join(boxHome, ".pi", "agent", "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "pi-full-output.js"), LOADABLE_EXTENSION_SOURCE);
  mkdirSync(join(extDir, "pkg-ext"), { recursive: true });
  writeFileSync(join(extDir, "pkg-ext", "index.ts"), "export default () => {}\n");
  mkdirSync(join(extDir, "not-an-extension"), { recursive: true }); // no index, no pi pkg
  writeFileSync(join(extDir, "README.md"), "docs, not code");
  return boxHome;
}

test("pi provisioning seeds extensions/ from the box-level dir WITHOUT planting", () => {
  // The test that would have caught the original gap (brick af6907f4): acpx
  // re-points PI_CODING_AGENT_DIR, so a box deploy under ~/.pi/agent was
  // invisible to every acpx session. This row pins the channel at the
  // provisioning boundary — see the file-top boundary note for what it does
  // NOT prove (that pi READS it is the live rig's / e2e evidence's job).
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    const env: NodeJS.ProcessEnv = { HOME: boxHome, PATH: "" };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_ext",
      primer: "P",
      rootDir: root,
    });
    assert.ok(env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR unset — nothing to inspect");
    const seeded = join(env.PI_CODING_AGENT_DIR, "extensions");
    assert.ok(existsSync(seeded), "extensions/ not seeded into the session dir");
    // The file extension arrived byte-for-byte.
    assert.equal(
      readFileSync(join(seeded, "pi-full-output.js"), "utf8"),
      LOADABLE_EXTENSION_SOURCE,
    );
    // The subdir extension arrived recursively; non-extensions did not.
    assert.ok(existsSync(join(seeded, "pkg-ext", "index.ts")), "subdir extension not seeded");
    assert.equal(existsSync(join(seeded, "not-an-extension")), false, "junk dir was seeded");
    assert.equal(existsSync(join(seeded, "README.md")), false, "non-code file was seeded");
  });
});

test("pi extension seeding: no box-level dir is a silent no-op, never an error", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = { HOME: join(root, "empty-home") };
    mkdirSync(env.HOME!, { recursive: true });
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_noext",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan);
    // brick 5fee840d: the dir now also carries acpx's OWN live-routing
    // extension, so "no box dir" no longer means "no extensions dir" — the
    // invariant that survives is "no box junk was seeded, and nothing errored":
    // exactly one seeded entry, the builtin.
    assert.deepEqual(
      plan.piExtensions?.map((entry) => entry.target.endsWith("acpx-openrouter-routing.js")),
      [true],
    );
  });
});

test("pi extension seeding opt-out: ACPX_PI_EXTENSIONS_SEED=off seeds nothing", () => {
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    const env: NodeJS.ProcessEnv = { HOME: boxHome, ACPX_PI_EXTENSIONS_SEED: "off" };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_killoff",
      primer: "P",
      rootDir: root,
    });
    assert.equal(
      existsSync(join(env.PI_CODING_AGENT_DIR!, "extensions")),
      false,
      "kill-switch did not suppress the seed",
    );
  });
});

// ⚠️ THE ROW THAT STOOD HERE ASSERTED THE DEFECT (brick://f24f6644). It was
// "a nested spawn inherits the PARENT's extensions", and its comment called an
// incoming `PI_CODING_AGENT_DIR` the source "so what the parent sees, the child
// sees". A parent session's provisioned dir is a THROWAWAY — removed at the
// parent's terminal close and by the orphan sweep — so that chain seeds a child
// from a directory that is about to disappear, and from whatever the parent
// happened to be seeded with rather than from the box. The three rows below
// replace it: refuse a per-session dir, honour a real box relocation, honour the
// explicit override. The middle one is what the old row was actually worth.

test("pi extension seeding: an inherited acpx PER-SESSION dir is NOT the source", () => {
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    // The production shape: a pi child of a pi parent inherits the parent's
    // provisioned dir, `acpx-pi-<id>` — named by the same scheme this module
    // composes, because that name is exactly what the refusal keys on.
    const parentDir = join(root, "acpx-pi-01a08859-0303-7ce0-8d40-cf15cf90dbdf");
    mkdirSync(join(parentDir, "extensions"), { recursive: true });
    writeFileSync(join(parentDir, "extensions", "parent-only.js"), "export default () => {}\n");
    const env: NodeJS.ProcessEnv = { HOME: boxHome, PI_CODING_AGENT_DIR: parentDir };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_nested",
      primer: "P",
      rootDir: root,
    });
    const seeded = join(env.PI_CODING_AGENT_DIR!, "extensions");
    // The BOX dir was the source …
    // Assert against the CONSTANT the fixture writes, never a re-typed literal:
    // this row was authored against the pre-074a1bd9 comment-only fixture and
    // broke at the f24f6644 × 074a1bd9 merge, when that brick repaired
    // `withBoxExtensions` to write a module pi can actually load. The
    // discriminator is unchanged — box content here, `parent-only.js` below.
    assert.equal(
      readFileSync(join(seeded, "pi-full-output.js"), "utf8"),
      LOADABLE_EXTENSION_SOURCE,
      "the box extensions dir was not the source",
    );
    // … and nothing came from the parent's throwaway dir.
    assert.equal(
      existsSync(join(seeded, "parent-only.js")),
      false,
      "seeded from the PARENT's per-session dir — that dir dies at the parent's close",
    );
  });
});

test("pi extension seeding: a REAL box-level PI_CODING_AGENT_DIR is still honoured", () => {
  // The refusal above is name-based, not a blanket ignore: a box that
  // legitimately relocates pi's agent dir must keep reaching its extensions.
  withTempRoot((root) => {
    const boxAgentDir = join(root, "opt-pi-agent");
    mkdirSync(join(boxAgentDir, "extensions"), { recursive: true });
    writeFileSync(join(boxAgentDir, "extensions", "relocated.js"), "export default () => {}\n");
    const env: NodeJS.ProcessEnv = {
      HOME: join(root, "home-without-extensions"),
      PI_CODING_AGENT_DIR: boxAgentDir,
    };
    mkdirSync(env.HOME!, { recursive: true });
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_relocated",
      primer: "P",
      rootDir: root,
    });
    assert.equal(
      readFileSync(join(env.PI_CODING_AGENT_DIR!, "extensions", "relocated.js"), "utf8"),
      "export default () => {}\n",
    );
  });
});

test("pi extension seeding: ACPX_PI_BOX_AGENT_DIR wins over an inherited one", () => {
  // The leg a LIVE probe can see on the pre-fix build (brick://f24f6644): the
  // spawn-env scrub in auth-env.ts already deletes an inherited PER-SESSION
  // value, so the row above cannot fail end-to-end today — but the override was
  // ignored by this channel alone while every other pi consumer honoured it.
  withTempRoot((root) => {
    const override = join(root, "override-agent");
    mkdirSync(join(override, "extensions"), { recursive: true });
    writeFileSync(join(override, "extensions", "from-override.js"), "export default () => {}\n");
    const inherited = join(root, "inherited-agent");
    mkdirSync(join(inherited, "extensions"), { recursive: true });
    writeFileSync(join(inherited, "extensions", "from-inherited.js"), "export default () => {}\n");
    const env: NodeJS.ProcessEnv = {
      HOME: join(root, "home-without-extensions"),
      ACPX_PI_BOX_AGENT_DIR: override,
      PI_CODING_AGENT_DIR: inherited,
    };
    mkdirSync(env.HOME!, { recursive: true });
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_override",
      primer: "P",
      rootDir: root,
    });
    const seeded = join(env.PI_CODING_AGENT_DIR!, "extensions");
    assert.ok(existsSync(join(seeded, "from-override.js")), "the box override was not the source");
    assert.equal(
      existsSync(join(seeded, "from-inherited.js")),
      false,
      "seeded from PI_CODING_AGENT_DIR while an explicit box override was set",
    );
  });
});

test("pi extension seeding snapshots — edits to the box dir after provisioning do not leak in", () => {
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    const env: NodeJS.ProcessEnv = { HOME: boxHome };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_snap",
      primer: "P",
      rootDir: root,
    });
    const seeded = join(env.PI_CODING_AGENT_DIR!, "extensions");
    // Post-provision box edits must NOT appear in the running session's dir.
    writeFileSync(join(boxHome, ".pi", "agent", "extensions", "late.js"), "// LATE\n");
    assert.equal(existsSync(join(seeded, "late.js")), false, "seed is not a snapshot");
  });
});

// ── brick 074a1bd9: a box extension pi CANNOT LOAD took down every
// `acpx pi sessions new` with `Cannot call write after a stream was destroyed`.
// Seeding cannot vet loadability (see seedPiExtensions' own note), so the bar is
// that the failure names the file and the way out.

test("074a1bd9: a NON-LOADABLE box extension is still seeded — and RECORDED with its box source", () => {
  // Deliberately still seeded: acpx copies by pi's DISCOVERY grammar and does not
  // judge loadability. What changes is that the pair is recorded, which is the
  // only reason the failure can later be traced back to a file the operator owns.
  withTempRoot((root) => {
    const boxHome = join(root, "broken-home");
    const extDir = join(boxHome, ".pi", "agent", "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "half-written.js"), NON_LOADABLE_EXTENSION_SOURCE);
    const env: NodeJS.ProcessEnv = { HOME: boxHome };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_broken",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan);
    const target = join(env.PI_CODING_AGENT_DIR!, "extensions", "half-written.js");
    assert.equal(existsSync(target), true, "the entry was not seeded");
    // brick 5fee840d: acpx's own live-routing extension is seeded alongside
    // every box extension, so the recorded list is the box pair PLUS the
    // builtin. The box pair's source stays the assertion — that is the
    // traceability this row exists for.
    assert.deepEqual(
      plan.piExtensions?.filter((entry) => entry.source.endsWith("half-written.js")),
      [{ source: join(extDir, "half-written.js"), target }],
    );
  });
});

test("074a1bd9: a failure naming a seeded extension is traced to the BOX file and the kill-switch", () => {
  withTempRoot((root) => {
    const boxHome = join(root, "broken-home-2");
    const extDir = join(boxHome, ".pi", "agent", "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "half-written.js"), NON_LOADABLE_EXTENSION_SOURCE);
    const env: NodeJS.ProcessEnv = { HOME: boxHome };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_broken_msg",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan?.piExtensions?.length);

    // pi 0.84.4's measured wording for exactly this file, naming the path IT read
    // — the acpx-provisioned copy, which is all pi can possibly know about.
    const target = plan.piExtensions[0].target;
    const piSaid =
      `Could not start pi: it exited during startup (code=1). pi reported:\n` +
      `Error: Failed to load extension "${target}": Extension does not export a valid factory function: ${target}\n` +
      `Hint: Start without extensions using "pi -ne".`;

    const hint = describePiExtensionSeedFailure(piSaid, plan.piExtensions);
    assert.ok(hint, "a failure naming a seeded extension produced no diagnosis");
    assert.ok(hint.includes(join(extDir, "half-written.js")), `no box source in: ${hint}`);
    assert.ok(hint.includes("ACPX_PI_EXTENSIONS_SEED=off"), `no kill-switch in: ${hint}`);
  });
});

test("074a1bd9: an unrelated failure gets NO extension diagnosis — the two-sided control", () => {
  // Without this row a `describePiExtensionSeedFailure` that returned the hint
  // unconditionally would pass the row above and bolt an irrelevant extension
  // story onto every auth failure, timeout and network error.
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    const env: NodeJS.ProcessEnv = { HOME: boxHome };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_unrelated",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan?.piExtensions?.length, "control: nothing was seeded, so this proves nothing");
    assert.equal(
      describePiExtensionSeedFailure("Authentication required: missing key", plan.piExtensions),
      undefined,
    );
  });
});

test("074a1bd9: with seeding OFF there is nothing to blame — no diagnosis, whatever the text", () => {
  withTempRoot((root) => {
    const boxHome = withBoxExtensions(root);
    const env: NodeJS.ProcessEnv = { HOME: boxHome, ACPX_PI_EXTENSIONS_SEED: "off" };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_offdiag",
      primer: "P",
      rootDir: root,
    });
    assert.deepEqual(plan?.piExtensions, []);
    assert.equal(
      describePiExtensionSeedFailure(
        'Error: Failed to load extension "/anything/at/all.js"',
        plan?.piExtensions,
      ),
      undefined,
    );
  });
});

test("GUARDRAIL: the extensions seed adds nothing for claude/codex dirs", () => {
  withTempRoot((root) => {
    withBoxExtensions(root);
    for (const agentCommand of [CLAUDE, CODEX]) {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: root };
      const plan = applyHarnessConfigDir({
        env,
        agentCommand,
        sessionId: `s-${agentCommand.slice(0, 8)}`,
        primer: "P",
        rootDir: root,
      });
      assert.equal(plan, undefined, `${agentCommand}: planned a dir`);
    }
  });
});

test("pi DOES get a generated models-store.json now that the merge semantics are measured", () => {
  // ⚠️ THIS ROW REPLACES ONE THAT ASSERTED THE ABSENCE, AND THE REVERSAL IS THE
  // POINT. The old row said writing the file risked REPLACING pi's ~371-entry
  // catalogue. Measured against pi 0.84.4 (brick ef5999ca): it MERGES BY ID —
  // 333 offered models became 334 with a one-entry file planted, a pre-existing
  // slug still resolved, and 333 came back after restore.
  withTempRoot((root) => {
    // HERMETIC (brick ff298f02): the box overlay and pi's knowledge are both
    // INJECTED. `zzz/not-in-any-catalogue` is a slug pi does not know, so case 3
    // ("pi already knows it ⇒ write nothing") does not apply here and the
    // reversal this row encodes is unaffected — only its dependence on the box
    // is removed. The row below asserts the injection is load-bearing.
    const env = piIsolatedEnv(root, { piKnows: ["some/model-pi-really-does-know"] });
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi2",
      primer: "P",
      provisionModelId: "openrouter/zzz/not-in-any-catalogue",
      rootDir: root,
    });
    assert.ok(
      env.PI_CODING_AGENT_DIR,
      "PI_CODING_AGENT_DIR unset — the reads below would be of nothing",
    );

    const written = readdirSync(env.PI_CODING_AGENT_DIR);
    // Same split as the row this replaces: acpx's own bookkeeping is judged apart
    // from what the harness consumes, so a NEW entry in either still fails here.
    const harnessVisible = written.filter((entry) => !entry.startsWith("."));
    // `settings.json` joined this list with the pi stall policy (brick 3437c6b5),
    // and `models.json` with the catalogue-refresh fix (brick 626f56f5) — pi
    // OVERWRITES `models-store.json` on a refresh, so the durable copy of the
    // provisioned slug and the Anthropic base-URL repair lives in the config file
    // pi only ever reads.
    // The row failing on a new entry is the contract working, not a nuisance: it
    // is the only thing that notices acpx quietly adding a file to a directory a
    // harness reads, so it is UPDATED here rather than loosened.
    assert.deepEqual(harnessVisible.toSorted(), [
      "APPEND_SYSTEM.md",
      // brick 5fee840d: acpx's own live-routing extension now lives here too.
      "extensions",
      "models-store.json",
      "models.json",
      "settings.json",
    ]);
    assert.deepEqual(
      written.filter((entry) => entry.startsWith(".")),
      [".acpx-holders"],
      "acpx wrote unexpected bookkeeping into a directory the harness reads",
    );

    const store = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "models-store.json"), "utf8"),
    ) as { openrouter: { lastModified: number; models: { id: string; baseUrl: string }[] } };

    // ⚠️ THE FIELD THAT MAKES THE FILE DO ANYTHING AT ALL. Without a
    // `lastModified` newer than the bundled stamp, `remoteModels()` returns []
    // and the entry is IGNORED — measured 333 → 333, slug not offered, no error
    // anywhere. A test that only checked the slug is present in the file would
    // pass on a file pi silently discards.
    assert.ok(
      store.openrouter.lastModified > Date.now() - 60_000,
      "the store carries no fresh lastModified — pi would ignore it entirely",
    );
    assert.deepEqual(
      store.openrouter.models.map((m) => m.id),
      ["zzz/not-in-any-catalogue"],
    );
    assert.equal(store.openrouter.models[0].baseUrl, "https://openrouter.ai/api/v1");
  });
});

test("a provisioned pi session's stall policy keeps the WORST-CASE DEAD AIR inside the 5-minute target", () => {
  // 🛑 WHAT THIS ROW DOES NOT PROVE, SAID FIRST SO NOBODY READS MORE INTO IT.
  // It does NOT prove the bound fires. A config carrying a number and a timeout
  // that actually triggers are different claims, and only one of them is
  // checkable without a provider. The BEHAVIOURAL proof is a rig that drives pi
  // 0.84.4's own `configureHttpDispatcher` against a stalling SSE server —
  // brick 3437c6b5, `verification/evidence/keepalive-idle-bound-run2.log`:
  // zero-byte stall fires at 10 506 ms against a 10 000 ms bound; a
  // keepalive-emitting stall NEVER fires; keepalives-then-silence fires at
  // last-byte + the bound.
  //
  // What it DOES pin is the thing a future edit is most likely to break silently:
  // the two settings are not independent, and the number that matters is neither
  // of them alone but the WORST-CASE TOTAL they imply. Raising the idle bound back
  // toward pi's 300 000 default, or adding a retry "for resilience", blows the
  // budget while every individual value still looks reasonable in review.
  withTempRoot((root) => {
    const env = piIsolatedEnv(root, { piKnows: [] });
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi_stall",
      primer: "P",
      rootDir: root,
    });
    assert.ok(
      env.PI_CODING_AGENT_DIR,
      "PI_CODING_AGENT_DIR unset — the read below would be of nothing",
    );

    const settings = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
    ) as { httpIdleTimeoutMs: number; retry: { maxRetries: number; baseDelayMs?: number } };

    // ⚠️ THIS ROW FIRED EXACTLY AS ITS OLD COMMENT PROMISED IT WOULD. It used to
    // assert `baseDelayMs === undefined` and explain that "if a later change starts
    // setting it, this arithmetic is no longer reading the value pi will actually use,
    // and the row must be updated rather than quietly becoming wrong." Brick bb23a7fa
    // set it, this went red, and it is updated here — the contract working, not a
    // nuisance.
    //
    // The budget must now read the EMITTED base delay, because pi's default (2 000)
    // and ours (500) differ by 190 s across 8 attempts: at 2 000 the same attempt
    // count would blow the target on backoff alone. Falling back to the default when
    // the field is absent keeps the row honest either way.
    const PI_DEFAULT_BASE_DELAY_MS = 2_000;
    const baseDelayMs = settings.retry.baseDelayMs ?? PI_DEFAULT_BASE_DELAY_MS;
    assert.ok(
      baseDelayMs > 0,
      `baseDelayMs ${baseDelayMs} must be positive — pi multiplies it by 2^(n-1)`,
    );

    // `agent-session.js:2279-2291`: attempts = 1 + maxRetries, backoff = base·2^(n-1).
    // Calibration: pi's OWN defaults (300 000, 3) give 1 214 000 ms — and the
    // incident that prompted this was measured at 20 m 15 s. The formula
    // reproduces the bug it is protecting against, which is what makes it a
    // budget and not an arbitrary inequality.
    const worstCaseMs = (idleMs: number, maxRetries: number): number =>
      idleMs * (1 + maxRetries) + baseDelayMs * (2 ** maxRetries - 1);

    assert.equal(
      300_000 * 4 + PI_DEFAULT_BASE_DELAY_MS * (2 ** 3 - 1),
      1_214_000,
      "the budget formula no longer reproduces the 20m14s default it was derived from",
    );

    const budgetMs = worstCaseMs(settings.httpIdleTimeoutMs, settings.retry.maxRetries);
    assert.ok(
      budgetMs <= 300_000,
      `worst-case dead air is ${budgetMs} ms (idle ${settings.httpIdleTimeoutMs} ms x ${
        1 + settings.retry.maxRetries
      } attempts) — over the 300 000 ms target this policy exists to hold`,
    );
    // ── The lower bound: the other half of the trade, RE-DERIVED (brick bb23a7fa) ──
    //
    // This row used to demand ≥ 60 000, to protect "a model that is genuinely slow to
    // first token". **That model was never measured, and the measurement killed it:**
    // the distribution is bimodal — every healthy request completed in 0.9–6.05 s and
    // every failure delivered nothing, ever (no request has been observed arriving
    // between 6 s and 615 s). There is no slow-but-alive request for a long bound to
    // rescue; a longer bound only makes a REFUSAL take longer to report.
    //
    // ⚠️ BUT THE FLOOR STILL EXISTS, ON A DIFFERENT AXIS — and it is the one that
    // nearly caught me out. `httpIdleTimeoutMs` is a per-byte INACTIVITY timer, so
    // what binds is the largest gap BETWEEN chunks of a healthy stream, not the
    // longest healthy turn. Measured on Daniel's session 01a0827e (~85 KB streamed):
    // gaps of 5.06 / 1.25 / 7.66 / 1.20 s. **7.66 s is the number to clear**, and a
    // 10 s bound sized off the 6.05 s figure would have had only 1.3× headroom.
    const LARGEST_HEALTHY_INTER_CHUNK_GAP_MS = 7_660;
    assert.ok(
      settings.httpIdleTimeoutMs >= 2 * LARGEST_HEALTHY_INTER_CHUNK_GAP_MS,
      `idle bound ${settings.httpIdleTimeoutMs} ms gives under 2x headroom over the largest ` +
        `MEASURED healthy inter-chunk gap (${LARGEST_HEALTHY_INTER_CHUNK_GAP_MS} ms) — that cuts ` +
        `working streams mid-response, which is invisible until a user reports it`,
    );
    // And the detector must still be fast enough to be a detector: the failure it
    // meets is a refusal, and spending minutes on one is what shipped and cost
    // Daniel an evening.
    assert.ok(
      settings.httpIdleTimeoutMs <= 60_000,
      `idle bound ${settings.httpIdleTimeoutMs} ms is a WAIT, not a detector — a throttled ` +
        `request delivers zero bytes forever, so waiting longer recovers nothing`,
    );
  });
});

test("HERMETICITY CONTROL: pi provisioning reads the INJECTED state, in both directions", () => {
  // 🛑 THE ROW ABOVE IS ONLY HERMETIC IF THE INJECTED STATE IS WHAT IT READS.
  // Asserting "the fixture is isolated" proves nothing on its own — an isolated
  // fixture and an IGNORED fixture produce the same green. So this row varies the
  // injected state and requires the OUTCOME to move with it. A row that only
  // checked the happy path would pass just as well against the box.
  withTempRoot((root) => {
    // (a) pi does NOT know the slug, and the injected box overlay is EMPTY ⇒ an
    //     entry is written, and it is the ONLY one.
    const notKnown = piIsolatedEnv(root, { piKnows: ["some/other-model"] });
    applyHarnessConfigDir({
      env: notKnown,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi_ctl_a",
      provisionModelId: "openrouter/zzz/not-in-any-catalogue",
      rootDir: root,
    });
    const storeA = join(notKnown.PI_CODING_AGENT_DIR as string, "models-store.json");
    assert.ok(existsSync(storeA), "(a) pi does not know the slug — an entry must be written");
    assert.deepEqual(
      (
        JSON.parse(readFileSync(storeA, "utf8")) as { openrouter: { models: { id: string }[] } }
      ).openrouter.models.map((m) => m.id),
      ["zzz/not-in-any-catalogue"],
    );
  });

  withTempRoot((root) => {
    // (b) THE SAME CALL, varying ONLY the injected pi knowledge ⇒ NO FILE AT ALL.
    //     This is the discriminator: if the row were reading the box instead of
    //     the fixture, flipping the fixture could not change the outcome.
    const known = piIsolatedEnv(root, { piKnows: ["zzz/not-in-any-catalogue"] });
    applyHarnessConfigDir({
      env: known,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi_ctl_b",
      provisionModelId: "openrouter/zzz/not-in-any-catalogue",
      rootDir: root,
    });
    assert.equal(
      existsSync(join(known.PI_CODING_AGENT_DIR as string, "models-store.json")),
      false,
      "(b) pi already knows the slug and the overlay is empty — no store may be written",
    );
  });

  withTempRoot((root) => {
    // (c) The BOX-overlay lever, proven through the injected HOME rather than
    //     through PI_CODING_AGENT_DIR. A planted entry that could only have come
    //     from the fixture must appear in the generated store — which is what
    //     rules out `/home/node` as the source.
    const planted = piIsolatedEnv(root, {
      piKnows: [],
      boxCatalogue: [
        {
          id: "planted/only-in-the-injected-home",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      ],
    });
    applyHarnessConfigDir({
      env: planted,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi_ctl_c",
      provisionModelId: "openrouter/zzz/not-in-any-catalogue",
      rootDir: root,
    });
    const ids = (
      JSON.parse(
        readFileSync(join(planted.PI_CODING_AGENT_DIR as string, "models-store.json"), "utf8"),
      ) as { openrouter: { models: { id: string }[] } }
    ).openrouter.models.map((m) => m.id);
    assert.deepEqual(ids.toSorted(), [
      "planted/only-in-the-injected-home",
      "zzz/not-in-any-catalogue",
    ]);
  });
});

test("provisioning COPIES the box catalogue forward and repairs the Anthropic baseUrl by id", () => {
  // Two failures in one row, both measured:
  //  1. writing ONLY the slug costs the session every model pi had cached
  //     (374 offered → 334 — the per-session file replaces the box's overlay
  //     block), and overwrites a KNOWN slug's real metadata with guesses.
  //  2. pi's 15 `anthropic-messages` entries carry `https://openrouter.ai/api`
  //     with no `/v1`, so the request 404s. Because the merge is BY ID, patching
  //     the copied entry repairs it instead of adding a second one.
  withTempRoot((root) => {
    const boxAgentDir = join(root, "box-pi-agent");
    mkdirSync(boxAgentDir, { recursive: true });
    writeFileSync(
      join(boxAgentDir, "models-store.json"),
      JSON.stringify({
        openrouter: {
          lastModified: 1,
          models: [
            {
              id: "anthropic/claude-opus-5",
              api: "anthropic-messages",
              baseUrl: "https://openrouter.ai/api",
              contextWindow: 1_000_000,
            },
            {
              id: "z-ai/glm-5.3-flash",
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              thinkingLevelMap: { off: null },
              contextWindow: 262_144,
            },
          ],
        },
      }),
    );

    // Hermetic like the rows above. `PI_CODING_AGENT_DIR` is THIS row's lever for
    // the overlay, but the KNOWLEDGE read is a second, independent box read: with
    // no cache path and no HOME it resolves the real `/home/node` and then tries
    // to spawn pi (brick ff298f02). Both are pinned here.
    const knowledgeCache = join(root, "pi-knowledge.json");
    writeFileSync(knowledgeCache, JSON.stringify({ fetchedAt: new Date().toISOString(), ids: [] }));
    resetPiKnowledgeMemo();
    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: boxAgentDir,
      ACPX_PI_KNOWLEDGE_CACHE: knowledgeCache,
      HOME: join(root, "box-home"),
      PATH: "",
    };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi3",
      provisionModelId: "openrouter/z-ai/glm-5.3-flash",
      rootDir: root,
    });

    const store = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR as string, "models-store.json"), "utf8"),
    ) as {
      openrouter: {
        models: {
          id: string;
          baseUrl: string;
          contextWindow?: number;
          thinkingLevelMap?: unknown;
        }[];
      };
    };
    const byId = new Map(store.openrouter.models.map((m) => [m.id, m]));

    assert.equal(store.openrouter.models.length, 2, "the box catalogue was not carried forward");
    assert.equal(
      byId.get("anthropic/claude-opus-5")?.baseUrl,
      "https://openrouter.ai/api/v1",
      "the Anthropic entry was not repaired",
    );
    // The requested model was ALREADY in the catalogue: it must keep pi's own
    // metadata, not be replaced by a generic entry. `thinkingLevelMap` is the
    // one that matters most — the depth ladder is derived from it.
    assert.equal(byId.get("z-ai/glm-5.3-flash")?.contextWindow, 262_144);
    assert.deepEqual(byId.get("z-ai/glm-5.3-flash")?.thinkingLevelMap, { off: null });
  });
});

test("pi's arbitrary-model support is ROUTED — but still PER HARNESS, never by KIND", () => {
  // The descriptor consequence of the rows above, asserted rather than assumed.
  //
  // ⚠️ THIS ROW IS WHY A NAME-BASED SWEEP IS NOT A PROPERTY SWEEP. Routing a
  // harness here has been done by grepping for
  // `ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR` and `harnessProvisionsModelCatalogue`
  // across src/ and test/. That finds two files. It does NOT find this one, because
  // this row asserts the DERIVED PROPERTY and never names the constant — so it
  // goes red in the gate rather than in the edit. Keep it that way: a guard that
  // is only reachable by running it is doing work the greps cannot.
  //
  // ⚠️ THE SECOND ASSERTION IS THE LOAD-BEARING ONE. The original defect was
  // routing the KIND: `arbitraryModelSupport: "provisioned"` switching a harness
  // on from a DIFFERENT harness's measurement, taken against a config format it
  // does not share. So the row hands the derivation a harness that declares the
  // same KIND while the provisioned list names only pi, and requires `false`.
  // Delete that and the row can no longer tell "provisioned is enough" from
  // "this harness was measured".
  assert.equal(HARNESS_FACTS.pi.arbitraryModelSupport, "provisioned");
  assert.equal(deriveHarnessCapabilities(HARNESS_FACTS.pi).acceptsArbitraryModelIds, true);
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", "codex", [], ["pi"]),
    false,
    "the KIND alone must never decide it — with only pi provisioned, an identical kind on another harness is false",
  );
});

// ── Degradation ──────────────────────────────────────────────────────────────

test("no primer and no model still yields a dir and the env vars", () => {
  // The dir is the isolation boundary as well as the primer carrier: without the
  // env vars the harness falls back to /home/node and writes global state there
  // (measured twice during I1's own cleanup).
  withTempRoot((root) => {
    const env = piIsolatedEnv(root, { piKnows: [] });
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_3",
      rootDir: root,
    });
    assert.ok(plan);
    assert.ok(env.PI_CODING_AGENT_DIR);
    // No primer and no model ⇒ no APPEND_SYSTEM.md and no models-store.json.
    // The two UNCONDITIONAL files are the whole content: the stall policy
    // (`settings.json`, brick 3437c6b5) and the Anthropic base-URL repair
    // (`models.json`, brick 626f56f5) — the latter because a session that named no
    // model can still `session/set_model` onto one of pi's 15 broken
    // `anthropic-messages` rows, measured to return an empty turn.
    assert.deepEqual(
      readdirSync(env.PI_CODING_AGENT_DIR)
        .filter((entry) => !entry.startsWith("."))
        .toSorted(),
      // brick 5fee840d: the live-routing extension joins the unconditional set.
      ["extensions", "models.json", "settings.json"],
    );
    // …and with nothing to provision it carries ONLY the repair, never a
    // fabricated `models[]` that would shadow a real row.
    assert.deepEqual(
      JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), "utf8")),
      { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } },
    );
  });
});

test("two sessions get two different directories", () => {
  withTempRoot((root) => {
    const a: NodeJS.ProcessEnv = {};
    const b: NodeJS.ProcessEnv = {};
    applyHarnessConfigDir({
      env: a,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_a",
      rootDir: root,
    });
    applyHarnessConfigDir({
      env: b,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_b",
      rootDir: root,
    });
    assert.notEqual(a.PI_CODING_AGENT_DIR, b.PI_CODING_AGENT_DIR);
  });
});

// ── F-8 (brick 161294ce): no shared literal, and a blank id is REFUSED ───────

test("a BLANK session id is REFUSED — no dir, no env, no shared literal", () => {
  // ⚠️ THE DEFECT THIS PINS SHIPPED. The call site read
  // `acpxRecordId?.trim() || "session"`, and on the real `sessions new` path the
  // record id is EMPTY at adapter-spawn time (`creationSessionContext` sets
  // `acpxRecordId: ""`, because the CLI record id IS the adapter's own
  // session/new id and cannot exist before the spawn that produces it). So the
  // literal fired on EVERY create and two distinct sessions were handed the same
  // `/tmp/acpx-<harness>-session`.
  //
  // A fallback that silently de-isolates is worse than an error, so there is no
  // fallback: a blank id refuses.
  withTempRoot((root) => {
    for (const id of ["pi"] as const) {
      for (const blank of ["", "   "]) {
        const env: NodeJS.ProcessEnv = {};
        const plan = applyHarnessConfigDir({
          env,
          agentCommand: AGENT_REGISTRY[id],
          sessionId: blank,
          primer: "P",
          rootDir: root,
        });
        assert.equal(plan, undefined, `${id}: a blank id produced a plan`);
        assert.deepEqual(Object.keys(env), [], `${id}: a blank id set env vars`);
      }
    }
    // NOTHING was written — and the directory listing is the evidence, not the
    // absence of a return value.
    assert.deepEqual(readdirSync(root), []);
  });
});

test("two spawns of the SAME session id share a dir; different ids never do", () => {
  withTempRoot((root) => {
    const a: NodeJS.ProcessEnv = {};
    const b: NodeJS.ProcessEnv = {};
    const c: NodeJS.ProcessEnv = {};
    const mk = (env: NodeJS.ProcessEnv, sessionId: string) =>
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.pi,
        sessionId,
        primer: "P",
        rootDir: root,
      });
    assert.equal(mk(a, "same-id")?.dir, mk(b, "same-id")?.dir);
    assert.notEqual(mk(a, "same-id")?.dir, mk(c, "other-id")?.dir);
    // The literal is GONE: no directory is named for a constant.
    assert.equal(
      readdirSync(root).some((entry) => entry.endsWith("-session")),
      false,
      "a shared literal directory was created",
    );
  });
});

// ── 433f6bf8: cleanup — remove-on-close and the orphan sweep ────────────────

test("removeHarnessConfigDir deletes a config dir and REFUSES anything else", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_rm",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan);
    assert.equal(existsSync(plan.dir), true, "control: the dir must exist before removal");
    removeHarnessConfigDir(plan.dir);
    assert.equal(existsSync(plan.dir), false);

    // A path this module could never have created is left ALONE — otherwise a
    // caller passing the wrong string gets an arbitrary recursive delete.
    const foreign = join(root, "not-ours");
    mkdirSync(foreign, { recursive: true });
    removeHarnessConfigDir(foreign);
    assert.equal(existsSync(foreign), true, "a non-config directory was deleted");
  });
});

test("the orphan sweep removes dead dirs, RETAINS live ones, and prints its population", () => {
  withTempRoot((root) => {
    for (const [harness, id] of [
      ["pi", "live-1"],
      ["pi", "dead-1"],
      ["pi", "dead-2"],
    ] as const) {
      applyHarnessConfigDir({
        env: {},
        agentCommand: AGENT_REGISTRY[harness],
        sessionId: id,
        primer: "P",
        rootDir: root,
      });
    }
    // ⚠️ A DIRECTORY THAT IS NOT OURS. `cli/queue/paths.ts` creates
    // `/tmp/acpx-<hash>` for queue sockets — found by ENUMERATING the consumers
    // of this name, not by recalling them. The sweep must never touch it.
    const queueDir = join(root, "acpx-0a1b2c3d4e");
    mkdirSync(queueDir, { recursive: true });

    // ⚠️ UPDATED FOR cc9a5f25: removal now requires POSITIVE ownership, so the
    // sweep is told which records exist and whether they are CLOSED, and is given
    // a measured /proc census. "live-1" is retained because its record is OPEN —
    // previously it was retained merely by being in a set of ids.
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map([
        ["live-1", { closed: false }],
        ["dead-1", { closed: true }],
        ["dead-2", { closed: true }],
      ]),
      liveScan: {
        scanned: 40,
        environRead: 9,
        pids: new Set([1]),
        referencedDirs: new Set<string>(),
        referencedSessionIds: new Set<string>(),
      },
      rootDir: root,
    });

    // POPULATION FIRST: 0 scanned would mean NOT RUN, not clean.
    assert.equal(result.scanned, 3, "scanned population is wrong — the sweep saw the wrong set");
    assert.equal(result.removed.length, 2);
    assert.equal(result.retained, 1);
    assert.equal(result.retainedBy.openRecord, 1, "retained for the wrong reason");
    assert.equal(existsSync(queueDir), true, "the queue socket dir was swept — it is not ours");
    assert.equal(
      readdirSync(root).some((entry) => entry.endsWith("-live-1")),
      true,
      "a LIVE session's dir was removed",
    );
  });
});

test("the sweep on an unreadable root reports scanned=0 — NOT RUN, not clean", () => {
  const result = pruneOrphanHarnessConfigDirs({
    records: new Map(),
    liveScan: {
      scanned: 40,
      environRead: 9,
      pids: new Set([1]),
      referencedDirs: new Set<string>(),
      referencedSessionIds: new Set<string>(),
    },
    rootDir: "/nonexistent-hp-b3-root-zzz9",
  });
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.removed, []);
  // ⚠️ AND IT REPORTS THE REFUSAL (cc9a5f25). An unreadable root and a clean root
  // both produce "removed 0"; `notMeasured` is what distinguishes them.
  assert.equal(result.notMeasured, true);
});

// ── RS-14 (fa2e54ec): the recorded-path field, and its ABSENCE ──────────────

test("RS-14: setHarnessConfigDir leaves a no-config-dir record COMPLETELY untouched", () => {
  // ⚠️ ABSENT — not null, not {}. This runs with `undefined` on EVERY claude /
  // claude-pty / codex spawn, because only pi gets a config dir. An
  // unconditional `record.acpx = clone ?? {}` would give a record whose `acpx`
  // was previously absent an empty object, changing the record SHAPE for three
  // harnesses the programme requires untouched — and record shape is consumed by
  // parse, serialize, the index projection and the UI.
  for (const acpx of [undefined, {}, { current_model_id: "x" }]) {
    const record = { agentCommand: CLAUDE, ...(acpx ? { acpx } : {}) } as unknown as SessionRecord;
    const before = JSON.stringify(record);
    setHarnessConfigDir(record, undefined);
    assert.equal(JSON.stringify(record), before, `record changed for acpx=${JSON.stringify(acpx)}`);
  }
  // The scan a tester runs: no key named harness_config_dir at ANY depth.
  const record = { agentCommand: CLAUDE } as unknown as SessionRecord;
  setHarnessConfigDir(record, undefined);
  assert.equal(pathsContainKey(record, "harness_config_dir"), 0);
  // PLANTED CONTROL, same scanner: it CAN see the key when it is there.
  setHarnessConfigDir(record, "/tmp/acpx-pi-planted");
  assert.equal(pathsContainKey(record, "harness_config_dir"), 1, "the scanner is blind");
});

test("RS-14: a spawn that writes no dir CLEARS a stale recorded path", () => {
  // A stale path that still resolves is a silent WRONG answer — worse than a
  // miss — so it must not survive a spawn that produced no directory.
  const record = { agentCommand: CLAUDE } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-pi-old");
  assert.equal(record.acpx?.harness_config_dir, "/tmp/acpx-pi-old");
  setHarnessConfigDir(record, undefined);
  assert.equal(record.acpx?.harness_config_dir, undefined);
  assert.equal(pathsContainKey(record, "harness_config_dir"), 0);
});

test("RS-14: the recorded path SURVIVES the per-turn acpx-state clone", () => {
  // The leg that ate `depth_projection`. `cloneSessionAcpxState` is an allowlist
  // the turn path re-bases `record.acpx` off, so a field it does not name is
  // dropped on EVERY REAL TURN — silently, with typecheck and the unit suite
  // green. Asserted as a PROPERTY, not as a source-text presence check.
  const record = { agentCommand: AGENT_REGISTRY.pi } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-pi-survives");
  const cloned = cloneSessionAcpxState(record.acpx);
  assert.equal(cloned?.harness_config_dir, "/tmp/acpx-pi-survives");
});

// ── brick://cb214e48: `pi_session_dir`, the same field on the same three legs ──

test("cb214e48: pi_session_dir SURVIVES the per-turn acpx-state clone", () => {
  // ⚠️ THE LEG THAT HAS EATEN FOUR FIELDS. `cloneSessionAcpxState` is an allowlist
  // the turn path re-bases `record.acpx` off, so a field it does not name is
  // present at `sessions new` and NULL AFTER ONE PROMPT — with typecheck, lint and
  // the whole unit suite green, because no in-memory test takes the turn leg.
  // Asserted as a PROPERTY here; proven through a REAL TURN in the brick's
  // verification evidence, because this row alone cannot see the turn path.
  const record = { agentCommand: AGENT_REGISTRY.pi } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-pi-dir", "/home/node/.pi/agent/sessions/--workspace--");
  const cloned = cloneSessionAcpxState(record.acpx);
  assert.equal(cloned?.pi_session_dir, "/home/node/.pi/agent/sessions/--workspace--");
  // And the field it sits beside must not have been traded for it.
  assert.equal(cloned?.harness_config_dir, "/tmp/acpx-pi-dir");
});

test("cb214e48: a spawn that hands pi no session dir CLEARS a stale one", () => {
  // Same rule as harness_config_dir above, and for the same reason: a stale path
  // that still resolves is a silent WRONG answer. The resume-failure message names
  // this directory, so a stale value would send the reader to the wrong store.
  const record = { agentCommand: AGENT_REGISTRY.pi } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-pi-dir", "/home/node/.pi/agent/sessions/--old--");
  assert.equal(record.acpx?.pi_session_dir, "/home/node/.pi/agent/sessions/--old--");
  setHarnessConfigDir(record, "/tmp/acpx-pi-dir", undefined);
  assert.equal(record.acpx?.pi_session_dir, undefined);
  assert.equal(pathsContainKey(record, "pi_session_dir"), 0);
});

test("cb214e48: a record that gets NEITHER dir is still left COMPLETELY untouched", () => {
  // The RS-14 guarantee, re-asserted for the widened setter. Adding a second field
  // to the guard is exactly how "touch nothing" quietly becomes "give every claude
  // record an empty acpx object".
  for (const acpx of [undefined, {}, { current_model_id: "x" }]) {
    const record = { agentCommand: CLAUDE, ...(acpx ? { acpx } : {}) } as unknown as SessionRecord;
    const before = JSON.stringify(record);
    setHarnessConfigDir(record, undefined, undefined);
    assert.equal(JSON.stringify(record), before, `record changed for acpx=${JSON.stringify(acpx)}`);
  }
  // PLANTED CONTROL, same scanner: it CAN see the key when it is there.
  const planted = { agentCommand: AGENT_REGISTRY.pi } as unknown as SessionRecord;
  setHarnessConfigDir(planted, undefined, "/home/node/.pi/agent/sessions/--x--");
  assert.equal(pathsContainKey(planted, "pi_session_dir"), 1, "the scanner is blind");
  assert.equal(pathsContainKey(planted, "harness_config_dir"), 0);
});

test("cb214e48: pi_session_dir round-trips a cold disk reload", () => {
  // `parseAcpxState` is an allowlist TOO — a field serialize passes through but
  // parse does not name is written to disk and silently dropped on the next cold
  // reload. That reload is exactly when the resume-failure message is produced, so
  // the field would be absent at the one moment it is read.
  const record = makeSessionRecord({
    acpxRecordId: "cb214e48-roundtrip",
    acpSessionId: "01a0875c-c60c-7e06-84de-6873ea4d3176",
    agentCommand: AGENT_REGISTRY.pi,
    cwd: "/workspace/projects/acpx",
  });
  setHarnessConfigDir(record, "/tmp/acpx-pi-rt", "/home/node/.pi/agent/sessions/--workspace--");
  const parsed = parseSessionRecord(serializeSessionRecordForDisk(record));
  assert.equal(parsed?.acpx?.pi_session_dir, "/home/node/.pi/agent/sessions/--workspace--");
  assert.equal(parsed?.acpx?.harness_config_dir, "/tmp/acpx-pi-rt");
});

/** Collect `process.stderr` writes made by `body`, synchronously. The shared
 *  `withCapturedStderrWrites` is async, which does not compose with the sync
 *  `withTempRoot` fixture above. */
function captureStderrSync(body: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  const writes: string[] = [];
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
    chunk: string,
  ) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = original;
  }
  return writes.join("");
}

/** Count paths whose final key is `key`, at ANY depth — the `paths(..)` scan a
 *  tester runs with jq, expressed in-process. Never a field probe: a wrong path
 *  returns a silent undefined indistinguishable from the pass condition. */
function pathsContainKey(value: unknown, key: string): number {
  let hits = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) {
        hits += 1;
      }
      walk(v);
    }
  };
  walk(value);
  return hits;
}

// ── F-12 (brick 2dc93747): the live flag REFINED per session ────────────────

test("F-12: an unclassifiable agent gets NO claim, not a false one", () => {
  const unknown = {
    acpxRecordId: "rec-f12-c",
    agentCommand: "some-unknown-adapter --acp",
    acpx: {},
  } as unknown as SessionRecord;
  assert.equal(
    toSessionIndexEntry(unknown, "rec-f12-c.json").canSetModelLive,
    undefined,
    "acpx must make no claim about an adapter it cannot classify — `false` would hide a working control",
  );
});

test("F-12 GUARDRAIL: declared non-Pi harnesses keep their declared answer", () => {
  for (const id of ["claude", "codex"] as const) {
    const record = {
      acpxRecordId: `rec-f12-${id}`,
      agentCommand: AGENT_REGISTRY[id],
      acpx: {},
    } as unknown as SessionRecord;
    assert.equal(
      toSessionIndexEntry(record, "x.json").canSetModelLive,
      deriveHarnessCapabilities(HARNESS_FACTS[id]).canSetModelLive,
      `${id}: the refinement changed a harness it must not touch`,
    );
  }
});

// ── F-12: the LEARNED, KEYED capability fact ────────────────────────────────

test("F-12: a -32601 learned on THIS adapter narrows canSetModelLive", () => {
  // Measured on the rig with the adapter swapped under an identical acpx:
  //   pi-acp 0.0.26 -> set model rc=0, record + current_model_id updated
  //   pi-acp 0.0.33 -> set model rc=1, -32601 Method not found  (what ships)
  // pi ADVERTISES 371 models and still has no such method, so NO advertisement
  // check can catch this. Only the observed refusal can.
  const record = {
    acpxRecordId: "rec-f12-pi",
    agentCommand: AGENT_REGISTRY.pi,
    acpx: {},
  } as unknown as SessionRecord;
  // CONTROL: before learning, the declared answer stands.
  assert.equal(toSessionIndexEntry(record, "x.json").canSetModelLive, true);

  setModelSetMethodUnsupported(record, true);
  assert.equal(
    toSessionIndexEntry(record, "x.json").canSetModelLive,
    false,
    "a proven-absent method must not be offered as a live control",
  );
});

test("F-12: ⚠️ THE RESTORATION CASE — a fact learned on ANOTHER adapter does not carry over", () => {
  // ⚠️ THE ROW THAT MATTERS MOST, and the one a bare boolean would fail. The
  // method EXISTED in 0.0.26, was REMOVED in 0.0.33, and our fork's job is to
  // RESTORE it. An unkeyed learned fact would keep the capability switched off
  // forever, the restoration would be INVISIBLE, and it would be blamed on the
  // fork. So the fact is keyed by the adapter it was learned on and does NOT
  // survive a change of adapter.
  const record = {
    acpxRecordId: "rec-f12-restore",
    agentCommand: "npx pi-acp@^0.0.33",
    acpx: {},
  } as unknown as SessionRecord;
  setModelSetMethodUnsupported(record, true);
  assert.equal(record.acpx?.model_set_unsupported_for, "npx pi-acp@^0.0.33");
  assert.equal(modelSetMethodKnownUnsupported(record), true, "control: it applies to its own key");

  // The pin moves — a restored method ships. The stale fact must NOT apply.
  record.agentCommand = "npx pi-acp@^0.0.34";
  assert.equal(
    modelSetMethodKnownUnsupported(record),
    false,
    "a refusal learned on a DIFFERENT adapter was carried over — the restoration is invisible",
  );
  assert.equal(
    toSessionIndexEntry(record, "x.json").canSetModelLive,
    true,
    "the live control stayed hidden on an adapter that was never probed",
  );
});

test("F-12: learning is TWO-WAY — a success clears a previous refusal", () => {
  const record = {
    acpxRecordId: "rec-f12-2way",
    agentCommand: AGENT_REGISTRY.pi,
    acpx: {},
  } as unknown as SessionRecord;
  setModelSetMethodUnsupported(record, true);
  assert.equal(modelSetMethodKnownUnsupported(record), true, "control: it was learned");
  setModelSetMethodUnsupported(record, false);
  assert.equal(modelSetMethodKnownUnsupported(record), false);
  // CLEARED means the KEY IS GONE, not set to false — a record that never learned
  // anything must be byte-identical to one that learned and recovered.
  assert.equal(record.acpx?.model_set_unsupported_for, undefined);
});

test("F-12: clearing on a record that never learned touches NOTHING", () => {
  // RS-14's rule, applied to this field: claude/claude-pty/codex never learn it,
  // and their record shape must not move.
  for (const id of ["claude", "claude-pty", "codex"] as const) {
    const record = { agentCommand: AGENT_REGISTRY[id] } as unknown as SessionRecord;
    const before = JSON.stringify(record);
    setModelSetMethodUnsupported(record, false);
    assert.equal(JSON.stringify(record), before, `${id}: the record shape moved`);
  }
});

// ============================================================================
// brick://cb214e48 §5.3 + §5.2 — a stranded pi transcript must survive the
// destruction of the directory it was wrongly written into, and must be findable
// again afterwards.
//
// Before R1, a pi child of a pi parent wrote its ONLY JSONL into the PARENT's
// per-session dir. The parent's terminal close (and the age-based orphan sweep)
// then removed that directory recursively — an unguarded `rm -rf` over other
// sessions' transcripts, which the holder refcount cannot see because a child
// registers as a holder of its OWN dir and its reference to the parent's travels
// on `PI_CODING_AGENT_SESSION_DIR`, deliberately not an ownership marker.
//
// ⚠️ EVERY ROW BELOW SCOPES THE BOX STORE WITH `ACPX_PI_BOX_AGENT_DIR`, AND THAT
// IS A SAFETY REQUIREMENT, NOT TIDINESS. The rescue's destination is the real
// `~/.pi/agent` when nothing overrides it, and this suite already writes 242
// fixture slugs into that real store (measured on devbox 2026-09-09) — a rescue
// that COPIES A FILE there is worse than the empty directories already leaking.
// ============================================================================

/** Run `body` with the box pi store pointed at `boxDir`, restored afterwards. */
function withBoxPiAgentDir<T>(boxDir: string, body: () => T): T {
  const previous = process.env.ACPX_PI_BOX_AGENT_DIR;
  process.env.ACPX_PI_BOX_AGENT_DIR = boxDir;
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_PI_BOX_AGENT_DIR;
    } else {
      process.env.ACPX_PI_BOX_AGENT_DIR = previous;
    }
  }
}

/** A legacy-shaped config dir holding one child's JSONL at a cwd slug — the exact
 *  shape measured under `/tmp/acpx-pi-01a08744-…` on devbox. */
function plantStrandedTranscript(
  root: string,
  sessionId: string,
  slug: string,
  fileName: string,
  content: string,
): { dir: string; file: string } {
  const dir = join(root, `acpx-pi-${sessionId}`);
  const sessionDir = join(dir, "sessions", slug);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, fileName), content);
  return { dir, file: join(sessionDir, fileName) };
}

const STRANDED_SLUG = "--workspace-projects-acpx-ui-w8-depth-gate--";
const STRANDED_FILE = "2026-09-09T18-09-59-308Z_01a08754-4154-7aa4-9f0c-d7687033f15d.jsonl";

test("cb214e48: a stranded child transcript is RESCUED before the dir is removed", () => {
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    const { dir } = plantStrandedTranscript(
      root,
      "parent-1",
      STRANDED_SLUG,
      STRANDED_FILE,
      '{"child":"only copy"}\n',
    );
    withBoxPiAgentDir(box, () => {
      removeHarnessConfigDir(dir);
    });
    const rescued = join(box, "sessions", STRANDED_SLUG, STRANDED_FILE);
    assert.equal(existsSync(rescued), true, "the child's ONLY transcript was destroyed");
    assert.equal(readFileSync(rescued, "utf8"), '{"child":"only copy"}\n');
    // And the directory still goes — this is a rescue, not a refusal to clean up.
    assert.equal(existsSync(dir), false, "the config dir leaked after a successful rescue");
  });
});

test("cb214e48: a LIVE destination file is NEVER overwritten — the destination is authoritative", () => {
  // ⚠️ THE ROW THAT STOPS A ROLLBACK IN TIME. Both manually-recovered Wave 8
  // children have a LIVE, LARGER file at the destination and a STALE, FROZEN one
  // in /tmp — two divergent files carrying ONE pi session id. Copying the stale one
  // over the live one would roll the session back, which is exactly the failure
  // `subscription-transcript.ts` was rewritten to prevent.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    const liveDir = join(box, "sessions", STRANDED_SLUG);
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, STRANDED_FILE), '{"live":1}\n{"live":2}\n{"live":3}\n');
    const { dir } = plantStrandedTranscript(
      root,
      "parent-2",
      STRANDED_SLUG,
      STRANDED_FILE,
      '{"stale":1}\n',
    );
    // ⚠️ AND THE SKIP MUST SAY SO — brick://cb214e48 F1 (TE finding). "Do nothing"
    // silently is indistinguishable from a rescue that never ran, and THIS is the
    // branch where a divergent pair lives: a LIVE file at the destination and a
    // STALE one in the directory about to be deleted. A reader who is not told
    // which copy was kept cannot tell a correct skip from a lost transcript.
    // Captured SYNCHRONOUSLY on purpose: `withTempRoot`'s callback is sync, and an
    // async one would let its `finally` delete the fixture root before the body
    // settled — a passing row measuring a directory that no longer exists.
    const writes = captureStderrSync(() => {
      withBoxPiAgentDir(box, () => {
        removeHarnessConfigDir(dir);
      });
    });
    assert.equal(
      readFileSync(join(liveDir, STRANDED_FILE), "utf8"),
      '{"live":1}\n{"live":2}\n{"live":3}\n',
      "the live destination file was rolled back to a stale /tmp copy",
    );
    assert.equal(existsSync(dir), false);
    assert.match(writes, /kept 1 existing pi transcript/, "the skip was SILENT");
    // Both paths named: the one kept, and the one discarded with the directory.
    assert.ok(
      writes.includes(join(liveDir, STRANDED_FILE)),
      "the line does not name the destination that was kept",
    );
    assert.ok(
      writes.includes(join(dir, "sessions", STRANDED_SLUG, STRANDED_FILE)),
      "the line does not name the stale copy being discarded",
    );
    assert.match(writes, /destination is authoritative/, "the line does not say WHY it was kept");
  });
});

test("cb214e48: an UNRESCUABLE transcript REFUSES the removal rather than losing it", () => {
  // A leaked directory loses nothing; a silent removal loses a session's only
  // history. The destination is made uncreatable by putting a FILE where the
  // sessions directory would have to be.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    writeFileSync(join(box, "sessions"), "not a directory");
    const { dir, file } = plantStrandedTranscript(
      root,
      "parent-3",
      STRANDED_SLUG,
      STRANDED_FILE,
      '{"child":"only copy"}\n',
    );
    withBoxPiAgentDir(box, () => {
      removeHarnessConfigDir(dir);
    });
    assert.equal(existsSync(dir), true, "removed a dir holding a transcript that exists nowhere");
    assert.equal(existsSync(file), true, "the unrescuable transcript is gone");
  });
});

test("cb214e48: a dir with NO stranded transcript is removed exactly as before", () => {
  // THE CONTROL, and the post-R1 steady state: after R1+R2 no newly-created config
  // dir can contain a `sessions/**` JSONL, so this is the path every real removal
  // takes. A rescue that started refusing here would be a leak in every session.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    const plan = applyHarnessConfigDir({
      env: { HOME: root, ACPX_PI_BOX_AGENT_DIR: box },
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "no-stranded",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan, "control: the config dir was never created");
    withBoxPiAgentDir(box, () => {
      removeHarnessConfigDir(plan.dir);
    });
    assert.equal(existsSync(plan.dir), false, "an ordinary config dir was refused");
  });
});

test("cb214e48: the ORPHAN SWEEP rescues too — it is a second way to lose the same file", () => {
  // Guarding only the close path would leave the age-based sweep as a quieter route
  // to the same loss. Both recursive removals in the module route through the
  // rescue; this row proves the sweep leg behaviourally rather than by reading the
  // source for a helper's name.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    plantStrandedTranscript(root, "swept-1", STRANDED_SLUG, STRANDED_FILE, '{"child":"swept"}\n');
    const result = withBoxPiAgentDir(box, () =>
      pruneOrphanHarnessConfigDirs({
        records: new Map([["swept-1", { closed: true }]]),
        liveScan: {
          scanned: 40,
          environRead: 9,
          pids: new Set([1]),
          referencedDirs: new Set<string>(),
          referencedSessionIds: new Set<string>(),
        },
        rootDir: root,
      }),
    );
    assert.equal(result.removed.length, 1, "the sweep did not remove the closed session's dir");
    assert.equal(
      existsSync(join(box, "sessions", STRANDED_SLUG, STRANDED_FILE)),
      true,
      "the SWEEP destroyed a stranded transcript",
    );
  });
});

// ── §5.2: finding it again, on an already-failing pi resume ──────────────────

test("cb214e48: the resume rescue finds a transcript stranded in ANOTHER session's dir", () => {
  // ⚠️ IT SCANS BY SHAPE BECAUSE THE RECORD CANNOT HELP. `harness_config_dir` on the
  // wedged child is the CHILD's own dir; nothing on the record names the parent's.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    const cwd = "/workspace/projects/acpx-ui/w8/depth-gate";
    const sessionId = "01a08754-4154-7aa4-9f0c-d7687033f15d";
    const slug = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    const fileName = `2026-09-09T18-09-59-308Z_${sessionId}.jsonl`;
    plantStrandedTranscript(root, "some-ancestor", slug, fileName, '{"stranded":true}\n');

    const rescue = rescueStrandedPiTranscriptForResume({
      cwd,
      acpSessionId: sessionId,
      env: { ACPX_PI_BOX_AGENT_DIR: box },
      rootDir: root,
    });
    assert.ok(rescue, "the stranded transcript was not found");
    assert.equal(rescue.copiedTo, join(box, "sessions", slug, fileName));
    assert.equal(readFileSync(rescue.copiedTo, "utf8"), '{"stranded":true}\n');
    // COPY, never move: a move would destroy the only copy if the retry fails.
    assert.equal(existsSync(rescue.copiedFrom), true, "the source was MOVED, not copied");
  });
});

test("cb214e48: the resume rescue stands down when the box store already has the session", () => {
  // Short-circuits BEFORE any scan. Without this it would race the live file and,
  // but for COPYFILE_EXCL, roll a session back in time.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    const cwd = "/workspace/projects/acpx-ui/w8/depth-gate";
    const sessionId = "01a08754-4154-7aa4-9f0c-d7687033f15d";
    const slug = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    const fileName = `2026-09-09T18-09-59-308Z_${sessionId}.jsonl`;
    mkdirSync(join(box, "sessions", slug), { recursive: true });
    writeFileSync(join(box, "sessions", slug, fileName), '{"live":true}\n');
    plantStrandedTranscript(root, "some-ancestor", slug, fileName, '{"stale":true}\n');

    assert.equal(
      rescueStrandedPiTranscriptForResume({
        cwd,
        acpSessionId: sessionId,
        env: { ACPX_PI_BOX_AGENT_DIR: box },
        rootDir: root,
      }),
      undefined,
      "the rescue ran against a session the box store already holds",
    );
    assert.equal(readFileSync(join(box, "sessions", slug, fileName), "utf8"), '{"live":true}\n');
  });
});

test("cb214e48: the resume rescue matches the EXACT session id, never a sibling in the same slug", () => {
  // The filename carries the pi session id, so the match is an exact suffix — no
  // header parsing, no heuristics. Two sessions legitimately share a cwd slug, and
  // copying the wrong one would resume a session into another session's history.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    const cwd = "/workspace/projects/temp/pi-steer-rig";
    const slug = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    plantStrandedTranscript(
      root,
      "ancestor-x",
      slug,
      "2026-09-09T18-31-17-000Z_01a0876e-a267-73da-b5c3-0cbe48306cc3.jsonl",
      '{"sibling":true}\n',
    );
    assert.equal(
      rescueStrandedPiTranscriptForResume({
        cwd,
        acpSessionId: "01a0877f-d545-7c49-864c-c849721fb353",
        env: { ACPX_PI_BOX_AGENT_DIR: box },
        rootDir: root,
      }),
      undefined,
      "a SIBLING session's transcript was rescued as this session's",
    );
    assert.equal(existsSync(join(box, "sessions", slug)), false, "a wrong-session copy was made");
  });
});

test("cb214e48: the resume rescue finds nothing when nothing is stranded", () => {
  // The ordinary case for a session that genuinely has no transcript anywhere —
  // which must stay a truthful miss, not an invented one.
  withTempRoot((root) => {
    const box = join(root, "box-agent");
    mkdirSync(box, { recursive: true });
    assert.equal(
      rescueStrandedPiTranscriptForResume({
        cwd: "/workspace/nothing/here",
        acpSessionId: "01a0aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        env: { ACPX_PI_BOX_AGENT_DIR: box },
        rootDir: root,
      }),
      undefined,
    );
  });
});
