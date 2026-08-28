// brick://874fee67 — the structural guards, as distinct from the behavioural
// tests in `output-style.test.ts`.
//
// These pin the two properties that no ordinary assertion can reach, because
// both are about the ABSENCE of code: R-6 inversion #1 (output style is never
// applied to a live query) and the load-bearing status of the owner recycle.
//
// Why absence needs a guard at all: this feature is ~40 sites of "copy exactly
// what `effort` does", and at this one point it must do the OPPOSITE. An
// implementer following the precedent faithfully — or a reviewer "restoring a
// missing piece" — introduces the defect. And the defect is close to invisible
// at runtime: the record would show the new style, the harness config readback
// would agree, and only the model's actual behaviour would disagree, which is
// the one signal no automated test reads by default.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyConfigOptionsToRecord } from "../src/session/config-options.js";
import { recordSessionUpdate } from "../src/session/conversation-model.js";
import { outputStyleChangePending } from "../src/session/output-style.js";
import { toSessionIndexEntry } from "../src/session/persistence/index.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// ⚠️ Resolve the repo root by WALKING UP TO package.json, never as a fixed
// `../src` from this file. The suite executes from `dist-test/test/`, so a fixed
// relative hop lands in `dist-test/src` — compiled `.js`, zero `.ts` files — and
// the sweep silently examines NOTHING while reporting clean. That is not a
// hypothetical: it is what this file did on its first run, and the only reason
// it surfaced is the non-empty assertion below. A sweep with no subjects and a
// sweep with no offenders are the same green.
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the repo root from " + import.meta.dirname);
}

const SRC_ROOT = path.join(repoRoot(), "src");

// A live-apply function for output style, in ANY spelling. The point of matching
// a shape rather than one known name is that the defect will not arrive under
// the name we predicted.
const LIVE_APPLY_SHAPE = /\bapply[A-Za-z]*OutputStyle[A-Za-z]*\b|\bapplyFlagSettings\b/;

async function collectTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptSources(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// DISCOVERING, not hand-listed: the sweep finds its own subjects by walking the
// tree, so a file nobody remembered to register is still covered. A hand-
// maintained file list is the form that systematically survives its own
// violation.
test("STRUCTURAL: no live-apply path for output style exists anywhere in src/", async () => {
  const files = await collectTypeScriptSources(SRC_ROOT);
  // Self-check on the instrument: a sweep over an empty set passes vacuously and
  // looks identical to a clean one.
  assert.ok(
    files.length > 100,
    `sweep found only ${files.length} sources — it is not reaching src/`,
  );

  const offenders: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    // Lint per OCCURRENCE, not per file: report the matching line so a hit is
    // actionable and cannot be a stale import or a comment mentioning the name.
    source.split("\n").forEach((line, index) => {
      // A comment saying why the call must not exist is exactly what we want to
      // keep, so skip comment lines rather than banning the words.
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
        return;
      }
      if (LIVE_APPLY_SHAPE.test(code)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}:${index + 1}: ${code}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "A live-apply path for output style is THE DEFECT, not a missing piece.\n" +
      "Moving the live harness config without recomposing the system prompt leaves the\n" +
      "model TOLD it is in a style whose instructions it has never seen — measured, and\n" +
      "worse than a no-op. The style reaches Claude Code only through the adapter's\n" +
      "CREATION settings (at spawn and at resume), and the owner recycle is what makes\n" +
      "a change reach a fresh query. See src/session/output-style.ts and brick://4d16ab8b.",
  );
});

// The instrument's positive control. A sweep that reports "clean" because its
// pattern matches nothing is indistinguishable from a clean codebase — so prove
// the pattern bites before trusting its silence.
test("STRUCTURAL: the sweep's pattern demonstrably matches the shape it forbids", () => {
  for (const specimen of [
    "await applyOutputStyleToSdk(query, value);",
    "async function applyOutputStyleLive(q: Query) {",
    "await query.applyFlagSettings({ outputStyle: value });",
  ]) {
    assert.ok(LIVE_APPLY_SHAPE.test(specimen), `pattern failed to match: ${specimen}`);
  }
  // ...and does not fire on the ordinary code it sits beside.
  for (const innocent of [
    "persistRequestedOutputStyle({ record, outputStyle, advertised, agentLabel });",
    "setDesiredConfigOption(record, OUTPUT_STYLE_CONFIG_ID, value);",
    "const applied = outputStyleApplied(record);",
  ]) {
    assert.equal(LIVE_APPLY_SHAPE.test(innocent), false, `false positive on: ${innocent}`);
  }
});

// ---------------------------------------------------------------------------
// AC-4b — the advertisement is replaced WHOLESALE, and that is the contract
// ---------------------------------------------------------------------------

function recordWithAdvertisement(ids: string[]): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "adv-rec",
    acpSessionId: "adv-sid",
    agentName: "claude",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      session_options: { model: "opus", output_style: "Explanatory" },
      applied_output_style: "Explanatory",
      config_options: ids.map((id) => ({
        id,
        name: id,
        type: "select" as const,
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      })),
    } satisfies SessionAcpxState,
  });
}

// The hazard AC-4b exists for: `buildConfigOptions` rebuilds the WHOLE option
// list on a model switch, and the rebuild is lossy by default. acpx mirrors the
// adapter faithfully — which is what makes an adapter-side omission reach the
// record within ONE notification and flip `outputStyleSupported` to false.
//
// This test PINS the mirroring rather than defending against it. Mirroring is
// the contract; a defensive merge here would hide a real adapter regression
// behind a stale record, which is worse. If this test ever fails, someone has
// added that defensive merge.
test("AC-4b: an adapter that stops advertising outputStyle flips supported to false (mirroring is the contract — do NOT defensively merge)", () => {
  const record = recordWithAdvertisement(["mode", "model", "effort", "outputStyle"]);
  assert.equal(toSessionIndexEntry(record, "f.json").outputStyleSupported, true);

  // A model switch: the adapter re-sends its whole rebuilt list, without the option.
  applyConfigOptionsToRecord(record, {
    configOptions: recordWithAdvertisement(["mode", "model", "effort"]).acpx?.config_options,
  });
  assert.equal(
    toSessionIndexEntry(record, "f.json").outputStyleSupported,
    false,
    "acpx must mirror the adapter — if this now reads true, a defensive merge was added and it is hiding an adapter regression",
  );
});

// The genuine risk in THIS repo, as opposed to the adapter's: a wholesale
// `config_options` replacement must not take the style fields down with it.
// All three replacement sites route through cloneSessionAcpxState, so this is a
// property of that clone — and it is the one that would break silently.
test("a wholesale config_options replacement does NOT clobber the style fields", () => {
  const record = recordWithAdvertisement(["mode", "outputStyle"]);
  applyConfigOptionsToRecord(record, {
    configOptions: recordWithAdvertisement(["mode"]).acpx?.config_options,
  });
  assert.equal(record.acpx?.session_options?.output_style, "Explanatory", "desired survived");
  assert.equal(record.acpx?.applied_output_style, "Explanatory", "applied survived");
  // And the predicate still reads correctly, which is what actually matters:
  // losing `applied` here would make every advertisement refresh look like a
  // pending style change and recycle the owner in a loop.
  assert.equal(outputStyleChangePending(record), false);
});

test("a config_option_update NOTIFICATION does not clobber the style fields either", () => {
  const record = recordWithAdvertisement(["mode", "outputStyle"]);
  const acpx: SessionAcpxState = { ...record.acpx };
  const next = recordSessionUpdate(
    {
      title: null,
      messages: [],
      updated_at: "2026-01-01T00:00:00.000Z",
      cumulative_token_usage: {},
      request_token_usage: {},
    },
    acpx,
    {
      sessionId: "adv-sid",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: recordWithAdvertisement(["mode"]).acpx?.config_options ?? [],
      },
    },
  );
  assert.equal(
    next.config_options?.some((option) => option.id === "outputStyle"),
    false,
    "control: the notification really did replace the advertised list",
  );
  assert.equal(next.session_options?.output_style, "Explanatory");
  assert.equal(next.applied_output_style, "Explanatory");
});
