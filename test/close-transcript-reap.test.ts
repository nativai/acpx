import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOSE_REAP_SLOW_CLOSE_MS,
  observeOwnerBeforeStop,
  reapTranscriptsAfterClose,
  type CloseReapDeps,
  type CloseReapInput,
} from "../src/cli/session/owner-exit-transcript-reap.js";
import { closeSession } from "../src/cli/session/session-control.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { readExitTailFile } from "../src/config/transcript-dedup.js";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import { withTempHome } from "./temp-home.js";
import {
  ageFile,
  conversation,
  exists,
  exitLine,
  jsonl,
  sessionIdFor,
  sha256File,
  writeFileAt,
  writeRecordFixture,
  writeRegistry,
} from "./transcript-fixture-test-helpers.js";

// Matrix H of brick 1e77037f (D5): the NON-SELF close removes the copy a session left in another
// subscription, as its last step, once the owner, its group, the adapter and `closed:true` are
// proven. HOME and ACPX_STATE_HOME are pinned to the temp home, so the step's REAL defaults
// (registry, record store, reaper, owner.log) resolve against the fixture.

const CWD = "/work/close-reap";
const TWO_MIN = 2 * 60_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Fx = { home: string; id: string; recordId: string; active: string; leftBehind: string };

async function withClosedSession(
  label: string,
  run: (fx: Fx) => Promise<void>,
  options: { pid?: number } = {},
): Promise<void> {
  await withTempHome(
    "acpx-close-reap-",
    async (home) => {
      await writeRegistry(home, ["subA", "subB"], "subA");
      const id = sessionIdFor(`close-${label}`);
      const recordId = `rec-close-${label}`;
      const sub = (name: string) => path.join(home, ".acpx", "subscriptions", name);
      await writeRecordFixture(home, {
        recordId,
        acpSessionId: id,
        cwd: CWD,
        profile: "subB",
        pid: options.pid,
      });
      await run({
        home,
        id,
        recordId,
        active: transcriptJsonlPath(sub("subB"), CWD, id),
        leftBehind: transcriptJsonlPath(sub("subA"), CWD, id),
      });
    },
    { pin: ["HOME", "ACPX_STATE_HOME"] },
  );
}

function bodies(id: string) {
  const p = conversation(id, { pairs: 16 });
  const newer = conversation(id, { pairs: 3, seed: "newer", startMinute: 200, parent: p.lastUuid });
  return { p, pText: jsonl(p.lines), full: jsonl(p.lines) + jsonl(newer.lines) };
}

/** A proven non-self close: record closed, owner observed + gone, group empty, no adapter. */
function provenClose(recordId: string, extra: Partial<CloseReapInput> = {}): CloseReapInput {
  return {
    sessionId: recordId,
    closeStartedAt: Date.now(),
    observation: { pid: 424242, identity: { kind: "timestamp" } as never, groupLeader: true },
    ownerStop: { stopped: true, reason: "stopped" },
    adapter: { pid: undefined, pidIdentity: undefined },
    recordClosedState: { status: "read", closed: { present: true, value: true } },
    ...extra,
  };
}

/** The owner it observed is gone and its group is empty — unless a row says otherwise. */
function deadOwnerDeps(extra: Partial<CloseReapDeps> = {}): Partial<CloseReapDeps> {
  return { isOwnerGone: () => true, listMembers: () => [], ...extra };
}

async function ownerLog(fx: Fx): Promise<string> {
  return await fs
    .readFile(path.join(fx.home, ".acpx", "sessions", `${fx.recordId}.owner.log`), "utf8")
    .catch(() => "");
}

async function seedPrefixLeftBehind(fx: Fx, ageMs = TWO_MIN) {
  const b = bodies(fx.id);
  await writeFileAt(fx.active, b.full);
  await writeFileAt(fx.leftBehind, b.pText);
  await ageFile(fx.leftBehind, ageMs);
  return b;
}

test("P: a proven close deletes a byte-prefix left-behind copy and logs it with trigger=session-close", async () => {
  await withClosedSession("p-prefix", async (fx) => {
    const b = await seedPrefixLeftBehind(fx);
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.equal(outcome?.ran, true, JSON.stringify(outcome));
    assert.equal(await exists(fx.leftBehind), false);
    assert.equal(await fs.readFile(fx.active, "utf8"), b.full, "the active copy is untouched");
    const log = await ownerLog(fx);
    assert.match(
      log,
      /transcript-reap session=\S+ active=\S+ deleted=1 reduced=0 .* trigger=session-close\n/,
    );
    assert.match(log, /transcript-reap-file action=deleted /);
  });
});

test("P (T): an exit-tail left-behind copy is reduced with reduced_by=session-close and restores sha-exact", async () => {
  await withClosedSession("p-tail", async (fx) => {
    const b = bodies(fx.id);
    await writeFileAt(fx.active, b.full);
    const body = b.pText + jsonl([exitLine("cost-state", fx.id, b.p.lastUuid)]);
    await writeFileAt(fx.leftBehind, body);
    await ageFile(fx.leftBehind, TWO_MIN);
    const before = await sha256File(fx.leftBehind);
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.equal(outcome?.ran, true);
    const reduced = outcome?.ran ? outcome.summary.files[0] : undefined;
    assert.equal(reduced?.action, "reduced");
    const { header, tail } = await readExitTailFile(reduced?.tailFile ?? "");
    assert.equal(header.reduced_by, "session-close");
    assert.equal(header.original_sha256, before);
    const active = await fs.readFile(fx.active);
    assert.equal(Buffer.concat([active.subarray(0, header.prefix_bytes), tail]).toString(), body);
  });
});

/** Every skip row: the left-behind copy stays byte-identical and the reason is logged. */
async function assertSkipped(fx: Fx, reason: string, run: () => Promise<unknown>) {
  const before = await sha256File(fx.leftBehind);
  const outcome = (await run()) as { ran: boolean; reason?: string } | undefined;
  assert.deepEqual(outcome, { ran: false, reason });
  assert.equal(await sha256File(fx.leftBehind), before, `${reason}: byte-identical`);
  assert.match(await ownerLog(fx), new RegExp(`skipped=${reason} trigger=session-close`));
}

test("N1: an owner that survived the stop → owner-alive, nothing removed", async () => {
  for (const reason of ["survived", "identity-unverified"]) {
    await withClosedSession(`n1-${reason}`, async (fx) => {
      await seedPrefixLeftBehind(fx);
      await assertSkipped(fx, "owner-alive", async () =>
        reapTranscriptsAfterClose(
          provenClose(fx.recordId, { ownerStop: { stopped: false, reason } }),
          deadOwnerDeps(),
        ),
      );
    });
  }
});

test("N1b: the observed owner pid is not gone by identity → owner-alive", async () => {
  await withClosedSession("n1b", async (fx) => {
    await seedPrefixLeftBehind(fx);
    await assertSkipped(fx, "owner-alive", async () =>
      reapTranscriptsAfterClose(
        provenClose(fx.recordId),
        deadOwnerDeps({ isOwnerGone: () => false }),
      ),
    );
  });
});

test("N2: a successor owner in the lease → successor-owner", async () => {
  await withClosedSession("n2", async (fx) => {
    await seedPrefixLeftBehind(fx);
    await assertSkipped(fx, "successor-owner", async () =>
      reapTranscriptsAfterClose(
        provenClose(fx.recordId, { ownerStop: { stopped: false, reason: "successor" } }),
        deadOwnerDeps(),
      ),
    );
  });
});

test("N3: an owner that was not its group's leader → no-leader", async () => {
  await withClosedSession("n3", async (fx) => {
    await seedPrefixLeftBehind(fx);
    const observation = {
      pid: 424242,
      identity: { kind: "timestamp" } as never,
      groupLeader: false,
    };
    await assertSkipped(fx, "no-leader", async () =>
      reapTranscriptsAfterClose(provenClose(fx.recordId, { observation }), deadOwnerDeps()),
    );
  });
});

test("N4: a live member left in the owner's group → group-busy (the closer waits, never signals)", async () => {
  await withClosedSession("n4", async (fx) => {
    await seedPrefixLeftBehind(fx);
    let clock = 0;
    const polled: number[] = [];
    await assertSkipped(fx, "group-busy", async () =>
      reapTranscriptsAfterClose(
        provenClose(fx.recordId),
        deadOwnerDeps({
          listMembers: (pgid) => {
            polled.push(pgid);
            return [777];
          },
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        }),
      ),
    );
    assert.ok(polled.length > 1, "the group is polled for its wait, not checked once");
    assert.ok(
      polled.every((pgid) => pgid === 424242),
      "the OBSERVED owner's pgid",
    );
  });
});

test("N5: the read-back failed or shows closed:false → not-closed", async () => {
  const states: CloseReapInput["recordClosedState"][] = [
    { status: "read_failed" },
    { status: "read", closed: { present: true, value: false } },
    { status: "read", closed: { present: false } },
  ];
  for (const [index, recordClosedState] of states.entries()) {
    await withClosedSession(`n5-${index}`, async (fx) => {
      await seedPrefixLeftBehind(fx);
      await assertSkipped(fx, "not-closed", async () =>
        reapTranscriptsAfterClose(provenClose(fx.recordId, { recordClosedState }), deadOwnerDeps()),
      );
    });
  }
});

test("N8: a divergent left-behind copy and one = active + 1 byte survive the close, byte-identical", async () => {
  await withClosedSession("n8", async (fx) => {
    const b = bodies(fx.id);
    const branch = conversation(fx.id, {
      pairs: 2,
      seed: "branch",
      startMinute: 90,
      parent: b.p.lastUuid,
    });
    await writeFileAt(fx.active, b.full);
    await writeFileAt(fx.leftBehind, b.pText + jsonl(branch.lines));
    await ageFile(fx.leftBehind, TWO_MIN);
    const before = await sha256File(fx.leftBehind);
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.equal(outcome?.ran, true);
    assert.equal(await sha256File(fx.leftBehind), before);
    await writeFileAt(fx.leftBehind, `${b.full}x`);
    await ageFile(fx.leftBehind, TWO_MIN);
    const plusOne = await sha256File(fx.leftBehind);
    await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.equal(await sha256File(fx.leftBehind), plusOne);
  });
});

test("N9: a left-behind copy written 30 s before the close is kept recent (the 60 s guard)", async () => {
  await withClosedSession("n9", async (fx) => {
    await seedPrefixLeftBehind(fx, 30_000);
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.equal(outcome?.ran, true);
    assert.deepEqual(outcome?.ran ? outcome.summary.keptReasons : {}, { recent: 1 });
    assert.equal(await exists(fx.leftBehind), true);
    assert.match(await ownerLog(fx), /keptReasons=recent:1 skipped=none trigger=session-close/);
  });
});

test("N10: an active copy that is not the freshest → not-freshest, nothing removed", async () => {
  await withClosedSession("n10", async (fx) => {
    const b = bodies(fx.id);
    await writeFileAt(fx.active, b.pText);
    await writeFileAt(fx.leftBehind, b.full);
    await ageFile(fx.leftBehind, TWO_MIN);
    const before = await sha256File(fx.leftBehind);
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), deadOwnerDeps());
    assert.deepEqual(outcome?.ran ? outcome.summary.skipped : [], ["not-freshest"]);
    assert.equal(await sha256File(fx.leftBehind), before);
  });
});

test("N11: a port renaming a new file onto the candidate mid-removal → path-replaced, the new file untouched", async () => {
  await withClosedSession("n11", async (fx) => {
    await seedPrefixLeftBehind(fx);
    const intruder = await writeFileAt(path.join(fx.home, "intruder.jsonl"), "a fresh port\n");
    const { reapLeftBehindTranscripts } = await import("../src/config/transcript-reap.js");
    const outcome = await reapTranscriptsAfterClose(
      provenClose(fx.recordId),
      deadOwnerDeps({
        reap: async (params) =>
          await reapLeftBehindTranscripts({
            ...params,
            hooks: { beforeRecheck: async () => await fs.rename(intruder, fx.leftBehind) },
          }),
      }),
    );
    assert.deepEqual(outcome?.ran ? outcome.summary.keptReasons : {}, { "path-replaced": 1 });
    assert.equal(await fs.readFile(fx.leftBehind, "utf8"), "a fresh port\n");
  });
});

test("N12: a recorded adapter pid that is a live process → adapter-alive", async () => {
  await withClosedSession("n12", async (fx) => {
    await seedPrefixLeftBehind(fx);
    await assertSkipped(fx, "adapter-alive", async () =>
      reapTranscriptsAfterClose(
        provenClose(fx.recordId, {
          observation: undefined,
          ownerStop: { stopped: true, reason: "no-owner" },
          adapter: { pid: process.pid, pidIdentity: undefined },
        }),
      ),
    );
  });
});

test("N13: a close that has already run ≥ 8 s skips the step without probing", async () => {
  await withClosedSession("n13", async (fx) => {
    await seedPrefixLeftBehind(fx);
    const calls: string[] = [];
    await assertSkipped(fx, "close-slow", async () =>
      reapTranscriptsAfterClose(
        provenClose(fx.recordId, { closeStartedAt: Date.now() - CLOSE_REAP_SLOW_CLOSE_MS }),
        deadOwnerDeps({
          hasLeftBehind: async () => {
            calls.push("probe");
            return true;
          },
          reap: async () => {
            calls.push("reap");
            throw new Error("must not run");
          },
          listMembers: () => {
            calls.push("group");
            return [];
          },
        }),
      ),
    );
    assert.deepEqual(calls, []);
  });
});

test("gate: a non-Claude or unbound record is never probed or logged", async () => {
  await withClosedSession("gate", async (fx) => {
    await seedPrefixLeftBehind(fx);
    const calls: string[] = [];
    const record = {
      cwd: CWD,
      acpSessionId: fx.id,
      agentCommand: "npx @agentclientprotocol/codex-acp",
      acpx: {},
    };
    const outcome = await reapTranscriptsAfterClose(provenClose(fx.recordId), {
      resolveRecord: async () => record as never,
      hasLeftBehind: async () => {
        calls.push("probe");
        return true;
      },
    });
    assert.equal(outcome, undefined);
    assert.deepEqual(calls, []);
    assert.equal(await ownerLog(fx), "");
  });
});

/** A process that stays alive until killed; `detached` makes it its own group leader. */
async function liveChild(detached: boolean): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached,
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return child;
}

test("pre-stop observation: a live verified owner is observed with its group-leader bit; a dead or unverified one is not", async () => {
  const leader = await liveChild(true);
  const member = await liveChild(false);
  try {
    const record = (pid: number) => {
      const identity = readProcessBirthIdentity(pid);
      return {
        pid,
        processIdentity: identity ? serializeProcessBirthIdentity(identity) : undefined,
      };
    };
    assert.equal(observeOwnerBeforeStop(record(leader.pid ?? 0))?.groupLeader, true);
    assert.equal(observeOwnerBeforeStop(record(member.pid ?? 0))?.groupLeader, false);
    assert.equal(observeOwnerBeforeStop(null), undefined);
    assert.equal(
      observeOwnerBeforeStop({ pid: leader.pid ?? 0, processIdentity: undefined }),
      undefined,
    );
    const stale = record(member.pid ?? 0);
    member.kill("SIGKILL");
    await new Promise((resolve) => member.once("exit", resolve));
    assert.equal(observeOwnerBeforeStop(stale), undefined, "a dead owner is not observed");
  } finally {
    leader.kill("SIGKILL");
    member.kill("SIGKILL");
  }
});

// --- through the REAL closeSession (no owner: idle-released earlier) ---------------------

test("P (closeSession): a no-owner close of a switched session removes its left-behind copy as the last step", async () => {
  await withClosedSession("real-close", async (fx) => {
    await seedPrefixLeftBehind(fx);
    const result = await closeSession(fx.recordId, { drain: false });
    assert.equal(result.recordClosedState.status, "read");
    assert.equal(await exists(fx.leftBehind), false);
    assert.equal(await exists(fx.active), true);
    assert.match(await ownerLog(fx), /deleted=1 .* trigger=session-close/);
    // The close's result carries no new field.
    assert.equal(Object.hasOwn(result, "transcriptReap"), false);
  });
});

test("N12 (closeSession): a no-owner close whose recorded adapter is a live process keeps the copy", async () => {
  const adapter = await liveChild(false);
  try {
    await withClosedSession(
      "real-adapter",
      async (fx) => {
        await seedPrefixLeftBehind(fx);
        const before = await sha256File(fx.leftBehind);
        await closeSession(fx.recordId, { drain: false });
        assert.equal(await sha256File(fx.leftBehind), before);
        assert.match(await ownerLog(fx), /skipped=adapter-alive trigger=session-close/);
      },
      { pid: adapter.pid },
    );
  } finally {
    adapter.kill("SIGKILL");
  }
});

test("N6 / N7: the step is reached only on the non-self arm, after every refusal and the read-back", async () => {
  // By construction: ONE call site, inside closeSession, after the self-arm's early return, after
  // the drain (whose refusal throws LiveBackgroundTasksDuringCloseError) and after the read-back.
  const source = await fs.readFile(
    path.join(REPO_ROOT, "src/cli/session/session-control.ts"),
    "utf8",
  );
  const calls = [...source.matchAll(/reapTranscriptsAfterClose\(/g)].map((m) => m.index ?? 0);
  assert.equal(calls.length, 1, "exactly one call site");
  const start = source.indexOf("export async function closeSession(");
  const end = source.indexOf("\n}\n", start);
  const inside = (needle: string) => {
    const index = source.indexOf(needle, start);
    assert.ok(index > start && index < end, `${needle} is inside closeSession`);
    return index;
  };
  assert.ok(calls[0] > start && calls[0] < end, "the call is inside closeSession");
  assert.ok(inside("return await closeSelfOwnedSession(") < calls[0], "after the self arm returns");
  assert.ok(inside("await drainCustodyBeforeClose(") < calls[0], "after the refusing drain");
  assert.ok(inside("await writeTerminalCloseRecord(") < calls[0], "after the write + read-back");
});
