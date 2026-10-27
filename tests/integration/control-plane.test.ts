import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import newman from "newman";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { buildPostmanCollection } from "../../apps/control-plane/src/postman.ts";

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "s3cret-pass");
  app = buildApp({ db, secureCookies: true });
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

const login = (password = "s3cret-pass") => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password } });
const sessionCookie = (res: Awaited<ReturnType<typeof login>>) => res.cookies.find((c) => c.name === "bap_session")!;

describe("database", () => {
  test("[REQ-DB-001] migrations create the schema on a clean database and are idempotent", async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["agents", "api_tokens", "operator_sessions", "operators"]),
    );
    expect(await migrateToLatest(db)).toEqual([]);
  });

  test("[REQ-DB-001] agent status is constrained to the administrative states", async () => {
    await expect(
      db.insertInto("agents").values({ name: "bad", platform: "darwin", architecture: "arm64", status: "PENDING" }).execute(),
    ).rejects.toThrow(/agents_status_check/);
  });
});

describe("operator authentication", () => {
  test("[REQ-SEC-011] protected routes answer 401 without authentication, in the PRD error format", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required", requestId: expect.any(String) } });
  });

  test("[REQ-SEC-011] wrong password is rejected and no session cookie is set", async () => {
    const res = await login("wrong");
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toEqual([]);
  });

  test("[REQ-SEC-011] password is stored as an argon2id hash", async () => {
    const row = await db.selectFrom("operators").select("password_hash").where("login", "=", "operator").executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
  });

  test("[REQ-SEC-011] login sets an httpOnly, SameSite=Strict, Secure session cookie; logout revokes it", async () => {
    const res = await login();
    expect(res.statusCode).toBe(204);
    const cookie = sessionCookie(res);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", secure: true, path: "/" });

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { bap_session: cookie.value } });
    expect(me.json()).toEqual({ login: "operator" });

    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { bap_session: cookie.value } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { bap_session: cookie.value } })).statusCode).toBe(401);
  });

  test("[REQ-SEC-011] expired sessions are rejected", async () => {
    const shortLived = buildApp({ db, sessionTtlMs: -1 });
    const res = await shortLived.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "s3cret-pass" } });
    const me = await shortLived.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { bap_session: sessionCookie(res).value } });
    expect(me.statusCode).toBe(401);
    await shortLived.close();
  });

  test("[REQ-SEC-011] Bearer API tokens authenticate REST calls; unknown tokens do not", async () => {
    const cookie = sessionCookie(await login()).value;
    const created = await app.inject({ method: "POST", url: "/api/v1/auth/tokens", cookies: { bap_session: cookie }, payload: { name: "ci" } });
    expect(created.statusCode).toBe(201);
    const { token } = created.json();

    const agents = await app.inject({ method: "GET", url: "/api/v1/agents", headers: { authorization: `Bearer ${token}` } });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/agents", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);

    const stored = await db.selectFrom("api_tokens").select("token_hash").execute();
    expect(stored.map((t) => t.token_hash)).not.toContain(token);
  });

  test("[REQ-SEC-011] invalid login payload is a validation error", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

test("[REQ-API-001] the generated Postman collection runs in Newman against a live Control Plane", async () => {
  const live = buildApp({ db, secureCookies: false });
  const baseUrl = await live.listen({ host: "127.0.0.1", port: 0 });
  const cookie = sessionCookie(await login()).value;
  const { token } = (await app.inject({ method: "POST", url: "/api/v1/auth/tokens", cookies: { bap_session: cookie }, payload: { name: "newman" } })).json();

  const collection = await buildPostmanCollection(buildApp({ db }));
  const summary = await new Promise<newman.NewmanRunSummary>((resolve, reject) =>
    newman.run(
      {
        collection: collection as never,
        envVar: [
          { key: "baseUrl", value: baseUrl },
          { key: "token", value: token },
          { key: "login", value: "operator" },
          { key: "password", value: "s3cret-pass" },
          { key: "name", value: "from-newman" },
        ],
        reporters: [],
      },
      (err, s) => (err ? reject(err) : resolve(s)),
    ),
  );
  await live.close();

  expect(summary.run.failures).toEqual([]);
  const codes = Object.fromEntries(summary.run.executions.map((e) => [e.item.name, e.response?.code]));
  expect(codes).toMatchObject({
    "GET /api/v1/health": 200,
    "POST /api/v1/auth/login": 204,
    "GET /api/v1/auth/me": 200,
    "POST /api/v1/auth/tokens": 201,
    "GET /api/v1/agents": 200,
  });
});
