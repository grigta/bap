import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { AGENT_SOCKET_PATH, message } from "@bap/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { LinkenSphereProvider } from "@bap/browser-adapters";
import { startAgent } from "../../apps/mac-agent/src/agent.ts";
import { launchAgentPlist } from "../../apps/mac-agent/src/launchagent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let baseUrl: string;
let cookie: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } });
  cookie = login.cookies.find((c) => c.name === "bap_session")!.value;
});

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

const api = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { bap_session: cookie } });
const invite = async () => (await api("POST", "/api/v1/agents/enrollments")).json() as { id: string; token: string; expiresAt: string };
const enroll = (token: string, name: string) =>
  app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name, platform: "darwin", architecture: "arm64" } });
const newAgent = async (name: string) => (await enroll((await invite()).token, name)).json() as { agentId: string; agentKey: string };
const agentView = async (id: string) => (await api("GET", `/api/v1/agents/${id}`)).json();

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

/** Runs `bap-agent start` as a real process with its own data directory. */
function spawnAgent(agent: { agentId: string; agentKey: string }, name: string): ChildProcess {
  const data = mkdtempSync(join(tmpdir(), "bap-agent-"));
  writeFileSync(join(data, "agent.json"), JSON.stringify({ serverUrl: baseUrl, agentId: agent.agentId, agentKey: agent.agentKey, name }));
  const child = spawn("node", [cli, "start"], { env: { ...process.env, BAP_AGENT_DATA: data, BAP_LS_API_URL: "" }, stdio: "pipe" });
  children.push(child);
  return child;
}

function rawSocket(agentKey?: string): Promise<{ ws: WebSocket; next: () => Promise<{ type: string; payload: Record<string, unknown> }>; closed: Promise<number> }> {
  const ws = new WebSocket(baseUrl.replace("http", "ws") + AGENT_SOCKET_PATH, { headers: agentKey ? { authorization: `Bearer ${agentKey}` } : {} });
  const inbox: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.on("message", (raw) => (waiters.length ? waiters.shift()!(String(raw)) : inbox.push(String(raw))));
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const next = () => new Promise<string>((r) => (inbox.length ? r(inbox.shift()!) : waiters.push(r))).then((m) => JSON.parse(m));
  return new Promise((ok, fail) => {
    ws.on("open", () => ok({ ws, next, closed }));
    ws.on("unexpected-response", (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe("enrollment", () => {
  test("[REQ-SEC-004] an invitation is single-use, expires and is stored only as a hash", async () => {
    const inv = await invite();
    expect(new Date(inv.expiresAt).getTime() - Date.now()).toBeGreaterThan(FLEET.enrollmentTtlMs - 5000);
    // Prefixed, so it never starts with "-" and the CLI never mistakes it for an option.
    for (const t of [inv.token, ...(await Promise.all(Array.from({ length: 20 }, invite))).map((i) => i.token)]) expect(t).toMatch(/^bapi_[\w-]{43}$/);
    const first = await enroll(inv.token, "mac-enroll");
    expect(first.statusCode).toBe(201);
    expect((await agentView(first.json().agentId)).status).toBe("ACTIVE");

    const reused = await enroll(inv.token, "mac-enroll-2");
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.code).toBe("INVITATION_INVALID");

    const stale = await invite();
    await db.updateTable("agent_enrollments").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", stale.id).execute();
    expect((await enroll(stale.token, "mac-stale")).statusCode).toBe(401);
    expect((await enroll("made-up", "mac-fake")).statusCode).toBe(401);

    const stored = await db.selectFrom("agent_enrollments").select("token_hash").execute();
    expect(stored.map((r) => r.token_hash)).not.toContain(inv.token);
    expect((await enroll((await invite()).token, "mac-enroll")).json().error.code).toBe("AGENT_NAME_TAKEN");
  });
});

describe("deleting a revoked agent", () => {
  test("[REQ-DB-002] only a revoked agent can be deleted; it leaves the panel with its profiles, its history stays, its name is free again", async () => {
    const { agentId } = await newAgent("mac-deleted");
    const profile = await db
      .insertInto("profiles")
      .values({ provider: "linken-sphere", external_profile_id: "ls-uuid-1", name: "shop", agent_id: agentId })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${agentId}`, cookies: { bap_session: cookie } })).json().error.code).toBe("AGENT_STATE_CONFLICT");
    await api("POST", `/api/v1/agents/${agentId}/revoke`);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${agentId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${agentId}`, cookies: { bap_session: cookie } })).statusCode).toBe(204);

    expect((await api("GET", "/api/v1/agents")).json().map((a: { id: string }) => a.id)).not.toContain(agentId);
    expect((await api("GET", `/api/v1/agents/${agentId}`)).statusCode).toBe(404);
    expect((await api("GET", "/api/v1/profiles")).json().map((p: { id: string }) => p.id)).not.toContain(profile.id);
    // Nothing is erased: runs, events and audit keep pointing at the same rows.
    expect(await db.selectFrom("agents").select("id").where("id", "=", agentId).executeTakeFirst()).toBeDefined();
    expect(await db.selectFrom("profiles").select("id").where("id", "=", profile.id).executeTakeFirst()).toBeDefined();

    // The same Mac registers again under its name and can import the same Linken Sphere profile.
    const again = (await enroll((await invite()).token, "mac-deleted")).json();
    expect(again.agentId).not.toBe(agentId);
    await db.insertInto("profiles").values({ provider: "linken-sphere", external_profile_id: "ls-uuid-1", name: "shop", agent_id: again.agentId }).execute();
    expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${agentId}`, cookies: { bap_session: cookie } })).statusCode).toBe(404);
  });
});

describe("audit", () => {
  test("[REQ-SEC-012] operator actions and rejected attempts are journalled with actor, target and outcome, without secrets", async () => {
    const inv = await invite();
    const { agentId } = (await enroll(inv.token, "mac-audited")).json();
    await enroll(inv.token, "mac-audited-again");
    await api("POST", `/api/v1/agents/${agentId}/drain`);
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "wrong-password-123" } });
    await app.inject({ method: "POST", url: `/api/v1/agents/${agentId}/revoke` }); // no session

    expect((await app.inject({ method: "GET", url: "/api/v1/audit" })).statusCode).toBe(401);
    const events = (await api("GET", "/api/v1/audit?limit=50")).json() as { actor: string; action: string; outcome: string; targetId: string | null; details: Record<string, unknown> }[];
    const find = (action: string, outcome: string) => events.find((e) => e.action === action && e.outcome === outcome);
    expect(find("POST /api/v1/agents/enrollments", "ok")).toMatchObject({ actor: "operator:operator" });
    expect(find("POST /api/v1/agents/enroll", "ok")).toMatchObject({ details: { status: 201, name: "mac-audited" } });
    expect(find("POST /api/v1/agents/enroll", "denied")).toMatchObject({ actor: "anonymous", details: { status: 401, name: "mac-audited-again" } });
    expect(find("POST /api/v1/agents/:id/drain", "ok")).toMatchObject({ actor: "operator:operator", targetId: agentId });
    expect(find("POST /api/v1/agents/:id/revoke", "denied")).toMatchObject({ actor: "anonymous", targetId: agentId, details: { status: 401 } });
    expect(find("POST /api/v1/auth/login", "denied")).toMatchObject({ details: { status: 401, login: "operator" } });
    expect(JSON.stringify(events)).not.toMatch(/wrong-password-123|pw"|token/);
    expect(JSON.stringify(events)).not.toContain(inv.token);
  });
});

describe("connection", () => {
  test("[REQ-PROTO-001] the agent dials out and listens on no TCP port; the socket needs agent credentials", async () => {
    const agent = await newAgent("mac-dialer");
    const child = spawnAgent(agent, "mac-dialer");
    await until("agent online", () => agentView(agent.agentId), (a) => a.connection === "ONLINE" && a.heartbeat !== null);
    const listening = spawnSync("lsof", ["-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-nP"], { encoding: "utf8" });
    expect(listening.stdout).toBe("");
    child.kill();

    await expect(rawSocket()).rejects.toThrow("HTTP 401");
    await expect(rawSocket("wrong-key")).rejects.toThrow("HTTP 401");
  });

  test("[REQ-PROTO-002][REQ-PROTO-003] a frozen agent goes SUSPECT then OFFLINE and comes back; admin status is a separate axis", async () => {
    const agent = await newAgent("mac-frozen");
    const child = spawnAgent(agent, "mac-frozen");
    await until("ONLINE", () => agentView(agent.agentId), (a) => a.connection === "ONLINE" && a.heartbeat !== null);

    child.kill("SIGSTOP");
    const stoppedAt = Date.now();
    await until("SUSPECT", () => agentView(agent.agentId), (a) => a.connection === "SUSPECT");
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(FLEET.suspectAfterMs - 2 * FLEET.heartbeatIntervalMs);
    await until("OFFLINE", () => agentView(agent.agentId), (a) => a.connection === "OFFLINE");
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(FLEET.offlineAfterMs - 2 * FLEET.heartbeatIntervalMs);

    child.kill("SIGCONT");
    await until("ONLINE again", () => agentView(agent.agentId), (a) => a.connection === "ONLINE");

    expect((await api("POST", `/api/v1/agents/${agent.agentId}/drain`)).json()).toMatchObject({ status: "DRAINING", connection: "ONLINE" });
    expect((await api("POST", `/api/v1/agents/${agent.agentId}/disable`)).json()).toMatchObject({ status: "DISABLED", connection: "ONLINE" });
    child.kill();
  });

  test("heartbeats carry metrics and the agent card returns their history", async () => {
    const agent = await newAgent("mac-metrics");
    const running = startAgent({ serverUrl: baseUrl, agentKey: agent.agentKey, provider: null, providerName: "none", maxSessions: 3, dataDir: tmpdir(), log: () => {} });
    const view = await until("3 heartbeats", () => agentView(agent.agentId), (a) => a.heartbeats.length >= 3);
    running.stop();
    expect(view).toMatchObject({ agentVersion: "0.1.0", maxSessions: 3, heartbeat: { activeSessions: 0, lsAvailable: false } });
    expect(view.heartbeat.memoryPercent).toBeGreaterThan(0);
    // Power comes from pmset: a real reading on macOS, null elsewhere (CI runs on Linux).
    const power = process.platform === "darwin" ? { source: expect.stringMatching(/^(ac|battery|unknown)$/), batteryPercent: expect.toBeOneOf([null, expect.any(Number)]), charging: expect.toBeOneOf([null, expect.any(Boolean)]), sleepPrevented: expect.toBeOneOf([null, expect.any(Boolean)]) } : null;
    expect(view.heartbeats[0]).toEqual({ cpuPercent: expect.any(Number), memoryPercent: expect.any(Number), lsAvailable: false, activeSessions: 0, power, at: expect.any(String) });
  });

  test("[REQ-SEC-005] revoking an agent closes its socket for good; re-registration grants nothing back", async () => {
    const agent = await newAgent("mac-revoked");
    const running = startAgent({ serverUrl: baseUrl, agentKey: agent.agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: tmpdir(), log: () => {} });
    await until("ONLINE", () => agentView(agent.agentId), (a) => a.connection === "ONLINE");
    // Revoked means cut off: never shown as connected, even within the heartbeat window.
    expect((await api("POST", `/api/v1/agents/${agent.agentId}/revoke`)).json()).toMatchObject({ status: "REVOKED", connection: "OFFLINE" });
    expect(await running.stopped).toBe("revoked");
    await expect(rawSocket(agent.agentKey)).rejects.toThrow("HTTP 401");
    // A restarted agent with the same key is refused again.
    const restarted = startAgent({ serverUrl: baseUrl, agentKey: agent.agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: tmpdir(), log: () => {} });
    expect(await restarted.stopped).toBe("revoked");
    // Revocation is final, and a new invitation cannot take over the revoked agent's identity.
    expect((await api("POST", `/api/v1/agents/${agent.agentId}/activate`)).statusCode).toBe(409);
    expect((await enroll((await invite()).token, "mac-revoked")).statusCode).toBe(409);
    const fresh = (await enroll((await invite()).token, "mac-revoked-2")).json();
    expect(fresh.agentId).not.toBe(agent.agentId);
    expect(await agentView(agent.agentId)).toMatchObject({ status: "REVOKED" });
  });

  test("[REQ-SEC-005] key rotation: the agent switches to a new key and reconnects; the old key is rejected", async () => {
    const agent = await newAgent("mac-rotated");
    let rotated = "";
    const running = startAgent({ serverUrl: baseUrl, agentKey: agent.agentKey, onKeyRotated: (k) => (rotated = k), provider: null, providerName: "none", maxSessions: 1, dataDir: tmpdir(), log: () => {} });
    await until("ONLINE", () => agentView(agent.agentId), (a) => a.connection === "ONLINE");
    expect((await api("POST", `/api/v1/agents/${agent.agentId}/rotate-key`)).statusCode).toBe(202);
    await until("new key", async () => rotated, (k) => k !== "");
    expect(rotated).not.toBe(agent.agentKey);
    await until("ONLINE with the new key", () => agentView(agent.agentId), (a) => a.connection === "ONLINE");
    await expect(rawSocket(agent.agentKey)).rejects.toThrow("HTTP 401");
    const { ws } = await rawSocket(rotated);
    ws.close();
    running.stop();
    const audited = await db.selectFrom("audit_events").select(["action", "actor"]).where("target_id", "=", agent.agentId).execute();
    expect(audited.map((a) => a.action)).toEqual(expect.arrayContaining(["agent key rotated"]));
  });
});

describe("protocol", () => {
  test("[REQ-PROTO-004] every message is schema-checked: malformed input and events before hello close the socket", async () => {
    const { agentKey, agentId } = await newAgent("mac-proto");
    const early = await rawSocket(agentKey);
    early.ws.send(JSON.stringify({ ...message({ type: "agent.heartbeat", payload: { cpuPercent: 1, memoryPercent: 1, lsAvailable: false, activeSessions: 0 } }), seq: 1 }));
    expect(await early.next()).toMatchObject({ type: "server.error", payload: { code: "HELLO_REQUIRED" } });
    expect(await early.closed).toBe(1008);

    const bad = await rawSocket(agentKey);
    bad.ws.send(JSON.stringify({ v: 1, type: "agent.hello", payload: {} }));
    expect(await bad.next()).toMatchObject({ type: "server.error", payload: { code: "PROTOCOL_ERROR" } });
    expect(await bad.closed).toBe(1008);
    expect(await db.selectFrom("agent_events").select("id").where("agent_id", "=", agentId).execute()).toEqual([]);
  });

  test("[REQ-PROTO-005] each hello opens a higher epoch; a repeated (epoch, sequence) is acknowledged as a duplicate and stored once", async () => {
    const { agentKey, agentId } = await newAgent("mac-epochs");
    const hello = message({ type: "agent.hello", payload: { agentVersion: "t", platform: "darwin", architecture: "arm64" } });
    const beat = (seq: number) => ({ ...message({ type: "agent.heartbeat", payload: { cpuPercent: 5, memoryPercent: 50, lsAvailable: false, activeSessions: 0 } }), seq });

    const a = await rawSocket(agentKey);
    a.ws.send(JSON.stringify(hello));
    const w1 = await a.next();
    const first = beat(1);
    a.ws.send(JSON.stringify(first));
    expect(await a.next()).toMatchObject({ type: "server.ack", payload: { id: first.id, duplicate: false } });
    a.ws.send(JSON.stringify({ ...beat(1), id: first.id }));
    expect(await a.next()).toMatchObject({ type: "server.ack", payload: { duplicate: true } });
    a.ws.close();

    // The agent lost its local state: sequence starts at 1 again, in a new epoch.
    const b = await rawSocket(agentKey);
    b.ws.send(JSON.stringify(hello));
    const w2 = await b.next();
    expect(w2.payload.epoch).toBe((w1.payload.epoch as number) + 1);
    b.ws.send(JSON.stringify(beat(1)));
    expect(await b.next()).toMatchObject({ type: "server.ack", payload: { duplicate: false } });
    b.ws.close();

    const rows = await sql<{ epoch: string; sequence: string }>`SELECT epoch, sequence FROM agent_events WHERE agent_id = ${agentId} ORDER BY epoch`.execute(db);
    expect(rows.rows.map((r) => [Number(r.epoch), Number(r.sequence)])).toEqual([
      [w1.payload.epoch, 1],
      [w2.payload.epoch, 1],
    ]);
    // Discarded repeats are counted on the agent card, so an operator can see redelivery happened.
    expect((await agentView(agentId)).duplicateMessages).toBe(1);
  });
});

test("[REQ-PROTO-002] a socket that falls silent (agent died without closing TCP) is dropped after the OFFLINE threshold", async () => {
  const { agentKey } = await newAgent("mac-silent");
  const silent = await rawSocket(agentKey);
  silent.ws.send(JSON.stringify(message({ type: "agent.hello", payload: { agentVersion: "t", platform: "darwin", architecture: "arm64" } })));
  await silent.next(); // welcome; then nothing more is sent
  const started = Date.now();
  await silent.closed;
  expect(Date.now() - started).toBeGreaterThanOrEqual(FLEET.offlineAfterMs - 500);
});

describe("Linken Sphere availability", () => {
  let stub: Server;
  let stubUrl: string;
  beforeAll(async () => {
    stub = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("[]"));
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  });

  test("[REQ-AGENT-003] every heartbeat reports whether the Local API answers", async () => {
    const agent = await newAgent("mac-ls");
    const running = startAgent({ serverUrl: baseUrl, agentKey: agent.agentKey, provider: new LinkenSphereProvider({ apiUrl: stubUrl }), providerName: "linken-sphere", maxSessions: 1, dataDir: tmpdir(), log: () => {} });
    await until("LS up", () => agentView(agent.agentId), (a) => a.heartbeat?.lsAvailable === true);
    await new Promise((r) => stub.close(r));
    stub.closeAllConnections();
    await until("LS down", () => agentView(agent.agentId), (a) => a.heartbeat?.lsAvailable === false);
    running.stop();
  });
});

// plutil and launchd exist only on macOS; CI runs on Linux.
test.skipIf(process.platform !== "darwin")("[REQ-AGENT-002] the LaunchAgent starts the agent at login and restarts it after a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "bap-plist-"));
  const path = join(dir, "com.bap.agent.plist");
  writeFileSync(path, launchAgentPlist({ node: "/opt/homebrew/bin/node", cli: "/opt/bap/cli.ts", logFile: "/tmp/agent.log", env: { BAP_LS_API_URL: "http://127.0.0.1:41234" } }));
  execFileSync("plutil", ["-lint", path]);
  const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
  expect(json).toMatchObject({
    Label: "com.bap.agent",
    ProgramArguments: ["/opt/homebrew/bin/node", "/opt/bap/cli.ts", "start"],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    EnvironmentVariables: { BAP_LS_API_URL: "http://127.0.0.1:41234" },
  });
  expect(readFileSync(path, "utf8")).toContain("<key>StandardErrorPath</key>");
});
