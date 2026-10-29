import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkenSphereProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { type ObjectStore, memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startFakeLinkenSphere } from "../support/fake-linken-sphere.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const IDLE_MS = 1500;

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let store: ObjectStore;
let baseUrl: string;
let cookie: string;
let agentId: string;
let agent: RunningAgent;
let ls: Awaited<ReturnType<typeof startFakeLinkenSphere>>;
let site: Server;
let siteUrl: string;

const api = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { bap_session: cookie } });

async function until<T>(what: string, read: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)?.slice(0, 300)}`);
    await sleep(50);
  }
}

/** A page with a button at a known place and a search field: what the operator clicks and types into. */
const PAGE = `<!doctype html><title>Стенд</title><body style="margin:0">
<button style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="location='/clicked'">Дальше</button>
<form action="/search" style="position:absolute;left:20px;top:120px"><input name="q" style="width:300px;height:40px"></form></body>`;

beforeAll(async () => {
  site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/" || req.url === "/failed" ? PAGE : `<title>${req.url}</title><p>${req.url}</p>`));
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  ls = await startFakeLinkenSphere(mkdtempSync(join(tmpdir(), "bap-remote-ls-")));
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  store = memoryStore();
  app = buildApp({ db, store, secureCookies: false, fleet: FLEET, remote: { idleMs: IDLE_MS } });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  let agentKey: string;
  ({ agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-remote", platform: "darwin", architecture: "arm64" } })).json());
  agent = startAgent({ serverUrl: baseUrl, agentKey, provider: new LinkenSphereProvider({ apiUrl: ls.url }), providerName: "linken-sphere", maxSessions: 2, dataDir: mkdtempSync(join(tmpdir(), "bap-remote-agent-")), log: () => {}, model: null });
  await db.insertInto("scenarios").values({ id: "remote-test" }).execute();
  await db.insertInto("scenario_versions").values({ scenario_id: "remote-test", version: "1.0.0", sha256: "0".repeat(64), bundle_key: "unused" }).execute();
  await until("LS available", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.heartbeat?.lsAvailable === true);
});

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  await ls?.stop();
  site?.close();
});

/** A profile whose run failed on `${siteUrl}/failed`, as «Недоработки» shows it. */
async function failedRun(profileStatus: "AVAILABLE" | "NEEDS_REVIEW" = "NEEDS_REVIEW") {
  const name = `remote-${randomUUID().slice(0, 6)}`;
  const external = ls.createSession(name);
  const profile = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: external, name })).json();
  await db.updateTable("profiles").set({ status: profileStatus }).where("id", "=", profile.id).execute();
  const run = await db
    .insertInto("runs")
    .values({ scenario_id: "remote-test", scenario_version: "1.0.0", profile_id: profile.id, agent_id: agentId, input: {}, timeout_ms: 60_000, status: "FAILED", error_code: "STEP_FAILED", error_message: "step s02 failed" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const key = `runs/${run.id}/02-s02.failure.json`;
  await store.put(key, Buffer.from(JSON.stringify({ stepId: "s02", url: `${siteUrl}/failed`, title: "Стенд", snapshot: null })), "application/json");
  const art = await db.insertInto("artifacts").values({ run_id: run.id, name: "02-s02.failure.json", content_type: "application/json", size_bytes: 1, sha256: "x", storage_key: key }).returning("id").executeTakeFirstOrThrow();
  await db
    .insertInto("run_steps")
    .values({ run_id: run.id, sequence: 2, step_id: "s02", mutating: false, status: "failed", started_at: new Date(), duration_ms: 1, error: "boom", screenshot_artifact_id: null, failure_artifact_id: art.id, intent: null, resolution: null, note: null })
    .execute();
  return { runId: run.id, profileId: profile.id as string, external };
}

/** The operator's side of a session: everything the server sends, and input going back. */
async function watch(sessionId: string) {
  const got: { type: string; url?: string; data?: string; reason?: string }[] = [];
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/remote/${sessionId}/ws`, { headers: { cookie: `bap_session=${cookie}` } });
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((r, j) => ws.once("open", r).once("error", j));
  return {
    ws,
    got,
    send: (input: object) => ws.send(JSON.stringify({ type: "input", input })),
    page: (match: RegExp) => until(`page ${match}`, () => got.filter((m) => m.type === "page").at(-1)?.url ?? "", (u) => match.test(u)),
  };
}

const lsStatus = async (external: string) => (await (await fetch(`${ls.url}/sessions`)).json()).find((s: { uuid: string }) => s.uuid === external)?.status;

describe("remote browser of a failed run's profile", () => {
  test("[REQ-UI-011][REQ-AGENT-005] the operator sees the page where the run stopped, clicks, types and navigates; closing stops the browser and keeps the addresses", async () => {
    const { runId, profileId, external } = await failedRun();
    const opened = await api("POST", `/api/v1/runs/${runId}/remote`);
    expect(opened.statusCode).toBe(201);
    const { sessionId } = opened.json();
    const view = await watch(sessionId);
    await until("opened", () => view.got, (g) => g.some((m) => m.type === "opened"));
    await view.page(/\/failed$/);
    const frame = await until("a frame", () => view.got.find((m) => m.type === "frame"), (f) => !!f);
    expect(Buffer.from(frame!.data!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG
    expect(await lsStatus(external)).not.toBe("stopped");

    view.send({ kind: "click", x: 120, y: 50 });
    await view.page(/\/clicked$/);
    view.send({ kind: "back" });
    await view.page(/\/failed$/);
    view.send({ kind: "click", x: 170, y: 140 });
    view.send({ kind: "text", text: "кофе" });
    view.send({ kind: "key", key: "Enter" });
    await view.page(/\/search\?q=%D0%BA%D0%BE%D1%84%D0%B5$/);
    view.send({ kind: "goto", url: `${siteUrl}/elsewhere` });
    await view.page(/\/elsewhere$/);

    // Only one person at a time in a profile's browser.
    expect((await api("POST", `/api/v1/runs/${runId}/remote`)).json().error.code).toBe("REMOTE_SESSION_OPEN");

    expect((await api("POST", `/api/v1/remote/${sessionId}/close`)).statusCode).toBe(204);
    await until("closed for the viewer", () => view.got, (g) => g.some((m) => m.type === "closed"));
    await until("LS session stopped", () => lsStatus(external), (s) => s === "stopped");
    const issue = (await api("GET", "/api/v1/review")).json().runs.find((r: { id: string }) => r.id === runId);
    expect(issue.remoteSessions[0]).toMatchObject({ openedBy: "operator", endReason: "закрыта оператором", endedAt: expect.any(String) });
    expect(issue.remoteSessions[0].urls).toEqual([`${siteUrl}/failed`, `${siteUrl}/clicked`, `${siteUrl}/failed`, `${siteUrl}/search?q=%D0%BA%D0%BE%D1%84%D0%B5`, `${siteUrl}/elsewhere`]);
    // What was typed is not kept anywhere on the server.
    expect(JSON.stringify(await db.selectFrom("remote_sessions").selectAll().execute())).not.toContain("кофе");
    expect((await api("GET", `/api/v1/profiles/${profileId}`)).json().status).toBe("NEEDS_REVIEW");
  });

  test("[REQ-UI-011] while the operator is in the profile, runs on it wait; a session nobody watches closes by itself", async () => {
    const { runId, profileId, external } = await failedRun("AVAILABLE");
    const { sessionId } = (await api("POST", `/api/v1/runs/${runId}/remote`)).json();
    await until("browser started", () => lsStatus(external), (s) => s !== "stopped");
    const waiting = await db
      .insertInto("runs")
      .values({ scenario_id: "farm", kind: "farm", profile_id: profileId, agent_id: agentId, input: { query: "кофе", sites: 1, dwellSeconds: 1, searchUrl: `${siteUrl}/` }, timeout_ms: 60_000, status: "QUEUED" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await app.internals.coordinator!.tick();
    expect((await api("GET", `/api/v1/runs/${waiting.id}`)).json()).toMatchObject({ status: "QUEUED", queueReason: "PROFILE_BUSY" });
    await api("POST", `/api/v1/runs/${waiting.id}/cancel`);

    // Nobody connected: closed after the idle timeout, and the browser stops.
    await until("closed when idle", async () => (await db.selectFrom("remote_sessions").select(["ended_at", "end_reason"]).where("id", "=", sessionId).executeTakeFirstOrThrow()).end_reason, (r) => r === "никто не смотрел сессию", IDLE_MS + 10_000);
    await until("LS session stopped", () => lsStatus(external), (s) => s === "stopped");
  });

  test("[REQ-UI-011] a profile in use by a run, an agent away or no cookie: no session", async () => {
    const busy = await failedRun("AVAILABLE");
    await db.updateTable("profiles").set({ status: "IN_USE" }).where("id", "=", busy.profileId).execute();
    expect((await api("POST", `/api/v1/runs/${busy.runId}/remote`)).json().error.code).toBe("PROFILE_BUSY");
    await db.updateTable("profiles").set({ status: "AVAILABLE" }).where("id", "=", busy.profileId).execute();

    const { sessionId } = (await api("POST", `/api/v1/runs/${busy.runId}/remote`)).json();
    const anonymous = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/remote/${sessionId}/ws`);
    await expect(new Promise((r, j) => anonymous.once("open", r).once("unexpected-response", (_q, res) => j(new Error(`HTTP ${res.statusCode}`))))).rejects.toThrow("HTTP 401");
    // Marking the run fixed closes the operator's session first.
    expect((await api("POST", `/api/v1/runs/${busy.runId}/resolve`, { note: "починил вручную" })).statusCode).toBe(200);
    expect((await db.selectFrom("remote_sessions").select("end_reason").where("id", "=", sessionId).executeTakeFirstOrThrow()).end_reason).toBe("проход отмечен как доработанный");

    const later = await failedRun("AVAILABLE");
    agent.stop();
    await until("agent offline", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.connection !== "ONLINE", 10_000);
    expect((await api("POST", `/api/v1/runs/${later.runId}/remote`)).json().error.code).toBe("AGENT_UNAVAILABLE");
  });
});
