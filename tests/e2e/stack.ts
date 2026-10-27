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
import { E2E_OPERATOR, STACK_FLEET, STACK_PORTS } from "./stack-config.ts";

const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
const db = createDb(postgres.getConnectionUri());
await migrateToLatest(db);
await ensureOperator(db, E2E_OPERATOR.login, E2E_OPERATOR.password);

// One store for the whole stack: bundles and screenshots survive Control Plane restarts in tests.
const store = memoryStore();
const bundles = mkdtempSync(join(tmpdir(), "bap-stack-bundles-"));
const repo = resolve(import.meta.dirname, "../..");
for (const entry of ["scenarios/staging-smoke-test", "scenarios/wizard-order", "tests/fixtures/scenarios/crash-page", "tests/fixtures/scenarios/slow-page"]) {
  const manifest = await buildScenarioBundle(join(repo, entry, "index.ts"), bundles);
  const key = `scenarios/${manifest.file}`;
  await store.put(key, readFileSync(join(bundles, manifest.file)), "text/javascript");
  await db.insertInto("scenarios").values({ id: manifest.id }).execute();
  await db.insertInto("scenario_versions").values({ scenario_id: manifest.id, version: manifest.version, sha256: manifest.sha256, bundle_key: key }).execute();
}

let app: App | null = null;
async function startControlPlane() {
  if (app) return;
  app = buildApp({ db, store, secureCookies: false, fleet: STACK_FLEET });
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

createHttpServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/control-plane/stop") await stopControlPlane();
  else if (req.method === "POST" && req.url === "/control-plane/start") await startControlPlane();
  else return res.writeHead(404).end();
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
