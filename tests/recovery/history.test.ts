// Run history outlives agent disconnects, Control Plane restarts and agent disable/revoke.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 };
const work = mkdtempSync(join(tmpdir(), "bap-history-"));
const store = memoryStore();

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let port: number;
let cookie: string;
let agent: RunningAgent | null = null;
let site: Awaited<ReturnType<typeof startTestSite>>;

const startControlPlane = async () => {
  app = buildApp({ db, store, secureCookies: false, fleet: FLEET });
  port = Number(new URL(await app.listen({ host: "127.0.0.1", port: port ?? 0 })).port);
};
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

/** Everything the operator sees about a run: status, transitions, steps and the screenshot bytes. */
async function history(runId: string) {
  const run = (await api("GET", `/api/v1/runs/${runId}`)).json();
  const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json() as { stepId: string; status: string; screenshotArtifactId: string }[];
  const screenshots = await Promise.all(steps.map(async (s) => (await api("GET", `/api/v1/runs/${runId}/artifacts/${s.screenshotArtifactId}/content`)).rawPayload.toString("base64")));
  return { status: run.status, agentId: run.agentId, transitions: run.transitions, steps, screenshots };
}

beforeAll(async () => {
  site = await startTestSite();
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  await startControlPlane();
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const manifest = await buildScenarioBundle(resolve(import.meta.dirname, "../../scenarios/staging-smoke-test/index.ts"), join(work, "bundles"));
  await store.put("smoke.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await api("POST", "/api/v1/scenarios/staging-smoke-test/versions", { version: manifest.version, sha256: manifest.sha256, bundleKey: "smoke.mjs" });
}, 120_000);

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});

test("[REQ-RUN-011][REQ-DB-002] run history survives the agent going away, a Control Plane restart, and the agent being disabled and revoked", async () => {
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-history", platform: "darwin", architecture: "arm64" } })).json();
  const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
  provider.createProfile("p1");
  const connect = () => (agent = startAgent({ serverUrl: `http://127.0.0.1:${port}`, agentKey, provider, providerName: "local-chromium", maxSessions: 1, dataDir: join(work, "agent"), log: () => {} }));
  connect();
  await until("agent online", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.maxSessions === 1);
  const profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "p1", name: "P1" })).json().id;
  const { runId } = (await api("POST", "/api/v1/runs", { scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url } })).json();
  const before = await until("run finished", () => history(runId), (h) => h.status === "SUCCEEDED");
  expect(before.steps).toHaveLength(3);

  // The agent disconnects: it is OFFLINE and the history stays.
  agent!.stop();
  await until("agent offline", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.connection === "OFFLINE");
  expect(await history(runId)).toEqual(before);

  // The Control Plane restarts on the same database: same history, and the agent reconnects.
  await app.close();
  await startControlPlane();
  expect(await history(runId)).toEqual(before);
  connect();
  await until("agent back online", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.connection === "ONLINE");

  // Disable, then revoke: still the same history, attributed to the same agent.
  await api("POST", `/api/v1/agents/${agentId}/disable`);
  await api("POST", `/api/v1/agents/${agentId}/revoke`);
  expect(await history(runId)).toEqual(before);
  expect((await api("GET", "/api/v1/runs")).json().map((r: { id: string }) => r.id)).toContain(runId);
  expect((await api("GET", `/api/v1/profiles/${profileId}`)).statusCode).toBe(200);
}, 120_000);

test("[REQ-DB-002] no foreign key deletes history together with an agent, profile or run", async () => {
  const rules = await sql<{ table_name: string; referenced: string; delete_rule: string }>`
    SELECT tc.table_name, ccu.table_name AS referenced, rc.delete_rule FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.constraint_name
    WHERE tc.table_schema = 'public' AND ccu.table_name IN ('agents', 'profiles', 'runs')`.execute(db);
  expect(rules.rows.length).toBeGreaterThan(5);
  expect(rules.rows.filter((r) => r.delete_rule === "CASCADE" || r.delete_rule === "SET NULL")).toEqual([]);
});
