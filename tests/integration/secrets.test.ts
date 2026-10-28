import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startAgent } from "../../apps/mac-agent/src/agent.ts";
import { buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { type ObjectStore, memoryStore } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

/** Returns where each secret occurs in the given sources (empty when none leaked). */
export function findSecrets(secrets: Record<string, string>, sources: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [secretName, secret] of Object.entries(secrets))
    for (const [sourceName, text] of Object.entries(sources)) if (text.includes(secret)) hits.push(`${secretName} in ${sourceName}`);
  return hits;
}

const listFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? listFiles(join(dir, f)) : [join(dir, f)]));

let postgres: StartedPostgreSqlContainer;
let db: Db;
let site: Awaited<ReturnType<typeof startTestSite>>;
afterAll(async () => {
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});
beforeAll(async () => {
  site = await startTestSite();
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
});

test("the scanner finds a planted secret (positive control)", () => {
  expect(findSecrets({ token: "planted-7c1e" }, { "log": "... Bearer planted-7c1e ...", "clean": "nothing" })).toEqual(["token in log"]);
});

test("[REQ-SEC-008] passwords, tokens and agent keys never reach logs, artifacts or tables", async () => {
  const work = mkdtempSync(join(tmpdir(), "bap-secrets-"));
  const cpLog = new PassThrough();
  let cpLogText = "";
  cpLog.on("data", (chunk) => (cpLogText += chunk));
  const agentLog: string[] = [];
  const stored = new Map<string, Buffer>();
  const base = memoryStore();
  const store: ObjectStore = { put: async (k, b, t) => (stored.set(k, b), base.put(k, b, t)), get: (k) => base.get(k), delete: (k) => base.delete(k) };

  const operatorPassword = `Operator-Pass-${randomUUID()}`;
  await ensureOperator(db, "operator", operatorPassword);
  const app = buildApp({ db, store, secureCookies: false, logger: { stream: cpLog }, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 } });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const ok = async (res: Promise<Response>) => {
    const r = await res;
    if (!r.ok) throw new Error(`${r.url} ${r.status} ${await r.text()}\n${cpLogText.split("\n").filter((l) => l.includes("\"level\":50")).join("\n")}`);
    return r.json();
  };
  const login = async (password: string) => fetch(`${baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "operator", password }) });
  await login("a-wrong-password-attempt");
  const session = (await login(operatorPassword)).headers.getSetCookie()[0]!.split(";")[0]!;
  const asOperator = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}/api/v1${path}`, { ...init, headers: { cookie: session, "content-type": "application/json", ...init.headers } });

  const apiToken = (await ok(asOperator("/auth/tokens", { method: "POST", body: JSON.stringify({ name: "ci" }) }))).token as string;
  const viaToken = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", ...init.headers } });
  const invite = (await ok(viaToken("/agents/enrollments", { method: "POST", body: "{}" }))).token as string;
  const enrolled = await ok(fetch(`${baseUrl}/api/v1/agents/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite, name: "mac-secrets", platform: "darwin", architecture: "arm64" }) }));
  await fetch(`${baseUrl}/api/v1/agents/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite, name: "mac-reuse", platform: "darwin", architecture: "arm64" }) });

  const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
  provider.createProfile("p1");
  let rotatedKey = "";
  const agent = startAgent({
    serverUrl: baseUrl,
    agentKey: enrolled.agentKey,
    provider,
    providerName: "local-chromium",
    maxSessions: 1,
    dataDir: join(work, "agent"),
    log: (line) => agentLog.push(line),
    onKeyRotated: (key) => (rotatedKey = key),
  });
  const waitFor = async (what: string, check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) if (await check()) return;
    else await sleep(100);
    throw new Error(`timed out waiting for ${what}; agent log:\n${agentLog.join("\n")}`);
  };

  await waitFor("agent capabilities", async () => (await (await viaToken(`/agents/${enrolled.agentId}`)).json()).maxSessions === 1);

  const manifest = await buildScenarioBundle(resolve(import.meta.dirname, "../../scenarios/staging-smoke-test/index.ts"), join(work, "bundles"));
  await store.put("smoke.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await ok(viaToken("/scenarios/staging-smoke-test/versions", { method: "POST", body: JSON.stringify({ version: manifest.version, sha256: manifest.sha256, bundleKey: "smoke.mjs" }) }));
  const profileId = (await ok(viaToken("/profiles/import", { method: "POST", body: JSON.stringify({ agentId: enrolled.agentId, externalProfileId: "p1", name: "P1" }) }))).id;
  const runId = (await ok(viaToken("/runs", { method: "POST", headers: { "idempotency-key": randomUUID() }, body: JSON.stringify({ scenarioId: "staging-smoke-test", scenarioVersion: manifest.version, profileId, input: { baseUrl: site.url } }) }))).runId;
  await waitFor("run to succeed", async () => (await ok(viaToken(`/runs/${runId}`))).status === "SUCCEEDED");

  await ok(viaToken(`/agents/${enrolled.agentId}/rotate-key`, { method: "POST", body: "{}" }));
  await waitFor("key rotation", async () => rotatedKey !== "");
  await waitFor("reconnect with the new key", async () => (await ok(viaToken(`/agents/${enrolled.agentId}`))).connection === "ONLINE");
  agent.stop();
  await app.close();

  const tables = await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(db);
  const sources: Record<string, string> = { "control-plane log": cpLogText, "agent log": agentLog.join("\n") };
  for (const { table_name } of tables.rows) sources[`table ${table_name}`] = JSON.stringify((await sql`SELECT * FROM ${sql.table(table_name)}`.execute(db)).rows);
  for (const [key, body] of stored) sources[`object ${key}`] = body.toString("latin1");
  for (const file of listFiles(join(work, "agent"))) sources[`agent file ${file.slice(work.length)}`] = readFileSync(file).toString("latin1");

  expect(cpLogText.length).toBeGreaterThan(1000); // the log really covers the flow
  expect(Object.keys(sources).filter((s) => s.startsWith("object runs/")).length).toBe(3);
  expect(rotatedKey).not.toBe("");
  expect(findSecrets({ operatorPassword, wrongPassword: "a-wrong-password-attempt", apiToken, invite, agentKey: enrolled.agentKey, rotatedKey }, sources)).toEqual([]);
}, 120_000);
