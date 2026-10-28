import type { Db } from "@bap/database";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import type { Coordinator } from "./coordinator.ts";
import { errorSchema, sendError } from "./errors.ts";

/** Warm-up of profiles before recipes (PRD §17, ADR-0029). */
export const farmingSettingsSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  /** Successful sessions a profile needs before recipes; 0 lets every profile through. */
  requiredWarmups: z.number().int().min(0).max(10),
  sites: z.number().int().min(1).max(10),
  dwellSeconds: z.number().int().min(1).max(600),
  searchUrl: z.url({ protocol: /^https?$/ }),
});
export type FarmingSettings = z.infer<typeof farmingSettingsSchema>;

export const DEFAULT_FARMING: FarmingSettings = {
  queries: ["accounting software", "weather tomorrow", "best laptops 2026", "how to cook pasta", "news today"],
  requiredWarmups: 3,
  sites: 3,
  dwellSeconds: 40,
  searchUrl: "https://www.google.com/",
};

/** Failed warm-ups in a row that send the profile to review instead of trying again. */
export const WARMUP_FAILURES_TO_REVIEW = 3;
const MAX_TIMEOUT_MS = 60 * 60_000;

export async function farmingSettings(db: Db): Promise<FarmingSettings> {
  const row = await db.selectFrom("settings").select("value").where("key", "=", "farming").executeTakeFirst();
  return row ? farmingSettingsSchema.parse(row.value) : DEFAULT_FARMING;
}

/** Whether a run of this kind needs a warmed-up profile: recipes and their recordings do, code scenarios do not. */
export const needsWarmProfile = (runKind: string, scenarioKind: string) => runKind === "record" || (runKind === "run" && scenarioKind === "recipe");

/** Queues one warm-up session on the profile with a random query from the list. */
export async function queueWarmup(db: Db, profile: { id: string; agent_id: string }, settings: FarmingSettings, reason: string): Promise<string> {
  const query = settings.queries[Math.floor(Math.random() * settings.queries.length)]!;
  const input = { query, sites: settings.sites, dwellSeconds: settings.dwellSeconds, searchUrl: settings.searchUrl };
  // The time on the sites plus loading: pages are waited for until they are ready, within this limit only.
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, (settings.sites * (settings.dwellSeconds + 60) + 120) * 1000);
  return db.transaction().execute(async (tx) => {
    const run = await tx
      .insertInto("runs")
      .values({ scenario_id: "farm", scenario_version: null, kind: "farm", profile_id: profile.id, agent_id: profile.agent_id, input: JSON.stringify(input), timeout_ms: timeoutMs })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx.insertInto("run_transitions").values({ run_id: run.id, from_status: null, to_status: "QUEUED", reason }).execute();
    return run.id;
  });
}

export interface FarmingOptions {
  db: Db;
  coordinator: Coordinator;
  operatorAuth: preHandlerAsyncHookHandler;
}

export function registerFarming(app: App, { db, coordinator, operatorAuth }: FarmingOptions) {
  const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema };

  app.get("/api/v1/farming/settings", { preHandler: operatorAuth, schema: { response: { 200: farmingSettingsSchema, ...errors } } }, () => farmingSettings(db));

  app.put("/api/v1/farming/settings", { preHandler: operatorAuth, schema: { body: farmingSettingsSchema, response: { 200: farmingSettingsSchema, 400: errorSchema, ...errors } } }, async (request) => {
    const value = request.body;
    await db
      .insertInto("settings")
      .values({ key: "farming", value: JSON.stringify(value) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }))
      .execute();
    await coordinator.tick(); // a lower threshold may let waiting recipes go now
    return value;
  });

  app.post(
    "/api/v1/profiles/:id/farm",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.uuid() }), response: { 202: z.object({ runId: z.string() }), ...errors } } },
    async (request, reply) => {
      const profile = await db.selectFrom("profiles").select(["id", "agent_id", "status"]).where("id", "=", request.params.id).where("archived_at", "is", null).executeTakeFirst();
      if (!profile) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
      if (profile.status === "NEEDS_REVIEW") return sendError(reply, request, 409, "PROFILE_NEEDS_REVIEW", "The profile needs review before new runs");
      if (profile.status === "DISABLED") return sendError(reply, request, 409, "PROFILE_DISABLED", "The profile is disabled");
      const runId = await queueWarmup(db, profile, await farmingSettings(db), "warm-up started by the operator");
      await coordinator.tick();
      return reply.code(202).send({ runId });
    },
  );
}
