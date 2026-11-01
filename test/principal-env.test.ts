import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { principalContextFields } from "../src/session/persistence/principal.js";

// PERSON-CONTRACT C8.6 / CONCEPTION §4.2: `ACPX_PRINCIPAL_ID` / `ACPX_PRINCIPAL_NAME` are set from the record in a
// child of a person-created session, and UNSET (not empty) in a child of a session with no principal — even
// when the caller's own environment carries a person (the strip). The real owner path is exercised by
// principal-spawn-paths.test.ts; this file pins buildAgentEnvironment and the four record-built contexts.

const P = "p-9df6e3afab610ff30d1a";
const NAME = "Daniel Brammertz";

function withEnvVars<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
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

test("a context naming a person exports ACPX_PRINCIPAL_ID and ACPX_PRINCIPAL_NAME", () => {
  withEnvVars({ ACPX_PRINCIPAL_ID: undefined, ACPX_PRINCIPAL_NAME: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child",
      principalId: P,
      principalName: NAME,
    });
    assert.equal(options.env.ACPX_PRINCIPAL_ID, P);
    assert.equal(options.env.ACPX_PRINCIPAL_NAME, NAME);
  });
});

test("an id without a name exports the id only; a name without an id exports nothing", () => {
  withEnvVars({ ACPX_PRINCIPAL_ID: undefined, ACPX_PRINCIPAL_NAME: undefined }, () => {
    const idOnly = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "c",
      principalId: P,
      principalName: null,
    });
    assert.equal(idOnly.env.ACPX_PRINCIPAL_ID, P);
    assert.equal(has(idOnly.env, "ACPX_PRINCIPAL_NAME"), false);

    const nameOnly = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "c",
      principalId: null,
      principalName: NAME,
    });
    assert.equal(has(nameOnly.env, "ACPX_PRINCIPAL_ID"), false);
    assert.equal(has(nameOnly.env, "ACPX_PRINCIPAL_NAME"), false);
  });
});

test("a context with NO principal leaves both UNSET — and strips the caller's inherited person (C8.6 negative)", () => {
  withEnvVars(
    { ACPX_PRINCIPAL_ID: "p-fb566154c0bf245b7538", ACPX_PRINCIPAL_NAME: "Daniel Laatz" },
    () => {
      for (const context of [
        { acpxRecordId: "bare-shell-child" },
        { acpxRecordId: "bare-shell-child", principalId: null, principalName: null },
        { acpxRecordId: "c", ...principalContextFields({ principal_via: "none" }) },
        {
          acpxRecordId: "c",
          ...principalContextFields({ principal_via: "inherited", principal_from: "x" }),
        },
        undefined,
      ]) {
        const { env } = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, context);
        assert.equal(has(env, "ACPX_PRINCIPAL_ID"), false, JSON.stringify(context));
        assert.equal(has(env, "ACPX_PRINCIPAL_NAME"), false, JSON.stringify(context));
        // "not an empty string": `[ -z "${ACPX_PRINCIPAL_ID+x}" ]` is true only when it is truly unset
        assert.equal(env.ACPX_PRINCIPAL_ID, undefined);
      }
    },
  );
});

test("the caller's inherited person never reaches a child that is itself principal-less, and a set principal replaces it", () => {
  withEnvVars(
    { ACPX_PRINCIPAL_ID: "p-fb566154c0bf245b7538", ACPX_PRINCIPAL_NAME: "Daniel Laatz" },
    () => {
      const { env } = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "c",
        principalId: P,
        principalName: NAME,
      });
      assert.equal(env.ACPX_PRINCIPAL_ID, P);
      assert.equal(env.ACPX_PRINCIPAL_NAME, NAME);
    },
  );
});

test("a malformed principal id is no principal: nothing is exported, and no padded or upper-case id is repaired", () => {
  withEnvVars({ ACPX_PRINCIPAL_ID: undefined, ACPX_PRINCIPAL_NAME: undefined }, () => {
    for (const bad of [
      `${P}\n`,
      ` ${P}`,
      "P-9df6e3afab610ff30d1a",
      "p-9df6e3afab610ff30d1",
      "laatz",
      "",
    ]) {
      const { env } = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "c",
        principalId: bad,
        principalName: NAME,
      });
      assert.equal(has(env, "ACPX_PRINCIPAL_ID"), false, JSON.stringify(bad));
      assert.equal(has(env, "ACPX_PRINCIPAL_NAME"), false, JSON.stringify(bad));
    }
  });
});

// ⚠️ THE FOUR LEGS. `sessionContext` is rebuilt from a record at four sites, field by field; a field missing from
// one is a silent half-fix — the first prompt through that leg has no principal while every in-memory test is
// green. The list is GENERATED from the code: every `seatId: record.seatId ?? null` line under src/ must be
// followed by the principal spread. The positive control is the count; a shrunken census fails loudly.
test("every sessionContext built from a record carries the principal beside seatId", () => {
  // Resolved from cwd, not import.meta.dirname: the suite runs the COMPILED tests out of dist-test/.
  const srcDir = path.join(process.cwd(), "src");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(srcDir);
  let sites = 0;
  let spreads = 0;
  const missing: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.includes("...principalContextFields(")) {
        spreads += 1;
      }
      if (/^\s*seatId: record\.seatId \?\? null,\s*$/.test(line)) {
        sites += 1;
        const window = lines.slice(index, index + 4).join("\n");
        if (!window.includes("...principalContextFields(record.metadata),")) {
          missing.push(`${path.relative(srcDir, file)}:${index + 1}`);
        }
      }
    });
  }
  assert.equal(sites, 4, `expected exactly 4 record-built sessionContext sites, found ${sites}`);
  assert.equal(spreads, sites, "a principal spread outside a record-built context is a stray");
  assert.deepEqual(missing, []);
});
