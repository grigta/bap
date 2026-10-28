#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { type BrowserProvider, LinkenSphereProvider, LocalChromiumProvider } from "@bap/browser-adapters";
import { CheckpointStore, type RunStatus, loadScenarioBundle, runScenario } from "@bap/engine";
import { startAgent } from "./agent.ts";
import { checkServerUrl, dataDir, defaultSecretStore, enroll, loadConfig, saveConfig } from "./config.ts";
import { LINKEN_SPHERE_SERVICE } from "./secret-store.ts";
import { launchAgentPath, launchAgentPlist } from "./launchagent.ts";

const USAGE = `usage:
  bap-agent enroll --server <url> --token <invitation> [--name <name>]
  bap-agent start
  bap-agent install-launchagent [--load]
  bap-agent update                             (agents installed with the one-line installer)
  bap-agent ls-credentials --email <email>     (password on stdin; stored in the Keychain)
  bap-agent ls-signin --email <email>
  bap-agent run <scenario-id> --profile <id> [--input '<json>'] [--version x.y.z]
                [--provider ls|local] [--bundles dist/scenarios] [--artifacts artifacts]`;
const EXIT: Record<RunStatus, number> = { SUCCEEDED: 0, FAILED: 1, NEEDS_REVIEW: 2, CANCELLED: 4 };
const EXIT_USAGE = 3;
const lsApiUrl = process.env.BAP_LS_API_URL ?? "http://127.0.0.1:41234";

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_USAGE);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    token: { type: "string" },
    name: { type: "string", default: hostname().replace(/\.local$/, "") },
    load: { type: "boolean", default: false },
    email: { type: "string" },
    profile: { type: "string" },
    input: { type: "string", default: "{}" },
    version: { type: "string" },
    provider: { type: "string", default: "ls" },
    bundles: { type: "string", default: "dist/scenarios" },
    artifacts: { type: "string", default: "artifacts" },
  },
});
const [command] = positionals;

if (command === "enroll") {
  if (!values.server || !values.token) fail(USAGE);
  try {
    const config = await enroll(values.server.replace(/\/$/, ""), values.token, values.name);
    saveConfig(config);
    console.log(`enrolled as ${config.name} (${config.agentId}); credentials saved to ${join(dataDir(), "agent.json")}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
} else if (command === "start") {
  const config = loadConfig();
  try {
    checkServerUrl(config.serverUrl);
  } catch (e) {
    fail((e as Error).message);
  }
  // BAP_PROVIDER=local runs on plain Chromium (tests, machines without Linken Sphere).
  const local = process.env.BAP_PROVIDER === "local";
  const agent = startAgent({
    serverUrl: config.serverUrl,
    agentKey: config.agentKey,
    onKeyRotated: (agentKey) => saveConfig({ ...config, agentKey }),
    provider: local
      ? new LocalChromiumProvider({ profilesDir: join(dataDir(), "profiles"), headless: process.env.BAP_HEADLESS !== "false" })
      : process.env.BAP_LS_API_URL === ""
        ? null
        : new LinkenSphereProvider({ apiUrl: lsApiUrl }),
    providerName: local ? "local-chromium" : "linken-sphere",
    maxSessions: Number(process.env.BAP_MAX_SESSIONS ?? 2),
    dataDir: dataDir(),
    retentionDays: Number(process.env.BAP_RETENTION_DAYS ?? 7),
  });
  console.log(`agent ${config.name} → ${config.serverUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => agent.stop());
  // A revoked agent exits 0 so launchd does not restart it in a loop; it needs a new invitation.
  await agent.stopped;
} else if (command === "install-launchagent") {
  const plist = launchAgentPath();
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    launchAgentPlist({
      node: process.execPath,
      cli: resolve(import.meta.filename),
      logFile: join(dataDir(), "agent.log"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        BAP_AGENT_DATA: dataDir(),
        BAP_LS_API_URL: lsApiUrl,
        // A server with a self-signed certificate (pnpm gateway): the installer saved it next to the agent.
        ...(process.env.NODE_EXTRA_CA_CERTS && { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
      },
    }),
  );
  execFileSync("plutil", ["-lint", plist], { stdio: "inherit" });
  const load = ["bootstrap", `gui/${process.getuid!()}`, plist];
  if (values.load) {
    // Re-running must replace an already loaded agent: bootstrap alone fails when the label exists.
    spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}/com.bap.agent`], { stdio: "ignore" });
    execFileSync("launchctl", load, { stdio: "inherit" });
  }
  else console.log(`load with: launchctl ${load.join(" ")}`);
} else if (command === "ls-credentials" || command === "ls-signin") {
  if (!values.email) fail(USAGE);
  const secrets = defaultSecretStore();
  if (!secrets) fail("no keychain on this machine: Linken Sphere credentials are not stored in files");
  if (command === "ls-credentials") {
    let password = "";
    for await (const chunk of process.stdin) password += chunk;
    secrets.set(LINKEN_SPHERE_SERVICE, values.email, password.replace(/\r?\n$/, ""));
    console.log(`Linken Sphere password for ${values.email} saved to the Keychain`);
  } else {
    const password = secrets.get(LINKEN_SPHERE_SERVICE, values.email);
    if (!password) fail(`no Linken Sphere password for ${values.email} in the Keychain — run bap-agent ls-credentials first`);
    const res = await new LinkenSphereProvider({ apiUrl: lsApiUrl }).api.signIn(values.email, password);
    console.log(res.message);
  }
} else if (command === "update") {
  // The installer put the agent here as one file; the server hands out the current one to its agents.
  const self = resolve(import.meta.filename);
  if (!self.endsWith(".mjs")) fail("update is for agents installed with the one-line installer; this one runs from the repository: git pull");
  const config = loadConfig();
  const res = await fetch(`${config.serverUrl}/api/v1/agents/install/bundle`, { headers: { authorization: `Bearer ${config.agentKey}` } });
  if (!res.ok) fail(`update failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== res.headers.get("x-bap-sha256")) fail("update failed: the downloaded agent does not match its checksum");
  writeFileSync(`${self}.new`, body);
  renameSync(`${self}.new`, self);
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/com.bap.agent`], { stdio: "ignore" });
  console.log(`updated to ${sha256.slice(0, 12)}; the agent restarts`);
} else if (command === "run") {
  await runCommand(positionals[1]);
} else fail(USAGE);

async function runCommand(scenarioId: string | undefined) {
  if (!scenarioId || !values.profile) fail(USAGE);
  const bundles = resolve(values.bundles);
  const versions = readdirSync(bundles)
    .filter((f) => f.startsWith(`${scenarioId}@`) && f.endsWith(".json"))
    .map((f) => f.slice(scenarioId.length + 1, -".json".length))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = values.version ?? versions.at(-1);
  if (!version || !versions.includes(version)) fail(`scenario ${scenarioId}@${values.version ?? "*"} not found in ${bundles} — run pnpm scenarios:build`);

  let input: unknown;
  try {
    input = JSON.parse(values.input);
  } catch {
    fail("--input is not valid JSON");
  }

  let provider: BrowserProvider;
  if (values.provider === "ls") provider = new LinkenSphereProvider({ apiUrl: lsApiUrl });
  else if (values.provider === "local") {
    const local = new LocalChromiumProvider({ profilesDir: join(dataDir(), "profiles"), headless: process.env.BAP_HEADLESS !== "false" });
    local.createProfile(values.profile);
    provider = local;
  } else fail(`unknown provider ${values.provider}`);

  const runId = randomUUID();
  const checkpoints = new CheckpointStore(join(dataDir(), "agent.db"));
  try {
    const scenario = await loadScenarioBundle(join(bundles, `${scenarioId}@${version}.json`));
    console.log(`${scenario.id}@${scenario.version} · run ${runId} · profile ${values.profile}`);
    const result = await runScenario({
      scenario,
      input,
      provider,
      profileId: values.profile,
      runId,
      agentId: process.env.BAP_AGENT_ID ?? hostname(),
      artifactsDir: resolve(values.artifacts, runId),
      checkpoints,
      onStep: (s) =>
        console.log(`  ${{ passed: "✓", failed: "✗", unverified: "?" }[s.status]} ${s.id}  ${s.durationMs} ms${s.error ? `\n      ${s.error.split("\n")[0]}` : ""}`),
    });
    console.log(`${result.status} · report ${result.reportPath}`);
    process.exitCode = EXIT[result.status];
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    checkpoints.close();
  }
}
