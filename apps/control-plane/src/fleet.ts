import type { Db } from "@bap/database";
import { sql } from "kysely";
import { AGENT_SOCKET_PATH, type AgentMessage, type AgentRequestPayload, type RunEvent, type ServerMessage, agentMessage, heartbeatPayload, message } from "@bap/protocol";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { App } from "./app.ts";
import { hashToken, newToken } from "./auth.ts";
import { errorSchema, sendError } from "./errors.ts";

export interface FleetConfig {
  heartbeatIntervalMs: number;
  /** No message for this long: SUSPECT. */
  suspectAfterMs: number;
  /** No message for this long: OFFLINE. */
  offlineAfterMs: number;
  enrollmentTtlMs: number;
}

export const DEFAULT_FLEET: FleetConfig = {
  heartbeatIntervalMs: 10_000,
  suspectAfterMs: 30_000,
  offlineAfterMs: 60_000,
  enrollmentTtlMs: 15 * 60_000,
};

export type Connection = "ONLINE" | "SUSPECT" | "OFFLINE";

export function connection(lastSeenAt: Date | null, config: FleetConfig, now = Date.now()): Connection {
  if (!lastSeenAt) return "OFFLINE";
  const silent = now - lastSeenAt.getTime();
  return silent < config.suspectAfterMs ? "ONLINE" : silent < config.offlineAfterMs ? "SUSPECT" : "OFFLINE";
}

const heartbeatSchema = heartbeatPayload.nullable();
const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  connection: z.enum(["ONLINE", "SUSPECT", "OFFLINE"]),
  lastSeenAt: z.string().nullable(),
  agentVersion: z.string().nullable(),
  platform: z.string(),
  architecture: z.string(),
  heartbeat: heartbeatSchema,
  /** Effective limit of parallel sessions: the operator's limit, else what the agent reports. */
  maxSessions: z.number().nullable(),
  reportedMaxSessions: z.number().nullable(),
  sessionLimit: z.number().nullable(),
  activeRuns: z.number(),
});
const idParams = z.object({ id: z.uuid() });

declare module "fastify" {
  interface FastifyRequest {
    agentId?: string;
  }
}

export class AgentRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Fleet {
  /** Sends a request to a connected agent; rejects with AgentRequestError (AGENT_UNAVAILABLE when not connected). */
  request(agentId: string, payload: AgentRequestPayload, timeoutMs?: number): Promise<unknown>;
  isConnected(agentId: string): boolean;
  /** Sends to the agent's live connection; false when it is not connected. */
  send(agentId: string, msg: ServerMessage): boolean;
  /** Authenticates agent HTTP calls by the agent key; sets request.agentId. */
  agentAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Set by the run coordinator. */
  handlers: {
    onRunEvent?: (agentId: string, event: RunEvent) => Promise<void>;
    onConnected?: (agentId: string) => Promise<void>;
    onHeartbeat?: (agentId: string) => Promise<void>;
  };
}

export function registerFleet(app: App, db: Db, config: FleetConfig, operatorAuth: preHandlerAsyncHookHandler): Fleet {
  const sockets = new Map<string, Set<WebSocket>>();
  const pending = new Map<string, { socket: WebSocket; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const handlers: Fleet["handlers"] = {};
  const unauthorized = { 401: errorSchema };

  const listAgents = async (id?: string) => {
    let query = db
      .selectFrom("agents")
      .leftJoin("agent_capabilities", "agent_capabilities.agent_id", "agents.id")
      .select(["agents.id", "name", "status", "last_seen_at", "agent_version", "platform", "architecture", "last_heartbeat", "max_sessions", "agent_capabilities.payload as capabilities"])
      .orderBy("name");
    if (id) query = query.where("agents.id", "=", id);
    const active = await db
      .selectFrom("runs")
      .select(["agent_id", db.fn.countAll<string>().as("n")])
      .where("status", "in", ["ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED"])
      .groupBy("agent_id")
      .execute();
    return (await query.execute()).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      connection: connection(r.last_seen_at, config),
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      agentVersion: r.agent_version,
      platform: r.platform,
      architecture: r.architecture,
      heartbeat: (r.last_heartbeat as z.infer<typeof heartbeatSchema>) ?? null,
      maxSessions: r.max_sessions ?? (r.capabilities as { maxSessions?: number } | null)?.maxSessions ?? null,
      reportedMaxSessions: (r.capabilities as { maxSessions?: number } | null)?.maxSessions ?? null,
      sessionLimit: r.max_sessions,
      activeRuns: Number(active.find((a) => a.agent_id === r.id)?.n ?? 0),
    }));
  };

  const heartbeatHistory = async (agentId: string) => {
    const rows = await db
      .selectFrom("agent_events")
      .select(["payload", "received_at"])
      .where("agent_id", "=", agentId)
      .where("event_type", "=", "agent.heartbeat")
      .orderBy("received_at", "desc")
      .limit(60)
      .execute();
    return rows.reverse().map((r) => ({ ...(r.payload as z.infer<typeof heartbeatPayload>), at: r.received_at.toISOString() }));
  };

  app.post(
    "/api/v1/agents/enrollments",
    { preHandler: operatorAuth, schema: { response: { 201: z.object({ id: z.string(), token: z.string(), expiresAt: z.string() }), ...unauthorized } } },
    async (request, reply) => {
      const token = newToken();
      const expiresAt = new Date(Date.now() + config.enrollmentTtlMs);
      const row = await db
        .insertInto("agent_enrollments")
        .values({ token_hash: hashToken(token), expires_at: expiresAt, created_by: request.operatorId! })
        .returning("id")
        .executeTakeFirstOrThrow();
      return reply.code(201).send({ id: row.id, token, expiresAt: expiresAt.toISOString() });
    },
  );

  app.post(
    "/api/v1/agents/enroll",
    {
      schema: {
        body: z.object({ token: z.string().min(1), name: z.string().min(1), platform: z.string(), architecture: z.string() }),
        response: { 201: z.object({ agentId: z.string(), agentKey: z.string() }), ...unauthorized, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const { token, name, platform, architecture } = request.body;
      const agentKey = newToken();
      const result = await db.transaction().execute(async (tx) => {
        // Claim the invitation atomically: a used or expired token matches no row.
        const invite = await tx
          .updateTable("agent_enrollments")
          .set({ used_at: new Date() })
          .where("token_hash", "=", hashToken(token))
          .where("used_at", "is", null)
          .where("expires_at", ">", new Date())
          .returning("id")
          .executeTakeFirst();
        if (!invite) return "invalid" as const;
        const taken = await tx.selectFrom("agents").select("id").where("name", "=", name).executeTakeFirst();
        if (taken) return "taken" as const;
        const agent = await tx.insertInto("agents").values({ name, platform, architecture }).returning("id").executeTakeFirstOrThrow();
        await tx.updateTable("agent_enrollments").set({ agent_id: agent.id }).where("id", "=", invite.id).execute();
        await tx.insertInto("agent_credentials").values({ agent_id: agent.id, key_hash: hashToken(agentKey) }).execute();
        return agent.id;
      });
      if (result === "invalid") return sendError(reply, request, 401, "INVITATION_INVALID", "Invitation is unknown, used or expired");
      if (result === "taken") return sendError(reply, request, 409, "AGENT_NAME_TAKEN", `Agent ${name} already exists`);
      return reply.code(201).send({ agentId: result, agentKey });
    },
  );

  app.get("/api/v1/agents", { preHandler: operatorAuth, schema: { response: { 200: z.array(agentSchema), ...unauthorized } } }, () => listAgents());

  app.get(
    "/api/v1/agents/:id",
    {
      preHandler: operatorAuth,
      schema: {
        params: idParams,
        response: { 200: agentSchema.extend({ heartbeats: z.array(heartbeatPayload.extend({ at: z.string() })) }), ...unauthorized, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const [agent] = await listAgents(request.params.id);
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      return { ...agent, heartbeats: await heartbeatHistory(agent.id) };
    },
  );

  // activate is not in PRD §10.1: it is the way back from DRAINING/DISABLED (S6).
  for (const [action, from, status] of [
    ["drain", ["ACTIVE"], "DRAINING"],
    ["disable", ["ACTIVE", "DRAINING"], "DISABLED"],
    ["activate", ["DRAINING", "DISABLED"], "ACTIVE"],
    ["revoke", ["ACTIVE", "DRAINING", "DISABLED"], "REVOKED"],
  ] as const) {
    app.post(
      `/api/v1/agents/:id/${action}`,
      { preHandler: operatorAuth, schema: { params: idParams, response: { 200: agentSchema, ...unauthorized, 404: errorSchema, 409: errorSchema } } },
      async (request, reply) => {
        const updated = await db.updateTable("agents").set({ status }).where("id", "=", request.params.id).where("status", "in", [...from]).returning("id").executeTakeFirst();
        if (!updated) {
          const [agent] = await listAgents(request.params.id);
          if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
          return sendError(reply, request, 409, "AGENT_STATE_CONFLICT", `Cannot ${action} an agent in status ${agent.status}`);
        }
        if (status === "REVOKED") {
          await db.updateTable("agent_credentials").set({ revoked_at: new Date() }).where("agent_id", "=", updated.id).where("revoked_at", "is", null).execute();
          for (const socket of sockets.get(updated.id) ?? []) socket.close(4401, "credentials revoked");
        } else {
          // Draining keeps running work; the agent only learns that no new runs come.
          const live = [...(sockets.get(updated.id) ?? [])].filter((s) => s.readyState === s.OPEN).at(-1);
          live?.send(JSON.stringify(message({ type: "agent.drain", payload: { draining: status !== "ACTIVE" } })));
        }
        return (await listAgents(updated.id))[0]!;
      },
    );
  }

  app.patch(
    "/api/v1/agents/:id",
    {
      preHandler: operatorAuth,
      schema: { params: idParams, body: z.object({ sessionLimit: z.number().int().min(0).max(100).nullable() }), response: { 200: agentSchema, ...unauthorized, 404: errorSchema } },
    },
    async (request, reply) => {
      const updated = await db.updateTable("agents").set({ max_sessions: request.body.sessionLimit }).where("id", "=", request.params.id).returning("id").executeTakeFirst();
      if (!updated) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      return (await listAgents(updated.id))[0]!;
    },
  );

  app.get(
    "/api/v1/agents/:id/metrics",
    {
      preHandler: operatorAuth,
      schema: { params: idParams, response: { 200: z.object({ heartbeats: z.array(heartbeatPayload.extend({ at: z.string() })) }), ...unauthorized, 404: errorSchema } },
    },
    async (request, reply) => {
      const [agent] = await listAgents(request.params.id);
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      return { heartbeats: await heartbeatHistory(agent.id) };
    },
  );

  const agentAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const key = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const credential = key
      ? await db
          .selectFrom("agent_credentials")
          .innerJoin("agents", "agents.id", "agent_credentials.agent_id")
          .select("agents.id")
          .where("key_hash", "=", hashToken(key))
          .where("revoked_at", "is", null)
          .where("agents.status", "!=", "REVOKED")
          .executeTakeFirst()
      : undefined;
    if (!credential) return sendError(reply, request, 401, "UNAUTHORIZED", "Agent credentials required");
    request.agentId = credential.id;
  };

  app.get(AGENT_SOCKET_PATH, { websocket: true, preValidation: agentAuth }, (socket, request) => {
    const agentId = request.agentId!;
    if (!sockets.has(agentId)) sockets.set(agentId, new Set());
    sockets.get(agentId)!.add(socket);
    let epoch: number | null = null;
    let queue = Promise.resolve();

    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    const protocolError = (code: string, text: string) => {
      send(message({ type: "server.error", payload: { code, message: text } }));
      socket.close(1008, code);
    };

    const handle = async (raw: string) => {
      let msg: AgentMessage;
      try {
        msg = agentMessage.parse(JSON.parse(raw));
      } catch (e) {
        return protocolError("PROTOCOL_ERROR", e instanceof Error ? e.message : String(e));
      }
      const now = new Date();
      if (msg.type === "agent.hello") {
        // A new epoch per hello: sequence numbers restart safely after the agent loses its local state.
        const row = await db
          .updateTable("agents")
          .set(() => ({
            current_epoch: sql<string>`current_epoch + 1`,
            last_seen_at: now,
            agent_version: msg.payload.agentVersion,
            platform: msg.payload.platform,
            architecture: msg.payload.architecture,
          }))
          .where("id", "=", agentId)
          .returning("current_epoch")
          .executeTakeFirstOrThrow();
        epoch = Number(row.current_epoch);
        send(message({ type: "server.welcome", payload: { agentId, epoch, heartbeatIntervalMs: config.heartbeatIntervalMs } }));
        // Runs queued while the agent was away go out now.
        await handlers.onConnected?.(agentId);
        return;
      }
      if (epoch === null) return protocolError("HELLO_REQUIRED", "agent.hello must be the first message");
      if (msg.type === "agent.response") {
        const waiting = pending.get(msg.payload.requestId);
        if (!waiting) return;
        pending.delete(msg.payload.requestId);
        clearTimeout(waiting.timer);
        if (msg.payload.ok) waiting.resolve(msg.payload.result);
        else waiting.reject(new AgentRequestError(msg.payload.error?.code ?? "AGENT_ERROR", msg.payload.error?.message ?? "agent request failed"));
        return;
      }

      const inserted = await db
        .insertInto("agent_events")
        .values({ agent_id: agentId, epoch, sequence: msg.seq, message_id: msg.id, event_type: msg.type, payload: JSON.stringify(msg.payload), sent_at: msg.ts })
        .onConflict((oc) => oc.columns(["agent_id", "epoch", "sequence"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      const duplicate = !inserted;
      if (!duplicate) {
        if (msg.type === "agent.heartbeat") {
          await db.updateTable("agents").set({ last_seen_at: now, last_heartbeat: JSON.stringify(msg.payload) }).where("id", "=", agentId).execute();
          await handlers.onHeartbeat?.(agentId);
        }
        else {
          await db.updateTable("agents").set({ last_seen_at: now }).where("id", "=", agentId).execute();
          if (msg.type === "agent.capabilities")
            await db
              .insertInto("agent_capabilities")
              .values({ agent_id: agentId, payload: JSON.stringify(msg.payload) })
              .onConflict((oc) => oc.column("agent_id").doUpdateSet({ payload: JSON.stringify(msg.payload), updated_at: now }))
              .execute();
          else await handlers.onRunEvent?.(agentId, msg);
        }
      }
      send(message({ type: "server.ack", payload: { id: msg.id, duplicate } }));
    };

    socket.on("message", (raw) => {
      // Answers to server requests skip the queue: a handler in the queue may be waiting for exactly this answer.
      const text = String(raw);
      if (text.includes('"type":"agent.response"')) {
        void handle(text).catch((e) => request.log.error(e));
        return;
      }
      queue = queue.then(() => handle(text)).catch((e) => request.log.error(e));
    });
    socket.on("close", () => {
      sockets.get(agentId)?.delete(socket);
      for (const [id, waiting] of pending)
        if (waiting.socket === socket) {
          pending.delete(id);
          clearTimeout(waiting.timer);
          waiting.reject(new AgentRequestError("AGENT_UNAVAILABLE", "The agent disconnected before answering"));
        }
    });
  });

  // The newest connection is the live one; older sockets are about to close.
  const liveSocket = (agentId: string) => [...(sockets.get(agentId) ?? [])].filter((s) => s.readyState === s.OPEN).at(-1);

  return {
    agentAuth,
    handlers,
    isConnected: (agentId) => liveSocket(agentId) !== undefined,
    send(agentId, msg) {
      const socket = liveSocket(agentId);
      if (!socket) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    request(agentId, payload, timeoutMs = 120_000) {
      const socket = liveSocket(agentId);
      if (!socket) return Promise.reject(new AgentRequestError("AGENT_UNAVAILABLE", "The agent is not connected"));
      const msg = message({ type: "server.request" as const, payload });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(msg.id);
          reject(new AgentRequestError("AGENT_TIMEOUT", `The agent did not answer ${payload.method} within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(msg.id, { socket, resolve, reject, timer });
        socket.send(JSON.stringify(msg));
      });
    },
  };
}
