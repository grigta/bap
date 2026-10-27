import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { BundleChecksumError, CheckpointStore, buildScenarioBundle, loadScenarioBundle, runScenario } from "@bap/engine";
import { defineScenario } from "@bap/scenario-sdk";
import wizardOrder from "../../scenarios/wizard-order/index.ts";
import { evidenceDir } from "../support/evidence.ts";
import { startTestSite } from "../support/test-site.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "bap-engine-"));
const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
let site: Awaited<ReturnType<typeof startTestSite>>;
let checkpoints: CheckpointStore;
let runs = 0;

beforeAll(async () => {
  site = await startTestSite();
  provider.createProfile("p1");
  checkpoints = new CheckpointStore(join(work, "agent.db"));
});
afterAll(async () => {
  checkpoints.close();
  await site.stop();
});

const run = (scenario: Parameters<typeof runScenario>[0]["scenario"], input: unknown) => {
  const runId = `run-${++runs}`;
  return runScenario({ scenario, input, provider, profileId: "p1", runId, agentId: "agent-1", artifactsDir: join(work, "artifacts", runId), checkpoints, stepTimeoutMs: 2000 });
};
const orders = async () => (await (await fetch(`${site.url}/api/orders`)).json()) as { id: number; item: string }[];
const saveEvidence = (name: string, artifactsDir: string) => {
  const dir = evidenceDir("S2");
  if (dir) cpSync(artifactsDir, join(dir, name), { recursive: true });
};

describe("wizard-order on local Chromium", () => {
  test("[REQ-RUN-004] a checkpoint with the full §8.1 content is saved after every confirmed step", async () => {
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const result = await run(wizardOrder, { baseUrl: site.url, item: "Кофе" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(await orders()).toEqual([expect.objectContaining({ id: 1, item: "Кофе" })]);

    // Re-open the SQLite file: checkpoints survive an agent restart.
    const reopened = new CheckpointStore(join(work, "agent.db"));
    const saved = reopened.list(result.runId);
    reopened.close();
    expect(saved.map((c) => [c.sequence, c.lastCompletedStepId])).toEqual([
      [1, "choose-item"],
      [2, "review"],
      [3, "confirm"],
      [4, "place-order"],
      [5, "check-orders"],
    ]);
    expect(saved[2]).toEqual({
      runId: result.runId,
      agentId: "agent-1",
      profileId: "p1",
      scenarioId: "wizard-order",
      scenarioVersion: "1.0.0",
      sdkVersion: "0.1.0",
      lastCompletedStepId: "confirm",
      sequence: 3,
      createdAt: expect.any(String),
      state: { orderId: null },
      resume: { nextStepId: "place-order", nextStepMutating: true, autoResume: false },
    });
    expect(saved[3]!.state).toEqual({ orderId: 1 });
    expect(saved[4]!.resume).toEqual({ nextStepId: null, nextStepMutating: false, autoResume: false });

    for (const step of result.steps) expect(existsSync(join(work, "artifacts", result.runId, step.screenshot!))).toBe(true);
    expect(readFileSync(result.reportPath, "utf8")).toContain('<span class="status SUCCEEDED">SUCCEEDED</span>');
    saveEvidence("success", join(work, "artifacts", result.runId));
  });
});

describe("step outcomes", () => {
  test("[REQ-RUN-006] an unconfirmed mutating step stops the run for review and is never retried", async () => {
    let attempts = 0;
    const scenario = defineScenario({
      id: "unconfirmed",
      version: "1.0.0",
      inputSchema: z.object({}),
      autoResume: true,
      initialState: () => ({}),
      steps: [
        { id: "pay", mutating: true, run: async () => void attempts++, verify: async () => false },
        { id: "after", run: async () => void attempts++ },
      ],
    });
    const result = await run(scenario, {});
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.steps).toEqual([expect.objectContaining({ id: "pay", status: "unverified", error: "verify did not confirm the step" })]);
    expect(attempts).toBe(1);
    expect(checkpoints.list(result.runId)).toEqual([]);
  });

  test("[REQ-RUN-006] a mutating step that throws but whose effect verify confirms counts as done", async () => {
    const scenario = defineScenario({
      id: "confirmed-after-error",
      version: "1.0.0",
      inputSchema: z.object({}),
      autoResume: true,
      initialState: () => ({}),
      steps: [
        { id: "pay", mutating: true, run: async () => Promise.reject(new Error("connection reset")), verify: async () => true },
        { id: "after", run: async () => {} },
      ],
    });
    const result = await run(scenario, {});
    expect(result.status).toBe("SUCCEEDED");
    expect(result.steps[0]).toMatchObject({ status: "passed", error: "connection reset" });
    expect(checkpoints.list(result.runId).map((c) => c.lastCompletedStepId)).toEqual(["pay", "after"]);
  });

  test("a broken selector fails the run with the error and a screenshot of the page at that moment", async () => {
    const scenario = defineScenario({
      id: "broken-selector",
      version: "1.0.0",
      inputSchema: z.object({ baseUrl: z.url() }),
      autoResume: true,
      initialState: () => ({}),
      steps: [
        { id: "open-orders", run: async ({ page, input }) => void (await page.goto(`${input.baseUrl}/orders`)) },
        { id: "click-missing", run: async ({ page }) => page.getByRole("button", { name: "Нет такой кнопки" }).click() },
        { id: "never", run: async () => {} },
      ],
    });
    const result = await run(scenario, { baseUrl: site.url });
    expect(result.status).toBe("FAILED");
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "failed"]);
    expect(result.steps[1]!.error).toMatch(/Нет такой кнопки/);
    expect(result.steps[1]!.error).not.toContain("\u001b");
    expect(existsSync(join(work, "artifacts", result.runId, result.steps[1]!.screenshot!))).toBe(true);
    expect(readFileSync(result.reportPath, "utf8")).toContain('<li class="failed">');
    saveEvidence("failure", join(work, "artifacts", result.runId));
  });
});

describe("scenario bundles", () => {
  test("[REQ-SEC-006] a bundle loads only while its bytes match the sha256 manifest", async () => {
    const out = join(work, "bundles");
    const manifest = await buildScenarioBundle(join(repoRoot, "scenarios/wizard-order/index.ts"), out);
    expect(manifest).toEqual({ id: "wizard-order", version: "1.0.0", file: "wizard-order@1.0.0.mjs", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const manifestPath = join(out, "wizard-order@1.0.0.json");
    expect((await loadScenarioBundle(manifestPath)).steps).toHaveLength(5);

    const file = join(out, manifest.file);
    writeFileSync(file, readFileSync(file, "utf8") + "\n// tampered\n");
    await expect(loadScenarioBundle(manifestPath)).rejects.toThrow(BundleChecksumError);
  });
});

describe("bap-agent CLI", () => {
  const cli = join(repoRoot, "apps/mac-agent/src/cli.ts");
  const bundles = join(work, "cli-bundles");
  const env = { ...process.env, BAP_AGENT_DATA: join(work, "cli-data") };

  beforeAll(() => {
    execFileSync("node", [join(repoRoot, "packages/engine/src/build-cli.ts"), join(repoRoot, "scenarios"), bundles]);
  });

  test("[REQ-RUN-010] invalid input exits with code 3 before a browser starts", () => {
    const res = spawnSync("node", [cli, "run", "wizard-order", "--profile", "c1", "--provider", "local", "--bundles", bundles, "--artifacts", join(work, "cli-art"), "--input", '{"baseUrl":"nope"}'], { env, encoding: "utf8" });
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/invalid input for wizard-order[\s\S]*Invalid URL[\s\S]*at baseUrl/);
    expect(existsSync(join(work, "cli-art"))).toBe(false);
  });

  test("runs a scenario and prints each step with its timing", () => {
    const res = spawnSync("node", [cli, "run", "staging-smoke-test", "--profile", "c1", "--provider", "local", "--bundles", bundles, "--artifacts", join(work, "cli-art"), "--input", JSON.stringify({ baseUrl: site.url })], { env, encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/✓ open-home {2}\d+ ms\n {2}✓ open-wizard {2}\d+ ms\n {2}✓ open-orders {2}\d+ ms\nSUCCEEDED · report .*run-report\.html/);
  });
});

describe("session start", () => {
  const scenario = defineScenario({ id: "one-step", version: "1.0.0", inputSchema: z.object({}), autoResume: true, initialState: () => ({}), steps: [{ id: "noop", run: async () => {} }] });
  /** Wraps the real provider so that attach fails a given number of times. */
  const flaky = (failures: number) => {
    let attempts = 0;
    return {
      get attempts() {
        return attempts;
      },
      provider: {
        isAvailable: () => provider.isAvailable(),
        listProfiles: () => provider.listProfiles(),
        openSession: async (id: string, runId: string) => {
          const session = await provider.openSession(id, runId);
          const attach = session.attach.bind(session);
          session.attach = async () => {
            attempts++;
            if (attempts <= failures) throw new Error(`cdp refused (attempt ${attempts})`);
            return attach();
          };
          return session;
        },
      },
    };
  };
  const runWith = (p: Parameters<typeof runScenario>[0]["provider"], profileId = "p1") =>
    runScenario({ scenario, input: {}, provider: p, profileId, runId: `run-${++runs}`, agentId: "a", artifactsDir: join(work, "artifacts", `s-${runs}`), checkpoints, sessionRetryDelayMs: 10 });

  test("[REQ-LS-008] a session that fails to start is retried a limited number of times", async () => {
    const twice = flaky(2);
    expect((await runWith(twice.provider)).status).toBe("SUCCEEDED");
    expect(twice.attempts).toBe(3);

    const never = flaky(99);
    const result = await runWith(never.provider);
    expect(never.attempts).toBe(3);
    expect(result).toMatchObject({ status: "FAILED", errorCode: "SESSION_START_FAILED", steps: [] });
    expect(result.errorMessage).toMatch(/did not start after 3 attempts: cdp refused \(attempt 3\)/);
  });

  test("[REQ-LS-008] a missing profile is a configuration error and is not retried", async () => {
    const result = await runWith(provider, "no-such-profile");
    expect(result).toMatchObject({ status: "FAILED", errorCode: "PROFILE_NOT_FOUND" });
  });
});
