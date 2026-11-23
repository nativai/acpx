import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import cluster from "node:cluster";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import inspector from "node:inspector";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judgeChild, type Judgement } from "../src/pod/verdict-child.js";
import { agentPodEnv, agentPodHome, runCli } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";

// Brick e8c77d5b — bar UDP, DNS and the raw native handles in the armed verdict child. The Node permission model of v22
// does not restrict any of them (v25 does), so on the boxes' runtime a child that sent a datagram or a name query was
// still RELAYED (K5 round 4 TE, C4); the first fix round's TE then reached the RAW handles (`dgram._createSocketHandle`,
// `net._createServerHandle`) and a socket made before the guards. These rows use the TE's ARRIVAL-COUNTING pattern:
// the parent holds a real UDP4 and UDP6 listener, a real UDP "DNS server" and a real TCP listener; an armed fixture
// child (armed exactly as the real one is, under the real flags, spawned the way `spawnVerdictChild` does) makes ONE
// attempt and then answers "not found" exit 4 as a well-behaved child would. Each row is judged by the tree's REAL
// `judgeChild`, and asserts the refusal's REASON is `network` (not merely "refused": a fixture that failed to arm
// for any other cause would also be refused), that NOTHING ARRIVED, and that the attempt did not run.
//
// EVERY row also runs its attempt UNARMED, on the same listeners: the arrival (or the ran marker) must be there, so a
// "nothing arrived" that no listener could ever have seen cannot pass. For the getaddrinfo rows (`dns.lookup`, …) no
// parent listener can see the system resolver, so the row's evidence is the REASON `network` plus the unarmed twin
// printing the ran marker — the second half is what makes the first one able to fail. The `net.connect` row aims at a
// TCP listener the connection WOULD reach.

const VERDICT_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/target-verdict.js", import.meta.url)),
).href;
const GUARDS_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/armed-guards.js", import.meta.url)),
).href;
const GHOST = "eeeeeeee-0000-4000-8000-0000000000ee";

type Counters = { udp: number; udp6: number; dnsQueries: number; tcp: number };
const NOTHING: Counters = { udp: 0, udp6: 0, dnsQueries: 0, tcp: 0 };

type Listeners = {
  ports: { udp: number; udp6: number; dns: number; tcp: number };
  counts: Counters;
  close: () => Promise<void>;
};

async function listen(): Promise<Listeners> {
  const counts: Counters = { ...NOTHING };
  const udp = dgram.createSocket("udp4");
  const udp6 = dgram.createSocket("udp6");
  const dnsServer = dgram.createSocket("udp4");
  const tcp = net.createServer((socket) => {
    counts.tcp += 1;
    socket.destroy();
  });
  udp.on("message", () => {
    counts.udp += 1;
  });
  udp6.on("message", () => {
    counts.udp6 += 1;
  });
  dnsServer.on("message", () => {
    counts.dnsQueries += 1;
  });
  await Promise.all([
    new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => udp6.bind(0, "::1", resolve)),
    new Promise<void>((resolve) => dnsServer.bind(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve)),
  ]);
  return {
    ports: {
      udp: udp.address().port,
      udp6: udp6.address().port,
      dns: dnsServer.address().port,
      tcp: (tcp.address() as net.AddressInfo).port,
    },
    counts,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => udp6.close(() => resolve())),
        new Promise<void>((resolve) => dnsServer.close(() => resolve())),
        new Promise<void>((resolve) => tcp.close(() => resolve())),
      ]);
    },
  };
}

/**
 * A fixture child: `pre` runs BEFORE the guards (a socket or handle made before they install), then it is armed exactly as
 * `cli.ts`'s `armedVerdictRun` arms the real one, makes ONE attempt (`ATTEMPT-RAN` is printed only if it did not throw),
 * and answers like a well-behaved child. It ends with `process.exit` so a socket the attempt opened cannot hold it up.
 */
function fixture(attempt: string, pre = ""): string {
  return `import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const UDP = Number(process.env.FIXTURE_UDP_PORT);
const UDP6 = Number(process.env.FIXTURE_UDP6_PORT);
const DNS = Number(process.env.FIXTURE_DNS_PORT);
const TCP = Number(process.env.FIXTURE_TCP_PORT);
const QUERY = Buffer.from("1234010000010000000000000765" + "78616d706c6500" + "00010001", "hex");
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
${pre}
const m = await import(${JSON.stringify(VERDICT_MODULE)});
const g = await import(${JSON.stringify(GUARDS_MODULE)});
if (g.isReadOnlyProcess()) {
  m.armTargetVerdict({ values: ["x"], kind: "not-found" });
  m.openSideChannel();
  g.installArmedGuards();
  process.on("exit", (code) => m.tellExit(code));
  m.tellParent("readonly");
}
try {
${attempt}
  process.stdout.write("ATTEMPT-RAN\\n");
} catch (error) {
  process.stdout.write("attempt threw: " + (error.code ?? error.message) + "\\n");
}
await settle();
process.stderr.write("Session not found: x\\n");
process.exit(4);
`;
}

type Rig = {
  judged: Judgement;
  status: number | null;
  stdout: string;
  stderr: string;
  counts: Counters;
  /** connections the parent made to a port the child printed as `LISTENING <port>` that were accepted */
  reachedChild: number;
};

const FLAGS = ["--permission", "--allow-fs-read=*"];

/** The child the way `spawnVerdictChild` starts it (real flags, NODE_OPTIONS removed, fd 3 side channel), async so the listeners keep counting. */
async function runFixture(source: string, armed: boolean): Promise<Rig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-"));
  const entry = path.join(dir, "child.mjs");
  await fs.writeFile(entry, source);
  const listeners = await listen();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    ACPX_ROUTED: "1",
    FIXTURE_UDP_PORT: String(listeners.ports.udp),
    FIXTURE_UDP6_PORT: String(listeners.ports.udp6),
    FIXTURE_DNS_PORT: String(listeners.ports.dns),
    FIXTURE_TCP_PORT: String(listeners.ports.tcp),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  let reachedChild = 0;
  try {
    const child = spawn(process.execPath, [...(armed ? FLAGS : []), entry], {
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let events = "";
    const probed = new Set<string>();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const match of stdout.matchAll(/LISTENING (\d+)/gu)) {
        const port = match[1] ?? "";
        if (!probed.has(port)) {
          probed.add(port);
          net
            .connect(Number(port), "127.0.0.1")
            .on("connect", function (this: net.Socket) {
              reachedChild += 1;
              this.destroy();
            })
            .on("error", () => undefined);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
      events += chunk.toString();
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const [status, signal] = await new Promise<[number | null, string | null]>((resolve) =>
      child.on("close", (code, sig) => resolve([code, sig])),
    );
    clearTimeout(killer);
    await new Promise((resolve) => setTimeout(resolve, 300)); // a late datagram is still a datagram
    return {
      judged: judgeChild({ status, signal, stdout, stderr, events }),
      status,
      stdout,
      stderr,
      counts: { ...listeners.counts },
      reachedChild,
    };
  } finally {
    await listeners.close();
  }
}

function arrivals(counts: Counters): number {
  return counts.udp + counts.udp6 + counts.dnsQueries + counts.tcp;
}

function assertBarred(rig: Rig, label: string): void {
  assert.deepEqual(rig.judged, { relay: false, why: "network" }, `${label}: ${rig.stderr}`);
  assert.deepEqual(rig.counts, NOTHING, `${label}: NOTHING may arrive`);
  assert.equal(rig.reachedChild, 0, `${label}: nothing may be reachable in the child`);
  assert.doesNotMatch(rig.stdout, /ATTEMPT-RAN/u, `${label}: the attempt must not have run`);
  assert.match(rig.stdout, /attempt threw: ERR_ACCESS_DENIED/u, label);
}

/** The same attempt with no barrier (the child is not read-only, so it never arms): it must reach the OS, or this row proves nothing. */
function assertWouldHaveRun(rig: Rig, label: string, expect: "arrives" | "runs"): void {
  assert.equal(rig.judged.relay, false, `${label}: an unarmed child is never relayed`);
  assert.doesNotMatch(rig.stdout, /ERR_ACCESS_DENIED/u, `${label}: unarmed twin was refused`);
  if (expect === "arrives") {
    assert.ok(
      arrivals(rig.counts) >= 1 || rig.reachedChild >= 1,
      `${label}: the unarmed twin must reach a listener (${JSON.stringify(rig.counts)})`,
    );
  } else {
    assert.match(rig.stdout, /ATTEMPT-RAN/u, `${label}: the unarmed twin must run the attempt`);
  }
}

type Route = {
  title: string;
  attempt: string;
  pre?: string;
  twin: "arrives" | "runs";
};

async function proveRoute(route: Route): Promise<Rig> {
  const barred = await runFixture(fixture(route.attempt, route.pre), true);
  assertBarred(barred, route.title);
  const open = await runFixture(fixture(route.attempt, route.pre), false);
  assertWouldHaveRun(open, route.title, route.twin);
  return open;
}

test("CONTROL: the same armed fixture with NO network attempt is relayed — the refusals below are the barrier's doing", async () => {
  const rig = await runFixture(fixture(""), true);
  assert.deepEqual(rig.judged.relay, true, rig.stderr);
  assert.equal(rig.status, 4);
  assert.match(rig.stderr, /Session not found: x/u);
  assert.deepEqual(rig.counts, NOTHING);
});

const send = (ctor: string, host: string, port: string): string =>
  `const s = ${ctor}; await new Promise((res, rej) => s.send("hi", ${port}, "${host}", (e) => (e ? rej(e) : res()))); s.close();`;

const UDP_ROUTES: Route[] = [
  {
    title: "dgram.createSocket + send",
    attempt: send('dgram.createSocket("udp4")', "127.0.0.1", "UDP"),
    twin: "arrives",
  },
  {
    title: "new dgram.Socket().send",
    attempt: send('new dgram.Socket("udp4")', "127.0.0.1", "UDP"),
    twin: "arrives",
  },
  {
    title: "dgram bind (opening a UDP socket)",
    attempt: `const s = dgram.createSocket("udp4"); await new Promise((res, rej) => { s.on("error", rej); s.bind(0, "127.0.0.1", res); }); s.close();`,
    twin: "runs",
  },
  {
    title: "dgram connect + send",
    attempt: `const s = dgram.createSocket("udp4"); await new Promise((res, rej) => { s.on("error", rej); s.connect(UDP, "127.0.0.1", res); }); s.send("hi"); await settle(); s.close();`,
    twin: "arrives",
  },
  {
    title: "udp6 socket send (to a real ::1 listener)",
    attempt: send('dgram.createSocket("udp6")', "::1", "UDP6"),
    twin: "arrives",
  },
  {
    // TE F1: a public (underscore) export that returns a BOUND native UDP handle; no Socket, no Socket.prototype.send
    title: "RAW HANDLE: dgram._createSocketHandle + handle.send (udp4)",
    attempt: `const h = dgram._createSocketHandle("127.0.0.1", 0, "udp4"); h.send({}, [Buffer.from("hi")], 1, UDP, "127.0.0.1", false);`,
    twin: "arrives",
  },
  {
    title: "RAW HANDLE: dgram._createSocketHandle + handle.send6 (udp6, to a real ::1 listener)",
    attempt: `const h = dgram._createSocketHandle("::1", 0, "udp6"); h.send6({}, [Buffer.from("hi")], 1, UDP6, "::1", false);`,
    twin: "arrives",
  },
  {
    title: "RAW HANDLE: handle.connect then handle.send",
    attempt: `const h = dgram._createSocketHandle("127.0.0.1", 0, "udp4"); h.connect("127.0.0.1", UDP); h.send({}, [Buffer.from("hi")], 1, false);`,
    twin: "arrives",
  },
  {
    title: "RAW HANDLE: through a createRequire copy of dgram",
    attempt: `const h = require("dgram")._createSocketHandle("127.0.0.1", 0, "udp4"); h.send({}, [Buffer.from("hi")], 1, UDP, "127.0.0.1", false);`,
    twin: "arrives",
  },
  {
    title: "RAW HANDLE: a hand-built DNS query packet to a DNS server",
    attempt: `const h = dgram._createSocketHandle("127.0.0.1", 0, "udp4"); h.send({}, [QUERY], 1, DNS, "127.0.0.1", false);`,
    twin: "arrives",
  },
  {
    // TE F3: a socket created BEFORE the guards. The real Socket.prototype must be barred, not only its replacement.
    title: "a socket created BEFORE the guards sends nothing after them",
    pre: `const pre = dgram.createSocket("udp4");`,
    attempt: `await new Promise((res, rej) => pre.send("hi", UDP, "127.0.0.1", (e) => (e ? rej(e) : res())));`,
    twin: "arrives",
  },
  {
    title: "a socket created BEFORE the guards: the real prototype's send, and sendto",
    pre: `const pre = dgram.createSocket("udp4");`,
    attempt: `Object.getPrototypeOf(pre).send.call(pre, "hi", UDP, "127.0.0.1"); pre.sendto("hi", 0, 2, UDP, "127.0.0.1");`,
    twin: "arrives",
  },
  {
    title: "a native UDP handle created BEFORE the guards sends nothing after them",
    pre: `const preHandle = dgram._createSocketHandle("127.0.0.1", 0, "udp4");`,
    attempt: `preHandle.send({}, [Buffer.from("hi")], 1, UDP, "127.0.0.1", false);`,
    twin: "arrives",
  },
];

for (const route of UDP_ROUTES) {
  test(`UDP — ${route.title}: barred (reason network), nothing arrives, and the unarmed twin DOES arrive`, async () => {
    await proveRoute(route);
  });
}

const TCP_ROUTES: Route[] = [
  {
    // the old "net.connect to localhost" row aimed at a port no TCP listener held: it could not fail
    title: "net.connect to a HOSTNAME (resolves first) aimed at a TCP listener",
    attempt: `await new Promise((res, rej) => { const s = net.connect(TCP, "localhost"); s.on("connect", () => { s.destroy(); res(); }); s.on("error", rej); });`,
    twin: "arrives",
  },
  {
    // TE F2: the TCP twin of the dgram hole — a bound native TCP handle without Server.prototype.listen
    title: "RAW HANDLE: net._createServerHandle + handle.listen",
    attempt: `const h = net._createServerHandle("127.0.0.1", 0, 4); const rc = h.listen(5); const a = {}; h.getsockname(a); process.stdout.write("LISTENING " + a.port + " rc=" + rc + "\\n");`,
    twin: "runs",
  },
  {
    title: "Server.prototype._listen2 on a new net.Server (listens without calling listen)",
    attempt: `const sv = new net.Server(); sv._listen2("127.0.0.1", 0, 4, 5); process.stdout.write("LISTENING " + sv.address().port + "\\n");`,
    twin: "runs",
  },
  {
    title: "net.Server.listen",
    attempt: `await new Promise((res, rej) => { const sv = net.createServer(); sv.on("error", rej); sv.listen(0, "127.0.0.1", () => { process.stdout.write("LISTENING " + sv.address().port + "\\n"); res(); }); });`,
    twin: "runs",
  },
  {
    title: "http.get to the TCP listener (resolves a hostname first)",
    attempt: `const http = require("http"); await new Promise((res, rej) => { const q = http.get({ host: "localhost", port: TCP }, () => res()); q.on("error", rej); });`,
    twin: "arrives",
  },
];

for (const route of TCP_ROUTES) {
  test(`TCP — ${route.title}: barred (reason network), nothing arrives or listens, and the unarmed twin does`, async () => {
    const open = await proveRoute(route);
    if (route.attempt.includes("LISTENING")) {
      assert.equal(
        open.reachedChild,
        1,
        "the unarmed twin's listener accepted the parent's connection",
      );
    }
  });
}

const DNS_ROUTES: Route[] = [
  {
    title: "dns.Resolver.resolve4 with a chosen server (callback)",
    attempt: `const r = new dns.Resolver({ timeout: 500, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => r.resolve4("atrium.example", () => res()));`,
    twin: "arrives",
  },
  {
    title: "dns.promises.Resolver.resolve4 with a chosen server",
    attempt: `const r = new dns.promises.Resolver({ timeout: 500, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); await r.resolve4("atrium.example").catch((e) => { if (e.code === "ERR_ACCESS_DENIED") throw e; });`,
    twin: "arrives",
  },
  {
    title: "dns.setServers + dns.resolve4 (the module-level resolver)",
    attempt: `dns.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => dns.resolve4("atrium.example", () => res()));`,
    twin: "arrives",
  },
  {
    title: "dns.resolveTxt / dns.resolveAny / dns.resolveMx through a chosen server",
    attempt: `const r = new dns.promises.Resolver({ timeout: 300, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); for (const f of ["resolveTxt", "resolveAny", "resolveMx"]) await r[f]("a.example").catch((e) => { if (e.code === "ERR_ACCESS_DENIED") throw e; });`,
    twin: "arrives",
  },
  {
    title: "dns.reverse through a chosen server",
    attempt: `dns.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => dns.reverse("10.99.99.99", () => res()));`,
    twin: "arrives",
  },
  {
    title:
      "dns.lookup (getaddrinfo, callback) — no listener can see it; the unarmed twin proves it runs",
    attempt: `await new Promise((res, rej) => dns.lookup("localhost", (e) => (e ? rej(e) : res())));`,
    twin: "runs",
  },
  {
    title: "dns.promises.lookup (getaddrinfo) — twin proves it runs",
    attempt: `await dns.promises.lookup("localhost");`,
    twin: "runs",
  },
  {
    title: "dns.lookupService (getnameinfo) — twin proves it runs",
    attempt: `await new Promise((res, rej) => dns.lookupService("127.0.0.1", 80, (e) => (e ? rej(e) : res())));`,
    twin: "runs",
  },
  {
    title: "dns.promises.lookupService — twin proves it runs",
    attempt: `await dns.promises.lookupService("127.0.0.1", 80);`,
    twin: "runs",
  },
];

for (const route of DNS_ROUTES) {
  test(`DNS — ${route.title}: barred (reason network), nothing arrives, and the unarmed twin does`, async () => {
    await proveRoute(route);
  });
}

// ---- the systematic part: every export that makes a native handle ---------------------------------------------

type Surface = { functions: string[]; objects: string[] };

/**
 * EVERY export of the ten modules, classified. A function export that constructs or exposes a native handle (the
 * `_create*Handle` family) is BARRED at the module (swapped for the refusal at install, DISCOVERED by name); the
 * classes' `listen`/`connect`/`bind`/`send` family is barred on the prototypes; `VIA_CLASS` exports reach the network
 * only through a barred class method (their rows are above); the rest is INERT: it sends nothing and opens nothing.
 * ⚠️ A NEW export on one of these modules (a Node upgrade) fails the "every export is classified" row below on
 * purpose: classify it here and, if it makes a handle or sends, bar it in `watchNetwork` (`src/pod/armed-guards.ts`).
 */
const DNS_QUERIES = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
];

const BARRED: Record<string, string[]> = {
  net: ["_createServerHandle"],
  dgram: ["_createSocketHandle", "createSocket", "Socket"],
  dns: DNS_QUERIES,
  "dns.promises": DNS_QUERIES,
  inspector: ["open"],
};

const VIA_CLASS: Record<string, string[]> = {
  net: ["connect", "createConnection", "createServer", "Server", "Socket"],
  tls: ["TLSSocket", "Server", "createServer", "connect", "createSecurePair"],
  http: ["Agent", "ClientRequest", "Server", "createServer", "get", "request", "WebSocket"],
  https: ["Agent", "Server", "createServer", "get", "request"],
  http2: ["connect", "createServer", "createSecureServer"],
};

const INERT: Record<string, Surface> = {
  net: {
    functions: [
      "_normalizeArgs",
      "_setSimultaneousAccepts",
      "BlockList",
      "SocketAddress",
      "isIP",
      "isIPv4",
      "isIPv6",
      "Stream",
      "getDefaultAutoSelectFamily",
      "setDefaultAutoSelectFamily",
      "getDefaultAutoSelectFamilyAttemptTimeout",
      "setDefaultAutoSelectFamilyAttemptTimeout",
    ],
    objects: [],
  },
  dgram: { functions: [], objects: [] },
  dns: {
    // setServers/getServers/Resolver send nothing: a Resolver only holds settings until it is asked to resolve
    functions: [
      "Resolver",
      "getDefaultResultOrder",
      "setDefaultResultOrder",
      "setServers",
      "getServers",
    ],
    objects: ["promises"],
  },
  "dns.promises": {
    functions: [
      "Resolver",
      "getDefaultResultOrder",
      "setDefaultResultOrder",
      "setServers",
      "getServers",
    ],
    objects: [],
  },
  tls: {
    functions: [
      "getCiphers",
      "getCACertificates",
      "setDefaultCACertificates",
      "convertALPNProtocols",
      "checkServerIdentity",
      "createSecureContext",
      "SecureContext",
    ],
    objects: ["rootCertificates"],
  },
  http: {
    functions: [
      "_connectionListener",
      "IncomingMessage",
      "OutgoingMessage",
      "ServerResponse",
      "validateHeaderName",
      "validateHeaderValue",
      "setMaxIdleHTTPParsers",
      "CloseEvent",
      "MessageEvent",
    ],
    objects: ["METHODS", "STATUS_CODES", "globalAgent"],
  },
  https: { functions: [], objects: ["globalAgent"] },
  http2: {
    functions: [
      "getDefaultSettings",
      "getPackedSettings",
      "getUnpackedSettings",
      "performServerHandshake",
      "Http2ServerRequest",
      "Http2ServerResponse",
    ],
    objects: ["constants"],
  },
  // `waitForDebugger`/`Session` are in-process (no socket); `close`/`url` read the inspector's state
  inspector: {
    functions: ["close", "url", "waitForDebugger", "Session"],
    objects: ["console", "Network", "NetworkResources"],
  },
  // `fork` starts a child process, which the permission model denies (a row below); the rest is bookkeeping
  cluster: {
    functions: ["Worker", "setupPrimary", "setupMaster", "fork", "disconnect"],
    objects: ["_events", "workers", "settings"],
  },
};

const MODULES: Record<string, object> = {
  net,
  dgram,
  dns,
  "dns.promises": dns.promises,
  tls,
  http,
  https,
  http2,
  inspector,
  cluster,
};

test("SYSTEMATIC: every function and object export of net, dgram, dns, dns.promises, tls, http, https, http2, inspector and cluster is classified — a NEW handle-making export fails here", () => {
  const unclassified: string[] = [];
  const handleMakers: string[] = [];
  let seen = 0;
  for (const [name, mod] of Object.entries(MODULES)) {
    const known = new Set([
      ...(BARRED[name] ?? []),
      ...(VIA_CLASS[name] ?? []),
      ...(INERT[name]?.functions ?? []),
      ...(INERT[name]?.objects ?? []),
    ]);
    for (const key of Object.keys(mod)) {
      const value = (mod as Record<string, unknown>)[key];
      if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
        continue; // a constant
      }
      seen += 1;
      if (!known.has(key)) {
        unclassified.push(`${name}.${key}`);
      }
      if (typeof value === "function" && key.endsWith("Handle") && !BARRED[name]?.includes(key)) {
        handleMakers.push(`${name}.${key}`);
      }
    }
  }
  assert.ok(seen >= 120, `positive control: enumerated ${seen} exports`);
  assert.deepEqual(unclassified, [], "classify the new export (see the comment above)");
  assert.deepEqual(handleMakers, [], "a handle-making export that is not in BARRED");
  // the other direction: nothing listed as barred is missing from this Node (a removed export needs the list trimmed, not a silent pass)
  for (const [name, names] of Object.entries(BARRED)) {
    const mod = MODULES[name] as Record<string, unknown>;
    assert.deepEqual(
      names.filter((n) => typeof mod[n] !== "function"),
      [],
      name,
    );
  }
});

const PROTOTYPE_BARS: Array<[string, string, string[]]> = [
  ["net", "Socket", ["connect"]],
  ["net", "Server", ["listen", "_listen2"]],
  ["tls", "TLSSocket", ["connect"]],
  ["tls", "Server", ["listen", "_listen2"]],
  ["http", "Server", ["listen", "_listen2"]],
  ["https", "Server", ["listen", "_listen2"]],
];

test("SYSTEMATIC, armed: every BARRED export is replaced at install, every class method listed is replaced on the REAL prototype, and internalBinding / process.binding / require of internals are unreachable", async () => {
  const pre = `const MODS = { net, dgram, dns, "dns.promises": dns.promises, inspector: (await import("node:inspector")).default };
const LISTED = ${JSON.stringify(BARRED)};
const before = {};
for (const [mod, names] of Object.entries(LISTED)) for (const n of names) before[mod + "." + n] = MODS[mod][n];
const CLASSES = ${JSON.stringify(PROTOTYPE_BARS)};
const protoOf = async (mod, cls) => (mod === "dgram" ? REAL : (await import("node:" + mod)).default[cls]).prototype;
const REAL = dgram.Socket;
const protoBefore = {};
for (const [mod, cls, methods] of CLASSES) for (const method of methods) protoBefore[mod + "." + cls + "." + method] = (await protoOf(mod, cls))[method];
for (const method of ["bind", "connect", "send", "sendto"]) protoBefore["dgram.Socket." + method] = REAL.prototype[method];`;
  const attempt = `const unchanged = [];
for (const [mod, names] of Object.entries(LISTED)) for (const n of names) if (MODS[mod][n] === before[mod + "." + n]) unchanged.push(mod + "." + n);
for (const [mod, cls, methods] of CLASSES) for (const method of methods) if ((await protoOf(mod, cls))[method] === protoBefore[mod + "." + cls + "." + method]) unchanged.push(mod + "." + cls + ".prototype." + method);
for (const method of ["bind", "connect", "send", "sendto"]) if (REAL.prototype[method] === protoBefore["dgram.Socket." + method]) unchanged.push("dgram.Socket(real).prototype." + method);
process.stdout.write("UNCHANGED " + JSON.stringify(unchanged) + "\\n");
process.stdout.write("internalBinding " + typeof internalBinding + "\\n");
for (const probe of ["process.binding('udp_wrap')", "process.binding('tcp_wrap')", "process.binding('cares_wrap')", "process.binding('http_parser')", "process._linkedBinding('udp_wrap')", "require('internal/test/binding')", "require('internal/dgram')"]) {
  try { new Function("require", "process", "return " + probe)(require, process); process.stdout.write("REACHED " + probe + "\\n"); }
  catch (e) { process.stdout.write("unreachable " + probe + " " + (e.code ?? e.message) + "\\n"); }
}`;
  const rig = await runFixture(fixture(attempt, pre), true);
  assert.match(rig.stdout, /UNCHANGED \[\]/u, rig.stdout + rig.stderr);
  assert.match(rig.stdout, /internalBinding undefined/u);
  assert.doesNotMatch(rig.stdout, /REACHED/u, rig.stdout);
  assert.equal((rig.stdout.match(/unreachable /gu) ?? []).length, 7, rig.stdout);
  assert.deepEqual(rig.counts, NOTHING);
});

test("cluster.fork in the armed child is denied by the runtime (it starts a child process) and nothing arrives", async () => {
  const rig = await runFixture(fixture(`const c = require("node:cluster"); c.fork();`), true);
  assert.match(rig.stdout, /attempt threw: ERR_ACCESS_DENIED/u, rig.stdout + rig.stderr);
  assert.doesNotMatch(rig.stdout, /ATTEMPT-RAN/u);
  assert.deepEqual(rig.judged, { relay: false, why: "denied" }, rig.stderr);
  assert.deepEqual(rig.counts, NOTHING);
});

// ---- end to end through the real CLI --------------------------------------------------------------------------

const FAST = { ACPX_CALL_HOME_BUDGET_MS: "20000" };

test("END TO END: an agent pod's real CLI refuses with the door's reason when the armed child sends a datagram through a raw handle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-e2e-"));
  const entry = path.join(dir, "child.mjs");
  await fs.writeFile(
    entry,
    fixture(
      `const h = dgram._createSocketHandle("127.0.0.1", 0, "udp4"); h.send({}, [Buffer.from("hi")], 1, UDP, "127.0.0.1", false);`,
    ),
  );
  const { home } = agentPodHome();
  const listeners = await listen();
  const atrium = await startRecordedAtrium({});
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_POD_VERDICT_CHILD_ENTRY: entry,
        FIXTURE_UDP_PORT: String(listeners.ports.udp),
        FIXTURE_UDP6_PORT: String(listeners.ports.udp6),
        FIXTURE_DNS_PORT: String(listeners.ports.dns),
        FIXTURE_TCP_PORT: String(listeners.ports.tcp),
      }),
      { cwd: home },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(run.status, 2, run.stderr);
    assert.match(
      run.stderr.split("\n")[0] ?? "",
      /^acpx: REFUSED reason=pass_through_refused .*detail=target-unresolved$/u,
    );
    assert.doesNotMatch(run.stdout + run.stderr, /Session not found/u);
    assert.deepEqual(listeners.counts, NOTHING);
    assert.equal(atrium.requests.length, 1, "only the parent's own call reached atrium");
  } finally {
    await atrium.close();
    await listeners.close();
  }
});

// ---- an UNARMED process is untouched ---------------------------------------------------------------------------

test("an ORDINARY process still uses dgram and dns: a datagram arrives, a Resolver query arrives, getaddrinfo resolves — the barrier exists only in the armed child", async () => {
  const listeners = await listen();
  try {
    const sender = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) =>
      sender.send("hi", listeners.ports.udp, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    sender.close();
    const resolver = new dns.promises.Resolver({ timeout: 300, tries: 1 });
    resolver.setServers([`127.0.0.1:${listeners.ports.dns}`]);
    await resolver.resolve4("atrium.example").catch(() => undefined);
    const looked = await dns.promises.lookup("localhost");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(listeners.counts.udp, 1, "the datagram arrived");
    assert.ok(listeners.counts.dnsQueries >= 1, "the DNS query arrived");
    assert.ok(looked.address.length > 0);
  } finally {
    await listeners.close();
  }
});

/** A preload that, at exit, reports which network functions of THIS process were replaced since start. */
const PRELOAD = `import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
const watched = {
  "dgram.createSocket": [dgram, "createSocket"], "dgram._createSocketHandle": [dgram, "_createSocketHandle"],
  "dgram.Socket": [dgram, "Socket"], "dgram.Socket.prototype.send": [dgram.Socket.prototype, "send"],
  "net._createServerHandle": [net, "_createServerHandle"], "net.Server.prototype._listen2": [net.Server.prototype, "_listen2"],
  "net.Server.prototype.listen": [net.Server.prototype, "listen"], "net.Socket.prototype.connect": [net.Socket.prototype, "connect"],
  "dns.lookup": [dns, "lookup"], "dns.resolve4": [dns, "resolve4"], "dns.promises.lookup": [dns.promises, "lookup"],
  "process.binding": [process, "binding"],
};
const original = Object.fromEntries(Object.entries(watched).map(([name, [target, key]]) => [name, target[key]]));
process.on("exit", () => {
  const replaced = Object.entries(watched).filter(([name, [target, key]]) => target[key] !== original[name]).map(([name]) => name);
  fs.writeFileSync(process.env.PRELOAD_REPORT, JSON.stringify({ replaced, checked: Object.keys(watched).length }));
});
`;

test("the REAL acpx CLI in an agent pod: its own process replaces no network function (the guards live only in the armed child), and the REAL armed child it spawns still answers (relayed 'not found')", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-real-"));
  const preload = path.join(dir, "preload.mjs");
  const report = path.join(dir, "report.json");
  await fs.writeFile(preload, PRELOAD);
  const { home } = agentPodHome();
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true }); // a real pod's home has its store
  const atrium = await startRecordedAtrium({});
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        PRELOAD_REPORT: report,
      }),
      { cwd: home },
    );
    // the real child (this very CLI under --permission, guards installed, NODE_OPTIONS removed) ran the lookup and ended 4
    assert.equal(run.status, 4, run.stderr);
    assert.match(run.stderr, /Session not found/u);
    const parsed = JSON.parse(await fs.readFile(report, "utf8")) as {
      replaced: string[];
      checked: number;
    };
    assert.equal(parsed.checked, 12, "positive control: the preload watched 12 functions");
    assert.deepEqual(parsed.replaced, []);
  } finally {
    await atrium.close();
  }
});

test("a plain process that loads the verdict module is not armed: the guards install only inside the armed child", async () => {
  // (the REAL-CLI row above is the one that runs the CLI; this one pins the module-level fact it rests on)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-plain-"));
  const probe = path.join(dir, "probe.mjs");
  await fs.writeFile(
    probe,
    `import dgram from "node:dgram";
import net from "node:net";
const m = await import(${JSON.stringify(VERDICT_MODULE)});
const s = dgram.createSocket("udp4");
process.stdout.write(JSON.stringify({ sendIsNative: !String(dgram.Socket.prototype.send).includes("refuse"), handleIsNative: !String(net._createServerHandle).includes("refuse"), armed: m.armedTargetVerdict() !== undefined }));
s.close();
`,
  );
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [probe]);
    let text = "";
    child.stdout?.on("data", (c: Buffer) => (text += c.toString()));
    child.on("close", () => resolve(text));
  });
  assert.deepEqual(JSON.parse(out), { sendIsNative: true, handleIsNative: true, armed: false });
});
