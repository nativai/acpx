/** B14 owner-side API. Persisted and wire names follow C0's approved schema. */
export type SpawnAttemptState =
  | "reserved"
  | "launched"
  | "published"
  | "adopted"
  | "revoked"
  | "cancelled"
  | "orphaned";

export interface SpawnReservation {
  run_id: string;
  fence: number;
  trigger_id: string;
  parent_brick_id: string;
  child_brick_id: string;
  target_record_id: string;
}

export interface SpawnAttempt extends SpawnReservation {
  idempotency_key: string;
  state: SpawnAttemptState;
  revoked_at: string | null;
  session_url: string | null;
  reserved_at: string;
  settled_at: string | null;
  last_error: string | null;
}

export interface SpawnRun {
  run_id: string;
  trigger_id: string;
  parent_brick_id: string;
  child_brick_id: string;
  adopted_fence: number | null;
  ack_confirmed_at: string | null;
  receipt_conflict: string | null;
  terminal_state: string | null;
  session_id: string | null;
  session_url: string | null;
  updated_at: string;
}

export interface ProjectionTuple {
  session_id: string;
  projection_epoch: number;
  revision: number;
}

export interface LocalDrainInventory {
  outbox_depth: number;
  oldest_unacknowledged: string | null;
  projection_heads: number;
  high_water: ProjectionTuple[];
  dispositioned_prefix: ProjectionTuple[];
  admission_frontier: ProjectionTuple[];
  attempts: Record<SpawnAttemptState, number>;
  runs: { adopted_without_ack_confirmation: number };
  drain: { cutover_id: string; entered_at: string } | null;
}

export interface SpawnTransitionEvidence {
  child_started?: boolean;
  child_gone?: boolean;
  higher_fence?: number;
  session_url?: string;
  reason?: string;
}

export type SpawnChildLiveness = "alive" | "gone" | "unknown";

export interface CentralRunReceipt {
  status: "spawned" | "failed" | "cancelled" | "skipped" | "conflict";
  session_id?: string;
  session_url?: string;
}
