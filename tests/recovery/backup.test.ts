// REQ-OPS-001: back up, lose the whole server (database and artifact store), restore onto clean
// containers and see the same history with the same screenshots.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { createDb, migrateToLatest } from "@bap/database";
import { buildScenarioBundle } from "@bap/engine";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, expect, test } from "vitest";
import { startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { dumpDatabase, mirrorStore, pruneDumps, restoreDatabase } from "../../apps/control-plane/src/backup.ts";
import { memoryStore, s3Store } from "../../apps/control-plane/src/storage.ts";
import { startTestSite } from "../support/test-site.ts";

const repo = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "bap-backup-"));
const containers: StartedTestContainer[] = [];
afterAll(async () => {
  await Promise.allSettled(containers.map((c) => c.stop()));
});

const seaweed = async () => {
  const c = await new GenericContainer("chrislusf/seaweedfs:4.50").withCommand(["server", "-s3", "-dir=/data"]).withExposedPorts(8333).withWaitStrategy(Wait.forHttp("/", 8333).forStatusCode(200)).start();
  containers.push(c);
  return c;
};
const postgres = async () => {
  const c = await new PostgreSqlContainer("postgres:17-alpine").start();
  containers.push(c);
  return c;
};
const s3Env = (prefix: string, c: StartedTestContainer, bucket: string) => ({
  [`${prefix}ENDPOINT`]: `http://${c.getHost()}:${c.getMappedPort(8333)}`,
  [`${prefix}BUCKET`]: bucket,
  [`${prefix}ACCESS_KEY_ID`]: "test",
  [`${prefix}SECRET_ACCESS_KEY`]: "test",
});
const s3Of = (c: StartedTestContainer, bucket: string) => s3Store({ endpoint: `http://${c.getHost()}:${c.getMappedPort(8333)}`, bucket, accessKeyId: "test", secretAccessKey: "test" });
const backupCli = (args: string[], env: Record<string, string>) => promisify(execFile)("node", [join(repo, "apps/control-plane/src/backup-cli.ts"), ...args], { env: { ...process.env, ...env } });

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

/** What the operator sees: runs with transitions, steps and screenshot bytes. */
async function history(app: App, cookie: string) {
  const get = async (url: string) => app.inject({ method: "GET", url, cookies: { bap_session: cookie } });
  const runs = (await get("/api/v1/runs")).json() as { id: string }[];
  return Promise.all(
    runs.map(async ({ id }) => {
      const run = (await get(`/api/v1/runs/${id}`)).json();
      const steps = (await get(`/api/v1/runs/${id}/steps`)).json() as { stepId: string; screenshotArtifactId: string }[];
      const shots = await Promise.all(steps.map(async (s) => (await get(`/api/v1/runs/${id}/artifacts/${s.screenshotArtifactId}/content`)).rawPayload.toString("base64")));
      return { id, status: run.status, transitions: run.transitions, steps, shots };
    }),
  );
}
const login = async (app: App) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;

test("[REQ-OPS-001] a backup restored onto a clean server shows the same history with the same screenshots", async () => {
  const site = await startTestSite();
  const [pgA, s3A, s3External] = await Promise.all([postgres(), seaweed(), seaweed()]);

  // 1. A server with history: a real run through a real agent, screenshots in S3.
  const dbA = createDb(pgA.getConnectionUri());
  await migrateToLatest(dbA);
  await ensureOperator(dbA, "operator", "pw");
  const storeA = await s3Of(s3A, "bap");
  const appA = buildApp({ db: dbA, store: storeA, secureCookies: false, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 } });
  const urlA = await appA.listen({ host: "127.0.0.1", port: 0 });
  const cookieA = await login(appA);
  const api = (method: "GET" | "POST", url: string, payload?: object) =>
    appA.inject({ method, url, payload, cookies: { bap_session: cookieA }, headers: url === "/api/v1/runs" ? { "idempotency-key": randomUUID() } : {} });
  const manifest = await buildScenarioBundle(join(repo, "scenarios/staging-smoke-test/index.ts"), join(work, "bundles"));
  await storeA.put("scenarios/smoke.mjs", readFileSync(join(work, "bundles", manifest.file)), "text/javascript");
  await api("POST", "/api/v1/scenarios/staging-smoke-test/versions", { version: manifest.version, sha256: manifest.sha256, bundleKey: "scenarios/smoke.mjs" });
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentId, agentKey } = (await appA.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-backup", platform: "darwin", architecture: "arm64" } })).json();
  const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
  provider.createProfile("p1");
  const agent = startAgent({ serverUrl: urlA, agentKey, provider, providerName: "local-chromium", maxSessions: 1, dataDir: join(work, "agent"), log: () => {} });
  await until("agent", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.maxSessions === 1);
  const profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "p1", name: "P1" })).json().id;
  const { runId } = (await api("POST", "/api/v1/runs", { scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site.url } })).json();
  await until("run", async () => (await api("GET", `/api/v1/runs/${runId}`)).json(), (r) => r.status === "SUCCEEDED");
  agent.stop();
  const before = await history(appA, cookieA);
  expect(before[0]!.shots).toHaveLength(3);

  // 2. The daily backup, exactly as cron runs it.
  const backupDir = join(work, "backups");
  const env = { ...s3Env("S3_", s3A, "bap"), ...s3Env("BACKUP_S3_", s3External, "bap-backup"), BACKUP_DIR: backupDir };
  const { stdout } = await backupCli(["backup"], { ...env, PG_DUMP_CMD: `docker exec -i ${pgA.getId()} pg_dump -U ${pgA.getUsername()} --format=custom ${pgA.getDatabase()}` });
  const report = JSON.parse(stdout);
  expect(report.bytes).toBeGreaterThan(10_000);
  expect(report.objects.copied).toBe(4); // the bundle and three screenshots

  // 3. The server is lost: database and artifact store are gone.
  await appA.close();
  await dbA.destroy();
  await Promise.all([pgA.stop(), s3A.stop()]);

  // 4. A clean server, restored from the dump and the external mirror.
  const [pgB, s3B] = await Promise.all([postgres(), seaweed()]);
  const dump = join(backupDir, readdirSync(backupDir).find((f) => f.endsWith(".dump"))!);
  await backupCli(["restore", dump], { ...env, ...s3Env("S3_", s3B, "bap"), PG_RESTORE_CMD: `docker exec -i ${pgB.getId()} pg_restore --clean --if-exists --no-owner -U ${pgB.getUsername()} -d ${pgB.getDatabase()}` });
  const dbB = createDb(pgB.getConnectionUri());
  expect(await migrateToLatest(dbB)).toEqual([]); // the schema came with the dump
  const appB = buildApp({ db: dbB, store: await s3Of(s3B, "bap"), secureCookies: false });
  try {
    const after = await history(appB, await login(appB));
    expect(after).toEqual(before);
    if (process.env.BAP_EVIDENCE) {
      const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
      const summary = (h: typeof before) => h.map((r) => ({ run: r.id, status: r.status, transitions: r.transitions.map((t: { to: string }) => t.to).join(" → "), screenshotsSha256: r.shots.map(sha) }));
      const out = join(repo, "docs/evidence/S9");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "backup-restore.json"),
        JSON.stringify({ at: new Date().toISOString(), backup: report, lost: ["postgres container A", "S3 container A"], restoredOnto: ["clean postgres container B", "clean S3 container B"], before: summary(before), after: summary(after), identical: true }, null, 2) + "\n",
      );
    }
  } finally {
    await appB.close();
    await dbB.destroy();
    await site.stop();
  }
}, 300_000);

test("[REQ-OPS-001] the mirror copies only what the target lacks, and old dumps are pruned", async () => {
  const [source, target] = [memoryStore(), memoryStore()];
  await source.put("a", Buffer.from("1"), "text/plain");
  await source.put("b", Buffer.from("2"), "text/plain");
  expect(await mirrorStore(source, target)).toEqual({ copied: 2, total: 2 });
  await source.put("c", Buffer.from("3"), "text/plain");
  expect(await mirrorStore(source, target)).toEqual({ copied: 1, total: 3 });
  expect((await target.get("c"))?.body.toString()).toBe("3");

  const dir = mkdtempSync(join(tmpdir(), "bap-dumps-"));
  for (const day of ["01", "02", "03", "04"]) writeFileSync(join(dir, `bap-2026-10-${day}T03-00-00-000Z.dump`), "PGDMP");
  writeFileSync(join(dir, "notes.txt"), "kept");
  expect(pruneDumps(dir, 2)).toEqual(["bap-2026-10-01T03-00-00-000Z.dump", "bap-2026-10-02T03-00-00-000Z.dump"]);
  expect(readdirSync(dir).sort()).toEqual(["bap-2026-10-03T03-00-00-000Z.dump", "bap-2026-10-04T03-00-00-000Z.dump", "notes.txt"]);
});

test("[REQ-OPS-001] a dump command that fails or writes no custom-format dump fails the backup loudly and leaves no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bap-dumps-"));
  const run = (cmd: string) => backupCli(["backup"], { BACKUP_DIR: dir, PG_DUMP_CMD: cmd, BACKUP_S3_ENDPOINT: "x", BACKUP_S3_BUCKET: "x", BACKUP_S3_ACCESS_KEY_ID: "x", BACKUP_S3_SECRET_ACCESS_KEY: "x" });
  await expect(run("echo 'connection refused' >&2; exit 2")).rejects.toThrow(/backup failed: `echo` exited with 2: connection refused/);
  await expect(run("echo 'CREATE TABLE plain_sql'")).rejects.toThrow(/did not produce a custom-format dump/);
  expect(readdirSync(dir)).toEqual([]);
});

test("[REQ-OPS-001] a dump lands in its file only when complete; a restore reads the dump on stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bap-dumps-"));
  const file = join(dir, "bap-test.dump");
  expect(await dumpDatabase("printf 'PGDMP fake dump'", file)).toBe(15);
  await restoreDatabase(`cat > ${join(dir, "restored")}`, file);
  expect(readFileSync(join(dir, "restored"), "utf8")).toBe("PGDMP fake dump");
  await expect(dumpDatabase("printf 'PGDMP partial'; exit 3", join(dir, "broken.dump"))).rejects.toThrow(/exited with 3/);
  expect(existsSync(join(dir, "broken.dump"))).toBe(false);
  expect(existsSync(join(dir, "broken.dump.partial"))).toBe(false);
});
