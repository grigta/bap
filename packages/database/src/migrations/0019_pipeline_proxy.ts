import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The row's proxy (ip:port[@login:pass]): LS Clicker binds it to the row's new Linken Sphere profile.
  await sql`ALTER TABLE pipeline_rows ADD COLUMN proxy TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE pipeline_rows DROP COLUMN proxy`.execute(db);
}
