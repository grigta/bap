import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentStore } from "./agent-store.ts";

/**
 * Deletes screenshots, reports and checkpoints of settled runs last written before `olderThan`
 * (REQ-SEC-010). Returns the purged run ids.
 */
export function purgeLocalRuns(store: AgentStore, dataDir: string, olderThan: Date): string[] {
  const runsDir = join(dataDir, "runs");
  if (!existsSync(runsDir)) return [];
  const purged: string[] = [];
  for (const runId of readdirSync(runsDir)) {
    const dir = join(runsDir, runId);
    if (statSync(dir).mtime >= olderThan || !store.isSettled(runId)) continue;
    rmSync(dir, { recursive: true, force: true });
    purged.push(runId);
  }
  return purged;
}
