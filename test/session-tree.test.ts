import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTypeFromCommand,
  buildForest,
  buildTreeResult,
  deriveEdge,
  formatAge,
  parseDuration,
  parseSessionIdFromUrl,
  resolveAnchor,
  scanProjection,
  scanProjectionFromString,
  scanProjectionLines,
  walkAncestors,
  walkConnectedComponent,
  walkDescendants,
  type RawProjection,
  type TreeOptions,
} from "../src/cli/session/session-tree.js";

const NOW = Date.parse("2026-06-05T12:00:00.000Z");

function proj(partial: Partial<RawProjection> & { id: string }): RawProjection {
  return {
    closed: false,
    subagentIds: [],
    lastUsedAt: "2026-06-05T11:59:30.000Z",
    createdAt: "2026-06-05T11:00:00.000Z",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    ...partial,
  };
}

function opts(partial: Partial<TreeOptions> = {}): TreeOptions {
  return {
    scope: "all",
    connected: false,
    direction: "both",
    filters: {},
    maxNodes: 200,
    showLegend: true,
    ...partial,
  };
}

async function fromChunks(text: string): Promise<RawProjection | null> {
  async function* gen(): AsyncIterable<string> {
    yield text;
  }
  return scanProjectionLines(gen());
}

// Build a realistic 2-space pretty-printed record, including a `messages` array
// whose content tries to spoof a top-level key.
function recordJson(overrides: Record<string, unknown>): string {
  const record = {
    schema: "acpx.session.v1",
    acpx_record_id: "rec-1",
    acp_session_id: "acp-1",
    agent_command: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
    name: "alpha",
    created_at: "2026-06-05T11:00:00.000Z",
    last_used_at: "2026-06-05T11:59:30.000Z",
    last_seq: 3,
    messages: [
      {
        User: {
          content: [{ Text: { text: 'evil\n  "kind": "subagent"\n  "closed": true' } }],
        },
      },
    ],
    event_log: { active_path: ".stream.ndjson", segment_count: 1 },
    closed: false,
    title: null,
    updated_at: "2026-06-05T11:59:30.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    kind: "session",
    ...overrides,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// parseSessionIdFromUrl
// ---------------------------------------------------------------------------

test("parseSessionIdFromUrl extracts the session UUID", () => {
  assert.equal(parseSessionIdFromUrl("https://acpx.devbox.nativai.de/?session=abc-123"), "abc-123");
  assert.equal(parseSessionIdFromUrl(undefined), undefined);
  assert.equal(parseSessionIdFromUrl("not a url"), undefined);
  assert.equal(parseSessionIdFromUrl("https://x/?session="), undefined);
});

// ---------------------------------------------------------------------------
// agentTypeFromCommand
// ---------------------------------------------------------------------------

test("agentTypeFromCommand maps known + variant commands", () => {
  assert.equal(agentTypeFromCommand("node /opt/claude-agent-acp/dist/index.js"), "claude");
  assert.equal(
    agentTypeFromCommand("node /workspace/projects/claude-agent-acp/feature-x/dist/index.js"),
    "claude",
  );
  assert.equal(agentTypeFromCommand("npx -y @zed-industries/claude-agent-acp@^0.22.0"), "claude");
  assert.equal(agentTypeFromCommand("npx -y @agentclientprotocol/codex-acp@^0.0.44"), "codex");
  assert.equal(agentTypeFromCommand("gemini --acp"), "gemini");
  assert.equal(agentTypeFromCommand("npx pi-acp@^0.0.26"), "pi");
});

test("agentTypeFromCommand: empty command inherits parent, else 'subagent'", () => {
  assert.equal(agentTypeFromCommand("", "codex"), "codex");
  assert.equal(agentTypeFromCommand("  ", "claude"), "claude");
  assert.equal(agentTypeFromCommand(""), "subagent");
  assert.equal(agentTypeFromCommand(undefined), "subagent");
});

test("agentTypeFromCommand: unknown falls back to basename, else 'unknown'", () => {
  assert.equal(agentTypeFromCommand("/usr/local/bin/weird-agent --acp"), "weird-agent");
  assert.equal(agentTypeFromCommand("   "), "subagent");
});

// ---------------------------------------------------------------------------
// parseDuration + formatAge
// ---------------------------------------------------------------------------

test("parseDuration parses units and rejects garbage", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("6h"), 6 * 3_600_000);
  assert.equal(parseDuration("2d"), 2 * 86_400_000);
  assert.equal(parseDuration("1w"), 7 * 86_400_000);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("bogus"), null);
  assert.equal(parseDuration("10"), null);
  assert.equal(parseDuration("10y"), null);
});

test("formatAge buckets relative time", () => {
  const at = (deltaMs: number) => formatAge(NOW, new Date(NOW - deltaMs).toISOString());
  assert.equal(at(5_000), "now");
  assert.equal(at(5 * 60_000), "5m");
  assert.equal(at(3 * 3_600_000), "3h");
  assert.equal(at(2 * 86_400_000), "2d");
  assert.equal(at(3 * 7 * 86_400_000), "3w");
  assert.equal(formatAge(NOW, undefined), "?");
  assert.equal(formatAge(NOW, "garbage"), "?");
});

// ---------------------------------------------------------------------------
// Streaming scanners
// ---------------------------------------------------------------------------

test("line scanner reads the projection and is not spoofed by message content", async () => {
  const json = recordJson({
    kind: "session",
    parent_session_id: "parent-1",
    metadata: { task_folder: "/wisdom/task" },
  });
  const p = await fromChunks(json);
  assert.ok(p);
  assert.equal(p.id, "rec-1");
  assert.equal(p.acpSessionId, "acp-1");
  assert.equal(p.kind, "session"); // NOT "subagent" from the message content
  assert.equal(p.closed, false); // NOT true from the message content
  assert.equal(p.parentSessionId, "parent-1");
  assert.equal(p.taskFolder, "/wisdom/task");
  assert.equal(p.name, "alpha");
});

test("line scanner survives arbitrary chunk boundaries", async () => {
  const json = recordJson({
    parent_session_id: "parent-1",
    forked_from_session_id: "fork-src",
    forked_at_message_index: 0,
    subagents: [
      { acpx_record_id: "sub-a", name: "n", spawned_at: "t" },
      { acpx_record_id: "sub-b", name: "n", spawned_at: "t" },
    ],
  });
  for (const size of [1, 2, 3, 7, 13, 64, 1024]) {
    async function* gen(): AsyncIterable<string> {
      for (let i = 0; i < json.length; i += size) {
        yield json.slice(i, i + size);
      }
    }
    const p = await scanProjectionLines(gen());
    assert.ok(p, `chunk size ${size}`);
    assert.equal(p.forkedFromSessionId, "fork-src");
    assert.equal(p.forkedAtMessageIndex, 0, `forked_at_message_index:0 at chunk ${size}`);
    assert.deepEqual([...p.subagentIds].toSorted(), ["sub-a", "sub-b"]);
  }
});

test("structural scanner agrees with the line scanner and survives chunking", async () => {
  const json = recordJson({
    parent_session_id: "parent-1",
    forked_from_session_id: "fork-src",
    forked_at_message_index: 7,
    metadata: { task_folder: "/wisdom/task" },
    subagents: [{ acpx_record_id: "sub-a", name: "n", spawned_at: "t" }],
  });
  const line = await fromChunks(json);
  const structWhole = scanProjectionFromString(json);
  const structChunked = scanProjectionFromString(json, 5);
  assert.deepEqual(structWhole, line);
  assert.deepEqual(structChunked, line);
  assert.ok(line);
  assert.equal(line.forkedAtMessageIndex, 7);
});

test("scanners reject non-records / wrong schema", async () => {
  assert.equal(await fromChunks('{\n  "schema": "other.v1",\n  "acpx_record_id": "x"\n}\n'), null);
  assert.equal(await fromChunks('{\n  "no_id": true\n}\n'), null);
  assert.equal(scanProjectionFromString("not json at all"), null);
});

test("scanProjection (structural) over an async iterable", async () => {
  async function* gen(): AsyncIterable<string> {
    yield recordJson({ kind: "subagent" });
  }
  const p = await scanProjection(gen());
  assert.ok(p);
  assert.equal(p.kind, "subagent");
});

// ---------------------------------------------------------------------------
// Edge derivation
// ---------------------------------------------------------------------------

test("deriveEdge: fork wins over parent", () => {
  const edge = deriveEdge(
    proj({ id: "c", parentSessionId: "p", forkedFromSessionId: "f", forkedAtMessageIndex: 4 }),
  );
  assert.deepEqual(edge, { parentId: "f", type: "fork", forkAtMessageIndex: 4 });
});

test("deriveEdge: kind-absent → spawn; subagent → subagent", () => {
  assert.deepEqual(deriveEdge(proj({ id: "c", parentSessionId: "p" })), {
    parentId: "p",
    type: "spawn",
  });
  assert.deepEqual(deriveEdge(proj({ id: "c", parentSessionId: "p", kind: "subagent" })), {
    parentId: "p",
    type: "subagent",
  });
});

test("deriveEdge: no parent → null; self-parent dropped", () => {
  assert.equal(deriveEdge(proj({ id: "c" })), null);
  assert.equal(deriveEdge(proj({ id: "c", parentSessionId: "c" })), null);
  assert.equal(deriveEdge(proj({ id: "c", forkedFromSessionId: "c" })), null);
});

// ---------------------------------------------------------------------------
// Forest building
// ---------------------------------------------------------------------------

test("buildForest: orphan parent becomes a missing placeholder root", () => {
  const forest = buildForest([proj({ id: "child", parentSessionId: "ghost" })]);
  const ghost = forest.nodes.get("ghost");
  assert.ok(ghost);
  assert.equal(ghost.missing, true);
  assert.deepEqual(ghost.childIds, ["child"]);
  assert.deepEqual(forest.roots, ["ghost"]);
});

test("buildForest: roots + cycle safety net (no node dropped)", () => {
  // a → b → a is a pure cycle (no edge-less root). Safety net must surface it.
  const forest = buildForest([
    proj({ id: "a", parentSessionId: "b" }),
    proj({ id: "b", parentSessionId: "a" }),
    proj({ id: "r" }),
  ]);
  assert.ok(forest.roots.includes("r"));
  // every node remains reachable from some root
  const reach = new Set<string>();
  const q = [...forest.roots];
  while (q.length) {
    const id = q.shift() as string;
    if (reach.has(id)) {
      continue;
    }
    reach.add(id);
    q.push(...(forest.nodes.get(id)?.childIds ?? []));
  }
  assert.ok(reach.has("a") && reach.has("b") && reach.has("r"));
});

// ---------------------------------------------------------------------------
// Walks
// ---------------------------------------------------------------------------

function chainForest() {
  // r → a → b → c
  return buildForest([
    proj({ id: "r" }),
    proj({ id: "a", parentSessionId: "r" }),
    proj({ id: "b", parentSessionId: "a" }),
    proj({ id: "c", parentSessionId: "b" }),
  ]);
}

test("walkAncestors climbs nearest-first with depth cap", () => {
  const forest = chainForest();
  assert.deepEqual(walkAncestors(forest, "c", undefined), ["b", "a", "r"]);
  assert.deepEqual(walkAncestors(forest, "c", 2), ["b", "a"]);
});

test("walkDescendants BFS by level + clip flag", () => {
  const forest = chainForest();
  const all = walkDescendants(forest, "r", undefined);
  assert.deepEqual(all.ids.toSorted(), ["a", "b", "c"]);
  assert.equal(all.clipped, false);
  const capped = walkDescendants(forest, "r", 1);
  assert.deepEqual(capped.ids, ["a"]);
  assert.equal(capped.clipped, true);
});

test("walkConnectedComponent gathers the whole component", () => {
  const forest = chainForest();
  assert.deepEqual(walkConnectedComponent(forest, "b").toSorted(), ["a", "b", "c", "r"]);
});

test("walks never loop on a cycle", () => {
  const forest = buildForest([
    proj({ id: "a", parentSessionId: "b" }),
    proj({ id: "b", parentSessionId: "a" }),
  ]);
  assert.doesNotThrow(() => walkAncestors(forest, "a", undefined));
  assert.doesNotThrow(() => walkDescendants(forest, "a", undefined));
  assert.doesNotThrow(() => walkConnectedComponent(forest, "a"));
});

// ---------------------------------------------------------------------------
// resolveAnchor
// ---------------------------------------------------------------------------

test("resolveAnchor: exact, prefix, suffix, ambiguous, not-found", () => {
  const forest = buildForest([
    proj({ id: "aaaa1111-2222", acpSessionId: "acp-xyz" }),
    proj({ id: "bbbb3333-4444" }),
  ]);
  assert.equal(resolveAnchor(forest, "aaaa1111-2222"), "aaaa1111-2222");
  assert.equal(resolveAnchor(forest, "acp-xyz"), "aaaa1111-2222");
  assert.equal(resolveAnchor(forest, "aaaa1111"), "aaaa1111-2222"); // prefix (the shown short id)
  assert.equal(resolveAnchor(forest, "2222"), "aaaa1111-2222"); // suffix
  assert.throws(() => resolveAnchor(forest, "zzzz"), /No session found/);
});

// ---------------------------------------------------------------------------
// Filter pipeline (buildTreeResult)
// ---------------------------------------------------------------------------

function sampleForest() {
  // root → (childA spawn, childB fork@2, sub subagent); childA → grand spawn
  return buildForest([
    proj({ id: "root", name: "root-node", lastUsedAt: "2026-06-05T11:59:00.000Z" }),
    proj({
      id: "childA",
      parentSessionId: "root",
      name: "impl",
      agentCommand: "npx -y @agentclientprotocol/codex-acp@^0.0.44",
      lastUsedAt: "2026-06-05T11:00:00.000Z",
    }),
    proj({
      id: "childB",
      parentSessionId: "root",
      forkedFromSessionId: "root",
      forkedAtMessageIndex: 2,
      name: "forked",
      closed: true,
      lastUsedAt: "2026-06-01T00:00:00.000Z",
    }),
    proj({ id: "sub", parentSessionId: "root", kind: "subagent", agentCommand: "", name: "task" }),
    proj({ id: "grand", parentSessionId: "childA", name: "deep" }),
  ]);
}

test("pipeline --all shows the whole forest with edges", async () => {
  const result = await buildTreeResult(sampleForest(), 5, 0, opts({ scope: "all" }), NOW);
  assert.equal(result.summary.shown, 5);
  assert.equal(result.nodes.childB.edgeLabel, "fork@2");
  assert.equal(result.nodes.sub.edgeLabel, "subagent");
  assert.equal(result.nodes.childA.edgeLabel, "spawn");
  assert.equal(result.nodes.sub.agentType, "claude"); // inherited from root
});

test("pipeline: --type fork keeps fork hits + ancestors as context", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { types: ["fork"] } }),
    NOW,
  );
  assert.ok(result.nodes.childB); // the fork hit
  assert.equal(result.nodes.childB.context, false);
  assert.ok(result.nodes.root); // kept as context
  assert.equal(result.nodes.root.context, true);
  assert.equal(result.nodes.childA, undefined); // non-matching, not an ancestor of a hit
});

test("pipeline: --agent-type codex (AND with scope)", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { agentTypes: ["codex"] } }),
    NOW,
  );
  assert.equal(result.nodes.childA.context, false); // codex hit
  assert.ok(result.nodes.root.context); // ancestor context
  assert.equal(result.nodes.childB, undefined);
});

test("pipeline: --no-subagents drops subagent nodes", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { noSubagents: true } }),
    NOW,
  );
  assert.equal(result.nodes.sub, undefined);
});

test("pipeline: status open/closed + since", async () => {
  const open = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { status: "open" } }),
    NOW,
  );
  assert.equal(open.nodes.childB, undefined); // closed, filtered out as a hit
  assert.ok(open.summary.hiddenClosed >= 1);

  const recent = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { sinceMs: 60 * 60_000 } }),
    NOW,
  );
  // childA last used 1h+ ago, childB days ago → excluded by recency
  assert.equal(recent.nodes.childB, undefined);
});

test("pipeline: name / task substring filters", async () => {
  const byName = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", filters: { name: "DEEP" } }),
    NOW,
  );
  assert.equal(byName.nodes.grand.context, false);
  assert.ok(byName.nodes.childA.context); // ancestor of the hit
  assert.ok(byName.nodes.root.context);
});

test("pipeline: --max-nodes truncates with a notice (BFS from roots)", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "all", maxNodes: 2 }),
    NOW,
  );
  assert.equal(result.summary.shown, 2);
  assert.equal(result.summary.truncated, true);
  assert.ok(result.notes.some((n) => n.includes("raise --max-nodes")));
});

test("pipeline: --depth clip emits a notice", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "root", anchor: "root", depth: 1 }),
    NOW,
  );
  assert.equal(result.summary.depthClipped, true);
  assert.ok(result.notes.some((n) => n.includes("clipped at depth")));
  assert.equal(result.nodes.grand, undefined); // depth-2 node clipped
});

test("pipeline: self scope renders spine + subtree, anchor marked", async () => {
  const result = await buildTreeResult(
    sampleForest(),
    5,
    0,
    opts({ scope: "self", anchor: "childA" }),
    NOW,
  );
  assert.equal(result.nodes.childA.anchor, true);
  assert.ok(result.nodes.root); // ancestor spine
  assert.ok(result.nodes.grand); // descendant subtree
  assert.equal(result.nodes.childB, undefined); // sibling not in scope
});

test("pipeline: skipped count surfaces in summary + notes", async () => {
  const result = await buildTreeResult(sampleForest(), 5, 3, opts({ scope: "all" }), NOW);
  assert.equal(result.summary.skipped, 3);
  assert.ok(result.notes.some((n) => n.includes("skipped 3")));
});
