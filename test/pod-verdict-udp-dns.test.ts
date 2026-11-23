import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentPodEnv, agentPodHome, runCli, type ChildRun } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";

// Brick e8c77d5b — bar UDP and DNS in the armed verdict child. The Node permission model of v22 does not restrict
// either (v25 does), so on the boxes' runtime a child that sent a datagram or a name query was still RELAYED
// (K5 round 4 TE, C4). These rows use the TE's ARRIVAL-COUNTING pattern: the parent holds a real UDP listener and a
// real UDP "DNS server"; an armed fixture child (armed exactly as the real one is) tries ONE route and then answers
// "not found" exit 4 as a well-behaved child would; each row asserts the door's refusal AND that NOTHING ARRIVED.
// A fixture that does not arm is judged `not-confirmed-read-only`, so every row also has its CONTROL: the same fixture
// with no attempt is RELAYED — the refusals are the barrier's doing, not the fixture's.

const GHOST = "eeeeeeee-0000-4000-8000-0000000000ee";
const FAST = { ACPX_CALL_HOME_BUDGET_MS: "20000" };
const VERDICT_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/target-verdict.js", import.meta.url)),
).href;
const GUARDS_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/armed-guards.js", import.meta.url)),
).href;

type Counters = { udp: number; dnsQueries: number };

type Listeners = {
  udpPort: number;
  dnsPort: number;
  counts: Counters;
  close: () => Promise<void>;
};

async function listen(): Promise<Listeners> {
  const counts: Counters = { udp: 0, dnsQueries: 0 };
  const udp = dgram.createSocket("udp4");
  const dnsServer = dgram.createSocket("udp4");
  udp.on("message", () => {
    counts.udp += 1;
  });
  dnsServer.on("message", () => {
    counts.dnsQueries += 1;
  });
  await Promise.all([
    new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => dnsServer.bind(0, "127.0.0.1", resolve)),
  ]);
  return {
    udpPort: udp.address().port,
    dnsPort: dnsServer.address().port,
    counts,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => dnsServer.close(() => resolve())),
      ]);
    },
  };
}

/** A fixture child: armed exactly as `cli.ts`'s `armedVerdictRun` arms the real one, ONE attempt, then a well-behaved answer. */
function fixture(attempt: string): string {
  return `import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
const m = await import(${JSON.stringify(VERDICT_MODULE)});
const g = await import(${JSON.stringify(GUARDS_MODULE)});
if (g.isReadOnlyProcess()) {
  m.armTargetVerdict({ values: ["x"], kind: "not-found" });
  m.openSideChannel();
  g.installArmedGuards();
  process.on("exit", (code) => m.tellExit(code));
  m.tellParent("readonly");
}
const UDP = Number(process.env.FIXTURE_UDP_PORT);
const DNS = Number(process.env.FIXTURE_DNS_PORT);
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
try {
${attempt}
} catch (error) {
  process.stdout.write("attempt threw: " + (error.code ?? error.message) + "\\n");
}
await settle();
process.stderr.write("Session not found: x\\n");
process.exitCode = 4;
`;
}

type Rig = { run: ChildRun; counts: Counters; atriumRequests: number };

async function runFixture(source: string): Promise<Rig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-"));
  const entry = path.join(dir, "child.mjs");
  await fs.writeFile(entry, source);
  const { home } = agentPodHome();
  const listeners = await listen();
  const atrium = await startRecordedAtrium({});
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_POD_VERDICT_CHILD_ENTRY: entry,
        FIXTURE_UDP_PORT: String(listeners.udpPort),
        FIXTURE_DNS_PORT: String(listeners.dnsPort),
      }),
      { cwd: home },
    );
    await new Promise((resolve) => setTimeout(resolve, 300)); // a late datagram is still a datagram
    return { run, counts: { ...listeners.counts }, atriumRequests: atrium.requests.length };
  } finally {
    await atrium.close();
    await listeners.close();
  }
}

function assertBarred(rig: Rig, label: string): void {
  assert.equal(rig.run.status, 2, `${label}: ${rig.run.stderr}`);
  assert.match(
    rig.run.stderr.split("\n")[0] ?? "",
    /^acpx: REFUSED reason=pass_through_refused .*detail=target-unresolved$/u,
    label,
  );
  assert.doesNotMatch(rig.run.stdout + rig.run.stderr, /Session not found/u, label);
  assert.deepEqual(rig.counts, { udp: 0, dnsQueries: 0 }, `${label}: NOTHING may arrive`);
  assert.equal(rig.atriumRequests, 1, `${label}: only the parent's own call reached atrium`);
}

test("CONTROL: the same armed fixture with NO network attempt is relayed — the refusals below are the barrier's doing", async () => {
  const rig = await runFixture(fixture(""));
  assert.equal(rig.run.status, 4, rig.run.stderr);
  assert.match(rig.run.stderr, /Session not found: x/u);
  assert.deepEqual(rig.counts, { udp: 0, dnsQueries: 0 });
});

const UDP_ROUTES: Array<[string, string]> = [
  [
    "dgram.createSocket + send",
    `const s = dgram.createSocket("udp4"); await new Promise((res, rej) => s.send("hi", UDP, "127.0.0.1", (e) => (e ? rej(e) : res()))); s.close();`,
  ],
  [
    "new dgram.Socket().send",
    `const s = new dgram.Socket("udp4"); await new Promise((res, rej) => s.send("hi", UDP, "127.0.0.1", (e) => (e ? rej(e) : res()))); s.close();`,
  ],
  [
    "dgram bind (opening a UDP socket)",
    `const s = dgram.createSocket("udp4"); await new Promise((res, rej) => { s.on("error", rej); s.bind(0, "127.0.0.1", res); }); s.close();`,
  ],
  [
    "dgram connect + send",
    `const s = dgram.createSocket("udp4"); await new Promise((res, rej) => { s.on("error", rej); s.connect(UDP, "127.0.0.1", res); }); s.send("hi"); await settle(); s.close();`,
  ],
  [
    "udp6 socket send",
    `const s = dgram.createSocket("udp6"); await new Promise((res, rej) => s.send("hi", UDP, "::1", (e) => (e ? rej(e) : res()))); s.close();`,
  ],
];

for (const [route, attempt] of UDP_ROUTES) {
  test(`UDP — ${route}: the armed child is barred (any attempt tells the parent), the door's refusal is kept, and NO datagram arrives`, async () => {
    assertBarred(await runFixture(fixture(attempt)), `UDP ${route}`);
  });
}

const DNS_ROUTES: Array<[string, string]> = [
  [
    "dns.Resolver.resolve4 with a chosen server (callback)",
    `const r = new dns.Resolver({ timeout: 500, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => r.resolve4("atrium.example", () => res()));`,
  ],
  [
    "dns.promises.Resolver.resolve4 with a chosen server",
    `const r = new dns.promises.Resolver({ timeout: 500, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); await r.resolve4("atrium.example");`,
  ],
  [
    "dns.setServers + dns.resolve4 (the module-level resolver)",
    `dns.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => dns.resolve4("atrium.example", () => res()));`,
  ],
  [
    "dns.resolveTxt / dns.resolveAny / dns.resolveMx through a chosen server",
    `const r = new dns.promises.Resolver({ timeout: 300, tries: 1 }); r.setServers(["127.0.0.1:" + DNS]); await r.resolveTxt("a.example").catch(() => {}); await r.resolveAny("a.example").catch(() => {}); await r.resolveMx("a.example");`,
  ],
  [
    "dns.reverse through a chosen server",
    `dns.setServers(["127.0.0.1:" + DNS]); await new Promise((res) => dns.reverse("127.0.0.1", () => res()));`,
  ],
  [
    "dns.lookup (getaddrinfo, callback)",
    `await new Promise((res, rej) => dns.lookup("localhost", (e) => (e ? rej(e) : res())));`,
  ],
  ["dns.promises.lookup (getaddrinfo)", `await dns.promises.lookup("localhost");`],
  [
    "dns.lookupService (getnameinfo)",
    `await new Promise((res, rej) => dns.lookupService("127.0.0.1", 80, (e) => (e ? rej(e) : res())));`,
  ],
  ["dns.promises.lookupService", `await dns.promises.lookupService("127.0.0.1", 80);`],
  [
    "net.connect to a HOSTNAME (resolves first)",
    `await new Promise((res, rej) => { const s = net.connect(UDP, "localhost"); s.on("connect", res); s.on("error", rej); setTimeout(res, 500); });`,
  ],
];

for (const [route, attempt] of DNS_ROUTES) {
  test(`DNS — ${route}: the armed child is barred (any attempt tells the parent), the door's refusal is kept, and NO query arrives`, async () => {
    assertBarred(await runFixture(fixture(attempt)), `DNS ${route}`);
  });
}

// ---- an UNARMED process is untouched ---------------------------------------------------------------------------

test("an ORDINARY process still uses dgram and dns: a datagram arrives, a Resolver query arrives, getaddrinfo resolves — the barrier exists only in the armed child", async () => {
  const listeners = await listen();
  try {
    const sender = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) =>
      sender.send("hi", listeners.udpPort, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    sender.close();
    const resolver = new dns.promises.Resolver({ timeout: 300, tries: 1 });
    resolver.setServers([`127.0.0.1:${listeners.dnsPort}`]);
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

test("an ordinary acpx process (the real CLI, no verdict) is unaffected too: the guards are installed only when a verdict is armed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-udp-dns-plain-"));
  const probe = path.join(dir, "probe.mjs");
  await fs.writeFile(
    probe,
    `import dgram from "node:dgram";
const m = await import(${JSON.stringify(VERDICT_MODULE)});
const s = dgram.createSocket("udp4");
process.stdout.write(JSON.stringify({ sendIsNative: !String(dgram.Socket.prototype.send).includes("refuse"), armed: m.armedTargetVerdict() !== undefined }));
s.close();
`,
  );
  const { spawn } = await import("node:child_process");
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [probe]);
    let text = "";
    child.stdout.on("data", (c: Buffer) => (text += c.toString()));
    child.on("close", () => resolve(text));
  });
  assert.deepEqual(JSON.parse(out), { sendIsNative: true, armed: false });
});
