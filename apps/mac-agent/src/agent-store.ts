import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunAssignPayload } from "@bap/protocol";

/** An event envelope without the per-connection sequence number. */
export interface OutboxEvent {
  v: 1;
  id: string;
  ts: string;
  type: string;
  payload: { runId: string } & Record<string, unknown>;
}
export interface OutboxArtifact {
  runId: string;
  name: string;
  path: string;
}
export type OutboxItem = { rowId: number; kind: "event"; event: OutboxEvent } | { rowId: number; kind: "artifact"; artifact: OutboxArtifact };

export type LocalRunStatus = "running" | "interrupted" | "finished";

/**
 * Agent-local durable state (REQ-PROTO-006, REQ-AGENT-001): the outbox of run events and
 * screenshot uploads not yet acknowledged, and the runs this agent has taken on.
 */
export class AgentStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "agent.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        message_id TEXT UNIQUE,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        assign TEXT NOT NULL
      );
    `);
  }

  enqueueEvent(event: OutboxEvent): void {
    this.db.prepare("INSERT INTO outbox (kind, message_id, body) VALUES ('event', ?, ?)").run(event.id, JSON.stringify(event));
  }

  enqueueArtifact(artifact: OutboxArtifact): void {
    this.db.prepare("INSERT INTO outbox (kind, body) VALUES ('artifact', ?)").run(JSON.stringify(artifact));
  }

  pending(): OutboxItem[] {
    const rows = this.db.prepare("SELECT row_id, kind, body FROM outbox ORDER BY row_id").all() as { row_id: number; kind: string; body: string }[];
    return rows.map((r) =>
      r.kind === "event" ? { rowId: r.row_id, kind: "event", event: JSON.parse(r.body) } : { rowId: r.row_id, kind: "artifact", artifact: JSON.parse(r.body) },
    );
  }

  remove(rowId: number): void {
    this.db.prepare("DELETE FROM outbox WHERE row_id = ?").run(rowId);
  }

  /** The server acknowledged the event with this message id. */
  acknowledge(messageId: string): void {
    this.db.prepare("DELETE FROM outbox WHERE message_id = ?").run(messageId);
  }

  setRun(runId: string, status: LocalRunStatus, assign?: RunAssignPayload): void {
    if (assign) this.db.prepare("INSERT OR REPLACE INTO local_runs (run_id, status, assign) VALUES (?, ?, ?)").run(runId, status, JSON.stringify(assign));
    else this.db.prepare("UPDATE local_runs SET status = ? WHERE run_id = ?").run(status, runId);
  }

  runStatus(runId: string): LocalRunStatus | null {
    const row = this.db.prepare("SELECT status FROM local_runs WHERE run_id = ?").get(runId) as { status: LocalRunStatus } | undefined;
    return row?.status ?? null;
  }

  runs(status: LocalRunStatus): { runId: string; assign: RunAssignPayload }[] {
    const rows = this.db.prepare("SELECT run_id, assign FROM local_runs WHERE status = ?").all(status) as { run_id: string; assign: string }[];
    return rows.map((r) => ({ runId: r.run_id, assign: JSON.parse(r.assign) }));
  }

  /** Runs whose events (results included) the server has not acknowledged yet. */
  runsWithUndeliveredEvents(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT json_extract(body, '$.payload.runId') AS run_id FROM outbox WHERE kind = 'event'").all() as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  /** Local files of the run may go: it has finished here (or was never assigned) and nothing of it waits for upload. */
  isSettled(runId: string): boolean {
    const status = this.runStatus(runId);
    if (status === "running" || status === "interrupted") return false;
    const pending = this.db.prepare("SELECT 1 FROM outbox WHERE kind = 'artifact' AND json_extract(body, '$.runId') = ?").get(runId);
    return pending === undefined;
  }

  close(): void {
    this.db.close();
  }
}
