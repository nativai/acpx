// The writers of a session record that the A-65 rows drive, one table for both: the unknown top-level keys
// (unknown-top-level-fields.test.ts) and the carried `metadata` keys (metadata-key-rule.test.ts). A writer
// added here is covered by both.
import {
  writeTerminalCloseAfterOwnerStop,
  writeTerminalCloseRecord,
  type ClosedAdapter,
} from "../src/cli/session/terminal-close.js";
import {
  writeCloseScalarsOnFreshRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
  writeSessionRecordAtBoundaryNow,
  writeSessionRecordAtBoundaryWithLifecycle,
  writeSessionRecordAuthorizingParent,
  writeSessionRecordAuthorizingParentWithoutIndex,
  writeSessionRecordAuthorizingSeatHolderWithoutIndex,
  writeSessionRecordWithLifecycle,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import type { Raw } from "./unknown-top-level-fields-fixtures.js";

/** The close's adapter when the row has none to speak of (A-64's third argument; the pid stays as it is). */
const NO_ADAPTER: ClosedAdapter = {
  pid: undefined,
  pidIdentity: undefined,
  kill: { signalled: false, reason: "no-pid" },
};

export type Writer = {
  name: string;
  write: (record: SessionRecord) => Promise<void>;
  /** What this writer's own change looks like on disk. */
  landed: (raw: Raw) => boolean;
};

const titled = (title: string) => (raw: Raw) => raw.title === title;
export const WRITERS: Writer[] = [
  { name: "writeSessionRecord", write: writeSessionRecord, landed: titled("w1") },
  {
    name: "writeSessionRecordAtBoundary",
    write: (record) => writeSessionRecordAtBoundary(record),
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordAtBoundaryNow",
    write: writeSessionRecordAtBoundaryNow,
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordWithLifecycle",
    write: writeSessionRecordWithLifecycle,
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordAtBoundaryWithLifecycle",
    write: (record) => writeSessionRecordAtBoundaryWithLifecycle(record),
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordAuthorizingParent",
    write: writeSessionRecordAuthorizingParent,
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordAuthorizingParentWithoutIndex",
    write: writeSessionRecordAuthorizingParentWithoutIndex,
    landed: titled("w1"),
  },
  {
    name: "writeSessionRecordAuthorizingSeatHolderWithoutIndex",
    write: writeSessionRecordAuthorizingSeatHolderWithoutIndex,
    landed: titled("w1"),
  },
  {
    name: "writeTerminalCloseRecord (the close of a proven-stopped owner, its own write)",
    write: async (record) => {
      await writeTerminalCloseRecord(record);
    },
    landed: (raw) => raw.closed === true,
  },
  {
    name: "writeTerminalCloseAfterOwnerStop, owner stopped",
    write: async (record) => {
      await writeTerminalCloseAfterOwnerStop(
        record,
        { stopped: true, reason: "stopped" },
        NO_ADAPTER,
      );
    },
    landed: (raw) => raw.closed === true,
  },
  {
    name: "writeTerminalCloseAfterOwnerStop, owner NOT proven stopped (the scalars-only arm)",
    write: async (record) => {
      await writeTerminalCloseAfterOwnerStop(
        record,
        { stopped: false, reason: "survived" },
        NO_ADAPTER,
      );
    },
    landed: (raw) => raw.closed === true,
  },
  {
    name: "writeCloseScalarsOnFreshRecord",
    write: async (record) => {
      await writeCloseScalarsOnFreshRecord(record.acpxRecordId, "2026-11-24T00:00:00.000Z");
    },
    landed: (raw) => raw.closed === true,
  },
];
