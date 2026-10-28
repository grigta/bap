import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Messages the agent delivered again and the server discarded (REQ-PROTO-005): proof that redelivery happened.
  await sql`ALTER TABLE agents ADD COLUMN duplicate_messages INTEGER NOT NULL DEFAULT 0`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE agents DROP COLUMN duplicate_messages`.execute(db);
}
