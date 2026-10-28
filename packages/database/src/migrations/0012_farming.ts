import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- A warm-up session is a run of a third kind; its scenario is built into the agent (PRD §17).
    ALTER TABLE scenarios DROP CONSTRAINT scenarios_kind_check;
    ALTER TABLE scenarios ADD CONSTRAINT scenarios_kind_check CHECK (kind IN ('bundle', 'recipe', 'farm'));
    INSERT INTO scenarios (id, kind) VALUES ('farm', 'farm') ON CONFLICT (id) DO NOTHING;
    ALTER TABLE runs DROP CONSTRAINT runs_kind_check;
    ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('run', 'record', 'farm'));
    ALTER TABLE runs DROP CONSTRAINT runs_version_required;
    ALTER TABLE runs ADD CONSTRAINT runs_version_required CHECK (kind <> 'run' OR scenario_version IS NOT NULL);

    -- A profile goes to recipes after enough successful warm-ups; failures in a row send it to review.
    ALTER TABLE profiles ADD COLUMN warmups INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE profiles ADD COLUMN warmup_failures INTEGER NOT NULL DEFAULT 0;

    -- Panel settings, one JSON value per key.
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE settings;
    ALTER TABLE profiles DROP COLUMN warmup_failures, DROP COLUMN warmups;
    DELETE FROM run_transitions WHERE run_id IN (SELECT id FROM runs WHERE kind = 'farm');
    DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE kind = 'farm');
    DELETE FROM runs WHERE kind = 'farm';
    ALTER TABLE runs DROP CONSTRAINT runs_version_required;
    ALTER TABLE runs ADD CONSTRAINT runs_version_required CHECK (kind = 'record' OR scenario_version IS NOT NULL);
    ALTER TABLE runs DROP CONSTRAINT runs_kind_check;
    ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('run', 'record'));
    DELETE FROM scenarios WHERE id = 'farm';
    ALTER TABLE scenarios DROP CONSTRAINT scenarios_kind_check;
    ALTER TABLE scenarios ADD CONSTRAINT scenarios_kind_check CHECK (kind IN ('bundle', 'recipe'));
  `.execute(db);
}
