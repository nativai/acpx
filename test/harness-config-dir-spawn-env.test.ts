import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR } from "../src/acp/harness-capabilities.js";
import type { HarnessId } from "../src/acp/harness-capabilities.js";
import type { AcpClientOptions } from "../src/types.js";

// B3 deliverable 5 — RS-13's in-repo half: THE ADAPTER-BOUNDARY DIFFERENTIAL.
//
// ⚠️ BOUNDARY (IR-15). This measures the environment of the process ACPX SPAWNS
// AS THE ADAPTER, read out of the child's OWN dump. It is the only boundary that
// can see this change:
//
//   acpx-ui --spawn('acpx')--> acpx CLI --spawn(adapter)--> the harness adapter
//                ^                              ^
//                └ RS-01 captures HERE          └ the config dir is applied HERE
//
// RS-01 is one level upstream and is structurally blind to this in BOTH
// directions — it shows an empty delta for a working gate and an equally empty
// delta for one that never ran. A row that cited RS-01 for this claim would be
// NOT RUN, not PASS.
//
// ⚠️ WHAT IT STILL CANNOT SEE: whether the harness READ the files. That needs a
// real OpenCode/Pi turn on the rig.
//
// ⚠️ THE MOCK AGENT'S ENV DUMP IS AN ALLOWLIST (ACPX_* / INDEPENDENT_CLAUDE_* /
// CLAUDE_CONFIG_DIR). The three names under test are NONE of those, so without
// `--env-dump-extra` every one reads `undefined` — INDISTINGUISHABLE from "acpx
// never set it", and this whole file would pass while proving nothing. hp-b1-acpx
// hit exactly that and added the flag; it is not optional here.
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

/** The names the config dir sets. Every arm captures ALL of them, so a harness
 *  that gains one it should not is caught as loudly as one that misses one. */
const CONFIG_DIR_NAMES = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "PI_CODING_AGENT_DIR"];

/**
 * The directory name that makes a command CLASSIFY as each harness.
 *
 * ⚠️ Every shipped detector matches with `args.some(arg => arg.includes(TOKEN))`
 * — verified in `src/acp/agent-command.ts` and `src/acp/codex-compat.ts` — so the
 * mock's own PATH is what classifies it. Placing a SYMLINK to the real mock under
 * a token-named directory means the argument string carries the token while Node
 * still resolves the module (and its relative imports) from the real location.
 *
 * ⚠️ This exercises acpx's REAL classification path with an adapter that answers,
 * which is the point: it measures ACPX'S GATE, not the harness. Passing the token
 * as a bare extra argument does not work — the mock rejects unknown options and
 * exits 1 before `initialize`, which reads as an infrastructure failure rather
 * than a result.
 */
const HARNESS_DIR_TOKENS: Record<string, string> = {
  claude: "claude-agent-acp",
  "claude-pty": "claude-pty-acp",
  codex: "codex-acp",
  opencode: "opencode-ai",
  pi: "pi-acp",
};

/** Which harnesses MUST receive a config dir, and exactly which names. */
const EXPECTED: Record<string, string[]> = {
  claude: [],
  "claude-pty": [],
  codex: [],
  opencode: ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"],
  pi: ["PI_CODING_AGENT_DIR"],
};

/**
 * ⚠️ THE CONFIG DIR DOES NOT OUTLIVE THE CLIENT ANY MORE. `close()` removes it
 * (brick 433f6bf8), so anything that inspects the directory must do so through
 * `beforeClose`, while the spawn is still open. Two tests in this file failed
 * exactly this way when remove-on-close landed — which is the fast path working.
 *
 * ## ⚠️ AND IT IS ISOLATED FROM THE REAL /tmp (brick 08107add) — READ THIS BEFORE
 * ## "SIMPLIFYING" THE TMPDIR DANCE BELOW
 *
 * Rows in this file went red intermittently FOUR times, always on a directory
 * that had VANISHED mid-read (`dirEntries=["<readdir failed>"]`), always passing
 * in isolation and on the next run. **It was blamed on load. That hypothesis was
 * never evidence, and it was wrong.** The mechanism, once a row printed the state
 * it judged:
 *
 *   1. this helper hard-coded `acpxRecordId: rec-b3-rs13-<harness>`, so the dir
 *      was a FIXED path under the REAL `/tmp`;
 *   2. `sessions prune` swept the real `/tmp` (it passed no `rootDir`, and the
 *      sweep defaults to `tmpdir()`); and
 *   3. `node --test` runs FILES in parallel, and four of them drive
 *      `sessions prune` through the CLI.
 *
 * That id is in none of their session lists, so the sweep called it an orphan and
 * deleted it while this file was reading it. **The row that printed its own
 * captured context is what turned an unreproducible intermittent into a
 * mechanism** — that instrument, not a reproduction, is the transferable part.
 *
 * The CAUSE is fixed in `pruneOrphanHarnessConfigDirs`, which no longer removes
 * an unrecognised id at all (brick cc9a5f25). This scoping is the second layer:
 * `os.tmpdir()` honours `TMPDIR` on POSIX and reads it per call, so pointing it
 * at a per-run directory keeps these spawns out of any other file's reach WITHOUT
 * inventing a test-only seam on `AcpClient`.
 */
async function spawnAndDumpEnv(
  harness: string,
  beforeClose?: (dump: Record<string, string>) => void | Promise<void>,
  sessionOptions?: AcpClientOptions["sessionOptions"],
): Promise<Record<string, string>> {
  const restoreTmp = await scopeTmpDir();
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-rs13-cwd-"));
  const envDumpPath = path.join(scratchDir, "env-dump.json");
  const linkDir = path.join(scratchDir, HARNESS_DIR_TOKENS[harness]);
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  await fs.symlink(MOCK_AGENT_PATH, mockLink);

  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(mockLink)} ` +
      `--env-dump-file ${JSON.stringify(envDumpPath)} ` +
      `--env-dump-extra ${CONFIG_DIR_NAMES.join(",")}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: `rec-b3-rs13-${harness}` },
    ...(sessionOptions ? { sessionOptions } : {}),
  });
  try {
    await client.start();
    await client.createSession();
    const dump = JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
    await beforeClose?.(dump);
    return dump;
  } finally {
    await client.close().catch(() => {});
    await fs.rm(scratchDir, { recursive: true, force: true });
    await restoreTmp();
  }
}

/**
 * Point `os.tmpdir()` at a per-run directory for the duration of one spawn, and
 * put it back afterwards. Returns the restore so it can sit in a `finally`.
 *
 * ⚠️ Top-level rows in a node:test FILE run SEQUENTIALLY, which is what makes
 * mutating `process.env.TMPDIR` safe here; the parallelism that caused 08107add
 * is BETWEEN files, in separate processes.
 */
async function scopeTmpDir(): Promise<() => Promise<void>> {
  const previous = process.env.TMPDIR;
  const scoped = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-rs13-root-"));
  process.env.TMPDIR = scoped;
  return async () => {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
    await fs.rm(scoped, { recursive: true, force: true });
  };
}

test("RS-13: config-dir vars reach opencode and pi ONLY — claude/claude-pty/codex EMPTY", async () => {
  const observed: Record<string, string[]> = {};
  const populations: Record<string, number> = {};

  for (const harness of Object.keys(HARNESS_DIR_TOKENS)) {
    const dump = await spawnAndDumpEnv(harness);

    // ⚠️ POPULATION FIRST, IN EVERY ARM. A dump of size 0 means the child never
    // wrote it — NOT RUN — and would satisfy every "is absent" assertion below
    // vacuously. This is what turns an empty result from "clean" into "broken".
    populations[harness] = Object.keys(dump).length;
    assert.ok(
      populations[harness] > 5,
      `${harness}: env dump has ${populations[harness]} entries — the child never ran, so this arm is NOT RUN, not clean`,
    );

    observed[harness] = CONFIG_DIR_NAMES.filter((name) => dump[name] !== undefined).toSorted();
  }

  // Printed so the row's evidence is the measurement, not the verdict.
  process.stderr.write(
    `[RS-13] populations=${JSON.stringify(populations)} observed=${JSON.stringify(observed)}\n`,
  );

  for (const [harness, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      observed[harness],
      expected.toSorted(),
      `${harness}: expected config-dir vars ${JSON.stringify(expected)} but observed ${JSON.stringify(observed[harness])}`,
    );
  }

  // THE TWO-SIDED CONTROL, stated as one assertion rather than left implicit:
  // the run must contain BOTH a harness that gained names and harnesses that
  // gained none. All-empty would mean the feature never fired; all-populated
  // would mean the gate does not gate.
  const gained = Object.entries(observed).filter(([, names]) => names.length > 0);
  const empty = Object.entries(observed).filter(([, names]) => names.length === 0);
  assert.equal(gained.length, 2, "exactly opencode and pi must gain config-dir vars");
  assert.equal(empty.length, 3, "exactly claude, claude-pty and codex must gain none");
});

test("RS-13 control: the probe CAN see these names — a planted value is captured", async () => {
  // The positive control for the three EMPTY arms above. Without it, "claude has
  // no XDG_CONFIG_HOME" is equally consistent with "--env-dump-extra is not
  // working and no name of this shape is ever captured". Plant the value in the
  // parent env and require the SAME instrument, in the same process, to see it
  // on the SAME harness that must otherwise show none.
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/hp-b3-planted-control";
  try {
    const dump = await spawnAndDumpEnv("claude");
    assert.equal(
      dump.XDG_CONFIG_HOME,
      "/tmp/hp-b3-planted-control",
      "the instrument cannot see XDG_CONFIG_HOME at all — every absence assertion above is blind",
    );
    // And acpx did not overwrite an inherited value for a non-config-dir harness.
    assert.equal(dump.OPENCODE_CONFIG_DIR, undefined);
    assert.equal(dump.PI_CODING_AGENT_DIR, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
});

test("the config dir opencode receives is REAL — the files exist where the env points", async () => {
  // The env var alone proves a name was set, not that a primer was written.
  // Inspected via beforeClose: close() now removes the directory.
  let checked = false;
  await spawnAndDumpEnv("opencode", async (dump) => {
    const configDir = dump.OPENCODE_CONFIG_DIR;
    assert.ok(
      configDir,
      `OPENCODE_CONFIG_DIR unset; captured names=${JSON.stringify(Object.keys(dump).slice(0, 40))}`,
    );
    const configPath = path.join(configDir, "opencode.json");
    // ⚠️ Read with the failure state attached: this row has gone red once under
    // full-suite load and left only a `not ok` line to work from.
    const raw = await fs.readFile(configPath, "utf8").catch(async (error: unknown) => {
      const entries = await fs.readdir(configDir).catch(() => ["<readdir failed>"]);
      throw new Error(
        `cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)} · ` +
          `dirEntries=${JSON.stringify(entries)}`,
      );
    });
    const config = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(config, `opencode.json at ${configPath} did not parse`);
    // XDG_CONFIG_HOME must be the PARENT — OpenCode merges both, so a mismatch
    // silently de-isolates the session (I1 R15).
    assert.equal(dump.XDG_CONFIG_HOME, path.dirname(configDir));
    checked = true;
  });
  assert.equal(checked, true, "beforeClose never ran — this row examined nothing");
});

test("acpx does NOT provision a catalogue entry for a pinned model today", async () => {
  // ⚠️ FOUND AFTER MERGE. The first version passed the pinned model as
  // `provisionModelId` unconditionally, so EVERY opencode session declared
  // `provider.openrouter.models.<slug>: {}` — including for the 358 models
  // already in OpenCode's bundled snapshot, which is all acpx can pin today
  // (`acceptsArbitraryModelIds` is false for opencode).
  //
  // Declaring an EMPTY config over an EXISTING catalogue entry is unmeasured: if
  // OpenCode replaces rather than deep-merges, the model loses its bundled
  // metadata INCLUDING its reasoning support — and the `effort` option is
  // advertised from exactly that, so the post-model re-read would find no ladder
  // and depth would silently stop working for every pinned model.
  //
  // Same asymmetry that kept Pi's models-store.json out: provisioning buys
  // nothing while arbitrary ids are declared unsupported, and risks that.
  let checked = false;
  await spawnAndDumpEnv("opencode", async (dump) => {
    const configDir = dump.OPENCODE_CONFIG_DIR;
    assert.ok(configDir, "OPENCODE_CONFIG_DIR unset — nothing to inspect");
    const config = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;

    // CONTROL: the file is real and the writer ran, so `provider` being absent is
    // a decision rather than an unwritten file.
    assert.ok(config, "opencode.json did not parse");
    assert.equal(
      config.provider,
      undefined,
      "a catalogue fragment was written for an already-catalogued model",
    );
    checked = true;
  });
  assert.equal(checked, true, "beforeClose never ran — this row examined nothing");
});

test("F-8: a spawn with NO sessionContext still gets a UNIQUE dir, never a shared literal", async () => {
  // ⚠️ THE CASE THE MERGED VERSION OF THIS FILE COULD NOT SEE. Every test above
  // HAND-SUPPLIES `sessionContext: { acpxRecordId: … }`, so the suite only ever
  // exercised the branch where the id IS present — the harness provided what the
  // real run does not. On the real `sessions new` path `acpxRecordId` is EMPTY
  // (`creationSessionContext` sets `""`, because the CLI record id IS the
  // adapter's own session/new id), so the literal fallback fired on every create
  // and two sessions shared `/tmp/acpx-<harness>-session`.
  //
  // The leaked `/tmp/acpx-pi-rec-b3-rs13-pi` from the old test is how we know it
  // never ran the real path.
  const dirs: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-f8-nocontext-"));
    const envDumpPath = path.join(scratchDir, "env-dump.json");
    const linkDir = path.join(scratchDir, "opencode-ai");
    await fs.mkdir(linkDir, { recursive: true });
    const mockLink = path.join(linkDir, "mock-agent.js");
    await fs.symlink(MOCK_AGENT_PATH, mockLink);

    // NO sessionContext AT ALL — exactly what the create spawn effectively has.
    const client = new AcpClient({
      agentCommand:
        `node ${JSON.stringify(mockLink)} ` +
        `--env-dump-file ${JSON.stringify(envDumpPath)} ` +
        `--env-dump-extra ${CONFIG_DIR_NAMES.join(",")}`,
      cwd: scratchDir,
      permissionMode: "approve-reads",
    });
    try {
      await client.start();
      await client.createSession();
      const dump = JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
      assert.ok(Object.keys(dump).length > 5, "control: the child must have run");
      const configDir = dump.OPENCODE_CONFIG_DIR;
      assert.ok(configDir, "no config dir was created without a sessionContext");
      dirs.push(path.dirname(configDir));
    } finally {
      await client.close().catch(() => {});
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  }

  // THE ASSERTION: two context-less spawns get DIFFERENT directories.
  assert.notEqual(dirs[0], dirs[1], "two spawns shared a directory — the literal fallback is back");
  for (const dir of dirs) {
    assert.match(path.basename(dir), /^acpx-opencode-/, "the dir prefix changed");
    assert.doesNotMatch(
      path.basename(dir),
      /^acpx-opencode-session$/,
      "the shared literal directory name is back",
    );
    // close() removed it — remove-on-close is the fast path (the sweep is the
    // guarantee), and this asserts the fast path actually fires.
    assert.equal(existsSync(dir), false, `close() left ${dir} behind`);
  }
});

/**
 * An OpenRouter slug no harness ships in its bundled catalogue, so its presence
 * in a written config file can only have come from acpx provisioning it.
 */
const PROVISIONED_SLUG = "openrouter/zzz-acpx-cba6fa92/routing-probe";

/** What `PROVISIONED_SLUG` looks like once `stripProviderPrefix` has run. */
const PROVISIONED_SLUG_STRIPPED = "zzz-acpx-cba6fa92/routing-probe";

/**
 * Swap the SHIPPED provisioning list, in place, for the duration of one probe.
 *
 * ⚠️ THE SHIPPED ARRAY IS THE SUBJECT, WHICH IS WHY THIS MUTATES IT RATHER THAN
 * INJECTING A PARAMETER. `harnessProvisionsModelCatalogue` is parameterised and a
 * test could hand it any list — but that measures the HELPER. The claim under
 * test is about `client.ts`: that the spawn ROUTES on the constant instead of on
 * a `=== "pi"` literal, and a literal and a `["pi"]` list are behaviourally
 * identical on the shipped defaults. Varying the constant underneath a real spawn
 * is the only runtime observable that separates them. `client.ts` reaches the
 * array through a default parameter, evaluated per call, so a splice is visible
 * to the very next spawn.
 *
 * Top-level rows in a node:test FILE run SEQUENTIALLY (see `scopeTmpDir`), and
 * the restore is in a `finally`, so no other row ever sees the swapped list.
 */
async function withProvisioningList<T>(
  next: readonly HarnessId[],
  run: () => Promise<T>,
): Promise<T> {
  const shipped = ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR as HarnessId[];
  const original = [...shipped];
  shipped.splice(0, shipped.length, ...next);
  try {
    return await run();
  } finally {
    shipped.splice(0, shipped.length, ...original);
  }
}

/**
 * Spawn `harness` with `PROVISIONED_SLUG` pinned and report whether the spawn
 * actually wrote a catalogue fragment for it.
 *
 * Each arm carries its OWN control, because "no fragment" and "the config dir was
 * never written" are the same observation otherwise: the config dir must exist,
 * and for opencode the config file must parse. So a `false` here means acpx
 * DECIDED not to provision, never that nothing ran.
 */
async function observeProvisioning(harness: "opencode" | "pi"): Promise<boolean> {
  let observed: boolean | undefined;
  await spawnAndDumpEnv(
    harness,
    async (dump) => {
      assert.ok(
        Object.keys(dump).length > 5,
        `${harness}: env dump has ${Object.keys(dump).length} entries — the child never ran, so this arm is NOT RUN, not clean`,
      );
      if (harness === "pi") {
        const dir = dump.PI_CODING_AGENT_DIR;
        assert.ok(dir, "pi: PI_CODING_AGENT_DIR unset — no config dir was written at all");
        // CONTROL: the directory is real and reachable, so a missing
        // models-store.json is a routing decision rather than an absent dir.
        const entries = await fs.readdir(dir);
        assert.ok(entries.length > 0, `pi: ${dir} is empty — the writer never ran`);
        const storePath = path.join(dir, "models-store.json");
        if (!existsSync(storePath)) {
          observed = false;
          return;
        }
        const store = JSON.parse(await fs.readFile(storePath, "utf8")) as {
          openrouter?: { models?: { id?: string }[] };
        };
        // Pin what the artifact CONTAINS, not merely that a file exists.
        observed = (store.openrouter?.models ?? []).some(
          (model) => model.id === PROVISIONED_SLUG_STRIPPED,
        );
        return;
      }
      const configDir = dump.OPENCODE_CONFIG_DIR;
      assert.ok(
        configDir,
        "opencode: OPENCODE_CONFIG_DIR unset — no config dir was written at all",
      );
      // CONTROL: the file is real and parses, so `provider` being absent is a
      // routing decision rather than an unwritten file.
      const config = JSON.parse(
        await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
      ) as { provider?: { openrouter?: { models?: Record<string, unknown> } } };
      assert.ok(config, "opencode: opencode.json did not parse");
      observed = config.provider?.openrouter?.models?.[PROVISIONED_SLUG_STRIPPED] !== undefined;
    },
    { model: PROVISIONED_SLUG },
  );
  assert.notEqual(
    observed,
    undefined,
    `${harness}: beforeClose never ran — this arm examined nothing`,
  );
  return observed === true;
}

test("the SHIPPED provisioning list is what the spawn routes on — both directions (brick cba6fa92)", async () => {
  // ⚠️ WHAT WAS WRONG, AND WHY BOTH HALVES OF THIS ROW ARE LOAD-BEARING.
  //
  // "pi is provisioned" was asserted in TWO independent places and only ONE was
  // defended. `test/harness-capabilities.test.ts` pins the DECLARED list
  // (`ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR`), but the SHIPPED routing was a
  // hardcoded `harnessIdForAgentCommand(…) === "pi"` literal in `client.ts` that
  // no test reached. So editing the declaration redded a row while editing the
  // routing moved nothing — the guard sat on the wrong side of the seam.
  //
  // ## PART 1 — the shipped defaults, in BOTH directions
  //
  // One harness that IS on the list and one that is NOT, measured through a real
  // adapter spawn. A row that pinned only the positive would be the same
  // one-sided defence being removed here.
  const shippedPi = await observeProvisioning("pi");
  const shippedOpencode = await observeProvisioning("opencode");
  process.stderr.write(
    `[cba6fa92] shipped list=${JSON.stringify([...ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR])} ` +
      `pi=${shippedPi} opencode=${shippedOpencode}\n`,
  );
  assert.equal(shippedPi, true, "pi is on the shipped list and the spawn must provision for it");
  assert.equal(
    shippedOpencode,
    false,
    "opencode is NOT on the shipped list and the spawn must not provision for it — " +
      "the empty-declaration merge-vs-replace question is still unmeasured (J2)",
  );

  // ## PART 2 — the routing is a DERIVATION, not a literal
  //
  // ⚠️ PART 1 ALONE CANNOT SEE THE DEFECT. `["pi"]` and `=== "pi"` agree on every
  // shipped input, so restoring the literal leaves Part 1 green. Only varying the
  // constant underneath the same real spawn separates them: with the list swapped
  // to `["opencode"]`, a literal keeps provisioning pi and keeps refusing
  // opencode, and BOTH assertions below go red.
  //
  // It is also a two-sided control for Part 1: the same instrument that reported
  // `pi=true, opencode=false` must be able to report the exact opposite, which is
  // what makes Part 1's `false` an observation rather than a blind spot.
  const [flippedPi, flippedOpencode] = await withProvisioningList(["opencode"], async () => [
    await observeProvisioning("pi"),
    await observeProvisioning("opencode"),
  ]);
  process.stderr.write(
    `[cba6fa92] swapped list=["opencode"] pi=${flippedPi} opencode=${flippedOpencode}\n`,
  );
  assert.equal(
    flippedPi,
    false,
    "the spawn still provisioned for pi with pi OFF the list — the routing is hardcoded, not derived",
  );
  assert.equal(
    flippedOpencode,
    true,
    "the spawn refused to provision for opencode with opencode ON the list — the routing is hardcoded, not derived",
  );

  // The restore actually happened, so nothing downstream inherits the swap.
  assert.deepEqual([...ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR], ["pi"]);
});
