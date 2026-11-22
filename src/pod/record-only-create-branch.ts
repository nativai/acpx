import { realpathSync } from "node:fs";
import { invocationAgentCommand, isClaudePtyCommand } from "./harness-support.js";
import { registerBranchHandler } from "./placement-step.js";
import { failLikeAcpx, routedArgv } from "./routed-branches.js";

/**
 * C1.3 — block A2's branch of the placement step: a `create` on the control pod in pod mode.
 * acpx runs the command as usual; every create path checks `isRecordOnlyCreate()` and writes the
 * record and nothing else (`cli/session/session-management.ts` `createRecordOnlySession`), the first
 * message goes into atrium's queue, nothing is admitted for room and no adapter or owner starts.
 *
 * ⚠️ KEEP THIS MODULE LIGHT: it is imported by `src/cli.ts` before the placement step runs, so its
 * static graph is node builtins and `placement-step.ts`; the heavy CLI is loaded only inside the
 * handler, as `cli.ts`'s own `start()` loads it.
 */
/**
 * A-39 (brick b69eeecf): the terminal harness has no pod, so a claude-pty record could never run in pod
 * mode. Refuse BEFORE anything is written — no record, no index row, no queue entry — by name, in the
 * routed calls' own shape (`ROUTED outcome=not_run reason=harness_unsupported`). Returns the exit code, or
 * undefined when the create may go on.
 */
async function refuseClaudePtyCreate(
  classification: Parameters<Parameters<typeof registerBranchHandler>[1]>[0]["classification"],
): Promise<number | undefined> {
  if (classification.kind !== "classified" || classification.path !== "sessions new") {
    return undefined;
  }
  const command = await invocationAgentCommand(
    classification.agent,
    routedArgv(process.argv, process.env),
  );
  if (!isClaudePtyCommand(command)) {
    return undefined;
  }
  const { randomUUID } = await import("node:crypto");
  const { RoutedCallError } = await import("./pod-refusal.js");
  return await failLikeAcpx(
    new RoutedCallError({
      outcome: "not_run",
      reason: "harness_unsupported",
      callId: randomUUID(),
    }),
    classification.output,
  );
}

registerBranchHandler("record-only-create", async (decision) => {
  const refused = await refuseClaudePtyCreate(decision.classification);
  if (refused !== undefined) {
    return refused;
  }
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  if (entry) {
    const { buildQueueOwnerArgOverride } = await import("../cli/session/queue-owner-process.js");
    const queueOwnerArgOverride = buildQueueOwnerArgOverride(entry);
    if (queueOwnerArgOverride) {
      process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
    }
  }
  const { main } = await import("../cli-core.js");
  await main(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
});
