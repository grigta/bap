import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Installed agents replace themselves with the server's build; agents run from a repository do not.
  await sql`ALTER TABLE agents ADD COLUMN updatable BOOLEAN NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE agents DROP COLUMN updatable`.execute(db);
}
