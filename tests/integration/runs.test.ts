import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { AGENT_SOCKET_PATH, message } from "@bap/protocol";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { purgeArtifacts } from "../../apps/control-plane/src/retention.ts";
import { type ObjectStore, memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const repo = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "bap-runs-"));
const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let store: ObjectStore;
let baseUrl: string;
let cookie: string;
let agentId: string;
let agentKey: string;
let agent: RunningAgent | null = null;
let profileId: string;
let site: Awaited<ReturnType<typeof startTestSite>>;

const api = (method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers, cookies: { bap_session: cookie } });
const createRun = (body: object, key: string = randomUUID()) => api("POST", "/api/v1/runs", body, { "idempotency-key": key });
const run = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
const connectAgent = () => (agent = startAgent({ serverUrl: baseUrl, agentKey, provider, providerName: "local-chromium", maxSessions: 2, dataDir: join(work, "agent"), log: (l) => process.env.BAP_TEST_AGENT_LOG && console.log(`[runs-agent] ${l}`) }));

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}
const finished = (id: string) => until(`run ${id} to finish`, () => run(id), (r) => ["SUCCEEDED", "FAILED", "NEEDS_REVIEW"].includes(r.status));

async function publish(entry: string) {
  const manifest = await buildScenarioBundle(entry, join(work, "bundles"));
  const key = `scenarios/${manifest.file}`;
  await store.put(key, readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  const res = await api("POST", `/api/v1/scenarios/${manifest.id}/versions`, { version: manifest.version, sha256: manifest.sha256, bundleKey: key });
  expect(res.statusCode).toBe(201);
  return { ...manifest, key };
}

beforeAll(async () => {
  site = await startTestSite();
  provider.createProfile("p1");
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  store = memoryStore();
  app = buildApp({ db, store, secureCookies: false, fleet: FLEET });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  ({ agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-runs", platform: "darwin", architecture: "arm64" } })).json());
  connectAgent();
  await until("agent capabilities", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.maxSessions === 2);
  profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "p1", name: "P1" })).json().id;
  await publish(join(repo, "scenarios/staging-smoke-test/index.ts"));
  for (const name of ["slow-page", "slow-order", "crash-page"]) await publish(join(repo, "tests/fixtures/scenarios", name, "index.ts"));
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});

const smoke = () => ({ scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url } });

describe("happy path", () => {
  test("[REQ-RUN-001][REQ-ARCH-001][REQ-PROF-009][REQ-RUN-009][REQ-SEC-009] a run goes QUEUED→…→SUCCEEDED on the profile's agent, journalled, with a screenshot per step only operators can read", async () => {
    const created = await createRun(smoke());
    expect(created.statusCode).toBe(202);
    const { runId } = created.json();
    const done = await finished(runId);
    expect(done).toMatchObject({ status: "SUCCEEDED", agentId, profileId, errorCode: null });
    expect(done.transitions.map((t: { from: string | null; to: string }) => `${t.from ?? "∅"}→${t.to}`)).toEqual([
      "∅→QUEUED",
      "QUEUED→ASSIGNED",
      "ASSIGNED→ACCEPTED",
      "ACCEPTED→RUNNING",
      "RUNNING→SUCCEEDED",
    ]);

    const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json();
    expect(steps.map((s: { stepId: string; status: string }) => [s.stepId, s.status])).toEqual([
      ["open-home", "passed"],
      ["open-wizard", "passed"],
      ["open-orders", "passed"],
    ]);
    for (const s of steps) {
      const png = await api("GET", `/api/v1/runs/${runId}/artifacts/${s.screenshotArtifactId}/content`);
      expect(png.headers["content-type"]).toBe("image/png");
      expect(png.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    }
    expect((await api("GET", `/api/v1/runs/${runId}/artifacts`)).json()).toHaveLength(3);
    // [REQ-SEC-009] Only an operator reads artifacts: not anonymous callers, not agent keys.
    const content = `/api/v1/runs/${runId}/artifacts/${steps[0].screenshotArtifactId}/content`;
    expect((await app.inject({ method: "GET", url: content })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: content, headers: { authorization: `Bearer ${agentKey}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts`, headers: { authorization: `Bearer ${agentKey}` } })).statusCode).toBe(401);
    // After the run the profile passes VERIFYING: the agent confirms the browser let go of it.
    expect(await until("profile verified", async () => (await api("GET", `/api/v1/profiles/${profileId}`)).json(), (p) => p.status !== "VERIFYING")).toMatchObject({ status: "AVAILABLE", activeRunId: null });
    expect((await api("GET", "/api/v1/runs?status=SUCCEEDED")).json().map((r: { id: string }) => r.id)).toContain(runId);
  });

  test("[REQ-RUN-001] events that do not fit the current status, or come from another agent, change nothing", async () => {
    const { runId } = (await createRun({ scenarioId: "crash-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url } })).json();
    const failed = await finished(runId);
    expect(failed.status).toBe("FAILED");

    const sendAs = async (key: string) => {
      const ws = new WebSocket(baseUrl.replace("http", "ws") + AGENT_SOCKET_PATH, { headers: { authorization: `Bearer ${key}` } });
      await new Promise((r) => ws.once("open", r));
      const replies: unknown[] = [];
      ws.on("message", (m) => replies.push(JSON.parse(String(m))));
      ws.send(JSON.stringify(message({ type: "agent.hello", payload: { agentVersion: "t", platform: "darwin", architecture: "arm64" } })));
      ws.send(JSON.stringify({ ...message({ type: "run.completed", payload: { runId } }), seq: 1 }));
      await until("ack", async () => replies.length, (n) => n >= 2);
      ws.close();
    };
    await sendAs(agentKey);
    const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
    const stranger = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-stranger", platform: "darwin", architecture: "arm64" } })).json();
    await sendAs(stranger.agentKey);

    const after = await run(runId);
    expect(after.status).toBe("FAILED");
    expect(after.transitions).toEqual(failed.transitions);
  });

  test("a run created while the agent is away waits in QUEUED and starts when it connects", async () => {
    agent!.stop();
    await until("agent offline", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.connection === "OFFLINE");
    const { runId, status, assignedAgentId } = (await createRun(smoke())).json();
    expect({ status, assignedAgentId }).toEqual({ status: "QUEUED", assignedAgentId: null });
    await sleep(500);
    expect((await run(runId)).status).toBe("QUEUED");
    connectAgent();
    expect((await finished(runId)).status).toBe("SUCCEEDED");
  });
});

describe("retention", () => {
  test("[REQ-SEC-010] artifacts of finished runs older than the retention period are deleted from storage, then from the journal", async () => {
    const { runId } = (await createRun(smoke())).json();
    await finished(runId);
    const artifacts = await db.selectFrom("artifacts").select(["id", "storage_key"]).where("run_id", "=", runId).execute();
    expect(artifacts).toHaveLength(3);

    // Fresh artifacts are kept.
    await purgeArtifacts(db, store, new Date(Date.now() - 60_000));
    expect((await api("GET", `/api/v1/runs/${runId}/artifacts`)).json()).toHaveLength(3);

    // A run that has not finished keeps its artifacts however old they are.
    agent?.stop();
    const { runId: queuedId } = (await createRun(smoke())).json();
    await store.put(`runs/${queuedId}/old.png`, Buffer.from("png"), "image/png");
    await db.insertInto("artifacts").values({ run_id: queuedId, name: "old.png", content_type: "image/png", size_bytes: 3, sha256: "x", storage_key: `runs/${queuedId}/old.png`, created_at: new Date(0) }).execute();

    const purged = await purgeArtifacts(db, store, new Date(Date.now() + 1000));
    expect(purged).toBeGreaterThanOrEqual(3);
    for (const a of artifacts) expect(await store.get(a.storage_key)).toBeNull();
    expect((await api("GET", `/api/v1/runs/${runId}/artifacts`)).json()).toEqual([]);
    expect((await api("GET", `/api/v1/runs/${runId}/artifacts/${artifacts[0]!.id}/content`)).statusCode).toBe(404);
    // The step journal stays; only the screenshot reference is gone.
    const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json();
    expect(steps.map((s: { status: string; screenshotArtifactId: string | null }) => [s.status, s.screenshotArtifactId])).toEqual([["passed", null], ["passed", null], ["passed", null]]);
    expect(await store.get(`runs/${queuedId}/old.png`)).not.toBeNull();
    expect((await api("GET", `/api/v1/runs/${queuedId}/artifacts`)).json()).toHaveLength(1);

    connectAgent();
    await finished(queuedId);
  });
});

describe("idempotency and validation", () => {
  test("[REQ-API-005] the same key and body return the same run; another body with that key is a conflict", async () => {
    const key = randomUUID();
    const first = (await createRun(smoke(), key)).json();
    const again = await createRun(smoke(), key);
    expect(again.statusCode).toBe(202);
    expect(again.json().runId).toBe(first.runId);
    const rows = await db.selectFrom("idempotency_keys").select("run_id").where("key", "=", key).execute();
    expect(rows).toEqual([{ run_id: first.runId }]);

    const other = await createRun({ ...smoke(), timeoutMs: 5000 }, key);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const missing = await api("POST", "/api/v1/runs", smoke());
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await finished(first.runId);
  });

  test("[REQ-RUN-008] an unregistered scenario version is rejected and nothing reaches the agent", async () => {
    const before = await db.selectFrom("runs").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow();
    const res = await createRun({ ...smoke(), scenarioVersion: "9.9.9" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SCENARIO_VERSION_MISMATCH");
    expect(await db.selectFrom("runs").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()).toEqual(before);
  });

  test("[REQ-RUN-008] registered versions are immutable and must match the stored bundle", async () => {
    const versions = (await api("GET", "/api/v1/scenarios/staging-smoke-test/versions")).json();
    expect(versions).toEqual([{ version: "1.0.0", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: expect.any(String) }]);
    const same = await api("POST", "/api/v1/scenarios/staging-smoke-test/versions", { version: "1.0.0", sha256: versions[0].sha256, bundleKey: "scenarios/staging-smoke-test@1.0.0.mjs" });
    expect(same.statusCode).toBe(200);
    await store.put("scenarios/other.mjs", Buffer.from("export default 1"), "text/javascript");
    const other = await api("POST", "/api/v1/scenarios/staging-smoke-test/versions", { version: "1.0.0", sha256: "a".repeat(64), bundleKey: "scenarios/other.mjs" });
    expect(other.json().error.code).toBe("BUNDLE_CHECKSUM_MISMATCH");
    const otherSha = createHash("sha256").update("export default 1").digest("hex");
    const changed = await api("POST", "/api/v1/scenarios/staging-smoke-test/versions", { version: "1.0.0", sha256: otherSha, bundleKey: "scenarios/other.mjs" });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("SCENARIO_VERSION_EXISTS");
    expect((await api("GET", "/api/v1/scenarios")).json().map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["staging-smoke-test", "slow-page"]));
  });

  test("[REQ-API-006] errors use one body shape with a stable code and the request id", async () => {
    const responses = [
      await createRun({ ...smoke(), scenarioVersion: "0.0.1" }),
      await api("GET", `/api/v1/runs/${randomUUID()}`),
      await app.inject({ method: "GET", url: "/api/v1/runs" }),
      await api("POST", "/api/v1/runs", { nonsense: true }, { "idempotency-key": randomUUID() }),
    ];
    expect(responses.map((r) => r.json().error.code)).toEqual(["SCENARIO_VERSION_MISMATCH", "NOT_FOUND", "UNAUTHORIZED", "VALIDATION_ERROR"]);
    for (const r of responses) expect(r.json()).toEqual({ error: { code: expect.any(String), message: expect.any(String), requestId: r.headers["x-request-id"] ?? expect.any(String) } });
  });
});

describe("failures", () => {
  test("[REQ-RUN-002] a read step that outlives timeoutMs fails the run with TIMEOUT", async () => {
    const { runId } = (await createRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms: 5000 }, timeoutMs: 1500 })).json();
    const done = await finished(runId);
    expect(done).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT" });
    expect((await until("profile verified", async () => (await api("GET", `/api/v1/profiles/${profileId}`)).json(), (p) => p.status !== "VERIFYING")).status).toBe("AVAILABLE");
  });

  test("[REQ-RUN-002] a mutating step that times out unconfirmed goes to NEEDS_REVIEW and blocks the profile", async () => {
    const { runId } = (await createRun({ scenarioId: "slow-order", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url }, timeoutMs: 1500 })).json();
    expect(await finished(runId)).toMatchObject({ status: "NEEDS_REVIEW", errorCode: "TIMEOUT" });
    const profile = (await api("GET", `/api/v1/profiles/${profileId}`)).json();
    expect(profile).toMatchObject({ status: "NEEDS_REVIEW", activeRunId: null });
    expect(profile.lastError).toContain(runId);
    const blocked = await createRun(smoke());
    expect(blocked.json().error.code).toBe("PROFILE_NEEDS_REVIEW");
    await api("POST", `/api/v1/profiles/${profileId}/release-review`);
  });

  test("a failing page ends FAILED with the failing step, its error and screenshot", async () => {
    const { runId } = (await createRun({ scenarioId: "crash-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url } })).json();
    expect(await finished(runId)).toMatchObject({ status: "FAILED", errorCode: "STEP_FAILED" });
    const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json();
    expect(steps.map((s: { stepId: string; status: string }) => [s.stepId, s.status])).toEqual([
      ["open-crash", "passed"],
      ["expect-orders", "failed"],
    ]);
    expect(steps[1].error).toMatch(/Timeout 1000ms exceeded/);
    expect(steps[1].screenshotArtifactId).not.toBeNull();
  });

  test("[REQ-SEC-006] the agent refuses a bundle whose bytes no longer match the registered sha256", async () => {
    await store.put("scenarios/slow-page@1.0.0.mjs", Buffer.from("export default {}"), "text/javascript");
    // The agent caches bundles by checksum; drop the cache so it downloads the tampered bytes.
    rmSync(join(work, "agent", "bundles"), { recursive: true, force: true });
    const { runId } = (await createRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms: 10 } })).json();
    expect(await finished(runId)).toMatchObject({ status: "FAILED", errorCode: "BUNDLE_CHECKSUM_MISMATCH" });
  });
});
