import { createHash } from "node:crypto";
import type { Db } from "@bap/database";
import { DONE_STATUSES, type LsClickerState, lsClickerState, numberColumn, statusColumn } from "@bap/protocol";
import type { preHandlerAsyncHookHandler } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
import { AgentRequestError, type Fleet, type FleetConfig, connection } from "./fleet.ts";
import { issueRunToken } from "./providers.ts";
import type { ObjectStore } from "./storage.ts";

export interface LsClickerOptions {
  db: Db;
  fleet: Fleet;
  fleetConfig: FleetConfig;
  store: ObjectStore;
  operatorAuth: preHandlerAsyncHookHandler;
}

const BUILD_KEY = "ls_clicker_build";
const idParams = z.object({ id: z.uuid() });
/**
 * The site's flow as LS Clicker walks it: steps with the markers its state.json reports, what is done
 * there and which fields are filled. Set by the operator; kept on the server, not in the code.
 */
const flowSchema = z.array(z.object({ key: z.string().min(1), label: z.string().min(1), aliases: z.array(z.string()), action: z.string().default(""), fields: z.array(z.string()).default([]) })).max(100);
const FLOW_KEY = "ls_clicker_flow";
/** After an automatic start, heartbeats that may predate the run are not taken as «idle». */
const AUTO_SETTLE_MS = 15_000;
const buildSchema = z.object({ sha256: z.string(), sizeBytes: z.number(), uploadedAt: z.string(), uploadedBy: z.string().nullable() });
type Build = z.infer<typeof buildSchema>;
/** The agent's codes as HTTP: a run in progress is a conflict, an agent away is unavailable, the rest a bad gateway. */
const statusOf = (code: string) => (["LS_CLICKER_RUNNING", "LS_CLICKER_IDLE", "LS_CLICKER_INPUT_CHANGED", "LS_CLICKER_HEADER_MISMATCH"].includes(code) ? 409 : ["AGENT_UNAVAILABLE", "AGENT_TIMEOUT"].includes(code) ? 503 : 502);

/**
 * LS Clicker without a panel of its own (ADR-0034): BAP rolls its build out to every Mac, sends the
 * operator's table rows to the Macs' input.csv, starts and stops runs, and brings output.csv back.
 * The agents execute; rows and results are the owner's employees' data and are never logged.
 */
export function registerLsClicker(app: App, { db, fleet, fleetConfig, store, operatorAuth }: LsClickerOptions) {
  const errors = { 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 502: errorSchema, 503: errorSchema };
  // Builds arrive as application/octet-stream, parsed to a Buffer by the parser runs.ts registers (≤ 10 MB).

  const currentBuild = async () => {
    const row = await db.selectFrom("settings").select("value").where("key", "=", BUILD_KEY).executeTakeFirst();
    return row ? buildSchema.parse(row.value) : null;
  };
  const ask = async (agentId: string, payload: Parameters<Fleet["request"]>[1], timeoutMs = 15_000) => {
    try {
      return { ok: true as const, result: await fleet.request(agentId, payload, timeoutMs) };
    } catch (e) {
      if (e instanceof AgentRequestError) return { ok: false as const, code: e.code, message: e.message };
      throw e;
    }
  };
  /** Agents that run LS Clicker, with their last reported state. */
  const macs = async () => {
    const rows = await db.selectFrom("agents").select(["id", "name", "model", "lsc_auto", "last_seen_at", "last_heartbeat", "status"]).where("deleted_at", "is", null).where("status", "!=", "REVOKED").orderBy("name").execute();
    return rows.flatMap((r) => {
      const state = lsClickerState.safeParse((r.last_heartbeat as { lsClicker?: unknown } | null)?.lsClicker ?? null);
      return state.success && state.data ? [{ agentId: r.id, name: r.name, model: r.model, auto: r.lsc_auto, connection: connection(r.last_seen_at, fleetConfig), state: state.data }] : [];
    });
  };

  // ---- rollout: every Mac with LS Clicker gets the current build, never in the middle of a run ----
  const installing = new Set<string>();
  const rollout = async (agentId: string, state: NonNullable<LsClickerState>) => {
    const build = await currentBuild();
    if (!build || state.sha256 === build.sha256 || state.run.running || installing.has(agentId) || !fleet.isConnected(agentId)) return;
    installing.add(agentId);
    void ask(agentId, { method: "lsclicker.install", sha256: build.sha256 }, 120_000)
      .then((a) => !a.ok && app.log.warn({ agentId, code: a.code }, "ls-clicker install failed"))
      .finally(() => installing.delete(agentId));
  };

  // ---- results: output.csv comes back whenever it changed on the Mac ----
  const syncing = new Set<string>();
  const syncOutput = async (agentId: string, state: NonNullable<LsClickerState>) => {
    const known = await db.selectFrom("lsclicker_macs").select("output_hash").where("agent_id", "=", agentId).executeTakeFirst();
    if (state.outputHash === null || known?.output_hash === state.outputHash || syncing.has(agentId)) return;
    syncing.add(agentId);
    try {
      const answer = await ask(agentId, { method: "lsclicker.output" });
      if (!answer.ok) return;
      const out = z.object({ header: z.array(z.string()), rows: z.array(z.array(z.string())) }).parse(answer.result);
      await db.transaction().execute(async (tx) => {
        for (const [position, cells] of out.rows.entries())
          await tx
            .insertInto("lsclicker_results")
            .values({ agent_id: agentId, position, header: JSON.stringify(out.header), cells: JSON.stringify(cells) })
            .onConflict((oc) => oc.columns(["agent_id", "position"]).doUpdateSet({ header: JSON.stringify(out.header), cells: JSON.stringify(cells), updated_at: new Date() }))
            .execute();
        // The engine's verdict (status good or bad) becomes the table row's status: the row moves to «result.csv».
        const verdictAt = out.header.findIndex((c) => c.trim().toLowerCase() === "status");
        const imp = await tx.selectFrom("pipeline_import").select(["id", "columns"]).orderBy("created_at", "desc").executeTakeFirst();
        const tableAt = imp ? statusColumn(imp.columns as string[]) : -1;
        if (verdictAt >= 0 && imp && tableAt >= 0)
          for (const [position, cells] of out.rows.entries()) {
            const verdict = (cells[verdictAt] ?? "").trim().toLowerCase();
            if (verdict !== "good" && verdict !== "bad") continue;
            const queued = await tx.selectFrom("lsclicker_queue").select("row_n").where("agent_id", "=", agentId).where("position", "=", position).where("import_id", "=", imp.id).executeTakeFirst();
            if (queued?.row_n == null) continue;
            await tx
              .updateTable("pipeline_rows")
              .set({ cells: sql`jsonb_set(cells, ${sql.lit(`{${tableAt}}`)}, to_jsonb(${verdict}::text))` })
              .where("import_id", "=", imp.id)
              .where("n", "=", queued.row_n)
              .where(sql<string>`lower(trim(coalesce(cells->>${sql.lit(tableAt)}, '')))`, "not in", [...DONE_STATUSES])
              .execute();
          }
        await tx
          .insertInto("lsclicker_macs")
          .values({ agent_id: agentId, output_hash: state.outputHash })
          .onConflict((oc) => oc.column("agent_id").doUpdateSet({ output_hash: state.outputHash }))
          .execute();
      });
    } finally {
      syncing.delete(agentId);
    }
  };

  const previousHeartbeat = fleet.handlers.onHeartbeat;
  fleet.handlers.onHeartbeat = async (agentId) => {
    await previousHeartbeat?.(agentId);
    const row = await db.selectFrom("agents").select("last_heartbeat").where("id", "=", agentId).executeTakeFirst();
    const state = lsClickerState.safeParse((row?.last_heartbeat as { lsClicker?: unknown } | null)?.lsClicker ?? null);
    if (!state.success || !state.data) return;
    // Not awaited: an agent request must never be awaited inside its own socket handler.
    void rollout(agentId, state.data).catch((e) => app.log.error(e, "ls-clicker rollout"));
    void syncOutput(agentId, state.data).catch((e) => app.log.error(e, "ls-clicker output sync"));
    void autoRun(agentId, state.data).catch((e) => app.log.error(e, "ls-clicker auto run"));
    void recordFailure(agentId, state.data).catch((e) => app.log.error(e, "ls-clicker failure"));
  };

  // ---- failures: every failed run goes to «Недоработки» with its error, log, stage and screen ----
  const recording = new Set<string>();
  const failureSchema = z.object({
    position: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string(),
    log: z.array(z.string()),
    stage: lsClickerState.unwrap().shape.stage,
    lsProfile: z.string().nullable(),
    screenshot: z.string().nullable(),
    page: z.record(z.string(), z.unknown()).nullable().default(null),
    pageScreenshot: z.string().nullable().default(null),
    html: z.string().nullable().default(null),
  });
  const recordFailure = async (agentId: string, state: NonNullable<LsClickerState>) => {
    const finishedAt = state.run.finishedAt;
    if (state.run.running || state.run.ok !== false || !finishedAt || recording.has(agentId)) return;
    if (await db.selectFrom("lsclicker_failures").select("id").where("agent_id", "=", agentId).where("finished_at", "=", new Date(finishedAt)).executeTakeFirst()) return;
    recording.add(agentId);
    try {
      // An agent before this feature has no «failure»: its log tail and the reported stage are what is left.
      const asked = await ask(agentId, { method: "lsclicker.failure" });
      const parsed = asked.ok ? z.object({ failure: failureSchema.nullable() }).safeParse(asked.result) : null;
      const full = parsed?.success && parsed.data.failure?.finishedAt === finishedAt ? parsed.data.failure : null;
      const log = full?.log ?? (await (async () => {
        const tail = await ask(agentId, { method: "lsclicker.log" });
        return tail.ok ? z.object({ lines: z.array(z.string()) }).parse(tail.result).lines : [];
      })());
      const error = [...log].reverse().find((l) => l.startsWith("ОШИБКА")) ?? log.at(-1) ?? "прогон завершился с ошибкой";
      const imp = await db.selectFrom("pipeline_import").select("id").orderBy("created_at", "desc").executeTakeFirst();
      const queued = await db
        .selectFrom("lsclicker_queue")
        .select(["import_id", "row_n"])
        .where("agent_id", "=", agentId)
        .$if(!!full, (q) => q.where("position", "=", full!.position))
        .$if(!!imp, (q) => q.where("import_id", "=", imp!.id))
        .orderBy("position", "desc")
        .executeTakeFirst();
      const id = crypto.randomUUID();
      const screenshotKey = full?.screenshot ? `ls-clicker-failures/${id}.jpg` : null;
      if (screenshotKey) await store.put(screenshotKey, Buffer.from(full!.screenshot!, "base64"), "image/jpeg");
      const pageKey = full?.pageScreenshot ? `ls-clicker-failures/${id}-page.png` : null;
      if (pageKey) await store.put(pageKey, Buffer.from(full!.pageScreenshot!, "base64"), "image/png");
      const htmlKey = full?.html ? `ls-clicker-failures/${id}.html` : null;
      if (htmlKey) await store.put(htmlKey, Buffer.from(full!.html!, "utf8"), "text/plain; charset=utf-8");
      await db
        .insertInto("lsclicker_failures")
        .values({
          id,
          agent_id: agentId,
          started_at: state.run.startedAt ? new Date(state.run.startedAt) : null,
          finished_at: new Date(finishedAt),
          import_id: queued?.import_id ?? null,
          row_n: queued?.row_n ?? null,
          error,
          log: JSON.stringify(log),
          stage: JSON.stringify(full?.stage ?? state.stage),
          ls_profile: full?.lsProfile ?? log.map((l) => /новый профиль:\s*([0-9a-f-]{36})/i.exec(l)?.[1]).filter(Boolean).at(-1) ?? null,
          screenshot_key: screenshotKey,
          page: full?.page ? JSON.stringify(full.page) : null,
          page_screenshot_key: pageKey,
          html_key: htmlKey,
        })
        .onConflict((oc) => oc.columns(["agent_id", "finished_at"]).doNothing())
        .execute();
    } finally {
      recording.delete(agentId);
    }
  };

  const failureView = z.object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    agentModel: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string(),
    rowN: z.number().nullable(),
    error: z.string(),
    log: z.array(z.string()),
    stage: z.unknown(),
    lsProfile: z.string().nullable(),
    screenshot: z.boolean(),
    page: z.unknown(),
    pageScreenshot: z.boolean(),
    html: z.boolean(),
    resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(),
    resolvedNote: z.string().nullable(),
  });
  app.get(
    "/api/v1/ls-clicker/failures",
    { preHandler: operatorAuth, schema: { querystring: z.object({ resolved: z.enum(["true", "false"]).default("false") }), response: { 200: z.array(failureView), 401: errorSchema } } },
    async (request) => {
      const resolved = request.query.resolved === "true";
      const rows = await db
        .selectFrom("lsclicker_failures")
        .innerJoin("agents", "agents.id", "lsclicker_failures.agent_id")
        .selectAll("lsclicker_failures")
        .select(["agents.name as agent_name", "agents.model as agent_model"])
        .where("lsclicker_failures.resolved_at", resolved ? "is not" : "is", null)
        .orderBy(resolved ? "lsclicker_failures.resolved_at" : "lsclicker_failures.finished_at", "desc")
        .limit(200)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        agentName: r.agent_name,
        agentModel: r.agent_model,
        startedAt: r.started_at?.toISOString() ?? null,
        finishedAt: r.finished_at.toISOString(),
        rowN: r.row_n,
        error: r.error,
        log: r.log as string[],
        stage: r.stage,
        lsProfile: r.ls_profile,
        screenshot: !!r.screenshot_key,
        page: r.page,
        pageScreenshot: !!r.page_screenshot_key,
        html: !!r.html_key,
        resolvedAt: r.resolved_at?.toISOString() ?? null,
        resolvedBy: r.resolved_by,
        resolvedNote: r.resolved_note,
      }));
    },
  );

  // The Mac's screen, the page as an image and the page's HTML (as a file to save, never rendered here).
  const files = { screenshot: "screenshot_key", page: "page_screenshot_key", html: "html_key" } as const;
  app.get("/api/v1/ls-clicker/failures/:id/:file", { preHandler: operatorAuth, schema: { params: z.object({ id: z.uuid(), file: z.enum(["screenshot", "page", "html"]) }) } }, async (request, reply) => {
    const column = files[request.params.file];
    const row = await db.selectFrom("lsclicker_failures").select(column).where("id", "=", request.params.id).executeTakeFirst();
    const key = row?.[column as keyof typeof row] as string | null | undefined;
    const object = key ? await store.get(key) : null;
    if (!object) return sendError(reply, request, 404, "NOT_FOUND", "No such file for this failure");
    if (request.params.file === "html") reply.header("content-disposition", `attachment; filename="failure-${request.params.id.slice(0, 8)}.html"`);
    return reply.header("cache-control", "private, max-age=86400").type(object.contentType).send(object.body);
  });

  app.post(
    "/api/v1/ls-clicker/failures/:id/resolve",
    { preHandler: operatorAuth, schema: { params: idParams, body: z.object({ note: z.string().trim().min(1).max(2000) }), response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const operator = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId!).executeTakeFirst();
      const done = await db
        .updateTable("lsclicker_failures")
        .set({ resolved_at: new Date(), resolved_by: operator?.login ?? null, resolved_note: request.body.note })
        .where("id", "=", request.params.id)
        .where("resolved_at", "is", null)
        .executeTakeFirst();
      if (done.numUpdatedRows === 0n) return sendError(reply, request, 404, "NOT_FOUND", "No open failure with this id");
      return reply.code(204).send(null);
    },
  );

  // ---- builds ----
  app.post(
    "/api/v1/ls-clicker/builds",
    { preHandler: operatorAuth, schema: { response: { 201: buildSchema, ...errors } } },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return sendError(reply, request, 400, "BUILD_EMPTY", "Send the ls-clicker binary as application/octet-stream");
      const sha256 = createHash("sha256").update(body).digest("hex");
      await store.put(`ls-clicker/${sha256}`, body, "application/octet-stream");
      const operator = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId!).executeTakeFirst();
      const build: Build = { sha256, sizeBytes: body.length, uploadedAt: new Date().toISOString(), uploadedBy: operator?.login ?? null };
      await db
        .insertInto("settings")
        .values({ key: BUILD_KEY, value: JSON.stringify(build) })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(build), updated_at: new Date() }))
        .execute();
      for (const m of await macs()) void rollout(m.agentId, m.state);
      return reply.code(201).send(build);
    },
  );

  app.get(
    "/api/v1/agents/me/ls-clicker/build",
    { preHandler: fleet.agentAuth, schema: { querystring: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }) } },
    async (request, reply) => {
      const object = await store.get(`ls-clicker/${request.query.sha256}`);
      if (!object) return sendError(reply, request, 404, "NOT_FOUND", "No such ls-clicker build");
      return reply.header("content-type", "application/octet-stream").send(object.body);
    },
  );

  // ---- the flow map ----
  app.get("/api/v1/ls-clicker/flow", { preHandler: operatorAuth, schema: { response: { 200: flowSchema, 401: errorSchema } } }, async () => {
    const row = await db.selectFrom("settings").select("value").where("key", "=", FLOW_KEY).executeTakeFirst();
    return row ? flowSchema.parse(row.value) : [];
  });
  app.put("/api/v1/ls-clicker/flow", { preHandler: operatorAuth, schema: { body: flowSchema, response: { 204: z.null(), ...errors } } }, async (request, reply) => {
    await db
      .insertInto("settings")
      .values({ key: FLOW_KEY, value: JSON.stringify(request.body) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(request.body), updated_at: new Date() }))
      .execute();
    return reply.code(204).send(null);
  });

  // ---- overview ----
  const macView = z.object({ agentId: z.string(), name: z.string(), model: z.string().nullable(), auto: z.boolean(), connection: z.string(), state: lsClickerState.unwrap(), sent: z.number(), processed: z.number() });
  app.get(
    "/api/v1/ls-clicker",
    { preHandler: operatorAuth, schema: { response: { 200: z.object({ build: buildSchema.nullable(), macs: z.array(macView), unsent: z.number() }), 401: errorSchema } } },
    async () => {
      const list = await macs();
      const sent = await db.selectFrom("lsclicker_queue").select(["agent_id", db.fn.countAll<string>().as("n")]).groupBy("agent_id").execute();
      const done = await db
        .selectFrom("lsclicker_queue")
        .innerJoin("lsclicker_results", (j) => j.onRef("lsclicker_results.agent_id", "=", "lsclicker_queue.agent_id").onRef("lsclicker_results.position", "=", "lsclicker_queue.position"))
        .select(["lsclicker_queue.agent_id", db.fn.countAll<string>().as("n")])
        .groupBy("lsclicker_queue.agent_id")
        .execute();
      return {
        build: await currentBuild(),
        macs: list.map((m) => ({ ...m, sent: Number(sent.find((s) => s.agent_id === m.agentId)?.n ?? 0), processed: Number(done.find((s) => s.agent_id === m.agentId)?.n ?? 0) })),
        unsent: (await unsentRows()).length,
      };
    },
  );

  // ---- runs, log and plan of one Mac ----
  const onMac = (path: string, method: "lsclicker.stop" | "lsclicker.log" | "lsclicker.plan", http: "GET" | "POST", code: 200 | 202) =>
    app.route({
      method: http,
      url: `/api/v1/agents/:id/ls-clicker/${path}`,
      preHandler: operatorAuth,
      schema: { params: idParams, response: { [code]: z.unknown(), ...errors } },
      handler: async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!(await db.selectFrom("agents").select("id").where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst())) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
        const answer = await ask(id, { method }, method === "lsclicker.plan" ? 45_000 : 15_000);
        if (!answer.ok) return sendError(reply, request, statusOf(answer.code), answer.code, answer.message);
        return reply.code(code).send(answer.result as never);
      },
    });
  onMac("stop", "lsclicker.stop", "POST", 202);
  onMac("log", "lsclicker.log", "GET", 200);
  onMac("plan", "lsclicker.plan", "GET", 200);

  // ---- runs: each Mac takes the next row of the operator's table, one at a time ----
  async function unsentRows() {
    const imp = await db.selectFrom("pipeline_import").select(["id", "columns", "lsc_from"]).orderBy("created_at", "desc").executeTakeFirst();
    if (!imp) return [];
    const status = statusColumn(imp.columns as string[]);
    const number = numberColumn(imp.columns as string[]);
    return db
      .selectFrom("pipeline_rows")
      .leftJoin("lsclicker_queue", (j) => j.onRef("lsclicker_queue.import_id", "=", "pipeline_rows.import_id").onRef("lsclicker_queue.row_n", "=", "pipeline_rows.n"))
      .select(["pipeline_rows.import_id", "pipeline_rows.n", "pipeline_rows.cells", "pipeline_rows.proxy"])
      .where("pipeline_rows.import_id", "=", imp.id)
      .where("lsclicker_queue.position", "is", null)
      // Rows above the operator's starting row are history: they are never run.
      .where("pipeline_rows.n", ">=", imp.lsc_from ?? 1)
      // A row whose status is already good or bad has been done: it is not run again.
      .$if(status >= 0, (q) => q.where(sql<string>`lower(trim(coalesce(pipeline_rows.cells->>${sql.lit(status)}, '')))`, "not in", [...DONE_STATUSES]))
      // «wait info»: a row runs only once its number and proxy are filled in.
      .where(sql<string>`trim(coalesce(pipeline_rows.proxy, ''))`, "!=", "")
      .$if(number >= 0, (q) => q.where(sql<string>`trim(coalesce(pipeline_rows.cells->>${sql.lit(number)}, ''))`, "!=", ""))
      .orderBy("pipeline_rows.n")
      .execute();
  }

  // Taking a row and starting it is one step at a time across the server, so no row goes to two Macs.
  let taking = Promise.resolve();
  const serially = <T,>(work: () => Promise<T>) => {
    const next = taking.then(work);
    taking = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  /** The table row this Mac was given last, for «Повторить» after a failed run. */
  const lastRowOf = (agentId: string, importId: string) =>
    db
      .selectFrom("lsclicker_queue")
      .innerJoin("pipeline_rows", (j) => j.onRef("pipeline_rows.import_id", "=", "lsclicker_queue.import_id").onRef("pipeline_rows.n", "=", "lsclicker_queue.row_n"))
      .select(["pipeline_rows.import_id", "pipeline_rows.n", "pipeline_rows.cells", "pipeline_rows.proxy"])
      .where("lsclicker_queue.agent_id", "=", agentId)
      .where("lsclicker_queue.import_id", "=", importId)
      .orderBy("lsclicker_queue.position", "desc")
      .executeTakeFirst();

  /**
   * The Mac runs its own unprocessed row if it has one, else the next unsent table row. A retry gives it
   * its last row again: the failed attempt stays in output.csv as history, the row runs as a new line.
   */
  const start = (agentId: string, retry = false) =>
    serially(async () => {
      const imp = await db.selectFrom("pipeline_import").select(["id", "columns"]).orderBy("created_at", "desc").executeTakeFirst();
      const next = retry ? imp && (await lastRowOf(agentId, imp.id)) : (await unsentRows())[0];
      const row = imp && next ? { header: imp.columns as string[], cells: next.cells as string[], ...(next.proxy && { proxy: next.proxy }) } : undefined;
      // Rows already on the Mac and not processed yet: the one it runs gets its current proxy.
      const queued = await db
        .selectFrom("lsclicker_queue")
        .innerJoin("pipeline_rows", (j) => j.onRef("pipeline_rows.import_id", "=", "lsclicker_queue.import_id").onRef("pipeline_rows.n", "=", "lsclicker_queue.row_n"))
        .leftJoin("lsclicker_results", (j) => j.onRef("lsclicker_results.agent_id", "=", "lsclicker_queue.agent_id").onRef("lsclicker_results.position", "=", "lsclicker_queue.position"))
        .select(["lsclicker_queue.position", "pipeline_rows.proxy"])
        .where("lsclicker_queue.agent_id", "=", agentId)
        .where("pipeline_rows.proxy", "is not", null)
        .where("lsclicker_results.position", "is", null)
        .execute();
      const proxies = Object.fromEntries(queued.map((q) => [String(q.position), q.proxy!]));
      const answer = await ask(agentId, { method: "lsclicker.run", token: await issueRunToken(db, agentId), proxies, ...(row && { row }) });
      if (answer.ok && next) {
        const { appended } = z.object({ appended: z.number().int().nullable() }).parse(answer.result);
        if (appended !== null)
          await db.transaction().execute(async (tx) => {
            // A retried row moves to its new line: the table shows its latest attempt, a row is on one line only.
            if (retry) await tx.deleteFrom("lsclicker_queue").where("import_id", "=", next.import_id).where("row_n", "=", next.n).execute();
            await tx
              .insertInto("lsclicker_queue")
              .values({ agent_id: agentId, position: appended, import_id: next.import_id, row_n: next.n })
              .onConflict((oc) => oc.columns(["agent_id", "position"]).doUpdateSet({ import_id: next.import_id, row_n: next.n, sent_at: new Date() }))
              .execute();
          });
      }
      if (!answer.ok && answer.code === "LS_CLICKER_NO_ROWS") return { ok: false as const, code: "NO_ROWS", message: "The table has no rows left to run" };
      return answer;
    });

  // ---- automatic runs: a ticked Mac takes the next ready row whenever it is idle ----
  /** The last automatic start per Mac: when, and the end of the run before it as the Mac reported it. */
  const autoStarted = new Map<string, { at: number; finishedAt: string | null }>();
  const checking = new Set<string>();
  const autoRun = async (agentId: string, state: NonNullable<LsClickerState>) => {
    // A failed run stops the Mac's automatic runs: it would retry the same row; the operator repeats it by hand.
    if (state.run.running || state.run.ok === false || checking.has(agentId) || !fleet.isConnected(agentId)) return;
    // A heartbeat after a start may predate the run: until a new end is reported, wait a while.
    const last = autoStarted.get(agentId);
    if (last && state.run.finishedAt === last.finishedAt && Date.now() - last.at < AUTO_SETTLE_MS) return;
    checking.add(agentId);
    try {
      const agent = await db.selectFrom("agents").select("lsc_auto").where("id", "=", agentId).executeTakeFirst();
      const build = await currentBuild();
      if (!agent?.lsc_auto || !build || state.sha256 !== build.sha256 || (await unsentRows()).length === 0) return;
      autoStarted.set(agentId, { at: Date.now(), finishedAt: state.run.finishedAt });
      const answer = await start(agentId);
      if (!answer.ok) app.log.warn({ agentId, code: answer.code }, "ls-clicker auto run not started");
    } finally {
      checking.delete(agentId);
    }
  };

  app.put(
    "/api/v1/agents/:id/ls-clicker/auto",
    { preHandler: operatorAuth, schema: { params: idParams, body: z.object({ enabled: z.boolean() }), response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const updated = await db.updateTable("agents").set({ lsc_auto: request.body.enabled }).where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      const mac = (await macs()).find((m) => m.agentId === request.params.id);
      if (request.body.enabled && mac) void autoRun(mac.agentId, mac.state).catch((e) => app.log.error(e, "ls-clicker auto run"));
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/api/v1/agents/:id/ls-clicker/runs",
    { preHandler: operatorAuth, schema: { params: idParams, body: z.object({ retry: z.boolean().optional() }).nullish(), response: { 202: z.object({ started: z.literal(true) }), ...errors } } },
    async (request, reply) => {
      if (!(await db.selectFrom("agents").select("id").where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst())) return sendError(reply, request, 404, "NOT_FOUND", "Agent not found");
      const answer = await start(request.params.id, !!request.body?.retry);
      if (!answer.ok) return sendError(reply, request, answer.code === "NO_ROWS" ? 409 : statusOf(answer.code), answer.code, answer.message);
      return reply.code(202).send({ started: true as const });
    },
  );

  // Every free Mac takes its next row.
  app.post(
    "/api/v1/ls-clicker/runs",
    { preHandler: operatorAuth, schema: { response: { 202: z.object({ started: z.array(z.string()), skipped: z.array(z.object({ name: z.string(), reason: z.string() })) }), 401: errorSchema } } },
    async (_request, reply) => {
      const started: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const m of await macs()) {
        // Busy or not is the agent's answer: the last heartbeat may still show a run that has just ended.
        if (m.connection !== "ONLINE") skipped.push({ name: m.name, reason: "не на связи" });
        else if (!m.state.sha256) skipped.push({ name: m.name, reason: "ls-clicker ещё не установлен" });
        else {
          const answer = await start(m.agentId);
          if (answer.ok) started.push(m.name);
          else
            skipped.push({
              name: m.name,
              reason: answer.code === "NO_ROWS" ? "в таблице не осталось строк" : answer.code === "LS_CLICKER_RUNNING" ? "уже выполняет строку" : `${answer.code}: ${answer.message}`,
            });
        }
      }
      return reply.code(202).send({ started, skipped });
    },
  );
}
