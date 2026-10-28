import { createHash } from "node:crypto";
import type { Db, RunStatus } from "@bap/database";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
import type { Coordinator } from "./coordinator.ts";
import type { Fleet } from "./fleet.ts";
import type { ObjectStore } from "./storage.ts";

const RUN_STATUSES = ["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED", "RECOVERY_PENDING", "NEEDS_REVIEW", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
const FINAL: RunStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"];
const MAX_TIMEOUT_MS = 60 * 60_000;

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** Canonical JSON (sorted keys) so equal request bodies hash equally. */
const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;

const runSchema = z.object({
  id: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.string(),
  profileId: z.string(),
  agentId: z.string(),
  status: z.enum(RUN_STATUSES),
  input: z.unknown(),
  timeoutMs: z.number(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Why a QUEUED run waits (agent drained, provider down, profile busy, capacity…). */
  queueReason: z.string().nullable(),
  autoResume: z.boolean().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
const transitionSchema = z.object({ from: z.string().nullable(), to: z.string(), reason: z.string().nullable(), at: z.string() });
const stepSchema = z.object({
  sequence: z.number(),
  stepId: z.string(),
  mutating: z.boolean(),
  status: z.enum(["passed", "failed", "unverified"]),
  startedAt: z.string(),
  durationMs: z.number(),
  error: z.string().nullable(),
  screenshotArtifactId: z.string().nullable(),
});
const artifactSchema = z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), sha256: z.string(), createdAt: z.string() });
const idParams = z.object({ id: z.uuid() });

export interface RunsOptions {
  db: Db;
  fleet: Fleet;
  coordinator: Coordinator;
  store: ObjectStore;
  operatorAuth: preHandlerAsyncHookHandler;
}

export function registerRuns(app: App, { db, fleet, coordinator, store, operatorAuth }: RunsOptions) {
  const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema };

  // ---- scenarios ----

  app.post(
    "/api/v1/scenarios/:id/versions",
    {
      preHandler: operatorAuth,
      schema: {
        params: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }),
        body: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), bundleKey: z.string().min(1) }),
        response: { 201: z.object({ id: z.string(), version: z.string(), sha256: z.string() }), 200: z.object({ id: z.string(), version: z.string(), sha256: z.string() }), ...errors, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { version, sha256: expected, bundleKey } = request.body;
      // Code never travels through the API: the bundle must already be in storage with this checksum.
      const object = await store.get(bundleKey);
      if (!object) return sendError(reply, request, 422, "BUNDLE_NOT_FOUND", `No bundle stored at ${bundleKey}`);
      if (sha256(object.body) !== expected) return sendError(reply, request, 422, "BUNDLE_CHECKSUM_MISMATCH", "Stored bundle does not match the sha256");
      const existing = await db.selectFrom("scenario_versions").select("sha256").where("scenario_id", "=", id).where("version", "=", version).executeTakeFirst();
      if (existing) {
        if (existing.sha256 === expected) return reply.code(200).send({ id, version, sha256: expected });
        return sendError(reply, request, 409, "SCENARIO_VERSION_EXISTS", `${id}@${version} is already registered with another checksum; versions are immutable`);
      }
      await db.insertInto("scenarios").values({ id }).onConflict((oc) => oc.column("id").doNothing()).execute();
      await db.insertInto("scenario_versions").values({ scenario_id: id, version, sha256: expected, bundle_key: bundleKey }).execute();
      return reply.code(201).send({ id, version, sha256: expected });
    },
  );

  const versionSchema = z.object({ version: z.string(), sha256: z.string(), createdAt: z.string() });
  const listVersions = async (id?: string) => {
    let q = db.selectFrom("scenario_versions").selectAll().orderBy("scenario_id").orderBy("created_at");
    if (id) q = q.where("scenario_id", "=", id);
    return (await q.execute()).map((v) => ({ scenarioId: v.scenario_id, version: v.version, sha256: v.sha256, createdAt: v.created_at.toISOString() }));
  };

  app.get("/api/v1/scenarios", { preHandler: operatorAuth, schema: { response: { 200: z.array(z.object({ id: z.string(), versions: z.array(versionSchema) })), ...errors } } }, async () => {
    const byId = new Map<string, z.infer<typeof versionSchema>[]>();
    for (const v of await listVersions()) byId.set(v.scenarioId, [...(byId.get(v.scenarioId) ?? []), { version: v.version, sha256: v.sha256, createdAt: v.createdAt }]);
    return [...byId].map(([id, versions]) => ({ id, versions }));
  });

  app.get(
    "/api/v1/scenarios/:id/versions",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.string() }), response: { 200: z.array(versionSchema), ...errors } } },
    async (request, reply) => {
      const versions = await listVersions(request.params.id);
      if (versions.length === 0) return sendError(reply, request, 404, "NOT_FOUND", "Scenario not found");
      return versions.map(({ version, sha256: sum, createdAt }) => ({ version, sha256: sum, createdAt }));
    },
  );

  app.get("/api/v1/scenarios/:id/versions/:version/bundle", { preHandler: fleet.agentAuth, schema: { params: z.object({ id: z.string(), version: z.string() }) } }, async (request, reply) => {
    const v = await db.selectFrom("scenario_versions").select("bundle_key").where("scenario_id", "=", request.params.id).where("version", "=", request.params.version).executeTakeFirst();
    const object = v && (await store.get(v.bundle_key));
    if (!object) return sendError(reply, request, 404, "NOT_FOUND", "Bundle not found");
    return reply.type("text/javascript").send(object.body);
  });

  // ---- runs ----

  const viewRun = (r: { id: string; scenario_id: string; scenario_version: string; profile_id: string; agent_id: string; status: RunStatus; input: unknown; timeout_ms: number; error_code: string | null; error_message: string | null; queue_reason: string | null; auto_resume: boolean | null; created_at: Date; started_at: Date | null; finished_at: Date | null }) => ({
    id: r.id,
    scenarioId: r.scenario_id,
    scenarioVersion: r.scenario_version,
    profileId: r.profile_id,
    agentId: r.agent_id,
    status: r.status,
    input: r.input,
    timeoutMs: r.timeout_ms,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    queueReason: r.status === "QUEUED" ? r.queue_reason : null,
    autoResume: r.auto_resume,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  });
  const loadRun = async (id: string) => {
    const r = await db.selectFrom("runs").selectAll().where("id", "=", id).executeTakeFirst();
    return r && viewRun(r);
  };

  app.post(
    "/api/v1/runs",
    {
      preHandler: operatorAuth,
      schema: {
        headers: z.object({ "idempotency-key": z.string().min(8).max(200).optional() }),
        body: z.object({
          scenarioId: z.string().min(1),
          scenarioVersion: z.string().min(1),
          profileId: z.uuid(),
          input: z.unknown().default({}),
          timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(120_000),
        }),
        response: { 202: z.object({ runId: z.string(), status: z.enum(RUN_STATUSES), scenarioId: z.string(), assignedAgentId: z.string().nullable() }), 400: errorSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (!key) return sendError(reply, request, 400, "IDEMPOTENCY_KEY_REQUIRED", "The Idempotency-Key header is required");
      const body = request.body;
      const requestHash = sha256(canonical(body));
      const accepted = async (runId: string) => {
        const run = (await loadRun(runId))!;
        return reply.code(202).send({ runId, status: run.status, scenarioId: run.scenarioId, assignedAgentId: run.status === "QUEUED" ? null : run.agentId });
      };
      const replay = async () => {
        const seen = await db.selectFrom("idempotency_keys").selectAll().where("key", "=", key).executeTakeFirst();
        if (!seen) return null;
        if (seen.request_hash !== requestHash) return sendError(reply, request, 409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
        return accepted(seen.run_id);
      };
      const earlier = await replay();
      if (earlier) return earlier;

      const version = await db.selectFrom("scenario_versions").select("version").where("scenario_id", "=", body.scenarioId).where("version", "=", body.scenarioVersion).executeTakeFirst();
      if (!version) return sendError(reply, request, 409, "SCENARIO_VERSION_MISMATCH", `Scenario ${body.scenarioId}@${body.scenarioVersion} is not registered`);
      const profile = await db.selectFrom("profiles").select(["id", "agent_id", "status"]).where("id", "=", body.profileId).executeTakeFirst();
      if (!profile) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
      if (profile.status === "NEEDS_REVIEW") return sendError(reply, request, 409, "PROFILE_NEEDS_REVIEW", "The profile needs review before new runs");
      if (profile.status === "DISABLED") return sendError(reply, request, 409, "PROFILE_DISABLED", "The profile is disabled");

      let runId: string;
      try {
        runId = await db.transaction().execute(async (tx) => {
          // The run goes to the profile's agent: placement is not part of the API (ADR-0003).
          const run = await tx
            .insertInto("runs")
            .values({ scenario_id: body.scenarioId, scenario_version: body.scenarioVersion, profile_id: profile.id, agent_id: profile.agent_id, input: JSON.stringify(body.input), timeout_ms: body.timeoutMs })
            .returning("id")
            .executeTakeFirstOrThrow();
          await tx.insertInto("run_transitions").values({ run_id: run.id, from_status: null, to_status: "QUEUED", reason: "created" }).execute();
          await tx.insertInto("idempotency_keys").values({ key, request_hash: requestHash, run_id: run.id }).execute();
          return run.id;
        });
      } catch (e) {
        // A concurrent request with the same key won the insert: answer like a replay.
        if ((e as { code?: string }).code === "23505") return (await replay())!;
        throw e;
      }
      await coordinator.tick();
      return accepted(runId);
    },
  );

  app.get(
    "/api/v1/runs",
    { preHandler: operatorAuth, schema: { querystring: z.object({ status: z.enum(RUN_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), response: { 200: z.array(runSchema), ...errors } } },
    async (request) => {
      let q = db.selectFrom("runs").selectAll().orderBy("created_at", "desc").limit(request.query.limit);
      if (request.query.status) q = q.where("status", "=", request.query.status);
      return (await q.execute()).map(viewRun);
    },
  );

  app.get(
    "/api/v1/runs/:id",
    {
      preHandler: operatorAuth,
      schema: {
        params: idParams,
        response: {
          200: runSchema.extend({
            transitions: z.array(transitionSchema),
            checkpoints: z.array(z.object({ sequence: z.number(), stepId: z.string(), nextStepId: z.string().nullable(), nextStepMutating: z.boolean(), createdAt: z.string() })),
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const run = await loadRun(request.params.id);
      if (!run) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      const transitions = await db.selectFrom("run_transitions").selectAll().where("run_id", "=", run.id).orderBy("id").execute();
      const checkpoints = await db.selectFrom("checkpoints").selectAll().where("run_id", "=", run.id).orderBy("sequence").execute();
      return {
        ...run,
        transitions: transitions.map((t) => ({ from: t.from_status, to: t.to_status, reason: t.reason, at: t.at.toISOString() })),
        checkpoints: checkpoints.map((c) => ({ sequence: c.sequence, stepId: c.step_id, nextStepId: c.next_step_id, nextStepMutating: c.next_step_mutating, createdAt: c.created_at.toISOString() })),
      };
    },
  );

  app.post(
    "/api/v1/runs/:id/cancel",
    { preHandler: operatorAuth, schema: { params: idParams, response: { 202: runSchema, ...errors } } },
    async (request, reply) => {
      const outcome = await coordinator.cancel(request.params.id);
      const run = await loadRun(request.params.id);
      if (!run) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      if (outcome === "conflict") return sendError(reply, request, 409, "RUN_STATE_CONFLICT", `Cannot cancel a run in status ${run.status}`);
      return reply.code(202).send(run);
    },
  );

  // Accepting a resume request is not a promise that the run will succeed (REQ-API-007).
  app.post(
    "/api/v1/runs/:id/resume",
    {
      preHandler: operatorAuth,
      schema: {
        params: idParams,
        body: z.object({ mode: z.literal("safe-checkpoint"), operatorConfirmed: z.boolean() }),
        response: { 202: z.object({ runId: z.string(), accepted: z.literal(true), status: z.enum(RUN_STATUSES) }), 400: errorSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!request.body.operatorConfirmed) return sendError(reply, request, 400, "OPERATOR_CONFIRMATION_REQUIRED", "Set operatorConfirmed: true after checking the run");
      const run = await loadRun(request.params.id);
      if (!run) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      if (!(await coordinator.requestResume(run.id))) return sendError(reply, request, 409, "RUN_STATE_CONFLICT", `Only RECOVERY_PENDING runs can be resumed; this one is ${run.status}`);
      return reply.code(202).send({ runId: run.id, accepted: true, status: (await loadRun(run.id))!.status });
    },
  );

  app.get(
    "/api/v1/review",
    {
      preHandler: operatorAuth,
      schema: {
        response: {
          200: z.object({
            runs: z.array(z.object({ id: z.string(), scenarioId: z.string(), profileId: z.string(), status: z.string(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), finishedAt: z.string().nullable() })),
            profiles: z.array(z.object({ id: z.string(), name: z.string(), agentName: z.string(), lastError: z.string().nullable(), updatedAt: z.string() })),
          }),
          ...errors,
        },
      },
    },
    async () => {
      const runs = await db.selectFrom("runs").selectAll().where("status", "in", ["NEEDS_REVIEW", "RECOVERY_PENDING"]).orderBy("updated_at", "desc").limit(200).execute();
      const profiles = await db
        .selectFrom("profiles")
        .innerJoin("agents", "agents.id", "profiles.agent_id")
        .select(["profiles.id", "profiles.name", "agents.name as agent_name", "profiles.last_error", "profiles.updated_at"])
        .where("profiles.status", "=", "NEEDS_REVIEW")
        .orderBy("profiles.updated_at", "desc")
        .execute();
      return {
        runs: runs.map((r) => ({ id: r.id, scenarioId: r.scenario_id, profileId: r.profile_id, status: r.status, errorCode: r.error_code, errorMessage: r.error_message, finishedAt: r.finished_at?.toISOString() ?? null })),
        profiles: profiles.map((p) => ({ id: p.id, name: p.name, agentName: p.agent_name, lastError: p.last_error, updatedAt: p.updated_at.toISOString() })),
      };
    },
  );

  app.get("/api/v1/runs/:id/steps", { preHandler: operatorAuth, schema: { params: idParams, response: { 200: z.array(stepSchema), ...errors } } }, async (request) => {
    const steps = await db.selectFrom("run_steps").selectAll().where("run_id", "=", request.params.id).orderBy("sequence").execute();
    return steps.map((s) => ({
      sequence: s.sequence,
      stepId: s.step_id,
      mutating: s.mutating,
      status: s.status,
      startedAt: s.started_at.toISOString(),
      durationMs: s.duration_ms,
      error: s.error,
      screenshotArtifactId: s.screenshot_artifact_id,
    }));
  });

  app.get("/api/v1/runs/:id/artifacts", { preHandler: operatorAuth, schema: { params: idParams, response: { 200: z.array(artifactSchema), ...errors } } }, async (request) => {
    const rows = await db.selectFrom("artifacts").selectAll().where("run_id", "=", request.params.id).orderBy("name").execute();
    return rows.map((a) => ({ id: a.id, name: a.name, contentType: a.content_type, sizeBytes: a.size_bytes, sha256: a.sha256, createdAt: a.created_at.toISOString() }));
  });

  app.get(
    "/api/v1/runs/:id/artifacts/:artifactId/content",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.uuid(), artifactId: z.uuid() }) } },
    async (request, reply) => {
      const a = await db.selectFrom("artifacts").select(["storage_key", "content_type"]).where("id", "=", request.params.artifactId).where("run_id", "=", request.params.id).executeTakeFirst();
      const object = a && (await store.get(a.storage_key));
      if (!object) return sendError(reply, request, 404, "NOT_FOUND", "Artifact not found");
      return reply.type(a.content_type).header("cache-control", "private, max-age=86400").send(object.body);
    },
  );

  app.addContentTypeParser("image/png", { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.put(
    "/api/v1/runs/:id/artifacts/:name",
    { preHandler: fleet.agentAuth, schema: { params: z.object({ id: z.uuid(), name: z.string().regex(/^[\w.-]+$/) }) } },
    async (request, reply) => {
      const run = await db.selectFrom("runs").select(["agent_id", "status"]).where("id", "=", request.params.id).executeTakeFirst();
      if (!run || run.agent_id !== request.agentId) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      if (FINAL.includes(run.status)) return sendError(reply, request, 409, "RUN_STATE_CONFLICT", `Run is ${run.status}`);
      const body = request.body as Buffer;
      const key = `runs/${request.params.id}/${request.params.name}`;
      await store.put(key, body, "image/png");
      await db
        .insertInto("artifacts")
        .values({ run_id: request.params.id, name: request.params.name, content_type: "image/png", size_bytes: body.length, sha256: sha256(body), storage_key: key })
        .onConflict((oc) => oc.columns(["run_id", "name"]).doNothing())
        .execute();
      return reply.code(204).send();
    },
  );
}
