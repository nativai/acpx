import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeBroker, wellFormedAgentRequest } from "./pod-kit/fake-broker.js";
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
      assert.deepEqual(answer.lines, ["scheduling", "pulling"]);
      assert.equal(record?.outcome, "job_deleted");
      assert.equal((await getAgents(broker)).live, 0);
    },
  );
});

test("a dropped connection is cut mid-stream, and a second POST follows the SAME Job", async () => {
  await withBroker(
    {
      default: {
        steps: [{ line: "scheduling" }, { line: "starting", delayMs: 100 }],
        finalDelayMs: 200,
        drop: { afterLines: 1 },
      },
    },
    async (broker) => {
      const { key, body } = wellFormedAgentRequest("session-drop");
      const first = await postAgent(broker, key, body);
      assert.equal(first.clean, false, "the first stream is cut, not ended");
      assert.ok(!first.lines.some((line) => line.startsWith("ready")));
      const second = await postAgent(broker, key, body);
      assert.equal(second.clean, true);
      assert.deepEqual(
        second.lines.slice(0, 2),
        ["scheduling", "starting"],
        "the second POST gets the whole history",
      );
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
    assert.ok(broker.requestsFor("POST", key)[1]?.problems.includes("contract_missing"));
    assert.deepEqual(
      broker.requestsFor("POST", key)[0]?.problems,
      [],
      "contract 2 is a scripted case, not a malformed request",
    );
  });
});

test("departures from C4's request shape are recorded by name, never silently accepted", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-shape");
    const releases = { ...(body.releases as Record<string, string>) };
    delete releases["pi-acp"];
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["unknown harness", { harness: "gemini" }, "field_invalid:harness"],
      ["unknown placement", { placement: "cloud" }, "field_invalid:placement"],
      ["unknown class", { class: "batch" }, "field_invalid:class"],
      ["no seat", { seat: undefined }, "field_missing:seat"],
      ["no releases", { releases: undefined }, "field_missing:releases"],
      ["one tool short in releases", { releases }, "releases_missing:pi-acp"],
      ["key is not the session's", { sessionId: "another" }, "key_mismatch"],
    ];
    for (const [name, overrides, problem] of cases) {
      await postAgent(broker, key, { ...body, ...overrides });
      const last = broker.requests.at(-1);
      assert.ok(
        last?.problems.includes(problem),
        `${name}: expected ${problem}, got ${JSON.stringify(last?.problems)}`,
      );
      await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
    }
    const answer = await postAgent(broker, key, "{not json");
    assert.deepEqual(answer.lines, ["error invalid_request"]);
    assert.deepEqual(broker.requests.at(-1)?.problems, ["invalid_json"]);
  });
});

test("C9: only an optional tool (pi-extensions) may be left out of releases; a required one may not", async () => {
  await withBroker({}, async (broker) => {
    const { key, body } = wellFormedAgentRequest("session-releases");
    const releases = { ...(body.releases as Record<string, string>) };
    delete releases["pi-extensions"];
    await postAgent(broker, key, { ...body, releases });
    assert.deepEqual(broker.requests.at(-1)?.problems, [], "pi-extensions absent is no problem");
    await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
    delete releases["claude-agent-acp"];
    await postAgent(broker, key, { ...body, releases });
    assert.deepEqual(broker.requests.at(-1)?.problems, ["releases_missing:claude-agent-acp"]);
    await fetch(`${broker.url}/v1/agents/${key}`, { method: "DELETE" });
    await postAgent(broker, key, {
      ...body,
      releases: { ...(body.releases as object), "pi-extensions": "" },
    });
    assert.deepEqual(broker.requests.at(-1)?.problems, ["releases_invalid:pi-extensions"]);
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

test("GET /v1/agents answers the C4 shape, derived from the Jobs unless scripted", async () => {
  await withBroker({}, async (broker) => {
    const shape = await getAgents(broker);
    assert.deepEqual(Object.keys(shape).toSorted(), [
      "cap",
      "home",
      "live",
      "pool",
      "quota",
      "reserve",
    ]);
    assert.deepEqual(shape.quota, { used: 0, hard: 100 });
    const { key, body } = wellFormedAgentRequest("session-status");
    await postAgent(broker, key, { ...body, placement: "home" });
    const after = await getAgents(broker);
    assert.equal(after.live, 1);
    assert.deepEqual(after.home, { live: 1, cap: 10 });
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
