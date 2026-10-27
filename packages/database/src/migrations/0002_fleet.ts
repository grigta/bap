import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE agents ADD COLUMN last_heartbeat JSONB;

    CREATE TABLE agent_enrollments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      agent_id UUID REFERENCES agents(id),
      created_by UUID NOT NULL REFERENCES operators(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE agent_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id),
      key_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE agent_capabilities (
      agent_id UUID PRIMARY KEY REFERENCES agents(id),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE agent_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id),
      epoch BIGINT NOT NULL,
      sequence BIGINT NOT NULL,
      message_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      sent_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, epoch, sequence)
    );
    CREATE INDEX idx_agent_events_agent_type ON agent_events(agent_id, event_type, received_at DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE agent_events, agent_capabilities, agent_credentials, agent_enrollments;
    ALTER TABLE agents DROP COLUMN last_heartbeat;
  `.execute(db);
}
