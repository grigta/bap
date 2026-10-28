import type { Db } from "@bap/database";
import type { FastifyRequest } from "fastify";

export interface AuditEntry {
  action: string;
  outcome?: "ok" | "denied";
  targetType?: string;
  targetId?: string;
  /** Identifiers and outcomes only: never tokens, passwords or keys. */
  details?: Record<string, unknown>;
  /** Defaults to the authenticated operator, else "anonymous". */
  actor?: string;
}

/** Writes one audit record for the request (REQ-SEC-012). */
export async function audit(db: Db, request: FastifyRequest, entry: AuditEntry): Promise<void> {
  let actor = entry.actor;
  if (!actor && request.operatorId) {
    const op = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId).executeTakeFirst();
    actor = op ? `operator:${op.login}` : `operator:${request.operatorId}`;
  }
  await db
    .insertInto("audit_events")
    .values({
      actor: actor ?? "anonymous",
      action: entry.action,
      outcome: entry.outcome ?? "ok",
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: JSON.stringify(entry.details ?? {}),
      request_id: request.id,
    })
    .execute();
}
