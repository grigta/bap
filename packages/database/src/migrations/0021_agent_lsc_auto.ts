import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The operator's tick: this Mac takes table rows for LS Clicker by itself as soon as they are ready.
  await sql`ALTER TABLE agents ADD COLUMN lsc_auto BOOLEAN NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE agents DROP COLUMN lsc_auto`.execute(db);
}
