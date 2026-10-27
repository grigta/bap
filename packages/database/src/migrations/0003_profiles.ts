import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      external_profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'AVAILABLE'
        CHECK (status IN ('AVAILABLE', 'RESERVED', 'IN_USE', 'VERIFYING', 'NEEDS_REVIEW', 'DISABLED')),
      -- references runs(id) once the runs table exists (S5)
      active_run_id UUID,
      last_error TEXT,
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, external_profile_id)
    );
    CREATE INDEX idx_profiles_agent_status ON profiles(agent_id, status);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE profiles`.execute(db);
}
