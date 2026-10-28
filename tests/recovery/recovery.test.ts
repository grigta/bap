// Demo steps of S7 against a real agent process: kill -9, restart, resume, cancel, network loss.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const SCHEDULER = { leaseTtlMs: 1500, acceptTimeoutMs: 3000, tickMs: 200 };
const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "apps/mac-agent/src/cli.ts");
const work = mkdtempSync(join(tmpdir(), "bap-recovery-"));

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let cookie: string;
let site: Awaited<ReturnType<typeof startTestSite>>;
let proxy: ReturnType<typeof outageProxy>;

/** TCP proxy between the agent and the Control Plane that can drop every connection and refuse new ones. */
function outageProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  let down = false;
  const server: Server = createServer((client) => {
    if (down) return void client.destroy();
    const upstream = connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {});
    }
    client.pipe(upstream).pipe(client);
    // A killed peer must close both halves, as a real TCP connection would.
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return {
    server,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    async outage(ms: number) {
      down = true;
      for (const s of sockets) s.destroy();
      await sleep(ms);
      down = false;
    },
  };
}

const api = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: { bap_session: cookie }, headers: method === "POST" && url === "/api/v1/runs" ? { "idempotency-key": randomUUID() } : {} });
const runView = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
const orders = async () => (await (await fetch(`${site.url}/api/orders`)).json()) as { item: string }[];
const setMode = (mode: object) => fetch(`${site.url}/api/mode`, { method: "POST", body: JSON.stringify(mode) });

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}
const FINAL = ["SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"];
const settled = (id: string) => until(`run ${id} final`, () => runView(id), (r) => FINAL.includes(r.status), 60_000);
const reasons = (run: { transitions: { reason: string | null }[] }) => run.transitions.map((t) => t.reason);

/** A real `bap-agent start` process on local Chromium; kill -9 leaves its browser behind like a real crash. */
class AgentProcess {
  child: ChildProcess | null = null;
  readonly data: string;
  profileId = "";
  readonly name: string;
  readonly profile: string;
  constructor(name: string, profile: string) {
    this.name = name;
    this.profile = profile;
    this.data = join(work, name);
    mkdirSync(join(this.data, "profiles", profile), { recursive: true });
  }
  async enroll(serverUrl: string) {
    const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
    const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: this.name, platform: "darwin", architecture: "arm64" } })).json();
    writeFileSync(join(this.data, "agent.json"), JSON.stringify({ serverUrl, agentId, agentKey, name: this.name }));
    this.start();
    await until(`${this.name} online`, async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.heartbeat?.lsAvailable === true);
    this.profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: this.profile, name: this.profile })).json().id;
  }
  start() {
    this.child = spawn("node", [cli, "start"], { env: { ...process.env, BAP_AGENT_DATA: this.data, BAP_PROVIDER: "local" }, stdio: "ignore" });
  }
  crash() {
    this.child?.kill("SIGKILL"); // the agent dies; its Chromium keeps running, as after a real crash
    this.child = null;
  }
}

async function publish(entry: string, store: ReturnType<typeof memoryStore>) {
  const manifest = await buildScenarioBundle(entry, join(work, "bundles"));
  await store.put(manifest.file, readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await api("POST", `/api/v1/scenarios/${manifest.id}/versions`, { version: manifest.version, sha256: manifest.sha256, bundleKey: manifest.file });
}

const agents: AgentProcess[] = [];
beforeAll(async () => {
  site = await startTestSite();
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  const store = memoryStore();
  app = buildApp({ db, store, secureCookies: false, fleet: FLEET, scheduler: SCHEDULER });
  const cpUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  proxy = outageProxy(Number(new URL(cpUrl).port));
  const proxyPort = await proxy.listen();
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  await publish(join(repo, "scenarios/wizard-order/index.ts"), store);
  await publish(join(repo, "tests/fixtures/scenarios/wizard-order-auto/index.ts"), store);
  for (const name of ["manual", "auto", "network"]) {
    const a = new AgentProcess(`rec-${name}`, `${name}-profile`);
    await a.enroll(`http://127.0.0.1:${proxyPort}`);
    agents.push(a);
  }
}, 180_000);

afterEach(async () => {
  await fetch(`${site.url}/api/orders`, { method: "DELETE" });
});

afterAll(async () => {
  for (const a of agents) {
    a.crash();
    // kill -9 leaves the agent's Chromium behind on purpose; tidy it up after the suite.
    await new LocalChromiumProvider({ profilesDir: join(a.data, "profiles") }).forceRelease(a.profile);
  }
  await app?.close();
  proxy?.server.close();
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});

const order = (agent: AgentProcess, scenarioId = "wizard-order") => {
  const item = `coffee-${randomUUID().slice(0, 8)}`;
  return { item, start: async () => (await api("POST", "/api/v1/runs", { scenarioId, scenarioVersion: "1.1.0", profileId: agent.profileId, input: { baseUrl: site.url, item } })).json().runId as string };
};

describe("cancel", () => {
  test("[REQ-RUN-003][REQ-API-004] a cancel during the mutating step lets it finish and verify, then stops; a queued run cancels at once", async () => {
    const a = agents[0]!;
    await setMode({ orderHoldMs: 3000 });
    const o = order(a);
    const runId = await o.start();
    await until("order placed", orders, (list) => list.length === 1);
    expect((await api("POST", `/api/v1/runs/${runId}/cancel`)).json().status).toBe("CANCEL_REQUESTED");
    const done = await settled(runId);
    expect(done.status).toBe("CANCELLED");
    expect(reasons(done)).toContain("cancelled after step place-order");
    const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json();
    expect(steps.map((s: { stepId: string; status: string }) => `${s.stepId}:${s.status}`)).toEqual(["choose-item:passed", "review:passed", "confirm:passed", "place-order:passed"]);
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);
    expect((await api("POST", `/api/v1/runs/${runId}/cancel`)).json().error.code).toBe("RUN_STATE_CONFLICT");

    a.crash(); // with the agent away the next run stays queued and cancels without it
    await until("agent offline", async () => (await api("GET", `/api/v1/agents/${(await api("GET", `/api/v1/profiles/${a.profileId}`)).json().agentId}`)).json(), (x) => x.connection === "OFFLINE");
    const queued = await order(a).start();
    expect((await api("POST", `/api/v1/runs/${queued}/cancel`)).json().status).toBe("CANCELLED");
    a.start();
  }, 90_000);
});

describe("crash and resume", () => {
  test("[REQ-RUN-005][REQ-API-007][REQ-AGENT-001] kill -9 during a read step: the restarted agent reports it, the operator resumes from the checkpoint", async () => {
    const a = agents[0]!;
    await until("profile free", async () => (await api("GET", `/api/v1/profiles/${a.profileId}`)).json(), (p) => p.status === "AVAILABLE");
    await setMode({ holdStep: 3, holdMs: 4000 });
    const o = order(a);
    const runId = await o.start();
    await until("checkpoint after review", () => runView(runId), (r) => r.checkpoints.some((c: { stepId: string }) => c.stepId === "review"));
    a.crash();
    await setMode({});
    a.start();
    const pending = await until("recovery pending", () => runView(runId), (r) => r.status === "RECOVERY_PENDING" && r.transitions.some((t: { reason: string }) => /agent restarted mid-run|lease expired/.test(t.reason)));
    expect(pending.autoResume).toBe(false);
    await sleep(1500);
    expect((await runView(runId)).status).toBe("RECOVERY_PENDING"); // autoResume: false waits for the operator

    const unconfirmed = await api("POST", `/api/v1/runs/${runId}/resume`, { mode: "safe-checkpoint", operatorConfirmed: false });
    expect(unconfirmed.json().error.code).toBe("OPERATOR_CONFIRMATION_REQUIRED");
    const accepted = await api("POST", `/api/v1/runs/${runId}/resume`, { mode: "safe-checkpoint", operatorConfirmed: true });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ runId, accepted: true });

    const done = await settled(runId);
    expect(done.status).toBe("SUCCEEDED");
    expect(reasons(done)).toEqual(expect.arrayContaining(["resume requested by operator from checkpoint 2 (review)", "resumed after checkpoint review"]));
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);
  }, 120_000);

  test("[REQ-RUN-006][REQ-RUN-005] kill -9 inside the mutating step after the site took the order: resume confirms it by verify, no second order", async () => {
    const a = agents[0]!;
    await until("profile free", async () => (await api("GET", `/api/v1/profiles/${a.profileId}`)).json(), (p) => p.status === "AVAILABLE");
    await setMode({ orderHoldMs: 5000 });
    const o = order(a);
    const runId = await o.start();
    await until("order taken by the site", orders, (list) => list.some((x) => x.item === o.item));
    a.crash();
    await setMode({});
    a.start();
    await until("recovery pending", () => runView(runId), (r) => r.status === "RECOVERY_PENDING");
    await until("profile verified idle", async () => (await api("GET", `/api/v1/profiles/${a.profileId}`)).json(), (p) => p.status === "AVAILABLE");
    await api("POST", `/api/v1/runs/${runId}/resume`, { mode: "safe-checkpoint", operatorConfirmed: true });
    const done = await settled(runId);
    expect(done.status).toBe("SUCCEEDED");
    expect(reasons(done)).toContain("resumed after checkpoint confirm");
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);
  }, 120_000);

  test("[REQ-RUN-007] with autoResume the run continues without the operator once it is safe", async () => {
    const a = agents[1]!;
    await setMode({ holdStep: 3, holdMs: 4000 });
    const o = order(a, "wizard-order-auto");
    const runId = await o.start();
    await until("checkpoint after review", () => runView(runId), (r) => r.checkpoints.length >= 2);
    a.crash();
    await setMode({});
    a.start();
    const done = await settled(runId);
    expect(done.status).toBe("SUCCEEDED");
    expect(reasons(done)).toEqual(expect.arrayContaining(["resume requested by autoResume from checkpoint 2 (review)"]));
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);
  }, 120_000);

  test("[REQ-PROF-008][REQ-RUN-005] when the site cannot tell whether the order went through, run and profile wait for review; no retry", async () => {
    const a = agents[1]!;
    await until("profile free", async () => (await api("GET", `/api/v1/profiles/${a.profileId}`)).json(), (p) => p.status === "AVAILABLE");
    await setMode({ orderHoldMs: 5000 });
    const o = order(a, "wizard-order-auto");
    const runId = await o.start();
    await until("order taken by the site", orders, (list) => list.some((x) => x.item === o.item));
    a.crash();
    await setMode({ ambiguous: true });
    a.start();
    const done = await settled(runId).catch(async (e) => {
      const profile = await db.selectFrom("profiles").select(["status", "last_error", "active_run_id"]).where("id", "=", a.profileId).executeTakeFirst();
      const leases = await db.selectFrom("profile_leases").selectAll().where("profile_id", "=", a.profileId).execute();
      throw new Error(`${e.message}\nPROFILE ${JSON.stringify(profile)}\nLEASES ${JSON.stringify(leases)}`);
    });
    expect(done).toMatchObject({ status: "NEEDS_REVIEW", errorCode: "UNVERIFIED" });
    expect(done.errorMessage).toContain("interrupted mutating step");
    const profile = await until("profile blocked", async () => (await api("GET", `/api/v1/profiles/${a.profileId}`)).json(), (p) => p.status === "NEEDS_REVIEW");
    expect(profile.lastError).toContain(runId);
    await setMode({});
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);

    const review = (await api("GET", "/api/v1/review")).json();
    expect(review.runs.map((r: { id: string }) => r.id)).toContain(runId);
    expect(review.profiles.map((p: { id: string }) => p.id)).toContain(a.profileId);
    await api("POST", `/api/v1/profiles/${a.profileId}/release-review`);
  }, 120_000);
});

describe("network loss", () => {
  test("[REQ-PROTO-006] events and screenshots buffered during a network outage arrive afterwards without gaps or duplicates", async () => {
    const a = agents[2]!;
    await setMode({ holdStep: 3, holdMs: 2500 });
    const o = order(a);
    const runId = await o.start();
    await until("running", () => runView(runId), (r) => r.status === "RUNNING");
    await proxy.outage(6000); // the lease expires meanwhile; the agent keeps working offline
    const done = await settled(runId);
    expect(done.status).toBe("SUCCEEDED");
    const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json();
    expect(steps.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.every((s: { screenshotArtifactId: string | null }) => s.screenshotArtifactId !== null)).toBe(true);
    const progress = await db.selectFrom("agent_events").select("event_type").where("event_type", "=", "run.progress").where("payload", "@>", JSON.stringify({ runId }) as never).execute();
    expect(progress).toHaveLength(5);
    expect((await orders()).filter((x) => x.item === o.item)).toHaveLength(1);
  }, 120_000);
});
