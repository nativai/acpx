import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

// Practical-tests pass 1, brick eb8b1fa3 (S4.5 / AC5). `ACPX_SESSION_NAME` became the SEAT's name (D-IDENTITY),
// so after a handover nothing in a holder's environment said WHICH holder it was: the brick CLI's journal
// author read the bare seat name for #1 and #2 alike. `ACPX_SEAT_ORDINAL` is the missing fact — the holder's own
// display ordinal (`record.holderOrdinal`) — and, like every other piece of session identity, it joins the FW-07
// delete block so a child of a long-lived owner can never inherit its parent's ordinal.

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

test("buildAgentSpawnOptions exports ACPX_SEAT_ORDINAL for a seated holder", () => {
  withEnvVars({ ACPX_SEAT_ORDINAL: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "holder-b",
      seatId: "137b9523-2f75-4172-8e96-94d52eeea152",
      seatOrdinal: 2,
    });
    assert.equal(options.env.ACPX_SEAT_ORDINAL, "2");
  });
});

test("ordinal 0 is exported (a falsy number is still an ordinal)", () => {
  withEnvVars({ ACPX_SEAT_ORDINAL: undefined }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "holder-zero",
      seatOrdinal: 0,
    });
    assert.equal(options.env.ACPX_SEAT_ORDINAL, "0");
  });
});

test("a context with no ordinal DELETES a stale inherited ACPX_SEAT_ORDINAL (FW-07)", () => {
  withEnvVars({ ACPX_SEAT_ORDINAL: "9" }, () => {
    for (const seatOrdinal of [undefined, null, -1, 1.5, Number.NaN]) {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        seatOrdinal,
      });
      assert.equal(
        has(options.env, "ACPX_SEAT_ORDINAL"),
        false,
        `seatOrdinal=${String(seatOrdinal)}`,
      );
    }
    const bare = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
    assert.equal(has(bare.env, "ACPX_SEAT_ORDINAL"), false);
  });
});

// ⚠️ THE FOUR LEGS. `sessionContext` is rebuilt from a record at four sites, field by field; a field missing from
// one is a silent half-fix (the first prompt through that leg has no ordinal). The list is GENERATED from the code:
// every `seatId: record.seatId ?? null` line under src/ must be followed by the ordinal line. The positive control is
// the count — four sites today; a shrunken census (a renamed field the scan no longer sees) fails loudly.
test("every sessionContext built from a record carries seatOrdinal beside seatId", () => {
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
  const missing: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*seatId: record\.seatId \?\? null,\s*$/.test(line)) {
        sites += 1;
        const window = lines.slice(index, index + 3).join("\n");
        if (!window.includes("seatOrdinal: record.holderOrdinal ?? null,")) {
          missing.push(`${path.relative(srcDir, file)}:${index + 1}`);
        }
      }
    });
  }
  assert.equal(sites, 4, `expected exactly 4 record-built sessionContext sites, found ${sites}`);
  assert.deepEqual(missing, []);
});
