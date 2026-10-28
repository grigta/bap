import { createHash } from "node:crypto";
import type { Db } from "@bap/database";
import { type Fingerprint, type PageSnapshot, type SnapshotElement, fingerprintOf, renderTemplate, resolve, serializeSnapshot, templatize } from "@bap/dom-snapshot";
import { type Recipe, type RecipeInput, type RecipeStep, recipeInputSchema, recipeJsonSchema, recipeSchema } from "@bap/recipe";
import type { RecordDecision } from "@bap/recipe";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import type { Coordinator } from "./coordinator.ts";
import { errorSchema, sendError } from "./errors.ts";
import type { Fleet } from "./fleet.ts";
import { BudgetExceededError } from "./llm/gate.ts";
import type { Model } from "./llm/model.ts";
import { HEAL_SYSTEM, type HealDecision, RECORD_SYSTEM, type RecordDecision as ModelDecision, healSchema, recordSchema } from "./llm/prompts.ts";
import type { ObjectStore } from "./storage.ts";

export interface RecipesOptions {
  db: Db;
  fleet: Fleet;
  coordinator: Coordinator;
  store: ObjectStore;
  operatorAuth: preHandlerAsyncHookHandler;
  /** null: the server has no model access; recording and healing are refused. */
  model: Model | null;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const MAX_RECORDING_MS = 60 * 60_000;

// The agent sends what captureSnapshot built; the server checks the shape it relies on.
const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  elements: z.array(
    z.looseObject({
      ref: z.string(),
      role: z.string(),
      name: z.string(),
      tag: z.string(),
      text: z.string(),
      attrs: z.record(z.string(), z.string()),
      states: z.array(z.string()),
      visible: z.boolean(),
      interactive: z.boolean(),
      rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      label: z.string(),
      context: z.string(),
      path: z.array(z.string()),
      frame: z.string(),
    }),
  ),
  text: z.string(),
});

/** A recipe step while recording: where it acted and what the next look showed. */
type DraftStep = RecipeStep & { urlBefore: string; urlAfter?: string; titleAfter?: string };
interface Pending {
  decision: Extract<RecordDecision, { type: "act" }>;
  screenshot: string;
}

export function registerRecipes(app: App, { db, fleet, coordinator, store, operatorAuth, model }: RecipesOptions) {
  const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema };

  const inputsOf = (raw: unknown): RecipeInput[] => z.array(recipeInputSchema).parse(raw ?? []);
  /** Input values the model and the recipe may see: secrets are left out (REQ-DOM-003). */
  const openValues = (inputs: RecipeInput[], input: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(input).filter(([k]) => !inputs.some((i) => i.name === k && i.secret)));

  const nextVersion = async (scenarioId: string) => {
    const rows = await db.selectFrom("scenario_versions").select("version").where("scenario_id", "=", scenarioId).execute();
    return `${Math.max(0, ...rows.map((r) => Number(r.version.split(".")[0]))) + 1}.0.0`;
  };

  /** Stores an immutable recipe version (REQ-DOM-005): delivered to agents with its sha256 like a bundle. */
  const saveVersion = async (scenarioId: string, recipe: Recipe, meta: { origin: "manual" | "recorded" | "healed"; published: boolean; sourceRunId?: string; parent?: string; note?: string }) => {
    const version = await nextVersion(scenarioId);
    const body = Buffer.from(JSON.stringify(recipe, null, 2) + "\n");
    const key = `recipes/${scenarioId}/${version}.json`;
    await store.put(key, body, "application/json");
    await db
      .insertInto("scenario_versions")
      .values({
        scenario_id: scenarioId,
        version,
        sha256: sha256(body),
        bundle_key: key,
        published_at: meta.published ? new Date() : null,
        origin: meta.origin,
        source_run_id: meta.sourceRunId ?? null,
        parent_version: meta.parent ?? null,
        note: meta.note ?? null,
      })
      .execute();
    return version;
  };

  const loadRecipe = async (scenarioId: string, version: string): Promise<Recipe | null> => {
    const row = await db.selectFrom("scenario_versions").select("bundle_key").where("scenario_id", "=", scenarioId).where("version", "=", version).executeTakeFirst();
    const object = row && (await store.get(row.bundle_key));
    return object ? recipeSchema.parse(JSON.parse(object.body.toString("utf8"))) : null;
  };

  // ---- operator API ----

  const versionView = z.object({
    version: z.string(),
    origin: z.enum(["bundle", "manual", "recorded", "healed"]),
    publishedAt: z.string().nullable(),
    createdAt: z.string(),
    sourceRunId: z.string().nullable(),
    parentVersion: z.string().nullable(),
    note: z.string().nullable(),
  });
  const recipeView = z.object({
    id: z.string(),
    goal: z.string(),
    startUrl: z.string(),
    inputs: z.array(z.object({ name: z.string(), secret: z.boolean() })),
    createdAt: z.string(),
    versions: z.array(versionView),
    lastRecording: z.object({ runId: z.string(), status: z.string(), createdAt: z.string() }).nullable(),
  });

  const listRecipes = async (id?: string) => {
    let q = db.selectFrom("scenarios").selectAll().where("kind", "=", "recipe").orderBy("created_at", "desc");
    if (id) q = q.where("id", "=", id);
    const recipes = await q.execute();
    const out: z.infer<typeof recipeView>[] = [];
    for (const r of recipes) {
      const versions = await db.selectFrom("scenario_versions").selectAll().where("scenario_id", "=", r.id).orderBy("created_at").execute();
      const rec = await db.selectFrom("runs").select(["id", "status", "created_at"]).where("scenario_id", "=", r.id).where("kind", "=", "record").orderBy("created_at", "desc").executeTakeFirst();
      out.push({
        id: r.id,
        goal: r.goal ?? "",
        startUrl: r.start_url ?? "",
        inputs: inputsOf(r.inputs),
        createdAt: r.created_at.toISOString(),
        versions: versions.map((v) => ({
          version: v.version,
          origin: v.origin,
          publishedAt: v.published_at?.toISOString() ?? null,
          createdAt: v.created_at.toISOString(),
          sourceRunId: v.source_run_id,
          parentVersion: v.parent_version,
          note: v.note,
        })),
        lastRecording: rec ? { runId: rec.id, status: rec.status, createdAt: rec.created_at.toISOString() } : null,
      });
    }
    return out;
  };

  app.get("/api/v1/recipes/schema", { preHandler: operatorAuth }, async () => recipeJsonSchema());

  app.get("/api/v1/recipes", { preHandler: operatorAuth, schema: { response: { 200: z.array(recipeView), ...errors } } }, async () => listRecipes());

  app.get("/api/v1/recipes/:id", { preHandler: operatorAuth, schema: { params: z.object({ id: z.string() }), response: { 200: recipeView, ...errors } } }, async (request, reply) => {
    const [recipe] = await listRecipes(request.params.id);
    return recipe ?? sendError(reply, request, 404, "NOT_FOUND", "Recipe not found");
  });

  app.get(
    "/api/v1/recipes/:id/versions/:version",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.string(), version: z.string() }), response: { 200: z.object({ version: z.string(), recipe: z.unknown() }), ...errors } } },
    async (request, reply) => {
      const recipe = await loadRecipe(request.params.id, request.params.version);
      if (!recipe) return sendError(reply, request, 404, "NOT_FOUND", "Recipe version not found");
      return { version: request.params.version, recipe };
    },
  );

  app.get("/api/v1/recipes/:id/screenshots/*", { preHandler: operatorAuth, schema: { params: z.object({ id: z.string(), "*": z.string() }) } }, async (request, reply) => {
    const key = `recipes/${request.params.id}/${request.params["*"]}`;
    const object = /^[\w./-]+$/.test(key) && !key.includes("..") ? await store.get(key) : null;
    if (!object) return sendError(reply, request, 404, "NOT_FOUND", "Screenshot not found");
    return reply.type("image/png").header("cache-control", "private, max-age=86400").send(object.body);
  });

  // A recipe written by hand: stored as a draft like a recorded one (S11.2).
  app.post(
    "/api/v1/recipes/:id/versions",
    {
      preHandler: operatorAuth,
      schema: { params: z.object({ id: idSchema }), body: recipeSchema, response: { 201: z.object({ id: z.string(), version: z.string() }), ...errors } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const recipe = request.body;
      const existing = await db.selectFrom("scenarios").select("kind").where("id", "=", id).executeTakeFirst();
      if (existing && existing.kind !== "recipe") return sendError(reply, request, 409, "SCENARIO_KIND_CONFLICT", `${id} is a code scenario`);
      if (!existing) await db.insertInto("scenarios").values({ id, kind: "recipe", goal: recipe.goal, start_url: recipe.startUrl, inputs: JSON.stringify(recipe.inputs) }).execute();
      const version = await saveVersion(id, recipe, { origin: "manual", published: false });
      return reply.code(201).send({ id, version });
    },
  );

  app.post(
    "/api/v1/recipes/:id/versions/:version/publish",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.string(), version: z.string() }), response: { 200: versionView, ...errors } } },
    async (request, reply) => {
      const { id, version } = request.params;
      const updated = await db
        .updateTable("scenario_versions")
        .set({ published_at: new Date() })
        .where("scenario_id", "=", id)
        .where("version", "=", version)
        .where("published_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      const row = updated ?? (await db.selectFrom("scenario_versions").selectAll().where("scenario_id", "=", id).where("version", "=", version).executeTakeFirst());
      if (!row) return sendError(reply, request, 404, "NOT_FOUND", "Recipe version not found");
      return { version: row.version, origin: row.origin, publishedAt: row.published_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), sourceRunId: row.source_run_id, parentVersion: row.parent_version, note: row.note };
    },
  );

  // A new task for a site: the recipe is recorded on the given profile (REQ-DOM-004).
  app.post(
    "/api/v1/recipes",
    {
      preHandler: operatorAuth,
      schema: {
        body: z.object({
          id: idSchema,
          goal: z.string().min(1),
          startUrl: z.url(),
          inputs: z.array(recipeInputSchema).default([]),
          profileId: z.uuid(),
          input: z.record(z.string(), z.string()).default({}),
          timeoutMs: z.number().int().positive().max(MAX_RECORDING_MS).default(30 * 60_000),
        }),
        response: { 202: z.object({ recipeId: z.string(), runId: z.string() }), ...errors, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (!model) return sendError(reply, request, 503, "RECORDING_UNAVAILABLE", "Recording is not configured on this server");
      const existing = await db.selectFrom("scenarios").select("kind").where("id", "=", body.id).executeTakeFirst();
      if (existing && existing.kind !== "recipe") return sendError(reply, request, 409, "SCENARIO_KIND_CONFLICT", `${body.id} is a code scenario`);
      const profile = await db.selectFrom("profiles").select(["id", "agent_id", "status"]).where("id", "=", body.profileId).where("archived_at", "is", null).executeTakeFirst();
      if (!profile) return sendError(reply, request, 404, "NOT_FOUND", "Profile not found");
      if (profile.status === "NEEDS_REVIEW" || profile.status === "DISABLED") return sendError(reply, request, 409, `PROFILE_${profile.status}`, `The profile is ${profile.status}`);
      const runId = await db.transaction().execute(async (tx) => {
        const task = { goal: body.goal, start_url: body.startUrl, inputs: JSON.stringify(body.inputs) };
        if (existing) await tx.updateTable("scenarios").set(task).where("id", "=", body.id).execute();
        else await tx.insertInto("scenarios").values({ id: body.id, kind: "recipe", ...task }).execute();
        const run = await tx
          .insertInto("runs")
          .values({ scenario_id: body.id, scenario_version: null, kind: "record", profile_id: profile.id, agent_id: profile.agent_id, input: JSON.stringify(body.input), timeout_ms: body.timeoutMs })
          .returning("id")
          .executeTakeFirstOrThrow();
        await tx.insertInto("run_transitions").values({ run_id: run.id, from_status: null, to_status: "QUEUED", reason: "recording requested" }).execute();
        await tx.insertInto("recordings").values({ run_id: run.id, updated_at: new Date() }).execute();
        return run.id;
      });
      await coordinator.tick();
      return reply.code(202).send({ recipeId: body.id, runId });
    },
  );

  const pendingView = z.object({ stepId: z.string(), intent: z.string(), screenshotArtifactId: z.string().nullable() }).nullable();
  app.get("/api/v1/runs/:id/confirmation", { preHandler: operatorAuth, schema: { params: z.object({ id: z.uuid() }), response: { 200: z.object({ pending: pendingView }), ...errors } } }, async (request) => {
    const rec = await db.selectFrom("recordings").select(["pending", "pending_state"]).where("run_id", "=", request.params.id).executeTakeFirst();
    if (rec?.pending_state !== "awaiting") return { pending: null };
    const pending = rec.pending as Pending;
    const shot = await db.selectFrom("artifacts").select("id").where("run_id", "=", request.params.id).where("name", "=", pending.screenshot).executeTakeFirst();
    return { pending: { stepId: pending.decision.stepId, intent: pending.decision.intent, screenshotArtifactId: shot?.id ?? null } };
  });

  // The operator allows or refuses a mutating action of a recording (REQ-DOM-008).
  app.post(
    "/api/v1/runs/:id/confirmation",
    { preHandler: operatorAuth, schema: { params: z.object({ id: z.uuid() }), body: z.object({ decision: z.enum(["confirm", "reject"]) }), response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const moved = await db
        .updateTable("recordings")
        .set({ pending_state: request.body.decision === "confirm" ? "confirmed" : "rejected", updated_at: new Date() })
        .where("run_id", "=", request.params.id)
        .where("pending_state", "=", "awaiting")
        .executeTakeFirst();
      if (Number(moved.numUpdatedRows) === 0) return sendError(reply, request, 409, "NOTHING_TO_CONFIRM", "The run is not waiting for a confirmation");
      return reply.code(204).send(null);
    },
  );

  // ---- agent API: recording ----

  const ownRun = async (runId: string, agentId: string | undefined) =>
    db
      .selectFrom("runs")
      .innerJoin("scenarios", "scenarios.id", "runs.scenario_id")
      .select(["runs.id", "runs.kind", "runs.status", "runs.input", "runs.scenario_id", "runs.scenario_version", "scenarios.goal", "scenarios.start_url", "scenarios.inputs"])
      .where("runs.id", "=", runId)
      .where("runs.agent_id", "=", agentId ?? "")
      .executeTakeFirst();

  app.post(
    "/api/v1/agents/me/runs/:id/record",
    {
      preHandler: fleet.agentAuth,
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.union([
          z.object({ poll: z.literal(true) }),
          z.object({ snapshot: snapshotSchema, screenshot: z.string().regex(/^[\w.-]+$/), last: z.object({ ok: z.boolean(), error: z.string().optional() }).nullable() }),
        ]),
        // RecordDecision from @bap/recipe: act, wait, done or fail.
        response: { 200: z.looseObject({ type: z.enum(["act", "wait", "done", "fail"]) }), 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const run = await ownRun(request.params.id, request.agentId);
      if (!run || run.kind !== "record") return sendError(reply, request, 404, "NOT_FOUND", "Recording not found");
      if (!["ACCEPTED", "RUNNING"].includes(run.status)) return sendError(reply, request, 409, "RUN_STATE_CONFLICT", `Run is ${run.status}`);
      const rec = await db.selectFrom("recordings").selectAll().where("run_id", "=", run.id).executeTakeFirstOrThrow();
      const answer = (d: RecordDecision) => reply.send(d);

      if (rec.pending_state === "awaiting") return answer({ type: "wait" });
      if (rec.pending_state === "confirmed" || rec.pending_state === "rejected") {
        const pending = rec.pending as Pending;
        await db.updateTable("recordings").set({ pending: null, pending_state: null, updated_at: new Date() }).where("run_id", "=", run.id).execute();
        if (rec.pending_state === "rejected") return answer({ type: "fail", code: "OPERATOR_REJECTED", message: `the operator refused “${pending.decision.intent}”` });
        return answer({ ...pending.decision, confirmed: true });
      }
      if ("poll" in request.body) return answer({ type: "fail", code: "NOTHING_PENDING", message: "no action is waiting; send an observation" });

      const { snapshot, screenshot, last } = request.body as { snapshot: PageSnapshot; screenshot: string; last: { ok: boolean; error?: string } | null };
      const inputs = inputsOf(run.inputs);
      const input = (run.input ?? {}) as Record<string, unknown>;
      const steps = rec.steps as DraftStep[];
      const history = rec.history as string[];
      const lastStep = steps.at(-1);
      if (lastStep && !lastStep.urlAfter) {
        lastStep.urlAfter = snapshot.url;
        lastStep.titleAfter = snapshot.title;
      }
      if (last && !last.ok && lastStep) {
        steps.pop(); // a failed action is not part of the solution
        history.push(`  ↳ failed: ${last.error ?? "unknown error"}`);
      }
      const save = (extra: { pending?: Pending | null; pending_state?: "awaiting" | null; result_version?: string } = {}) =>
        db.updateTable("recordings").set({ steps: JSON.stringify(steps), history: JSON.stringify(history), updated_at: new Date(), ...extra, ...(extra.pending !== undefined && { pending: extra.pending && JSON.stringify(extra.pending) }) }).where("run_id", "=", run.id).execute();

      const image = (await db.selectFrom("artifacts").select("storage_key").where("run_id", "=", run.id).where("name", "=", screenshot).executeTakeFirst()) ?? null;
      const imageBody = image ? (await store.get(image.storage_key))?.body : undefined;
      const prompt = (problem?: string) =>
        [
          `Task: ${run.goal}`,
          `Start address: ${run.start_url}`,
          "Inputs:",
          ...(inputs.length ? inputs.map((i) => `- ${i.name} = ${i.secret ? "(secret)" : JSON.stringify(String(input[i.name] ?? ""))}`) : ["(none)"]),
          "Steps done:",
          "1. Открыть сайт",
          ...history,
          `Last action: ${last === null ? "none yet" : last.ok ? "done" : `FAILED: ${last.error}`}`,
          ...(problem ? [`Your previous answer was rejected: ${problem}. Answer again.`] : []),
          "Current page:",
          serializeSnapshot(snapshot),
        ].join("\n");

      let decision: ModelDecision | null = null;
      let problem: string | undefined;
      try {
        for (let attempt = 0; attempt < 3 && !decision; attempt++) {
          const reply = await model!.ask({ purpose: "record", runId: run.id, system: RECORD_SYSTEM, prompt: prompt(problem), ...(imageBody && { image: imageBody }), schema: recordSchema });
          const d = reply.output as ModelDecision;
          problem = checkDecision(d, snapshot);
          if (!problem) decision = d;
        }
      } catch (e) {
        await save();
        if (e instanceof BudgetExceededError) return answer({ type: "fail", code: e.code, message: e.message });
        request.log.error({ err: e }, "recording: model call failed");
        return answer({ type: "fail", code: "MODEL_UNAVAILABLE", message: e instanceof Error ? e.message : String(e) });
      }
      if (!decision) {
        await save();
        return answer({ type: "fail", code: "RECORDING_FAILED", message: `no usable answer: ${problem}` });
      }

      const check = decision.previousCheck;
      if (lastStep && steps.at(-1) === lastStep && check && (check.text || check.url) && !lastStep.postcondition) lastStep.postcondition = cleanCheck(check, openValues(inputs, input));

      if (decision.decision === "fail") {
        await save();
        return answer({ type: "fail", code: "RECORDING_FAILED", message: decision.reason ?? "the goal cannot be reached" });
      }
      if (decision.decision === "done") {
        const final = steps.at(-1);
        if (final && decision.result && (decision.result.text || decision.result.url)) final.postcondition ??= cleanCheck(decision.result, openValues(inputs, input));
        const recipe = finishRecipe(run.goal ?? "", run.start_url ?? "", inputs, steps, run.id);
        const parsed = recipeSchema.safeParse(recipe);
        if (!parsed.success) {
          await save();
          return answer({ type: "fail", code: "RECORDING_INCOMPLETE", message: z.prettifyError(parsed.error) });
        }
        // Screenshots move next to the recipe: run artifacts expire, recipe versions do not.
        for (const step of parsed.data.steps) {
          if (!step.screenshot) continue;
          const art = await db.selectFrom("artifacts").select("storage_key").where("run_id", "=", run.id).where("name", "=", step.screenshot).executeTakeFirst();
          const object = art && (await store.get(art.storage_key));
          if (!object) {
            delete step.screenshot;
            continue;
          }
          const key = `screens/${run.id}/${step.screenshot}`;
          await store.put(`recipes/${run.scenario_id}/${key}`, object.body, "image/png");
          step.screenshot = key;
        }
        const version = await saveVersion(run.scenario_id, parsed.data, { origin: "recorded", published: false, sourceRunId: run.id });
        await db.updateTable("runs").set({ scenario_version: version }).where("id", "=", run.id).execute();
        await save({ result_version: version });
        return answer({ type: "done", version });
      }

      const action = decision.action!;
      const open = openValues(inputs, input);
      const el = action.ref ? snapshot.elements.find((e) => e.ref === action.ref) : undefined;
      const value = action.value === undefined ? undefined : templateValue(action.value, open);
      const step: DraftStep = {
        id: `s${String(steps.length + 2).padStart(2, "0")}`,
        intent: action.intent,
        action: action.kind,
        ...(el && { target: templatize(fingerprintOf(el as SnapshotElement, snapshot), open) }),
        ...(value !== undefined && { value }),
        mutating: action.mutating,
        screenshot,
        urlBefore: snapshot.url,
      };
      steps.push(step);
      history.push(`${steps.length + 1}. ${action.intent}${action.mutating ? " (mutating)" : ""}`);
      const act: Extract<RecordDecision, { type: "act" }> = {
        type: "act",
        stepId: step.id,
        intent: step.intent,
        action: action.kind,
        ...(action.ref && { ref: action.ref }),
        ...(value !== undefined && { value }),
        mutating: action.mutating,
        confirmed: false,
      };
      if (action.mutating) {
        await save({ pending: { decision: act, screenshot }, pending_state: "awaiting" });
        return answer({ type: "wait" });
      }
      await save();
      return answer(act);
    },
  );

  // ---- agent API: healing ----

  app.post(
    "/api/v1/agents/me/runs/:id/heal",
    {
      preHandler: fleet.agentAuth,
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ stepId: z.string(), reason: z.enum(["missing", "ambiguous", "postcondition"]), detail: z.string(), snapshot: snapshotSchema, screenshot: z.string() }),
        response: { 200: z.object({ ref: z.string(), note: z.string() }), 404: errorSchema, 409: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const run = await ownRun(request.params.id, request.agentId);
      if (!run || run.kind !== "run" || !run.scenario_version) return sendError(reply, request, 404, "NOT_FOUND", "Run not found");
      if (!["ACCEPTED", "RUNNING"].includes(run.status)) return sendError(reply, request, 409, "RUN_STATE_CONFLICT", `Run is ${run.status}`);
      if (!model) return sendError(reply, request, 422, "HEAL_FAILED", "Healing is not configured on this server");
      const recipe = await loadRecipe(run.scenario_id, run.scenario_version);
      const step = recipe?.steps.find((s) => s.id === request.body.stepId);
      if (!recipe || !step?.target) return sendError(reply, request, 404, "NOT_FOUND", "Recipe step not found");
      // After a mutating action with an unclear outcome nothing is retried (REQ-DOM-008).
      if (step.mutating && request.body.reason === "postcondition") return sendError(reply, request, 409, "MUTATING_STEP", "A mutating step is healed only before its action");
      const snapshot = request.body.snapshot as PageSnapshot;
      const inputs = inputsOf(run.inputs);
      const open = openValues(inputs, (run.input ?? {}) as Record<string, unknown>);
      const was = step.target;
      const prompt = (problem?: string) =>
        [
          `Step intent: ${step.intent}`,
          `Action: ${step.action}${step.value !== undefined ? ` ${JSON.stringify(step.value)}` : ""}`,
          `Recorded element: ${was.role} “${renderTemplate(was.name || was.text, open)}”${was.context ? ` in “${renderTemplate(was.context, open)}”` : ""}${was.frame ? ` (frame ${was.frame})` : ""}`,
          `Why it is not found now: ${request.body.detail}`,
          ...(problem ? [`Your previous answer was rejected: ${problem}. Answer again.`] : []),
          "Current page:",
          serializeSnapshot(snapshot),
        ].join("\n");
      let problem: string | undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const answer = (await model.ask({ purpose: "heal", runId: run.id, system: HEAL_SYSTEM, prompt: prompt(problem), image: Buffer.from(request.body.screenshot, "base64"), schema: healSchema })).output as HealDecision;
          if (answer.ref === null) return sendError(reply, request, 422, "HEAL_FAILED", answer.note || "no element on the page serves this step");
          // The server checks the choice itself: the element exists, is visible, and its new fingerprint is unique.
          const el = snapshot.elements.find((e) => e.ref === answer.ref);
          const fp = el && fingerprintOf(el as SnapshotElement, snapshot);
          const unique = fp ? resolve(fp, snapshot) : null;
          if (!el) problem = `${answer.ref} is not in the list`;
          else if (!el.visible) problem = `${answer.ref} is not visible`;
          else if (["fill", "select", "click"].includes(step.action) && !el.interactive) problem = `${answer.ref} cannot be operated`;
          else if (unique?.kind !== "found" || unique.ref !== el.ref) problem = `${answer.ref} cannot be told apart from other elements`;
          else {
            await db.insertInto("heals").values({ run_id: run.id, scenario_version: run.scenario_version, step_id: step.id, target: JSON.stringify(templatize(fp!, open)), note: answer.note }).execute();
            return { ref: el.ref, note: answer.note };
          }
        }
      } catch (e) {
        if (e instanceof BudgetExceededError) return sendError(reply, request, 422, e.code, e.message);
        request.log.error({ err: e }, "healing: model call failed");
        return sendError(reply, request, 422, "MODEL_UNAVAILABLE", e instanceof Error ? e.message : String(e));
      }
      return sendError(reply, request, 422, "HEAL_FAILED", `no usable answer: ${problem}`);
    },
  );

  /** A run that healed steps and then succeeded gives every Mac the healed recipe (REQ-DOM-007). */
  const onSucceeded = async (runId: string) => {
    const run = await db.selectFrom("runs").select(["scenario_id", "scenario_version", "kind"]).where("id", "=", runId).executeTakeFirst();
    if (!run || run.kind !== "run" || !run.scenario_version) return;
    const heals = await db.selectFrom("heals").selectAll().where("run_id", "=", runId).orderBy("id").execute();
    if (heals.length === 0) return;
    const recipe = await loadRecipe(run.scenario_id, run.scenario_version);
    if (!recipe) return;
    const latest = new Map(heals.map((h) => [h.step_id, h]));
    const steps = recipe.steps.map((s) => (latest.has(s.id) ? { ...s, target: latest.get(s.id)!.target as Fingerprint } : s));
    const note = [...latest.values()].map((h) => `${h.step_id}: ${h.note}`).join("; ");
    await saveVersion(run.scenario_id, { ...recipe, steps }, { origin: "healed", published: true, sourceRunId: runId, parent: run.scenario_version, note });
  };

  return { onSucceeded };
}

/** Problems with the model's answer that the model can fix by answering again. */
function checkDecision(d: ModelDecision, snapshot: PageSnapshot): string | undefined {
  if (!d || !["act", "done", "fail"].includes(d.decision)) return "decision must be act, done or fail";
  if (d.decision !== "act") return undefined;
  const a = d.action;
  if (!a) return "decision act needs an action";
  if (a.kind === "press") return a.value ? undefined : "press needs a key in value";
  const el = snapshot.elements.find((e) => e.ref === a.ref);
  if (!el) return `ref ${a.ref} is not in the list`;
  if (!el.visible) return `${a.ref} is not visible`;
  if ((a.kind === "fill" || a.kind === "select") && a.value === undefined) return `${a.kind} needs a value`;
  return undefined;
}

/** Input values quoted by the model become placeholders, so the check holds for other inputs too. */
function templateText(text: string, open: Record<string, unknown>): string {
  const values = Object.entries(open)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  return values.reduce((acc, [key, value]) => acc.split(value).join(`{{input.${key}}}`), text);
}

/** The page list's notation is not page text: `value="Option 2"` checks for Option 2. */
const unquote = (text: string) => /^\s*[\w-]+="(.*)"\s*$/.exec(text)?.[1] ?? text;

export const cleanCheck = (c: { text?: string; url?: string }, open: Record<string, unknown>) => ({
  ...(c.text && { text: templateText(unquote(c.text), open) }),
  ...(c.url && { url: templateText(c.url, open) }),
});

/** A literal input value typed by the model becomes its placeholder, so the recipe works for other inputs. */
function templateValue(value: string, open: Record<string, unknown>): string {
  for (const [key, v] of Object.entries(open)) if (typeof v === "string" && v.length > 0 && value === v) return `{{input.${key}}}`;
  return value;
}

/** The recorded steps as a recipe: the start page first, every mutating step with a postcondition. */
function finishRecipe(goal: string, startUrl: string, inputs: RecipeInput[], drafts: DraftStep[], runId: string): Recipe {
  const steps: RecipeStep[] = [{ id: "s01", intent: "Открыть сайт", action: "navigate", value: startUrl, mutating: false }];
  drafts.forEach(({ urlBefore, urlAfter, titleAfter, ...step }, i) => {
    let postcondition = step.postcondition;
    // The model did not say what proves a mutating step: the page it led to does.
    if (!postcondition && step.mutating && urlAfter) {
      const before = new URL(urlBefore);
      const after = new URL(urlAfter);
      postcondition = after.pathname !== before.pathname ? { url: after.pathname.replace(/\d+$/, "") } : titleAfter ? { text: titleAfter } : undefined;
    }
    steps.push({ ...step, id: `s${String(i + 2).padStart(2, "0")}`, ...(postcondition && { postcondition }) });
  });
  return { schema: 1, goal, startUrl, inputs, steps, sourceRunId: runId };
}
