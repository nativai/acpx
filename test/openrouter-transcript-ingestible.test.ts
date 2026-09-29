import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OPENROUTER_HARNESS_HOME_PREFIX, openRouterHarnessHomeDir } from "../src/acp/auth-env.js";
import { subscriptionsDir } from "../src/config/subscriptions.js";

/**
 * THE PERMANENT NEGATIVE TEST for brick e30b3f6a — an OpenRouter-routed Claude
 * session's transcript must stay reachable by acpx-ui's usage ingester.
 *
 * ## What happened, so nobody deletes this as redundant
 *
 * `startOpenRouterShimForSession` put `CLAUDE_CONFIG_DIR` at
 * `join(tmpdir(), "or-" + sessionId)`. Claude Code therefore wrote its transcript
 * to `/tmp/or-<record-id>/projects/<cwd-slug>/<acp-session-id>.jsonl`, and
 * acpx-ui's ingester — which only ever looks under the subscriptions root — found
 * nothing, ingested nothing, and committed a clean skip-state. Every such session
 * spent real money on the box's OpenRouter key and reported **$0**, with no
 * warning on any surface, and `/tmp` being the ephemeral container overlay meant
 * the evidence disappeared at the next pod restart. Six of the seven sessions
 * this ever happened to are unrecoverable; the one survivor carried ~166 billed
 * messages, a floor of roughly $12.65.
 *
 * ## ⚠️ WHY THIS TEST TRANSCRIBES THE READER'S RULE INSTEAD OF IMPORTING IT
 *
 * The defect lives in a **seam between two repos**: acpx decides where the
 * transcript is written, acpx-ui decides where it is looked for, and neither
 * repo's suite can see both halves. acpx cannot import acpx-ui, so
 * `readerWouldResolve` below is a deliberate, documented transcription of
 * `acpx-ui/server/claudeJsonlUsage.ts` (`subscriptionDirs` + `resolveJsonlPaths`,
 * primary cwd-slug leg) as of acpx-ui@b12b346b.
 *
 * **A transcription can drift from the thing it transcribes, and that is a real
 * residual — stated, not hidden.** It is pinned from the other side by
 * `acpx-ui/server/claudeJsonlUsage.openrouter.test.ts`, which asserts the reader
 * accepts ANY child of the subscriptions root having a `projects/` subdir,
 * registry membership irrelevant. The two files are each other's anchor: narrow
 * the reader and acpx-ui reds; move the writer and this file reds. Neither
 * suite alone proves the seam — only a real session does, which is why this
 * brick also carries an end-to-end proof.
 *
 * ## What each case is for
 *
 *   POSITIVE  — the product's own path, laid out as the harness lays it out, is
 *               found by the reader's rule. Reds if the writer moves anywhere the
 *               reader cannot see.
 *   NEGATIVE  — the EXACT pre-fix layout under `tmpdir()`, run through the SAME
 *               rule, must find nothing. This is the defect itself, committed as
 *               an assertion, so the rule is exercised in both directions forever
 *               rather than being trusted because it passed once.
 *   NAMESPACE — the directory name cannot be a registry id. It sits beside real
 *               credential dirs, so a name collision would point a Claude adapter
 *               at a real account's credentials.
 */

/**
 * A faithful transcription of acpx-ui's resolver — see the file header for why a
 * transcription and not an import, and for what pins it against drift.
 *
 * `subscriptionDirs`: every immediate child of the root that has a `projects/`
 * subdir. Deliberately ignorant of `registry.json` — the reader's own comment
 * says it is "robust to the registry format (we don't parse it)", which is the
 * property that lets an `or-<id>` directory be a transcript source and nothing
 * else.
 *
 * `resolveJsonlPaths` primary leg: `<sub>/projects/<cwd with '/'→'-'>/<acpSessionId>.jsonl`.
 */
function readerWouldResolve(
  subscriptionsRoot: string,
  acpSessionId: string,
  cwd: string,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(subscriptionsRoot);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const projects = path.join(subscriptionsRoot, entry, "projects");
    try {
      if (!fs.statSync(projects).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const candidate = path.join(projects, cwd.replace(/\//g, "-"), `${acpSessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/** Lay out a harness home exactly as Claude Code does, and return the JSONL path. */
function writeHarnessTranscript(configDir: string, acpSessionId: string, cwd: string): string {
  const projectDir = path.join(configDir, "projects", cwd.replace(/\//g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonl = path.join(projectDir, `${acpSessionId}.jsonl`);
  fs.writeFileSync(
    jsonl,
    `${JSON.stringify({
      type: "assistant",
      requestId: "req_partc",
      timestamp: "2026-09-29T12:00:00.000Z",
      message: {
        id: "msg_partc",
        model: "z-ai/glm-5.3-flash",
        usage: { input_tokens: 11, output_tokens: 22 },
      },
    })}\n`,
  );
  return jsonl;
}

/**
 * Point `subscriptionsDir()` at a scratch root for the duration of `body`.
 * acpx resolves it as `<ACPX_STATE_HOME || homedir()>/.acpx/subscriptions`, so
 * overriding `ACPX_STATE_HOME` moves the root without touching the real store.
 */
function withScratchStateHome(body: (subscriptionsRoot: string) => void): void {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "partc-state-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  try {
    const root = subscriptionsDir();
    fs.mkdirSync(root, { recursive: true });
    // Guard against a vacuous pass: if the override did not take, the rest of
    // this test would be measuring the real store instead of the scratch one.
    assert.equal(
      root,
      path.join(stateHome, ".acpx", "subscriptions"),
      "ACPX_STATE_HOME override did not reach subscriptionsDir()",
    );
    body(root);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

const RECORD_ID = "5b146e33-9893-4dd3-957e-9a84354c654f";
const ACP_SESSION_ID = "7530a795-fb82-4fca-8f86-5a8b5432802d";
const CWD = "/workspace/projects/acpx-ui";

test("POSITIVE — the OpenRouter harness home is where acpx-ui's ingester looks", () => {
  withScratchStateHome((root) => {
    const configDir = openRouterHarnessHomeDir(RECORD_ID);
    const jsonl = writeHarnessTranscript(configDir, ACP_SESSION_ID, CWD);

    const resolved = readerWouldResolve(root, ACP_SESSION_ID, CWD);

    assert.deepEqual(
      resolved,
      [jsonl],
      "the reader must resolve exactly the transcript the harness wrote at the product's own path",
    );
  });
});

test("NEGATIVE — the pre-fix tmpdir layout is invisible to the same reader rule", () => {
  withScratchStateHome((root) => {
    // The EXACT shape the defect had: `join(tmpdir(), "or-" + sessionId)`.
    const preFixDir = fs.mkdtempSync(path.join(os.tmpdir(), "partc-tmproot-"));
    const legacyConfigDir = path.join(preFixDir, `or-${RECORD_ID}`);
    try {
      const jsonl = writeHarnessTranscript(legacyConfigDir, ACP_SESSION_ID, CWD);
      // The transcript genuinely exists — this case fails for the RIGHT reason
      // (out of the reader's reach), never because nothing was written.
      assert.ok(fs.existsSync(jsonl), "control: the legacy-layout transcript must exist on disk");

      assert.deepEqual(
        readerWouldResolve(root, ACP_SESSION_ID, CWD),
        [],
        "a transcript outside the subscriptions root must remain unreachable — " +
          "this is the defect, and it must stay reproducible",
      );
    } finally {
      fs.rmSync(preFixDir, { recursive: true, force: true });
    }
  });
});

/**
 * ⚠️ THIS IS THE CASE THAT CATCHES A REVERSION, AND IT IS DELIBERATELY NOT
 * "assert the path is not under tmpdir()".
 *
 * That obvious form is **environment-coupled, not product-coupled**: the scratch
 * root this suite builds is itself created under `os.tmpdir()`, so the assertion
 * fails against a perfectly correct product — and in an environment where
 * `ACPX_STATE_HOME` pointed somewhere else it would pass against a BROKEN one.
 * It measures where the test's fixture lives, not what the product computes.
 *
 * The property that actually distinguishes fixed from broken is INVARIANCE: the
 * pre-fix `join(tmpdir(), "or-" + sessionId)` ignores the subscriptions root
 * entirely, so it returns the SAME path no matter where that root moves. Run the
 * product against two different roots and a correct implementation must give two
 * different answers. Nothing in the environment can satisfy this by accident.
 */
test("NEGATIVE — the harness home tracks the subscriptions root; a tmpdir()-derived path cannot", () => {
  const produced: string[] = [];

  for (let arm = 0; arm < 2; arm++) {
    withScratchStateHome((root) => {
      const configDir = openRouterHarnessHomeDir(RECORD_ID);
      assert.equal(
        path.dirname(configDir),
        root,
        "the harness home must be an immediate child of the subscriptions root — " +
          "the reader enumerates children of that root and nothing deeper",
      );
      produced.push(configDir);
    });
  }

  assert.equal(produced.length, 2, "control: both arms must have run");
  assert.notEqual(
    produced[0],
    produced[1],
    "the harness home must move with the subscriptions root. A path composed from " +
      "tmpdir() is invariant under that move and would produce the same string twice — " +
      "which is exactly the defect this brick closed.",
  );
});

test("NAMESPACE — the harness home cannot shadow a registry id", () => {
  withScratchStateHome(() => {
    const name = path.basename(openRouterHarnessHomeDir(RECORD_ID));

    assert.equal(
      name,
      `${OPENROUTER_HARNESS_HOME_PREFIX}${RECORD_ID}`,
      "the prefix is what keeps this name out of the registry's namespace",
    );
    // The live registry ids on this fleet are `subN` / `codexgpt`. The guarantee
    // is not that today's ids differ — it is that the prefix makes the two
    // namespaces disjoint, so a new id cannot collide either.
    for (const registryId of ["sub3", "sub8", "sub10", "codexgpt", RECORD_ID]) {
      assert.notEqual(
        name,
        registryId,
        `a harness home named "${registryId}" would point the adapter at a real credential dir`,
      );
    }
  });
});

test("ISOLATION — a freshly created harness home holds no credentials", () => {
  withScratchStateHome(() => {
    const configDir = openRouterHarnessHomeDir(RECORD_ID);
    fs.mkdirSync(configDir, { recursive: true });

    // The whole purpose of the per-session dir (brick 007eaac8) is that the
    // adapter cannot inherit the box's real Claude OAuth. That property comes
    // from the directory being fresh and empty, not from where it lives — which
    // is exactly what licensed moving it. Assert the property, not the parent.
    assert.deepEqual(
      fs.readdirSync(configDir),
      [],
      "a newly created harness home must be empty — no inherited credential material",
    );
    assert.equal(
      fs.existsSync(path.join(configDir, ".credentials.json")),
      false,
      "a harness home must never carry a credentials file",
    );
  });
});
