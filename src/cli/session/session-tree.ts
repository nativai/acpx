// Lineage-forest reader for `acpx sessions tree`.
//
// This module is intentionally self-contained and pure: all filesystem access,
// the wall clock, and queue-owner liveness probing are injected via `TreeIO`, so
// the forest builder / edge derivation / filter pipeline can be unit-tested with
// in-memory fixtures. The handler (`handleSessionsTree`) wires the real adapter
// (`createDefaultTreeIO`).
//
// Why a bespoke reader instead of `parseSessionRecord`/`listSessions`:
//   1. `parseSessionRecord` requires a valid `messages[]` array and validates
//      every message, forcing the whole (up to 27 MB) conversation to be
//      materialised — multi-second + heavy GC over the ~500 MB store.
//   2. `parseSessionRecord`/`SessionRecord`/`serialize.ts` historically dropped
//      the fork fields, so a parse-based reader would show 0 fork edges.
// We therefore stream each record with a depth-aware scanner that captures only
// the lightweight projection (§6.2) and skips the *bytes* of large values
// (`messages`, token usage, `event_log`) without allocating them.

import { AGENT_REGISTRY } from "../../agent-registry.js";

export const SESSION_TREE_SCHEMA = "acpx.session-tree.v1" as const;
export const DEFAULT_MAX_NODES = 200;
export const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — see §5.1

/** Error thrown when an anchor id cannot be resolved (handler maps to a CLI error). */
export class SessionTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTreeError";
  }
}

// ---------------------------------------------------------------------------
// Projection + edge types
// ---------------------------------------------------------------------------

/** The lightweight per-record projection (§6.2) — never holds `messages[]`. */
export type RawProjection = {
  id: string;
  acpSessionId?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  forkedAtMessageIndex?: number;
  kind?: string;
  agentCommand?: string;
  name?: string;
  title?: string;
  cwd?: string;
  closed: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  lastPromptAt?: string;
  pid?: number;
  taskFolder?: string;
  subagentIds: string[];
};

export type EdgeType = "spawn" | "fork" | "subagent";

export type ParentEdge = {
  parentId: string;
  type: EdgeType;
  forkAtMessageIndex?: number;
};

/** A node in the assembled forest (a real record or a `missing` placeholder). */
export type ForestNode = {
  id: string;
  projection?: RawProjection;
  edgeToParent: ParentEdge | null;
  childIds: string[];
  missing: boolean;
};

export type Forest = {
  nodes: Map<string, ForestNode>;
  roots: string[];
};

// ---------------------------------------------------------------------------
// `parseSessionIdFromUrl` — shared with command-handlers for `--self`
// ---------------------------------------------------------------------------

// Parse the UUID from an acpx-ui session URL (...?session=<uuid>).
// Returns undefined for missing / malformed input or empty session value.
export function parseSessionIdFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    const sessionId = parsed.searchParams.get("session")?.trim();
    return sessionId && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent-type normalisation (§6.4)
// ---------------------------------------------------------------------------

// Substring → agent type. Ordered: first match wins. Seeded by the adapter
// command shapes in AGENT_REGISTRY but tolerant of feature-branch / zed / npx
// variants a pure registry inversion would miss (see investigation-notes §A).
const AGENT_TYPE_SUBSTRINGS: Array<[string, string]> = [
  ["claude-agent-acp", "claude"],
  ["codex-acp", "codex"],
  ["gemini", "gemini"],
  ["openclaw", "openclaw"],
  ["pi-acp", "pi"],
  ["cursor-agent", "cursor"],
  ["copilot", "copilot"],
  ["droid", "droid"],
  ["iflow", "iflow"],
  ["kilocode", "kilocode"],
  ["kiro", "kiro"],
  ["opencode", "opencode"],
  ["qoder", "qoder"],
  ["qwen", "qwen"],
  ["trae", "trae"],
];

function agentTypeBySubstring(lowered: string): string | undefined {
  for (const [needle, type] of AGENT_TYPE_SUBSTRINGS) {
    if (lowered.includes(needle)) {
      return type;
    }
  }
  return undefined;
}

function agentTypeByRegistry(command: string): string | undefined {
  // Registry inversion: an exact configured command maps back to its name.
  for (const [name, configured] of Object.entries(AGENT_REGISTRY)) {
    if (configured === command) {
      return name;
    }
  }
  return undefined;
}

function agentTypeFallback(command: string): string {
  // Basename of the first token (e.g. a raw binary path), else "unknown".
  const base = (command.split(/\s+/)[0] ?? "").split("/").pop() ?? "";
  return base.length > 0 ? base : "unknown";
}

/**
 * Normalise a record's `agent_command` to an agent type (claude/codex/…).
 * Empty command (subagents) inherits `parentType` when given, else "subagent".
 */
export function agentTypeFromCommand(
  agentCommand: string | undefined,
  parentType?: string,
): string {
  const command = (agentCommand ?? "").trim();
  if (command.length === 0) {
    return parentType ?? "subagent";
  }
  return (
    agentTypeBySubstring(command.toLowerCase()) ??
    agentTypeByRegistry(command) ??
    agentTypeFallback(command)
  );
}

// ---------------------------------------------------------------------------
// Duration parsing + age formatting
// ---------------------------------------------------------------------------

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Parse `30m` / `6h` / `2d` / `1w` (also `s`) to milliseconds; null if invalid. */
export function parseDuration(value: string): number | null {
  const match = /^(\d+)\s*([smhdw])$/.exec(value.trim().toLowerCase());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return amount * DURATION_UNIT_MS[match[2]];
}

/** Relative age of `iso` vs `nowMs`: `now`, `2m`, `6h`, `2d`, `1w`; `?` if absent. */
export function formatAge(nowMs: number, iso: string | undefined): string {
  if (!iso) {
    return "?";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "?";
  }
  const deltaMs = Math.max(0, nowMs - then);
  if (deltaMs < 60 * 1000) {
    return "now";
  }
  if (deltaMs < 60 * 60 * 1000) {
    return `${Math.floor(deltaMs / (60 * 1000))}m`;
  }
  if (deltaMs < 24 * 60 * 60 * 1000) {
    return `${Math.floor(deltaMs / (60 * 60 * 1000))}h`;
  }
  if (deltaMs < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(deltaMs / (24 * 60 * 60 * 1000))}d`;
  }
  return `${Math.floor(deltaMs / (7 * 24 * 60 * 60 * 1000))}w`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Streaming depth-aware projection scanner (§7)
// ---------------------------------------------------------------------------

const SESSION_RECORD_SCHEMA = "acpx.session.v1";

// Root-level scalar keys we keep. Everything else at the root is skipped; large
// structural values (messages, *_token_usage, event_log, acpx, …) are skipped by
// the bytes without allocation.
const ROOT_SCALAR_KEYS = new Set([
  "schema",
  "acpx_record_id",
  "acp_session_id",
  "parent_session_id",
  "forked_from_session_id",
  "forked_at_message_index",
  "kind",
  "agent_command",
  "name",
  "title",
  "cwd",
  "closed",
  "created_at",
  "last_used_at",
  "last_prompt_at",
  "pid",
]);

function decodeJsonString(inner: string): string {
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return inner;
  }
}

function parsePrimitive(token: string): string | number | boolean | null {
  if (token === "true") {
    return true;
  }
  if (token === "false") {
    return false;
  }
  if (token === "null") {
    return null;
  }
  const num = Number(token);
  return Number.isFinite(num) ? num : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function buildProjection(
  raw: Record<string, string | number | boolean | null>,
  taskFolder: string | undefined,
  subagentIds: string[],
): RawProjection | null {
  const id = typeof raw.acpx_record_id === "string" ? raw.acpx_record_id : undefined;
  if (!id) {
    return null;
  }
  if (raw.schema !== undefined && raw.schema !== SESSION_RECORD_SCHEMA) {
    return null;
  }
  return {
    id,
    acpSessionId: asString(raw.acp_session_id),
    parentSessionId: asString(raw.parent_session_id),
    forkedFromSessionId: asString(raw.forked_from_session_id),
    forkedAtMessageIndex: asNonNegativeInt(raw.forked_at_message_index),
    kind: asString(raw.kind),
    agentCommand: asString(raw.agent_command),
    name: asString(raw.name),
    title: asString(raw.title),
    cwd: asString(raw.cwd),
    closed: raw.closed === true,
    createdAt: asString(raw.created_at),
    lastUsedAt: asString(raw.last_used_at),
    lastPromptAt: asString(raw.last_prompt_at),
    pid: asNonNegativeInt(raw.pid),
    taskFolder,
    subagentIds,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractScalarKeys(
  record: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const raw: Record<string, string | number | boolean | null> = {};
  for (const key of ROOT_SCALAR_KEYS) {
    const v = record[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
      raw[key] = v;
    }
  }
  return raw;
}

function extractSubagentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    const sub = asRecord(entry);
    if (sub && typeof sub.acpx_record_id === "string") {
      ids.push(sub.acpx_record_id);
    }
  }
  return ids;
}

/**
 * Correctness guard for the rare non-pretty-printed (compact) record the line
 * scanner can't read: extract the same projection fields from a one-shot
 * `JSON.parse`d object. Returns null for a non-record (→ counted as skipped).
 */
export function projectionFromObject(value: unknown): RawProjection | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const metadata = asRecord(record.metadata);
  const taskFolder = typeof metadata?.task_folder === "string" ? metadata.task_folder : undefined;
  return buildProjection(
    extractScalarKeys(record),
    taskFolder,
    extractSubagentIds(record.subagents),
  );
}

// Upper bound for the JSON.parse fallback. A compact record above this is skipped
// (counted, never silently dropped) rather than risk materialising a huge object.
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;

/** Read a single file (bounded) and JSON.parse-extract its projection. */
export async function scanProjectionFallback(
  chunks: AsyncIterable<string>,
  maxBytes: number,
): Promise<RawProjection | null> {
  let text = "";
  for await (const chunk of chunks) {
    text += chunk;
    if (text.length > maxBytes) {
      return null; // compact AND oversized → skip (surfaced in the `skipped` count)
    }
  }
  try {
    return projectionFromObject(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fast line-oriented scanner (primary path).
//
// acpx persists every record with `JSON.stringify(record, null, 2)`, and JSON
// escapes literal newlines (`\n`) — so EVERY physical newline in the file is
// structural whitespace, and a top-level key is always a line at exactly
// 2-space indent (`^  "key":`). Message content can therefore never spoof a
// top-level key (it has no physical newlines), so this scanner is both correct
// and fast (it skips message-content lines with a 3-char check instead of
// walking every byte, and never materialises `messages[]`). It is the correct
// primary for 100% of acpx-written records. A non-pretty-printed (compact) file
// — never produced by acpx — yields no projection here and is handled by the
// small `JSON.parse` guard in `loadProjections` (never a silent drop).
// ---------------------------------------------------------------------------

const RE_SUBAGENT_ID = /^\s{2,}"acpx_record_id"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const RE_TASK_FOLDER = /^\s{2,}"task_folder"\s*:\s*"((?:[^"\\]|\\.)*)"/;

type SkipMode = "none" | "plain" | "subagents" | "metadata";

/** True for a top-level structural close line `  ]` / `  }` (optionally `,`). */
function isTopLevelClose(data: string, start: number, len: number): boolean {
  if (len > 4) {
    return false;
  }
  const c2 = data.charCodeAt(start + 2);
  return (
    data.charCodeAt(start) === 32 &&
    data.charCodeAt(start + 1) === 32 &&
    (c2 === 93 /* ] */ || c2 === 125) /* } */
  );
}

// eslint-disable-next-line complexity -- streaming JSON scanner state machine; verified byte-identical against the full store, kept inline for parse correctness
export async function scanProjectionLines(
  chunks: AsyncIterable<string>,
): Promise<RawProjection | null> {
  const raw: Record<string, string | number | boolean | null> = {};
  const subagentIds: string[] = [];
  let taskFolder: string | undefined;
  let skip: SkipMode = "none";

  // Returns the skip mode to be in *after* this line (returned, not mutated, so
  // the outer flow — not just this closure — observes the change).
  // eslint-disable-next-line complexity -- streaming JSON scanner state machine; verified byte-identical against the full store, kept inline for parse correctness
  const handleLine = (data: string, start: number, end: number, mode: SkipMode): SkipMode => {
    const len = end - start;
    if (len === 0) {
      return mode;
    }
    if (mode !== "none") {
      if (isTopLevelClose(data, start, len)) {
        return "none";
      }
      if (mode === "subagents") {
        const match = RE_SUBAGENT_ID.exec(data.slice(start, end));
        if (match) {
          subagentIds.push(decodeJsonString(match[1]));
        }
      } else if (mode === "metadata") {
        const match = RE_TASK_FOLDER.exec(data.slice(start, end));
        if (match) {
          taskFolder = decodeJsonString(match[1]);
        }
      }
      return mode;
    }
    if (
      data.charCodeAt(start) === 32 &&
      data.charCodeAt(start + 1) === 32 &&
      data.charCodeAt(start + 2) === 34 /* " */
    ) {
      return parseTopLevelLine(data.slice(start, end), raw);
    }
    return mode;
  };

  let pending = "";
  let midLineSkip = false; // discarding a long content line inside a `plain` skip
  for await (const chunk of chunks) {
    let data: string;
    let start = 0;
    if (midLineSkip) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) {
        continue; // long line still running; discard the whole chunk
      }
      midLineSkip = false;
      data = chunk;
      start = nl + 1;
    } else {
      data = pending + chunk;
    }
    let nl = data.indexOf("\n", start);
    while (nl !== -1) {
      skip = handleLine(data, start, nl, skip);
      start = nl + 1;
      nl = data.indexOf("\n", start);
    }
    const tailLen = data.length - start;
    if (skip === "plain" && tailLen > 4) {
      midLineSkip = true; // a long line inside a skip can't be a close — discard it
      pending = "";
    } else {
      pending = start === 0 ? data : data.slice(start);
    }
  }
  if (!midLineSkip && pending.length > 0) {
    skip = handleLine(pending, 0, pending.length, skip);
  }
  return buildProjection(raw, taskFolder, subagentIds);
}

/** Parse one `  "key": value` top-level line; returns the skip mode to enter (if any). */
// eslint-disable-next-line complexity -- streaming JSON scanner state machine; verified byte-identical against the full store, kept inline for parse correctness
function parseTopLevelLine(
  line: string,
  raw: Record<string, string | number | boolean | null>,
): SkipMode {
  const keyEnd = line.indexOf('"', 3);
  if (keyEnd < 0) {
    return "none";
  }
  const key = line.slice(3, keyEnd);
  const colon = line.indexOf(":", keyEnd + 1);
  if (colon < 0) {
    return "none";
  }
  let value = line.slice(colon + 1).trim();
  if (value.endsWith(",")) {
    value = value.slice(0, -1).trimEnd();
  }
  if (value.length === 0) {
    return "none";
  }
  const first = value.charCodeAt(0);
  if (first === 91 /* [ */ || first === 123 /* { */) {
    if (value === "[]" || value === "{}") {
      return "none";
    }
    if (key === "subagents") {
      return "subagents";
    }
    if (key === "metadata") {
      return "metadata";
    }
    return "plain";
  }
  if (!ROOT_SCALAR_KEYS.has(key)) {
    return "none";
  }
  if (first === 34 /* " */) {
    try {
      raw[key] = JSON.parse(value) as string;
    } catch {
      // ignore malformed scalar
    }
  } else {
    raw[key] = parsePrimitive(value);
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Edge derivation + forest building (§6.3)
// ---------------------------------------------------------------------------

/** Single parent edge, fork-wins; self-parent dropped (treated as root). */
export function deriveEdge(projection: RawProjection): ParentEdge | null {
  const { id, forkedFromSessionId, parentSessionId, kind } = projection;
  if (forkedFromSessionId && forkedFromSessionId !== id) {
    return {
      parentId: forkedFromSessionId,
      type: "fork",
      forkAtMessageIndex: projection.forkedAtMessageIndex,
    };
  }
  if (parentSessionId && parentSessionId !== id) {
    return { parentId: parentSessionId, type: kind === "subagent" ? "subagent" : "spawn" };
  }
  return null;
}

/**
 * Build the lineage forest: index by id, invert parent edges into children,
 * synthesise `missing` placeholders for referenced-but-absent parents, and
 * surface roots (no edge, missing parent, or — defensively — cycle members).
 */
export function buildForest(projections: RawProjection[]): Forest {
  const nodes = new Map<string, ForestNode>();
  for (const projection of projections) {
    // De-dupe by id (last write wins) so a duplicate file can't double a node.
    nodes.set(projection.id, {
      id: projection.id,
      projection,
      edgeToParent: deriveEdge(projection),
      childIds: [],
      missing: false,
    });
  }

  // Snapshot before iterating: we add `missing` placeholders to `nodes` below.
  const initialNodes = [...nodes.values()];
  for (const node of initialNodes) {
    const edge = node.edgeToParent;
    if (!edge) {
      continue;
    }
    let parent = nodes.get(edge.parentId);
    if (!parent) {
      parent = {
        id: edge.parentId,
        projection: undefined,
        edgeToParent: null,
        childIds: [],
        missing: true,
      };
      nodes.set(parent.id, parent);
    }
    parent.childIds.push(node.id);
  }

  const roots: string[] = [];
  for (const node of nodes.values()) {
    if (node.missing || !node.edgeToParent) {
      roots.push(node.id);
    }
  }
  surfaceUnreachableNodes(nodes, roots);
  return { nodes, roots };
}

/**
 * Safety net: a pure cycle (every member has a present parent) yields no root
 * and would be invisible under --all. Promote any node unreachable from the
 * collected roots to a pseudo-root so nothing is silently dropped.
 */
function surfaceUnreachableNodes(nodes: Map<string, ForestNode>, roots: string[]): void {
  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) {
      continue;
    }
    reachable.add(id);
    const node = nodes.get(id);
    if (node) {
      queue.push(...node.childIds);
    }
  }
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) {
      roots.push(node.id);
      reachable.add(node.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Traversals (§6.3) — visited-set guarded, depth-bounded
// ---------------------------------------------------------------------------

/** Climb parent pointers from `id` (excluded), nearest-first; stop at `maxDepth`. */
// eslint-disable-next-line complexity -- bounded graph traversal (visited-set + depth guard) mirroring acpx-ui's walks
export function walkAncestors(forest: Forest, id: string, maxDepth: number | undefined): string[] {
  const result: string[] = [];
  const visited = new Set<string>([id]);
  let current = forest.nodes.get(id)?.edgeToParent?.parentId;
  let depth = 0;
  while (current && !visited.has(current)) {
    if (maxDepth !== undefined && depth >= maxDepth) {
      break;
    }
    visited.add(current);
    result.push(current);
    current = forest.nodes.get(current)?.edgeToParent?.parentId;
    depth += 1;
  }
  return result;
}

/**
 * BFS the subtree under `id` (excluded) by frontier so `maxDepth` counts graph
 * levels. Returns ids and whether the subtree was clipped by `maxDepth`.
 */
// eslint-disable-next-line complexity -- bounded graph traversal (visited-set + depth guard) mirroring acpx-ui's walks
export function walkDescendants(
  forest: Forest,
  id: string,
  maxDepth: number | undefined,
): { ids: string[]; clipped: boolean } {
  const result: string[] = [];
  const visited = new Set<string>([id]);
  let frontier = [id];
  let depth = 0;
  let clipped = false;
  while (frontier.length > 0) {
    if (maxDepth !== undefined && depth >= maxDepth) {
      if (frontier.some((nodeId) => (forest.nodes.get(nodeId)?.childIds.length ?? 0) > 0)) {
        clipped = true;
      }
      break;
    }
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const childId of forest.nodes.get(nodeId)?.childIds ?? []) {
        if (!visited.has(childId)) {
          visited.add(childId);
          result.push(childId);
          next.push(childId);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return { ids: result, clipped };
}

/** The whole connected component containing `id` (climb to roots, then BFS down). */
export function walkConnectedComponent(forest: Forest, id: string): string[] {
  const visited = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const node = forest.nodes.get(current);
    if (!node) {
      continue;
    }
    if (node.edgeToParent && !visited.has(node.edgeToParent.parentId)) {
      queue.push(node.edgeToParent.parentId);
    }
    for (const childId of node.childIds) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }
  return [...visited];
}

// ---------------------------------------------------------------------------
// Filter pipeline (§10) + result assembly (§11)
// ---------------------------------------------------------------------------

export type TreeScopeMode = "self" | "session" | "root" | "all" | "active-forest";
export type TreeDirection = "ancestors" | "descendants" | "both";

export type TreeFilters = {
  status?: "open" | "closed";
  sinceMs?: number;
  types?: EdgeType[];
  agentTypes?: string[];
  noSubagents?: boolean;
  live?: boolean;
  name?: string;
  cwd?: string;
  task?: string;
};

export type TreeOptions = {
  scope: TreeScopeMode;
  anchor?: string;
  connected: boolean;
  direction: TreeDirection;
  depth?: number;
  filters: TreeFilters;
  maxNodes: number;
  showLegend: boolean;
  selfFallbackNote?: string;
};

export type NodeStatus = "active" | "open" | "closed";

export type TreeNodeView = {
  id: string;
  shortId: string;
  name?: string;
  title?: string;
  agentType: string;
  kind: string;
  status: NodeStatus;
  closed: boolean;
  live: boolean | null;
  edgeToParent: ParentEdge | null;
  edgeLabel: string;
  createdAt?: string;
  lastUsedAt?: string;
  lastPromptAt?: string;
  age: string;
  cwd?: string;
  taskFolder?: string;
  pid?: number;
  anchor: boolean;
  context: boolean;
  missing: boolean;
  childIds: string[];
};

export type TreeSummary = {
  total: number;
  shown: number;
  roots: number;
  active: number;
  hiddenClosed: number;
  hiddenInactive: number;
  skipped: number;
  truncated: boolean;
  depthClipped: boolean;
};

export type SessionTreeResult = {
  schema: typeof SESSION_TREE_SCHEMA;
  generatedAt: string;
  scope: { mode: TreeScopeMode; anchorId: string | null; depth: number | null; connected: boolean };
  filters: {
    active: boolean;
    open: boolean;
    closed: boolean;
    since: number | null;
    agentType: string[];
    type: EdgeType[];
    noSubagents: boolean;
    name: string | null;
    cwd: string | null;
    task: string | null;
    live: boolean;
  };
  summary: TreeSummary;
  roots: string[];
  nodes: Record<string, TreeNodeView>;
  notes: string[];
  hint: string | null;
  scopeLabel: string;
  showLegend: boolean;
};

function isActive(projection: RawProjection | undefined, nowMs: number): boolean {
  if (!projection || projection.closed) {
    return false;
  }
  const t = projection.lastUsedAt ? Date.parse(projection.lastUsedAt) : Number.NaN;
  return !Number.isNaN(t) && t >= nowMs - DEFAULT_ACTIVE_WINDOW_MS;
}

function statusOf(projection: RawProjection | undefined, nowMs: number): NodeStatus {
  if (projection?.closed) {
    return "closed";
  }
  return isActive(projection, nowMs) ? "active" : "open";
}

/** Resolve an anchor string to a record id (exact id/acpSessionId, then unique suffix). */
export function resolveAnchor(forest: Forest, raw: string): string {
  const needle = raw.trim();
  if (needle.length === 0) {
    throw new SessionTreeError("No anchor session id provided");
  }
  const real = [...forest.nodes.values()].filter((node) => node.projection);
  const exact = real.find((node) => node.id === needle || node.projection?.acpSessionId === needle);
  if (exact) {
    return exact.id;
  }
  // The displayed short id is a prefix (first 8 chars), so accept a unique
  // prefix OR suffix on either id (mirrors the store's own suffix resolution).
  const partial = real.filter((node) => {
    const acp = node.projection?.acpSessionId ?? "";
    return (
      node.id.startsWith(needle) ||
      node.id.endsWith(needle) ||
      acp.startsWith(needle) ||
      acp.endsWith(needle)
    );
  });
  if (partial.length === 1) {
    return partial[0].id;
  }
  if (partial.length > 1) {
    const sample = partial
      .slice(0, 6)
      .map((node) => shortId(node.id))
      .join(", ");
    throw new SessionTreeError(`Session id is ambiguous: ${needle} (matches ${sample}…)`);
  }
  const near = real
    .filter((node) => node.id.includes(needle))
    .slice(0, 6)
    .map((node) => shortId(node.id));
  const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
  throw new SessionTreeError(`No session found for id: ${needle}.${hint}`);
}

/** Agent-type resolver with subagent→parent inheritance, memoised. */
export function makeAgentTypeResolver(forest: Forest): (id: string) => string {
  const cache = new Map<string, string>();
  // eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
  const resolve = (id: string, guard: Set<string>): string => {
    const cached = cache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const node = forest.nodes.get(id);
    const command = node?.projection?.agentCommand ?? "";
    let type: string;
    if (command.trim().length === 0) {
      const parentId = node?.edgeToParent?.parentId;
      if (parentId && !guard.has(id)) {
        guard.add(id);
        type = agentTypeFromCommand(command, resolve(parentId, guard));
      } else {
        type = agentTypeFromCommand(command);
      }
    } else {
      type = agentTypeFromCommand(command);
    }
    cache.set(id, type);
    return type;
  };
  return (id: string) => resolve(id, new Set<string>());
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function matchesStatus(projection: RawProjection, filters: TreeFilters, nowMs: number): boolean {
  if (filters.status === "open" && projection.closed) {
    return false;
  }
  if (filters.status === "closed" && !projection.closed) {
    return false;
  }
  if (filters.sinceMs !== undefined) {
    const t = projection.lastUsedAt ? Date.parse(projection.lastUsedAt) : Number.NaN;
    if (Number.isNaN(t) || t < nowMs - filters.sinceMs) {
      return false;
    }
  }
  return true;
}

function matchesType(node: ForestNode, filters: TreeFilters): boolean {
  if (!filters.types?.length) {
    return true;
  }
  const type = node.edgeToParent?.type;
  return Boolean(type && filters.types.includes(type));
}

function includesCi(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function matchesText(projection: RawProjection, filters: TreeFilters): boolean {
  if (
    filters.name &&
    !includesCi(`${projection.name ?? ""}\n${projection.title ?? ""}`, filters.name)
  ) {
    return false;
  }
  if (filters.cwd && !includesCi(projection.cwd, filters.cwd)) {
    return false;
  }
  if (filters.task && !includesCi(projection.taskFolder, filters.task)) {
    return false;
  }
  return true;
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function matchesPredicates(
  node: ForestNode,
  filters: TreeFilters,
  agentTypeOf: (id: string) => string,
  nowMs: number,
): boolean {
  const projection = node.projection;
  if (!projection) {
    return false;
  }
  return (
    matchesStatus(projection, filters, nowMs) &&
    matchesType(node, filters) &&
    (!filters.agentTypes?.length || filters.agentTypes.includes(agentTypeOf(node.id))) &&
    !(filters.noSubagents && projection.kind === "subagent") &&
    matchesText(projection, filters)
  );
}

function parseTimeMs(iso: string | undefined): number {
  if (!iso) {
    return 0;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function edgeLabelFor(node: ForestNode): string {
  if (node.missing) {
    return "orphan";
  }
  const edge = node.edgeToParent;
  if (!edge) {
    return "root";
  }
  if (edge.type === "fork") {
    return `fork@${edge.forkAtMessageIndex ?? "?"}`;
  }
  return edge.type;
}

function childrenInScope(forest: Forest, id: string, within: Set<string>): string[] {
  return (
    (forest.nodes.get(id)?.childIds ?? [])
      .filter((childId) => within.has(childId))
      // eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
      .toSorted((a, b) => {
        const an = forest.nodes.get(a)?.projection;
        const bn = forest.nodes.get(b)?.projection;
        return (
          parseTimeMs(an?.createdAt ?? an?.lastUsedAt) -
            parseTimeMs(bn?.createdAt ?? bn?.lastUsedAt) || a.localeCompare(b)
        );
      })
  );
}

function sortByRecencyDesc(forest: Forest, ids: string[]): string[] {
  return ids.toSorted(
    (a, b) =>
      parseTimeMs(forest.nodes.get(b)?.projection?.lastUsedAt) -
      parseTimeMs(forest.nodes.get(a)?.projection?.lastUsedAt),
  );
}

function isShownRoot(forest: Forest, id: string, within: Set<string>): boolean {
  const parentId = forest.nodes.get(id)?.edgeToParent?.parentId;
  return !parentId || !within.has(parentId);
}

// eslint-disable-next-line complexity -- scope dispatch (self/session/root/all/connected + direction); flat branches kept inline
function resolveCandidates(
  forest: Forest,
  options: TreeOptions,
): { anchorId: string | null; candidates: Set<string>; depthClipped: boolean } {
  if (options.scope === "all" || options.scope === "active-forest") {
    return { anchorId: null, candidates: new Set(forest.nodes.keys()), depthClipped: false };
  }
  const anchorId = resolveAnchor(forest, options.anchor ?? "");
  const depth = options.depth;
  if (options.connected) {
    return {
      anchorId,
      candidates: new Set(walkConnectedComponent(forest, anchorId)),
      depthClipped: false,
    };
  }
  if (options.scope === "root") {
    const down = walkDescendants(forest, anchorId, depth);
    return { anchorId, candidates: new Set([anchorId, ...down.ids]), depthClipped: down.clipped };
  }
  const candidates = new Set([anchorId]);
  let depthClipped = false;
  if (options.direction !== "descendants") {
    for (const id of walkAncestors(forest, anchorId, depth)) {
      candidates.add(id);
    }
  }
  if (options.direction !== "ancestors") {
    const down = walkDescendants(forest, anchorId, depth);
    depthClipped = down.clipped;
    for (const id of down.ids) {
      candidates.add(id);
    }
  }
  return { anchorId, candidates, depthClipped };
}

async function selectHits(
  forest: Forest,
  candidates: Set<string>,
  options: TreeOptions,
  agentTypeOf: (id: string) => string,
  nowMs: number,
  probeLive?: (id: string) => Promise<boolean>,
): Promise<{ hits: string[]; liveById: Map<string, boolean> }> {
  // Predicate → hit set (only real records can be hits; placeholders never).
  let hits = [...candidates].filter((id) => {
    const node = forest.nodes.get(id);
    return node ? matchesPredicates(node, options.filters, agentTypeOf, nowMs) : false;
  });
  // --live: probed lazily, only for cheap hits (the shown set).
  const liveById = new Map<string, boolean>();
  if (options.filters.live && probeLive) {
    const flags = await mapPool(hits, 12, async (id) => await probeLive(id));
    hits = hits.filter((id, index) => {
      liveById.set(id, flags[index]);
      return flags[index];
    });
  }
  return { hits, liveById };
}

/** Keep each hit's ancestor chain (within scope) as context — deep hits never rootless. */
// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function collectShownIds(forest: Forest, hits: string[], candidates: Set<string>): Set<string> {
  const shownIds = new Set(hits);
  for (const id of hits) {
    const guard = new Set<string>([id]);
    let current = forest.nodes.get(id)?.edgeToParent?.parentId;
    while (current && candidates.has(current) && !guard.has(current)) {
      guard.add(current);
      shownIds.add(current);
      current = forest.nodes.get(current)?.edgeToParent?.parentId;
    }
  }
  return shownIds;
}

/** Cap rendered nodes in BFS order from roots so the cap keeps the most relevant (top) nodes. */
function capByMaxNodes(
  forest: Forest,
  shownIds: Set<string>,
  maxNodes: number,
): { kept: Set<string>; truncated: boolean } {
  const bfs = sortByRecencyDesc(
    forest,
    [...shownIds].filter((id) => isShownRoot(forest, id, shownIds)),
  );
  const kept = new Set<string>();
  let truncated = false;
  for (let k = 0; k < bfs.length; k += 1) {
    const id = bfs[k];
    if (kept.has(id)) {
      continue;
    }
    if (kept.size >= maxNodes) {
      truncated = true;
      break;
    }
    kept.add(id);
    for (const childId of childrenInScope(forest, id, shownIds)) {
      bfs.push(childId);
    }
  }
  return { kept, truncated: truncated || kept.size < shownIds.size };
}

type ViewContext = {
  nowMs: number;
  anchorId: string | null;
  hitSet: Set<string>;
  kept: Set<string>;
  liveById: Map<string, boolean>;
  agentTypeOf: (id: string) => string;
};

function buildNodeView(forest: Forest, id: string, ctx: ViewContext): TreeNodeView {
  const node = forest.nodes.get(id) as ForestNode;
  const projection = node.projection;
  if (node.missing || !projection) {
    return {
      id,
      shortId: shortId(id),
      agentType: "missing",
      kind: "session",
      status: "open",
      closed: false,
      live: null,
      edgeToParent: node.edgeToParent,
      edgeLabel: edgeLabelFor(node),
      age: "?",
      anchor: id === ctx.anchorId,
      context: false,
      missing: true,
      childIds: childrenInScope(forest, id, ctx.kept),
    };
  }
  return {
    id,
    shortId: shortId(id),
    name: projection.name,
    title: projection.title,
    agentType: ctx.agentTypeOf(id),
    kind: projection.kind ?? "session",
    status: statusOf(projection, ctx.nowMs),
    closed: projection.closed,
    live: ctx.liveById.get(id) ?? null,
    edgeToParent: node.edgeToParent,
    edgeLabel: edgeLabelFor(node),
    createdAt: projection.createdAt,
    lastUsedAt: projection.lastUsedAt,
    lastPromptAt: projection.lastPromptAt,
    age: formatAge(ctx.nowMs, projection.lastUsedAt),
    cwd: projection.cwd,
    taskFolder: projection.taskFolder,
    pid: projection.pid,
    anchor: id === ctx.anchorId,
    context: !ctx.hitSet.has(id),
    missing: false,
    childIds: childrenInScope(forest, id, ctx.kept),
  };
}

/**
 * Hidden-count notes — gated on whether the status / recency predicate is what
 * hid them (so they read as a faithful "what was withheld" hint).
 */
function countHidden(
  forest: Forest,
  candidates: Set<string>,
  kept: Set<string>,
  filters: TreeFilters,
  nowMs: number,
): { hiddenClosed: number; hiddenInactive: number } {
  const excluded = [...candidates].filter((id) => {
    const node = forest.nodes.get(id);
    return Boolean(node?.projection) && !kept.has(id);
  });
  const hiddenClosed =
    filters.status === "open"
      ? excluded.filter((id) => forest.nodes.get(id)?.projection?.closed).length
      : 0;
  const sinceMs = filters.sinceMs;
  const hiddenInactive =
    sinceMs === undefined
      ? 0
      : excluded.filter((id) => {
          const projection = forest.nodes.get(id)?.projection;
          return Boolean(
            projection &&
            !projection.closed &&
            parseTimeMs(projection.lastUsedAt) < nowMs - sinceMs,
          );
        }).length;
  return { hiddenClosed, hiddenInactive };
}

type NotesInput = {
  options: TreeOptions;
  hiddenClosed: number;
  hiddenInactive: number;
  truncated: boolean;
  shown: number;
  matchedCount: number;
  depthClipped: boolean;
  skipped: number;
};

// eslint-disable-next-line complexity -- linear list of independent "what was withheld" notices
function buildTreeNotes(input: NotesInput): string[] {
  const notes: string[] = [];
  // Under --all the scope is already the whole forest, so the remedy is to relax
  // the explicit predicate, not "use --all" (which would be a no-op hint).
  const allScope = input.options.scope === "all";
  if (input.options.selfFallbackNote) {
    notes.push(input.options.selfFallbackNote);
  }
  if (input.hiddenClosed > 0) {
    const widen = allScope ? "drop --open/--active" : "use --all";
    notes.push(`+${input.hiddenClosed} closed hidden — ${widen}`);
  }
  if (input.hiddenInactive > 0) {
    const widen = allScope ? "raise or drop --since" : "use --since <dur> or --all";
    notes.push(`+${input.hiddenInactive} open but inactive hidden — ${widen}`);
  }
  if (input.truncated) {
    notes.push(
      `showing ${input.shown} of ${input.matchedCount} matched nodes — narrow with --root <id>/--active or raise --max-nodes`,
    );
  }
  if (input.depthClipped && input.options.depth !== undefined) {
    notes.push(`subtree clipped at depth ${input.options.depth} — raise with --depth N`);
  }
  if (input.skipped > 0) {
    notes.push(`skipped ${input.skipped} unreadable records`);
  }
  return notes;
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function buildFilterSummary(options: TreeOptions): SessionTreeResult["filters"] {
  return {
    active: options.scope === "active-forest",
    open: options.filters.status === "open",
    closed: options.filters.status === "closed",
    since: options.filters.sinceMs ?? null,
    agentType: options.filters.agentTypes ?? [],
    type: options.filters.types ?? [],
    noSubagents: options.filters.noSubagents ?? false,
    name: options.filters.name ?? null,
    cwd: options.filters.cwd ?? null,
    task: options.filters.task ?? null,
    live: options.filters.live ?? false,
  };
}

export async function buildTreeResult(
  forest: Forest,
  totalReal: number,
  skipped: number,
  options: TreeOptions,
  nowMs: number,
  probeLive?: (id: string) => Promise<boolean>,
): Promise<SessionTreeResult> {
  const { anchorId, candidates, depthClipped } = resolveCandidates(forest, options);
  const agentTypeOf = makeAgentTypeResolver(forest);
  const { hits, liveById } = await selectHits(
    forest,
    candidates,
    options,
    agentTypeOf,
    nowMs,
    probeLive,
  );
  const hitSet = new Set(hits);
  const shownIds = collectShownIds(forest, hits, candidates);
  const matchedCount = shownIds.size;
  const { kept, truncated } = capByMaxNodes(forest, shownIds, options.maxNodes);

  const ctx: ViewContext = { nowMs, anchorId, hitSet, kept, liveById, agentTypeOf };
  const nodes: Record<string, TreeNodeView> = {};
  let activeShown = 0;
  for (const id of kept) {
    const view = buildNodeView(forest, id, ctx);
    if (view.status === "active") {
      activeShown += 1;
    }
    nodes[id] = view;
  }
  const finalRoots = sortByRecencyDesc(
    forest,
    [...kept].filter((id) => isShownRoot(forest, id, kept)),
  );

  const { hiddenClosed, hiddenInactive } = countHidden(
    forest,
    candidates,
    kept,
    options.filters,
    nowMs,
  );
  const notes = buildTreeNotes({
    options,
    hiddenClosed,
    hiddenInactive,
    truncated,
    shown: kept.size,
    matchedCount,
    depthClipped,
    skipped,
  });
  const { scopeLabel, hint } = describeScope(options, anchorId, nowMs);

  return {
    schema: SESSION_TREE_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    scope: {
      mode: options.scope,
      anchorId,
      depth: options.depth ?? null,
      connected: options.connected,
    },
    filters: buildFilterSummary(options),
    summary: {
      total: totalReal,
      shown: kept.size,
      roots: finalRoots.length,
      active: activeShown,
      hiddenClosed,
      hiddenInactive,
      skipped,
      truncated,
      depthClipped,
    },
    roots: finalRoots,
    nodes,
    notes,
    hint,
    scopeLabel,
    showLegend: options.showLegend,
  };
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
function describeScope(
  options: TreeOptions,
  anchorId: string | null,
  _nowMs: number,
): { scopeLabel: string; hint: string | null } {
  const connected = options.connected ? " +connected" : "";
  if (options.scope === "self") {
    return {
      scopeLabel: `anchor ${anchorId ? shortId(anchorId) : "?"} (--self)${connected}`,
      hint: null,
    };
  }
  if (options.scope === "session") {
    return {
      scopeLabel: `anchor ${anchorId ? shortId(anchorId) : "?"} (--session)${connected}`,
      hint: null,
    };
  }
  if (options.scope === "root") {
    return { scopeLabel: `root ${anchorId ? shortId(anchorId) : "?"}${connected}`, hint: null };
  }
  if (options.scope === "all") {
    return { scopeLabel: "scope: all", hint: null };
  }
  // active-forest: the bare default is open ∧ <24h; explicit filters relabel it.
  const isBoundedActiveDefault =
    options.filters.status === "open" && options.filters.sinceMs === DEFAULT_ACTIVE_WINDOW_MS;
  if (isBoundedActiveDefault) {
    return {
      scopeLabel: "scope: active (open, last 24h)",
      hint: "showing only active sessions — use --self, --root <id>, --since <dur>, or --all to widen",
    };
  }
  return {
    scopeLabel: "scope: forest (filtered)",
    hint: "use --self, --root <id>, --since <dur>, or --all to change scope",
  };
}

// ---------------------------------------------------------------------------
// IO adapter + projection loading (§7)
// ---------------------------------------------------------------------------

export type FileStat = { mtimeMs: number; size: number };

export type TreeIO = {
  baseDir: string;
  cachePath?: string;
  listSessionFiles: (dir: string) => Promise<string[]>;
  statFile: (filePath: string) => Promise<FileStat | null>;
  openChunks: (filePath: string) => AsyncIterable<string>;
  readCache?: (cachePath: string) => Promise<string | null>;
  writeCache?: (cachePath: string, content: string) => Promise<void>;
  now: () => number;
  probeLive?: (id: string) => Promise<boolean>;
  concurrency?: number;
};

const TREE_CACHE_SCHEMA = "acpx.tree-cache.v1";
type TreeCacheEntry = { mtimeMs: number; size: number; p: RawProjection };

/** Keep `*.json` records; drop `index.json`, dotfiles (incl. the cache), and `*.tmp`. */
export function isSessionRecordFile(name: string): boolean {
  return (
    name.endsWith(".json") &&
    name !== "index.json" &&
    !name.startsWith(".") &&
    !name.endsWith(".tmp")
  );
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
export async function loadProjections(
  io: TreeIO,
): Promise<{ projections: RawProjection[]; skipped: number }> {
  let files: string[];
  try {
    files = await io.listSessionFiles(io.baseDir);
  } catch {
    return { projections: [], skipped: 0 };
  }
  const records = files.filter(isSessionRecordFile);

  const useCache = Boolean(io.cachePath && io.readCache && io.writeCache);
  const cache = new Map<string, TreeCacheEntry>();
  if (useCache) {
    try {
      const text = await io.readCache!(io.cachePath as string);
      if (text) {
        const parsed = JSON.parse(text) as {
          schema?: string;
          entries?: Record<string, TreeCacheEntry>;
        };
        if (parsed.schema === TREE_CACHE_SCHEMA && parsed.entries) {
          for (const [file, entry] of Object.entries(parsed.entries)) {
            if (
              entry &&
              typeof entry.mtimeMs === "number" &&
              typeof entry.size === "number" &&
              entry.p?.id
            ) {
              cache.set(file, entry);
            }
          }
        }
      }
    } catch {
      // best-effort; degrade to a full scan
    }
  }

  const concurrency = io.concurrency ?? 12;
  const newEntries: Record<string, TreeCacheEntry> = {};
  let changed = false;

  // eslint-disable-next-line complexity -- filter/assembly pipeline step; independent guards / flat ?? mapping, max-8 is strict here
  const scanned = await mapPool(records, concurrency, async (file) => {
    const filePath = pathJoin(io.baseDir, file);
    let stat: FileStat | null = null;
    if (useCache) {
      stat = await io.statFile(filePath);
      if (stat) {
        const cached = cache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          newEntries[file] = cached;
          return cached.p;
        }
      }
    }
    try {
      // Fast line scan first (correct for every acpx-written, pretty-printed
      // record). A non-pretty-printed (compact) record — never produced by acpx
      // — yields nothing here, so JSON.parse just that one (small) file; a
      // compact AND pathologically large file is skipped, never silently.
      let projection = await scanProjectionLines(io.openChunks(filePath));
      if (!projection) {
        projection = await scanProjectionFallback(io.openChunks(filePath), MAX_FALLBACK_BYTES);
      }
      if (!projection) {
        return null;
      }
      if (useCache && stat) {
        newEntries[file] = { mtimeMs: stat.mtimeMs, size: stat.size, p: projection };
        changed = true;
      }
      return projection;
    } catch {
      return null;
    }
  });

  const projections: RawProjection[] = [];
  let skipped = 0;
  for (const result of scanned) {
    if (result) {
      projections.push(result);
    } else {
      skipped += 1;
    }
  }

  if (useCache && (changed || Object.keys(newEntries).length !== cache.size)) {
    try {
      await io.writeCache!(
        io.cachePath as string,
        JSON.stringify({ schema: TREE_CACHE_SCHEMA, entries: newEntries }),
      );
    } catch {
      // best-effort
    }
  }

  return { projections, skipped };
}

function pathJoin(dir: string, file: string): string {
  return dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`;
}

export async function buildSessionTree(
  io: TreeIO,
  options: TreeOptions,
): Promise<SessionTreeResult> {
  const { projections, skipped } = await loadProjections(io);
  const forest = buildForest(projections);
  return await buildTreeResult(
    forest,
    projections.length,
    skipped,
    options,
    io.now(),
    io.probeLive,
  );
}
