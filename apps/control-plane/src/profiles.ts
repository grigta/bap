import type { Db, ProfileStatus } from "@bap/database";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
import { AgentRequestError, type Fleet, type FleetConfig, connection } from "./fleet.ts";
import { moveProfile } from "./profile-states.ts";

const STATUSES = ["AVAILABLE", "RESERVED", "IN_USE", "VERIFYING", "NEEDS_REVIEW", "DISABLED"] as const;

/** Public view: identifiers and state only; never cookies, storage or provider credentials. */
const profileSchema = z.object({
  id: z.string(),
  provider: z.string(),
  externalProfileId: z.string(),
  name: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentConnection: z.enum(["ONLINE", "SUSPECT", "OFFLINE"]),
  status: z.enum(STATUSES),
  /** Whether a run may be assigned now: AVAILABLE on an ACTIVE, ONLINE agent. */
  assignable: z.boolean(),
  activeRunId: z.string().nullable(),
  lastError: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type ProfileView = z.infer<typeof profileSchema>;

const idParams = z.object({ id: z.uuid() });
export const PROFILE_NOT_FOUND_MESSAGE = "Profile not found at the provider: configuration error";

export function registerProfiles(app: App, db: Db, fleet: Fleet, config: FleetConfig, operatorAuth: preHandlerAsyncHookHandler) {
  const responses = { 401: errorSchema, 404: errorSchema, 409: errorSchema };

  const load = async (id?: string): Promise<ProfileView[]> => {
    let query = db
      .selectFrom("profiles")
      .innerJoin("agents", "agents.id", "profiles.agent_id")
      .selectAll("profiles")
      .select(["agents.name as agent_name", "agents.status as agent_status", "agents.last_seen_at"])
      .orderBy("profiles.name");
    // Profiles of a deleted agent stay in the database for history, not in the panel.
    query = id ? query.where("profiles.id", "=", id) : query.where("profiles.archived_at", "is", null);
    return (await query.execute()).map((r) => {
      const agentConnection = connection(r.last_seen_at, config);
      return {
        id: r.id,
        provider: r.provider,
        externalProfileId: r.external_profile_id,
        name: r.name,
        agentId: r.agent_id,
        agentName: r.agent_name,
        agentConnection,
        status: r.status,
        assignable: r.status === "AVAILABLE" && r.agent_status === "ACTIVE" && agentConnection === "ONLINE",
        activeRunId: r.active_run_id,
        lastError: r.last_error,
        lastVerifiedAt: r.last_verified_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    });
  };

  const transition = (id: string, from: ProfileStatus[], to: ProfileStatus, extra: { last_error?: string | null } = {}) => moveProfile(db, id, from, to, extra);

  const conflict = async (request: FastifyRequest, reply: FastifyReply, id: string, action: string) => {
    const [profile] = await load(id);
    if (!profile) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
    return sendError(reply, request, 409, "PROFILE_STATE_CONFLICT", `Cannot ${action} a profile in status ${profile.status}`);
  };

  /** Moves the profile to VERIFYING and lets its agent open and close it; the outcome lands asynchronously. */
  const startVerify = async (request: FastifyRequest, reply: FastifyReply, id: string, from: ProfileStatus[], action: string) => {
    const [current] = await load(id);
    if (!current) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
    if (!fleet.isConnected(current.agentId)) return sendError(reply, request, 409, "AGENT_UNAVAILABLE", "The profile's agent is not connected");
    const row = await transition(id, from, "VERIFYING");
    if (!row) return conflict(request, reply, id, action);
    void fleet.request(row.agent_id, { method: "profiles.verify", externalId: row.external_profile_id }).then(
      () => moveProfile(db, id, ["VERIFYING"], "AVAILABLE", { last_verified_at: new Date(), last_error: null }),
      (e: unknown) => {
        const code = e instanceof AgentRequestError ? e.code : "AGENT_ERROR";
        const lastError = code === "PROFILE_NOT_FOUND" ? PROFILE_NOT_FOUND_MESSAGE : `${code}: ${e instanceof Error ? e.message : String(e)}`;
        return transition(id, ["VERIFYING"], "NEEDS_REVIEW", { last_error: lastError });
      },
    ).catch((e) => request.log.error(e));
    return reply.code(202).send((await load(id))[0]!);
  };

  app.get(
    "/api/v1/agents/:id/provider-profiles",
    {
      preHandler: operatorAuth,
      schema: { params: idParams, response: { 200: z.array(z.object({ id: z.string(), name: z.string(), importedAs: z.string().nullable() })), ...responses } },
    },
    async (request, reply) => {
      let listed: { id: string; name: string }[];
      try {
        listed = (await fleet.request(request.params.id, { method: "profiles.list" }, 15_000)) as typeof listed;
      } catch (e) {
        if (e instanceof AgentRequestError) return sendError(reply, request, 409, e.code, e.message);
        throw e;
      }
      const imported = await db.selectFrom("profiles").select(["id", "external_profile_id"]).where("agent_id", "=", request.params.id).execute();
      return listed.map((p) => ({ id: p.id, name: p.name, importedAs: imported.find((i) => i.external_profile_id === p.id)?.id ?? null }));
    },
  );

  app.post(
    "/api/v1/profiles/import",
    {
      preHandler: operatorAuth,
      schema: { body: z.object({ agentId: z.uuid(), externalProfileId: z.string().min(1), name: z.string().min(1) }), response: { 201: profileSchema, ...responses } },
    },
    async (request, reply) => {
      const { agentId, externalProfileId, name } = request.body;
      const agent = await db
        .selectFrom("agents")
        .leftJoin("agent_capabilities", "agent_capabilities.agent_id", "agents.id")
        .select(["agents.id", "agent_capabilities.payload"])
        .where("agents.id", "=", agentId)
        .executeTakeFirst();
      if (!agent) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      const provider = (agent.payload as { providers?: string[] } | null)?.providers?.[0];
      if (!provider) return sendError(reply, request, 409, "PROVIDER_UNAVAILABLE", "The agent reports no browser provider");
      const row = await db
        .insertInto("profiles")
        .values({ provider, external_profile_id: externalProfileId, name, agent_id: agentId })
        .onConflict((oc) => oc.columns(["provider", "external_profile_id"]).where("archived_at", "is", null).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return sendError(reply, request, 409, "PROFILE_EXISTS", `Profile ${externalProfileId} is already imported`);
      return reply.code(201).send((await load(row.id))[0]!);
    },
  );

  app.get("/api/v1/profiles", { preHandler: operatorAuth, schema: { response: { 200: z.array(profileSchema), ...responses } } }, () => load());

  app.get("/api/v1/profiles/:id", { preHandler: operatorAuth, schema: { params: idParams, response: { 200: profileSchema, ...responses } } }, async (request, reply) => {
    const [profile] = await load(request.params.id);
    return profile ?? sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
  });

  // Removing a profile from the panel: its rows stay for the runs that used it (REQ-DB-002), and the
  // provider profile can be imported again. Not while a browser may hold it or a run still waits for it.
  app.delete(
    "/api/v1/profiles/:id",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 204: z.null(), ...responses, 409: errorSchema } } },
    async (request, reply) => {
      const profile = await db.selectFrom("profiles").select(["id", "status"]).where("id", "=", request.params.id).where("archived_at", "is", null).executeTakeFirst();
      if (!profile) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
      const waiting = await db
        .selectFrom("runs")
        .select("id")
        .where("profile_id", "=", profile.id)
        .where("status", "not in", ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"])
        .executeTakeFirst();
      if (["RESERVED", "IN_USE", "VERIFYING"].includes(profile.status) || waiting)
        return sendError(reply, request, 409, "PROFILE_IN_USE", waiting ? `Run ${waiting.id} still waits for this profile: cancel it first` : `The profile is ${profile.status}: wait until it is released`);
      await db.updateTable("profiles").set({ archived_at: new Date() }).where("id", "=", profile.id).execute();
      return reply.code(204).send(null);
    },
  );

  app.post("/api/v1/profiles/:id/verify", { preHandler: operatorAuth, schema: { params: idParams, response: { 202: profileSchema, ...responses } } }, (request, reply) =>
    startVerify(request, reply, request.params.id, ["AVAILABLE", "NEEDS_REVIEW"], "verify"),
  );

  // Enabling re-checks the profile first: it comes back as AVAILABLE only after a successful verify.
  app.post("/api/v1/profiles/:id/enable", { preHandler: operatorAuth, schema: { params: idParams, response: { 202: profileSchema, ...responses } } }, (request, reply) =>
    startVerify(request, reply, request.params.id, ["DISABLED"], "enable"),
  );

  for (const [action, from, to] of [
    ["disable", ["AVAILABLE", "NEEDS_REVIEW"], "DISABLED"],
    ["release-review", ["NEEDS_REVIEW"], "AVAILABLE"],
  ] as const) {
    app.post(`/api/v1/profiles/:id/${action}`, { preHandler: operatorAuth, schema: { params: idParams, response: { 200: profileSchema, ...responses } } }, async (request, reply) => {
      const row = await transition(request.params.id, [...from], to, action === "release-review" ? { last_error: null } : {});
      if (!row) return conflict(request, reply, request.params.id, action);
      return (await load(row.id))[0]!;
    });
  }
}
