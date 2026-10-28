import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { PROFILE_NOT_FOUND_MESSAGE } from "../../apps/control-plane/src/profiles.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const profilesDir = mkdtempSync(join(tmpdir(), "bap-profiles-"));
const provider = new LocalChromiumProvider({ profilesDir });

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let baseUrl: string;
let cookie: string;
let agentId: string;
let agentKey: string;
let agent: RunningAgent;

const api = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { bap_session: cookie } });
const profile = async (id: string) => (await api("GET", `/api/v1/profiles/${id}`)).json();

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

const connect = () => startAgent({ serverUrl: baseUrl, agentKey, provider, providerName: "local-chromium", maxSessions: 2, dataDir: tmpdir(), log: () => {} });

beforeAll(async () => {
  for (const id of ["shop-1", "shop-2", "doomed"]) provider.createProfile(id);
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  ({ agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-1", platform: "darwin", architecture: "arm64" } })).json());
  agent = connect();
  await until("agent capabilities", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.maxSessions === 2);
});

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  rmSync(profilesDir, { recursive: true, force: true });
});

describe("import", () => {
  test("[REQ-API-003][REQ-PROF-001] the agent lists its provider profiles and import stores only identifiers and state", async () => {
    const listed = (await api("GET", `/api/v1/agents/${agentId}/provider-profiles`)).json();
    expect(listed).toEqual(expect.arrayContaining([{ id: "shop-1", name: "shop-1", importedAs: null }, { id: "shop-2", name: "shop-2", importedAs: null }]));

    const created = await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "shop-1", name: "Shop 1" });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(Object.keys(body).sort()).toEqual(
      ["activeRunId", "agentConnection", "agentId", "agentName", "assignable", "createdAt", "externalProfileId", "id", "lastError", "lastVerifiedAt", "name", "provider", "status", "updatedAt"].sort(),
    );
    expect(body).toMatchObject({ provider: "local-chromium", externalProfileId: "shop-1", name: "Shop 1", agentName: "mac-1", status: "AVAILABLE", assignable: true });
    expect((await api("GET", `/api/v1/agents/${agentId}/provider-profiles`)).json()).toContainEqual({ id: "shop-1", name: "shop-1", importedAs: body.id });
    expect((await api("GET", "/api/v1/profiles")).json().map((p: { id: string }) => p.id)).toContain(body.id);
  });

  test("[REQ-PROF-002] the same provider profile cannot be imported twice", async () => {
    await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "shop-2", name: "Shop 2" });
    const again = await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "shop-2", name: "Shop 2 again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("PROFILE_EXISTS");
    const rows = await db.selectFrom("profiles").select("id").where("external_profile_id", "=", "shop-2").execute();
    expect(rows).toHaveLength(1);
    await expect(
      db.insertInto("profiles").values({ provider: "local-chromium", external_profile_id: "shop-2", name: "x", agent_id: agentId }).execute(),
    ).rejects.toThrow(/profiles_external_live/);
  });
  test("an agent without a browser provider answers with PROVIDER_UNAVAILABLE", async () => {
    const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
    const bare = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-bare", platform: "darwin", architecture: "arm64" } })).json();
    const running = startAgent({ serverUrl: baseUrl, agentKey: bare.agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: tmpdir(), log: () => {} });
    await until("bare agent online", async () => (await api("GET", `/api/v1/agents/${bare.agentId}`)).json(), (a) => a.connection === "ONLINE" && a.maxSessions === 1);
    const res = await api("GET", `/api/v1/agents/${bare.agentId}/provider-profiles`);
    running.stop();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROVIDER_UNAVAILABLE");
    const imported = await api("POST", "/api/v1/profiles/import", { agentId: bare.agentId, externalProfileId: "x", name: "x" });
    expect(imported.json().error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("verification", () => {
  test("[REQ-API-003] verify opens and closes the profile on its agent, then marks it AVAILABLE", async () => {
    const { id } = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "shop-3", name: "Shop 3" })).json();
    provider.createProfile("shop-3");
    const started = await api("POST", `/api/v1/profiles/${id}/verify`);
    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe("VERIFYING");
    const done = await until("verified", () => profile(id), (p) => p.status !== "VERIFYING");
    expect(done).toMatchObject({ status: "AVAILABLE", lastError: null });
    expect(Date.now() - Date.parse(done.lastVerifiedAt)).toBeLessThan(15_000);
  });

  test("[REQ-LS-007] a profile missing at the provider is a configuration error and needs review", async () => {
    const { id } = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "doomed", name: "Doomed" })).json();
    rmSync(join(profilesDir, "doomed"), { recursive: true });
    await api("POST", `/api/v1/profiles/${id}/verify`);
    const done = await until("verify result", () => profile(id), (p) => p.status !== "VERIFYING");
    expect(done).toMatchObject({ status: "NEEDS_REVIEW", lastError: PROFILE_NOT_FOUND_MESSAGE, assignable: false });

    provider.createProfile("doomed");
    expect((await api("POST", `/api/v1/profiles/${id}/release-review`)).json()).toMatchObject({ status: "AVAILABLE", lastError: null });
  });

  test("[REQ-PROF-010] disable blocks the profile; enable re-verifies before it is AVAILABLE again", async () => {
    const id = (await api("GET", "/api/v1/profiles")).json().find((p: { externalProfileId: string }) => p.externalProfileId === "shop-1").id;
    expect((await api("POST", `/api/v1/profiles/${id}/disable`)).json()).toMatchObject({ status: "DISABLED", assignable: false });
    const conflict = await api("POST", `/api/v1/profiles/${id}/verify`);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("PROFILE_STATE_CONFLICT");

    const enabling = (await api("POST", `/api/v1/profiles/${id}/enable`)).json();
    expect(enabling.status).toBe("VERIFYING");
    expect(await until("enabled", () => profile(id), (p) => p.status !== "VERIFYING")).toMatchObject({ status: "AVAILABLE", assignable: true });
    expect((await api("POST", `/api/v1/profiles/${id}/enable`)).statusCode).toBe(409);
  });
});

describe("agent offline", () => {
  test("[REQ-PROF-005] when the agent goes OFFLINE the profile keeps its status but stops being assignable", async () => {
    const id = (await api("GET", "/api/v1/profiles")).json().find((p: { externalProfileId: string }) => p.externalProfileId === "shop-2").id;
    expect(await profile(id)).toMatchObject({ status: "AVAILABLE", assignable: true, agentConnection: "ONLINE" });

    agent.stop();
    const offline = await until("agent offline", () => profile(id), (p) => p.agentConnection === "OFFLINE");
    expect(offline).toMatchObject({ status: "AVAILABLE", assignable: false });
    const verify = await api("POST", `/api/v1/profiles/${id}/verify`);
    expect(verify.statusCode).toBe(409);
    expect(verify.json().error.code).toBe("AGENT_UNAVAILABLE");
    expect((await profile(id)).status).toBe("AVAILABLE");

    agent = connect();
    expect(await until("assignable again", () => profile(id), (p) => p.assignable)).toMatchObject({ status: "AVAILABLE", agentConnection: "ONLINE" });
  });
});
