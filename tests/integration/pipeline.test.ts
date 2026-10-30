import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { parseCsv } from "@bap/csv";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

// Made-up rows only: the owner's real table holds employees' data and never appears in tests.
const TABLE = "Сотрудник;Профиль;Заметка\nИван Тестов;shop-a;первая\nПётр Пробный;SHOP-B ;вторая\nАнна Нетпрофиля;nobody;третья\n";

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let cookie: string;
let agentId: string;

const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { bap_session: cookie } });
const upload = (csv: string, name = "люди.csv") =>
  app.inject({ method: "POST", url: `/api/v1/pipeline/import?name=${encodeURIComponent(name)}`, payload: csv, headers: { "content-type": "text/csv" }, cookies: { bap_session: cookie } });

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 } });
  await app.ready();
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  agentId = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-table", platform: "darwin", architecture: "arm64" } })).json().agentId;
  await db.updateTable("agents").set({ model: "MacBook Air · Apple M5 · 16 GB" }).where("id", "=", agentId).execute();
  const a = await db.insertInto("profiles").values({ provider: "linken-sphere", external_profile_id: "uuid-a", name: "shop-a", agent_id: agentId }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("profiles").values({ provider: "linken-sphere", external_profile_id: "shop-b", name: "Магазин Б", agent_id: agentId, status: "NEEDS_REVIEW", last_error: "капча" }).execute();
  await db.insertInto("scenarios").values({ id: "table-test" }).execute();
  await db.insertInto("scenario_versions").values({ scenario_id: "table-test", version: "1.0.0", sha256: "0".repeat(64), bundle_key: "unused" }).execute();
  for (const [status, at] of [["SUCCEEDED", "2026-10-01T10:00:00Z"], ["FAILED", "2026-10-02T10:00:00Z"]] as const)
    await db
      .insertInto("runs")
      .values({ scenario_id: "table-test", scenario_version: "1.0.0", profile_id: a.id, agent_id: agentId, input: {}, timeout_ms: 1000, status, error_code: status === "FAILED" ? "STEP_FAILED" : null, error_message: status === "FAILED" ? "кнопки нет" : null, created_at: at, finished_at: at })
      .execute();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

describe("the operator's table in «Конвейер»", () => {
  test("[REQ-UI-012] any CSV is stored as it came; the answer has counts, not values", async () => {
    expect((await api("GET", "/api/v1/pipeline")).json()).toEqual({ import: null, rows: [] });
    const res = await upload(TABLE);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ rows: 3, columns: 3 });
    const view = (await api("GET", "/api/v1/pipeline")).json();
    expect(view.import).toMatchObject({ fileName: "люди.csv", columns: ["Сотрудник", "Профиль", "Заметка"], profileColumn: null, rowCount: 3, createdBy: "operator" });
    expect(view.rows.map((r: { cells: string[]; ours: unknown }) => [r.cells[0], r.ours])).toEqual([
      ["Иван Тестов", null],
      ["Пётр Пробный", null],
      ["Анна Нетпрофиля", null],
    ]);
  });

  test("[REQ-UI-012] the profile column links rows to profiles by name or LS id: their state, Mac and latest run", async () => {
    expect((await api("PUT", "/api/v1/pipeline/profile-column", { column: 5 })).statusCode).toBe(400);
    expect((await api("PUT", "/api/v1/pipeline/profile-column", { column: 1 })).statusCode).toBe(204);
    const rows = (await api("GET", "/api/v1/pipeline")).json().rows;
    expect(rows[0].ours).toMatchObject({ profileName: "shop-a", profileStatus: "AVAILABLE", agentName: "mac-table", agentModel: "MacBook Air · Apple M5 · 16 GB", lastRun: { scenarioId: "table-test", status: "FAILED", errorCode: "STEP_FAILED" } });
    expect(rows[1].ours).toMatchObject({ profileName: "Магазин Б", profileStatus: "NEEDS_REVIEW", profileLastError: "капча", lastRun: null });
    expect(rows[2].ours).toBeNull();
  });

  test("[REQ-UI-012] the export is the operator's columns plus ours, in the same delimiter", async () => {
    const res = await api("GET", "/api/v1/pipeline/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("люди-конвейер.csv"));
    const csv = parseCsv(res.body);
    expect(csv.delimiter).toBe(";");
    expect(csv.columns).toEqual(["Сотрудник", "Профиль", "Заметка", "Статус профиля", "Mac", "Последний проход", "Статус прохода", "Ошибка", "Когда", "LS Clicker: Mac", "Прокси"]);
    expect(csv.rows[0]).toEqual(["Иван Тестов", "shop-a", "первая", "AVAILABLE", "mac-table · MacBook Air · Apple M5 · 16 GB", "table-test", "FAILED", "STEP_FAILED: кнопки нет", "2026-10-02T10:00:00.000Z", "", ""]);
    expect(csv.rows[1]!.slice(3, 5)).toEqual(["NEEDS_REVIEW", "mac-table · MacBook Air · Apple M5 · 16 GB"]);
    expect(csv.rows[1]![7]).toBe("капча");
    expect(csv.rows[2]!.slice(3)).toEqual(["", "", "", "", "", "", "", ""]);
  });

  test("[REQ-UI-013] the operator edits a row's cells and its proxy; a proxy is taken in any common form and stored as ls-clicker takes it; the export ends with it", async () => {
    const patch = (n: number, payload: object) => app.inject({ method: "PATCH", url: `/api/v1/pipeline/rows/${n}`, payload, cookies: { bap_session: cookie } });
    expect((await patch(1, { cells: ["Иван Тестов", "shop-a", "исправлено"] })).statusCode).toBe(204);
    expect((await patch(1, { proxy: "10.0.0.7:1080@user:p@ss:word" })).statusCode).toBe(204);
    expect((await patch(2, { proxy: "10.0.0.8:1080" })).statusCode).toBe(204);
    expect((await patch(1, { cells: ["слишком", "мало"] })).json().error.code).toBe("CELLS_INVALID");
    for (const bad of ["10.0.0.7", "10.0.0.7:port", "10.0.0.7:1080@onlylogin", "a b:1"]) expect((await patch(1, { proxy: bad })).statusCode, bad).toBe(400);
    expect((await patch(99, { proxy: "1.2.3.4:5" })).statusCode).toBe(404);
    // Any common way of writing a proxy is stored in the one form ls-clicker takes.
    for (const [written, stored] of [
      ["user:pass@10.0.0.9:1080", "10.0.0.9:1080@user:pass"],
      ["10.0.0.9:1080:user:pass", "10.0.0.9:1080@user:pass"],
      ["http://user:pass@10.0.0.9:3128", "http://10.0.0.9:3128@user:pass"],
    ]) {
      expect((await patch(3, { proxy: written! })).statusCode).toBe(204);
      expect((await api("GET", "/api/v1/pipeline")).json().rows[2].proxy).toBe(stored);
    }
    expect((await patch(3, { proxy: "" })).statusCode).toBe(204);
    const rows = (await api("GET", "/api/v1/pipeline")).json().rows;
    expect(rows[0]).toMatchObject({ n: 1, cells: ["Иван Тестов", "shop-a", "исправлено"], proxy: "10.0.0.7:1080@user:p@ss:word" });
    expect(rows[2].proxy).toBeNull();
    const csv = parseCsv((await api("GET", "/api/v1/pipeline/export")).body);
    expect(csv.columns.at(-1)).toBe("Прокси");
    expect(csv.rows.map((r) => r.at(-1))).toEqual(["10.0.0.7:1080@user:p@ss:word", "10.0.0.8:1080", ""]);
    // Clearing it.
    expect((await patch(2, { proxy: "" })).statusCode).toBe(204);
    expect((await api("GET", "/api/v1/pipeline")).json().rows[1].proxy).toBeNull();
    // The journal records the edit, never the values.
    const journal = JSON.stringify(await db.selectFrom("audit_events").selectAll().execute());
    expect(journal).not.toContain("p@ss");
    expect(journal).not.toContain("исправлено");
  });

  test("[REQ-UI-014] the operator adds rows: comma-separated values in the table's column order, quotes allowed, missing values empty", async () => {
    const add = (text: string) => app.inject({ method: "POST", url: "/api/v1/pipeline/rows", payload: { text }, cookies: { bap_session: cookie } });
    const before = (await api("GET", "/api/v1/pipeline")).json();
    const res = await add('Новый Тест,shop-a,"с запятой, внутри"\nЕщё Один,nobody\n');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ added: 2 });
    const after = (await api("GET", "/api/v1/pipeline")).json();
    expect(after.import.rowCount).toBe(before.import.rowCount + 2);
    expect(after.rows.slice(-2).map((r: { n: number; cells: string[] }) => [r.n, r.cells])).toEqual([
      [before.rows.at(-1).n + 1, ["Новый Тест", "shop-a", "с запятой, внутри"]],
      [before.rows.at(-1).n + 2, ["Ещё Один", "nobody", ""]],
    ]);
    const tooLong = await add("a,b,c\nтут,слишком,много,значений\n");
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toBe("строка 2: 4 значения при 3 колонках");
    expect(tooLong.body).not.toContain("слишком");
    expect((await api("GET", "/api/v1/pipeline")).json().import.rowCount).toBe(before.import.rowCount + 2);
  });

  test("[REQ-LSC-007] the operator sets a row's status to good or bad by hand, also on a row already on a Mac; none brings it back", async () => {
    const patch = (n: number, payload: object) => app.inject({ method: "PATCH", url: `/api/v1/pipeline/rows/${n}`, payload, cookies: { bap_session: cookie } });
    const { rows } = (await api("GET", "/api/v1/pipeline")).json();
    expect((await patch(rows[0].n, { status: "good" })).json().error.code).toBe("NO_STATUS_COLUMN");
    const upload = await app.inject({ method: "POST", url: "/api/v1/pipeline/import?name=verdict.csv", payload: "who,status\nann,\nbob,рег\n", headers: { "content-type": "text/csv" }, cookies: { bap_session: cookie } });
    expect(upload.statusCode).toBe(201);
    expect((await patch(1, { status: "good" })).statusCode).toBe(204);
    expect((await patch(2, { status: "bad" })).statusCode).toBe(204);
    expect((await api("GET", "/api/v1/pipeline")).json().rows.map((r: { cells: string[] }) => r.cells)).toEqual([["ann", "good"], ["bob", "bad"]]);
    expect((await patch(2, { status: "" })).statusCode).toBe(204);
    expect((await api("GET", "/api/v1/pipeline")).json().rows[1].cells).toEqual(["bob", ""]);
    expect((await patch(1, { status: "maybe" })).statusCode).toBe(400);
  });

  test("[REQ-UI-014] the operator deletes a row that has not gone to a Mac; the others keep their numbers", async () => {
    const remove = (n: number) => app.inject({ method: "DELETE", url: `/api/v1/pipeline/rows/${n}`, cookies: { bap_session: cookie } });
    const before = (await api("GET", "/api/v1/pipeline")).json();
    const [first, second] = before.rows as { n: number }[];
    expect((await remove(first!.n)).statusCode).toBe(204);
    const after = (await api("GET", "/api/v1/pipeline")).json();
    expect(after.import.rowCount).toBe(before.import.rowCount - 1);
    expect(after.rows.map((r: { n: number }) => r.n)).toEqual(before.rows.slice(1).map((r: { n: number }) => r.n));
    expect(after.rows[0].n).toBe(second!.n);
    expect((await remove(first!.n)).statusCode).toBe(404);
    expect((await remove(99_999)).json().error.code).toBe("NOT_FOUND");
  });

  test("[REQ-UI-012] a new upload replaces the table; clearing removes it; a broken file is refused with the line, not the values", async () => {
    expect((await upload("a,b\n1,2\n", "второй.csv")).json()).toEqual({ rows: 1, columns: 2 });
    const view = (await api("GET", "/api/v1/pipeline")).json();
    expect(view.import).toMatchObject({ fileName: "второй.csv", profileColumn: null, rowCount: 1 });
    expect(await db.selectFrom("pipeline_rows").select(({ fn }) => fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).toEqual({ n: "1" });

    const bad = await upload("a,b\n1,2\nсекретное-значение,2,3\n");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: "CSV_INVALID", message: "строка 3: 3 значения при 2 колонках" });
    expect(bad.body).not.toContain("секретное-значение");
    expect((await api("GET", "/api/v1/pipeline")).json().import.fileName).toBe("второй.csv");

    expect((await api("DELETE", "/api/v1/pipeline")).statusCode).toBe(204);
    expect((await api("GET", "/api/v1/pipeline")).json()).toEqual({ import: null, rows: [] });
    expect((await api("GET", "/api/v1/pipeline/export")).statusCode).toBe(404);
  });

  test("[REQ-UI-012] only the operator reaches the table, and the journal never holds its values", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/pipeline" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/pipeline/import", payload: TABLE, headers: { "content-type": "text/csv" } })).statusCode).toBe(401);
    await upload(TABLE);
    const journal = JSON.stringify(await db.selectFrom("audit_events").selectAll().execute());
    for (const value of ["Иван Тестов", "Пётр Пробный", "первая", "Сотрудник"]) expect(journal).not.toContain(value);
  });
});
