import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- The operator works in a profile's browser from «Недоработки» (REQ-UI-011). Typed text is never stored.
    CREATE TABLE remote_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id UUID NOT NULL REFERENCES profiles(id),
      agent_id UUID NOT NULL REFERENCES agents(id),
      run_id UUID REFERENCES runs(id),
      opened_by TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      end_reason TEXT,
      urls JSONB NOT NULL DEFAULT '[]'
    );
    -- One person at a time in a profile's browser.
    CREATE UNIQUE INDEX remote_sessions_one_open ON remote_sessions (profile_id) WHERE ended_at IS NULL;
    CREATE INDEX remote_sessions_run ON remote_sessions (run_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE remote_sessions`.execute(db);
}
