import type { Db } from "@bap/database";
import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";
import { CsvError, parseCsv, toCsv, toEngineCsv } from "@bap/csv";
import { PROXY_FORMAT } from "@bap/protocol";

const MAX_BYTES = 20 * 1024 * 1024;
/** Our columns, appended to the operator's own in the table and the export. */
export const OUR_COLUMNS = ["Статус профиля", "Mac", "Последний проход", "Статус прохода", "Ошибка", "Когда"];

const ours = z
  .object({
    profileId: z.string(),
    profileName: z.string(),
    profileStatus: z.string(),
    profileLastError: z.string().nullable(),
    agentName: z.string(),
    agentModel: z.string().nullable(),
    lastRun: z.object({ id: z.string(), scenarioId: z.string(), status: z.string(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), at: z.string() }).nullable(),
  })
  .nullable();
/** Where LS Clicker has the row: which Mac, and its output.csv result once processed (ADR-0034). */
const lsc = z.object({ agentName: z.string(), result: z.object({ header: z.array(z.string()), cells: z.array(z.string()) }).nullable() }).nullable();
type Lsc = z.infer<typeof lsc>;
const pipelineSchema = z.object({
  import: z.object({ fileName: z.string(), columns: z.array(z.string()), profileColumn: z.number().nullable(), rowCount: z.number(), createdAt: z.string(), createdBy: z.string().nullable() }).nullable(),
  rows: z.array(z.object({ n: z.number(), cells: z.array(z.string()), proxy: z.string().nullable(), ours, lsc })),
});
type Ours = z.infer<typeof ours>;

/**
 * The operator's own table in «Конвейер» (REQ-UI-012): any CSV, stored as it came, shown next to the
 * state of the matching profile, exported with our columns added. Its rows are the owner's employees'
 * data: nothing here logs or audits cell values (ADR-0033).
 */
export function registerPipeline(app: App, { db, operatorAuth }: { db: Db; operatorAuth: preHandlerAsyncHookHandler }) {
  const errors = { 400: errorSchema, 401: errorSchema, 404: errorSchema };
  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  const current = () => db.selectFrom("pipeline_import").selectAll().orderBy("created_at", "desc").executeTakeFirst();

  /** LS Clicker's side of each row: the Mac it was sent to and the result that came back. */
  const lscOf = async (importId: string) => {
    const queued = await db
      .selectFrom("lsclicker_queue")
      .innerJoin("agents", "agents.id", "lsclicker_queue.agent_id")
      .leftJoin("lsclicker_results", (j) => j.onRef("lsclicker_results.agent_id", "=", "lsclicker_queue.agent_id").onRef("lsclicker_results.position", "=", "lsclicker_queue.position"))
      .select(["lsclicker_queue.row_n", "agents.name", "lsclicker_results.header", "lsclicker_results.cells"])
      .where("lsclicker_queue.import_id", "=", importId)
      .execute();
    return new Map<number, Lsc>(queued.map((q) => [q.row_n!, { agentName: q.name, result: q.cells ? { header: q.header as string[], cells: q.cells as string[] } : null }]));
  };

  /** Our side of each row: the profile named in the chosen column, its Mac and its latest run. */
  const load = async () => {
    const imp = await current();
    if (!imp) return { imp: null, rows: [] as { n: number; cells: string[]; proxy: string | null; ours: Ours; lsc: Lsc }[] };
    const stored = await db.selectFrom("pipeline_rows").select(["n", "cells", "proxy"]).where("import_id", "=", imp.id).orderBy("n").execute();
    const cells = stored.map((r) => r.cells as string[]);
    const sent = await lscOf(imp.id);
    const lscAt = (i: number) => sent.get(stored[i]!.n) ?? null;
    const own = (i: number) => ({ n: stored[i]!.n, proxy: stored[i]!.proxy });
    const col = imp.profile_column;
    if (col === null) return { imp, rows: cells.map((c, i) => ({ ...own(i), cells: c, ours: null, lsc: lscAt(i) })) };
    const profiles = await db
      .selectFrom("profiles")
      .innerJoin("agents", "agents.id", "profiles.agent_id")
      .select(["profiles.id", "profiles.name", "profiles.external_profile_id", "profiles.status", "profiles.last_error", "agents.name as agent_name", "agents.model as agent_model"])
      .where("profiles.archived_at", "is", null)
      .execute();
    const key = (v: string) => v.trim().toLowerCase();
    const byKey = new Map<string, (typeof profiles)[number]>();
    for (const p of profiles) {
      byKey.set(key(p.external_profile_id), p);
      byKey.set(key(p.name), p);
    }
    const latest = profiles.length
      ? await db
          .selectFrom("runs")
          .select(["id", "profile_id", "scenario_id", "status", "error_code", "error_message", "created_at", "finished_at"])
          .distinctOn("profile_id")
          .where("kind", "<>", "farm")
          .where("profile_id", "in", profiles.map((p) => p.id))
          .orderBy("profile_id")
          .orderBy("created_at", "desc")
          .execute()
      : [];
    return {
      imp,
      rows: cells.map((c, i) => {
        const p = byKey.get(key(c[col] ?? ""));
        const run = p && latest.find((r) => r.profile_id === p.id);
        return {
          ...own(i),
          cells: c,
          ours: p
            ? {
                profileId: p.id,
                profileName: p.name,
                profileStatus: p.status,
                profileLastError: p.last_error,
                agentName: p.agent_name,
                agentModel: p.agent_model,
                lastRun: run ? { id: run.id, scenarioId: run.scenario_id, status: run.status, errorCode: run.error_code, errorMessage: run.error_message, at: (run.finished_at ?? run.created_at).toISOString() } : null,
              }
            : null,
          lsc: lscAt(i),
        };
      }),
    };
  };

  app.post(
    "/api/v1/pipeline/import",
    {
      preHandler: operatorAuth,
      schema: { querystring: z.object({ name: z.string().min(1).max(255).default("table.csv") }), response: { 201: z.object({ rows: z.number(), columns: z.number() }), ...errors } },
    },
    async (request, reply) => {
      let parsed;
      try {
        parsed = parseCsv(typeof request.body === "string" ? request.body : "");
      } catch (e) {
        if (e instanceof CsvError) return sendError(reply, request, 400, "CSV_INVALID", e.message);
        throw e;
      }
      const operator = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId!).executeTakeFirst();
      await db.transaction().execute(async (tx) => {
        // One current table: a new upload replaces the old one completely.
        await tx.deleteFrom("pipeline_import").execute();
        const imp = await tx
          .insertInto("pipeline_import")
          .values({ file_name: request.query.name, delimiter: parsed.delimiter, columns: JSON.stringify(parsed.columns), row_count: parsed.rows.length, created_by: operator?.login ?? null })
          .returning("id")
          .executeTakeFirstOrThrow();
        for (let i = 0; i < parsed.rows.length; i += 1000)
          await tx
            .insertInto("pipeline_rows")
            .values(parsed.rows.slice(i, i + 1000).map((cells, j) => ({ import_id: imp.id, n: i + j + 1, cells: JSON.stringify(cells) })))
            .execute();
      });
      return reply.code(201).send({ rows: parsed.rows.length, columns: parsed.columns.length });
    },
  );

  app.get("/api/v1/pipeline", { preHandler: operatorAuth, schema: { response: { 200: pipelineSchema, ...errors } } }, async () => {
    const { imp, rows } = await load();
    return {
      import: imp && { fileName: imp.file_name, columns: imp.columns as string[], profileColumn: imp.profile_column, rowCount: imp.row_count, createdAt: imp.created_at.toISOString(), createdBy: imp.created_by },
      rows,
    };
  });

  app.put(
    "/api/v1/pipeline/profile-column",
    { preHandler: operatorAuth, schema: { body: z.object({ column: z.number().int().min(0).nullable() }), response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const imp = await current();
      if (!imp) return sendError(reply, request, 404, "NOT_FOUND", "No table has been imported");
      const { column } = request.body;
      if (column !== null && column >= (imp.columns as string[]).length) return sendError(reply, request, 400, "COLUMN_INVALID", `The table has ${(imp.columns as string[]).length} columns`);
      await db.updateTable("pipeline_import").set({ profile_column: column }).where("id", "=", imp.id).execute();
      return reply.code(204).send(null);
    },
  );

  // The operator adds rows by hand: one line per row, values comma-separated in the table's column order.
  app.post(
    "/api/v1/pipeline/rows",
    { preHandler: operatorAuth, schema: { body: z.object({ text: z.string().min(1).max(MAX_BYTES) }), response: { 201: z.object({ added: z.number() }), ...errors } } },
    async (request, reply) => {
      const imp = await current();
      if (!imp) return sendError(reply, request, 404, "NOT_FOUND", "No table has been imported");
      const columns = imp.columns as string[];
      let rows: string[][];
      try {
        // Parsed under the table's own header, written with commas: the lines are read as comma-separated.
        rows = parseCsv(toEngineCsv([columns]) + request.body.text).rows;
      } catch (e) {
        if (e instanceof CsvError) return sendError(reply, request, 400, "CSV_INVALID", e.message.replace(/строка (\d+)/, (_m, n) => `строка ${Number(n) - 1}`));
        throw e;
      }
      if (rows.length === 0) return sendError(reply, request, 400, "CSV_INVALID", "нет строк");
      const last = await db.selectFrom("pipeline_rows").select((eb) => eb.fn.max("n").as("n")).where("import_id", "=", imp.id).executeTakeFirst();
      const from = Number(last?.n ?? 0);
      await db.transaction().execute(async (tx) => {
        await tx.insertInto("pipeline_rows").values(rows.map((cells, i) => ({ import_id: imp.id, n: from + i + 1, cells: JSON.stringify(cells) }))).execute();
        await tx.updateTable("pipeline_import").set((eb) => ({ row_count: eb("row_count", "+", rows.length) })).where("id", "=", imp.id).execute();
      });
      return reply.code(201).send({ added: rows.length });
    },
  );

  // The operator edits a row: its cells until LS Clicker has taken it (input.csv on a Mac is never rewritten),
  // its proxy until it has been processed (the proxy is read when the row starts).
  app.patch(
    "/api/v1/pipeline/rows/:n",
    {
      preHandler: operatorAuth,
      schema: {
        params: z.object({ n: z.coerce.number().int().positive() }),
        body: z.object({ cells: z.array(z.string()).optional(), proxy: z.string().trim().regex(PROXY_FORMAT, "ip:port or ip:port@login:pass").or(z.literal("")).nullable().optional() }),
        response: { 204: z.null(), ...errors, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const imp = await current();
      if (!imp) return sendError(reply, request, 404, "NOT_FOUND", "No table has been imported");
      const row = await db.selectFrom("pipeline_rows").select("n").where("import_id", "=", imp.id).where("n", "=", request.params.n).executeTakeFirst();
      if (!row) return sendError(reply, request, 404, "NOT_FOUND", "No such row");
      const { cells, proxy } = request.body;
      if (cells && cells.length !== (imp.columns as string[]).length) return sendError(reply, request, 400, "CELLS_INVALID", `The row has ${(imp.columns as string[]).length} columns`);
      const sent = await db
        .selectFrom("lsclicker_queue")
        .leftJoin("lsclicker_results", (j) => j.onRef("lsclicker_results.agent_id", "=", "lsclicker_queue.agent_id").onRef("lsclicker_results.position", "=", "lsclicker_queue.position"))
        .select(["lsclicker_results.position as done"])
        .where("lsclicker_queue.import_id", "=", imp.id)
        .where("lsclicker_queue.row_n", "=", row.n)
        .executeTakeFirst();
      if (cells && sent) return sendError(reply, request, 409, "ROW_SENT", "The row is already on a Mac: its cells can no longer change there");
      if (proxy !== undefined && sent && sent.done !== null) return sendError(reply, request, 409, "ROW_PROCESSED", "The row has been processed: its proxy is no longer used");
      await db
        .updateTable("pipeline_rows")
        .set({ ...(cells && { cells: JSON.stringify(cells) }), ...(proxy !== undefined && { proxy: proxy || null }) })
        .where("import_id", "=", imp.id)
        .where("n", "=", row.n)
        .execute();
      return reply.code(204).send(null);
    },
  );

  app.get("/api/v1/pipeline/export", { preHandler: operatorAuth, schema: { response: { 200: z.string(), 404: errorSchema, 401: errorSchema } } }, async (request, reply) => {
    const { imp, rows } = await load();
    if (!imp) return sendError(reply, request, 404, "NOT_FOUND", "No table has been imported");
    const extra = (o: Ours) =>
      o
        ? [o.profileStatus, [o.agentName, o.agentModel].filter(Boolean).join(" · "), o.lastRun?.scenarioId ?? "", o.lastRun?.status ?? "", o.lastRun?.errorCode ? `${o.lastRun.errorCode}: ${o.lastRun.errorMessage ?? ""}` : (o.profileLastError ?? ""), o.lastRun?.at ?? ""]
        : OUR_COLUMNS.map(() => "");
    // LS Clicker's result columns (output.csv) follow ours, under its own header.
    const resultHeader = rows.find((r) => r.lsc?.result)?.lsc?.result?.header ?? [];
    const lscCells = (l: Lsc) => [l?.agentName ?? "", ...resultHeader.map((_, i) => l?.result?.cells[i] ?? "")];
    const csv = toCsv(imp.delimiter, [
      [...(imp.columns as string[]), ...OUR_COLUMNS, "LS Clicker: Mac", ...resultHeader, "Прокси"],
      ...rows.map((r) => [...r.cells, ...extra(r.ours), ...lscCells(r.lsc), r.proxy ?? ""]),
    ]);
    const name = imp.file_name.replace(/\.csv$/i, "") + "-конвейер.csv";
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="pipeline.csv"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(csv);
  });

  app.delete("/api/v1/pipeline", { preHandler: operatorAuth, schema: { response: { 204: z.null(), ...errors } } }, async (_request, reply) => {
    await db.deleteFrom("pipeline_import").execute();
    return reply.code(204).send(null);
  });
}
