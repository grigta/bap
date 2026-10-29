import type { Db } from "@bap/database";
import { type RemoteAgentMessage, message, remoteInput } from "@bap/protocol";
import type { preHandlerAsyncHookHandler } from "fastify";
import { sql } from "kysely";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { App } from "./app.ts";
import type { Coordinator } from "./coordinator.ts";
import { errorSchema, sendError } from "./errors.ts";
import { type Fleet, type FleetConfig, connection } from "./fleet.ts";
import type { ObjectStore } from "./storage.ts";

export interface RemoteConfig {
  /** Closed when no operator has watched it for this long. */
  idleMs: number;
  /** Closed after this long in any case. */
  maxMs: number;
}
export const DEFAULT_REMOTE: RemoteConfig = { idleMs: 2 * 60_000, maxMs: 60 * 60_000 };

export interface RemoteOptions {
  db: Db;
  fleet: Fleet;
  fleetConfig: FleetConfig;
  coordinator: Coordinator;
  store: ObjectStore;
  operatorAuth: preHandlerAsyncHookHandler;
  config: RemoteConfig;
}

/** What the server keeps of an open session: only the latest picture, never the operator's input. */
interface Live {
  agentId: string;
  profileId: string;
  viewer: WebSocket | null;
  opened: boolean;
  frame: string | null;
  page: { url: string; title: string } | null;
  idle: NodeJS.Timeout | null;
  max: NodeJS.Timeout;
}

/** Statuses a run left the profile in when it stopped on an error; a running profile is not taken over. */
const FREE_PROFILE = ["AVAILABLE", "NEEDS_REVIEW", "DISABLED"];
const idParams = z.object({ id: z.uuid() });

/**
 * The operator works in a failed run's profile from the panel (REQ-UI-011): frames and input travel
 * over the agent's own connection, so nothing listens on the Mac (ADR-0032).
 */
export function registerRemote(app: App, { db, fleet, fleetConfig, coordinator, store, operatorAuth, config }: RemoteOptions) {
  const live = new Map<string, Live>();
  const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema };
  const toViewer = (s: Live, msg: object) => s.viewer?.readyState === 1 && s.viewer.send(JSON.stringify(msg));

  const watchIdle = (id: string, s: Live) => {
    if (s.idle) clearTimeout(s.idle);
    s.idle = s.viewer ? null : setTimeout(() => void end(id, "никто не смотрел сессию", true), config.idleMs);
  };

  /** Ends the session on the server; `tellAgent` closes the browser on the Mac too. */
  const end = async (id: string, reason: string, tellAgent: boolean) => {
    const s = live.get(id);
    if (s) {
      live.delete(id);
      if (s.idle) clearTimeout(s.idle);
      clearTimeout(s.max);
      if (tellAgent) fleet.send(s.agentId, message({ type: "remote.close", payload: { sessionId: id } }));
      toViewer(s, { type: "closed", reason });
      s.viewer?.close(1000, "session closed");
    }
    const ended = await db.updateTable("remote_sessions").set({ ended_at: new Date(), end_reason: reason }).where("id", "=", id).where("ended_at", "is", null).returning("id").executeTakeFirst();
    // The profile is free for runs again.
    if (ended) await coordinator.tick();
  };

  fleet.handlers.onRemote = (agentId, msg: RemoteAgentMessage) => {
    const id = msg.payload.sessionId;
    const s = live.get(id);
    if (!s || s.agentId !== agentId) return;
    switch (msg.type) {
      case "remote.opened":
        s.opened = true;
        return void toViewer(s, { type: "opened" });
      case "remote.frame":
        s.frame = msg.payload.data;
        return void toViewer(s, { type: "frame", data: msg.payload.data, width: msg.payload.width, height: msg.payload.height });
      case "remote.page": {
        const { url, title } = msg.payload;
        const changed = s.page?.url !== url;
        s.page = { url, title };
        toViewer(s, { type: "page", url, title });
        // Where the operator went is kept for the engine's fixers; what was typed is not.
        if (changed && /^https?:/.test(url))
          void db
            .updateTable("remote_sessions")
            .set({ urls: sql`urls || ${JSON.stringify([url])}::jsonb` })
            .where("id", "=", id)
            .execute()
            .catch(() => {});
        return;
      }
      case "remote.failed":
        return void end(id, `${msg.payload.code}: ${msg.payload.message}`, false);
      case "remote.closed":
        return void end(id, msg.payload.reason, false);
    }
  };
  fleet.handlers.onDisconnected = (agentId) => {
    for (const [id, s] of live) if (s.agentId === agentId) void end(id, "агент отключился", false);
  };

  /** Closes the operator's session on a profile, e.g. before the run is marked fixed. */
  const closeForProfile = async (profileId: string, reason: string) => {
    const open = await db.selectFrom("remote_sessions").select("id").where("profile_id", "=", profileId).where("ended_at", "is", null).execute();
    for (const r of open) await end(r.id, reason, true);
  };

  /** Where the run stopped: the page address from its failure snapshot. */
  const failureUrl = async (runId: string) => {
    const step = await db
      .selectFrom("run_steps")
      .innerJoin("artifacts", "artifacts.id", "run_steps.failure_artifact_id")
      .select("artifacts.storage_key")
      .where("run_steps.run_id", "=", runId)
      .orderBy("run_steps.sequence", "desc")
      .executeTakeFirst();
    if (!step) return null;
    const object = await store.get(step.storage_key).catch(() => null);
    try {
      const url = (JSON.parse(String(object?.body)) as { url?: unknown }).url;
      return typeof url === "string" && /^https?:/.test(url) ? url : null;
    } catch {
      return null;
    }
  };

  app.post(
    "/api/v1/runs/:id/remote",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 201: z.object({ sessionId: z.string() }), ...errors } } },
    async (request, reply) => {
      const run = await db
        .selectFrom("runs")
        .innerJoin("profiles", "profiles.id", "runs.profile_id")
        .innerJoin("agents", "agents.id", "profiles.agent_id")
        .select(["runs.id", "runs.profile_id", "profiles.agent_id", "profiles.status as profile_status", "profiles.external_profile_id", "agents.last_seen_at", "agents.last_heartbeat"])
        .where("runs.id", "=", request.params.id)
        .executeTakeFirst();
      if (!run) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      if (!FREE_PROFILE.includes(run.profile_status)) return sendError(reply, request, 409, "PROFILE_BUSY", `The profile is ${run.profile_status}: wait until the run on it ends`);
      if (!fleet.isConnected(run.agent_id) || connection(run.last_seen_at, fleetConfig) !== "ONLINE") return sendError(reply, request, 409, "AGENT_UNAVAILABLE", "The profile's Mac is not connected");
      if ((run.last_heartbeat as { lsAvailable?: boolean } | null)?.lsAvailable !== true) return sendError(reply, request, 409, "PROVIDER_UNAVAILABLE", "Linken Sphere does not answer on the profile's Mac: start it on «Агенты»");
      // A server restart loses the live side of a session: such a leftover is closed, not blocking.
      await db
        .updateTable("remote_sessions")
        .set({ ended_at: new Date(), end_reason: "сервер перезапущен" })
        .where("profile_id", "=", run.profile_id)
        .where("ended_at", "is", null)
        .where("id", "not in", [...live.keys(), "00000000-0000-0000-0000-000000000000"])
        .execute();
      const operator = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId!).executeTakeFirst();
      const row = await db
        .insertInto("remote_sessions")
        .values({ profile_id: run.profile_id, agent_id: run.agent_id, run_id: run.id, opened_by: operator?.login ?? null })
        .onConflict((oc) => oc.column("profile_id").where("ended_at", "is", null).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return sendError(reply, request, 409, "REMOTE_SESSION_OPEN", "Someone is already working in this profile's browser");
      const s: Live = { agentId: run.agent_id, profileId: run.profile_id, viewer: null, opened: false, frame: null, page: null, idle: null, max: setTimeout(() => void end(row.id, "время сессии истекло", true), config.maxMs) };
      live.set(row.id, s);
      watchIdle(row.id, s);
      fleet.send(run.agent_id, message({ type: "remote.open", payload: { sessionId: row.id, profileExternalId: run.external_profile_id, startUrl: await failureUrl(run.id) } }));
      return reply.code(201).send({ sessionId: row.id });
    },
  );

  app.post(
    "/api/v1/remote/:id/close",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const row = await db.selectFrom("remote_sessions").select("id").where("id", "=", request.params.id).executeTakeFirst();
      if (!row) return sendError(reply, request, 404, "NOT_FOUND", "Remote session not found");
      await end(row.id, "закрыта оператором", true);
      return reply.code(204).send(null);
    },
  );

  // The operator's view: frames and page changes in, input out. One viewer; a new tab takes over.
  app.get("/api/v1/remote/:id/ws", { websocket: true, preValidation: operatorAuth, schema: { params: idParams } }, (socket, request) => {
    const id = (request.params as { id: string }).id;
    const s = live.get(id);
    if (!s) {
      socket.send(JSON.stringify({ type: "closed", reason: "сессия уже закрыта" }));
      return socket.close(1000, "session closed");
    }
    if (s.viewer && s.viewer !== socket) s.viewer.close(4000, "opened in another tab");
    s.viewer = socket;
    watchIdle(id, s);
    if (s.opened) socket.send(JSON.stringify({ type: "opened" }));
    if (s.page) socket.send(JSON.stringify({ type: "page", ...s.page }));
    if (s.frame) socket.send(JSON.stringify({ type: "frame", data: s.frame }));
    socket.on("message", (raw) => {
      const parsed = z.object({ type: z.literal("input"), input: remoteInput }).safeParse(JSON.parse(String(raw)));
      if (!parsed.success || live.get(id) !== s) return;
      fleet.send(s.agentId, message({ type: "remote.input", payload: { sessionId: id, input: parsed.data.input } }));
    });
    socket.on("close", () => {
      if (s.viewer !== socket) return;
      s.viewer = null;
      if (live.get(id) === s) watchIdle(id, s);
    });
  });

  app.addHook("onClose", async () => {
    for (const id of [...live.keys()]) await end(id, "сервер остановлен", true);
  });

  return {
    closeForProfile,
    /** Profiles someone is working in right now: no run may start on them. */
    profiles: () => new Set([...live.values()].map((s) => s.profileId)),
  };
}
