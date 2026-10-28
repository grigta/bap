// Full panel stack for e2e: PostgreSQL (Testcontainers) + Control Plane + Vite dev server.
// A control port lets tests stop and start the Control Plane to observe the UI reacting.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildScenarioBundle } from "@bap/engine";
import { createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer as createViteServer } from "vite";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { fakeShopModel } from "../support/fake-model.ts";
import { outageProxy } from "../support/outage-proxy.ts";
import { E2E_OPERATOR, STACK_FLEET, STACK_PORTS, STACK_SCHEDULER } from "./stack-config.ts";
import { withoutWarmup } from "../support/no-warmup.ts";

const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
// The Control Plane reaches PostgreSQL through a proxy, so fault tests can take the database away.
const pgProxy = outageProxy(postgres.getMappedPort(5432));
const pgUrl = new URL(postgres.getConnectionUri());
pgUrl.host = `127.0.0.1:${await pgProxy.listen()}`;
const db = createDb(pgUrl.toString());
await migrateToLatest(db);
await ensureOperator(db, E2E_OPERATOR.login, E2E_OPERATOR.password);
await withoutWarmup(db);

// One store for the whole stack: bundles and screenshots survive Control Plane restarts in tests.
const store = memoryStore();
const bundles = mkdtempSync(join(tmpdir(), "bap-stack-bundles-"));
const repo = resolve(import.meta.dirname, "../..");
const bundleKeys = new Map<string, string>();
for (const entry of ["scenarios/staging-smoke-test", "scenarios/wizard-order", "tests/fixtures/scenarios/crash-page", "tests/fixtures/scenarios/slow-page"]) {
  const manifest = await buildScenarioBundle(join(repo, entry, "index.ts"), bundles);
  const key = `scenarios/${manifest.file}`;
  await store.put(key, readFileSync(join(bundles, manifest.file)), "text/javascript");
  bundleKeys.set(manifest.id, key);
  await db.insertInto("scenarios").values({ id: manifest.id }).execute();
  await db.insertInto("scenario_versions").values({ scenario_id: manifest.id, version: manifest.version, sha256: manifest.sha256, bundle_key: key }).execute();
}

let app: App | null = null;
async function startControlPlane() {
  if (app) return;
  // Recording and healing talk to a stand-in model that knows the shapeshift shop (Claude in production).
  app = buildApp({ db, store, secureCookies: false, fleet: STACK_FLEET, scheduler: STACK_SCHEDULER, model: fakeShopModel() });
  await app.listen({ host: "127.0.0.1", port: STACK_PORTS.controlPlane });
}
async function stopControlPlane() {
  await app?.close();
  app = null;
}
await startControlPlane();

process.env.WEB_PORT = String(STACK_PORTS.web);
process.env.CONTROL_PLANE_URL = `http://127.0.0.1:${STACK_PORTS.controlPlane}`;
const web = await createViteServer({ root: resolve(import.meta.dirname, "../../apps/web"), logLevel: "warn" });
await web.listen();

// Fault and security demos: take the database away; expire open invitations; swap a bundle in storage for other bytes and back.
const originals = new Map<string, Buffer>();
createHttpServer(async (req, res) => {
  const bundle = /^\/bundles\/([\w-]+)\/(tamper|restore)$/.exec(req.url ?? "");
  if (req.method === "POST" && req.url === "/control-plane/stop") await stopControlPlane();
  else if (req.method === "POST" && req.url === "/control-plane/start") await startControlPlane();
  else if (req.method === "POST" && req.url === "/database/down") pgProxy.down();
  else if (req.method === "POST" && req.url === "/database/up") pgProxy.up();
  else if (req.method === "GET" && req.url?.startsWith("/llm-calls?run=")) {
    // Model calls are counted on the server only, never shown in the panel (ADR-0025).
    const runId = new URL(req.url, "http://x").searchParams.get("run")!;
    const { n } = await db.selectFrom("llm_calls").select(db.fn.countAll<string>().as("n")).where("run_id", "=", runId).executeTakeFirstOrThrow();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ calls: Number(n) }));
  } else if (req.method === "POST" && req.url === "/enrollments/expire")
    await db.updateTable("agent_enrollments").set({ expires_at: new Date(Date.now() - 1000) }).where("used_at", "is", null).execute();
  else if (req.method === "POST" && bundle && bundleKeys.has(bundle[1]!)) {
    const key = bundleKeys.get(bundle[1]!)!;
    if (!originals.has(key)) originals.set(key, (await store.get(key))!.body);
    await store.put(key, bundle[2] === "tamper" ? Buffer.from("export default {} // tampered") : originals.get(key)!, "text/javascript");
  } else return res.writeHead(404).end();
  res.writeHead(204).end();
}).listen(STACK_PORTS.control, "127.0.0.1");

const shutdown = async () => {
  await Promise.allSettled([stopControlPlane(), web.close()]);
  await db.destroy();
  await postgres.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`stack ready: web http://127.0.0.1:${STACK_PORTS.web}`);
