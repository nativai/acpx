import { realpathSync } from "node:fs";
import { registerBranchHandler } from "./placement-step.js";

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
registerBranchHandler("record-only-create", async () => {
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
