import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import pg from "pg";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface AgentsTable {
  id: Generated<string>;
  name: string;
  platform: string;
  architecture: string;
  model: string | null;
  status: Generated<string>;
  current_epoch: Generated<string>;
  agent_version: string | null;
  last_seen_at: Timestamp | null;
  last_heartbeat: unknown | null;
  max_sessions: number | null;
  duplicate_messages: Generated<number>;
  updatable: Generated<boolean>;
  /** Set when a revoked agent is deleted: hidden everywhere, kept for history. */
  deleted_at: Timestamp | null;
  created_at: Timestamp;
}

export interface AgentEnrollmentsTable {
  id: Generated<string>;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  agent_id: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface AgentCredentialsTable {
  id: Generated<string>;
  agent_id: string;
  key_hash: string;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface AgentCapabilitiesTable {
  agent_id: string;
  payload: unknown;
  updated_at: Timestamp;
}

export interface AgentEventsTable {
  id: Generated<string>;
  agent_id: string;
  epoch: string | number;
  sequence: string | number;
  message_id: string;
  event_type: string;
  payload: unknown;
  sent_at: Timestamp;
  received_at: Timestamp;
}

export type ProfileStatus = "AVAILABLE" | "RESERVED" | "IN_USE" | "VERIFYING" | "NEEDS_REVIEW" | "DISABLED";

export interface ProfilesTable {
  id: Generated<string>;
  provider: string;
  external_profile_id: string;
  name: string;
  agent_id: string;
  status: ColumnType<ProfileStatus, ProfileStatus | undefined, ProfileStatus>;
  active_run_id: string | null;
  last_error: string | null;
  last_verified_at: Timestamp | null;
  /** Set when its agent is deleted. */
  archived_at: Timestamp | null;
  /** Successful warm-up sessions, and failed ones in a row (PRD §17). */
  warmups: Generated<number>;
  warmup_failures: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_at: Generated<Timestamp>;
}

export type RunStatus =
  | "QUEUED" | "ASSIGNED" | "ACCEPTED" | "RUNNING" | "CANCEL_REQUESTED" | "RECOVERY_PENDING"
  | "NEEDS_REVIEW" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ScenariosTable {
  id: string;
  kind: Generated<"bundle" | "recipe" | "farm">;
  /** Recipes: the task in words, where it starts and its inputs. */
  goal: string | null;
  start_url: string | null;
  inputs: unknown | null;
  created_at: Timestamp;
}

export interface ScenarioVersionsTable {
  scenario_id: string;
  version: string;
  sha256: string;
  bundle_key: string;
  /** null: a recorded recipe version waiting for the operator. */
  published_at: Timestamp | null;
  origin: Generated<"bundle" | "manual" | "recorded" | "healed">;
  source_run_id: string | null;
  parent_version: string | null;
  note: string | null;
  created_at: Timestamp;
}

export interface RunsTable {
  id: Generated<string>;
  scenario_id: string;
  /** null only for a recording, which produces a version. */
  scenario_version: string | null;
  kind: Generated<"run" | "record" | "farm">;
  profile_id: string;
  agent_id: string;
  input: unknown;
  timeout_ms: number;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  error_code: string | null;
  error_message: string | null;
  queue_reason: string | null;
  auto_resume: boolean | null;
  resume_requested: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  resolved_at: Timestamp | null;
  resolved_note: string | null;
  resolved_by: string | null;
}

export interface RemoteSessionsTable {
  id: Generated<string>;
  profile_id: string;
  agent_id: string;
  run_id: string | null;
  opened_by: string | null;
  opened_at: Timestamp;
  ended_at: Timestamp | null;
  end_reason: string | null;
  urls: Generated<unknown>;
}

export interface PipelineImportTable {
  id: Generated<string>;
  file_name: string;
  delimiter: string;
  columns: unknown;
  profile_column: number | null;
  row_count: number;
  created_by: string | null;
  created_at: Timestamp;
}

export interface PipelineRowsTable {
  import_id: string;
  n: number;
  cells: unknown;
}

export interface LsClickerQueueTable {
  agent_id: string;
  position: number;
  import_id: string | null;
  row_n: number | null;
  sent_at: Generated<Timestamp>;
}

export interface LsClickerResultsTable {
  agent_id: string;
  position: number;
  header: unknown;
  cells: unknown;
  updated_at: Generated<Timestamp>;
}

export interface LsClickerMacsTable {
  agent_id: string;
  output_hash: string | null;
}

export interface RunTransitionsTable {
  id: Generated<string>;
  run_id: string;
  from_status: RunStatus | null;
  to_status: RunStatus;
  reason: string | null;
  at: Timestamp;
}

export interface RunAssignmentsTable {
  id: Generated<string>;
  run_id: string;
  agent_id: string;
  status: Generated<string>;
  attempt: Generated<number>;
  assigned_at: Timestamp;
  acknowledged_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface ArtifactsTable {
  id: Generated<string>;
  run_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  created_at: Timestamp;
}

export interface RunStepsTable {
  run_id: string;
  sequence: number;
  step_id: string;
  mutating: boolean;
  status: "passed" | "failed" | "unverified";
  started_at: Timestamp;
  duration_ms: number;
  error: string | null;
  screenshot_artifact_id: string | null;
  failure_artifact_id: string | null;
  intent: string | null;
  resolution: "found" | "healed" | "confirmed" | "recorded" | null;
  note: string | null;
}

export interface RecordingsTable {
  run_id: string;
  steps: Generated<unknown>;
  history: Generated<unknown>;
  pending: unknown | null;
  pending_state: "awaiting" | "confirmed" | "rejected" | null;
  result_version: string | null;
  updated_at: Timestamp;
}

export interface HealsTable {
  id: Generated<string>;
  run_id: string;
  scenario_version: string;
  step_id: string;
  target: unknown;
  note: string;
  at: Timestamp;
}

export interface LlmCallsTable {
  id: Generated<string>;
  at: Timestamp;
  purpose: "record" | "heal";
  run_id: string;
  model: string | null;
  ok: boolean;
  duration_ms: number;
  cost_usd: number | string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
}

export interface IdempotencyKeysTable {
  key: string;
  request_hash: string;
  run_id: string;
  created_at: Timestamp;
}

export interface CheckpointsTable {
  run_id: string;
  sequence: number;
  step_id: string;
  next_step_id: string | null;
  next_step_mutating: boolean;
  auto_resume: boolean;
  created_at: Timestamp;
}

export interface ProfileLeasesTable {
  profile_id: string;
  run_id: string;
  owner_agent_id: string;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  at: Timestamp;
  actor: string;
  action: string;
  outcome: "ok" | "denied";
  target_type: string | null;
  target_id: string | null;
  details: unknown;
  request_id: string | null;
}

export interface OperatorsTable {
  id: Generated<string>;
  login: string;
  password_hash: string;
  created_at: Timestamp;
}

export interface OperatorSessionsTable {
  id: Generated<string>;
  operator_id: string;
  token_hash: string;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface ApiTokensTable {
  id: Generated<string>;
  operator_id: string;
  name: string;
  token_hash: string;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface Database {
  agents: AgentsTable;
  agent_enrollments: AgentEnrollmentsTable;
  agent_credentials: AgentCredentialsTable;
  agent_capabilities: AgentCapabilitiesTable;
  agent_events: AgentEventsTable;
  profiles: ProfilesTable;
  scenarios: ScenariosTable;
  scenario_versions: ScenarioVersionsTable;
  runs: RunsTable;
  run_transitions: RunTransitionsTable;
  run_assignments: RunAssignmentsTable;
  artifacts: ArtifactsTable;
  run_steps: RunStepsTable;
  idempotency_keys: IdempotencyKeysTable;
  profile_leases: ProfileLeasesTable;
  checkpoints: CheckpointsTable;
  audit_events: AuditEventsTable;
  operators: OperatorsTable;
  operator_sessions: OperatorSessionsTable;
  api_tokens: ApiTokensTable;
  recordings: RecordingsTable;
  heals: HealsTable;
  llm_calls: LlmCallsTable;
  settings: SettingsTable;
  remote_sessions: RemoteSessionsTable;
  pipeline_import: PipelineImportTable;
  pipeline_rows: PipelineRowsTable;
  lsclicker_queue: LsClickerQueueTable;
  lsclicker_results: LsClickerResultsTable;
  lsclicker_macs: LsClickerMacsTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string): Db {
  // Without a connect timeout a request waits forever for a database that is gone.
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
  // A client losing its connection emits "error" (the pool listens only while it is idle); unhandled,
  // that kills the process. The query in flight fails on its own, and the pool discards the client.
  const lost = (e: Error) => console.error(`postgres: connection lost: ${e.message}`);
  pool.on("error", lost);
  pool.on("connect", (client) => client.on("error", lost));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** The error means the database cannot be reached right now (as opposed to a bad query). */
export function isDatabaseUnavailable(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  // 08xxx: connection exceptions; 57P0x: server shutting down or restarting.
  if (typeof err.code === "string" && (/^08/.test(err.code) || /^57P0/.test(err.code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(err.code))) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(err.message ?? "");
}

/** Applies all pending migrations; throws on the first failure. Returns names of applied migrations. */
export async function migrateToLatest(db: Db): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: path.join(import.meta.dirname, "migrations") }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).map((r) => r.migrationName);
}
