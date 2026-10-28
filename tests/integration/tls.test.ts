import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const work = mkdtempSync(join(tmpdir(), "bap-tls-"));
const certFile = join(work, "cert.pem");
const keyFile = join(work, "key.pem");

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let baseUrl: string;
let agentProcess: ChildProcess | null = null;

beforeAll(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), https: { cert: readFileSync(certFile), key: readFileSync(keyFile) }, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 } });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 120_000);

afterAll(async () => {
  agentProcess?.kill("SIGKILL");
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

/** GET over TLS trusting only the test certificate. */
const get = (path: string) =>
  new Promise<{ status: number; headers: Record<string, unknown> }>((ok, fail) =>
    request(`${baseUrl}${path}`, { ca: readFileSync(certFile) }, (res) => {
      res.resume();
      ok({ status: res.statusCode!, headers: res.headers });
    })
      .on("error", fail)
      .end(),
  );

test("[REQ-SEC-001] the Control Plane serves HTTPS with HSTS and does not answer plain HTTP", async () => {
  expect(baseUrl).toMatch(/^https:\/\//);
  const health = await get("/api/v1/health");
  expect(health.status).toBe(200);
  expect(health.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  await expect(fetch(baseUrl.replace("https:", "http:") + "/api/v1/health")).rejects.toThrow();
});

test("[REQ-SEC-001] a real agent process enrolls and connects over HTTPS/WSS", async () => {
  const cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await app.inject({ method: "POST", url: "/api/v1/agents/enrollments", cookies: { bap_session: cookie } })).json();
  const data = mkdtempSync(join(tmpdir(), "bap-tls-agent-"));
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_LS_API_URL: "", BAP_KEY_STORAGE: "file", NODE_EXTRA_CA_CERTS: certFile };
  // Asynchronous: the server runs in this process and must keep answering.
  await promisify(execFile)("node", [cli, "enroll", "--server", baseUrl, "--token", token, "--name", "mac-tls"], { env });
  agentProcess = spawn("node", [cli, "start"], { env, stdio: "pipe" });
  const agentId = JSON.parse(readFileSync(join(data, "agent.json"), "utf8")).agentId;
  let connection = "";
  for (let i = 0; i < 100 && connection !== "ONLINE"; i++) {
    connection = (await app.inject({ method: "GET", url: `/api/v1/agents/${agentId}`, cookies: { bap_session: cookie } })).json().connection;
    await sleep(100);
  }
  expect(connection).toBe("ONLINE");
}, 60_000);

test("[REQ-SEC-001] the agent refuses an unencrypted server address other than this Mac", () => {
  const data = mkdtempSync(join(tmpdir(), "bap-tls-agent-"));
  writeFileSync(join(data, "agent.json"), JSON.stringify({ serverUrl: "http://192.0.2.10:3000", agentId: "a", agentKey: "k", name: "insecure" }));
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_LS_API_URL: "", BAP_KEY_STORAGE: "file" };
  expect(() => execFileSync("node", [cli, "start"], { env, stdio: "pipe", timeout: 10_000 })).toThrow(/HTTPS/);
  expect(() => execFileSync("node", [cli, "enroll", "--server", "http://192.0.2.10:3000", "--token", "t", "--name", "n"], { env, stdio: "pipe", timeout: 10_000 })).toThrow(/HTTPS/);
});
