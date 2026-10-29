import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The Mac as people call it ("MacBook Air · Apple M5 · 16 GB"), reported on every hello.
  await sql`ALTER TABLE agents ADD COLUMN model TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE agents DROP COLUMN model`.execute(db);
}
