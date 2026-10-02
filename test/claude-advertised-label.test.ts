// brick ebfe4c3c — the ONE Claude label derivation (CONTRACT §1) and the index
// projection of `resolvedModelLabel` / `servedModel` (CONTRACT §2).
//
// The table below is VERBATIM: every `value | name | description` shape counted in
// the devbox census (2,370 records, 2026-10-02) plus the measured no-credential probe
// (API form). A derivation that only handled today's binary would pass the first rows
// and print prose for the rest.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transcriptCwdHash } from "../src/config/subscription-transcript.js";
import {
  advertisedModelOptions,
  findAdvertisedOption,
  labelFromAdvertisedOption,
  resolvedModelLabelForRecord,
  taglineFromAdvertisedOption,
  type AdvertisedModelOption,
} from "../src/models/claude-advertised-label.js";
import { readLastServedModel } from "../src/session/model-floor.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

function opt(value: string, name: string, description: string | null): AdvertisedModelOption {
  return { value, name, description };
}

// [option, expected label, expected tagline]
const CENSUS_ROWS: [AdvertisedModelOption, string | undefined, string | undefined][] = [
  [
    opt("default", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"),
    "Opus 5.5",
    "Best for everyday, complex tasks",
  ],
  [
    opt("opus", "Opus", "Opus 5.5 · Best for everyday, complex tasks"),
    "Opus 5.5",
    "Best for everyday, complex tasks",
  ],
  [
    opt("sonnet", "Sonnet", "Sonnet 5.5 · Efficient for routine tasks"),
    "Sonnet 5.5",
    "Efficient for routine tasks",
  ],
  [
    opt("fable", "Fable", "Fable 5.1 · Most capable for your hardest and longest-running tasks"),
    "Fable 5.1",
    "Most capable for your hardest and longest-running tasks",
  ],
  [
    opt("haiku", "Haiku", "Haiku 4.5 · Fastest for quick answers"),
    "Haiku 4.5",
    "Fastest for quick answers",
  ],
  // The measured no-credential probe (API form): rule 2, and a price is never a tagline.
  [
    opt(
      "default",
      "Default (recommended)",
      "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
    ),
    "Opus 5.5",
    undefined,
  ],
  [
    opt("opus", "Opus", "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok"),
    "Opus 5.5",
    "Best for everyday, complex tasks",
  ],
  [
    opt(
      "default",
      "Default (recommended)",
      "Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok",
    ),
    "Opus 5 (1M)",
    undefined,
  ],
  [
    opt("default", "Default (recommended)", "Opus 5 with 1M context · Best for everyday tasks"),
    "Opus 5 (1M)",
    "Best for everyday tasks",
  ],
  [
    opt("opus[1m]", "Opus (1M context)", "Opus 5 with 1M context · Best for everyday tasks"),
    "Opus 5 (1M)",
    "Best for everyday tasks",
  ],
  [opt("fable", "Fable", "Fable (1M context)"), "Fable (1M)", undefined],
  [opt("opus", "Opus", "Opus"), "Opus", undefined],
  [
    opt("opus", "Opus", "Opus 5 · Best for everyday, complex tasks"),
    "Opus 5",
    "Best for everyday, complex tasks",
  ],
  [opt("opus", "Opus", "Opus 4.8"), "Opus 4.8", undefined],
  // Segment 1 is PROSE on these — the label comes from the NAME, and no tagline.
  [
    opt("claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks (claude-opus-4-8)"),
    "Opus 4.8",
    undefined,
  ],
  [
    opt("claude-opus-4-8", "Opus 4.8", "Newer version available · select Opus for Opus 5"),
    "Opus 4.8",
    undefined,
  ],
  [
    opt("sonnet[1m]", "Sonnet 5 (1M context)", "Sonnet 5 for long sessions · $2/$10 per Mtok"),
    "Sonnet 5 (1M)",
    undefined,
  ],
  // A custom id is not a Claude label at all.
  [opt("z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash", "Custom model"), undefined, undefined],
];

test("every census + probe shape derives its label and tagline (CONTRACT §1.2 table)", () => {
  assert.equal(CENSUS_ROWS.length, 18, "the table must stay complete");
  for (const [option, label, tagline] of CENSUS_ROWS) {
    const shape = `${option.value} | ${option.name} | ${option.description}`;
    assert.equal(labelFromAdvertisedOption(option), label, `label of ${shape}`);
    assert.equal(taglineFromAdvertisedOption(option), tagline, `tagline of ${shape}`);
  }
});

test("FUTURE shapes need zero edits — a new version or window just reads through", () => {
  assert.equal(
    labelFromAdvertisedOption(opt("opus", "Opus", "Opus 6.2 · Best for everyday, complex tasks")),
    "Opus 6.2",
  );
  assert.equal(
    labelFromAdvertisedOption(opt("mythos", "Mythos", "Mythos 1 with 2M context · Huge")),
    "Mythos 1 (2M)",
  );
  assert.equal(
    labelFromAdvertisedOption(opt("opus", "Opus", "Opus 9.1 (500K context) · Test")),
    "Opus 9.1 (500K)",
  );
});

test("a REWORDED default template degrades to undefined — never prose", () => {
  // Negative cases: each of these would print a sentence as a model name under an
  // "always take segment 1" rule.
  for (const description of [
    "Use the default model, currently Opus 5.5 · $4/$20 per Mtok",
    "The recommended model for most tasks",
    "Newer version available",
  ]) {
    assert.equal(
      labelFromAdvertisedOption(opt("default", "Default (recommended)", description)),
      undefined,
      description,
    );
  }
  // No description at all → the name, when it is a label…
  assert.equal(labelFromAdvertisedOption({ value: "opus", name: "Opus" }), "Opus");
  // …and nothing when neither carries one.
  assert.equal(labelFromAdvertisedOption({ value: "x" }), undefined);
  assert.equal(labelFromAdvertisedOption(opt("x", "", null)), undefined);
});

test("advertisedModelOptions reads the `model` select only, flattening groups", () => {
  const configOptions: unknown[] = [
    { id: "mode", type: "select", options: [{ value: "plan", name: "Plan" }] },
    {
      id: "model",
      type: "select",
      currentValue: "opus",
      options: [
        { value: "default", name: "Default", description: "Opus 5.5 · x" },
        {
          group: "older",
          name: "Older",
          options: [{ value: "claude-opus-4-8", name: "Opus 4.8", description: null }],
        },
        { name: "no value — dropped" },
      ],
    },
  ];
  assert.deepEqual(advertisedModelOptions(configOptions), [
    { value: "default", name: "Default", description: "Opus 5.5 · x" },
    { value: "claude-opus-4-8", name: "Opus 4.8", description: null },
  ]);
  assert.equal(advertisedModelOptions([{ id: "mode", options: [] }]), undefined);
  assert.equal(advertisedModelOptions(undefined), undefined);
});

test("findAdvertisedOption matches the alias trimmed and case-insensitively", () => {
  const options = [opt("opus", "Opus", "Opus 5.5 · x"), opt("sonnet", "Sonnet", "Sonnet 5.5 · y")];
  assert.equal(findAdvertisedOption(options, " SONNET ")?.value, "sonnet");
  assert.equal(findAdvertisedOption(options, "haiku"), undefined);
  assert.equal(findAdvertisedOption(options, "  "), undefined);
});

// ── The record projection ─────────────────────────────────────────────────────

const ADVERTISED_9_1 = [
  {
    id: "model",
    name: "Model",
    type: "select" as const,
    currentValue: "default",
    options: [
      { value: "default", name: "Default (recommended)", description: "Opus 9.1 · Test tagline" },
      { value: "opus", name: "Opus", description: "Opus 9.1 · Test tagline" },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 9.1 · Test tagline" },
    ],
  },
];

function claudeRecord(acpx: SessionRecord["acpx"], agentCommand = CLAUDE_COMMAND): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "rec-label",
    acpSessionId: "sid-label",
    agentCommand,
    cwd: "/workspace/proj",
    acpx,
  });
}

test("a record whose advertisement says 'Opus 9.1' projects resolvedModelLabel 'Opus 9.1'", () => {
  const record = claudeRecord({
    current_model_id: "opus",
    config_options: ADVERTISED_9_1,
  });
  assert.equal(toSessionIndexEntry(record, "rec-label.json").resolvedModelLabel, "Opus 9.1");
});

test("the label is computed for the EFFECTIVE alias: current_model_id > pin > currentValue", () => {
  // current_model_id wins over a disagreeing pin and currentValue.
  assert.equal(
    resolvedModelLabelForRecord(
      claudeRecord({
        current_model_id: "sonnet",
        session_options: { model: "opus" },
        config_options: ADVERTISED_9_1,
      }),
    ),
    "Sonnet 9.1",
  );
  // ⚠️ THE CENSUS CASE: currentValue "default" (a stale creation snapshot) against an
  // `opus` pin — the pin must win, or most sessions would read the wrong model.
  const pinned = claudeRecord({
    session_options: { model: "sonnet" },
    config_options: ADVERTISED_9_1,
  });
  assert.equal(resolvedModelLabelForRecord(pinned), "Sonnet 9.1");
  // currentValue only when nothing else is known.
  assert.equal(
    resolvedModelLabelForRecord(claudeRecord({ config_options: ADVERTISED_9_1 })),
    "Opus 9.1",
  );
});

test("no clean label ⇒ the field is ABSENT, never a guess", () => {
  // No stored advertisement (a legacy record).
  assert.equal(resolvedModelLabelForRecord(claudeRecord({ current_model_id: "opus" })), undefined);
  // A pin the advertisement does not carry (custom model).
  assert.equal(
    resolvedModelLabelForRecord(
      claudeRecord({ current_model_id: "z-ai/glm-5.3-flash", config_options: ADVERTISED_9_1 }),
    ),
    undefined,
  );
  const entry = toSessionIndexEntry(claudeRecord({ current_model_id: "opus" }), "x.json");
  assert.equal("resolvedModelLabel" in JSON.parse(JSON.stringify(entry)), false);
});

test("the claude gate: codex / pi / synthetic commands never carry the label", () => {
  for (const command of [
    "node /opt/codex-acp/dist/index.js",
    "npx pi-acp@0.0.33",
    // ⚠️ A SYNTHETIC "claude" command — what fixtures use and no real record carries.
    "claude",
  ]) {
    const record = claudeRecord(
      { current_model_id: "opus", config_options: ADVERTISED_9_1 },
      command,
    );
    assert.equal(toSessionIndexEntry(record, "x.json").resolvedModelLabel, undefined, command);
  }
  // Positive control on the SAME record shape: the real adapter path does carry it.
  assert.equal(
    toSessionIndexEntry(
      claudeRecord({ current_model_id: "opus", config_options: ADVERTISED_9_1 }),
      "x.json",
    ).resolvedModelLabel,
    "Opus 9.1",
  );
});

test("servedModel is acpx.served.model verbatim, absent until a served turn", () => {
  const served = claudeRecord({
    current_model_id: "opus",
    config_options: ADVERTISED_9_1,
    served: {
      model: " claude-opus-9-1 ",
      at: "2026-10-02T00:00:00.000Z",
      source: "claude-transcript",
    },
  });
  assert.equal(toSessionIndexEntry(served, "x.json").servedModel, "claude-opus-9-1");
  assert.equal(toSessionIndexEntry(claudeRecord({}), "x.json").servedModel, undefined);
});

test("ROUND TRIP: both fields survive toSessionIndexEntry → writeSessionIndex → readSessionIndex", async () => {
  // ⚠️ The parse leg (`parseIndexEntry`) rebuilds EVERY untouched entry on each index
  // rewrite — a field missing there is stripped from all entries by the next write of
  // ANY session. Guard 5 of persisted-allowlist-roundtrip covers servedModel via the
  // sentinel's served.model; it cannot cover resolvedModelLabel, hence this row.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-label-index-"));
  try {
    const record = claudeRecord({
      current_model_id: "opus",
      config_options: ADVERTISED_9_1,
      served: { model: "claude-opus-9-1" },
    });
    const entry = toSessionIndexEntry(record, "rec-label.json");
    await writeSessionIndex(dir, { files: ["rec-label.json"], entries: [entry] });
    const reread = await readSessionIndex(dir);
    const [roundTripped] = reread?.entries ?? [];
    assert.equal(roundTripped?.resolvedModelLabel, "Opus 9.1");
    assert.equal(roundTripped?.servedModel, "claude-opus-9-1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── `<synthetic>` is not a served model (CONTRACT §2.5) ─────────────────────────

test("<synthetic>: the backwards scan skips it and returns the last REAL assistant model", async () => {
  await withTempHome("acpx-synthetic-", async (home) => {
    const record = claudeRecord({});
    const dir = path.join(home, ".claude", "projects", transcriptCwdHash(record.cwd));
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [] } },
      { type: "user", message: { role: "user", content: "stop" } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [] } },
    ];
    await fs.writeFile(
      path.join(dir, `${record.acpSessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    assert.equal(await readLastServedModel(record), "claude-opus-5-5");

    // Control: with only a synthetic entry there is no served model at all.
    await fs.writeFile(
      path.join(dir, `${record.acpSessionId}.jsonl`),
      `${JSON.stringify(lines[2])}\n`,
    );
    assert.equal(await readLastServedModel(record), undefined);
  });
});
