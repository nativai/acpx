// brick e50e171d (Daniel's ruling, 2026-10-11) — under a DELIBERATE close, an ACCEPTED delivery counts as DELIVERED.
//
// Unit rows for the two pieces the runtime rows (close-cut-main-turn, delivery-consumption) do not isolate: the
// choke point's decision table (`closeDrainTerminal`) and the owner-exit sweep of absorbed steers. The main-turn sweep
// and the runtime choke point are driven end to end in test/close-cut-main-turn.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE,
  closeDrainTerminal,
  DELIVERED_AT_CLOSE,
  DELIVERED_AT_CLOSE_NOTE,
  SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
  TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  noteSessionCloseDrain,
  resetSessionCloseIntentForTests,
} from "../src/cli/queue/session-close-intent.js";
import {
  registerAbsorbedDeliveries,
  type RegisteredAbsorbedDelivery,
  terminalizeAbsorbedDeliveriesOnOwnerExit,
} from "../src/cli/session/absorbed-delivery-registry.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { listSessionEvents } from "../src/session/events.js";
import { withTempHome } from "./runtime-test-helpers.js";

const disconnected = {
  code: 0,
  message: "ACP agent disconnected",
  detailCode: "AGENT_DISCONNECTED",
};
const watchdog = { code: 0, message: "watchdog", detailCode: TURN_WATCHDOG_CANCELLED_DETAIL_CODE };

test("e50e171d: closeDrainTerminal — an ACCEPTED delivery cut while a close drains is delivered, any cut", () => {
  for (const [phase, error, detailCode] of [
    ["cancelled", undefined, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE],
    ["failed", watchdog, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE],
    // Widened past cancel/watchdog: the non-self arm can kill the adapter before the ACP cancel lands.
    ["failed", disconnected, "AGENT_DISCONNECTED"],
    ["failed", undefined, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE],
  ] as const) {
    assert.deepEqual(
      closeDrainTerminal({ closeDrainActive: true, accepted: true, phase, error }),
      {
        kind: "delivered",
        note: { code: 0, message: DELIVERED_AT_CLOSE_NOTE, detailCode },
      },
      `${phase} ${error?.detailCode ?? ""}`,
    );
  }
});

test("e50e171d: closeDrainTerminal — a NEVER-accepted delivery is never delivered (Daniel's case 2)", () => {
  // A failure before `accepted` (the injected path's recordPromptStart throwing) keeps its own terminal.
  assert.equal(
    closeDrainTerminal({
      closeDrainActive: true,
      accepted: false,
      phase: "failed",
      error: disconnected,
    }),
    undefined,
  );
  // A cancel or watchdog cut of one keeps today's outcome-unknown close code.
  assert.deepEqual(
    closeDrainTerminal({ closeDrainActive: true, accepted: false, phase: "cancelled" }),
    { kind: "turn-cancelled" },
  );
  assert.deepEqual(
    closeDrainTerminal({
      closeDrainActive: true,
      accepted: false,
      phase: "failed",
      error: watchdog,
    }),
    { kind: "turn-cancelled" },
  );
});

test("e50e171d: closeDrainTerminal — no close drain, or the turn's own done, changes nothing", () => {
  for (const phase of ["cancelled", "failed", "done"] as const) {
    assert.equal(
      closeDrainTerminal({ closeDrainActive: false, accepted: true, phase, error: disconnected }),
      undefined,
      `no close: ${phase}`,
    );
  }
  assert.equal(
    closeDrainTerminal({ closeDrainActive: true, accepted: true, phase: "done" }),
    undefined,
    "a turn that ended on its own keeps its own done",
  );
});

type DeliveryParams = {
  messageId?: string;
  phase?: string;
  stopReason?: string | null;
  error?: { message?: string; detailCode?: string };
};

async function terminalsFor(sessionId: string, messageId: string): Promise<DeliveryParams[]> {
  const events = (await listSessionEvents(sessionId)) as Array<{
    method?: string;
    params?: DeliveryParams;
  }>;
  return events
    .filter((event) => event.method === "acpx/delivery")
    .map((event) => event.params ?? {})
    .filter((params) => params.messageId === messageId && params.phase !== "accepted");
}

async function sweepAbsorbed(
  sessionId: string,
  closing: boolean,
): Promise<{ sweep: ReturnType<typeof terminalizeAbsorbedDeliveriesOnOwnerExit>; steer: string }> {
  await fs.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
  const steer = `steer-${sessionId}`;
  const consumedSteer = `consumed-${sessionId}`;
  const deliveries: RegisteredAbsorbedDelivery[] = [
    { context: { messageId: steer, requestId: `req-${steer}` }, terminalWritten: false },
    {
      context: { messageId: consumedSteer, requestId: `req-${consumedSteer}` },
      terminalWritten: false,
      consumed: true,
    },
  ];
  registerAbsorbedDeliveries(sessionId, deliveries);
  if (closing) {
    noteSessionCloseDrain(sessionId);
  }
  try {
    const sweep = terminalizeAbsorbedDeliveriesOnOwnerExit(sessionId);
    // R-CONSUMED keeps precedence under a close and outside one alike.
    const [consumed] = await terminalsFor(sessionId, consumedSteer);
    assert.equal(consumed?.stopReason, "consumed_before_cut", `${sessionId}: consumed first`);
    return { sweep, steer };
  } finally {
    resetSessionCloseIntentForTests();
  }
}

test("e50e171d: the absorbed owner-exit sweep writes done/delivered_at_close for a steer when a close drain told the owner", async () => {
  await withTempHome("acpx-delivered-at-close-absorbed-", async () => {
    const { sweep, steer } = await sweepAbsorbed("absorbed-closing", true);
    assert.deepEqual(sweep, { failed: 0, consumed: 1, deliveredAtClose: 1 });
    const terminals = await terminalsFor("absorbed-closing", steer);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.phase, "done");
    assert.equal(terminals[0]?.stopReason, DELIVERED_AT_CLOSE);
    assert.equal(terminals[0]?.error?.message, DELIVERED_AT_CLOSE_NOTE);
    assert.equal(terminals[0]?.error?.detailCode, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE);
  });
});

test("e50e171d (negative): an owner exit with NO close drain keeps the outcome-unknown failure — owner death still notifies", async () => {
  await withTempHome("acpx-delivered-at-close-absorbed-open-", async () => {
    const { sweep, steer } = await sweepAbsorbed("absorbed-open", false);
    assert.deepEqual(sweep, { failed: 1, consumed: 1, deliveredAtClose: 0 });
    const [terminal] = await terminalsFor("absorbed-open", steer);
    assert.equal(terminal?.phase, "failed");
    assert.equal(terminal?.error?.detailCode, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE);
  });
});
