import type { SessionRecord } from "../../types.js";

/**
 * Serialises the boundary record-writes for ONE sub-agent record so two
 * concurrent `teammate_*` updates can never interleave their writes, and drops
 * the chain entry once it settles.
 *
 * Extracted from the queue-owner runtime closure so the promise shape below is
 * reachable from a test with a rejecting `write` — the exact production fault
 * (brick://da3d7c95) lives in the shape, not in the write.
 */
export function createSubagentBoundaryWriteEnqueuer(deps: {
  /** The runtime's own `subagentSaveChains` map — shared, not owned here. */
  chains: Map<string, Promise<void>>;
  write: (record: SessionRecord) => Promise<void>;
  onWriteError: (childAcpxRecordId: string, error: unknown) => void;
}): (childAcpxRecordId: string, childRecord: SessionRecord) => Promise<void> {
  return (childAcpxRecordId: string, childRecord: SessionRecord): Promise<void> => {
    const previous = deps.chains.get(childAcpxRecordId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Preserve ordering after a best-effort write failure.
      })
      .then(async () => {
        await deps.write(childRecord);
      });
    deps.chains.set(childAcpxRecordId, next);
    // ⚠️ DO NOT DROP THE TRAILING `.catch()`, AND DO NOT "SIMPLIFY" THIS BACK TO
    // `void next.finally(...)`. It looks like a tidy-up and it is the bug.
    // `.finally()` returns a NEW promise that INHERITS `next`'s rejection, and
    // `void` discards it with no handler attached. The call sites' own
    // `.catch(() => {})` settles `next`, NOT this derived promise. acpx installs
    // no `process.on("unhandledRejection")`, so under Node's default
    // `--unhandled-rejections=throw` one rejected write — e.g.
    // `OutboxError("outbox-busy")` under record-outbox contention — becomes an
    // uncaught exception that kills the whole queue-owner process mid-turn.
    // Nine owners died that way on devbox on 2026-09-22.
    // Fire-tested by `test/subagent-boundary-write-rejection.test.ts`, which
    // runs this function in a child process and asserts it exits 0; removing
    // the `.catch()` turns that child's exit code to 1.
    void next
      .finally(() => {
        if (deps.chains.get(childAcpxRecordId) === next) {
          deps.chains.delete(childAcpxRecordId);
        }
      })
      .catch((error: unknown) => {
        // Not a blanket swallow. Both call sites discard `next` silently, so
        // this chain is the one place a lost sub-agent record write is observed
        // exactly once — `onWriteError` surfaces it instead of hiding it.
        deps.onWriteError(childAcpxRecordId, error);
      });
    return next;
  };
}
