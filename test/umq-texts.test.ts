import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CapacitySnapshot } from "../src/capacity/reading.js";
import { readWaiting } from "../src/capacity/waiting.js";
import { waitingLine } from "../src/cli/capacity-command.js";
import { noticeDeliveredText, noticeNotDeliveredText } from "../src/cli/command-handlers.js";
import {
  atriumDownRefusalLine,
  deliveredDirectlyLine,
  formatAhead,
  ROUTED_WAIT_MODE_LINE,
  routedPromptLine,
} from "../src/cli/prompt-routing.js";
import { admissionDir, makeBox, makeTarget, runCli } from "./umq-rig.js";

// UMQ lane A2 — what senders are told (AC11, CONCEPTION §7, UX §11) and the waiting line (§6.5, S4).
// The scan is by CONSTRUCTION over the source tree (a new offending string anywhere in `src/` fails it
// without being registered) plus the rendered golden texts of the message paths.

const AC11 =
  /retry later|retry in|retry once|send it again|send it later|never in a loop|--final-report/iu;

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/u.test(line);

/**
 * The AC11 phrases that may remain in acpx — each is NOT a sentence on a message path, with the
 * reason. The allow-list of CONCEPTION §13 AC11 is the first entry: `WAKE_BUSY_LINE`.
 */
const REMAINING: Array<{ file: string; contains: string; why: string }> = [
  {
    file: "capacity/admission.ts",
    contains: "other session starts held the box's admission lock",
    why: "AC11 allow-list: acpx's busy line (a wake refused because the admission lock was held)",
  },
  {
    file: "capacity/admission.ts",
    contains: "other session creations held the box's admission lock",
    why: "the CREATE refusal (decision 8 keeps its wording; `create-output`, not a message path)",
  },
  {
    file: "capacity/admission.ts",
    contains: "the box is stalling on memory right now",
    why: "the CREATE refusal (decision 8)",
  },
  {
    file: "capacity/admission.ts",
    contains: "the box is borrowing above its memory request",
    why: "the CREATE refusal (decision 8)",
  },
  {
    file: "capacity/admission.ts",
    contains: "needs to start its agent for a few seconds",
    why: "the ownerless `set` refusal (5c44d8ba): a settings change, never a message",
  },
  {
    file: "cli/output/output.ts",
    contains: "the provider appears rate-limited",
    why: "a provider rate-limit hint on a failed turn, not a send",
  },
];

test("N-A2-10 · AC11 (acpx): no source line of acpx outside the listed remainders contains a retry/resend phrase or `--final-report`; the retired identifiers are gone", () => {
  const hits: Array<{ file: string; line: string }> = [];
  const retired: string[] = [];
  const retiredIdentifiers =
    /FINAL_REPORT_LINE|NOT_FOR_YOU_LINE|\bRETRY_LINE\b|BLOCKED_LEAF_LINE|PRE_S1_HINT|finalReportOffer|wakeRetryLine|finalReportLine|FinalReportWhy|finalReportSupported|capabilitiesDirOf/u;
  // `senderRole` / `crossBox` were the wake gate's inputs; `crossBox` also names an unrelated
  // parent-edge field in session-reparent.ts, so these two are scanned where the gate lives.
  const wakeGateInputs = /\bsenderRole\b|\bcrossBox\b/u;
  const wakeGateFiles = /^(capacity\/|cli\/capacity-command\.ts|cli\/session\/wake-gate\.ts)/u;
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (isComment(line)) {
        continue;
      }
      if (AC11.test(line)) {
        hits.push({ file: rel, line });
      }
      if (retiredIdentifiers.test(line) || (wakeGateFiles.test(rel) && wakeGateInputs.test(line))) {
        retired.push(`${rel}: ${line.trim()}`);
      }
    }
  }
  const unlisted = hits.filter(
    (hit) =>
      !REMAINING.some((entry) => entry.file === hit.file && hit.line.includes(entry.contains)),
  );
  assert.deepEqual(unlisted, [], "an AC11 phrase outside the listed remainders");
  for (const entry of REMAINING) {
    assert.ok(
      hits.some((hit) => hit.file === entry.file && hit.line.includes(entry.contains)),
      `the remainder "${entry.contains}" no longer exists — drop it from the list (${entry.why})`,
    );
  }
  assert.deepEqual(retired, [], "a retired sentence/identifier is still reachable");
  // The control: the scan flags a planted phrase.
  assert.ok(AC11.test("acpx: Retry Later, never in a loop"), "the regex bites");
  assert.ok(AC11.test("send it with 'send-message.sh --final-report' instead"));
});

test("N-A2-10 · the rendered golden texts of the acpx message paths contain none of the AC11 phrases except the allow-listed lines", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  const goldens: string[] = [
    routedPromptLine(
      { delivery_id: "7f0c0000-0000-4000-8000-000000000001", to: "x", status: "queued" },
      "lane-a",
    ),
    routedPromptLine(
      {
        delivery_id: "7f0c0000-0000-4000-8000-000000000002",
        to: "x",
        status: "queued",
        held: { since: "2026-11-09T12:00:00Z", reason: "no_capacity", ahead: 0 },
      },
      "lane-a",
    ),
    routedPromptLine(
      {
        delivery_id: "7f0c0000-0000-4000-8000-000000000003",
        to: "x",
        status: "queued",
        held: { since: "2026-11-09T12:00:00Z", reason: "no_capacity", ahead: 4 },
      },
      "lane-a",
    ),
    ROUTED_WAIT_MODE_LINE,
    deliveredDirectlyLine("7f0c0000-0000-4000-8000-000000000004"),
    noticeDeliveredText("holder-two", { deliveryId: "d1" }),
    noticeDeliveredText("holder-two", { deliveryId: "d1", held: true }),
    noticeNotDeliveredText({ reason: "acpx-ui answered HTTP 500" }),
  ];
  // The wake refusal, as `acpx prompt` (an agent in an owner tree on a FULL box) and `admit-wake` print it.
  const env = { ...f.env, ACPX_SESSION_RECORD_ID: "sess-caller" };
  const prompt = await runCli(
    [
      "--agent",
      f.agent,
      "--cwd",
      path.join(f.root, "work"),
      "prompt",
      "--session-id",
      id,
      "--no-wait",
      "hello",
    ],
    env,
    f.root,
  );
  assert.equal(prompt.code, 75, prompt.stderr);
  goldens.push(prompt.stderr, prompt.stdout);
  const admit = await runCli(
    ["--format", "json", "capacity", "admit-wake", "--session-id", id, "--class", "delivery"],
    f.env,
    f.root,
  );
  assert.equal(admit.code, 75, admit.stderr);
  goldens.push(admit.stdout, admit.stderr);

  for (const text of goldens) {
    assert.doesNotMatch(text, AC11, text);
  }
  // The allow-listed fallback sentence is the ONE retained instruction, and says what it must.
  const fallback = atriumDownRefusalLine("lane-a (session 5ea7c0de)");
  assert.match(fallback, /atrium's message queue did not answer, so nothing was queued/u);
  assert.equal(AC11.test(fallback), false, "it uses 'sent again', which is not on the AC11 list");
  assert.equal(formatAhead(0), "next in line");
});

// ─── the waiting line ────────────────────────────────────────────────────────────────────────

function waitingFixture(name: string): {
  count: number;
  items: CapacitySnapshot["waiting"]["items"];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-waiting-"));
  const waiting = path.join(dir, "waiting");
  fs.mkdirSync(waiting, { recursive: true });
  const source = fileURLToPath(
    new URL(`../../test/fixtures/capacity/waiting/${name}`, import.meta.url),
  );
  const target = path.join(waiting, "atrium-test.json");
  fs.copyFileSync(source, target);
  const now = new Date();
  fs.utimesSync(target, now, now);
  return readWaiting(dir, now);
}

const snapshotOf = (waiting: ReturnType<typeof waitingFixture>, cls: "spawn" | "automation") =>
  ({ waiting, class: cls }) as unknown as CapacitySnapshot;

test("N-A2-14 · §6.5: a waiting item for a never-run recipient reads `opening prompt → <seat name>` and the effect clause is the new one", () => {
  const line = waitingLine(
    snapshotOf(waitingFixture("atrium-example-v2.json"), "spawn"),
    new Date("2026-11-09T14:00:00.000Z"),
  );
  assert.equal(
    line,
    "waiting: 3 queued for room since 13:02Z (opening prompt → nightly-rebake, 2 messages → hod-wave9, lane-a → parent-x) — atrium wakes them oldest first as room frees, each with everything waiting for it; the slots above already leave room for them",
  );
  assert.doesNotMatch(line ?? "", /they start before new agent sessions/u);
});

test("N-A2-12 · S4: an OLD atrium's waiting file with `wakeup` / `trigger-run` items is still labelled", () => {
  const line = waitingLine(
    snapshotOf(waitingFixture("atrium-example.json"), "spawn"),
    new Date("2026-10-31T02:00:00.000Z"),
  );
  assert.ok(line?.includes("wakeup re-baker-2026-10-31"), line);
  assert.ok(line?.includes("brick run 3f2a1c…"), line);
  assert.ok(line?.includes('"Implement X"'), line);
});

test("capacity JSON advertises `sessions-new-sleeping` (K9) and no final-report marker field", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await runCli(["--format", "json", "capacity"], f.env, f.root);
  assert.equal(run.code, 0, run.stderr);
  const json = JSON.parse(run.stdout.trim()) as { features?: string[] };
  assert.ok(json.features?.includes("sessions-new-sleeping"), JSON.stringify(json.features));
  assert.doesNotMatch(run.stdout, /finalReport/u);
  assert.equal(fs.existsSync(path.join(admissionDir(f), "capabilities")), false);
});
