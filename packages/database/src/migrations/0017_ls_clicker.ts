import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Rows of the operator's table sent to a Mac's LS Clicker (ADR-0034). position is the row's index in
    -- that Mac's input.csv: rows are only appended, and output.csv row N is the result of input row N.
    CREATE TABLE lsclicker_queue (
      agent_id UUID NOT NULL REFERENCES agents(id),
      position INT NOT NULL,
      import_id UUID REFERENCES pipeline_import(id) ON DELETE SET NULL,
      row_n INT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, position)
    );
    CREATE UNIQUE INDEX lsclicker_queue_row ON lsclicker_queue (import_id, row_n) WHERE import_id IS NOT NULL;
    -- output.csv of each Mac as it came, row by row.
    CREATE TABLE lsclicker_results (
      agent_id UUID NOT NULL REFERENCES agents(id),
      position INT NOT NULL,
      header JSONB NOT NULL,
      cells JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, position)
    );
    CREATE TABLE lsclicker_macs (
      agent_id UUID PRIMARY KEY REFERENCES agents(id),
      output_hash TEXT
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE lsclicker_macs; DROP TABLE lsclicker_results; DROP TABLE lsclicker_queue;`.execute(db);
}
