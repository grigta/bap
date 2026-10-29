import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- The operator's own table for «Конвейер» (REQ-UI-012), stored as it came: any columns, one current upload.
    CREATE TABLE pipeline_import (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_name TEXT NOT NULL,
      delimiter TEXT NOT NULL,
      columns JSONB NOT NULL,
      profile_column INT,
      row_count INT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE pipeline_rows (
      import_id UUID NOT NULL REFERENCES pipeline_import(id) ON DELETE CASCADE,
      n INT NOT NULL,
      cells JSONB NOT NULL,
      PRIMARY KEY (import_id, n)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE pipeline_rows; DROP TABLE pipeline_import;`.execute(db);
}
