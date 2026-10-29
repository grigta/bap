import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { type IncomingHttpHeaders, type RequestListener, type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { issueRunToken } from "../../apps/control-plane/src/providers.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const FAKE = readFileSync(resolve(import.meta.dirname, "../fixtures/ls-clicker/fake-ls-clicker.mjs"));
const API_ANYTHING = resolve(import.meta.dirname, "../fixtures/api-anything/fake-api-anything.mjs");
const GOTSMS_KEY = "gotsms-key-only-on-the-server";
const RUCAPTCHA_KEY = "rucaptcha-key-only-on-the-server";
const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let bare: App;
let baseUrl: string;
let cookie: string;
let agent: RunningAgent;
let agentId: string;
let dir: string;
let logs = "";
const upstream: Server[] = [];
const seen: { gotsms: { method: string; url: string; headers: IncomingHttpHeaders }[]; rucaptcha: string[] } = { gotsms: [], rucaptcha: [] };

const listen = async (handler: RequestListener) => {
  const s = createServer(handler);
  upstream.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};
const call = (path: string, token: string | null, payload?: object) =>
  app.inject({ method: payload ? "POST" : "GET", url: `/api/v1/providers/${path}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function until<T>(what: string, read: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

beforeAll(async () => {
  const gotsms = await listen(async (req, res) => {
    seen.gotsms.push({ method: req.method!, url: req.url!, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ balance: 12.5, path: req.url }));
  });
  const rucaptcha = await listen(async (req, res) => {
    seen.rucaptcha.push(req.url!);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: 1, request: "7" }));
  });
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  const stream = new Writable({ write: (chunk, _enc, done) => void ((logs += String(chunk)), done()) });
  app = buildApp({
    db,
    store: memoryStore(),
    secureCookies: false,
    fleet: FLEET,
    logger: { stream },
    providers: { gotsms: { url: gotsms, key: GOTSMS_KEY }, rucaptcha: { url: rucaptcha, key: RUCAPTCHA_KEY }, spokeo: { bin: API_ANYTHING, home: "/srv/spokeo-session" } },
  });
  bare = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET });
  await bare.ready();
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object | Buffer, contentType?: string) =>
    app.inject({ method, url, payload, cookies: { bap_session: cookie }, ...(contentType && { headers: { "content-type": contentType } }) });
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const enrolled = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-keys", platform: "darwin", architecture: "arm64" } })).json();
  agentId = enrolled.agentId;
  dir = join(mkdtempSync(join(tmpdir(), "bap-keys-")), "ls-clicker");
  agent = startAgent({ serverUrl: baseUrl, agentKey: enrolled.agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: mkdtempSync(join(tmpdir(), "bap-keys-agent-")), log: () => {}, model: null, lsClickerDir: dir });
  await api("POST", "/api/v1/ls-clicker/builds", FAKE, "application/octet-stream");
  const sha = createHash("sha256").update(FAKE).digest("hex");
  await until("build installed", async () => (await api("GET", "/api/v1/ls-clicker")).json().macs[0]?.state.sha256, (s) => s === sha);
  await api("POST", "/api/v1/pipeline/import?name=t.csv", Buffer.from("who,company\nann,Acme\n"), "text/csv");
  // A row runs only with its proxy («wait info» otherwise).
  await api("PATCH", "/api/v1/pipeline/rows/1", { proxy: "10.9.9.9:1080" });
  expect((await api("POST", `/api/v1/agents/${agentId}/ls-clicker/runs`)).statusCode).toBe(202);
});

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await bare?.close();
  await db?.destroy();
  await postgres?.stop();
  for (const s of upstream) s.close();
});

describe("LS Clicker's providers through the server", () => {
  test("[REQ-LSC-005] a run reaches GotSMS and Spokeo through the server with its token; the key is added by the server and never reaches the Mac", async () => {
    const answer = await until("the engine called its providers", () => {
      try {
        return JSON.parse(readFileSync(join(dir, "provider.json"), "utf8"));
      } catch {
        return null;
      }
    }, (v) => v !== null);
    expect(answer.server).toBe(baseUrl);
    expect(answer.gotsms).toEqual({ status: 200, body: { balance: 12.5, path: "/api/account" } });
    expect(answer.spokeo).toEqual({ status: 200, body: { ok: true, data: { owner: "" }, home: "/srv/spokeo-session" } });
    expect(seen.gotsms.at(-1)).toMatchObject({ method: "GET", url: "/api/account", headers: { authorization: `Bearer ${GOTSMS_KEY}` } });
    // Nothing on the Mac knows the key: not the engine's environment, not its files.
    expect(JSON.stringify(answer)).not.toContain(GOTSMS_KEY);
    expect(logs).not.toContain(GOTSMS_KEY);
  });

  test("[REQ-LSC-005] RuCaptcha gets the server's key in place of any the engine sends; GotSMS paths, queries and bodies pass as they are", async () => {
    const token = await issueRunToken(db, agentId);
    const created = await call("rucaptcha/in.php?method=userrecaptcha&googlekey=site-key&pageurl=https%3A%2F%2Fexample.com&enterprise=1&json=1&key=from-the-mac", token);
    expect(created.json()).toEqual({ status: 1, request: "7" });
    const sent = new URL(`http://x${seen.rucaptcha.at(-1)}`);
    expect(sent.pathname).toBe("/in.php");
    expect(Object.fromEntries(sent.searchParams)).toEqual({ method: "userrecaptcha", googlekey: "site-key", pageurl: "https://example.com", enterprise: "1", json: "1", key: RUCAPTCHA_KEY });
    expect(created.body).not.toContain(RUCAPTCHA_KEY);
    expect((await call("rucaptcha/res.php?action=getbalance&json=1", token)).statusCode).toBe(200);
    expect((await call("rucaptcha/../etc/passwd", token)).statusCode).toBeGreaterThanOrEqual(400);

    await app.inject({ method: "POST", url: "/api/v1/providers/gotsms/api/rents/bulk?x=1", payload: { quantity: 1 }, headers: { authorization: `Bearer ${token}` } });
    expect(seen.gotsms.at(-1)).toMatchObject({ method: "POST", url: "/api/rents/bulk?x=1" });
  });

  test("[REQ-LSC-006] only a live run token opens the providers; a phone that is not a phone is refused; a server without keys says so", async () => {
    expect((await call("gotsms/api/account", null)).statusCode).toBe(401);
    expect((await call("gotsms/api/account", "made-up-token")).statusCode).toBe(401);
    // The run is over and the token is no longer fresh: refused.
    await until("run over", async () => (await db.selectFrom("agents").select("last_heartbeat").where("id", "=", agentId).executeTakeFirstOrThrow()).last_heartbeat as { lsClicker: { run: { running: boolean } } }, (h) => h.lsClicker.run.running === false);
    const old = await issueRunToken(db, agentId);
    await db.updateTable("lsclicker_tokens").set({ created_at: new Date(Date.now() - 5 * 60_000) }).execute();
    expect((await call("gotsms/api/account", old)).statusCode).toBe(401);
    // Expired tokens are refused whatever the run does.
    const expired = await issueRunToken(db, agentId);
    await db.updateTable("lsclicker_tokens").set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect((await call("gotsms/api/account", expired)).statusCode).toBe(401);

    const fresh = await issueRunToken(db, agentId);
    expect((await call("spokeo/phone-lookup", fresh, { phone: "415-712-3489; rm -rf /" })).statusCode).toBe(400);
    expect((await call("spokeo/phone-lookup", fresh, { phone: "$(id)" })).statusCode).toBe(400);
    // A server without the keys: 503, the token is fine.
    const without = await bare.inject({ method: "GET", url: "/api/v1/providers/gotsms/api/account", headers: { authorization: `Bearer ${fresh}` } });
    expect(without.statusCode).toBe(503);
    expect(without.json().error.code).toBe("PROVIDER_NOT_CONFIGURED");
    // The engine's own calls stay out of the journal; refused attempts are in it, as any refused call.
    const journal = await db.selectFrom("audit_events").select(["action", "outcome"]).where("action", "like", "%/providers/%").execute();
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e) => e.outcome === "denied")).toBe(true);
  });
});
