// P3a §4 at the CLIENT, with a real (mock) adapter spawn: the C11 refusal (G1), the codex carry (G2) and the
// harness-aware fallback notice (N4). Spec: /wisdom/Bricks/f87fa15b-…/conception/IMPLEMENTATION-SPEC.md §4.2,
// §4.3, §4.5. Shaped on the P3a TE's probe (verification-evidence/c11.mjs).

import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OsPrimerRequiredError, takeAtriumOsNotice } from "../src/acp/atrium-os.js";
import type { AgentSessionContext } from "../src/acp/auth-env.js";
import { AcpClient } from "../src/acp/client.js";
import { resetSessionPrimerMemoForTests } from "../src/acp/session-primer.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

/**
 * A primer script that counts its renders and fails / succeeds per the mode FILE, one decision per render.
 * A file, not an env var: the render runs in the SPAWN env captured at `start()`, so a mode a test changes
 * later in `process.env` would never reach it.
 */
const PRIMER_SCRIPT = `#!/bin/sh
n=$(cat "$P3A_PRIMER_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$P3A_PRIMER_COUNT"
case "$(cat "$P3A_PRIMER_MODE_FILE")" in
  ok) echo "PRIMER OK";;
  fail) echo "boom" >&2; exit 3;;
  fail-then-ok) [ "$n" -ge 2 ] && echo "PRIMER OK" || { echo "boom" >&2; exit 3; };;
esac
`;

type Rig = { dir: string; ops: string; count: string; modeFile: string };

async function withRig(
  mode: "ok" | "fail" | "fail-then-ok",
  run: (rig: Rig) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-atrium-os-client-"));
  const primer = path.join(dir, "primer.sh");
  fs.writeFileSync(primer, PRIMER_SCRIPT, { mode: 0o755 });
  const rig = {
    dir,
    ops: path.join(dir, "ops.jsonl"),
    count: path.join(dir, "count"),
    modeFile: path.join(dir, "mode"),
  };
  fs.writeFileSync(rig.modeFile, mode);
  // The spawn env starts from process.env, so the primer knobs reach the render through it.
  const saved = new Map<string, string | undefined>();
  const set = {
    ACPX_SESSION_PRIMER_COMMAND: primer,
    P3A_PRIMER_MODE_FILE: rig.modeFile,
    P3A_PRIMER_COUNT: rig.count,
    ATRIUM_OS: undefined,
    ATRIUM_OS_DEFAULT: undefined,
  };
  for (const [key, value] of Object.entries(set)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetSessionPrimerMemoForTests();
  try {
    await run(rig);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetSessionPrimerMemoForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function client(
  rig: Rig,
  harness: "--claude-agent-acp" | "--codex-acp",
  sessionContext: AgentSessionContext,
  requireOsPrimer?: boolean,
): AcpClient {
  return new AcpClient({
    agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} ${harness} --operation-log ${JSON.stringify(rig.ops)}`,
    cwd: rig.dir,
    permissionMode: "approve-reads",
    sessionContext,
    ...(requireOsPrimer === undefined ? {} : { requireOsPrimer }),
  });
}

function renders(rig: Rig): number {
  return fs.existsSync(rig.count) ? Number(fs.readFileSync(rig.count, "utf8").trim()) : 0;
}

function sessionNewsAtAgent(rig: Rig): number {
  if (!fs.existsSync(rig.ops)) {
    return 0;
  }
  return fs
    .readFileSync(rig.ops, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => (JSON.parse(line) as { method?: string }).method === "session/new").length;
}

async function withClient(c: AcpClient, run: (c: AcpClient) => Promise<void>): Promise<void> {
  try {
    await c.start();
    await run(c);
  } finally {
    await c.close().catch(() => {});
  }
}

// ── G1: the C11 refusal ───────────────────────────────────────────────────────────────────────────

test("G1 requireOsPrimer + a failing primer → refused BEFORE session/new, after exactly one retry", async () => {
  await withRig("fail", async (rig) => {
    const c = client(
      rig,
      "--claude-agent-acp",
      { seatNameGeneric: false, acpxRecordId: "rec-g1-a" },
      true,
    );
    await withClient(c, async () => {
      await assert.rejects(c.createSession(rig.dir), (error: unknown) => {
        assert.ok(error instanceof OsPrimerRequiredError, String(error));
        assert.match(
          error.message,
          /refusing to create the session: its Operating System primer did not render/,
        );
        return true;
      });
    });
    assert.equal(renders(rig), 2, "the render is retried exactly once");
    assert.equal(sessionNewsAtAgent(rig), 0, "nothing reached the agent");
    assert.equal(
      c.getAgentLifecycleSnapshot().os?.primerError,
      undefined,
      "a refusal stamps no alarm",
    );
  });
});

test("G1 the retry rescues the create: first render fails, the retry renders → created, no alarm", async () => {
  await withRig("fail-then-ok", async (rig) => {
    const c = client(
      rig,
      "--claude-agent-acp",
      { seatNameGeneric: false, acpxRecordId: "rec-g1-b" },
      true,
    );
    await withClient(c, async () => {
      await c.createSession(rig.dir);
    });
    assert.equal(renders(rig), 2);
    assert.equal(sessionNewsAtAgent(rig), 1);
    assert.equal(c.getAgentLifecycleSnapshot().os?.primerError, null);
  });
});

test("G1 negative: the directory case (requireOsPrimer false) and a respawn client (option absent) only ALARM", async () => {
  for (const requireOsPrimer of [false, undefined]) {
    await withRig("fail", async (rig) => {
      const c = client(
        rig,
        "--claude-agent-acp",
        { seatNameGeneric: false, acpxRecordId: "rec-g1-c" },
        requireOsPrimer,
      );
      await withClient(c, async () => {
        await c.createSession(rig.dir);
      });
      assert.equal(
        renders(rig),
        1,
        `requireOsPrimer=${String(requireOsPrimer)}: no retry without refusal`,
      );
      assert.equal(sessionNewsAtAgent(rig), 1, "the session was created");
      assert.match(
        c.getAgentLifecycleSnapshot().os?.primerError ?? "",
        /^\d{4}-\d{2}-\d{2}T\S+ exited with code 3/,
      );
    });
  }
});

test("G1 negative: only the client's FIRST creating render can refuse — a later session/new only alarms", async () => {
  await withRig("ok", async (rig) => {
    const c = client(
      rig,
      "--claude-agent-acp",
      { seatNameGeneric: false, acpxRecordId: "rec-g1-d" },
      true,
    );
    await withClient(c, async () => {
      await c.createSession(rig.dir);
      // The later fresh session/new (a reconnect's fallback) renders again and fails.
      fs.writeFileSync(rig.modeFile, "fail");
      resetSessionPrimerMemoForTests();
      await c.createSession(rig.dir);
    });
    assert.equal(sessionNewsAtAgent(rig), 2, "both creates reached the agent");
    assert.equal(renders(rig), 2, "the second render was not retried: no refusal applied");
    assert.ok(c.getAgentLifecycleSnapshot().os?.primerError, "the later failure raised the alarm");
  });
});

// ── G2: the codex carry ───────────────────────────────────────────────────────────────────────────

const STORED = "2026-11-14T21:01:27.410Z exec error: spawn /nonexistent/primer.sh ENOENT";

test("G2 a stored primer failure re-arms the notice at a spawn that renders no primer (codex)", async () => {
  await withRig("ok", async (rig) => {
    const c = client(rig, "--codex-acp", {
      seatNameGeneric: false,
      acpxRecordId: "rec-g2-a",
      osPrimerError: STORED,
    });
    await withClient(c, async () => {
      // start() spawned the adapter; codex renders nothing until a session/new, which a resume never sends.
      const notice = takeAtriumOsNotice("rec-g2-a") ?? "";
      assert.match(notice, /⟦OS-NOTICE⟧ Your Operating System primer did not load/);
      assert.match(
        notice,
        /spawn \/nonexistent\/primer\.sh ENOENT/,
        "the STORED reason, not the timestamp",
      );
      assert.doesNotMatch(notice, /2026-11-14T21:01:27/);
    });
    assert.equal(renders(rig), 0, "positive control: this spawn rendered no primer");
    assert.equal(
      c.getAgentLifecycleSnapshot().os?.primerError,
      undefined,
      "undefined leaves the stored key",
    );
  });
});

test("G2 negative: no stored failure → no notice", async () => {
  await withRig("ok", async (rig) => {
    const c = client(rig, "--codex-acp", { seatNameGeneric: false, acpxRecordId: "rec-g2-b" });
    await withClient(c, async () => {
      assert.equal(takeAtriumOsNotice("rec-g2-b"), undefined);
    });
  });
});

test("G2 a render in the same spawn CLEARS the carried notice (success) or REPLACES it (failure)", async () => {
  await withRig("ok", async (rig) => {
    const c = client(rig, "--codex-acp", {
      seatNameGeneric: false,
      acpxRecordId: "rec-g2-c",
      osPrimerError: STORED,
    });
    await withClient(c, async () => {
      await c.createSession(rig.dir);
      assert.equal(takeAtriumOsNotice("rec-g2-c"), undefined, "a good render clears the carry");
    });
    assert.equal(c.getAgentLifecycleSnapshot().os?.primerError, null, "…and clears the record key");
  });
  await withRig("fail", async (rig) => {
    const c = client(rig, "--codex-acp", {
      seatNameGeneric: false,
      acpxRecordId: "rec-g2-d",
      osPrimerError: STORED,
    });
    await withClient(c, async () => {
      await c.createSession(rig.dir);
      const notice = takeAtriumOsNotice("rec-g2-d") ?? "";
      assert.match(notice, /exited with code 3/, "the fresh failure's reason");
      assert.doesNotMatch(notice, /ENOENT/, "not the stale one");
    });
  });
});

// ── N4: the fallback notice is harness-aware ──────────────────────────────────────────────────────

test("N4 the fallback notice: claude's primer follows the default root; codex's creation primer is unchanged", async () => {
  const missing = path.join("/workspace/projects/temp", "acpx-p3a-gone-os-root");
  for (const [harness, recordId, expected, absent] of [
    ["--claude-agent-acp", "rec-n4-claude", /its commands and primer, not/, /primer you received/],
    [
      "--codex-acp",
      "rec-n4-codex",
      /the primer you received when this session was created is unchanged/,
      /commands and primer/,
    ],
  ] as const) {
    await withRig("ok", async (rig) => {
      const c = client(rig, harness, {
        seatNameGeneric: false,
        acpxRecordId: recordId,
        osChoice: missing,
      });
      await withClient(c, async () => {
        const notice = takeAtriumOsNotice(recordId) ?? "";
        assert.match(
          notice,
          /⟦OS-NOTICE⟧ This session's Operating System .* was not found/,
          harness,
        );
        assert.match(notice, expected, harness);
        assert.doesNotMatch(notice, absent, harness);
      });
      assert.match(c.getAgentLifecycleSnapshot().os?.fallbackAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    });
  }
});
