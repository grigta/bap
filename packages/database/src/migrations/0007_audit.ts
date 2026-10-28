import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Administrative actions and rejected access attempts (REQ-SEC-012). Never stores secrets.
    CREATE TABLE audit_events (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied')),
      target_type TEXT,
      target_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT
    );
    CREATE INDEX idx_audit_events_at ON audit_events(at DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE audit_events`.execute(db);
}
