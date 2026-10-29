// S14: a warm-up session in a real browser against a stand-in search engine (tests/fixtures/farm-site),
// and the scheduler that lets a profile go to recipes only after enough of them.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { CheckpointStore, buildScenarioBundle, runScenario } from "@bap/engine";
import { type FarmInput, type Recipe, farmScenario } from "@bap/recipe";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

let site: Awaited<ReturnType<typeof startTestSite>>;
const provider = new LocalChromiumProvider({ profilesDir: mkdtempSync(join(tmpdir(), "bap-farm-profiles-")) });

interface Log {
  hits: { server: string; path: string; referer: string | null; at: number }[];
  reads: { site: string; scrolls: number; maxY: number; ms: number }[];
}
const log = async (): Promise<Log> => (await fetch(`${site.url}/log`)).json() as Promise<Log>;

let profiles = 0;
async function farm(input: Partial<FarmInput> = {}) {
  const profile = `warm-${++profiles}`;
  provider.createProfile(profile);
  const params = { query: "бухгалтерия для ИП", sites: 3, dwellSeconds: 3, searchUrl: `${site.url}/`, ...input };
  return runScenario({ scenario: farmScenario(params), input: params, provider, profileId: profile, runId: crypto.randomUUID(), agentId: "farm", artifactsDir: mkdtempSync(join(tmpdir(), "bap-farm-run-")), checkpoints: new CheckpointStore(":memory:"), timeoutMs: 120_000 });
}

beforeAll(async () => {
  site = await startTestSite("farm-site");
});
afterAll(() => site?.stop());
beforeEach(async () => {
  await fetch(`${site.url}/log`, { method: "DELETE" });
});

describe("warm-up session", () => {
  test("[REQ-FARM-001] searches, opens three different sites from the results by clicking, reads each by scrolling for the set time", async () => {
    const result = await farm();
    expect(result.status, result.errorMessage).toBe("SUCCEEDED");
    const { hits } = await log();
    const search = hits.find((h) => h.server === "search" && h.path.startsWith("/search?"));
    expect(decodeURIComponent(search!.path.replace(/\+/g, " "))).toContain("q=бухгалтерия для ИП");
    const opened = hits.filter((h) => h.server.startsWith("site"));
    expect(new Set(opened.map((h) => h.server)).size).toBe(3);
    expect(opened).toHaveLength(3);
    // Came from the results page, like a click does.
    for (const h of opened) expect(h.referer).toMatch(new RegExp(`^${site.url}/`));
    expect(hits.some((h) => h.server === "ad")).toBe(false);
    // Each site reports it was scrolled, and was read for at least the set time.
    // The last page reports on pagehide: under load its beacon may come a little later.
    await expect.poll(async () => (await log()).reads.length, { timeout: 10_000 }).toBe(3);
    for (const r of (await log()).reads) {
      expect(r.scrolls, r.site).toBeGreaterThan(0);
      expect(r.maxY, r.site).toBeGreaterThan(0);
      expect(r.ms, r.site).toBeGreaterThanOrEqual(3000);
    }
    expect(result.steps.map((s) => s.note).slice(2).every((n) => /127\.0\.0\.1:\d+: \d+ с, прокруток \d+/.test(n ?? ""))).toBe(true);
  });

  test("[REQ-FARM-002] accepts the search engine's cookie consent first", async () => {
    const result = await farm({ sites: 1, searchUrl: `${site.url}/consent` });
    expect(result.status, result.errorMessage).toBe("SUCCEEDED");
    expect(result.steps[0]!.note).toBe("согласие на cookie: «Принять все»");
    expect((await log()).hits.filter((h) => h.server.startsWith("site"))).toHaveLength(1);
    // Google's own dialog in a language not in any list: found by the button's id.
    const finnish = await farm({ sites: 1, searchUrl: `${site.url}/fi` });
    expect(finnish.status, finnish.errorMessage).toBe("SUCCEEDED");
    expect(finnish.steps[0]!.note).toBe("согласие на cookie: «Hyväksy kaikki»");
  });

  test("[REQ-FARM-002] a captcha ends the session with FARM_CAPTCHA; too few results with FARM_TOO_FEW_SITES", async () => {
    const captcha = await farm({ searchUrl: `${site.url}/sorry/` });
    expect(captcha).toMatchObject({ status: "FAILED", errorCode: "FARM_CAPTCHA" });
    const few = await farm({ query: "мало сайтов", sites: 2 });
    expect(few).toMatchObject({ status: "FAILED", errorCode: "FARM_TOO_FEW_SITES" });
    expect((await log()).hits.filter((h) => h.server.startsWith("site"))).toHaveLength(1);
  });
});

describe("admission to recipes", () => {
  const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
  const work = mkdtempSync(join(tmpdir(), "bap-farming-"));
  const agentProvider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
  let postgres: StartedPostgreSqlContainer;
  let db: Db;
  let app: App;
  let cookie: string;
  let agent: RunningAgent;
  let agentId: string;
  const api = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { bap_session: cookie }, headers: url === "/api/v1/runs" ? { "idempotency-key": randomUUID() } : {} });
  const runView = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
  const profileView = async (id: string) => (await api("GET", `/api/v1/profiles/${id}`)).json();
  const farms = async (profileId: string) => (await db.selectFrom("runs").select(["id", "status", "error_code"]).where("profile_id", "=", profileId).where("kind", "=", "farm").orderBy("created_at").execute());
  async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await read();
      if (ok(value)) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
      await sleep(150);
    }
  }
  const settings = (over: object = {}) => ({ queries: ["бухгалтерия для ИП", "учёт малого бизнеса"], requiredWarmups: 2, sites: 1, dwellSeconds: 1, searchUrl: `${site.url}/`, ...over });
  let profiles = 0;
  const newProfile = async () => {
    const name = `cold-${++profiles}`;
    agentProvider.createProfile(name);
    return (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: name, name })).json().id as string;
  };
  const recipeRun = async (profileId: string) => (await api("POST", "/api/v1/runs", { scenarioId: "open-site", scenarioVersion: "1.0.0", profileId, input: {} })).json().runId as string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDb(postgres.getConnectionUri());
    await migrateToLatest(db);
    await ensureOperator(db, "operator", "pw");
    const store = memoryStore();
    app = buildApp({ db, store, secureCookies: false, fleet: FLEET, scheduler: { leaseTtlMs: 5000, acceptTimeoutMs: 5000, tickMs: 200 } });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
    const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
    const enrolled = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-farm", platform: "darwin", architecture: "arm64" } })).json();
    agentId = enrolled.agentId;
    agent = startAgent({ serverUrl: baseUrl, agentKey: enrolled.agentKey, provider: agentProvider, providerName: "local-chromium", maxSessions: 2, dataDir: join(work, "agent"), log: () => {} });
    await until("agent ready", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.heartbeat?.lsAvailable === true);
    const recipe: Recipe = { schema: 1, goal: "Открыть сайт", startUrl: `${site.url}/`, inputs: [], steps: [{ id: "s01", intent: "Открыть сайт", action: "navigate", value: `${site.url}/`, mutating: false }] };
    expect((await api("POST", "/api/v1/recipes/open-site/versions", recipe)).statusCode).toBe(201);
    await api("POST", "/api/v1/recipes/open-site/versions/1.0.0/publish");
    const repo = resolve(import.meta.dirname, "../..");
    const manifest = await buildScenarioBundle(join(repo, "tests/fixtures/scenarios/slow-page/index.ts"), join(work, "bundles"));
    await store.put("slow.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
    await api("POST", "/api/v1/scenarios/slow-page/versions", { version: "1.0.0", sha256: manifest.sha256, bundleKey: "slow.mjs" });
  }, 180_000);
  afterAll(async () => {
    agent?.stop();
    await app?.close();
    await db?.destroy();
    await postgres?.stop();
  });

  test("[REQ-FARM-005] warm-up settings are checked; defaults until the operator sets them", async () => {
    expect((await api("GET", "/api/v1/farming/settings")).json()).toMatchObject({ requiredWarmups: 3, sites: 3, dwellSeconds: 40, searchUrl: "https://www.google.com/" });
    for (const bad of [{ queries: [] }, { queries: [" "] }, { requiredWarmups: 11 }, { sites: 0 }, { dwellSeconds: 601 }, { searchUrl: "ftp://example.com/" }])
      expect((await api("PUT", "/api/v1/farming/settings", settings(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await api("PUT", "/api/v1/farming/settings", settings())).json()).toEqual(settings());
    expect((await api("GET", "/api/v1/farming/settings")).json()).toEqual(settings());
  });

  test("[REQ-FARM-003] a recipe on a cold profile waits; warm-ups are queued one at a time; after the threshold the recipe runs", async () => {
    const profileId = await newProfile();
    const runId = await recipeRun(profileId);
    expect((await until("waiting for warm-up", () => runView(runId), (r) => r.queueReason === "PROFILE_WARMING")).status).toBe("QUEUED");
    await until("recipe done", () => runView(runId), (r) => r.status === "SUCCEEDED");
    const done = await farms(profileId);
    expect(done.map((f) => f.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(await profileView(profileId)).toMatchObject({ warmups: 2, warmupFailures: 0 });
    // The recipe started only after the second warm-up had finished.
    const finishedFarm = (await db.selectFrom("runs").select("finished_at").where("id", "=", done[1]!.id).executeTakeFirstOrThrow()).finished_at!;
    expect((await db.selectFrom("runs").select("started_at").where("id", "=", runId).executeTakeFirstOrThrow()).started_at!.getTime()).toBeGreaterThanOrEqual(finishedFarm.getTime());
    // Admitted: the next recipe goes straight away, no more warm-ups.
    const again = await recipeRun(profileId);
    await until("second recipe", () => runView(again), (r) => r.status === "SUCCEEDED");
    expect(await farms(profileId)).toHaveLength(2);
  });

  test("[REQ-FARM-003] code scenarios need no warm-up; a cancelled warm-up does not count", async () => {
    const profileId = await newProfile();
    const bundle = (await api("POST", "/api/v1/runs", { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms: 10 } })).json().runId;
    await until("bundle run", () => runView(bundle), (r) => r.status === "SUCCEEDED");
    expect(await farms(profileId)).toHaveLength(0);
    await until("profile free", () => profileView(profileId), (p) => p.status === "AVAILABLE");
    const manual = (await api("POST", `/api/v1/profiles/${profileId}/farm`)).json().runId;
    await api("POST", `/api/v1/runs/${manual}/cancel`);
    await until("warm-up cancelled", () => runView(manual), (r) => r.status === "CANCELLED");
    expect(await profileView(profileId)).toMatchObject({ warmups: 0, warmupFailures: 0 });
  });

  test("[REQ-FARM-004] three failed warm-ups in a row send the profile to review; releasing it resets the count", async () => {
    await api("PUT", "/api/v1/farming/settings", settings({ searchUrl: `${site.url}/sorry/` }));
    const profileId = await newProfile();
    const runId = await recipeRun(profileId);
    const reviewed = await until("profile to review", () => profileView(profileId), (p) => p.status === "NEEDS_REVIEW");
    expect(reviewed).toMatchObject({ warmups: 0, warmupFailures: 3, lastError: expect.stringMatching(/^warm-up failed 3 times in a row; last: FARM_CAPTCHA/) });
    expect((await farms(profileId)).map((f) => f.error_code)).toEqual(["FARM_CAPTCHA", "FARM_CAPTCHA", "FARM_CAPTCHA"]);
    // The next scheduler pass gives the recipe its new reason.
    await until("recipe waits for review", () => runView(runId), (r) => r.status === "QUEUED" && r.queueReason === "PROFILE_NEEDS_REVIEW");
    // The search engine lets us in again; the operator releases the profile and the recipe goes on.
    await api("PUT", "/api/v1/farming/settings", settings());
    expect((await api("POST", `/api/v1/profiles/${profileId}/release-review`)).json()).toMatchObject({ warmupFailures: 0 });
    await until("recipe done after release", () => runView(runId), (r) => r.status === "SUCCEEDED");
    expect(await profileView(profileId)).toMatchObject({ warmups: 2, warmupFailures: 0 });
  });
});
