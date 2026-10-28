import type { Db } from "@bap/database";
import { DEFAULT_FARMING } from "../../apps/control-plane/src/farming.ts";

/** Lets every profile go to recipes at once: tests of recipes are not about warm-ups (PRD §17). */
export async function withoutWarmup(db: Db) {
  const value = JSON.stringify({ ...DEFAULT_FARMING, requiredWarmups: 0 });
  await db.insertInto("settings").values({ key: "farming", value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
}
