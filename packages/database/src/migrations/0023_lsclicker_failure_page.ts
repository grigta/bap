import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The engine's dump of the page it stopped on: its parsed controls, the page as an image and its HTML.
  await sql`ALTER TABLE lsclicker_failures ADD COLUMN page JSONB, ADD COLUMN page_screenshot_key TEXT, ADD COLUMN html_key TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE lsclicker_failures DROP COLUMN page, DROP COLUMN page_screenshot_key, DROP COLUMN html_key`.execute(db);
}
