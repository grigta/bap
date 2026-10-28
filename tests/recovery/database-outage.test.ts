// PostgreSQL goes away under a working Control Plane and comes back (PRD §13.2).
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { outageProxy } from "../support/outage-proxy.ts";
import { startTestSite } from "../support/test-site.ts";

const work = mkdtempSync(join(tmpdir(), "bap-db-outage-"));
const store = memoryStore();

let postgres: StartedPostgreSqlContainer;
let pgProxy: ReturnType<typeof outageProxy>;
let db: Db;
let app: App;
let cookie: string;
let agent: RunningAgent;
let site: Awaited<ReturnType<typeof startTestSite>>;

const api = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: { bap_session: cookie }, headers: url === "/api/v1/runs" && method === "POST" ? { "idempotency-key": randomUUID() } : {} });

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

beforeAll(async () => {
  site = await startTestSite();
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  // The Control Plane reaches PostgreSQL only through a proxy the test can cut.
  pgProxy = outageProxy(postgres.getMappedPort(5432));
  const url = new URL(postgres.getConnectionUri());
  url.host = `127.0.0.1:${await pgProxy.listen()}`;
  db = createDb(url.toString());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store, secureCookies: false, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 } });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;

  const manifest = await buildScenarioBundle(resolve(import.meta.dirname, "../fixtures/scenarios/slow-page/index.ts"), join(work, "bundles"));
  await store.put("slow.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await api("POST", "/api/v1/scenarios/slow-page/versions", { version: manifest.version, sha256: manifest.sha256, bundleKey: "slow.mjs" });
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-db", platform: "darwin", architecture: "arm64" } })).json();
  const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
  provider.createProfile("p1");
  agent = startAgent({ serverUrl: baseUrl, agentKey, provider, providerName: "local-chromium", maxSessions: 1, dataDir: join(work, "agent"), log: () => {} });
}, 120_000);

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await pgProxy?.close();
  await postgres?.stop();
  await site?.stop();
});

test("[REQ-RUN-011] while PostgreSQL is down the API answers 503 quickly and the panel can tell; afterwards the run caught by the outage completes", async () => {
  const agentId = (await until("agent", async () => (await api("GET", "/api/v1/agents")).json(), (a) => a[0]?.maxSessions === 1))[0].id;
  const profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "p1", name: "P1" })).json().id;
  expect((await api("GET", "/api/v1/health")).json()).toEqual({ status: "ok", database: "up" });
  const { runId } = (await api("POST", "/api/v1/runs", { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms: 2500 } })).json();
  await until("run started", async () => (await api("GET", `/api/v1/runs/${runId}`)).json(), (r) => r.status === "RUNNING");

  pgProxy.down();
  const started = Date.now();
  const runs = await api("GET", "/api/v1/runs");
  expect(Date.now() - started).toBeLessThan(6000);
  expect(runs.statusCode).toBe(503);
  expect(runs.json().error.code).toBe("DATABASE_UNAVAILABLE");
  const health = await api("GET", "/api/v1/health");
  expect(health.statusCode).toBe(503);
  expect(health.json()).toEqual({ status: "degraded", database: "down" });
  await sleep(4000); // the run finishes on the agent while its events cannot be stored

  pgProxy.up();
  await until("database back", async () => (await api("GET", "/api/v1/health")).statusCode, (s) => s === 200);
  const done = await until("run finished", async () => (await api("GET", `/api/v1/runs/${runId}`)).json(), (r) => r.status === "SUCCEEDED", 30_000);
  expect(done.transitions.map((t: { to: string }) => t.to)).toEqual(["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "SUCCEEDED"]);
  expect((await api("GET", `/api/v1/runs/${runId}/steps`)).json()).toHaveLength(1);

  // New work goes through as before.
  const next = (await api("POST", "/api/v1/runs", { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms: 10 } })).json();
  expect((await until("next run", async () => (await api("GET", `/api/v1/runs/${next.runId}`)).json(), (r) => r.status === "SUCCEEDED")).status).toBe("SUCCEEDED");
}, 120_000);
