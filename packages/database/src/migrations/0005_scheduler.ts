import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- One live lease per profile: the primary key makes a second reservation impossible.
    CREATE TABLE profile_leases (
      profile_id UUID PRIMARY KEY REFERENCES profiles(id),
      run_id UUID NOT NULL REFERENCES runs(id),
      owner_agent_id UUID NOT NULL REFERENCES agents(id),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_profile_leases_owner ON profile_leases(owner_agent_id);
    CREATE INDEX idx_profile_leases_expiry ON profile_leases(expires_at);

    -- Operator-set limit of parallel sessions; NULL means the agent's own reported maximum.
    ALTER TABLE agents ADD COLUMN max_sessions INTEGER CHECK (max_sessions >= 0);

    -- Why a run is still QUEUED (shown to the operator).
    ALTER TABLE runs ADD COLUMN queue_reason TEXT;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE runs DROP COLUMN queue_reason;
    ALTER TABLE agents DROP COLUMN max_sessions;
    DROP TABLE profile_leases;
  `.execute(db);
}
