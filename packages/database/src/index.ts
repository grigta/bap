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
