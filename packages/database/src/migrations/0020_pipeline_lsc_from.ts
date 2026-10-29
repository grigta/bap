import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // LS Clicker takes rows from this number on; rows above it are history and never run. NULL: from the first row.
  await sql`ALTER TABLE pipeline_import ADD COLUMN lsc_from INTEGER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE pipeline_import DROP COLUMN lsc_from`.execute(db);
}
