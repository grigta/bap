import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Checkpoint {
  runId: string;
  agentId: string;
  profileId: string;
  scenarioId: string;
  scenarioVersion: string;
  sdkVersion: string;
  lastCompletedStepId: string;
  sequence: number;
  createdAt: string;
  state: unknown;
  /** What a recovery may do next without asking the operator. */
  resume: { nextStepId: string | null; nextStepMutating: boolean; autoResume: boolean };
}

/** Agent-local checkpoint log in SQLite; survives agent crashes and restarts. */
export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence)
    )`);
  }

  save(checkpoint: Checkpoint): void {
    this.db.prepare("INSERT INTO checkpoints (run_id, sequence, body) VALUES (?, ?, ?)").run(checkpoint.runId, checkpoint.sequence, JSON.stringify(checkpoint));
  }

  list(runId: string): Checkpoint[] {
    const rows = this.db.prepare("SELECT body FROM checkpoints WHERE run_id = ? ORDER BY sequence").all(runId) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body));
  }

  latest(runId: string): Checkpoint | null {
    return this.list(runId).at(-1) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
