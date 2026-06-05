import path from "node:path";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { AgentSessionListResult, OutputFormat, SessionRecord } from "../../types.js";
import { probeQueueOwnerHealth } from "../queue/ipc.js";
import type { SessionTreeResult, TreeNodeView } from "../session/session-tree.js";
import { emitJsonResult } from "./json-output.js";

function formatSessionLabel(record: SessionRecord): string {
  return record.name ?? "cwd";
}

function formatRoutedFrom(sessionCwd: string, currentCwd: string): string | undefined {
  const relative = path.relative(sessionCwd, currentCwd);
  if (!relative || relative === ".") {
    return undefined;
  }
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`;
}

type SessionConnectionStatus = "connected" | "needs reconnect";

async function resolveSessionConnectionStatus(
  record: SessionRecord,
): Promise<SessionConnectionStatus> {
  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  return health.healthy ? "connected" : "needs reconnect";
}

export function printSessionsByFormat(sessions: SessionRecord[], format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietSessions(sessions);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No sessions\n");
    return;
  }

  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(
      `${session.acpxRecordId}${closedMarker}\t${session.name ?? "-"}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

function printQuietSessions(sessions: SessionRecord[]): void {
  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(`${session.acpxRecordId}${closedMarker}\n`);
  }
}

export function printAgentSessionsByFormat(
  result: AgentSessionListResult,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietAgentSessions(result);
    return;
  }

  printTextAgentSessions(result);
}

function printQuietAgentSessions(result: AgentSessionListResult): void {
  for (const session of result.sessions) {
    process.stdout.write(`${session.sessionId}\n`);
  }
}

function printTextAgentSessions(result: AgentSessionListResult): void {
  if (result.sessions.length === 0) {
    process.stdout.write("No sessions\n");
  } else {
    for (const session of result.sessions) {
      const title = session.title ?? "-";
      const updatedAt = session.updatedAt ?? "-";
      const meta = session._meta ? JSON.stringify(session._meta) : "-";
      process.stdout.write(
        `${session.sessionId}\t${title}\t${session.cwd}\t${updatedAt}\t${meta}\n`,
      );
    }
  }

  if (result.nextCursor) {
    process.stdout.write(`Next cursor: ${result.nextCursor}\n`);
  }
}

export function printClosedSessionByFormat(record: SessionRecord, format: OutputFormat): void {
  if (
    emitJsonResult(format, {
      action: "session_closed",
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printNewSessionByFormat(
  record: SessionRecord,
  replaced: SessionRecord | undefined,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created: true,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
      replacedSessionId: replaced?.acpxRecordId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  if (replaced) {
    process.stdout.write(`${record.acpxRecordId}\t(replaced ${replaced.acpxRecordId})\n`);
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printEnsuredSessionByFormat(
  record: SessionRecord,
  created: boolean,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  const action = created ? "created" : "existing";
  process.stdout.write(`${record.acpxRecordId}\t(${action})\n`);
}

export function printQueuedPromptByFormat(
  result: {
    sessionId: string;
    requestId: string;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "prompt_queued",
      acpxRecordId: result.sessionId,
      requestId: result.requestId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`[queued] ${result.requestId}\n`);
}

export function formatPromptSessionBannerLine(
  record: SessionRecord,
  currentCwd: string,
  connectionStatus: SessionConnectionStatus = "needs reconnect",
): string {
  const label = formatSessionLabel(record);
  const normalizedSessionCwd = path.resolve(record.cwd);
  const normalizedCurrentCwd = path.resolve(currentCwd);
  const routedFrom =
    normalizedSessionCwd === normalizedCurrentCwd
      ? undefined
      : formatRoutedFrom(normalizedSessionCwd, normalizedCurrentCwd);
  const status = connectionStatus;

  if (routedFrom) {
    return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd} (routed from ${routedFrom}) · agent ${status}`;
  }

  return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd} · agent ${status}`;
}

export async function printPromptSessionBanner(
  record: SessionRecord,
  currentCwd: string,
  format: OutputFormat,
  jsonStrict = false,
): Promise<void> {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const status = await resolveSessionConnectionStatus(record);
  process.stderr.write(`${formatPromptSessionBannerLine(record, currentCwd, status)}\n`);
}

export function printCreatedSessionBanner(
  record: SessionRecord,
  agentName: string,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const label = formatSessionLabel(record);
  process.stderr.write(`[acpx] created session ${label} (${record.acpxRecordId})\n`);
  process.stderr.write(`[acpx] agent: ${agentName}\n`);
  process.stderr.write(`[acpx] cwd: ${record.cwd}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function printPruneResultByFormat(
  result: { pruned: SessionRecord[]; bytesFreed: number; dryRun: boolean },
  format: OutputFormat,
): void {
  const count = result.pruned.length;

  if (emitPruneJsonResult(result, format, count)) {
    return;
  }

  if (format === "quiet") {
    printQuietPruneResult(result.pruned);
    return;
  }

  if (count === 0) {
    process.stdout.write(
      result.dryRun ? "[DRY RUN] No sessions to prune\n" : "No sessions pruned\n",
    );
    return;
  }

  process.stdout.write(`${formatPruneSummaryLine(result, count)}\n`);

  for (const record of result.pruned) {
    const label = record.name ? ` (${record.name})` : "";
    process.stdout.write(
      `  ${record.acpxRecordId}${label}\t${record.closedAt ?? record.lastUsedAt}\n`,
    );
  }
}

function emitPruneJsonResult(
  result: { pruned: SessionRecord[]; bytesFreed: number; dryRun: boolean },
  format: OutputFormat,
  count: number,
): boolean {
  return emitJsonResult(format, {
    action: result.dryRun ? "sessions_prune_dry_run" : "sessions_pruned",
    dryRun: result.dryRun,
    count,
    bytesFreed: result.bytesFreed,
    pruned: result.pruned.map((r) => r.acpxRecordId),
  });
}

function printQuietPruneResult(pruned: SessionRecord[]): void {
  for (const record of pruned) {
    process.stdout.write(`${record.acpxRecordId}\n`);
  }
}

function formatPruneSummaryLine(
  result: { bytesFreed: number; dryRun: boolean },
  count: number,
): string {
  const prefix = result.dryRun ? "[DRY RUN] Would prune" : "Pruned";
  const bytesSuffix =
    !result.dryRun && result.bytesFreed > 0 ? `, freed ${formatBytes(result.bytesFreed)}` : "";
  return `${prefix} ${count} session${count === 1 ? "" : "s"}${bytesSuffix}`;
}

// ---------------------------------------------------------------------------
// `sessions tree` rendering
// ---------------------------------------------------------------------------

export function printSessionTreeByFormat(result: SessionTreeResult, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "quiet") {
    for (const id of treePreOrder(result)) {
      process.stdout.write(`${id}\n`);
    }
    return;
  }
  printSessionTreeText(result);
}

function treePreOrder(result: SessionTreeResult): string[] {
  const order: string[] = [];
  const visit = (id: string): void => {
    const node = result.nodes[id];
    if (!node || order.includes(id)) {
      return;
    }
    order.push(id);
    for (const childId of node.childIds) {
      visit(childId);
    }
  };
  for (const rootId of result.roots) {
    visit(rootId);
  }
  return order;
}

function printSessionTreeText(result: SessionTreeResult): void {
  const { summary } = result;
  const activeSuffix = result.scope.mode === "active-forest" ? "" : ` · active ${summary.active}`;
  process.stdout.write(
    `session tree · ${result.scopeLabel} · showing ${summary.shown} of ${summary.total} · roots ${summary.roots}${activeSuffix}\n`,
  );
  if (result.hint) {
    process.stdout.write(`hint: ${result.hint}\n`);
  }
  process.stdout.write("\n");

  const selfScope = result.scope.mode === "self";
  if (summary.shown === 0) {
    process.stdout.write("(no matching sessions)\n");
  } else {
    for (const rootId of result.roots) {
      renderTreeNode(result, rootId, "", true, true, selfScope);
    }
  }

  if (result.showLegend) {
    process.stdout.write("\n");
    process.stdout.write(
      "legend: ● anchor (you, with --self) · · context · (spawn|fork@idx|subagent) edge to parent · age = since last activity\n",
    );
    if (result.notes.length > 0) {
      process.stdout.write(`notes: ${result.notes.join(" · ")}\n`);
    }
  }
}

function renderTreeNode(
  result: SessionTreeResult,
  id: string,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  selfScope: boolean,
): void {
  const node = result.nodes[id];
  if (!node) {
    return;
  }
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  process.stdout.write(`${prefix}${connector}${formatTreeRow(node, selfScope)}\n`);

  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
  const children = node.childIds;
  for (let i = 0; i < children.length; i += 1) {
    renderTreeNode(result, children[i], childPrefix, i === children.length - 1, false, selfScope);
  }
}

// eslint-disable-next-line complexity -- flat column assembly (marker/name/status/age/edge); ternary-dense by nature
function formatTreeRow(node: TreeNodeView, selfScope: boolean): string {
  const marker = node.anchor ? "● " : node.context ? "· " : "";
  const rawName = node.missing ? "(orphan)" : (node.name ?? node.title ?? "-");
  const name = truncate(rawName, 28);
  const statusCol = node.live === true ? `${node.status} live` : node.status;
  const location = shortenLocation(node.cwd, node.taskFolder);
  const youSuffix = node.anchor && selfScope ? " ← you" : "";
  return [
    `${marker}${node.shortId}`,
    padEnd(name, 28),
    padEnd(node.agentType, 8),
    padEnd(statusCol, 11),
    padEnd(node.age, 4),
    location,
    `(${node.edgeLabel}${youSuffix})`,
  ].join("  ");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function shortenLocation(cwd: string | undefined, taskFolder: string | undefined): string {
  const value = cwd ?? taskFolder ?? "";
  if (value.length === 0) {
    return "-";
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (value.length <= 30 || segments.length <= 1) {
    return value;
  }
  return `/…/${segments[segments.length - 1]}`;
}

export function agentSessionIdPayload(agentSessionId: string | undefined): {
  agentSessionId?: string;
} {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return {};
  }

  return { agentSessionId: normalized };
}
