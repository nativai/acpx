import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable } from "../src/acp/agent-command.js";
import { resolveAcpxUiBaseUrl } from "../src/acp/auth-env.js";
import { resolveAgentSessionCwd } from "../src/acp/client-process.js";
import { buildAgentSpawnOptions, buildSpawnCommandOptions } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { buildQueueOwnerSpawnOptions } from "../src/cli/session/queue-owner-process.js";
import {
  markSubscriptionDead,
  resetKnownDeadSubs,
} from "../src/config/known-dead-subscriptions.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import {
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
} from "../src/spawn-command-options.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

test("buildAgentSpawnOptions hides Windows console windows and preserves auth env", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
    ACPX_AUTH_TOKEN: "secret-token",
  });

  assert.equal(options.cwd, "/tmp/acpx-agent");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_AUTH_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions never injects ACPX_SESSION_ID (URL-only identity contract)", () => {
  const previous = process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  try {
    // The base URL is a CONTROLLED INPUT here (rung 1 of the resolver ladder) —
    // the emit side deliberately hardcodes no host (resolveAcpxUiBaseUrl reads
    // $ACPX_UI_BASE_URL, then /proc/1/environ, then the hostmap cache), so the
    // exact URL below pins the composition without depending on this rig's own
    // resolution.
    withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "11111111-2222-3333-4444-555555555555",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
      assert.equal(
        options.env.ACPX_SESSION_URL,
        "https://atrium.devbox.nativai.de/?session=11111111-2222-3333-4444-555555555555",
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previous;
    }
  }
});

// brick c2df657e — the sticky-routing key handoff. The seeded pi extension reads
// ACPX_SESSION_RECORD_ID per request; the record id (not the per-spawn ACP
// session id) is the only key that survives a session resume, so it is what the
// env carries.
test("adapter env carries the acpx RECORD id for the pi sticky-routing seam", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(options.env.ACPX_SESSION_RECORD_ID, "11111111-2222-3333-4444-555555555555");
});

test("adapter env: the sticky-routing key rides even where no base URL resolves", () => {
  // The record id is handed over UNCONDITIONALLY (unlike ACPX_SESSION_URL, which
  // is gated on a resolvable UI base URL): the id alone is enough to pin the
  // provider cache, and a box where the resolver ladder misses everything must
  // not silently lose cache affinity too. The ladder's lower rungs read
  // /proc/1/environ, so whether the URL answers here is box-dependent — asserted
  // hermetically as the pairing rule instead.
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(options.env.ACPX_SESSION_RECORD_ID, "11111111-2222-3333-4444-555555555555");
    const urlId = options.env.ACPX_SESSION_URL?.split("session=")[1];
    if (urlId !== undefined) {
      assert.equal(
        urlId,
        options.env.ACPX_SESSION_RECORD_ID,
        "URL and sticky key must name the SAME record id when both are handed over",
      );
    }
  });
});

test("adapter env: a STALE ACPX_SESSION_RECORD_ID never leaks into a spawn with no context", () => {
  // The FW-07 hazard, brick-shaped: a long-lived queue-owner that served session A
  // spawns for session B — a leftover record id would pin A's provider-cache key
  // onto B's requests. Scrubbed before set, like every session-identity variable.
  const previous = process.env.ACPX_SESSION_RECORD_ID;
  process.env.ACPX_SESSION_RECORD_ID = "stale-record-id";
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_RECORD_ID"),
      false,
      "no sessionContext ⇒ no key, not an inherited one",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_RECORD_ID;
    } else {
      process.env.ACPX_SESSION_RECORD_ID = previous;
    }
  }
});

test("buildAgentSpawnOptions never injects ACPX_PARENT_SESSION_ID (URL-only identity contract)", () => {
  const previous = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        parentSessionId: "parent-id-abc",
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
        false,
      );
      assert.equal(
        options.env.ACPX_PARENT_SESSION_URL,
        "https://atrium.devbox.nativai.de/?session=parent-id-abc",
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previous;
    }
  }
});

test("buildAgentSpawnOptions trims whitespace around parentSessionId into ACPX_PARENT_SESSION_URL", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "  parent-id-xyz  ",
    });
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://atrium.devbox.nativai.de/?session=parent-id-xyz",
    );
  });
});

function withAcpxUiBaseUrlEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.ACPX_UI_BASE_URL;
  if (value === undefined) {
    delete process.env.ACPX_UI_BASE_URL;
  } else {
    process.env.ACPX_UI_BASE_URL = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = previous;
    }
  }
}

/**
 * The URL the production resolver ladder yields for THIS rig under the currently
 * controlled env, composed exactly the way buildAgentSpawnOptions composes it.
 *
 * The emit side deliberately hardcodes NO host — resolveAcpxUiBaseUrl reads
 * $ACPX_UI_BASE_URL (rung 1), then /proc/1/environ (rung 2), then acpx-ui's
 * hostmap cache (rung 3), and returns UNDEFINED when every rung misses (which is
 * an answer, not a failure: the caller must omit the URL rather than invent a
 * host). So a test that leaves rung 1 unset cannot assert a host LITERAL — it
 * asserts against the same resolver the code uses, pinning the exact
 * composition (`<base>/?session=<trimmed id>`) on any rig. Returns undefined
 * when nothing resolves; callers then assert the URL var is ABSENT.
 */
function expectedSessionUrl(sessionId: string): string | undefined {
  const base = resolveAcpxUiBaseUrl(process.env);
  return base === undefined ? undefined : `${base}/?session=${sessionId}`;
}

test("buildAgentSpawnOptions composes ACPX_SESSION_URL from the box's resolved base URL when acpxRecordId is set", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "11111111-2222-3333-4444-555555555555",
    });
    // With rung 1 unset, the emit side falls through to the box ladder (rung 2
    // /proc/1/environ, rung 3 hostmap cache) — it hardcodes NO host, and when no
    // rung resolves it must OMIT the URL rather than invent one.
    const expected = expectedSessionUrl("11111111-2222-3333-4444-555555555555");
    if (expected === undefined) {
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_URL"), false);
    } else {
      assert.equal(options.env.ACPX_SESSION_URL, expected);
    }
  });
});

test("buildAgentSpawnOptions omits ACPX_SESSION_URL when acpxRecordId is empty/whitespace", () => {
  const previousUrl = process.env.ACPX_SESSION_URL;
  delete process.env.ACPX_SESSION_URL;
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "   ",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_URL"), false);
  } finally {
    if (previousUrl === undefined) {
      delete process.env.ACPX_SESSION_URL;
    } else {
      process.env.ACPX_SESSION_URL = previousUrl;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_PARENT_SESSION_URL when parentSessionId is non-empty", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id-abc",
    });
    const expected = expectedSessionUrl("parent-id-abc");
    if (expected === undefined) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_URL"),
        false,
      );
    } else {
      assert.equal(options.env.ACPX_PARENT_SESSION_URL, expected);
    }
  });
});

test("buildAgentSpawnOptions omits ACPX_PARENT_SESSION_URL when parentSessionId is null/undefined/whitespace", () => {
  const previousParentUrl = process.env.ACPX_PARENT_SESSION_URL;
  delete process.env.ACPX_PARENT_SESSION_URL;
  try {
    const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: null,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_PARENT_SESSION_URL"),
      false,
    );

    const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_PARENT_SESSION_URL"),
      false,
    );

    const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_PARENT_SESSION_URL"),
      false,
    );
  } finally {
    if (previousParentUrl === undefined) {
      delete process.env.ACPX_PARENT_SESSION_URL;
    } else {
      process.env.ACPX_PARENT_SESSION_URL = previousParentUrl;
    }
  }
});

test("buildAgentSpawnOptions honors ACPX_UI_BASE_URL override for both URL vars", () => {
  withAcpxUiBaseUrlEnv("http://localhost:3456", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "http://localhost:3456/?session=child-id");
    assert.equal(options.env.ACPX_PARENT_SESSION_URL, "http://localhost:3456/?session=parent-id");
  });
});

test("buildAgentSpawnOptions normalizes a trailing slash on ACPX_UI_BASE_URL", () => {
  withAcpxUiBaseUrlEnv("https://x.example.com/", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "https://x.example.com/?session=child-id");
  });
});

test("buildAgentSpawnOptions falls through to the box ladder when ACPX_UI_BASE_URL is empty/whitespace", () => {
  // The unset-env answer is what blank values must fall through to. It is NOT a
  // host literal — the resolver ladder decides it per rig — so it is computed
  // from the same resolver the emit side uses (undefined when nothing resolves).
  const unsetUrl = withAcpxUiBaseUrlEnv(
    undefined,
    () =>
      buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
      }).env.ACPX_SESSION_URL,
  );

  for (const blank of ["   ", ""]) {
    withAcpxUiBaseUrlEnv(blank, () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
      });
      if (unsetUrl === undefined) {
        assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_URL"), false);
      } else {
        assert.equal(options.env.ACPX_SESSION_URL, unsetUrl);
      }
    });
  }
});

test("buildAgentSpawnOptions reflects trimmed UUIDs in URL vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "  child-id  ",
      parentSessionId: "  parent-id-xyz  ",
    });
    assert.equal(options.env.ACPX_SESSION_URL, expectedSessionUrl("child-id"));
    assert.equal(options.env.ACPX_PARENT_SESSION_URL, expectedSessionUrl("parent-id-xyz"));
  });
});

test("buildAgentSpawnOptions: URL is the only identity surface — no _ID vars emitted", () => {
  const previousSessionId = process.env.ACPX_SESSION_ID;
  const previousParentId = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    withAcpxUiBaseUrlEnv(undefined, () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        parentSessionId: "parent-id",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
        false,
      );
      assert.equal(options.env.ACPX_SESSION_URL, expectedSessionUrl("child-id"));
      assert.equal(options.env.ACPX_PARENT_SESSION_URL, expectedSessionUrl("parent-id"));
    });
  } finally {
    if (previousSessionId === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previousSessionId;
    }
    if (previousParentId === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previousParentId;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_TASK_FOLDER when sessionContext.taskFolder is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    taskFolder: "/abs/path/to/task",
  });
  assert.equal(options.env.ACPX_TASK_FOLDER, "/abs/path/to/task");
});

test("buildAgentSpawnOptions injects ACPX_SESSION_NAME when sessionContext.sessionName is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    sessionName: " self-status ",
  });
  assert.equal(options.env.ACPX_SESSION_NAME, "self-status");
});

test("buildAgentSpawnOptions omits ACPX_SESSION_NAME for unnamed sessions and clears inherited stale names", () => {
  const previous = process.env.ACPX_SESSION_NAME;
  process.env.ACPX_SESSION_NAME = "stale-parent-name";
  try {
    const unnamed = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(unnamed.env, "ACPX_SESSION_NAME"), false);

    const nullName = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      sessionName: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(nullName.env, "ACPX_SESSION_NAME"), false);

    const whitespaceName = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      sessionName: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceName.env, "ACPX_SESSION_NAME"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_NAME;
    } else {
      process.env.ACPX_SESSION_NAME = previous;
    }
  }
});

test("buildAgentSpawnOptions trims whitespace around taskFolder before injecting ACPX_TASK_FOLDER", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    taskFolder: "   /abs/path  ",
  });
  assert.equal(options.env.ACPX_TASK_FOLDER, "/abs/path");
});

test("buildAgentSpawnOptions omits ACPX_TASK_FOLDER when taskFolder is null/undefined/empty/whitespace", () => {
  const previous = process.env.ACPX_TASK_FOLDER;
  delete process.env.ACPX_TASK_FOLDER;
  try {
    const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_TASK_FOLDER"),
      false,
    );

    const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_TASK_FOLDER"), false);

    const emptyCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: "",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(emptyCase.env, "ACPX_TASK_FOLDER"), false);

    const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_TASK_FOLDER"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_TASK_FOLDER;
    } else {
      process.env.ACPX_TASK_FOLDER = previous;
    }
  }
});

test("buildAgentSpawnOptions clears stale ACPX_TASK_FOLDER when this session has none", () => {
  const previous = process.env.ACPX_TASK_FOLDER;
  process.env.ACPX_TASK_FOLDER = "/stale/task";
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_TASK_FOLDER"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_TASK_FOLDER;
    } else {
      process.env.ACPX_TASK_FOLDER = previous;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_BRICK and ACPX_BRICK_PATH when present", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    brick: "11111111-2222-3333-4444-555555555555",
    brickPath: "/wisdom/Operating System/Bricks/11111111-2222-3333-4444-555555555555",
  });
  assert.equal(options.env.ACPX_BRICK, "11111111-2222-3333-4444-555555555555");
  assert.equal(
    options.env.ACPX_BRICK_PATH,
    "/wisdom/Operating System/Bricks/11111111-2222-3333-4444-555555555555",
  );
});

test("buildAgentSpawnOptions trims brick env vars and omits path without a brick id", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    brick: "  11111111-2222-3333-4444-555555555555  ",
    brickPath: "  /brick/path  ",
  });
  assert.equal(options.env.ACPX_BRICK, "11111111-2222-3333-4444-555555555555");
  assert.equal(options.env.ACPX_BRICK_PATH, "/brick/path");

  const noBrick = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    brickPath: "/brick/path",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(noBrick.env, "ACPX_BRICK"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(noBrick.env, "ACPX_BRICK_PATH"), false);
});

test("buildAgentSpawnOptions clears stale ACPX_BRICK vars and owner-log marker", () => {
  const previousBrick = process.env.ACPX_BRICK;
  const previousBrickPath = process.env.ACPX_BRICK_PATH;
  const previousOwnerLog = process.env.ACPX_OWNER_LOG;
  process.env.ACPX_BRICK = "stale";
  process.env.ACPX_BRICK_PATH = "/stale";
  process.env.ACPX_OWNER_LOG = "1";
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_BRICK"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_BRICK_PATH"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_OWNER_LOG"), false);
  } finally {
    if (previousBrick === undefined) {
      delete process.env.ACPX_BRICK;
    } else {
      process.env.ACPX_BRICK = previousBrick;
    }
    if (previousBrickPath === undefined) {
      delete process.env.ACPX_BRICK_PATH;
    } else {
      process.env.ACPX_BRICK_PATH = previousBrickPath;
    }
    if (previousOwnerLog === undefined) {
      delete process.env.ACPX_OWNER_LOG;
    } else {
      process.env.ACPX_OWNER_LOG = previousOwnerLog;
    }
  }
});

test("buildAgentSpawnOptions: ACPX_TASK_FOLDER coexists with URL session + parent vars (no _ID vars)", () => {
  const previousSessionId = process.env.ACPX_SESSION_ID;
  const previousParentId = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    withAcpxUiBaseUrlEnv(undefined, () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        parentSessionId: "parent-id",
        taskFolder: "/task/abs",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
        false,
      );
      assert.equal(options.env.ACPX_SESSION_URL, expectedSessionUrl("child-id"));
      assert.equal(options.env.ACPX_PARENT_SESSION_URL, expectedSessionUrl("parent-id"));
      assert.equal(options.env.ACPX_TASK_FOLDER, "/task/abs");
    });
  } finally {
    if (previousSessionId === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previousSessionId;
    }
    if (previousParentId === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previousParentId;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_AGENT_FOLDER when sessionContext.agentFolder is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    agentFolder: "/abs/task/agents/child-12345678",
  });
  assert.equal(options.env.ACPX_AGENT_FOLDER, "/abs/task/agents/child-12345678");
});

test("buildAgentSpawnOptions trims whitespace around agentFolder before injecting ACPX_AGENT_FOLDER", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    agentFolder: "   /abs/task/agents/child  ",
  });
  assert.equal(options.env.ACPX_AGENT_FOLDER, "/abs/task/agents/child");
});

test("buildAgentSpawnOptions omits ACPX_AGENT_FOLDER when agentFolder is null/undefined/empty/whitespace", () => {
  const previous = process.env.ACPX_AGENT_FOLDER;
  delete process.env.ACPX_AGENT_FOLDER;
  try {
    const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_AGENT_FOLDER"),
      false,
    );

    const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_AGENT_FOLDER"), false);

    const emptyCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: "",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(emptyCase.env, "ACPX_AGENT_FOLDER"), false);

    const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_AGENT_FOLDER"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_AGENT_FOLDER;
    } else {
      process.env.ACPX_AGENT_FOLDER = previous;
    }
  }
});

test("buildAgentSpawnOptions: ACPX_AGENT_FOLDER coexists with task folder + URL session vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
      taskFolder: "/task/abs",
      agentFolder: "/task/abs/agents/child-id",
    });
    assert.equal(options.env.ACPX_TASK_FOLDER, "/task/abs");
    assert.equal(options.env.ACPX_AGENT_FOLDER, "/task/abs/agents/child-id");
    assert.equal(options.env.ACPX_SESSION_URL, expectedSessionUrl("child-id"));
  });
});

test("buildAgentSpawnOptions promotes explicit ACPX auth env vars into agent auth env", () => {
  const previousPrefixed = process.env.ACPX_AUTH_OPENAI_API_KEY;
  const previousNormalized = process.env.OPENAI_API_KEY;

  process.env.ACPX_AUTH_OPENAI_API_KEY = "sk-explicit";
  delete process.env.OPENAI_API_KEY;

  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined);
    assert.equal(options.env.ACPX_AUTH_OPENAI_API_KEY, "sk-explicit");
    assert.equal(options.env.OPENAI_API_KEY, "sk-explicit");
  } finally {
    if (previousPrefixed == null) {
      delete process.env.ACPX_AUTH_OPENAI_API_KEY;
    } else {
      process.env.ACPX_AUTH_OPENAI_API_KEY = previousPrefixed;
    }

    if (previousNormalized == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousNormalized;
    }
  }
});

// ============================================================================
// brick://cb214e48 — the FW-07 scrub, extended to pi's DATA dir.
//
// pi exports its whole environment into every tool subprocess, and
// `buildAgentEnvironment` starts from `{...process.env}` — so a pi session that
// spawns `acpx pi …` handed its child the PARENT's re-pointed
// PI_CODING_AGENT_DIR, which acpx then read as "the box". Same class as the
// CLAUDE_CONFIG_DIR (brick://1820be37) and OPENROUTER-key (brick://c788eca0)
// inheritances already on this list.
// ============================================================================

/** Run `body` with `process.env[name]` forced to `value`, restored afterwards. */
function withProcessEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("cb214e48: an inherited acpx-pi-* PI_CODING_AGENT_DIR does not reach the child spawn env", () => {
  withProcessEnv("PI_CODING_AGENT_DIR", "/tmp/acpx-pi-01a08744-8e1f-74ab-93a1-368e09e68a13", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(options.env, "PI_CODING_AGENT_DIR"),
      false,
      "the parent's throwaway agent dir reached the child spawn",
    );
  });
});

test("cb214e48: a BOX-level PI_CODING_AGENT_DIR DOES reach it", () => {
  // THE CONTROL that stops the scrub becoming unconditional. A box that
  // legitimately relocates pi's agent dir must keep working — without this row,
  // `delete env.PI_CODING_AGENT_DIR` on every spawn passes the row above.
  withProcessEnv("PI_CODING_AGENT_DIR", "/opt/pi-box/agent", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(options.env.PI_CODING_AGENT_DIR, "/opt/pi-box/agent");
  });
});

test("cb214e48: PI_CODING_AGENT_SESSION_DIR never survives the copy — for ANY harness", () => {
  // Unconditional: `writePiConfigDir` is its only writer and its value is
  // inherently cwd-specific, so an inherited one can only ever be another
  // session's. pi re-sets its own afterwards; claude / claude-pty / codex carry it
  // today for no reason at all.
  withProcessEnv(
    "PI_CODING_AGENT_SESSION_DIR",
    "/tmp/acpx-pi-parent/sessions/--workspace-other--",
    () => {
      for (const agentCommand of [undefined, AGENT_REGISTRY.pi, AGENT_REGISTRY.claude]) {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "child-id" },
          undefined,
          agentCommand,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(options.env, "PI_CODING_AGENT_SESSION_DIR"),
          false,
          `${agentCommand ?? "<no command>"} inherited PI_CODING_AGENT_SESSION_DIR`,
        );
      }
    },
  );
});

// ============================================================================
// brick://27894f40 — the same scrub, extended to pi's five DESCRIPTIVE session
// variables. cb214e48 deferred these because they are not OPERATIVE: pi drops
// and re-derives all five for every tool subprocess, so an inherited value can
// never steer a child pi. What it CAN do is mis-attribute one: measured on
// devbox 2026-09-09, the pi-acp adapter of the child session `w8-depth-gate`
// reported the PARENT's PI_SESSION_ID and PI_SESSION_FILE, sending anyone
// reading /proc to the wrong transcript.
// ============================================================================

/** The five pi publishes about its own session — never legitimate as an inherited value. */
const PI_DESCRIPTIVE_ENV_NAMES = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
] as const;

/** Run `body` with every `[name, value]` forced into `process.env`, restored afterwards. */
function withProcessEnvAll(entries: Array<[string, string]>, body: () => void): void {
  const previous = entries.map(([name]) => [name, process.env[name]] as const);
  for (const [name, value] of entries) {
    process.env[name] = value;
  }
  try {
    body();
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

/** The parent values measured in the rig (real pi parent 01a08a63-9a74, 2026-09-10). */
const PARENT_PI_ENV: Array<[string, string]> = [
  ["PI_SESSION_ID", "01a08a63-9a74-7fd1-a7ab-f41ae9528591"],
  [
    "PI_SESSION_FILE",
    "/home/node/.pi/agent/sessions/--tmp--/2026-09-10T08-16-18-548Z_01a08a63-9a74-7fd1-a7ab-f41ae9528591.jsonl",
  ],
  ["PI_MODEL", "moonshotai/kimi-k2.6"],
  ["PI_PROVIDER", "openrouter"],
  ["PI_REASONING_LEVEL", "medium"],
];

test("27894f40: none of pi's five descriptive session vars survives the copy — for ANY harness", () => {
  // Unconditional and harness-independent, unlike PI_CODING_AGENT_DIR above:
  // these five are per-session OUTPUTS of a running pi, so there is no
  // box-level value to preserve and an inherited one is always another
  // session's. A claude or codex child of a pi parent carries them today too.
  withProcessEnvAll(PARENT_PI_ENV, () => {
    for (const agentCommand of [
      undefined,
      AGENT_REGISTRY.pi,
      AGENT_REGISTRY.claude,
      AGENT_REGISTRY.codex,
    ]) {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "child-id" },
        undefined,
        agentCommand,
      );
      for (const name of PI_DESCRIPTIVE_ENV_NAMES) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(options.env, name),
          false,
          `${agentCommand ?? "<no command>"} inherited ${name} — the child adapter would report the parent's pi session`,
        );
      }
    }
  });
});

test("27894f40: the scrub is scoped to those five — an unrelated PI_* var is untouched", () => {
  // THE CONTROL that stops the scrub becoming a `PI_`-prefix sweep. Without it,
  // deleting every key starting with `PI_` passes the row above — and would take
  // PI_CODING_AGENT_DIR's legitimate box-level value (asserted separately above)
  // and PI_CODING_AGENT with it. Measured in the rig on the fixed build:
  // PI_UNRELATED_CONTROL=keep-me and PI_CODING_AGENT=true both reached the child
  // adapter while all five were gone.
  withProcessEnvAll(
    [...PARENT_PI_ENV, ["PI_UNRELATED_CONTROL", "keep-me"], ["PI_CODING_AGENT", "true"]],
    () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
      });
      assert.equal(options.env.PI_UNRELATED_CONTROL, "keep-me");
      assert.equal(options.env.PI_CODING_AGENT, "true");
    },
  );
});

test("buildTerminalSpawnOptions hides Windows console windows and maps env entries", () => {
  const options = buildTerminalSpawnOptions("node", "/tmp/acpx-terminal", [
    { name: "TMUX", value: "/tmp/tmux-1000/default,123,0" },
    { name: "TERM", value: "screen-256color" },
  ]);

  assert.equal(options.cwd, "/tmp/acpx-terminal");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env?.TMUX, "/tmp/tmux-1000/default,123,0");
  assert.equal(options.env?.TERM, "screen-256color");
});

test("buildQueueOwnerSpawnOptions hides Windows console windows and passes payload", () => {
  const options = buildQueueOwnerSpawnOptions('{"sessionId":"queue-session"}');

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_QUEUE_OWNER_PAYLOAD, '{"sessionId":"queue-session"}');
});

test("buildSpawnCommandOptions enables shell for .cmd/.bat on Windows", () => {
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  const cmdOptions = buildSpawnCommandOptions("C:\\Program Files\\nodejs\\npx.cmd", base, "win32");
  const batOptions = buildSpawnCommandOptions("C:\\tools\\agent.bat", base, "win32");

  assert.equal(cmdOptions.shell, true);
  assert.equal(batOptions.shell, true);
  assert.deepEqual(cmdOptions.stdio, base.stdio);
  assert.equal(cmdOptions.windowsHide, true);
});

test("buildSpawnCommandOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildSpawnCommandOptions("npx", base, "win32", env);
    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, base.stdio);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSpawnCommandOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const linuxOptions = buildSpawnCommandOptions("/usr/bin/npx", base, "linux");
    const windowsExeOptions = buildSpawnCommandOptions("node", base, "win32", env);

    assert.equal(linuxOptions.shell, undefined);
    assert.equal(windowsExeOptions.shell, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnCommand preserves explicit argv", () => {
  assert.deepEqual(buildTerminalSpawnCommand("node", ["-e", "console.log('ok')"]), {
    command: "node",
    args: ["-e", "console.log('ok')"],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", []), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", undefined), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
});

test("buildTerminalShellSpawnCommand routes command lines through the shell", () => {
  assert.deepEqual(buildTerminalShellSpawnCommand("echo hello | tr a-z A-Z", "darwin"), {
    command: "/bin/sh",
    args: ["-c", "echo hello | tr a-z A-Z"],
    killProcessGroup: true,
  });
  assert.deepEqual(buildTerminalShellSpawnCommand("dir C:\\Users", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "dir C:\\Users"],
    killProcessGroup: true,
  });
});

test("resolveAgentSessionCwd translates WSL cwd for Windows exe agents", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Users/User/AppData/Local/GitHub CLI/copilot/copilot.exe" --acp --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd leaves non-WSL and non-Windows agents on resolved cwd", async () => {
  const nonWsl = await resolveAgentSessionCwd("relative/project", "/mnt/c/tools/copilot.exe", {
    platform: "linux",
    existsSync: () => false,
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });
  const inputCwd = "/home/user/project";
  const wslNodeAgent = await resolveAgentSessionCwd(inputCwd, "node ./agent.js", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });

  assert.equal(nonWsl, path.resolve("relative/project"));
  assert.equal(wslNodeAgent, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd translates WSL cwd for Windows .cmd wrappers", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Program Files/nodejs/npx.cmd" some-acp-agent --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd translates WSL cwd for Windows agents on non-C drives", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/d/tools/agent.bat --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async (value) => {
      capturedCwd = value;
      return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
    },
  });

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd does not translate WSL cwd for extension-less commands under /mnt/<drive>/", async () => {
  const inputCwd = "/home/user/project";
  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/c/tools/linux-agent --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run for extension-less /mnt/<drive>/ commands");
    },
  });

  assert.equal(cwd, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd rejects empty wslpath output", async () => {
  await assert.rejects(
    resolveAgentSessionCwd("/home/user/project", "/mnt/c/tools/copilot.exe --acp", {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async () => "\n",
    }),
    /wslpath returned an empty Windows path/,
  );
});

test("buildTerminalSpawnOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildTerminalSpawnOptions(
      "npx",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const options = buildTerminalSpawnOptions(
      "node",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable finds claude.exe on PATH on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = { PATH: tempDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable respects case-insensitive env var on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      claude_code_executable: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined on non-Windows platforms", () => {
  const result = resolveClaudeCodeExecutable("linux", { PATH: "/usr/bin" } as NodeJS.ProcessEnv);
  assert.equal(result, undefined);
});

test("resolveClaudeCodeExecutable returns undefined when claude is not on PATH", () => {
  const env = { PATH: "/nonexistent", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
  const result = resolveClaudeCodeExecutable("win32", env);
  assert.equal(result, undefined);
});

// --- CLAUDE_CONFIG_DIR resolution (registry `default` governs unselected sessions) ---
// Hermetic: every case injects a temp registry + real temp configDirs via the
// 4th `lookupOptions` arg, so NONE of these read this box's real ~/.acpx (which
// has default=sub2). Ambient Claude subscription env is scrubbed so ABSENT
// assertions are meaningful regardless of how the test runner was launched.

type SubsHomeContext = {
  lookupOptions: SubscriptionLookupOptions;
  configDir: (id: string) => string;
};

async function withSubscriptionsHome(
  setup: { registry?: unknown; existingDirs?: string[] },
  run: (ctx: SubsHomeContext) => Promise<void>,
): Promise<void> {
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAcpxSubscription = process.env.ACPX_SUBSCRIPTION;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ACPX_SUBSCRIPTION;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-spawn-subs-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    const registryPath = path.join(subsDir, "registry.json");
    if (setup.registry !== undefined) {
      await fs.writeFile(registryPath, JSON.stringify(setup.registry));
    }
    for (const id of setup.existingDirs ?? []) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
    }
    await run({
      lookupOptions: { homeDir, registryPath },
      configDir: (id) => path.join(subsDir, id),
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    if (previousAcpxSubscription === undefined) {
      delete process.env.ACPX_SUBSCRIPTION;
    } else {
      process.env.ACPX_SUBSCRIPTION = previousAcpxSubscription;
    }
  }
}

function hasClaudeConfigDir(env: NodeJS.ProcessEnv): boolean {
  return Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR");
}

const TWO_SUB_REGISTRY = {
  default: "sub2",
  subscriptions: [
    { id: "sub1", label: "One" },
    { id: "sub2", label: "Two" },
  ],
};

test("buildAgentSpawnOptions (N1) explicit valid subscription → CLAUDE_CONFIG_DIR is that configDir", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
    },
  );
});

test("buildAgentSpawnOptions (N2/W14-01) unselected + usable default → raw env, no late binding", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" }, // no subscriptionId
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.equal(options.env.ACPX_SUBSCRIPTION, undefined);
        assert.deepEqual(writes, []);
      });
    },
  );
});

test("buildAgentSpawnOptions (N3) unselected + default whose dir is MISSING → CLAUDE_CONFIG_DIR ABSENT and silent", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1"] }, // sub2 (the default) dir not created
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.deepEqual(writes, []); // defaultUnusable is intentionally silent
      });
    },
  );
});

test("buildAgentSpawnOptions (N4) explicit unknown + usable default → loud refusal", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        assert.throws(
          () =>
            buildAgentSpawnOptions(
              "/tmp/acpx-agent",
              undefined,
              { acpxRecordId: "rec", subscriptionId: "ghost" },
              ctx.lookupOptions,
            ),
          /subscription "ghost" not found in registry; refusing to spawn on a different account/,
        );
        assert.deepEqual(writes, []);
      });
    },
  );
});

test("buildAgentSpawnOptions (G1) no registry + unselected → CLAUDE_CONFIG_DIR ABSENT and ZERO subscription stderr", async () => {
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    await withCapturedStderrWrites(async (writes) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec" },
        ctx.lookupOptions,
      );
      assert.equal(hasClaudeConfigDir(options.env), false);
      assert.deepEqual(writes, []);
    });
  });
});

test("buildAgentSpawnOptions (G2) no registry + explicit unknown → loud refusal", async () => {
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    await withCapturedStderrWrites(async (writes) => {
      assert.throws(
        () =>
          buildAgentSpawnOptions(
            "/tmp/acpx-agent",
            undefined,
            { acpxRecordId: "rec", subscriptionId: "ghost" },
            ctx.lookupOptions,
          ),
        /subscription "ghost" not found in registry; refusing to spawn on a different account/,
      );
      assert.deepEqual(writes, []);
    });
  });
});

test("buildAgentSpawnOptions (G3) registry present but default ABSENT + unselected → ABSENT and silent", async () => {
  await withSubscriptionsHome(
    { registry: { subscriptions: [{ id: "sub1", label: "One" }] }, existingDirs: ["sub1"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.deepEqual(writes, []);
      });
    },
  );
});

test("buildAgentSpawnOptions (G4) explicit id with MISSING dir, no default → loud refusal", async () => {
  await withSubscriptionsHome(
    { registry: { subscriptions: [{ id: "sub1", label: "One" }] }, existingDirs: [] }, // sub1 dir not created, no default
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        assert.throws(
          () =>
            buildAgentSpawnOptions(
              "/tmp/acpx-agent",
              undefined,
              { acpxRecordId: "rec", subscriptionId: "sub1" },
              ctx.lookupOptions,
            ),
          new RegExp(
            `subscription "sub1" configDir not found at ${ctx.configDir(
              "sub1",
            )}; refusing to spawn on a different account`,
          ),
        );
        assert.deepEqual(writes, []);
      });
    },
  );
});

// --- ACPX_SUBSCRIPTION env export (E.2) ---

test("buildAgentSpawnOptions (S1) explicit sub → ACPX_SUBSCRIPTION = that id", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.ACPX_SUBSCRIPTION, "sub1");
    },
  );
});

test("buildAgentSpawnOptions (S2/W14-01) unselected + default → ACPX_SUBSCRIPTION absent", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SUBSCRIPTION"), false);
        assert.deepEqual(writes, []);
      });
    },
  );
});

test("buildAgentSpawnOptions (S3) no registry → ACPX_SUBSCRIPTION ABSENT (backward safety)", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "rec" },
      ctx.lookupOptions,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SUBSCRIPTION"), false);
  });
});

// --- Pre-spawn known-dead avoidance (§4.1.4) ---

test("buildAgentSpawnOptions (K1) explicit resolved sub known-dead → no hidden substitution", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      markSubscriptionDead("sub1");
      try {
        await withCapturedStderrWrites(async () => {
          const options = buildAgentSpawnOptions(
            "/tmp/acpx-agent",
            undefined,
            { acpxRecordId: "rec", subscriptionId: "sub1" }, // explicitly pinned to the dead sub
            ctx.lookupOptions,
          );
          assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
          assert.equal(options.env.ACPX_SUBSCRIPTION, "sub1");
        });
      } finally {
        resetKnownDeadSubs();
      }
    },
  );
});

test("buildAgentSpawnOptions (K2) known-dead set empty → no substitution (identical to today)", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
    },
  );
});

test("buildQueueOwnerSpawnOptions routes stdout+stderr to the owner-log fd when provided", () => {
  const withFd = buildQueueOwnerSpawnOptions('{"sessionId":"queue-session"}', 42);
  assert.deepEqual(withFd.stdio, ["ignore", 42, 42]);
  assert.equal(withFd.detached, true);
  assert.equal(withFd.env.ACPX_QUEUE_OWNER_PAYLOAD, '{"sessionId":"queue-session"}');
  // (a) With the log fd active, the owner is marked (ACPX_OWNER_LOG=1) so its
  // in-process client may emit diagnostic disconnect/exit lines to stderr (→ the
  // owner log); absent it (e.g. a json-strict CLI) those lines stay suppressed.
  assert.equal(withFd.env.ACPX_OWNER_LOG, "1");
  // No fd (or null) → the prior "ignore" behavior is preserved.
  assert.equal(buildQueueOwnerSpawnOptions('{"sessionId":"queue-session"}', null).stdio, "ignore");
  assert.equal(buildQueueOwnerSpawnOptions('{"sessionId":"queue-session"}').stdio, "ignore");
});

// --- ACPX_AGENT_TYPE (brick://aa74cb34) -------------------------------------
// The environment named the box, the session, the parent and the brick, and
// never the harness — so an agent's only cross-harness self-identification was
// inference. A pi agent inferred wrong, copied a claude-shaped spawn block, and
// its child diverged on agent-type, model and effort at once.

test("buildAgentSpawnOptions injects ACPX_AGENT_TYPE for every classified harness", () => {
  for (const [agentCommand, expected] of [
    ["node /opt/claude-agent-acp/dist/index.js", "claude"],
    ["node /opt/pi-acp/dist/index.js", "pi"],
    ["node /opt/codex-acp/dist/index.js", "codex"],
  ] as const) {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "11111111-2222-3333-4444-555555555555" },
      undefined,
      agentCommand,
    );
    // Present for claude too, deliberately: a discriminator that appears only in
    // the non-default case teaches agents to infer from ABSENCE — the exact flaw
    // in ACPX_EFFECTIVE_ADAPTER, which reads "claude" and is absent under pi.
    assert.equal(options.env.ACPX_AGENT_TYPE, expected);
  }
});

test("buildAgentSpawnOptions leaves ACPX_AGENT_TYPE UNSET for an unclassifiable agent command", () => {
  const previous = process.env.ACPX_AGENT_TYPE;
  // Poison the ambient env: the point is that a stale inherited value must not
  // survive into a session acpx cannot classify (FW-07), because a confidently
  // WRONG harness id is worse than none — absence reads as "find out another
  // way", a wrong value gets acted on.
  process.env.ACPX_AGENT_TYPE = "claude";
  try {
    // `undefined` = no agent command reached the env builder at all; the second
    // is a well-formed command for an adapter no detector knows.
    // NOT covered: an EMPTY agentCommand — `buildAgentEnvironment` throws
    // "Invalid --agent command: empty command" from `isClaudePtyAgentCommand`
    // further down, pre-existing behavior unrelated to this variable
    // (`harnessIdForAgentCommand` short-circuits an empty command by contract).
    for (const agentCommand of [undefined, "node /opt/some-unknown-acp/dist/index.js"]) {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "11111111-2222-3333-4444-555555555555" },
        undefined,
        agentCommand,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_AGENT_TYPE"),
        false,
        `expected ACPX_AGENT_TYPE unset for agentCommand ${JSON.stringify(agentCommand)}`,
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_AGENT_TYPE;
    } else {
      process.env.ACPX_AGENT_TYPE = previous;
    }
  }
});

// --- account-stamp leak (brick://6530d3b4) ----------------------------------
// The FW-07 delete list covered session identity and not account identity, so a
// pi child of a claude parent inherited a complete Claude credential identity
// for a session authenticated by an OpenRouter box key. The ACPX_EFFECTIVE_ADAPTER
// half of it is what makes this an IDENTITY bug and not only a hygiene one: it
// reads "claude" inside a pi session (brick://aa74cb34).

const LEAKED_ACCOUNT_STAMP = {
  ACPX_SUBSCRIPTION: "sub7",
  ACPX_EFFECTIVE_PROFILE: "sub7",
  ACPX_EFFECTIVE_ACCOUNT: "sub7",
  ACPX_EFFECTIVE_ADAPTER: "claude",
  ACPX_EFFECTIVE_AUTH_MODE: "subscription",
  ACPX_EFFECTIVE_ANCHOR: "/home/node/.acpx/subscriptions/sub7",
} as const;

function withPoisonedAccountStamp(run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(LEAKED_ACCOUNT_STAMP)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("buildAgentSpawnOptions does not leak the parent's account stamp into a child with no selection", () => {
  withPoisonedAccountStamp(() => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "11111111-2222-3333-4444-555555555555" },
      undefined,
      "node /opt/pi-acp/dist/index.js",
    );
    for (const key of Object.keys(LEAKED_ACCOUNT_STAMP)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, key),
        false,
        `${key} leaked from the spawning process into a session with no account selection`,
      );
    }
    // The whole point: the harness answer must come from the classifier, not
    // from whatever the parent happened to be.
    assert.equal(options.env.ACPX_AGENT_TYPE, "pi");
  });
});

test("buildAgentSpawnOptions still stamps the account for a session that HAS a subscription", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      // Poisoned with sub7 throughout: a pass proves the values were re-derived
      // for THIS session rather than survived from the environment.
      withPoisonedAccountStamp(() => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec", subscriptionId: "sub1" },
          ctx.lookupOptions,
          "node /opt/claude-agent-acp/dist/index.js",
        );
        assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
        assert.equal(options.env.ACPX_SUBSCRIPTION, "sub1");
        assert.equal(options.env.ACPX_EFFECTIVE_PROFILE, "sub1");
        assert.equal(options.env.ACPX_EFFECTIVE_ADAPTER, "claude");
        assert.equal(options.env.ACPX_AGENT_TYPE, "claude");
      });
    },
  );
});

// --- CLAUDE_CONFIG_DIR leak (brick://1820be37) ------------------------------
// The OPERATIVE half of the account-stamp leak: this variable points at a
// subscription's real credential directory. Measured on devbox, a pi child of a
// claude parent inherited it. Not a privilege escalation (same uid, conventional
// path) but a scoping defect acpx already legislates against in the profile
// paths and never generalised to the shared env builder.

const POISON_CONFIG_DIR = "/home/node/.acpx/subscriptions/sub7";

function withPoisonedConfigDir(run: () => void): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = POISON_CONFIG_DIR;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
}

test("buildAgentSpawnOptions does not leak CLAUDE_CONFIG_DIR into a non-claude child", () => {
  withPoisonedConfigDir(() => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "11111111-2222-3333-4444-555555555555" },
      undefined,
      "node /opt/pi-acp/dist/index.js",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(options.env, "CLAUDE_CONFIG_DIR"),
      false,
      "a pi session must not receive a pointer into a Claude subscription's credential dir",
    );
  });
});

test("buildAgentSpawnOptions does not leak CLAUDE_CONFIG_DIR into a claude-pty child", () => {
  // The subscription branch documents claude-pty as getting "no CLAUDE_CONFIG_DIR"
  // (the bridge owns auth via its HOME selector) — but it never cleared an
  // INHERITED one, so the code contradicted its own comment.
  withPoisonedConfigDir(() => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "11111111-2222-3333-4444-555555555555" },
      undefined,
      "node /opt/claude-pty-acp/dist/index.js",
    );
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "CLAUDE_CONFIG_DIR"), false);
  });
});

test("buildAgentSpawnOptions still resolves CLAUDE_CONFIG_DIR for a subscription-bound claude child", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      // Poisoned with a FOREIGN dir throughout: the assertion fails if the value
      // survived from the environment, and equally if nothing re-derived it.
      withPoisonedConfigDir(() => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec", subscriptionId: "sub1" },
          ctx.lookupOptions,
          "node /opt/claude-agent-acp/dist/index.js",
        );
        assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
        assert.notEqual(options.env.CLAUDE_CONFIG_DIR, POISON_CONFIG_DIR);
      });
    },
  );
});
