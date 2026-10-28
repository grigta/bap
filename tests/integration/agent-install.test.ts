// The one-line installer, end to end: the command from the panel, piped into bash, against a
// Control Plane with a self-signed certificate (as behind `pnpm gateway`). Node download, npm and
// the LaunchAgent are swapped for local equivalents; everything else is the real script.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { installScript } from "../../apps/control-plane/src/agent-install.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const work = mkdtempSync(join(tmpdir(), "bap-install-"));
const certFile = join(work, "cert.pem");
const keyFile = join(work, "key.pem");
const playwrightCore = dirname(createRequire(resolve(import.meta.dirname, "../../packages/browser-adapters/package.json")).resolve("playwright-core/package.json"));

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let cookie: string;
let agent: ChildProcess | null = null;

const sh = promisify(execFile);
const pinOf = (pem: string) => `sha256//${createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;

beforeAll(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), https: { cert: readFileSync(certFile), key: readFileSync(keyFile) }, fleet: { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000 } });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  // What `pnpm gateway` writes; the Control Plane reads it on every request.
  writeFileSync(join(work, "gateway.json"), JSON.stringify({ publicUrl: baseUrl, pin: pinOf(readFileSync(certFile, "utf8")), certFile }));
  process.env.BAP_GATEWAY_FILE = join(work, "gateway.json");
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
}, 120_000);

afterAll(async () => {
  agent?.kill("SIGKILL");
  delete process.env.BAP_GATEWAY_FILE;
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

const invite = async () => (await app.inject({ method: "POST", url: "/api/v1/agents/enrollments", cookies: { bap_session: cookie } })).json() as { id: string; token: string; installCommand: string | null };

/** A Mac's home with Node "already installed" and playwright-core "already downloaded". */
function freshMac(name: string) {
  const home = join(work, name);
  mkdirSync(join(home, ".bap/app/node_modules"), { recursive: true });
  symlinkSync(playwrightCore, join(home, ".bap/app/node_modules/playwright-core"));
  return {
    home,
    env: { ...process.env, HOME: home, BAP_HOME: join(home, ".bap"), BAP_NODE: process.execPath, BAP_SKIP_NPM: "1", BAP_NO_LAUNCHAGENT: "1", BAP_SKIP_POWER: "1", BAP_ALLOW_NON_MAC: "1", BAP_KEY_STORAGE: "file", BAP_NAME: name },
  };
}
const install = (command: string, env: NodeJS.ProcessEnv) => sh("bash", ["-c", command], { env, timeout: 120_000 });

test("the command from the panel installs, registers and connects a Mac in one go; running it again changes nothing", async () => {
  const first = await invite();
  expect(first.installCommand).toMatch(/^curl -fsSL --pinnedpubkey 'sha256\/\/[\w+/=]+' -k 'https:\/\/127\.0\.0\.1:\d+\/install\.sh' \| bash -s -- 'bapi_[\w-]+'$/);
  const mac = freshMac("mac-installed");
  const { stdout } = await install(first.installCommand!, mac.env);
  expect(stdout).toContain("6/6");
  expect(stdout).toContain("настройка питания пропущена");
  expect(stdout).toContain("зарегистрирован");
  const bap = join(mac.home, ".bap");
  expect(readFileSync(join(bap, "server-ca.pem"), "utf8")).toBe(readFileSync(certFile, "utf8"));
  const config = JSON.parse(readFileSync(join(bap, "agent.json"), "utf8"));
  expect(config).toMatchObject({ name: "mac-installed", serverUrl: expect.stringMatching(/^https:/) });

  // The installed wrapper runs the agent; over HTTPS with the pinned certificate it comes online.
  agent = spawn(join(bap, "bin/bap-agent"), ["start"], { env: { ...mac.env, BAP_LS_API_URL: "" }, stdio: "ignore" });
  let connection = "";
  for (let i = 0; i < 100 && connection !== "ONLINE"; i++) {
    connection = (await app.inject({ method: "GET", url: `/api/v1/agents/${config.agentId}`, cookies: { bap_session: cookie } })).json().connection;
    await sleep(100);
  }
  expect(connection).toBe("ONLINE");
  const status = (await app.inject({ method: "GET", url: `/api/v1/agents/enrollments/${first.id}`, cookies: { bap_session: cookie } })).json();
  expect(status).toMatchObject({ usedAt: expect.any(String), agent: { id: config.agentId, name: "mac-installed", connection: "ONLINE" } });

  // Again, with a new invitation: already registered, the invitation stays unused, no second agent.
  const again = await invite();
  const rerun = await install(again.installCommand!, mac.env);
  expect(rerun.stdout).toContain("уже зарегистрирован");
  const agents = (await app.inject({ method: "GET", url: "/api/v1/agents", cookies: { bap_session: cookie } })).json();
  expect(agents.filter((a: { name: string }) => a.name.startsWith("mac-installed"))).toHaveLength(1);

  // The server moves (same database, new address): the registration stays, only the address changes.
  const gateway = JSON.parse(readFileSync(join(work, "gateway.json"), "utf8"));
  writeFileSync(join(work, "gateway.json"), JSON.stringify({ ...gateway, publicUrl: gateway.publicUrl.replace("127.0.0.1", "localhost") }));
  const moved = await install((await invite()).installCommand!, mac.env);
  expect(moved.stdout).toContain("уже зарегистрирован");
  expect(JSON.parse(readFileSync(join(bap, "agent.json"), "utf8"))).toMatchObject({ agentId: config.agentId, serverUrl: expect.stringMatching(/^https:\/\/localhost:/) });
  writeFileSync(join(work, "gateway.json"), JSON.stringify(gateway));

  // Revoked and deleted in the panel: the same command with a new invitation registers the Mac again.
  agent?.kill("SIGKILL");
  agent = null;
  await app.inject({ method: "POST", url: `/api/v1/agents/${config.agentId}/revoke`, cookies: { bap_session: cookie } });
  await app.inject({ method: "DELETE", url: `/api/v1/agents/${config.agentId}`, cookies: { bap_session: cookie } });
  const fresh = await invite();
  const reinstall = await install(fresh.installCommand!, mac.env);
  expect(reinstall.stdout).toContain("ключ этого Mac отозван, регистрирую заново");
  const reconfig = JSON.parse(readFileSync(join(bap, "agent.json"), "utf8"));
  expect(reconfig.agentId).not.toBe(config.agentId);
  expect(reconfig.name).toBe("mac-installed");

  // The agent updates itself from the server with its own key.
  const update = await sh(join(bap, "bin/bap-agent"), ["update"], { env: mac.env });
  expect(update.stdout).toMatch(/updated to [0-9a-f]{12}/);
}, 180_000);

test("a used or made-up invitation stops the installer with a clear message and nothing registered", async () => {
  const { installCommand } = await invite();
  const forged = installCommand!.replace(/'bapi_[\w-]+'$/, "'bapi_made-up'");
  const mac = freshMac("mac-forged");
  const failed = await install(forged, mac.env).then(() => null, (e: { code: number; stderr: string }) => e);
  expect(failed?.code).toBe(1);
  expect(failed?.stderr).toContain("Приглашение недействительно");
  expect(existsSync(join(mac.home, ".bap/agent.json"))).toBe(false);
});

test("[REQ-SEC-001] the installer only talks to the server whose key it pins", async () => {
  const { installCommand } = await invite();
  const wrongPin = installCommand!.replace(/sha256\/\/[\w+/=]+/, `sha256//${Buffer.alloc(32).toString("base64")}`);
  const mac = freshMac("mac-mitm");
  // curl refuses before anything is downloaded; bash then gets an empty script and does nothing.
  const result = await install(wrongPin, mac.env).catch((e: { stderr: string }) => e);
  expect(result.stderr).toMatch(/pinned|public key/i);
  expect(existsSync(join(mac.home, ".bap/bin/bap-agent"))).toBe(false);
});

test("the installer script carries no secrets and no invitation", () => {
  const script = installScript({ endpoint: { url: "https://bore.pub:12345", pin: "sha256//abc=", caPem: "PEM" }, nodeVersion: "26.8.1", playwrightVersion: "1.64.1" });
  expect(script).toContain("SERVER='https://bore.pub:12345'");
  expect(script).toContain("PIN='sha256//abc='");
  expect(script).not.toMatch(/bapi_|PEM/);
  // Power: sudo asks on the terminal (the script itself arrives on stdin) and the lid-closed setting is included.
  expect(script).toContain("sudo -v < /dev/tty");
  expect(script).toContain("pmset -a disablesleep 1");
  execFileSync("bash", ["-n"], { input: script }); // valid bash
});
