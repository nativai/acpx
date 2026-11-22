import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  startFakeBroker,
  wellFormedAgentRequest,
  wellFormedUtilityRequest,
} from "./pod-kit/fake-broker.js";
import type { BrokerScript, FakeBroker } from "./pod-kit/fake-broker.js";

// Self-test of the X1 fake broker (CONTRACTS-r4.md C4). Each test proves a shape the contract
// names, or that a scripted fault really happens on the wire — never only that the script was read.

const READY_LINE =
  /^ready ip=\d{1,3}(\.\d{1,3}){3} pod=ag-[0-9a-f]{24} uid=[0-9a-f-]{36} node=\S+ placement=(pool|home)$/;

interface Streamed {
  status: number;
  contentType: string | null;
  lines: string[];
  /** true: the body ended normally; false: the connection was cut. */
  clean: boolean;
}

async function postAgent(
  broker: FakeBroker,
  key: string,
  body: unknown,
  options: { stopAfterLines?: number; signal?: AbortSignal } = {},
): Promise<Streamed> {
  const response = await fetch(`${broker.url}/v1/agents/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
  const lines: string[] = [];
  let clean = true;
  let pending = "";
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      if (reader === undefined) {
        break;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (options.stopAfterLines !== undefined && lines.length >= options.stopAfterLines) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    clean = false;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    lines,
    clean,
  };
}

async function withBroker(script: BrokerScript, run: (broker: FakeBroker) => Promise<void>) {
  const broker = await startFakeBroker(script);
  try {
    await run(broker);
  } finally {
    await broker.close();
  }
}

async function getAgents(broker: FakeBroker): Promise<Record<string, unknown>> {
  const response = await fetch(`${broker.url}/v1/agents`);
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

test("POST streams the progress lines, then exactly one ready line, as text/plain", async () => {
  await withBroker({ default: { steps: ["scheduling", "starting"] } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-a");
    const answer = await postAgent(broker, key, body);
    assert.equal(answer.status, 200);
    assert.match(answer.contentType ?? "", /^text\/plain/);
    assert.equal(answer.clean, true);
    assert.deepEqual(answer.lines.slice(0, 2), ["scheduling", "starting"]);
    assert.equal(answer.lines.length, 3);
    assert.match(answer.lines[2] ?? "", READY_LINE);
    const [record] = broker.requestsFor("POST", key);
    assert.deepEqual(record?.problems, []);
    assert.deepEqual(record?.linesSent, answer.lines);
    assert.equal(record?.outcome, "final");
  });
});

test("the three final lines carry exactly the C4 fields", async () => {
  await withBroker(
    {
      keys: {},
      jobs: [
        {
          final: {
            ready: { ip: "10.1.2.3", pod: "ag-x", uid: "u-1", node: "n-1", placement: "home" },
          },
        },
        { final: { refused: { reason: "home_full", live: 4, cap: 4 } } },
        { final: { error: "start_failed" } },
        { final: { refused: { reason: "too_big", live: 0, cap: 100 } } },
      ],
    },
    async (broker) => {
      const finals: string[] = [];
      for (const id of ["s1", "s2", "s3", "s4"]) {
        const { key, body } = wellFormedAgentRequest(id);
        finals.push((await postAgent(broker, key, body)).lines.at(-1) ?? "");
      }
      assert.deepEqual(finals, [
        "ready ip=10.1.2.3 pod=ag-x uid=u-1 node=n-1 placement=home",
        "refused reason=home_full live=4 cap=4",
        "error start_failed",
        "refused reason=too_big live=0 cap=100",
      ]);
    },
  );
});

test("per-step delays really happen, and a line arrives before the next step's delay ends", async () => {
  await withBroker(
    {
      default: {
        steps: [{ line: "scheduling" }, { line: "starting", delayMs: 250 }],
        finalDelayMs: 150,
      },
    },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-delays");
      const started = Date.now();
      const response = await fetch(`${broker.url}/v1/agents/${key}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const reader = response.body?.getReader();
      assert.ok(reader);
      const first = await reader.read();
      const firstAt = Date.now() - started;
      assert.equal(new TextDecoder().decode(first.value), "scheduling\n");
      assert.ok(
        firstAt < 200,
        `first line must not wait for the later delays (took ${String(firstAt)} ms)`,
      );
      let rest = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        rest += new TextDecoder().decode(chunk.value);
      }
      const totalAt = Date.now() - started;
      assert.ok(
        totalAt >= 380,
        `step + final delays (250 + 150) must elapse (took ${String(totalAt)} ms)`,
      );
      assert.match(rest, /^starting\nready /);
    },
  );
});

test("a never-finishing stream sends its steps and then nothing, until DELETE ends it", async () => {
  await withBroker(
    { default: { steps: ["scheduling", "pulling"], hang: true } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-hang");
      const controller = new AbortController();
      const pending = postAgent(broker, key, body, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal((await getAgents(broker)).live, 1);
      const [record] = broker.requestsFor("POST", key);
      assert.deepEqual(record?.linesSent, ["scheduling", "pulling"]);
      assert.equal(
        record?.outcome,
        "pending",
        "400 ms later the stream is still open, with no final line",
      );
      const deleted = await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      const answer = await pending;
      assert.deepEqual(answer.lines, ["scheduling", "pulling", "error deleted"]);
      assert.equal(record?.outcome, "job_deleted");
      assert.equal((await getAgents(broker)).live, 0);
    },
  );
});

test("a dropped connection is cut mid-stream, and a second POST follows the SAME Job from its CURRENT phase", async () => {
  await withBroker(
    {
      default: {
        steps: [
          { line: "scheduling" },
          { line: "pulling", delayMs: 40 },
          { line: "starting", delayMs: 40 },
        ],
        finalDelayMs: 400,
        drop: { afterLines: 1 },
      },
    },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-drop");
      const first = await postAgent(broker, key, body);
      assert.equal(first.clean, false, "the first stream is cut, not ended");
      assert.ok(!first.lines.some((line) => line.startsWith("ready")));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await postAgent(broker, key, body);
      assert.equal(second.clean, true);
      assert.equal(
        second.lines.length,
        2,
        "a follower is told where the pod is NOW, not the history (F9)",
      );
      assert.equal(second.lines[0], "starting");
      assert.match(second.lines.at(-1) ?? "", READY_LINE);
      const posts = broker.requestsFor("POST", key);
      assert.equal(posts.length, 2);
      assert.equal(posts[0]?.joinedExistingJob, false);
      assert.equal(posts[1]?.joinedExistingJob, true);
      assert.equal(posts[1]?.jobSeq, posts[0]?.jobSeq);
      assert.equal(posts[0]?.outcome, "dropped");
      assert.equal((await getAgents(broker)).live, 1, "one Job, not two");
    },
  );
});

test("F9: a follower of a READY pod gets exactly one `ready` line", async () => {
  await withBroker(
    { default: { steps: ["scheduling", "pulling", "starting"] } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-follow-ready");
      const first = await postAgent(broker, key, body);
      assert.equal(first.lines.length, 4);
      const second = await postAgent(broker, key, body);
      assert.equal(second.lines.length, 1);
      assert.match(second.lines[0] ?? "", READY_LINE);
      assert.equal(second.lines[0], first.lines.at(-1), "the same pod, the same uid");
    },
  );
});

test("beforeHeaders resets the connection before any status line", async () => {
  await withBroker(
    { default: { drop: { afterLines: 0, beforeHeaders: true } } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-reset");
      await assert.rejects(postAgent(broker, key, body));
      assert.equal(broker.requestsFor("POST", key)[0]?.outcome, "dropped_before_headers");
    },
  );
});

test("an unknown contract version is refused by name and starts nothing", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-contract");
    const answer = await postAgent(broker, key, { ...body, contract: 2 });
    assert.deepEqual(answer.lines, ["error unsupported_contract"]);
    assert.equal((await getAgents(broker)).live, 0, "no Job was created");
    const missing = await postAgent(broker, key, { ...body, contract: undefined });
    assert.deepEqual(missing.lines, ["error unsupported_contract"]);
    const asString = await postAgent(broker, key, { ...body, contract: "1" });
    assert.deepEqual(
      asString.lines,
      ["error unsupported_contract"],
      "the string 1 is not the number 1",
    );
    assert.equal(broker.requestsFor("POST", key)[0]?.problems[0], "contract 2");
    // the contract is judged BEFORE the key and the fields (the real broker's order)
    const both = await postAgent(broker, "not-a-key", { ...body, contract: 2 });
    assert.deepEqual(both.lines, ["error unsupported_contract"]);
  });
});

test("F3: what the REAL broker refuses is `error invalid_request` and creates nothing", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-shape");
    const releases = { ...(body.releases as Record<string, string>) };
    const lessPiAcp = { ...releases };
    delete lessPiAcp["pi-acp"];
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ["unknown harness", key, { harness: "gemini" }, "unknown harness"],
      ["unknown placement", key, { placement: "cloud" }, "unknown placement"],
      ["unknown class", key, { class: "batch" }, "unknown class"],
      ["no seat", key, { seat: undefined }, "seat must be a string"],
      [
        "seat that is no label value",
        key,
        { seat: "has space/slash" },
        "seat must be a label value",
      ],
      ["seat too long", key, { seat: "a".repeat(64) }, "seat must be a label value"],
      [
        "sessionId with a bad character",
        key,
        { sessionId: "bad id" },
        "sessionId missing or invalid",
      ],
      [
        "key is not the session's",
        key,
        { sessionId: "another" },
        "key is not sha256(sessionId)[:24]",
      ],
      ["no releases", key, { releases: undefined }, "releases must be an object"],
      ["a required tool missing", key, { releases: lessPiAcp }, "releases.pi-acp missing"],
      [
        "a release key with a bad charset",
        key,
        { releases: { ...releases, "evil key!": "x" } },
        "releases.evil key! is not a release directory name",
      ],
      [
        "a release value with a bad charset",
        key,
        { releases: { ...releases, acpx: "../etc" } },
        "releases.acpx is not a release directory name",
      ],
      [
        "releases over 4096 bytes",
        key,
        {
          releases: {
            ...releases,
            "pi-extensions": "x".repeat(128),
            ...Object.fromEntries(
              Array.from({ length: 40 }, (_, i) => [`t${String(i)}`, "r".repeat(120)]),
            ),
          },
        },
        "releases too large",
      ],
      [
        "a key outside the key regex",
        "SESSION-KEY-UPPER",
        {},
        "key must be 24 lower-case hex characters, util-pool or util-home",
      ],
    ];
    for (const [name, atKey, overrides, reason] of cases) {
      const answer = await postAgent(broker, atKey, { ...body, ...overrides });
      assert.deepEqual(answer.lines, ["error invalid_request"], name);
      assert.deepEqual(broker.requests.at(-1)?.problems, [reason], name);
    }
    assert.equal((await getAgents(broker)).live, 0, "none of them created a Job");
    const notJson = await postAgent(broker, key, "{not json");
    assert.deepEqual(notJson.lines, ["error invalid_request"]);
    assert.deepEqual(broker.requests.at(-1)?.problems, ["body must be a JSON object"]);
    const big = await postAgent(
      broker,
      key,
      JSON.stringify({ ...body, sessionName: "x".repeat(70_000) }),
    );
    assert.deepEqual(big.lines, ["error invalid_request"], "a body over 64 KiB");
    assert.deepEqual(broker.requests.at(-1)?.problems, ["body too large"]);
    // and a well-formed one still works
    assert.match((await postAgent(broker, key, body)).lines.at(-1) ?? "", READY_LINE);
    assert.deepEqual(broker.requests.at(-1)?.problems, []);
  });
});

test("C9: only an optional tool (pi-extensions) may be left out of releases; a required one may not", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-releases");
    const releases = { ...(body.releases as Record<string, string>) };
    delete releases["pi-extensions"];
    assert.match(
      (await postAgent(broker, key, { ...body, releases })).lines.at(-1) ?? "",
      READY_LINE,
    );
    assert.deepEqual(broker.requests.at(-1)?.problems, [], "pi-extensions absent is no problem");
    await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
    delete releases["claude-agent-acp"];
    assert.deepEqual((await postAgent(broker, key, { ...body, releases })).lines, [
      "error invalid_request",
    ]);
    assert.deepEqual(broker.requests.at(-1)?.problems, ["releases.claude-agent-acp missing"]);
    const empty = await postAgent(broker, key, {
      ...body,
      releases: { ...(body.releases as object), "pi-extensions": "" },
    });
    assert.deepEqual(
      empty.lines,
      ["error invalid_request"],
      "a present value must be a release name",
    );
  });
});

test("C4 `error deleted`: a POST that was following the key when a DELETE ran ends with it; a POST after the DELETE gets a fresh Job", async () => {
  await withBroker({ default: { steps: ["scheduling"], finalDelayMs: 5_000 } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-deleted");
    const following = postAgent(broker, key, body);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await deleteAgent(broker, key)).status, 200);
    const answer = await following;
    assert.deepEqual(
      answer.lines,
      ["scheduling", "error deleted"],
      "the follower is told, not left hanging",
    );
    assert.equal(answer.clean, true);
    assert.ok(
      !answer.lines.some((line) => line.startsWith("ready")),
      "never re-created for the follower",
    );
    assert.equal((await getAgents(broker)).live, 0);
    broker.setScript({ default: { steps: ["scheduling"] } });
    const fresh = await postAgent(broker, key, body);
    assert.match(fresh.lines.at(-1) ?? "", READY_LINE, "recover = delete, then wake");
    const posts = broker.requestsFor("POST", key);
    assert.equal(posts[1]?.joinedExistingJob, false);
    assert.notEqual(posts[1]?.jobSeq, posts[0]?.jobSeq);
  });
});

test("F1: a POST that starts WHILE a DELETE of its key runs ends `error deleted` and creates no Job", async () => {
  await withBroker({ delete: { delayMs: 400 } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-terminating-post");
    await postAgent(broker, key, body);
    const jobsBefore = broker.requestsFor("POST", key).length;
    const deleting = deleteAgent(broker, key);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const started = Date.now();
    const during = await postAgent(broker, key, body);
    assert.deepEqual(during.lines, ["error deleted"]);
    assert.ok(Date.now() - started < 300, "it does not wait for the termination");
    assert.equal(
      broker.requestsFor("POST", key)[jobsBefore]?.jobSeq,
      null,
      "no Job was followed or created",
    );
    await deleting;
    assert.equal((await getAgents(broker)).live, 0);
    const after = await postAgent(broker, key, body);
    assert.match(
      after.lines.at(-1) ?? "",
      READY_LINE,
      "a POST started after the answer is a new request",
    );
  });
});

test("F1: a POST that began before a DELETE's answer is a follower and ends `error deleted` even if the pod never existed for it", async () => {
  await withBroker(
    { default: { steps: ["scheduling"], hang: true }, delete: { delayMs: 100 } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-follower-deleted");
      const controller = new AbortController();
      const creator = postAgent(broker, key, body, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const follower = postAgent(broker, key, body);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await deleteAgent(broker, key);
      assert.deepEqual((await follower).lines.slice(-1), ["error deleted"]);
      assert.deepEqual((await creator).lines.slice(-1), ["error deleted"]);
    },
  );
});

test("F2: a refused or failed POST is never replayed to the next one — admission is evaluated again, a Job is re-created with a new uid", async () => {
  await withBroker(
    {
      jobs: [{ final: { error: "start_failed" } }, { final: { error: "start_failed" } }],
      default: { steps: ["starting"] },
    },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-ended");
      const first = await postAgent(broker, key, body);
      assert.deepEqual(first.lines, ["error start_failed"]);
      const second = await postAgent(broker, key, body);
      assert.deepEqual(
        second.lines,
        ["error start_failed"],
        "the 2nd scripted Job, not a replay of the 1st",
      );
      const third = await postAgent(broker, key, body);
      assert.match(third.lines.at(-1) ?? "", READY_LINE, "the 3rd takes the default");
      const posts = broker.requestsFor("POST", key);
      assert.deepEqual(
        posts.map((entry) => entry.joinedExistingJob),
        [false, false, false],
      );
      assert.equal(new Set(posts.map((entry) => entry.jobSeq)).size, 3, "three Jobs");
    },
  );
  // admission refusal: room frees up, the very next POST gets in
  await withBroker({ status: { live: 99, cap: 100, reserve: 1 } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-room");
    const refused = await postAgent(broker, key, { ...body, class: "spawn" });
    assert.deepEqual(refused.lines, ["refused reason=agent_cap live=99 cap=100"]);
    broker.setScript({ status: { live: 3, cap: 100 } });
    assert.match(
      (await postAgent(broker, key, { ...body, class: "spawn" })).lines.at(-1) ?? "",
      READY_LINE,
    );
  });
});

test("F2: a pod that ended by itself is not followed — the next POST creates a NEW Job with a new uid", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-idle-exit");
    const first = (await postAgent(broker, key, body)).lines.at(-1) ?? "";
    assert.equal(broker.endPod(key), true);
    assert.equal((await getAgents(broker)).live, 0, "an ended pod holds no slot");
    const second = (await postAgent(broker, key, body)).lines.at(-1) ?? "";
    assert.match(second, READY_LINE);
    assert.notEqual(/uid=(\S+)/.exec(second)?.[1], /uid=(\S+)/.exec(first)?.[1], "a new uid");
    const posts = broker.requestsFor("POST", key);
    assert.equal(posts[1]?.joinedExistingJob, false);
    assert.equal(broker.endPod("no-such-key"), false);
  });
});

test("F10: cap, reserve, quota and home cap are applied in the real order; the real GET defaults", async () => {
  await withBroker({}, async (broker) => {
    const defaults = await getAgents(broker);
    assert.deepEqual(defaults, {
      live: 0,
      cap: 100,
      reserve: 1,
      quota: { used: 0, hard: 100 },
      home: { live: 0, cap: 0 },
      pool: { state: "ready" },
    });
    const ask = async (id: string, overrides: Record<string, unknown> = {}) => {
      const { key, body } = wellFormedAgentRequest(id, overrides);
      return (await postAgent(broker, key, body)).lines.at(-1) ?? "";
    };
    // home cap 0 (the real default): a home request is refused, auto goes to the pool
    assert.equal(
      await ask("s-home", { placement: "home" }),
      "refused reason=home_full live=0 cap=100",
    );
    assert.match(await ask("s-pool"), READY_LINE);
    broker.setScript({ status: { live: 99 } });
    assert.equal(
      await ask("s-spawn", { class: "spawn" }),
      "refused reason=agent_cap live=99 cap=100",
      "the reserve is the person's",
    );
    assert.match(
      await ask("s-person", { class: "interactive" }),
      READY_LINE,
      "interactive may use the reserve",
    );
    broker.setScript({ status: { live: 100 } });
    assert.equal(
      await ask("s-full", { class: "interactive" }),
      "refused reason=agent_cap live=100 cap=100",
    );
    broker.setScript({ status: { quota: { used: 5, hard: 5 } } });
    assert.match(await ask("s-quota"), /^refused reason=quota /);
    broker.setScript({ status: { quota: { used: 0, hard: 0 } } });
    assert.match(
      await ask("s-noquota"),
      /^refused reason=quota /,
      "a box without its quota starts no agent pod",
    );
    broker.setScript({ status: { home: { live: 0, cap: 2 } } });
    assert.match(await ask("s-home-ok", { placement: "home" }), /placement=home$/);
  });
});

test("F4: DELETE ?uid= with an EMPTY value is no uid — it deletes the key's Job unconditionally (the real `uid or None`)", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-empty-uid");
    await postAgent(broker, key, body);
    assert.equal((await getAgents(broker)).live, 1);
    const answer = await fetch(`${broker.url}/v1/agents/${key}?uid=`, { method: "DELETE" });
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), "", "not `refused reason=uid_mismatch`");
    assert.equal((await getAgents(broker)).live, 0, "the Job is gone");
    assert.equal(broker.requestsFor("DELETE", key)[0]?.outcome, "deleted");
  });
});

test("DELETE removes the Job; the next POST for the key creates a fresh one", async () => {
  await withBroker({ delete: { delayMs: 120 } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-delete");
    await postAgent(broker, key, body);
    assert.equal((await getAgents(broker)).live, 1);
    const started = Date.now();
    const deleted = await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.ok(Date.now() - started >= 100, "DELETE answers after the scripted delay");
    assert.equal((await getAgents(broker)).live, 0);
    await postAgent(broker, key, body);
    const posts = broker.requestsFor("POST", key);
    assert.equal(posts[1]?.joinedExistingJob, false);
    assert.notEqual(posts[1]?.jobSeq, posts[0]?.jobSeq);
    assert.equal(broker.requestsFor("DELETE", key)[0]?.outcome, "deleted");
  });
});

async function deleteAgent(broker: FakeBroker, key: string, uid?: string) {
  const query = uid === undefined ? "" : `?uid=${uid}`;
  const response = await fetch(`${broker.url}/v1/agents/${key}${query}`, { method: "DELETE" });
  return { status: response.status, text: await response.text() };
}

test("DELETE ?uid=: a wrong uid deletes nothing and answers 200 `refused reason=uid_mismatch`; the matching uid deletes", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-uid");
    const ready = (await postAgent(broker, key, body)).lines.at(-1) ?? "";
    const uid = /uid=(\S+)/.exec(ready)?.[1] ?? "";
    assert.match(uid, /^[0-9a-f-]{36}$/);
    const wrong = await deleteAgent(broker, key, "00000000-0000-4000-8000-000000000000");
    assert.deepEqual(wrong, { status: 200, text: "refused reason=uid_mismatch\n" });
    assert.equal((await getAgents(broker)).live, 1, "nothing was deleted");
    assert.equal(broker.requestsFor("DELETE", key)[0]?.outcome, "uid_mismatch");
    assert.equal(
      broker.requestsFor("DELETE", key)[0]?.query,
      "uid=00000000-0000-4000-8000-000000000000",
    );
    const joined = await postAgent(broker, key, body);
    assert.equal(
      broker.requestsFor("POST", key)[1]?.joinedExistingJob,
      true,
      "the Job is still there to follow",
    );
    assert.match(joined.lines.at(-1) ?? "", READY_LINE);
    const right = await deleteAgent(broker, key, uid);
    assert.deepEqual(right, { status: 200, text: "" });
    assert.equal((await getAgents(broker)).live, 0);
    assert.equal(broker.requestsFor("DELETE", key)[1]?.outcome, "deleted");
  });
});

test("DELETE ?uid= on a scripted uid, before the pod is ready, and with no uid at all", async () => {
  await withBroker(
    { default: { steps: ["scheduling"], hang: true, final: { ready: { uid: "scripted-uid-1" } } } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-uid2");
      const controller = new AbortController();
      const pending = postAgent(broker, key, body, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        (await deleteAgent(broker, key, "scripted-uid-1x")).text,
        "refused reason=uid_mismatch\n",
      );
      assert.equal((await deleteAgent(broker, key, "scripted-uid-1")).text, "");
      await pending;
      await postAgent(broker, key, body, { stopAfterLines: 1 });
      assert.equal((await deleteAgent(broker, key)).text, "", "no uid: deletes unconditionally");
    },
  );
});

test("DELETE ?uid= on a terminating pod: the matching uid still matches, a wrong one is still refused", async () => {
  await withBroker({ delete: { delayMs: 300 } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-terminating");
    const ready = (await postAgent(broker, key, body)).lines.at(-1) ?? "";
    const uid = /uid=(\S+)/.exec(ready)?.[1] ?? "";
    const first = deleteAgent(broker, key, uid);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const startedWrong = Date.now();
    assert.equal(
      (await deleteAgent(broker, key, "other-uid")).text,
      "refused reason=uid_mismatch\n",
    );
    assert.ok(Date.now() - startedWrong < 200, "a refusal does not wait for the termination");
    const second = await deleteAgent(broker, key, uid);
    assert.deepEqual(second, { status: 200, text: "" });
    assert.equal(broker.requestsFor("DELETE", key)[2]?.outcome, "deleted_terminating");
    assert.deepEqual(await first, { status: 200, text: "" });
  });
});

test("F14: a scripted DELETE failure carries the real body — 504 `error timeout`, 502 `error kube_api_error`", async () => {
  for (const [status, body] of [
    [504, "error timeout\n"],
    [502, "error kube_api_error\n"],
  ] as const) {
    await withBroker({ delete: { status } }, async (broker) => {
      const { key, body: request } = wellFormedAgentRequest("session-delete-fails");
      await postAgent(broker, key, request);
      assert.deepEqual(await deleteAgent(broker, key), { status, text: body });
      // the scripted failure is the answer of a DELETE that RAN: nothing there, or a uid refusal, is always 200
      assert.deepEqual(await deleteAgent(broker, "abcdef012345abcdef012345"), {
        status: 200,
        text: "",
      });
    });
  }
});

test("K-R2-3: `error timeout` ends the STREAM, not the Job — the next POST follows the same Job and uid, which still holds a slot", async () => {
  await withBroker(
    {
      jobs: [{ steps: ["pulling"], final: { error: "timeout" } }],
      default: { steps: ["starting"] },
    },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-timeout");
      const first = await postAgent(broker, key, body);
      assert.deepEqual(first.lines, ["pulling", "error timeout"]);
      assert.equal((await getAgents(broker)).live, 1, "the Job continues and keeps its slot");
      const second = await postAgent(broker, key, body);
      assert.equal(broker.requestsFor("POST", key)[1]?.joinedExistingJob, true);
      assert.equal(
        broker.requestsFor("POST", key)[1]?.jobSeq,
        broker.requestsFor("POST", key)[0]?.jobSeq,
        "the same Job",
      );
      assert.equal(second.lines.at(-1), "error timeout");
    },
  );
  // the contrast: a failed start IS an ended Job — the next POST is a new request
  await withBroker({ jobs: [{ final: { error: "start_failed" } }] }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-failed");
    await postAgent(broker, key, body);
    assert.equal((await getAgents(broker)).live, 0);
  });
});

test("K-R2-4: `ready` prints the placement the Job was ROUTED to — an `auto` request with the pool not ready goes home, and home.live counts it", async () => {
  await withBroker(
    { status: { pool: { state: "no-template" }, home: { cap: 2 } } },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-auto-home", { placement: "auto" });
      const ready = (await postAgent(broker, key, body)).lines.at(-1) ?? "";
      assert.match(ready, /placement=home$/);
      assert.deepEqual((await getAgents(broker)).home, { live: 1, cap: 2 });
    },
  );
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-auto-pool", { placement: "auto" });
    assert.match((await postAgent(broker, key, body)).lines.at(-1) ?? "", /placement=pool$/);
  });
});

test("K-R2-8: an explicit pool request while the pool is not usable is `error template_rejected`; a utility request may send null seat / sessionId", async () => {
  await withBroker({ status: { pool: { state: "no-template" } } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-pool-rejected", { placement: "pool" });
    assert.deepEqual((await postAgent(broker, key, body)).lines, ["error template_rejected"]);
    assert.equal((await getAgents(broker)).live, 0);
  });
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedUtilityRequest("pool", { seat: null, sessionId: null });
    assert.match((await postAgent(broker, key, body)).lines.at(-1) ?? "", /^ready /);
    assert.deepEqual(broker.requests.at(-1)?.problems, []);
  });
});

test("DELETE of a key with no pod answers 200 with an empty body, with or without a uid", async () => {
  await withBroker({}, async (broker) => {
    assert.deepEqual(await deleteAgent(broker, "abcdef012345abcdef012345"), {
      status: 200,
      text: "",
    });
    assert.deepEqual(await deleteAgent(broker, "abcdef012345abcdef012345", "some-uid"), {
      status: 200,
      text: "",
    });
  });
});

test("a utility request carries no seat and no sessionId; the real broker's utility rules are enforced", async () => {
  await withBroker({}, async (broker) => {
    for (const placement of ["pool", "home"] as const) {
      const { key, body } = wellFormedUtilityRequest(placement);
      assert.equal(key, `util-${placement}`);
      broker.setScript({ status: { home: { live: 0, cap: 2 } } });
      const answer = await postAgent(broker, key, body);
      assert.match(answer.lines.at(-1) ?? "", /^ready /);
      assert.deepEqual(broker.requests.at(-1)?.problems, [], `utility ${placement}`);
    }
    const { key, body } = wellFormedUtilityRequest("pool");
    await deleteAgent(broker, key);
    // a sent seat is ignored by the real broker (flagged by the kit, not refused)
    assert.match(
      (await postAgent(broker, key, { ...body, seat: "seat-0001" })).lines.at(-1) ?? "",
      /^ready /,
    );
    assert.deepEqual(broker.requests.at(-1)?.problems, ["field_present:seat"]);
    await deleteAgent(broker, key);
    // a sessionId on a utility request is refused
    assert.deepEqual((await postAgent(broker, key, { ...body, sessionId: "s-1" })).lines, [
      "error invalid_request",
    ]);
    // util-pool with placement home is refused
    assert.deepEqual((await postAgent(broker, key, { ...body, placement: "home" })).lines, [
      "error invalid_request",
    ]);
    assert.deepEqual(broker.requests.at(-1)?.problems, [
      "a utility key takes harness utility, no sessionId and its own placement",
    ]);
    // a utility key with another harness is refused
    assert.deepEqual((await postAgent(broker, key, { ...body, harness: "claude" })).lines, [
      "error invalid_request",
    ]);
    // an ordinary request still needs both
    const agent = wellFormedAgentRequest("session-needs-both");
    assert.deepEqual(
      (await postAgent(broker, agent.key, { ...agent.body, seat: undefined })).lines,
      ["error invalid_request"],
    );
    assert.deepEqual(
      (await postAgent(broker, agent.key, { ...agent.body, sessionId: undefined })).lines,
      ["error invalid_request"],
    );
  });
});

test("GET /v1/agents answers the C4 shape, derived from the Jobs unless scripted", async () => {
  await withBroker({ status: { home: { live: 0, cap: 10 } } }, async (broker) => {
    const shape = await getAgents(broker);
    assert.deepEqual(Object.keys(shape).toSorted(), [
      "cap",
      "home",
      "live",
      "pool",
      "quota",
      "reserve",
    ]);
    const { key, body } = wellFormedAgentRequest("session-status");
    await postAgent(broker, key, { ...body, placement: "home" });
    const after = await getAgents(broker);
    assert.equal(after.live, 1);
    assert.deepEqual(after.quota, { used: 1, hard: 100 });
    assert.equal((after.home as { cap: number }).cap, 10);
    broker.setScript({
      status: {
        live: 7,
        cap: 8,
        reserve: 1,
        quota: { used: 7, hard: 8 },
        pool: { state: "at-maximum" },
      },
    });
    const scripted = await getAgents(broker);
    assert.equal(scripted.live, 7);
    assert.deepEqual(scripted.pool, { state: "at-maximum" });
  });
});

test("scripted answers: per-key wins over the ordered list, which wins over the default", async () => {
  await withBroker(
    {
      keys: { [wellFormedAgentRequest("by-key").key]: { final: { error: "template_rejected" } } },
      jobs: [{ final: { error: "start_failed" } }],
      default: { final: { refused: { reason: "quota", live: 9, cap: 9 } } },
    },
    async (broker) => {
      const byKey = wellFormedAgentRequest("by-key");
      const first = wellFormedAgentRequest("first");
      const second = wellFormedAgentRequest("second");
      assert.deepEqual((await postAgent(broker, byKey.key, byKey.body)).lines, [
        "error template_rejected",
      ]);
      assert.deepEqual((await postAgent(broker, first.key, first.body)).lines, [
        "error start_failed",
      ]);
      assert.deepEqual((await postAgent(broker, second.key, second.body)).lines, [
        "refused reason=quota live=9 cap=9",
      ]);
    },
  );
});

test("respond answers the POST with a plain HTTP failure, no stream", async () => {
  await withBroker({ default: { respond: { status: 503, body: "busy" } } }, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-503");
    const answer = await postAgent(broker, key, body);
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.lines, []);
    assert.equal(broker.requests[0]?.outcome, "respond_503");
  });
});

test("an unknown path is 404 and a wrong method is 405", async () => {
  await withBroker({}, async (broker) => {
    assert.equal((await fetch(`${broker.url}/v1/workbenches/x`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${broker.url}/v1/agents/abc`)).status, 405);
    assert.equal((await fetch(`${broker.url}/v1/agents`, { method: "POST" })).status, 405);
  });
});

test("after close() the port refuses connections", async () => {
  const broker = await startFakeBroker({});
  const url = broker.url;
  await broker.close();
  await assert.rejects(fetch(`${url}/v1/agents`));
});

test("run as a process from its TypeScript source: prints its port, honours --script, serves C4", async () => {
  const source = fileURLToPath(new URL("../../test/pod-kit/fake-broker.ts", import.meta.url));
  const script = JSON.stringify({
    default: { steps: ["scheduling"], final: { error: "start_failed" } },
  });
  const child = spawn(process.execPath, [source, "--port", "0", "--script", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const firstLine = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) {
          resolve(text.slice(0, text.indexOf("\n")));
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`fake broker exited early rc=${String(code)}`)),
      );
    });
    const announced = JSON.parse(firstLine) as { fake: string; port: number };
    assert.equal(announced.fake, "broker");
    assert.ok(announced.port > 0);
    const { key, body } = wellFormedAgentRequest("session-process");
    const response = await fetch(`http://127.0.0.1:${String(announced.port)}/v1/agents/${key}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(await response.text(), "scheduling\nerror start_failed\n");
    const record = (await (
      await fetch(`http://127.0.0.1:${String(announced.port)}/_kit/record`)
    ).json()) as {
      requests: Array<{ method: string; key: string }>;
    };
    assert.deepEqual(
      record.requests.map((entry) => [entry.method, entry.key]),
      [["POST", key]],
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
