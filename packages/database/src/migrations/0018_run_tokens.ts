import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- LS Clicker calls its providers through the server with a token of its run (ADR-0035); only the hash is kept.
    CREATE TABLE lsclicker_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id UUID NOT NULL REFERENCES agents(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX lsclicker_tokens_expiry ON lsclicker_tokens (expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE lsclicker_tokens`.execute(db);
}
