// Full panel stack for e2e: PostgreSQL (Testcontainers) + Control Plane + Vite dev server.
// A control port lets tests stop and start the Control Plane to observe the UI reacting.
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer as createViteServer } from "vite";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { E2E_OPERATOR, STACK_PORTS } from "./stack-config.ts";

const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
const db = createDb(postgres.getConnectionUri());
await migrateToLatest(db);
await ensureOperator(db, E2E_OPERATOR.login, E2E_OPERATOR.password);

let app: App | null = null;
async function startControlPlane() {
  if (app) return;
  app = buildApp({ db, secureCookies: false });
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
