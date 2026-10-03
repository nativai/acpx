import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

// C7 (brick 09197f03) rows 1 + 4 on the env surface: `ACPX_SEAT_FOLDER` is the NEW additive variable
// beside `ACPX_AGENT_FOLDER` (C3's dual-write rule), and — like every other piece of session identity —
// it joins the FW-07 delete block, so a seat-less child can never inherit its parent's seat folder.

/** Save/restore a process.env var around a block — the FW-07 pollution rig. */
function withEnvVars<T>(entries: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(entries)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

test("buildAgentSpawnOptions exports ACPX_SEAT_FOLDER beside ACPX_AGENT_FOLDER for a seated context", () => {
  withEnvVars({ ACPX_SEAT_FOLDER: undefined, ACPX_AGENT_FOLDER: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      seatId: "137b9523-2f75-4172-8e96-94d52eeea152",
      agentFolder: "/pool/b/agents/137b9523/holders/child-id",
      seatFolder: "/pool/b/agents/137b9523",
    });
    assert.equal(options.env.ACPX_AGENT_FOLDER, "/pool/b/agents/137b9523/holders/child-id");
    assert.equal(options.env.ACPX_SEAT_FOLDER, "/pool/b/agents/137b9523");
  });
});

test("buildAgentSpawnOptions trims ACPX_SEAT_FOLDER", () => {
  withEnvVars({ ACPX_SEAT_FOLDER: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      seatFolder: "   /pool/b/agents/137b9523  ",
    });
    assert.equal(options.env.ACPX_SEAT_FOLDER, "/pool/b/agents/137b9523");
  });
});

test("ACPX_SEAT_FOLDER does not depend on a resolvable UI base URL (unlike ACPX_SEAT_URL)", () => {
  withEnvVars({ ACPX_SEAT_FOLDER: undefined, ACPX_UI_BASE_URL: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      seatFolder: "/pool/b/agents/137b9523",
    });
    assert.equal(options.env.ACPX_SEAT_FOLDER, "/pool/b/agents/137b9523");
  });
});

test("a seat-less context DELETES a stale inherited ACPX_SEAT_FOLDER and ACPX_AGENT_FOLDER (FW-07)", () => {
  withEnvVars(
    {
      ACPX_SEAT_FOLDER: "/stale/parent/agents/aaaaaaaa",
      ACPX_AGENT_FOLDER: "/stale/parent/agents/aaaaaaaa/holders/bbbbbbbb",
    },
    () => {
      for (const seatFolder of [undefined, null, "", "   "]) {
        const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
          acpxRecordId: "child-id",
          seatFolder,
        });
        assert.equal(
          has(options.env, "ACPX_SEAT_FOLDER"),
          false,
          `seatFolder=${String(seatFolder)}`,
        );
        assert.equal(
          has(options.env, "ACPX_AGENT_FOLDER"),
          false,
          "a context with no agentFolder must not inherit the parent's agent folder either",
        );
      }
    },
  );
});

test("with no session context at all, neither folder variable survives from the parent env", () => {
  withEnvVars({ ACPX_SEAT_FOLDER: "/stale/seat", ACPX_AGENT_FOLDER: "/stale/agent" }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
    assert.equal(has(options.env, "ACPX_SEAT_FOLDER"), false);
    assert.equal(has(options.env, "ACPX_AGENT_FOLDER"), false);
  });
});
