import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      architecture TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DRAINING', 'DISABLED', 'REVOKED')),
      current_epoch BIGINT NOT NULL DEFAULT 0,
      agent_version TEXT,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_agents_status ON agents(status, last_seen_at);

    CREATE TABLE operators (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE operator_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE api_tokens, operator_sessions, operators, agents`.execute(db);
}
