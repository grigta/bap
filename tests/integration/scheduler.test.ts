import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BrowserProvider, LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { IllegalProfileTransition, PROFILE_TRANSITIONS, canMoveProfile, moveProfile } from "../../apps/control-plane/src/profile-states.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const SCHEDULER = { leaseTtlMs: 1500, acceptTimeoutMs: 2000, tickMs: 200 };
const repo = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "bap-scheduler-"));

/** Wraps a provider to count browser sessions that are really open, per agent and per profile. */
function instrumented(base: LocalChromiumProvider) {
  const open = new Map<string, number>();
  const stats = { current: 0, maxAgent: 0, maxPerProfile: new Map<string, number>(), available: true, leaveBusy: false, stateUnknown: false };
  const provider: BrowserProvider = {
    isAvailable: async () => stats.available && (await base.isAvailable()),
    listProfiles: () => base.listProfiles(),
    profileState: async (id) => {
      if (stats.stateUnknown) throw new Error("Local API returned an unknown session state");
      return stats.leaveBusy ? "busy" : base.profileState(id);
    },
    forceRelease: (id) => base.forceRelease(id),
    openSession: async (id, runId) => {
      const session = await base.openSession(id, runId);
      const attach = session.attach.bind(session);
      const close = session.closeSession.bind(session);
      let counted = false;
      session.attach = async () => {
        await attach();
        counted = true;
        stats.current++;
        open.set(id, (open.get(id) ?? 0) + 1);
        stats.maxAgent = Math.max(stats.maxAgent, stats.current);
        stats.maxPerProfile.set(id, Math.max(stats.maxPerProfile.get(id) ?? 0, open.get(id)!));
      };
      session.closeSession = async () => {
        if (counted) {
          stats.current--;
          open.set(id, open.get(id)! - 1);
          counted = false;
        }
        await close();
      };
      return session;
    },
  };
  return { provider, stats, base };
}

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let baseUrl: string;
let cookie: string;
let site: Awaited<ReturnType<typeof startTestSite>>;

const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: { bap_session: cookie }, headers: method === "POST" && url === "/api/v1/runs" ? { "idempotency-key": randomUUID() } : {} });
const runView = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
const profileView = async (id: string) => (await api("GET", `/api/v1/profiles/${id}`)).json();
const agentView = async (id: string) => (await api("GET", `/api/v1/agents/${id}`)).json();

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}
const FINAL = ["SUCCEEDED", "FAILED", "NEEDS_REVIEW"];
const finished = (id: string) => until(`run ${id}`, () => runView(id), (r) => FINAL.includes(r.status), 60_000);
const idle = (profileId: string) => until("profile idle", () => profileView(profileId), (p) => p.status === "AVAILABLE");

interface Node {
  name: string;
  agentId: string;
  agentKey: string;
  profiles: string[];
  inst: ReturnType<typeof instrumented>;
  running: RunningAgent | null;
  logs: string[];
}

async function node(name: string, profileCount: number): Promise<Node> {
  const inst = instrumented(new LocalChromiumProvider({ profilesDir: join(work, name, "profiles") }));
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name, platform: "darwin", architecture: "arm64" } })).json();
  const n: Node = { name, agentId, agentKey, profiles: [], inst, running: null, logs: [] };
  connect(n);
  await until(`${name} ready`, () => agentView(agentId), (a) => a.maxSessions !== null && a.heartbeat?.lsAvailable === true);
  for (let i = 1; i <= profileCount; i++) {
    inst.base.createProfile(`${name}-p${i}`);
    n.profiles.push((await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: `${name}-p${i}`, name: `${name}-p${i}` })).json().id);
  }
  return n;
}
function connect(n: Node) {
  n.running = startAgent({ serverUrl: baseUrl, agentKey: n.agentKey, provider: n.inst.provider, providerName: "local-chromium", maxSessions: 2, dataDir: join(work, n.name, "data"), log: (l) => n.logs.push(l) });
}
const slow = (profileId: string, ms = 1500) => api("POST", "/api/v1/runs", { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url, ms } });

let a: Node;
let b: Node;

beforeAll(async () => {
  site = await startTestSite();
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  const store = memoryStore();
  app = buildApp({ db, store, secureCookies: false, fleet: FLEET, scheduler: SCHEDULER });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const manifest = await buildScenarioBundle(join(repo, "tests/fixtures/scenarios/slow-page/index.ts"), join(work, "bundles"));
  await store.put("slow.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await api("POST", "/api/v1/scenarios/slow-page/versions", { version: "1.0.0", sha256: manifest.sha256, bundleKey: "slow.mjs" });
  a = await node("mac-a", 3);
  b = await node("mac-b", 2);
}, 180_000);

afterAll(async () => {
  a?.running?.stop();
  b?.running?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});

describe("reservation", () => {
  test("[REQ-PROF-003] profile states change only along the transition table", async () => {
    expect(canMoveProfile("AVAILABLE", "RESERVED")).toBe(true);
    expect(canMoveProfile("IN_USE", "NEEDS_REVIEW")).toBe(false);
    expect(canMoveProfile("DISABLED", "AVAILABLE")).toBe(false);
    const allowed = Object.entries(PROFILE_TRANSITIONS).flatMap(([from, to]) => to.map((t) => `${from}→${t}`));
    expect(allowed).toHaveLength(13);
    await expect(moveProfile(db, a.profiles[0]!, ["AVAILABLE"], "IN_USE")).rejects.toBeInstanceOf(IllegalProfileTransition);
    expect((await profileView(a.profiles[0]!)).status).toBe("AVAILABLE");
  });

  test("[REQ-PROF-006] parallel reservations of one profile: exactly one wins, and the agent never opens it twice", async () => {
    const profileId = b.profiles[0]!;
    b.running!.stop();
    await until("mac-b offline", () => agentView(b.agentId), (x) => x.connection === "OFFLINE");
    const runs: string[] = [];
    for (let i = 0; i < 8; i++) runs.push((await slow(profileId, 300)).json().runId);

    const results = await Promise.all(runs.map((id) => app.internals.coordinator!.reserve(id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const leases = await db.selectFrom("profile_leases").selectAll().where("profile_id", "=", profileId).execute();
    expect(leases).toHaveLength(1);
    expect((await profileView(profileId)).status).toBe("RESERVED");

    // The won reservation was never delivered: after the accept timeout it goes back to the queue (RESERVED → AVAILABLE).
    const winner = runs[results.indexOf(true)]!;
    // Whichever fires first (accept timeout or lease expiry), the unaccepted run is requeued, never left half-assigned.
    await until("unaccepted assignment requeued", () => runView(winner), (r) => r.status === "QUEUED");
    expect((await runView(winner)).transitions.at(-1)).toMatchObject({ from: "ASSIGNED", to: "QUEUED", reason: expect.stringMatching(/accept/) });

    connect(b);
    for (const id of runs) expect((await finished(id)).status).toBe("SUCCEEDED");
    expect(b.inst.stats.maxPerProfile.get("mac-b-p1")).toBe(1);
  }, 120_000);
});

describe("capacity and placement", () => {
  test("[REQ-ARCH-003][REQ-SCHED-001] each agent runs at most its limit; the operator can change the limit", async () => {
    // Profiles of earlier tests may still be verified (slow under load): a busy profile would hide the capacity wait.
    for (const p of a.profiles) await idle(p);
    a.inst.stats.maxAgent = 0;
    const first = await Promise.all(a.profiles.map((p) => slow(p, 1500).then((r) => r.json().runId as string)));
    const waiting = await until("third run waits for a slot", () => Promise.all(first.map(runView)), (rs) => rs.some((r) => r.queueReason === "AGENT_AT_CAPACITY"));
    expect(waiting.filter((r) => r.queueReason === "AGENT_AT_CAPACITY")).toHaveLength(1);
    for (const id of first) await finished(id);
    expect(a.inst.stats.maxAgent).toBe(2);

    expect((await api("PATCH", `/api/v1/agents/${a.agentId}`, { sessionLimit: 1 })).json()).toMatchObject({ sessionLimit: 1, maxSessions: 1, reportedMaxSessions: 2 });
    for (const p of a.profiles) await idle(p);
    a.inst.stats.maxAgent = 0;
    const second = await Promise.all(a.profiles.map((p) => slow(p, 500).then((r) => r.json().runId as string)));
    for (const id of second) await finished(id);
    expect(a.inst.stats.maxAgent).toBe(1);
    await api("PATCH", `/api/v1/agents/${a.agentId}`, { sessionLimit: null });
  }, 120_000);

  test("[REQ-ARCH-002] a failed node does not stop the others", async () => {
    b.running!.stop();
    await until("mac-b offline", () => agentView(b.agentId), (x) => x.connection === "OFFLINE");
    const onB = (await slow(b.profiles[1]!, 100)).json().runId;
    const onA = (await slow(a.profiles[0]!, 100)).json().runId;
    expect((await finished(onA)).status).toBe("SUCCEEDED");
    expect(await runView(onB)).toMatchObject({ status: "QUEUED", queueReason: "AGENT_UNAVAILABLE" });
    connect(b);
    expect((await finished(onB)).status).toBe("SUCCEEDED");
  }, 60_000);

  test("[REQ-LS-006] when the Local API stops answering, the node gets no new runs", async () => {
    b.inst.stats.available = false;
    await until("heartbeat reports LS down", () => agentView(b.agentId), (x) => x.heartbeat?.lsAvailable === false);
    const run = (await slow(b.profiles[0]!, 100)).json().runId;
    await until("queued for the provider", () => runView(run), (r) => r.queueReason === "PROVIDER_UNAVAILABLE");
    b.inst.stats.available = true;
    expect((await finished(run)).status).toBe("SUCCEEDED");
  }, 60_000);
});

describe("drain", () => {
  test("[REQ-SCHED-002] a drained agent finishes its run and gets no new ones until activated", async () => {
    const running = (await slow(a.profiles[0]!, 2000)).json().runId;
    await until("running", () => runView(running), (r) => r.status === "RUNNING");
    expect((await api("POST", `/api/v1/agents/${a.agentId}/drain`)).json().status).toBe("DRAINING");
    const next = (await slow(a.profiles[1]!, 100)).json().runId;
    expect(await finished(running)).toMatchObject({ status: "SUCCEEDED", errorCode: null });
    expect(await runView(next)).toMatchObject({ status: "QUEUED", queueReason: "AGENT_DRAINING" });
    expect(a.logs).toContain("drained: finishing current runs, no new ones");

    expect((await api("POST", `/api/v1/agents/${a.agentId}/activate`)).json().status).toBe("ACTIVE");
    expect(await finished(next)).toMatchObject({ status: "SUCCEEDED", errorCode: null });
  }, 60_000);
});

describe("after a run", () => {
  test("[REQ-PROF-004] VERIFYING releases the profile only when the agent confirms the browser let go", async () => {
    const ok = (await slow(a.profiles[2]!, 100)).json().runId;
    await finished(ok);
    expect(await idle(a.profiles[2]!)).toMatchObject({ status: "AVAILABLE", activeRunId: null });
    expect(await db.selectFrom("profile_leases").selectAll().where("profile_id", "=", a.profiles[2]!).execute()).toEqual([]);

    a.inst.stats.leaveBusy = true;
    const stuck = (await slow(a.profiles[2]!, 100)).json().runId;
    await finished(stuck);
    const reviewed = await until("needs review", () => profileView(a.profiles[2]!), (p) => p.status === "NEEDS_REVIEW");
    expect(reviewed.lastError).toBe("The browser still holds the profile after the run");
    a.inst.stats.leaveBusy = false;
    await api("POST", `/api/v1/profiles/${a.profiles[2]}/release-review`);
  }, 60_000);

  test("[REQ-LS-011] a profile whose state cannot be determined is not reused until reviewed", async () => {
    a.inst.stats.stateUnknown = true;
    const run = (await slow(a.profiles[2]!, 100)).json().runId;
    await finished(run);
    const blocked = await until("needs review", () => profileView(a.profiles[2]!), (p) => p.status === "NEEDS_REVIEW");
    expect(blocked.lastError).toMatch(/unknown session state/);
    const next = (await slow(a.profiles[2]!, 100)).json();
    expect(next.error.code).toBe("PROFILE_NEEDS_REVIEW");
    a.inst.stats.stateUnknown = false;
    await api("POST", `/api/v1/profiles/${a.profiles[2]}/release-review`);
  }, 60_000);

  test("[REQ-PROF-007] heartbeats extend the lease; when they stop the profile waits in VERIFYING instead of opening a second browser", async () => {
    const profileId = b.profiles[0]!;
    const run = (await slow(profileId, 4000)).json().runId;
    await until("running", () => runView(run), (r) => r.status === "RUNNING");
    const lease = async () => (await db.selectFrom("profile_leases").select("expires_at").where("profile_id", "=", profileId).executeTakeFirstOrThrow()).expires_at.getTime();
    const first = await lease();
    await sleep(600);
    expect(await lease()).toBeGreaterThan(first);

    b.running!.stop(); // heartbeats stop; the browser on the node keeps running
    await until("lease expired", () => profileView(profileId), (p) => p.status === "VERIFYING", 10_000);
    expect((await runView(run)).status).toBe("RECOVERY_PENDING");
    const next = (await slow(profileId, 100)).json().runId;
    await sleep(1000);
    // It waits: the owner is unreachable and the kept lease blocks the profile either way.
    expect(await runView(next)).toMatchObject({ status: "QUEUED", queueReason: expect.stringMatching(/^(AGENT_UNAVAILABLE|PROFILE_BUSY)$/) });
    expect(b.inst.stats.maxPerProfile.get("mac-b-p1")).toBe(1);

    connect(b); // the owner is back: once its browser has closed, it confirms the profile is idle
    await idle(profileId);
    // The old run finished while the agent was away; its buffered events arrive after the reconnect (S7).
    const recovered = await finished(run);
    expect(recovered.status).toBe("SUCCEEDED");
    expect(recovered.transitions.map((t: { to: string }) => t.to)).toEqual(expect.arrayContaining(["RECOVERY_PENDING", "SUCCEEDED"]));
    expect((await finished(next)).status).toBe("SUCCEEDED");
    expect(b.inst.stats.maxPerProfile.get("mac-b-p1")).toBe(1);
  }, 90_000);
});

describe("agent endpoints", () => {
  test("[REQ-API-002] agents: list, card, metrics, limits and guarded drain/disable/activate/revoke", async () => {
    const list = (await api("GET", "/api/v1/agents")).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["mac-a", "mac-b"]));
    expect((await api("GET", `/api/v1/agents/${a.agentId}/metrics`)).json().heartbeats.length).toBeGreaterThan(0);
    expect((await api("POST", `/api/v1/agents/${a.agentId}/activate`)).json().error.code).toBe("AGENT_STATE_CONFLICT");
    expect((await api("POST", `/api/v1/agents/${a.agentId}/disable`)).json().status).toBe("DISABLED");
    expect((await api("POST", `/api/v1/agents/${a.agentId}/drain`)).json().error.code).toBe("AGENT_STATE_CONFLICT");
    expect((await api("POST", `/api/v1/agents/${a.agentId}/activate`)).json().status).toBe("ACTIVE");
    expect((await api("PATCH", `/api/v1/agents/${randomUUID()}`, { sessionLimit: 1 })).statusCode).toBe(404);
  });
});
