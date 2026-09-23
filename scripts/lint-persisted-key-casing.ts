import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPersistedKeyPolicyViolations } from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "lint-record",
    acpSessionId: "lint-session",
    agentSessionId: "agent-session",
    agentCommand: "npx -y @agentclientprotocol/codex-acp",
    cwd: "/tmp/lint",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: {
      active_path: "/tmp/lint-record.events.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    title: null,
    // ⚠️ NOT AN EMPTY LIST, AND DO NOT TRIM THESE ENTRIES BACK. `messages: []`
    // is what let `messages.Agent.claudeUuid` past this lint and into
    // production, where it threw inside `serializeSessionRecordForDisk` and
    // silently stopped 33 sessions persisting (brick://94b6f8fb). A record with
    // no messages never exercises the message subtree at all, so every key
    // under `messages.*` was unguarded. Both entry kinds carry every optional
    // provenance field so a camelCase one cannot be added without this lint
    // failing.
    messages: [
      {
        User: {
          id: "lint-user",
          content: [{ Text: "hello" }],
          claude_uuid: "11111111-1111-4111-8111-111111111111",
        },
      },
      {
        Agent: {
          content: [{ Text: "hi" }],
          tool_results: {},
          claude_uuid: "22222222-2222-4222-8222-222222222222",
        },
      },
    ],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

function assertSerializationPolicy(): void {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(
    violations.length,
    0,
    `serializeSessionRecordForDisk emitted non-snake keys: ${violations.join(", ")}`,
  );

  const requiredTopLevel = [
    "schema",
    "acpx_record_id",
    "acp_session_id",
    "agent_session_id",
    "agent_command",
    "cwd",
    "created_at",
    "last_used_at",
    "last_seq",
    "event_log",
    "title",
    "messages",
    "updated_at",
    "cumulative_token_usage",
    "request_token_usage",
  ];

  for (const key of requiredTopLevel) {
    assert.equal(
      key in persisted,
      true,
      `serialized session record is missing required key: ${key}`,
    );
  }

  const forbiddenTopLevel = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenTopLevel) {
    assert.equal(
      key in persisted,
      false,
      `serialized session record must not emit camelCase key: ${key}`,
    );
  }
}

function assertSerializerSourceKeys(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(scriptDir, "..", "src", "session", "persistence", "serialize.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const serializerStart = source.indexOf("export function serializeSessionRecordForDisk");
  assert.notEqual(serializerStart, -1, "serializeSessionRecordForDisk not found");

  const serializerBlock = source.slice(serializerStart);
  const forbiddenPersistedKeys = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenPersistedKeys) {
    const matcher = new RegExp(`\\b${key}\\s*:`, "g");
    assert.equal(
      matcher.test(serializerBlock),
      false,
      `serializer contains non-snake persisted key literal: ${key}`,
    );
  }
}

// ---------------------------------------------------------------------------
// THE DISCOVERING HALF — everything above is fixture-driven and cannot see a
// field nobody added to the fixture (brick://dce67687)
// ---------------------------------------------------------------------------
//
// 🛑 `assertSerializationPolicy` ABOVE CHECKS ONE HAND-WRITTEN RECORD. It catches
// a camelCase key on the fields that fixture happens to carry, and is blind to
// every field invented after it was written — which is how
// `messages.Agent.claudeUuid` shipped and silently stopped 33 sessions
// persisting (brick://94b6f8fb). Extending the fixture closed that one key; it
// did not close the class, because the next field is by definition not in the
// fixture either.
//
// The guard that does close the class is the compile-time one in
// `src/persisted-key-policy.ts`: it is derived from the TYPES, so it discovers a
// new field with nothing to register. What is asserted BELOW is that the guard
// actually FIRES — by injecting a camelCase key into a copy of `src/types.ts`
// and requiring `tsgo` to fail naming it.
//
// ⚠️ THIS IS THE CONTROL FOR THE GUARD, AND IT IS THE POINT OF THE EXERCISE. A
// type-level assertion can degenerate to a no-op in complete silence — one
// `unknown` on the path, one `Record<string, …>` in the wrong place, one nesting
// level past the walk's depth bound, and `OffendingKeys` yields `never` for a
// tree full of violations while every other gate stays green. That is the exact
// failure shape of the incident this file exists for, so the guard is not
// allowed to be believed on inspection: it has to be seen going red.
//
// PROBE 3 IS THE ONE THAT CANNOT BE FAKED BY A LIST. It invents a subtree type
// that exists in no allowlist, no fixture and no guard declaration, hangs it off
// `SessionRecord`, and requires the typecheck to fail on a key inside it.
// Measured on `origin/dev` 5756fd6, before `PersistedRecordSubtreeKeysAreSnakeCase`
// existed: probes 1 and 2 already failed the typecheck (the message subtree was
// guarded), probe 3 PASSED it — a fresh wholesale subtree was unguarded, exactly
// as `messages` had been.

/**
 * Only `src/persisted-key-policy.ts` and its import closure. Measured on the
 * devbox workbench: ~2.4 s a run, against ~20 s for the whole-project
 * `pnpm run typecheck` program. Five runs below, so ~12 s of gate time.
 */
const PROBE_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    module: "ESNext",
    moduleResolution: "bundler",
    esModuleInterop: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    isolatedModules: true,
    types: ["node"],
  },
  files: ["src/persisted-key-policy.ts"],
};

type GuardProbe = {
  /** What property of the guard this probe measures. */
  name: string;
  /** Applied to a COPY of `src/types.ts`; never to the real file. */
  mutate: (typesSource: string) => string;
  /** Every one of these must appear in the typecheck output. */
  expectNamed: string[];
};

function insertField(source: string, typeName: string, field: string): string {
  const anchor = `export type ${typeName} = {\n`;
  const at = source.indexOf(anchor);
  assert.notEqual(
    at,
    -1,
    `guard probe cannot find \`export type ${typeName} = {\` in src/types.ts — the probe anchor moved, so the probe proves nothing until it is repaired`,
  );
  const cut = at + anchor.length;
  return `${source.slice(0, cut)}  ${field}\n${source.slice(cut)}`;
}

/** `{ level_1?: { … { deep_snake_key?: string } } }`, `levels` objects deep. */
function nestedSubtreeType(levels: number): string {
  let inner = "{ deep_snake_key?: string }";
  for (let level = levels; level > 0; level -= 1) {
    inner = `{ level_${level}?: ${inner} }`;
  }
  return inner;
}

const GUARD_PROBES: GuardProbe[] = [
  {
    name: "a new camelCase field on SessionAgentMessage (the shape that shipped)",
    mutate: (source) => insertField(source, "SessionAgentMessage", "probeAgentCamelKey?: string;"),
    expectNamed: ["probeAgentCamelKey"],
  },
  {
    name: "a new camelCase field on SessionUserMessage",
    mutate: (source) => insertField(source, "SessionUserMessage", "probeUserCamelKey?: string;"),
    expectNamed: ["probeUserCamelKey"],
  },
  {
    // The discovering property itself: a subtype nothing has ever heard of.
    name: "a camelCase key inside a BRAND-NEW SessionRecord subtree, registered nowhere",
    mutate: (source) =>
      insertField(
        `${source}\nexport type ProbeFreshSubtree = { probeFreshSubtreeKey?: string };\n`,
        "SessionRecord",
        "probe_fresh_subtree?: ProbeFreshSubtree;",
      ),
    expectNamed: ["probeFreshSubtreeKey"],
  },
  {
    // Exhaustion must be LOUD. Note every key here is snake_case: the only thing
    // this can red on is the walk running out of depth.
    name: "a subtree nested past the walk's depth bound",
    mutate: (source) =>
      insertField(
        `${source}\nexport type ProbeDeepSubtree = ${nestedSubtreeType(13)};\n`,
        "SessionRecord",
        "probe_deep_subtree?: ProbeDeepSubtree;",
      ),
    expectNamed: ["__persisted_key_walk_ran_out_of_depth__"],
  },
];

function assertCompileTimeGuardFires(): void {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsgo = path.join(repoRoot, "node_modules", ".bin", "tsgo");
  assert.equal(fs.existsSync(tsgo), true, `guard probe needs ${tsgo} — run \`pnpm install\``);

  // Literal path, captured once at creation and never re-derived (the rm below).
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-persisted-key-probe-"));
  try {
    fs.cpSync(path.join(repoRoot, "src"), path.join(probeDir, "src"), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(probeDir, "node_modules"));
    const tsconfigPath = path.join(probeDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, `${JSON.stringify(PROBE_TSCONFIG, null, 2)}\n`);

    const typecheck = (): { failed: boolean; output: string } => {
      const run = spawnSync(tsgo, ["-p", tsconfigPath], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(run.error, undefined, `guard probe could not run tsgo: ${String(run.error)}`);
      assert.equal(run.signal, null, `guard probe's tsgo was killed by ${String(run.signal)}`);
      return { failed: run.status !== 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
    };

    const typesPath = path.join(probeDir, "src", "types.ts");
    const pristineTypes = fs.readFileSync(typesPath, "utf8");

    // CONTROL FIRST. Without it, a probe copy that is broken for some unrelated
    // reason reds on every probe and "proves" a guard that may not exist at all.
    const control = typecheck();
    assert.equal(
      control.failed,
      false,
      `guard probe's UNMUTATED copy does not typecheck, so no probe below proves anything:\n${control.output}`,
    );

    for (const probe of GUARD_PROBES) {
      const mutated = probe.mutate(pristineTypes);
      assert.notEqual(mutated, pristineTypes, `guard probe "${probe.name}" mutated nothing`);
      fs.writeFileSync(typesPath, mutated);
      const result = typecheck();
      fs.writeFileSync(typesPath, pristineTypes);

      assert.equal(
        result.failed,
        true,
        `THE PERSISTED-KEY GUARD IS BLIND TO ${probe.name.toUpperCase()}.\n` +
          `A copy of src/types.ts carrying it typechecks clean, so such a field can be added, ` +
          `shipped, and silently stop the session record from ever being written again ` +
          `(brick://94b6f8fb). Widen the derived guard in src/persisted-key-policy.ts — ` +
          `do NOT relax this probe.`,
      );
      for (const expected of probe.expectNamed) {
        assert.equal(
          result.output.includes(expected),
          true,
          `guard probe "${probe.name}" failed the typecheck but never named \`${expected}\`, ` +
            `so the red may be unrelated to the probe:\n${result.output}`,
        );
      }
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

assertSerializationPolicy();
assertSerializerSourceKeys();
assertCompileTimeGuardFires();
