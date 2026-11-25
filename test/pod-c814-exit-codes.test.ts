import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// Brick c8146ccd — two pod refusals that exited 1 where CONTRACTS-r4 C7.2 says exit 2 (the same class as brick
// 59070d68 F-1). Atrium's `classifyPodOutcome` finds a REFUSED token only at exit 75 or 2, so a refusal at exit 1 is an
// "outcome unknown" to the delivery runner (A-53).
//
// Every row drives the SHIPPED `dist/cli.js` (needs `pnpm build`), in text AND json mode: the unit tests of the error
// classes cannot see the top-level handler's `normalizeOutputError` → `exitCodeForOutputErrorCode` mapping, which is
// where an error that carries no `outputCode` becomes RUNTIME = exit 1.
//
//   C7.2-B.1  `bridge_on_control_pod what=<adapter|owner>` — the spawn tripwire, at BOTH spawn sites.
//   A-25      `pod_identity_missing` from a lock writer — a writer that cannot name its pod.
//
// The placement step never lets a bridge-starting command, or a writer on a host without an identity, through on its
// own; the rows reach the sites by `ACPX_POD_TEST_SKIP_PLACEMENT=1` (src/cli.ts, honoured only under `node --test`).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");
const MOCK = `node ${JSON.stringify(path.join(HERE, "mock-agent.js"))} --supports-load-session`;

const RECORD_ID = "c814c814-0000-4000-8000-000000000001";

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-c814-"));
}

function saDir(): string {
  const dir = makeHome();
  fs.writeFileSync(path.join(dir, "namespace"), "dev-devbox\n");
  return dir;
}

/** A control-role host in pod mode (the product's own seam, A-6), the identity complete unless `identity` is false. */
function podEnv(
  home: string,
  opts: {
    identity?: boolean;
    skipPlacement?: boolean;
    /** The place file: this host is an agent pod (A-25), the file naming a pod. */
    placeFile?: string;
    extra?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  if (opts.placeFile !== undefined) {
    fs.writeFileSync(path.join(home, ".nv-agent"), `${opts.placeFile}\n`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    ACPX_POD_SA_DIR: saDir(),
    ...(opts.skipPlacement === false ? {} : { ACPX_POD_TEST_SKIP_PLACEMENT: "1" }),
    ...opts.extra,
  };
  delete env.ACPX_STATE_HOME;
  for (const name of ["NV_POD_NAME", "NV_POD_UID", "NV_NODE_NAME"]) {
    delete env[name];
  }
  if (opts.identity !== false) {
    Object.assign(env, {
      NV_POD_NAME: "dev-server-abc",
      NV_POD_UID: "uid-1",
      NV_NODE_NAME: "node-a",
    });
  }
  return env;
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(argv: string[], env: NodeJS.ProcessEnv): Run {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The first stderr line that begins `acpx: REFUSED ` — the token an outcome reader looks for (A-53). */
function firstRefusedLine(stderr: string): string | undefined {
  return stderr.split("\n").find((line) => line.startsWith("acpx: REFUSED "));
}

/** The JSON error object of the last stdout line. */
function jsonError(stdout: string): {
  code?: number;
  message?: string;
  data?: { acpxCode?: string; detailCode?: string; origin?: string };
} {
  const last = stdout.trim().split("\n").at(-1) ?? "{}";
  return (JSON.parse(last) as { error?: object }).error ?? {};
}

/** Every file under the state home, but the session index (it is rebuilt by any read). */
function files(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (!entry.name.startsWith("index")) {
        out.push(path.relative(home, full));
      }
    }
  };
  walk(path.join(home, ".acpx"));
  return out.toSorted();
}

async function homeWithRecord(): Promise<string> {
  const home = makeHome();
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: RECORD_ID,
      acpSessionId: "c814c814-0000-4000-8000-000000000002",
      agentCommand: MOCK,
      cwd: home,
    }),
  );
  return home;
}

const SITES = [
  {
    what: "adapter",
    // a one-shot starts its adapter in the CLI process: `AcpClient.spawnAgentProcess`
    argv: (home: string, format: string) => [
      "--agent",
      MOCK,
      "--approve-all",
      "--cwd",
      home,
      "--format",
      format,
      "exec",
      "hello",
    ],
    home: () => Promise.resolve(makeHome()),
  },
  {
    what: "owner",
    // a prompt to an existing session with no owner starts one from the CLI process: `spawnQueueOwnerProcess`
    argv: (home: string, format: string) => [
      "--approve-all",
      "--cwd",
      home,
      "--format",
      format,
      "claude",
      "--session-id",
      RECORD_ID,
      "hello",
    ],
    home: homeWithRecord,
  },
] as const;

for (const site of SITES) {
  for (const format of ["text", "json"] as const) {
    test(`C7.2-B.1 (${site.what} site, ${format}): the spawn tripwire through the shipped CLI exits 2 with the token as the first REFUSED line, nothing started`, async () => {
      const home = await site.home();
      const token = `acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=${site.what}`;
      const before = files(home);
      const r = run(
        site.argv(home, format),
        // an automation-free wake: `interactive` is never gated by the broker, so the owner spawn is reached
        podEnv(home, { extra: { ACPX_ADMISSION_CLASS: "interactive" } }),
      );
      assert.equal(r.status, 2, `exit 2 (got ${r.status}); stderr: ${r.stderr.slice(-600)}`);
      assert.equal(
        firstRefusedLine(r.stderr),
        token,
        `the token is the first REFUSED line, with no prefix: ${r.stderr.slice(-600)}`,
      );
      assert.ok(
        r.stderr
          .split("\n")
          .filter((line) => line.includes("reason=bridge_on_control_pod"))
          .every((line) => line.startsWith("acpx: REFUSED ")),
        `no prefix before the token on any line: ${r.stderr.slice(-600)}`,
      );
      assert.deepEqual(
        files(home).filter((f) => f.startsWith(path.join(".acpx", "queues"))),
        [],
        "no owner lease or queue file: nothing was started",
      );
      assert.deepEqual(
        files(home).filter((f) => f.endsWith(".stream.ndjson") || f.endsWith(".lock")),
        before.filter((f) => f.endsWith(".stream.ndjson") || f.endsWith(".lock")),
        "no stream and no lock was written",
      );
      if (format === "json") {
        const error = jsonError(r.stdout);
        assert.equal(
          error.data?.acpxCode,
          "USAGE",
          "the existing exit-2 refusals' JSON class (as owner_outside_pod)",
        );
        assert.equal(error.data?.origin, "cli");
        assert.ok(
          error.message?.startsWith(token),
          `the refusal is the JSON error's message: ${r.stdout.slice(-600)}`,
        );
      }
    });
  }
}

test("C7.2-B.1 negative case: with pod mode OFF the same one-shot starts its adapter (the refusal is the tripwire's, not the command's)", () => {
  const home = makeHome();
  const env = podEnv(home, { extra: { ACPX_OWNER_PLACEMENT: undefined } });
  const r = run(SITES[0].argv(home, "text"), env);
  assert.equal(firstRefusedLine(r.stderr), undefined, r.stderr.slice(-600));
  assert.notEqual(r.status, 2, r.stderr.slice(-600));
});

test("the seam is what reaches the tripwire: without ACPX_POD_TEST_SKIP_PLACEMENT the placement step decides, and the one-shot never gets to a spawn site", () => {
  const home = makeHome();
  const r = run(SITES[0].argv(home, "text"), podEnv(home, { skipPlacement: false }));
  assert.doesNotMatch(r.stderr, /reason=bridge_on_control_pod/u, r.stderr.slice(-600));
  assert.match(firstRefusedLine(r.stderr) ?? r.stderr, /^acpx: (REFUSED|ROUTED) /u);
});

// ─── A-5 / A-25 / A-26: `pod_identity_missing` from a lock writer ────────────────────────────────────

// `acpx sessions new` takes the record lock (and the index lock) of the box's state home. A writer that cannot name
// its pod refuses and holds nothing (`PodIdentityMissingError`); at the top-level handler it must exit 2 like the
// placement step's own `pod_identity_missing` does — `capacity admit-wake` below is that other form, as the control.
const IDENTITY_TOKEN = "acpx: REFUSED reason=pod_identity_missing";
const HOSTS = [
  { host: "a control-role host in pod mode (the switch)", env: {} },
  {
    host: "an agent pod (the place file, A-25)",
    env: { placeFile: "ag-0123456789abcdef01234567" },
  },
] as const;

for (const { host, env } of HOSTS) {
  for (const format of ["text", "json"] as const) {
    test(`A-25 (${format}): a lock writer on ${host} that cannot name its pod exits 2 with the token as the first REFUSED line, and writes no lock`, () => {
      const home = makeHome();
      const r = run(
        ["--agent", MOCK, "--approve-all", "--cwd", home, "--format", format, "sessions", "new"],
        podEnv(home, { identity: false, ...env }),
      );
      assert.equal(r.status, 2, `exit 2 (got ${r.status}); stderr: ${r.stderr.slice(-800)}`);
      const line = firstRefusedLine(r.stderr);
      assert.ok(
        line?.startsWith(IDENTITY_TOKEN),
        `the token is the first REFUSED line, with no prefix: ${r.stderr.slice(-800)}`,
      );
      assert.deepEqual(
        files(home).filter((f) => f.endsWith(".lock")),
        [],
        "no lock file was written",
      );
      if (format === "json") {
        const error = jsonError(r.stdout);
        assert.equal(error.data?.acpxCode, "USAGE", r.stdout.slice(-600));
        assert.equal(error.data?.detailCode, "pod_identity_missing");
        assert.equal(error.data?.origin, "cli");
        assert.ok(error.message?.startsWith(IDENTITY_TOKEN), r.stdout.slice(-600));
      }
    });
  }
}

test("A-25 negative case: the same command with a COMPLETE identity is not refused as `pod_identity_missing`", () => {
  const home = makeHome();
  const r = run(
    ["--agent", MOCK, "--approve-all", "--cwd", home, "sessions", "new"],
    podEnv(home, { extra: { ACPX_ADMISSION_CLASS: "interactive" } }),
  );
  assert.doesNotMatch(r.stderr, /pod_identity_missing/u, r.stderr.slice(-800));
});

test("A-5 control: the placement step's own `pod_identity_missing` (no seam) exits 2 — the code the lock writer's form must match", () => {
  const home = makeHome();
  const r = run(
    ["--agent", MOCK, "--approve-all", "--cwd", home, "sessions", "new"],
    podEnv(home, { identity: false, skipPlacement: false }),
  );
  assert.equal(r.status, 2, r.stderr.slice(-600));
  assert.equal(firstRefusedLine(r.stderr), IDENTITY_TOKEN);
});
