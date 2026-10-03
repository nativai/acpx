import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withSeatStoreWrite, type SeatRecord } from "../src/session/persistence.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick c85c42bf (HOD-R46 (b)) — `sessions activate` DELIVERS its ⟦SEAT-ACTIVATION⟧ notice to
// the successor instead of only printing it (AC6: "a succession costs one command and no
// follow-up"). Every row drives the real compiled CLI against a LOCAL STUB HTTP server on an
// ephemeral port — never 3456, never a real session. The stub is addressed through
// ACPX_UI_INTERNAL_URL, the same seam the suite bootstrap (test/box-env-scrub.ts) points at a
// dead port so no row can reach the box's real acpx-ui by accident.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const SEAT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ACTIVATOR_ID = "cccccccc-2222-4222-8222-cccccccccccc";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string, extraEnv: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type StubRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Stub = { url: string; requests: StubRequest[]; close: () => Promise<void> };

/** `respond` undefined ⇒ the stub accepts the request and never answers (the timeout arm). */
async function startStub(respond: { status: number; body: string } | undefined): Promise<Stub> {
  const requests: StubRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (respond) {
        res.writeHead(respond.status, { "content-type": "application/json" });
        res.end(respond.body);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

async function withRig(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-notice-delivery-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seat = (id: string, over: Record<string, unknown>) =>
      writeSessionRecordFile(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: `${id}-acp`,
          agentCommand: "node mock",
          agentName: "claude",
          cwd,
          seatId: SEAT_A,
          ...over,
        }),
      );
    await seat("holder-one", { holderActive: true, holderOrdinal: 1 });
    await seat("holder-two", { holderActive: false });
    const row: SeatRecord = {
      seatId: SEAT_A,
      createdAt: "2026-10-03T00:00:00.000Z",
      activeHolderId: "holder-one",
      nextOrdinal: 2,
      closedAt: null,
      name: "the seat",
      brickId: undefined,
      favorite: false,
    };
    await withSeatStoreWrite(path.join(homeDir, ".acpx", "sessions"), (store) => {
      const seats = new Map(store.seats);
      seats.set(row.seatId, row);
      return { mutation: { kind: "write", seats }, result: undefined };
    });
    await run(homeDir);
  });
}

function activate(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  extra: string[] = [],
  format: "text" | "json" = "json",
): Promise<CliResult> {
  return runCli(
    [
      "--agent",
      MOCK_AGENT_COMMAND,
      "--format",
      format,
      "sessions",
      "activate",
      SEAT_A,
      "holder-two",
      ...extra,
    ],
    homeDir,
    env,
  );
}

async function holderActive(homeDir: string, id: string): Promise<unknown> {
  const stored = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${id}.json`), "utf8"),
  ) as { holder_active?: unknown };
  return stored.holder_active;
}

type Delivery = { delivered?: unknown; deliveryId?: unknown; reason?: unknown };

function deliveryOf(result: CliResult): Delivery {
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.ok(
    Object.hasOwn(payload, "activationNoticeDelivery"),
    `no activationNoticeDelivery key: ${result.stdout}`,
  );
  return payload.activationNoticeDelivery as Delivery;
}

test("ND1 · DELIVERED (TEXT): the notice is POSTed to the successor's message route, and the output says so with the delivery id", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: JSON.stringify({ delivery_id: "dlv-77" }) });
    try {
      const result = await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url }, [], "text");
      assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
      assert.equal(stub.requests.length, 1, "exactly one delivery");
      const [request] = stub.requests;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/sessions/holder-two/message");
      const body = JSON.parse(request.body) as { text?: string; from?: string };
      assert.ok(body.text?.startsWith("⟦SEAT-ACTIVATION⟧"), `body: ${request.body}`);
      assert.equal(body.from, "acpx:sessions-activate");
      assert.ok(
        result.stdout.includes("notice delivered to holder-two (delivery dlv-77)"),
        result.stdout,
      );
      assert.doesNotMatch(result.stdout, /NOT delivered/);
      // The predecessor's duty lines are unchanged: the notice is the SUCCESSOR's, the duty the operator's.
      assert.match(result.stdout, /YOUR DUTY — close it yourself/);
      assert.match(result.stdout, /acpx sessions close --session-id holder-one/);
    } finally {
      await stub.close();
    }
  });
});

test("ND2 · DELIVERED (JSON): activationNoticeDelivery is {delivered:true, deliveryId}, and `from` is the activator's own session id when ACPX_SESSION_URL is set", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: JSON.stringify({ delivery_id: "dlv-78" }) });
    try {
      const result = await activate(homeDir, {
        ACPX_UI_INTERNAL_URL: stub.url,
        ACPX_SESSION_URL: `https://ui.example.test/?session=${ACTIVATOR_ID}`,
      });
      assert.deepEqual(deliveryOf(result), { delivered: true, deliveryId: "dlv-78" });
      assert.equal((JSON.parse(stub.requests[0].body) as { from?: string }).from, ACTIVATOR_ID);
    } finally {
      await stub.close();
    }
  });
});

test("ND3 · NON-2xx: the activation still succeeds (rc 0), the notice is PRINTED as today, plus the not-delivered line; JSON names the status", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 409, body: '{"error":{"code":"SESSION_CLOSED"}}' });
    try {
      const text = await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url }, [], "text");
      assert.equal(text.code, 0, `${text.stderr}${text.stdout}`);
      assert.match(text.stdout, /--- notice for the successor ---\n⟦SEAT-ACTIVATION⟧/);
      assert.ok(
        text.stdout.includes("notice NOT delivered — paste it to the successor"),
        text.stdout,
      );
      assert.doesNotMatch(text.stdout, /notice delivered to/);
      assert.equal(await holderActive(homeDir, "holder-two"), true, "the activation itself landed");
    } finally {
      await stub.close();
    }
  });
});

test("ND4 · NON-2xx (JSON): {delivered:false, reason} carries the HTTP status — never silent", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 500, body: "boom" });
    try {
      const delivery = deliveryOf(await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url }));
      assert.equal(delivery.delivered, false);
      assert.match(String(delivery.reason), /500/);
      assert.equal(Object.hasOwn(delivery, "deliveryId"), false);
    } finally {
      await stub.close();
    }
  });
});

test("ND5 · UNREACHABLE: a refused connection prints the notice plus the not-delivered line, rc stays 0", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: "{}" });
    const deadUrl = stub.url;
    await stub.close();
    const text = await activate(homeDir, { ACPX_UI_INTERNAL_URL: deadUrl }, [], "text");
    assert.equal(text.code, 0, `${text.stderr}${text.stdout}`);
    assert.match(text.stdout, /--- notice for the successor ---\n⟦SEAT-ACTIVATION⟧/);
    assert.ok(
      text.stdout.includes("notice NOT delivered — paste it to the successor"),
      text.stdout,
    );
    assert.equal(await holderActive(homeDir, "holder-two"), true);
    const delivery = deliveryOf(await activate(homeDir, { ACPX_UI_INTERNAL_URL: deadUrl }));
    // Second activation is a no-op (already active); the shape is still present and honest.
    assert.equal(delivery.delivered, false);
    assert.equal(typeof delivery.reason, "string");
  });
});

test("ND6 · NO BASE URL: an empty ACPX_UI_INTERNAL_URL means nothing to deliver to — printed as today plus the not-delivered line, rc 0", async () => {
  await withRig(async (homeDir) => {
    const delivery = deliveryOf(await activate(homeDir, { ACPX_UI_INTERNAL_URL: "" }));
    assert.equal(delivery.delivered, false);
    assert.match(String(delivery.reason), /base url/i);
  });
});

test("ND7 · TIMEOUT: a server that accepts and never answers is abandoned after 10 s — notice printed, not-delivered line, rc 0", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub(undefined);
    try {
      const started = Date.now();
      const text = await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url }, [], "text");
      const elapsed = Date.now() - started;
      assert.equal(text.code, 0, `${text.stderr}${text.stdout}`);
      assert.ok(text.stdout.includes("notice NOT delivered — paste it to the successor"));
      assert.ok(elapsed >= 9_500, `gave up after ${elapsed} ms — the bound is 10 s`);
      assert.equal(stub.requests.length, 1, "the request did reach the stub");
    } finally {
      await stub.close();
    }
  });
});

test("ND8 · --no-notify: nothing is sent, the notice prints as today with no delivered/NOT-delivered line, JSON says why", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: JSON.stringify({ delivery_id: "dlv-x" }) });
    try {
      const text = await activate(
        homeDir,
        { ACPX_UI_INTERNAL_URL: stub.url },
        ["--no-notify"],
        "text",
      );
      assert.equal(text.code, 0, `${text.stderr}${text.stdout}`);
      assert.match(text.stdout, /--- notice for the successor ---\n⟦SEAT-ACTIVATION⟧/);
      assert.doesNotMatch(text.stdout, /notice delivered to|NOT delivered/);
      assert.equal(stub.requests.length, 0, "--no-notify must send nothing");
    } finally {
      await stub.close();
    }
  });
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: "{}" });
    try {
      const delivery = deliveryOf(
        await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url }, ["--no-notify"]),
      );
      assert.equal(delivery.delivered, false);
      assert.match(String(delivery.reason), /no-notify/);
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
});

test("ND9 · a re-run of an already-completed activation writes nothing and therefore re-sends nothing", async () => {
  await withRig(async (homeDir) => {
    const stub = await startStub({ status: 200, body: JSON.stringify({ delivery_id: "dlv-1" }) });
    try {
      await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url });
      assert.equal(stub.requests.length, 1);
      const again = await activate(homeDir, { ACPX_UI_INTERNAL_URL: stub.url });
      assert.equal(again.code, 0, `${again.stderr}${again.stdout}`);
      assert.equal(stub.requests.length, 1, "the no-op re-run delivered a second notice");
    } finally {
      await stub.close();
    }
  });
});
