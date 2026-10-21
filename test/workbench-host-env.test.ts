import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

// Per-seat workbench, block F (brick 79f7a34f; plan I1/C3/K2/K14, contracts C0/C1) — acpx exports
// ACPX_WORKBENCH_HOST, this seat's workbench address, at every spawn: ACPX_WORKBENCH_HOST_TEMPLATE
// from acpx's own env with `{seat}` replaced by the lowercase seat UUID. Its presence switches the
// process to per-seat workbenches, so every row below that expects it ABSENT is a guarantee too.

const TEMPLATE = "wb-{seat}.wb.dev-devbox.svc.cluster.local";
const SEAT_A = "11111111-2222-4333-8444-555555555555";
const SEAT_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HOST_A = `wb-${SEAT_A}.wb.dev-devbox.svc.cluster.local`;
const HOST_B = `wb-${SEAT_B}.wb.dev-devbox.svc.cluster.local`;

/** Run `fn` with the given process.env overrides (`undefined` = unset), restoring every key after. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
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

function hostFor(
  vars: Record<string, string | undefined>,
  context: { acpxRecordId?: string; seatId?: string | null },
): string | undefined {
  return withEnv(
    {
      ACPX_UI_BASE_URL: "https://atrium.devbox.nativai.de",
      ACPX_WORKBENCH_HOST: undefined,
      ...vars,
    },
    () => {
      const env = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "record-id",
        ...context,
      }).env;
      return Object.prototype.hasOwnProperty.call(env, "ACPX_WORKBENCH_HOST")
        ? env.ACPX_WORKBENCH_HOST
        : undefined;
    },
  );
}

async function warningsFor(
  vars: Record<string, string | undefined>,
  context: { seatId?: string | null },
): Promise<{ host: string | undefined; warnings: string[] }> {
  let host: string | undefined;
  let warnings: string[] = [];
  await withCapturedStderrWrites(async (writes) => {
    host = hostFor(vars, context);
    warnings = writes.filter((line) => line.includes("ACPX_WORKBENCH_HOST is not set"));
  });
  return { host, warnings };
}

test("template set + seat ⇒ the template with {seat} replaced by the seat, byte for byte", () => {
  assert.equal(hostFor({ ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE }, { seatId: SEAT_A }), HOST_A);
});

test("the seat is lower-cased and trimmed, the template trimmed", () => {
  assert.equal(
    hostFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: `  ${TEMPLATE}\n` },
      { seatId: ` ${SEAT_A.toUpperCase()} ` },
    ),
    HOST_A,
  );
});

// ⚠️ Bites only where NO atrium base URL resolves (off-cluster, e.g. upstream CI): on a dev box
// /proc/1/environ answers rung 2 of resolveAcpxUiBaseUrl whatever this row sets, and there is no seam.
test("no baseUrl gate: the host is exported with ACPX_UI_BASE_URL blank", () => {
  withEnv({ ACPX_UI_BASE_URL: "", ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE }, () => {
    const env = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "record-id",
      seatId: SEAT_A,
    }).env;
    assert.equal(env.ACPX_WORKBENCH_HOST, HOST_A);
  });
});

test("template unset or blank ⇒ ACPX_WORKBENCH_HOST absent, and no warning", async () => {
  for (const template of [undefined, "", "   "]) {
    const { host, warnings } = await warningsFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: template },
      { seatId: SEAT_A },
    );
    assert.equal(host, undefined, `template=${JSON.stringify(template)}`);
    assert.deepEqual(warnings, []);
  }
});

test("no seat (the transient creation spawn) ⇒ absent, even with the template set", () => {
  for (const seatId of [undefined, null, "", "   "]) {
    assert.equal(
      hostFor({ ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE }, { seatId }),
      undefined,
      `seatId=${JSON.stringify(seatId)}`,
    );
  }
});

test("FW-07 · an inherited stale ACPX_WORKBENCH_HOST is stripped when the template is unset", () => {
  assert.equal(
    hostFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: undefined, ACPX_WORKBENCH_HOST: HOST_B },
      { seatId: SEAT_A },
    ),
    undefined,
  );
});

test("FW-07 · an inherited stale ACPX_WORKBENCH_HOST is stripped on a seatless spawn", () => {
  assert.equal(
    hostFor({ ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE, ACPX_WORKBENCH_HOST: HOST_B }, {}),
    undefined,
  );
});

test("FW-07 · an inherited value from a DIFFERENT seat is replaced by this seat's, never kept", () => {
  assert.equal(
    hostFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE, ACPX_WORKBENCH_HOST: HOST_B },
      { seatId: SEAT_A },
    ),
    HOST_A,
  );
});

test("malformed template (no {seat}, or more than one) ⇒ absent + exactly one warning; stale value stripped", async () => {
  for (const template of [
    "wb.dev-devbox.svc.cluster.local",
    "wb-{SEAT}.wb.dev-devbox.svc.cluster.local",
    "wb-{seat}.wb-{seat}.dev-devbox.svc.cluster.local",
  ]) {
    const { host, warnings } = await warningsFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: template, ACPX_WORKBENCH_HOST: HOST_B },
      { seatId: SEAT_A },
    );
    assert.equal(host, undefined, `template=${template}`);
    assert.equal(warnings.length, 1, `template=${template}: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0] ?? "", /exactly once/);
  }
});

test("a seat that is not a UUID (contract C0) ⇒ absent + exactly one warning", async () => {
  for (const seatId of ["not-a-seat", "terminal", `${SEAT_A}x`, "../../etc"]) {
    const { host, warnings } = await warningsFor(
      { ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE },
      { seatId },
    );
    assert.equal(host, undefined, `seatId=${seatId}`);
    assert.equal(warnings.length, 1, `seatId=${seatId}: ${JSON.stringify(warnings)}`);
  }
});

test("a well-formed spawn emits no warning", async () => {
  const { host, warnings } = await warningsFor(
    { ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE },
    { seatId: SEAT_A },
  );
  assert.equal(host, HOST_A);
  assert.deepEqual(warnings, []);
});

test("handover successor (new holder, SAME seat) ⇒ the same value as its predecessor", () => {
  const vars = { ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE };
  const predecessor = hostFor(vars, { acpxRecordId: "predecessor-record", seatId: SEAT_A });
  // The successor is spawned by its predecessor's owner, so it inherits the predecessor's value.
  const successor = hostFor(
    { ...vars, ACPX_WORKBENCH_HOST: predecessor },
    { acpxRecordId: "successor-record", seatId: SEAT_A },
  );
  assert.equal(predecessor, HOST_A);
  assert.equal(successor, HOST_A);
});

test("fork (NEW seat) spawned from the source's env ⇒ the fork's own value, not the source's", () => {
  const vars = { ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE };
  const source = hostFor(vars, { acpxRecordId: "source-record", seatId: SEAT_A });
  const fork = hostFor(
    { ...vars, ACPX_WORKBENCH_HOST: source },
    { acpxRecordId: "fork-record", seatId: SEAT_B },
  );
  assert.equal(source, HOST_A);
  assert.equal(fork, HOST_B);
});

test("the template itself passes through to the child, so the child's own children get their own host", () => {
  withEnv({ ACPX_WORKBENCH_HOST_TEMPLATE: TEMPLATE }, () => {
    const env = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "record-id",
      seatId: SEAT_A,
    }).env;
    assert.equal(env.ACPX_WORKBENCH_HOST_TEMPLATE, TEMPLATE);
  });
});
