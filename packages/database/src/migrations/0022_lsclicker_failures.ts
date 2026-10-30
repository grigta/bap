import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Every failed LS Clicker run, for «Недоработки»: the error, the whole log, where the engine stood, the screen.
  await sql`
    CREATE TABLE lsclicker_failures (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ NOT NULL,
      import_id UUID REFERENCES pipeline_import(id) ON DELETE SET NULL,
      row_n INT,
      error TEXT NOT NULL,
      log JSONB NOT NULL,
      stage JSONB,
      ls_profile TEXT,
      screenshot_key TEXT,
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      resolved_note TEXT,
      UNIQUE (agent_id, finished_at)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE lsclicker_failures`.execute(db);
}
