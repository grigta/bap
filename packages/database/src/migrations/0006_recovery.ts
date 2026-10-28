import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Agents resend unacknowledged events after a reconnect, in a new epoch: the message id deduplicates them.
    CREATE UNIQUE INDEX agent_events_message_unique ON agent_events(agent_id, message_id);

    -- Server copy of the agent's checkpoints (PRD §8.1); the full state stays on the agent.
    CREATE TABLE checkpoints (
      run_id UUID NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      next_step_id TEXT,
      next_step_mutating BOOLEAN NOT NULL,
      auto_resume BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );

    ALTER TABLE runs ADD COLUMN auto_resume BOOLEAN;
    -- Set while a resumed run waits in the queue: the agent continues from its checkpoint.
    ALTER TABLE runs ADD COLUMN resume_requested BOOLEAN NOT NULL DEFAULT false;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE runs DROP COLUMN resume_requested;
    ALTER TABLE runs DROP COLUMN auto_resume;
    DROP TABLE checkpoints;
    DROP INDEX agent_events_message_unique;
  `.execute(db);
}
