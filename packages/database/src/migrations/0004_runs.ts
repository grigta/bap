import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE scenarios (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE scenario_versions (
      scenario_id TEXT NOT NULL REFERENCES scenarios(id),
      version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bundle_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scenario_id, version)
    );

    CREATE TABLE runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_id TEXT NOT NULL,
      scenario_version TEXT NOT NULL,
      profile_id UUID NOT NULL REFERENCES profiles(id),
      agent_id UUID NOT NULL REFERENCES agents(id),
      input JSONB NOT NULL,
      timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
        'QUEUED', 'ASSIGNED', 'ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED', 'RECOVERY_PENDING',
        'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      FOREIGN KEY (scenario_id, scenario_version) REFERENCES scenario_versions(scenario_id, version)
    );
    CREATE INDEX idx_runs_status ON runs(status, created_at DESC);
    CREATE INDEX idx_runs_agent ON runs(agent_id, status);

    -- Journal of every status change, written in the same transaction as the change.
    CREATE TABLE run_transitions (
      id BIGSERIAL PRIMARY KEY,
      run_id UUID NOT NULL REFERENCES runs(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_run_transitions_run ON run_transitions(run_id, id);

    CREATE TABLE run_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES runs(id),
      agent_id UUID NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempt INTEGER NOT NULL DEFAULT 1,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      acknowledged_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX idx_assignments_run ON run_assignments(run_id, assigned_at);

    CREATE TABLE artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES runs(id),
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, name)
    );

    CREATE TABLE run_steps (
      run_id UUID NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      mutating BOOLEAN NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'unverified')),
      started_at TIMESTAMPTZ NOT NULL,
      duration_ms INTEGER NOT NULL,
      error TEXT,
      screenshot_artifact_id UUID REFERENCES artifacts(id),
      PRIMARY KEY (run_id, sequence)
    );

    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      run_id UUID NOT NULL REFERENCES runs(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE profiles ADD CONSTRAINT profiles_active_run_fk FOREIGN KEY (active_run_id) REFERENCES runs(id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE profiles DROP CONSTRAINT profiles_active_run_fk;
    DROP TABLE idempotency_keys, run_steps, artifacts, run_assignments, run_transitions, runs, scenario_versions, scenarios;
  `.execute(db);
}
