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
  status: Generated<string>;
  current_epoch: Generated<string>;
  agent_version: string | null;
  last_seen_at: Timestamp | null;
  last_heartbeat: unknown | null;
  max_sessions: number | null;
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
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type RunStatus =
  | "QUEUED" | "ASSIGNED" | "ACCEPTED" | "RUNNING" | "CANCEL_REQUESTED" | "RECOVERY_PENDING"
  | "NEEDS_REVIEW" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ScenariosTable {
  id: string;
  created_at: Timestamp;
}

export interface ScenarioVersionsTable {
  scenario_id: string;
  version: string;
  sha256: string;
  bundle_key: string;
  created_at: Timestamp;
}

export interface RunsTable {
  id: Generated<string>;
  scenario_id: string;
  scenario_version: string;
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
  operators: OperatorsTable;
  operator_sessions: OperatorSessionsTable;
  api_tokens: ApiTokensTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }) });
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
