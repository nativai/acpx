import assert from "node:assert/strict";
import test from "node:test";
import { resolveTreeOptions } from "../src/cli/command-handlers.js";
import type { SessionsTreeFlags } from "../src/cli/flags.js";
import {
  buildForest,
  buildTreeResult,
  type RawProjection,
} from "../src/cli/session/session-tree.js";

// D1 regression: the flag → engine-filter mapping for `--all`. The pure pipeline
// was correct (its unit tests drive scope:"all" + status directly), but the
// `buildTreeFilters` `--all` branch used to hard-blank status/sinceMs, so explicit
// `--active/--open/--closed/--since` never reached the engine and conflict
// validation was bypassed. These tests cover that mapping layer.

const NOW = Date.parse("2026-06-05T12:00:00.000Z");
const RECENT = "2026-06-05T11:59:00.000Z"; // < 1h ago
const OLD = "2026-06-03T00:00:00.000Z"; // ~2d ago

function proj(partial: Partial<RawProjection> & { id: string }): RawProjection {
  return {
    closed: false,
    subagentIds: [],
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    createdAt: OLD,
    lastUsedAt: RECENT,
    ...partial,
  };
}

test("--all keeps explicit status/recency predicates (D1)", () => {
  const closed = resolveTreeOptions({ all: true, closed: true });
  assert.equal(closed.scope, "all");
  assert.equal(closed.filters.status, "closed");

  const since = resolveTreeOptions({ all: true, since: "6h" });
  assert.equal(since.scope, "all");
  assert.equal(since.filters.sinceMs, 6 * 60 * 60 * 1000);

  const active = resolveTreeOptions({ all: true, active: true });
  assert.equal(active.filters.status, "open");
  assert.equal(active.filters.sinceMs, 24 * 60 * 60 * 1000);

  const open = resolveTreeOptions({ all: true, open: true });
  assert.equal(open.filters.status, "open");

  // --all with no status/recency flag → no implicit predicate (shows everything).
  const bare = resolveTreeOptions({ all: true });
  assert.equal(bare.scope, "all");
  assert.equal(bare.filters.status, undefined);
  assert.equal(bare.filters.sinceMs, undefined);
});

test("--all still runs status conflict validation (would exit 2 at the CLI)", () => {
  assert.throws(
    () => resolveTreeOptions({ all: true, open: true, closed: true }),
    /Cannot combine/,
  );
  assert.throws(
    () => resolveTreeOptions({ all: true, active: true, closed: true }),
    /Cannot combine/,
  );
});

test("--all + status/recency actually narrows the forest", async () => {
  const forest = buildForest([
    proj({ id: "open-recent", name: "or", lastUsedAt: RECENT }),
    proj({ id: "open-old", name: "oo", lastUsedAt: OLD }),
    proj({ id: "closed-old", name: "co", closed: true, lastUsedAt: OLD }),
  ]);
  const shown = async (flags: SessionsTreeFlags): Promise<string[]> => {
    const result = await buildTreeResult(forest, 3, 0, resolveTreeOptions(flags), NOW);
    return Object.keys(result.nodes).toSorted();
  };

  const all = await shown({ all: true });
  const closed = await shown({ all: true, closed: true });
  const active = await shown({ all: true, active: true });
  const since6h = await shown({ all: true, since: "6h" });

  assert.deepEqual(all, ["closed-old", "open-old", "open-recent"]); // everything
  assert.deepEqual(closed, ["closed-old"]);
  assert.deepEqual(active, ["open-recent"]);
  // The defect: `--all --closed` and `--all --active` were byte-identical.
  assert.notDeepEqual(closed, active);
  // Each predicate result is a strict subset of the full forest.
  assert.ok(closed.every((id) => all.includes(id)) && closed.length < all.length);
  assert.ok(active.every((id) => all.includes(id)) && active.length < all.length);
  assert.ok(since6h.length <= all.length);
  assert.deepEqual(since6h, ["open-recent"]);
});
