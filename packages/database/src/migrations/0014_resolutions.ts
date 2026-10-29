import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- A run that stopped on an error stays on «Недоработки» until the operator fixes it by hand and says what was done.
    ALTER TABLE runs ADD COLUMN resolved_at TIMESTAMPTZ;
    ALTER TABLE runs ADD COLUMN resolved_note TEXT;
    ALTER TABLE runs ADD COLUMN resolved_by TEXT;
    -- The page when a step failed (failure.json from the agent).
    ALTER TABLE run_steps ADD COLUMN failure_artifact_id UUID REFERENCES artifacts(id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE run_steps DROP COLUMN failure_artifact_id;
    ALTER TABLE runs DROP COLUMN resolved_by;
    ALTER TABLE runs DROP COLUMN resolved_note;
    ALTER TABLE runs DROP COLUMN resolved_at;
  `.execute(db);
}
