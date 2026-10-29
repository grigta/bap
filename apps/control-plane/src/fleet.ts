import { type Db, isDatabaseUnavailable } from "@bap/database";
import { sql } from "kysely";
import { AGENT_SOCKET_PATH, type AgentMessage, type AgentRequestPayload, type RemoteAgentMessage, type RunEvent, type ServerMessage, agentMessage, isRemoteMessage, heartbeatPayload, message } from "@bap/protocol";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { App } from "./app.ts";
import { agentBundle, installCommand, installScript, publicEndpoint } from "./agent-install.ts";
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
  /** The build the agent runs (see agent.hello). */
  agentVersion: z.string().nullable(),
  /** Installed agents: whether they run the server's current build; null for agents run from a repository. */
  upToDate: z.boolean().nullable(),
  platform: z.string(),
  architecture: z.string(),
  /** "MacBook Air · Apple M5 · 16 GB"; null until an agent that knows it says hello. */
  model: z.string().nullable(),
  heartbeat: heartbeatSchema,
  /** Effective limit of parallel sessions: the operator's limit, else what the agent reports. */
  maxSessions: z.number().nullable(),
  /** Repeated messages discarded by deduplication. */
  duplicateMessages: z.number(),
  reportedMaxSessions: z.number().nullable(),
  sessionLimit: z.number().nullable(),
  activeRuns: z.number(),
});
const idParams = z.object({ id: z.uuid() });

declare module "fastify" {
  interface FastifyRequest {
    agentId?: string;
    agentCredentialId?: string;
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
    onConnected?: (agentId: string, report: { activeRuns: string[]; interruptedRuns: string[] }) => Promise<void>;
    onHeartbeat?: (agentId: string) => Promise<void>;
    /** Remote browser messages (frames, page changes): relayed to the operator, never stored. */
    onRemote?: (agentId: string, msg: RemoteAgentMessage) => void;
    /** The agent's last connection closed. */
    onDisconnected?: (agentId: string) => void;
  };
}

export function registerFleet(app: App, db: Db, config: FleetConfig, operatorAuth: preHandlerAsyncHookHandler): Fleet {
  const sockets = new Map<string, Set<WebSocket>>();
  const pending = new Map<string, { socket: WebSocket; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const handlers: Fleet["handlers"] = {};
  // A socket of an agent that died without closing TCP looks open forever: drop it after the OFFLINE threshold.
  const lastMessageAt = new WeakMap<WebSocket, number>();
  const reaper = setInterval(() => {
    for (const set of sockets.values())
      for (const socket of set) if (Date.now() - (lastMessageAt.get(socket) ?? 0) > config.offlineAfterMs) socket.terminate();
  }, Math.max(100, Math.min(config.heartbeatIntervalMs, 5000)));
  app.addHook("onClose", async () => clearInterval(reaper));
  const unauthorized = { 401: errorSchema };

  const listAgents = async (id?: string) => {
    let query = db
      .selectFrom("agents")
      .leftJoin("agent_capabilities", "agent_capabilities.agent_id", "agents.id")
      .select(["agents.id", "name", "status", "last_seen_at", "agent_version", "platform", "architecture", "model", "last_heartbeat", "max_sessions", "duplicate_messages", "updatable", "agent_capabilities.payload as capabilities"])
      .where("deleted_at", "is", null)
      .orderBy("name");
    if (id) query = query.where("agents.id", "=", id);
    const active = await db
      .selectFrom("runs")
      .select(["agent_id", db.fn.countAll<string>().as("n")])
      .where("status", "in", ["ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED"])
      .groupBy("agent_id")
      .execute();
    const rows = await query.execute();
    // The current build is only needed (and only bundled) when an installed agent is listed.
    const current = rows.some((r) => r.updatable) ? (await agentBundle()).sha256.slice(0, 12) : null;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      connection: r.status === "REVOKED" ? "OFFLINE" : connection(r.last_seen_at, config),
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      agentVersion: r.agent_version,
      upToDate: r.updatable ? r.agent_version === current : null,
      platform: r.platform,
      architecture: r.architecture,
      model: r.model,
      heartbeat: (r.last_heartbeat as z.infer<typeof heartbeatSchema>) ?? null,
      maxSessions: r.max_sessions ?? (r.capabilities as { maxSessions?: number } | null)?.maxSessions ?? null,
      reportedMaxSessions: (r.capabilities as { maxSessions?: number } | null)?.maxSessions ?? null,
      sessionLimit: r.max_sessions,
      duplicateMessages: r.duplicate_messages,
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
    {
      preHandler: operatorAuth,
      schema: {
        response: {
          // installCommand: the one line for a new Mac; null until `pnpm gateway` (or BAP_PUBLIC_URL) makes this server reachable.
          201: z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), installCommand: z.string().nullable() }),
          ...unauthorized,
        },
      },
    },
    async (request, reply) => {
      // The operator pastes it into `bap-agent enroll --token`: the prefix keeps a leading "-" of
      // base64url from being read as an option, and makes a leaked invitation easy to recognise.
      const token = `bapi_${newToken()}`;
      const expiresAt = new Date(Date.now() + config.enrollmentTtlMs);
      const row = await db
        .insertInto("agent_enrollments")
        .values({ token_hash: hashToken(token), expires_at: expiresAt, created_by: request.operatorId! })
        .returning("id")
        .executeTakeFirstOrThrow();
      const endpoint = publicEndpoint();
      return reply.code(201).send({ id: row.id, token, expiresAt: expiresAt.toISOString(), installCommand: endpoint && installCommand(endpoint, token) });
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
        const taken = await tx.selectFrom("agents").select("id").where("name", "=", name).where("deleted_at", "is", null).executeTakeFirst();
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

  // Linken Sphere closed or crashed on a Mac: the operator starts it from the panel (REQ-AGENT-004).
  app.post(
    "/api/v1/agents/:id/ls/start",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 200: z.object({ started: z.boolean() }), ...unauthorized, 404: errorSchema, 409: errorSchema } } },
    async (request, reply) => {
      const [agent] = await listAgents(request.params.id);
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      try {
        return (await ask(agent.id, { method: "provider.start" })) as { started: boolean };
      } catch (e) {
        if (e instanceof AgentRequestError) return sendError(reply, request, 409, e.code, e.message);
        throw e;
      }
    },
  );

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
          .select(["agents.id", "agent_credentials.id as credential_id"])
          .where("key_hash", "=", hashToken(key))
          .where("revoked_at", "is", null)
          .where("agents.status", "!=", "REVOKED")
          .executeTakeFirst()
      : undefined;
    if (!credential) return sendError(reply, request, 401, "UNAUTHORIZED", "Agent credentials required");
    request.agentId = credential.id;
    request.agentCredentialId = credential.credential_id;
  };

  // A revoked agent can be removed from the panel; its rows stay for the history that points at them
  // (REQ-DB-002), and its name and Linken Sphere profiles are free for a new registration.
  app.delete(
    "/api/v1/agents/:id",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 204: z.null(), ...unauthorized, 404: errorSchema, 409: errorSchema } } },
    async (request, reply) => {
      const [agent] = await listAgents(request.params.id);
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      if (agent.status !== "REVOKED") return sendError(reply, request, 409, "AGENT_STATE_CONFLICT", "Only a revoked agent can be deleted: revoke it first");
      await db.transaction().execute(async (tx) => {
        const now = new Date();
        await tx.updateTable("agents").set({ deleted_at: now }).where("id", "=", agent.id).execute();
        await tx.updateTable("profiles").set({ archived_at: now }).where("agent_id", "=", agent.id).where("archived_at", "is", null).execute();
      });
      return reply.code(204).send(null);
    },
  );

  // ---- one-command install on a new Mac (see agent-install.ts) ----
  app.get(
    "/api/v1/agents/enrollments/:id",
    {
      preHandler: operatorAuth,
      schema: {
        params: idParams,
        response: {
          200: z.object({ id: z.string(), expiresAt: z.string(), usedAt: z.string().nullable(), agent: agentSchema.pick({ id: true, name: true, connection: true }).nullable() }),
          ...unauthorized,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const invite = await db.selectFrom("agent_enrollments").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!invite) return sendError(reply, request, 404, "NOT_FOUND", "Invitation not found");
      const [agent] = invite.agent_id ? await listAgents(invite.agent_id) : [];
      return { id: invite.id, expiresAt: invite.expires_at.toISOString(), usedAt: invite.used_at?.toISOString() ?? null, agent: agent ? { id: agent.id, name: agent.name, connection: agent.connection } : null };
    },
  );

  // The agent program: for a valid (not yet used) invitation during install, or for an agent key on update.
  app.get("/api/v1/agents/install/bundle", { schema: { querystring: z.object({ token: z.string().optional() }) } }, async (request, reply) => {
    if (request.query.token) {
      const invite = await db
        .selectFrom("agent_enrollments")
        .select("id")
        .where("token_hash", "=", hashToken(request.query.token))
        .where("used_at", "is", null)
        .where("expires_at", ">", new Date())
        .executeTakeFirst();
      if (!invite) return sendError(reply, request, 401, "INVITATION_INVALID", "Invitation is unknown, used or expired");
    } else {
      await agentAuth(request, reply);
      if (reply.sent) return reply;
    }
    const bundle = await agentBundle();
    return reply.header("x-bap-sha256", bundle.sha256).type("text/javascript").send(bundle.body);
  });

  // The self-signed certificate agents must trust; public by nature (the TLS handshake shows it anyway).
  app.get("/api/v1/agents/install/ca", async (request, reply) => {
    const endpoint = publicEndpoint();
    if (!endpoint?.caPem) return sendError(reply, request, 404, "NOT_FOUND", "This server uses a CA-signed certificate");
    return reply.type("application/x-pem-file").send(endpoint.caPem);
  });

  app.get("/install.sh", async (request, reply) => {
    const endpoint = publicEndpoint();
    if (!endpoint) return reply.code(503).type("text/plain").send("echo 'BAP: the server is not reachable from other Macs yet: run pnpm gateway on it.' >&2; exit 1\n");
    const { playwrightVersion } = await agentBundle();
    return reply.type("text/x-shellscript").send(installScript({ endpoint, nodeVersion: process.versions.node, playwrightVersion }));
  });

  app.post(
    "/api/v1/agents/:id/rotate-key",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 202: z.object({ requested: z.literal(true) }), ...unauthorized, 404: errorSchema, 409: errorSchema } } },
    async (request, reply) => {
      const [agent] = await listAgents(request.params.id);
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      const live = [...(sockets.get(agent.id) ?? [])].filter((s) => s.readyState === s.OPEN).at(-1);
      if (!live) return sendError(reply, request, 409, "AGENT_UNAVAILABLE", "The agent must be connected to rotate its key");
      live.send(JSON.stringify(message({ type: "agent.rotate-key", payload: {} })));
      return reply.code(202).send({ requested: true });
    },
  );

  // Lets an agent (and the installer) ask whether its key is still accepted.
  app.get("/api/v1/agents/me", { preHandler: agentAuth, schema: { response: { 200: z.object({ agentId: z.string() }), ...unauthorized } } }, async (request) => ({
    agentId: request.agentId!,
  }));

  // The agent exchanges its current key for a new one; the old key stops working at once (REQ-SEC-005).
  app.post("/api/v1/agents/me/key", { preHandler: agentAuth, schema: { response: { 201: z.object({ agentKey: z.string() }), ...unauthorized } } }, async (request, reply) => {
    const agentKey = newToken();
    await db.transaction().execute(async (tx) => {
      await tx.updateTable("agent_credentials").set({ revoked_at: new Date() }).where("id", "=", request.agentCredentialId!).execute();
      await tx.insertInto("agent_credentials").values({ agent_id: request.agentId!, key_hash: hashToken(agentKey) }).execute();
      await tx.insertInto("audit_events").values({ actor: `agent:${request.agentId}`, action: "agent key rotated", outcome: "ok", target_type: "agents", target_id: request.agentId!, details: "{}", request_id: request.id }).execute();
    });
    return reply.code(201).send({ agentKey });
  });

  app.get(AGENT_SOCKET_PATH, { websocket: true, preValidation: agentAuth }, (socket, request) => {
    const agentId = request.agentId!;
    if (!sockets.has(agentId)) sockets.set(agentId, new Set());
    sockets.get(agentId)!.add(socket);
    lastMessageAt.set(socket, Date.now());
    let epoch: number | null = null;
    let queue = Promise.resolve();

    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    const protocolError = (code: string, text: string) => {
      send(message({ type: "server.error", payload: { code, message: text } }));
      socket.close(1008, code);
    };

    // An installed agent on an old build, with no run in progress, replaces itself with the current one.
    let updateOffered = false;
    const offerUpdate = async () => {
      if (updateOffered) return;
      const agent = await db.selectFrom("agents").select(["agent_version", "updatable"]).where("id", "=", agentId).executeTakeFirst();
      if (!agent?.updatable) return;
      const { sha256 } = await agentBundle();
      if (agent.agent_version === sha256.slice(0, 12)) return;
      const busy = await db.selectFrom("runs").select("id").where("agent_id", "=", agentId).where("status", "in", ["ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED"]).executeTakeFirst();
      if (busy) return;
      updateOffered = true;
      send(message({ type: "agent.update", payload: { sha256 } }));
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
            updatable: msg.payload.updatable,
            platform: msg.payload.platform,
            architecture: msg.payload.architecture,
            model: msg.payload.model,
          }))
          .where("id", "=", agentId)
          .returning("current_epoch")
          .executeTakeFirstOrThrow();
        epoch = Number(row.current_epoch);
        send(message({ type: "server.welcome", payload: { agentId, epoch, heartbeatIntervalMs: config.heartbeatIntervalMs } }));
        // Interrupted and still-running runs are reconciled; runs queued while the agent was away go out.
        await handlers.onConnected?.(agentId, { activeRuns: msg.payload.activeRuns, interruptedRuns: msg.payload.interruptedRuns });
        await offerUpdate();
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
      if (isRemoteMessage(msg)) {
        handlers.onRemote?.(agentId, msg);
        return;
      }

      const inserted = await db
        .insertInto("agent_events")
        .values({ agent_id: agentId, epoch, sequence: msg.seq, message_id: msg.id, event_type: msg.type, payload: JSON.stringify(msg.payload), sent_at: msg.ts })
        // Either key catches a repeat: (epoch, sequence) within a connection, the message id across reconnects.
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      const duplicate = !inserted;
      if (duplicate)
        await db
          .updateTable("agents")
          .set((eb) => ({ duplicate_messages: eb("duplicate_messages", "+", 1) }))
          .where("id", "=", agentId)
          .execute();
      else {
        if (msg.type === "agent.heartbeat") {
          await db.updateTable("agents").set({ last_seen_at: now, last_heartbeat: JSON.stringify(msg.payload) }).where("id", "=", agentId).execute();
          await handlers.onHeartbeat?.(agentId);
          await offerUpdate(); // a busy agent gets it once its runs are done
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
      lastMessageAt.set(socket, Date.now());
      // Answers to server requests skip the queue: a handler in the queue may be waiting for exactly this answer.
      const text = String(raw);
      if (text.includes('"type":"agent.response"') || text.includes('"type":"remote.')) {
        void handle(text).catch((e) => request.log.error(e));
        return;
      }
      queue = queue.then(() => handle(text)).catch((e) => {
        // Not stored, so not acknowledged: closing makes the agent reconnect and resend it from its outbox.
        if (isDatabaseUnavailable(e)) {
          request.log.warn(`agent ${agentId}: message not stored, database unavailable; closing the socket`);
          socket.close(1011, "storage unavailable");
        } else request.log.error(e);
      });
    });
    socket.on("close", () => {
      sockets.get(agentId)?.delete(socket);
      if (!liveSocket(agentId)) handlers.onDisconnected?.(agentId);
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

  const ask: Fleet["request"] = (agentId, payload, timeoutMs = 120_000) => {
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
  };

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
    request: ask,
  };
}
