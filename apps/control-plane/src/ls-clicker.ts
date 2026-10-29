import { createHash } from "node:crypto";
import type { Db } from "@bap/database";
import { type LsClickerState, lsClickerState } from "@bap/protocol";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
import { AgentRequestError, type Fleet, type FleetConfig, connection } from "./fleet.ts";
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
    const rows = await db.selectFrom("agents").select(["id", "name", "model", "last_seen_at", "last_heartbeat", "status"]).where("deleted_at", "is", null).where("status", "!=", "REVOKED").orderBy("name").execute();
    return rows.flatMap((r) => {
      const state = lsClickerState.safeParse((r.last_heartbeat as { lsClicker?: unknown } | null)?.lsClicker ?? null);
      return state.success && state.data ? [{ agentId: r.id, name: r.name, model: r.model, connection: connection(r.last_seen_at, fleetConfig), state: state.data }] : [];
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
  };

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
  const macView = z.object({ agentId: z.string(), name: z.string(), model: z.string().nullable(), connection: z.string(), state: lsClickerState.unwrap(), sent: z.number(), processed: z.number() });
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
  const onMac = (path: string, method: "lsclicker.run" | "lsclicker.stop" | "lsclicker.log" | "lsclicker.plan", http: "GET" | "POST", code: 200 | 202) =>
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
  onMac("runs", "lsclicker.run", "POST", 202);
  onMac("stop", "lsclicker.stop", "POST", 202);
  onMac("log", "lsclicker.log", "GET", 200);
  onMac("plan", "lsclicker.plan", "GET", 200);

  // Every free Mac that still has unprocessed rows starts its next one.
  app.post(
    "/api/v1/ls-clicker/runs",
    { preHandler: operatorAuth, schema: { response: { 202: z.object({ started: z.array(z.string()), skipped: z.array(z.object({ name: z.string(), reason: z.string() })) }), 401: errorSchema } } },
    async (_request, reply) => {
      const started: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const m of await macs()) {
        if (m.connection !== "ONLINE") skipped.push({ name: m.name, reason: "не на связи" });
        else if (m.state.run.running) skipped.push({ name: m.name, reason: "уже выполняет строку" });
        else if (m.state.inputRows <= m.state.outputRows) skipped.push({ name: m.name, reason: "нет необработанных строк" });
        else {
          const answer = await ask(m.agentId, { method: "lsclicker.run" });
          if (answer.ok) started.push(m.name);
          else skipped.push({ name: m.name, reason: `${answer.code}: ${answer.message}` });
        }
      }
      return reply.code(202).send({ started, skipped });
    },
  );

  // ---- rows of the operator's table → Macs ----
  async function unsentRows() {
    const imp = await db.selectFrom("pipeline_import").select(["id", "columns"]).orderBy("created_at", "desc").executeTakeFirst();
    if (!imp) return [];
    return db
      .selectFrom("pipeline_rows")
      .leftJoin("lsclicker_queue", (j) => j.onRef("lsclicker_queue.import_id", "=", "pipeline_rows.import_id").onRef("lsclicker_queue.row_n", "=", "pipeline_rows.n"))
      .select(["pipeline_rows.import_id", "pipeline_rows.n", "pipeline_rows.cells"])
      .where("pipeline_rows.import_id", "=", imp.id)
      .where("lsclicker_queue.position", "is", null)
      .orderBy("pipeline_rows.n")
      .execute();
  }

  // Unsent rows go to the chosen Macs (all online ones by default) evenly, appended to their input.csv.
  app.post(
    "/api/v1/ls-clicker/distribute",
    {
      preHandler: operatorAuth,
      schema: {
        body: z.object({ agentIds: z.array(z.uuid()).min(1).optional(), limit: z.number().int().positive().optional() }),
        response: { 200: z.object({ sent: z.array(z.object({ name: z.string(), rows: z.number() })), failed: z.array(z.object({ name: z.string(), code: z.string(), message: z.string() })) }), ...errors },
      },
    },
    async (request, reply) => {
      const imp = await db.selectFrom("pipeline_import").select(["id", "columns"]).orderBy("created_at", "desc").executeTakeFirst();
      if (!imp) return sendError(reply, request, 404, "NOT_FOUND", "No table has been imported");
      const targets = (await macs()).filter((m) => m.connection === "ONLINE" && (!request.body.agentIds || request.body.agentIds.includes(m.agentId)));
      if (targets.length === 0) return sendError(reply, request, 409, "NO_MACS", "No online Mac with LS Clicker to send rows to");
      const rows = (await unsentRows()).slice(0, request.body.limit);
      const share = new Map(targets.map((t) => [t.agentId, [] as typeof rows]));
      rows.forEach((r, i) => share.get(targets[i % targets.length]!.agentId)!.push(r));
      const sent: { name: string; rows: number }[] = [];
      const failed: { name: string; code: string; message: string }[] = [];
      for (const t of targets) {
        const mine = share.get(t.agentId)!;
        if (mine.length === 0) continue;
        const answer = await ask(t.agentId, { method: "lsclicker.append", header: imp.columns as string[], rows: mine.map((r) => r.cells as string[]), expectedInputRows: t.state.inputRows });
        if (!answer.ok) {
          failed.push({ name: t.name, code: answer.code, message: answer.message });
          continue;
        }
        await db
          .insertInto("lsclicker_queue")
          .values(mine.map((r, i) => ({ agent_id: t.agentId, position: t.state.inputRows + i, import_id: r.import_id, row_n: r.n })))
          .execute();
        sent.push({ name: t.name, rows: mine.length });
      }
      return { sent, failed };
    },
  );
}
