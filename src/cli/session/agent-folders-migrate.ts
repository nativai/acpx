// C7 (brick 09197f03) RED STUB — the filesystem migration lands in the green commit.
export type AgentFolderMigrationOptions = {
  pool: string;
  sessionsDir: string;
  apply: boolean;
};

export type AgentFolderMigrationCounts = {
  moved: number;
  removedEmpty: number;
  untouchedSeatless: number;
  unresolved: number;
  ambiguous: number;
  other: number;
  alreadyC7: number;
};

export type AgentFolderMigrationAction = {
  action: "move" | "remove-empty";
  brick: string;
  from: string;
  to?: string;
};

export type AgentFolderMigrationReport = {
  mode: "dry-run" | "apply";
  pool: string;
  sessionsDir: string;
  counts: AgentFolderMigrationCounts;
  actions: AgentFolderMigrationAction[];
};

export async function migrateAgentFolders(
  _options: AgentFolderMigrationOptions,
): Promise<AgentFolderMigrationReport> {
  throw new Error("C7 red stub: migrateAgentFolders is not implemented");
}
