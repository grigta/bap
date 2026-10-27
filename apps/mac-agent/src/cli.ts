#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { type BrowserProvider, LinkenSphereProvider, LocalChromiumProvider } from "@bap/browser-adapters";
import { CheckpointStore, type RunStatus, loadScenarioBundle, runScenario } from "@bap/engine";

const USAGE = `usage: bap-agent run <scenario-id> --profile <id> [--input '<json>'] [--version x.y.z]
                 [--provider ls|local] [--bundles dist/scenarios] [--artifacts artifacts]`;
const EXIT: Record<RunStatus, number> = { SUCCEEDED: 0, FAILED: 1, NEEDS_REVIEW: 2 };
const EXIT_USAGE = 3;

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_USAGE);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    input: { type: "string", default: "{}" },
    version: { type: "string" },
    provider: { type: "string", default: "ls" },
    bundles: { type: "string", default: "dist/scenarios" },
    artifacts: { type: "string", default: "artifacts" },
  },
});
const [command, scenarioId] = positionals;
if (command !== "run" || !scenarioId || !values.profile) fail(USAGE);

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

const dataDir = process.env.BAP_AGENT_DATA ?? join(homedir(), ".bap");
let provider: BrowserProvider;
if (values.provider === "ls") {
  provider = new LinkenSphereProvider({ apiUrl: process.env.BAP_LS_API_URL ?? "http://127.0.0.1:41234" });
} else if (values.provider === "local") {
  const local = new LocalChromiumProvider({ profilesDir: join(dataDir, "profiles"), headless: process.env.BAP_HEADLESS !== "false" });
  local.createProfile(values.profile);
  provider = local;
} else fail(`unknown provider ${values.provider}`);

const runId = randomUUID();
const artifactsDir = resolve(values.artifacts, runId);
const checkpoints = new CheckpointStore(join(dataDir, "agent.db"));
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
    artifactsDir,
    checkpoints,
    onStep: (s) => console.log(`  ${{ passed: "✓", failed: "✗", unverified: "?" }[s.status]} ${s.id}  ${s.durationMs} ms${s.error ? `\n      ${s.error.split("\n")[0]}` : ""}`),
  });
  console.log(`${result.status} · report ${result.reportPath}`);
  process.exitCode = EXIT[result.status];
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  checkpoints.close();
}
