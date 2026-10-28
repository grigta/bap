import type { Db } from "@bap/database";
import { sql } from "kysely";
import { type Model, type ModelReply, type ModelRequest } from "./model.ts";

export interface LlmLimits {
  /** Model calls one recording may make. */
  recordCallsPerRun: number;
  /** Model calls healing may make within one run. */
  healCallsPerRun: number;
  /** Model calls of the whole server per 24 hours. */
  callsPerDay: number;
}

export const DEFAULT_LIMITS: LlmLimits = { recordCallsPerRun: 60, healCallsPerRun: 20, callsPerDay: 500 };

export class BudgetExceededError extends Error {
  readonly code = "LLM_BUDGET_EXCEEDED";
}

/**
 * Limits and the journal of model calls (REQ-DOM-010). The journal lives in the database and the server log
 * only: the panel never shows the model or what it costs (ADR-0025).
 */
export function gatedModel(db: Db, model: Model, limits: LlmLimits, log: (entry: Record<string, unknown>) => void): Model {
  return {
    async ask(req: ModelRequest): Promise<ModelReply> {
      const perRun = await db.selectFrom("llm_calls").select(db.fn.countAll<string>().as("n")).where("run_id", "=", req.runId).where("purpose", "=", req.purpose).executeTakeFirstOrThrow();
      const limit = req.purpose === "record" ? limits.recordCallsPerRun : limits.healCallsPerRun;
      if (Number(perRun.n) >= limit) throw new BudgetExceededError(`${req.purpose} limit of ${limit} model calls per run reached`);
      const today = await db.selectFrom("llm_calls").select(db.fn.countAll<string>().as("n")).where("at", ">", sql<Date>`now() - interval '1 day'`).executeTakeFirstOrThrow();
      if (Number(today.n) >= limits.callsPerDay) throw new BudgetExceededError(`daily limit of ${limits.callsPerDay} model calls reached`);

      const started = Date.now();
      try {
        const reply = await model.ask(req);
        await db
          .insertInto("llm_calls")
          .values({ purpose: req.purpose, run_id: req.runId, model: reply.model, ok: true, duration_ms: reply.durationMs, cost_usd: reply.costUsd, input_tokens: reply.inputTokens, output_tokens: reply.outputTokens, error: null })
          .execute();
        log({ llm: req.purpose, runId: req.runId, model: reply.model, ms: reply.durationMs, costUsd: reply.costUsd, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens });
        return reply;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await db.insertInto("llm_calls").values({ purpose: req.purpose, run_id: req.runId, model: null, ok: false, duration_ms: Date.now() - started, cost_usd: null, input_tokens: null, output_tokens: null, error }).execute();
        log({ llm: req.purpose, runId: req.runId, error });
        throw e;
      }
    },
  };
}
