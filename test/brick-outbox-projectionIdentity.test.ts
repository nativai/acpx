import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutboxError, projectionIdentity } from "../src/brick-outbox.js";

/**
 * Direct-import coverage for `projectionIdentity()` (97c158ed). Unlike the rest of this file's
 * scenarios, this function has no shared/module-level state and no lock semantics, so it does not
 * need the subprocess-worker pattern above — it is a pure function of its arguments plus
 * `os.homedir()`/`process.env`, both of which this file overrides per-test and restores after.
 *
 * The defect: `base` used to fall back to `process.env.ACPX_SESSION_URL` (an IDENTITY variable —
 * names the CALLING agent's own session) when neither an explicit `bound` identity nor
 * `ACPX_UI_BASE_URL` (a genuine box LOCATOR marker) was available. `ssh-remote` forwards the former
 * and deliberately withholds the latter, so on a box reached remotely with no `ACPX_UI_BASE_URL` of
 * its own, this silently minted a projection naming the CALLING box instead of refusing.
 */

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "b-outbox-pid-"));
  const originalHome = os.homedir();
  const homedirSpy = os.homedir;
  // os.homedir() has no env-based override on this platform's Node build worth relying on
  // (HOME is read at process start on some platforms) — stub the function directly, restored in
  // `finally`, exactly like the pattern below restores env.
  (os as unknown as { homedir: () => string }).homedir = () => home;
  try {
    fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".acpx", "instance.json"),
      JSON.stringify({ instance_id: "i-0123456789ab", home }),
    );
    return fn(home);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = homedirSpy;
    void originalHome;
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const record = { acpx_record_id: "rec-1" };

test("projectionIdentity: unbound, no ACPX_UI_BASE_URL, but ACPX_SESSION_URL set from the CALLER ⇒ REFUSE (not silently mint the caller's URL)", () => {
  withHome(() =>
    withEnv(
      {
        ACPX_UI_BASE_URL: undefined,
        ACPX_SESSION_URL: "https://atrium.ORIGINATING-BOX.nativai.de/?session=deadbeef",
      },
      () => {
        assert.throws(
          () => projectionIdentity(record),
          (error: unknown) => error instanceof OutboxError && error.code === "instance-url-missing",
        );
      },
    ),
  );
});

test("projectionIdentity POSITIVE CONTROL: unbound, ACPX_UI_BASE_URL set ⇒ resolves, using it — box is null (no ACPX_BOX substitution)", () => {
  withHome(() =>
    withEnv(
      { ACPX_UI_BASE_URL: "https://atrium.devbox.nativai.de", ACPX_SESSION_URL: undefined, ACPX_BOX: "should-not-be-used" },
      () => {
        const identity = projectionIdentity(record);
        assert.equal(identity.instance_id, "i-0123456789ab");
        assert.equal(new URL(identity.session_url).origin, "https://atrium.devbox.nativai.de");
        assert.equal(identity.box, null);
      },
    ),
  );
});

test("projectionIdentity POSITIVE CONTROL: an explicit `bound` identity wins verbatim, ignoring env entirely", () => {
  withHome(() =>
    withEnv(
      {
        ACPX_UI_BASE_URL: "https://wrong-should-be-ignored.example",
        ACPX_SESSION_URL: "https://also-wrong.example/?session=x",
      },
      () => {
        const identity = projectionIdentity(record, {
          instance_id: "i-0123456789ab",
          box: "devbox",
          public_base_url: "https://atrium.devbox.nativai.de",
        });
        assert.equal(identity.box, "devbox");
        assert.equal(new URL(identity.session_url).origin, "https://atrium.devbox.nativai.de");
      },
    ),
  );
});
