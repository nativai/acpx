import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

// Save/restore a set of process.env keys around a test body so we can control the
// inherited environment buildAgentEnvironment copies from (base URL + any
// pre-existing GIT_CONFIG_* / GIT_AUTHOR_* the box happens to export).
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// A clean git-config env baseline: no inherited base URL override, no inherited
// GIT_CONFIG_* / GIT_AUTHOR_* / GIT_COMMITTER_* from the box.
const CLEAN_GIT_ENV: Record<string, string | undefined> = {
  ACPX_UI_BASE_URL: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_KEY_0: undefined,
  GIT_CONFIG_VALUE_0: undefined,
  GIT_CONFIG_KEY_1: undefined,
  GIT_CONFIG_VALUE_1: undefined,
  GIT_CONFIG_KEY_2: undefined,
  GIT_CONFIG_VALUE_2: undefined,
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
};

test("git attribution: sets author/committer identity from name + recordId + base-URL host", () => {
  withEnv(CLEAN_GIT_ENV, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "11111111-2222-3333-4444-555555555555",
      sessionName: "  w13-42-dev  ",
    });
    // Host is derived from the resolved acpx-ui base URL (default box host here).
    assert.equal(options.env.GIT_AUTHOR_NAME, "w13-42-dev");
    assert.equal(
      options.env.GIT_AUTHOR_EMAIL,
      "11111111-2222-3333-4444-555555555555@acpx.devbox.nativai.de",
    );
    // Committer pair is identical to the author pair.
    assert.equal(options.env.GIT_COMMITTER_NAME, options.env.GIT_AUTHOR_NAME);
    assert.equal(options.env.GIT_COMMITTER_EMAIL, options.env.GIT_AUTHOR_EMAIL);
  });
});

test("git attribution: falls back to acpx:<recordId8> when no session name", () => {
  withEnv(CLEAN_GIT_ENV, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "abcdef01-2222-3333-4444-555555555555",
    });
    assert.equal(options.env.GIT_AUTHOR_NAME, "acpx:abcdef01");
    assert.equal(options.env.GIT_COMMITTER_NAME, "acpx:abcdef01");
  });
});

test("git attribution: honors ACPX_UI_BASE_URL host for the author email", () => {
  withEnv({ ...CLEAN_GIT_ENV, ACPX_UI_BASE_URL: "https://acpx.tubeyakker.nativai.de" }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "deadbeef-0000-0000-0000-000000000000",
      sessionName: "runner",
    });
    assert.equal(
      options.env.GIT_AUTHOR_EMAIL,
      "deadbeef-0000-0000-0000-000000000000@acpx.tubeyakker.nativai.de",
    );
  });
});

test("git attribution: activates core.hooksPath via GIT_CONFIG_* with no pre-existing count", () => {
  withEnv(CLEAN_GIT_ENV, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      sessionName: "runner",
    });
    assert.equal(options.env.GIT_CONFIG_COUNT, "1");
    assert.equal(options.env.GIT_CONFIG_KEY_0, "core.hooksPath");
    const value = options.env.GIT_CONFIG_VALUE_0;
    assert.ok(value !== undefined, "GIT_CONFIG_VALUE_0 must be set");
    assert.ok(isAbsolute(value), `hooks dir must be absolute, got ${value}`);
    assert.ok(value.endsWith("git-hooks"), `hooks dir must end with git-hooks, got ${value}`);
  });
});

test("git attribution: appends to a pre-existing GIT_CONFIG_COUNT without clobbering it", () => {
  withEnv(
    {
      ...CLEAN_GIT_ENV,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Existing Zero",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "zero@example.com",
    },
    () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        sessionName: "runner",
      });
      // Pre-existing entries survive untouched.
      assert.equal(options.env.GIT_CONFIG_KEY_0, "user.name");
      assert.equal(options.env.GIT_CONFIG_VALUE_0, "Existing Zero");
      assert.equal(options.env.GIT_CONFIG_KEY_1, "user.email");
      assert.equal(options.env.GIT_CONFIG_VALUE_1, "zero@example.com");
      // Our hook config lands at index 2, count bumped to 3.
      assert.equal(options.env.GIT_CONFIG_KEY_2, "core.hooksPath");
      assert.ok(isAbsolute(options.env.GIT_CONFIG_VALUE_2 ?? ""));
      assert.equal(options.env.GIT_CONFIG_COUNT, "3");
    },
  );
});

test("git attribution: omitted entirely when recordId is absent/whitespace", () => {
  withEnv(CLEAN_GIT_ENV, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "   ",
      sessionName: "runner",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "GIT_AUTHOR_NAME"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "GIT_AUTHOR_EMAIL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "GIT_COMMITTER_NAME"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "GIT_COMMITTER_EMAIL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "GIT_CONFIG_COUNT"), false);
  });
});
