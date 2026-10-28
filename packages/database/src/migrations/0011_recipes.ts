import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Recipes are scenarios of a second kind: a JSON solution of a task, recorded on the server (PRD §16).
    ALTER TABLE scenarios ADD COLUMN kind TEXT NOT NULL DEFAULT 'bundle' CHECK (kind IN ('bundle', 'recipe'));
    ALTER TABLE scenarios ADD COLUMN goal TEXT;
    ALTER TABLE scenarios ADD COLUMN start_url TEXT;
    ALTER TABLE scenarios ADD COLUMN inputs JSONB;

    -- A recorded version waits for the operator; only published versions run (REQ-DOM-011).
    ALTER TABLE scenario_versions ADD COLUMN published_at TIMESTAMPTZ DEFAULT now();
    UPDATE scenario_versions SET published_at = created_at;
    ALTER TABLE scenario_versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'bundle' CHECK (origin IN ('bundle', 'manual', 'recorded', 'healed'));
    ALTER TABLE scenario_versions ADD COLUMN source_run_id UUID;
    ALTER TABLE scenario_versions ADD COLUMN parent_version TEXT;
    ALTER TABLE scenario_versions ADD COLUMN note TEXT;

    -- A recording run has no version yet: it produces one.
    ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'record'));
    ALTER TABLE runs ALTER COLUMN scenario_version DROP NOT NULL;
    ALTER TABLE runs ADD CONSTRAINT runs_version_required CHECK (kind = 'record' OR scenario_version IS NOT NULL);

    -- How each step went: found, healed (with the reason), confirmed by the operator, recorded (REQ-DOM-012).
    ALTER TABLE run_steps ADD COLUMN intent TEXT;
    ALTER TABLE run_steps ADD COLUMN resolution TEXT CHECK (resolution IN ('found', 'healed', 'confirmed', 'recorded'));
    ALTER TABLE run_steps ADD COLUMN note TEXT;

    -- Server side of a recording: the steps so far and the action waiting for the operator.
    CREATE TABLE recordings (
      run_id UUID PRIMARY KEY REFERENCES runs(id),
      steps JSONB NOT NULL DEFAULT '[]',
      history JSONB NOT NULL DEFAULT '[]',
      pending JSONB,
      pending_state TEXT CHECK (pending_state IN ('awaiting', 'confirmed', 'rejected')),
      result_version TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- New targets chosen while healing; a successful run turns them into the next recipe version.
    CREATE TABLE heals (
      id BIGSERIAL PRIMARY KEY,
      run_id UUID NOT NULL REFERENCES runs(id),
      scenario_version TEXT NOT NULL,
      step_id TEXT NOT NULL,
      target JSONB NOT NULL,
      note TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_heals_run ON heals(run_id);

    -- Model calls, for limits and the server's own accounting; never shown in the panel (ADR-0025).
    CREATE TABLE llm_calls (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      purpose TEXT NOT NULL CHECK (purpose IN ('record', 'heal')),
      run_id UUID NOT NULL,
      model TEXT,
      ok BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      cost_usd NUMERIC(12, 6),
      input_tokens INTEGER,
      output_tokens INTEGER,
      error TEXT
    );
    CREATE INDEX idx_llm_calls_run ON llm_calls(run_id, purpose);
    CREATE INDEX idx_llm_calls_at ON llm_calls(at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE llm_calls, heals, recordings;
    ALTER TABLE run_steps DROP COLUMN note, DROP COLUMN resolution, DROP COLUMN intent;
    DELETE FROM runs WHERE kind = 'record';
    ALTER TABLE runs DROP CONSTRAINT runs_version_required;
    ALTER TABLE runs ALTER COLUMN scenario_version SET NOT NULL;
    ALTER TABLE runs DROP COLUMN kind;
    ALTER TABLE scenario_versions DROP COLUMN note, DROP COLUMN parent_version, DROP COLUMN source_run_id, DROP COLUMN origin, DROP COLUMN published_at;
    ALTER TABLE scenarios DROP COLUMN inputs, DROP COLUMN start_url, DROP COLUMN goal, DROP COLUMN kind;
  `.execute(db);
}
