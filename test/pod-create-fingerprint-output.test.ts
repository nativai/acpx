import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequestFingerprint } from "../src/pod/create-plan.js";
import {
  createdRecordIds,
  type Fixture,
  makeBox,
  makeTarget,
  runCli,
  type Run,
} from "./umq-rig.js";

// A-82 item (1), row 82.1 (brick 6fb427d7) — C6.2: the output options (`--format`, `--json-strict`; a CLOSED
// list kept in acpx) are not part of a create's request. A replay that differs from the first call ONLY in
// them is an identical replay: exit 0, nothing written, and the JSON answer a JSON first call would have
// given. Atrium's pass-through replays a text-mode create as JSON (S2 / row 82.2 is atrium's half).
// Every other argument still counts (A-20 / M-2, `test/pod-create-plan.test.ts`, stays as it is).

const RECORD_ID = "82a82a82-0000-4000-8000-000000000001";
const CALL_ID = "82c82c82-0000-4000-8000-000000000001";
const ORACLE_RECORD_ID = "82a82a82-0000-4000-8000-0000000000f1";
const ORACLE_CALL_ID = "82c82c82-0000-4000-8000-0000000000f1";

/** Pod mode through A1's seams (`ACPX_POD_TEST_HOME`, `ACPX_POD_SA_DIR` — honoured under `node --test` only). */
const pod = (f: Fixture): NodeJS.ProcessEnv => {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  return {
    ...f.env,
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
  };
};

/** The rig's global flags with NO output option: what a text-mode create is run with. */
const textBase = (f: Fixture): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  path.join(f.root, "work"),
  "--approve-all",
];

/** The output-option spellings a replay can arrive with. Each is a separate row of the closed list. */
const OUTPUT_SPELLINGS: Array<{ name: string; flags: string[] }> = [
  { name: "--format json", flags: ["--format", "json"] },
  { name: "--format=json", flags: ["--format=json"] },
  { name: "--json-strict", flags: ["--json-strict"] },
  { name: "--format json --json-strict", flags: ["--format", "json", "--json-strict"] },
];

/** Every file under the state dir, path and bytes, hashed: a replay must leave this unchanged. */
function stateDigest(f: Fixture): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).toSorted()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      hash.update(`${path.relative(f.root, full)}\n`);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(path.join(f.root, ".acpx"));
  return hash.digest("hex");
}

type Answer = Record<string, unknown>;
const answerOf = (run: Run): Answer =>
  JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Answer;

/** An answer with its record ids and timestamps masked, so two creates of one form compare. */
function masked(answer: Answer, ids: string[]): string {
  let text = JSON.stringify(answer, Object.keys(answer).toSorted());
  for (const id of ids) {
    text = text.split(id).join("<record-id>");
  }
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, "<time>");
}

type Form = { name: string; argv: (source: string, template: string) => string[]; key: string };
const FORMS: Form[] = [
  {
    name: "a plain copy (carries a forkNotice)",
    argv: (source) => ["sessions", "copy", "--from", source],
    key: "forkNotice",
  },
  {
    name: "a template spawn whose template has an auto-prompt (carries a templatePrompt)",
    argv: (_source, template) => ["sessions", "new", "--from-template", template],
    key: "templatePrompt",
  },
];

async function makeBoxWithSources(): Promise<{ f: Fixture; source: string; template: string }> {
  const f = makeBox({ requestMib: 4000 });
  const source = await makeTarget(f);
  const template = await makeTarget(f);
  const marked = await runCli(
    [
      ...textBase(f),
      "--format",
      "json",
      "sessions",
      "template",
      template,
      "--enable",
      "--auto-prompt",
      "do the thing",
    ],
    f.env,
    f.root,
  );
  assert.equal(marked.code, 0, marked.stderr);
  return { f, source, template };
}

for (const form of FORMS) {
  test(`row 82.1 / C6.2 (A-82): ${form.name} first run in TEXT mode, repeated with an output option — exit 0, nothing written, the JSON answer a JSON first call gives`, async () => {
    const { f, source, template } = await makeBoxWithSources();
    const ids = ["--record-id", RECORD_ID, "--created-by-call", CALL_ID];
    const oracleIds = ["--record-id", ORACLE_RECORD_ID, "--created-by-call", ORACLE_CALL_ID];

    // The oracle: what a JSON FIRST call of this form answers (another record and call id).
    const oracle = await runCli(
      [...textBase(f), "--format", "json", ...form.argv(source, template), ...oracleIds],
      pod(f),
      f.root,
    );
    assert.equal(oracle.code, 0, oracle.stderr);
    const expected = answerOf(oracle);
    assert.equal(
      typeof expected[form.key],
      "string",
      `the control: a JSON first call has ${form.key}`,
    );

    const first = await runCli(
      [...textBase(f), ...form.argv(source, template), ...ids],
      pod(f),
      f.root,
    );
    assert.equal(first.code, 0, first.stderr);
    assert.ok(
      createdRecordIds(f).includes(RECORD_ID),
      "the text-mode first call created the record",
    );
    const before = stateDigest(f);

    for (const spelling of OUTPUT_SPELLINGS) {
      const repeat = await runCli(
        [...textBase(f), ...spelling.flags, ...form.argv(source, template), ...ids],
        pod(f),
        f.root,
      );
      assert.equal(repeat.code, 0, `${spelling.name}: ${repeat.stderr}${repeat.stdout}`);
      assert.equal(stateDigest(f), before, `${spelling.name}: nothing was written`);
      const answer = answerOf(repeat);
      assert.equal(answer.acpxRecordId, RECORD_ID, `${spelling.name}: the first call's record`);
      assert.equal(typeof answer[form.key], "string", `${spelling.name}: carries ${form.key}`);
      assert.equal(
        masked(answer, [RECORD_ID]),
        masked(expected, [ORACLE_RECORD_ID]),
        `${spelling.name}: the answer a JSON first call would have given`,
      );
    }
  });

  test(`row 82.1 negative (A-82): ${form.name} — a repeat that differs in ANY other argument is still refused CREATE_REPLAY_MISMATCH (exit 2), with or without an output option, and writes nothing`, async () => {
    const { f, source, template } = await makeBoxWithSources();
    const ids = ["--record-id", RECORD_ID, "--created-by-call", CALL_ID];
    const first = await runCli(
      [...textBase(f), ...form.argv(source, template), "--name", "first", ...ids],
      pod(f),
      f.root,
    );
    assert.equal(first.code, 0, first.stderr);
    const before = stateDigest(f);
    for (const output of [[], ...OUTPUT_SPELLINGS.map((spelling) => spelling.flags)]) {
      const repeat = await runCli(
        [...textBase(f), ...output, ...form.argv(source, template), "--name", "another", ...ids],
        pod(f),
        f.root,
      );
      assert.equal(repeat.code, 2, `${output.join(" ")}: ${repeat.stderr}`);
      assert.match(repeat.stdout + repeat.stderr, /CREATE_REPLAY_MISMATCH/u, output.join(" "));
      assert.equal(stateDigest(f), before, `${output.join(" ")}: nothing was written`);
    }
  });
}

// ─── records written by the OLD build (architect #21: old-scheme handling is REQUIRED) ─────────────

/** The OLD build's fingerprint, byte for byte: sha256 of `JSON.stringify(argv)` over the WHOLE argv, 32 hex. */
const oldBuildFingerprint = (argv: string[]): string =>
  createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 32);

for (const form of FORMS) {
  for (const firstMode of [
    { name: "a --format json first call", output: ["--format", "json"] },
    { name: "a text-mode first call", output: [] as string[] },
  ]) {
    test(`row 82.1 old scheme (A-82, architect #21): ${form.name}, its record written by the OLD build (${firstMode.name}), replayed IDENTICALLY by the new build — exit 0, nothing written, never CREATE_REPLAY_MISMATCH`, async () => {
      const { f, source, template } = await makeBoxWithSources();
      const ids = ["--record-id", RECORD_ID, "--created-by-call", CALL_ID];
      const argv = [...textBase(f), ...firstMode.output, ...form.argv(source, template), ...ids];
      const first = await runCli(argv, pod(f), f.root);
      assert.equal(first.code, 0, first.stderr);
      // Make the record what the old build wrote: its fingerprint over the whole argv, output options included.
      const file = path.join(f.root, ".acpx", "sessions", `${RECORD_ID}.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as {
        metadata: Record<string, string>;
      };
      const old = oldBuildFingerprint(argv);
      assert.notEqual(
        record.metadata.created_by_request,
        undefined,
        "the control: a fingerprint is stored",
      );
      record.metadata.created_by_request = old;
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      const before = stateDigest(f);

      const identical = await runCli(argv, pod(f), f.root);
      assert.equal(
        identical.code,
        0,
        `an identical retry of an old-build create: ${identical.stderr}`,
      );
      assert.doesNotMatch(identical.stdout + identical.stderr, /CREATE_REPLAY_MISMATCH/u);
      assert.equal(stateDigest(f), before, "nothing was written");
      assert.equal(answerOf(identical).acpxRecordId, RECORD_ID);

      if (firstMode.output.length === 0) {
        // A text first call on the old build hashed an argv with no output option: atrium's JSON second call
        // is the same request.
        const json = await runCli(
          [...textBase(f), "--format", "json", ...form.argv(source, template), ...ids],
          pod(f),
          f.root,
        );
        assert.equal(json.code, 0, `${json.stderr}${json.stdout}`);
        assert.equal(stateDigest(f), before, "nothing was written");
        assert.equal(typeof answerOf(json)[form.key], "string");
      }

      // Only the closed list passes: a repeat that differs in another argument is still refused.
      const other = await runCli(
        [
          ...textBase(f),
          ...firstMode.output,
          ...form.argv(source, template),
          "--name",
          "other",
          ...ids,
        ],
        pod(f),
        f.root,
      );
      assert.equal(other.code, 2, other.stderr);
      assert.match(other.stdout + other.stderr, /CREATE_REPLAY_MISMATCH/u);
      assert.equal(stateDigest(f), before, "nothing was written");
    });
  }
}

// ─── the fingerprint itself (unit) ─────────────────────────────────────────────────────────────────

const CREATE = [
  "sessions",
  "copy",
  "--from",
  "src-1",
  "--record-id",
  "r-1",
  "--created-by-call",
  "c-1",
];

test("row 82.1 unit (A-82): the fingerprint ignores `--format <v>`, `--format=<v>` and `--json-strict` wherever they stand — and nothing else", () => {
  const plain = createRequestFingerprint(CREATE);
  for (const variant of [
    ["--format", "json", ...CREATE],
    ["--format=json", ...CREATE],
    ["--json-strict", ...CREATE],
    ["--format", "json", "--json-strict", ...CREATE],
    [...CREATE.slice(0, 2), "--format", "json", ...CREATE.slice(2)],
    [...CREATE, "--format", "quiet"],
    ["--format", "text", ...CREATE],
  ]) {
    assert.equal(createRequestFingerprint(variant), plain, variant.join(" "));
  }
});

test("row 82.1 unit negative (A-82): every other argument still counts — another name, source, cut, order-sensitive position, a value that merely looks like an output option after `--`", () => {
  const plain = createRequestFingerprint(CREATE);
  for (const variant of [
    [...CREATE, "--name", "another"],
    CREATE.map((arg) => (arg === "src-1" ? "src-2" : arg)),
    [...CREATE, "--at-log-index", "2"],
    [...CREATE, "--ephemeral"],
    ["--verbose", ...CREATE],
    ["--suppress-reads", ...CREATE],
    ["--approve-all", ...CREATE],
    [...CREATE, "--", "--format", "json"],
    [...CREATE, "--metadata", "format=json"],
  ]) {
    assert.notEqual(createRequestFingerprint(variant), plain, variant.join(" "));
  }
});
