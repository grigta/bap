import type { Db } from "@bap/database";
import type { ObjectStore } from "./storage.ts";

const FINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"] as const;

/**
 * Deletes screenshots and reports of finished runs created before `olderThan` (REQ-SEC-010).
 * Objects go first and rows second: a crash in between leaves a row whose content answers 404,
 * never an orphaned object nobody can find. Runs still in progress keep everything.
 */
export async function purgeArtifacts(db: Db, store: ObjectStore, olderThan: Date): Promise<number> {
  const expired = await db
    .selectFrom("artifacts")
    .innerJoin("runs", "runs.id", "artifacts.run_id")
    .select(["artifacts.id", "artifacts.storage_key"])
    .where("artifacts.created_at", "<", olderThan)
    .where("runs.status", "in", FINAL)
    .execute();
  if (expired.length === 0) return 0;
  for (const a of expired) await store.delete(a.storage_key);
  const ids = expired.map((a) => a.id);
  await db.transaction().execute(async (tx) => {
    await tx.updateTable("run_steps").set({ screenshot_artifact_id: null }).where("screenshot_artifact_id", "in", ids).execute();
    await tx.deleteFrom("artifacts").where("id", "in", ids).execute();
  });
  return expired.length;
}
