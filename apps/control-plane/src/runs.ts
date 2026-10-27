import { createHash } from "node:crypto";
import type { Db, RunStatus } from "@bap/database";
import { type RunEvent, message } from "@bap/protocol";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
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
  store: ObjectStore;
  operatorAuth: preHandlerAsyncHookHandler;
}

export function registerRuns(app: App, { db, fleet, store, operatorAuth }: RunsOptions) {
  const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema };

  // ---- run coordinator: the only place that changes run status ----

  /** Changes status only from the listed states and journals the change in the same transaction. */
  const transition = (runId: string, from: RunStatus[], to: RunStatus, reason: string | null, extra: Partial<{ error_code: string; error_message: string; started_at: Date; finished_at: Date }> = {}) =>
    db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("status", "in", from).forUpdate().executeTakeFirst();
      if (!before) return false;
      await tx.updateTable("runs").set({ status: to, updated_at: new Date(), ...extra }).where("id", "=", runId).execute();
      await tx.insertInto("run_transitions").values({ run_id: runId, from_status: before.status, to_status: to, reason }).execute();
      return true;
    });

  const releaseProfile = (runId: string, to: "AVAILABLE" | "NEEDS_REVIEW", lastError: string | null) =>
    db.updateTable("profiles").set({ status: to, active_run_id: null, last_error: lastError, updated_at: new Date() }).where("active_run_id", "=", runId).execute();

  /** Hands a queued run to its profile's agent if the agent is connected; otherwise it waits for the agent. */
  const dispatch = async (runId: string) => {
    const run = await db
      .selectFrom("runs")
      .innerJoin("profiles", "profiles.id", "runs.profile_id")
      .innerJoin("scenario_versions", (j) => j.onRef("scenario_versions.scenario_id", "=", "runs.scenario_id").onRef("scenario_versions.version", "=", "runs.scenario_version"))
      .select(["runs.id", "runs.agent_id", "runs.status", "runs.input", "runs.timeout_ms", "runs.scenario_id", "runs.scenario_version", "scenario_versions.sha256", "profiles.external_profile_id"])
      .where("runs.id", "=", runId)
      .executeTakeFirstOrThrow();
    if (run.status !== "QUEUED" || !fleet.isConnected(run.agent_id)) return;
    // The profile is taken for this run atomically; a profile already in use leaves the run queued.
    const taken = await db
      .updateTable("profiles")
      .set({ status: "IN_USE", active_run_id: runId, updated_at: new Date() })
      .where("id", "=", (await db.selectFrom("runs").select("profile_id").where("id", "=", runId).executeTakeFirstOrThrow()).profile_id)
      .where("status", "=", "AVAILABLE")
      .returning("id")
      .executeTakeFirst();
    if (!taken) return;
    if (!(await transition(runId, ["QUEUED"], "ASSIGNED", `assigned to agent ${run.agent_id}`))) return releaseProfile(runId, "AVAILABLE", null);
    await db.insertInto("run_assignments").values({ run_id: runId, agent_id: run.agent_id }).execute();
    const sent = fleet.send(
      run.agent_id,
      message({
        type: "run.assign",
        payload: {
          runId,
          scenario: { id: run.scenario_id, version: run.scenario_version, sha256: run.sha256 },
          profileExternalId: run.external_profile_id,
          input: run.input,
          timeoutMs: run.timeout_ms,
        },
      }),
    );
    if (!sent) {
      await transition(runId, ["ASSIGNED"], "QUEUED", "agent disconnected before the assignment was sent");
      await releaseProfile(runId, "AVAILABLE", null);
    }
  };

  fleet.handlers.onConnected = async (agentId) => {
    const queued = await db.selectFrom("runs").select("id").where("agent_id", "=", agentId).where("status", "=", "QUEUED").orderBy("created_at").execute();
    for (const r of queued) await dispatch(r.id);
  };

  fleet.handlers.onRunEvent = async (agentId, event: RunEvent) => {
    const runId = event.payload.runId;
    const owner = await db.selectFrom("runs").select("agent_id").where("id", "=", runId).executeTakeFirst();
    if (owner?.agent_id !== agentId) return; // an agent may only report on its own runs
    switch (event.type) {
      case "run.accepted":
        await transition(runId, ["ASSIGNED"], "ACCEPTED", "agent accepted");
        await db.updateTable("run_assignments").set({ status: "ACCEPTED", acknowledged_at: new Date() }).where("run_id", "=", runId).where("acknowledged_at", "is", null).execute();
        break;
      case "run.started":
        await transition(runId, ["ACCEPTED"], "RUNNING", "browser session started", { started_at: new Date() });
        break;
      case "run.progress": {
        const step = event.payload.step;
        const shot = step.screenshot
          ? await db.selectFrom("artifacts").select("id").where("run_id", "=", runId).where("name", "=", step.screenshot).executeTakeFirst()
          : undefined;
        await db
          .insertInto("run_steps")
          .values({
            run_id: runId,
            sequence: step.sequence,
            step_id: step.stepId,
            mutating: step.mutating,
            status: step.status,
            started_at: step.startedAt,
            duration_ms: step.durationMs,
            error: step.error ?? null,
            screenshot_artifact_id: shot?.id ?? null,
          })
          .onConflict((oc) => oc.columns(["run_id", "sequence"]).doNothing())
          .execute();
        break;
      }
      case "run.completed":
        await transition(runId, ["RUNNING"], "SUCCEEDED", "all steps passed", { finished_at: new Date() });
        await releaseProfile(runId, "AVAILABLE", null);
        await db.updateTable("run_assignments").set({ status: "FINISHED", finished_at: new Date() }).where("run_id", "=", runId).execute();
        break;
      case "run.failed": {
        const { status, errorCode, message: text } = event.payload;
        await transition(runId, ["ACCEPTED", "RUNNING"], status, `${errorCode}: ${text}`, { error_code: errorCode, error_message: text, finished_at: new Date() });
        // An unconfirmed change keeps the profile blocked until an operator looks at it.
        await releaseProfile(runId, status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "AVAILABLE", status === "NEEDS_REVIEW" ? `run ${runId}: ${text}` : null);
        await db.updateTable("run_assignments").set({ status: "FINISHED", finished_at: new Date() }).where("run_id", "=", runId).execute();
        break;
      }
    }
  };

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

  const viewRun = (r: { id: string; scenario_id: string; scenario_version: string; profile_id: string; agent_id: string; status: RunStatus; input: unknown; timeout_ms: number; error_code: string | null; error_message: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null }) => ({
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
      await dispatch(runId);
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
    { preHandler: operatorAuth, schema: { params: idParams, response: { 200: runSchema.extend({ transitions: z.array(transitionSchema) }), ...errors } } },
    async (request, reply) => {
      const run = await loadRun(request.params.id);
      if (!run) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      const transitions = await db.selectFrom("run_transitions").selectAll().where("run_id", "=", run.id).orderBy("id").execute();
      return { ...run, transitions: transitions.map((t) => ({ from: t.from_status, to: t.to_status, reason: t.reason, at: t.at.toISOString() })) };
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
