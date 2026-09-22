import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

// SEATS (brick 5ad22d5d, C3/D-B1-8/D-B1-9) — the additive dual-write for
// ACPX_SEAT_URL / ACPX_PARENT_SEAT_URL in buildAgentEnvironment. Modelled
// directly on the ACPX_SESSION_URL / ACPX_PARENT_SESSION_URL rows in
// spawn-options.test.ts — same composition, same FW-07 discipline, new vars.

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

/** Save/restore a process.env var around a block — the FW-07 pollution rig. */
function withEnvVar<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("buildAgentSpawnOptions composes ACPX_SEAT_URL exactly like ACPX_SESSION_URL, substituting ?seat=", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-record-id",
      seatId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(
      options.env.ACPX_SEAT_URL,
      "https://atrium.devbox.nativai.de/?seat=11111111-2222-3333-4444-555555555555",
    );
    // The sibling var keeps working unchanged (C3: additive dual-write, never a
    // cutover) — both present, naming different ids, from the same call.
    assert.equal(
      options.env.ACPX_SESSION_URL,
      "https://atrium.devbox.nativai.de/?session=child-record-id",
    );
  });
});

test("buildAgentSpawnOptions omits ACPX_SEAT_URL when seatId is empty/whitespace/absent", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    const whitespace = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-record-id",
      seatId: "   ",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(whitespace.env, "ACPX_SEAT_URL"), false);

    const absent = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-record-id",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(absent.env, "ACPX_SEAT_URL"), false);
  });
});

test("buildAgentSpawnOptions injects ACPX_PARENT_SEAT_URL when parentSeatId is non-empty, trimmed", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-record-id",
      parentSeatId: "  parent-seat-id-xyz  ",
    });
    assert.equal(
      options.env.ACPX_PARENT_SEAT_URL,
      "https://atrium.devbox.nativai.de/?seat=parent-seat-id-xyz",
    );
  });
});

test("buildAgentSpawnOptions omits ACPX_PARENT_SEAT_URL when parentSeatId is null/undefined/whitespace", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    for (const parentSeatId of [null, undefined, "   "] as const) {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-record-id",
        parentSeatId,
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SEAT_URL"),
        false,
        `parentSeatId=${JSON.stringify(parentSeatId)} must not produce ACPX_PARENT_SEAT_URL`,
      );
    }
  });
});

// ── D-B1-8 — THE HAZARD ROW ─────────────────────────────────────────────────
// This is the assertion the whole delete-block edit exists for. Without it,
// deleting ACPX_SESSION_URL/ACPX_PARENT_SESSION_URL but forgetting the seat
// siblings would pass every OTHER test in this file (they all supply fresh
// context) while silently reintroducing FW-07 for seat identity in production
// — a long-lived queue owner that served a different session leaking a STALE
// seat into a child, which then reports into someone else's seat.

test("FW-07 · a STALE ACPX_SEAT_URL never survives a spawn with no seat in context", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    withEnvVar("ACPX_SEAT_URL", "https://atrium.devbox.nativai.de/?seat=stale-foreign-seat", () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-record-id",
        // No seatId supplied — this spawn has no seat context of its own.
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_SEAT_URL"),
        false,
        "a pre-polluted foreign ACPX_SEAT_URL leaked into the built child env — " +
          "the FW-07 delete block is missing ACPX_SEAT_URL, or it isn't unconditional",
      );
    });
  });
});

test("FW-07 · a STALE ACPX_PARENT_SEAT_URL never survives a spawn with no parent seat in context", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    withEnvVar(
      "ACPX_PARENT_SEAT_URL",
      "https://atrium.devbox.nativai.de/?seat=stale-foreign-parent-seat",
      () => {
        const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
          acpxRecordId: "child-record-id",
          // No parentSeatId supplied.
        });
        assert.equal(
          Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SEAT_URL"),
          false,
          "a pre-polluted foreign ACPX_PARENT_SEAT_URL leaked into the built child env",
        );
      },
    );
  });
});

test("FW-07 · a spawn WITH its own seat context overwrites, never merges with, a stale value", () => {
  withAcpxUiBaseUrlEnv("https://atrium.devbox.nativai.de", () => {
    withEnvVar("ACPX_SEAT_URL", "https://atrium.devbox.nativai.de/?seat=stale-foreign-seat", () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-record-id",
        seatId: "this-spawns-own-seat",
      });
      assert.equal(
        options.env.ACPX_SEAT_URL,
        "https://atrium.devbox.nativai.de/?seat=this-spawns-own-seat",
      );
    });
  });
});
