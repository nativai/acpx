import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentPodEnv, agentPodHome, tmpDir } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type {
  AtriumRequestRecord,
  AtriumScript,
  RecordedAtrium,
} from "./pod-kit/recorded-atrium.js";

// brick cc2f6a98, ruling of 2026-11-25 (CONTRACTS-r4 C6.2, "Clarified 2026-11-25 (cc2f6a98)"; row
// C6.2-Q.1): from an agent pod, the first message of a create is reported by ATRIUM's own queue —
// `promptQueued:true` once atrium queued it. ATRIUM owns that answer and its order (a0d5ac36). The
// pod client is NOT a second owner of the field: it relays atrium's answer, stdout and stderr, byte
// for byte (C6.2: "The pod-side acpx prints stdout and stderr"). These rows pin the relay through
// the SHIPPED `dist/cli.js` over the pod kit's recorded atrium, JSON and text. A pod client that
// reconciles `promptQueued` from `delivery` (the first design of this brick, dropped by the ruling)
// goes red on row 2.

/**
 * What the CONTROL pod's acpx prints for a sleeping create it was given no first turn for — the TE's
 * evidence line (acpx 5ed94dad, 08:14Z): `render.ts` `sleepingJson` + `printNewSessionByFormat`.
 */
const SLEEPING_CREATE_LINE =
  '{"action":"session_ensured","created":true,"acpxRecordId":"ed3e38bd-2768-48ca-8912-97aa64813288",' +
  '"acpxSessionId":"","agentSessionId":"","cwd":"/workspace","sessionUrl":"https://atrium.example/?session=ed3e38bd-2768-48ca-8912-97aa64813288",' +
  '"promptQueued":false,"sleeping":true}\n';

/** The SHIPPED bundle (`pnpm build` first): an in-process object can carry the right value while the CLI prints another (59070d68). */
const SHIPPED_CLI = path.resolve(process.cwd(), "dist/cli.js");

function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIPPED_CLI, ...argv], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end("");
  });
}

const BRIEF_ASK = ["sessions", "new", "--name", "child", "--prompt-file", "brief.md"];
const NOTICE = "[acpx] created session ed3e38bd-2768-48ca-8912-97aa64813288\n";

/** atrium's answer line when ITS queue took the brief (the contract's answer, C6.2-Q.1): true. */
const QUEUED_LINE = SLEEPING_CREATE_LINE.replace('"promptQueued":false', '"promptQueued":true');

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

async function spawnWithBrief(atrium: RecordedAtrium, argv: string[], brief = "the brief\n") {
  const { home } = agentPodHome();
  const work = tmpDir("acpx-cc2f-work-");
  fs.writeFileSync(path.join(work, "brief.md"), brief);
  const result = await runCli(argv, agentPodEnv(home, atrium.url), { cwd: work });
  const call = atrium.requests.find((r) => r.route === "call");
  return { result, call };
}

/**
 * The kit's atrium took the brief out of argv and queued it (`delivery.status:"queued"`, id = call id,
 * as acpx-ui passThrough.ts does) — so a row that sees `false` on stdout proves "not overridden", not
 * "no delivery".
 */
function assertBriefQueuedByAtrium(call: AtriumRequestRecord | undefined): void {
  assert.ok(call, "the call reached atrium");
  assert.equal(call.stdin, "the brief\n", "the brief travelled as stdin");
  assert.equal(call.ranArgv?.includes("--prompt-file"), false, "atrium took the brief out of argv");
}

test("cc2f relay 1: atrium's answer says promptQueued:true (delivery queued) — the caller sees that line byte for byte", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: QUEUED_LINE } }] }, async (atrium) => {
    const { result, call } = await spawnWithBrief(atrium, ["--format", "json", ...BRIEF_ASK]);
    assert.equal(result.status, 0, result.stderr);
    assertBriefQueuedByAtrium(call);
    assert.equal(result.stdout, QUEUED_LINE, "relayed verbatim");
    assert.equal(result.stderr, "");
  });
});

test("cc2f relay 2 (NEGATIVE — the pod client is not the owner): atrium's answer says false while its delivery says queued — the caller sees false", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { result, call } = await spawnWithBrief(atrium, ["--format", "json", ...BRIEF_ASK]);
      assert.equal(result.status, 0, result.stderr);
      assertBriefQueuedByAtrium(call);
      // the kit queued the brief (delivery.status "queued" under the call id) — and acpx still prints atrium's line
      assert.equal(result.stdout, SLEEPING_CREATE_LINE, "not reconciled from `delivery`");
      assert.equal(result.stdout.includes('"promptQueued":true'), false, result.stdout);
    },
  );
});

test("cc2f relay 3 (NEGATIVE): a held brief — atrium's `delivery.held` — changes nothing the client prints", async () => {
  await withAtrium(
    {
      calls: [{ answer: { exit: 0, stdout: QUEUED_LINE } }],
      firstMessageHold: { reason: "no_capacity", ahead: 2 },
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, ["--format", "json", ...BRIEF_ASK]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, QUEUED_LINE);
    },
  );
});

test("cc2f relay 4 (text mode): atrium's stdout and stderr are printed exactly — the client adds no 'first turn' line of its own", async () => {
  await withAtrium(
    {
      calls: [
        {
          answer: {
            exit: 0,
            stdout: "ed3e38bd-2768-48ca-8912-97aa64813288\n",
            stderr: `${NOTICE}[acpx] first turn queued (from brief.md)\n`,
          },
        },
      ],
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, BRIEF_ASK);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "ed3e38bd-2768-48ca-8912-97aa64813288\n");
      assert.equal(result.stderr, `${NOTICE}[acpx] first turn queued (from brief.md)\n`);
    },
  );
});

test("cc2f relay 5 (text mode, NEGATIVE): atrium's stderr does not say queued — the client does not say it either", async () => {
  await withAtrium(
    {
      calls: [
        { answer: { exit: 0, stdout: "ed3e38bd-2768-48ca-8912-97aa64813288\n", stderr: NOTICE } },
      ],
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, BRIEF_ASK);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, NOTICE);
      assert.doesNotMatch(result.stderr, /first turn queued/u);
    },
  );
});

test("cc2f relay 6 (NEGATIVE, the real failure): atrium could not queue the brief — non-zero exit, no promptQueued:true on stdout", async () => {
  await withAtrium(
    {
      calls: [
        {
          answer: {
            status: 500,
            body: {
              exit: 0,
              stdout: QUEUED_LINE,
              stderr: "",
              error: "first-message-not-queued",
              reason: "append failed",
            },
          },
        },
      ],
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, ["--format", "json", ...BRIEF_ASK]);
      assert.notEqual(result.status, 0, "the failure is loud");
      assert.equal(
        result.stdout.includes('"promptQueued":true'),
        false,
        "the 500's body stdout is not relayed as a success",
      );
    },
  );
});

test("cc2f relay 7: a create with NO brief is relayed verbatim too", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { home } = agentPodHome();
      const result = await runCli(
        ["--format", "json", "sessions", "new", "--name", "child"],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, SLEEPING_CREATE_LINE);
    },
  );
});

test("cc2f relay 8: a non-create verb is relayed verbatim, whatever its stdout looks like", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { home } = agentPodHome();
      const result = await runCli(
        ["--format", "json", "seats", "rename", "11111111-1111-4111-8111-111111111111", "x"],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, SLEEPING_CREATE_LINE);
    },
  );
});
