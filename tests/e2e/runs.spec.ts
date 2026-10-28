import { type ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
let agent: ChildProcess | undefined;

test.afterEach(() => killAgent(agent));

/** Enrolls a local-Chromium agent with one profile and imports it. */
async function agentWithProfile(page: Page, name: string): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-runs-"));
  mkdirSync(join(data, "profiles", `${name}-profile`), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
  const enrolled = spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", name], { env, encoding: "utf8" });
  expect(enrolled.stderr).toBe("");
  agent = spawnAgent(cli, env);
  const agentId = await expect
    .poll(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string; maxSessions: number | null }) => a.name === name && a.maxSessions !== null)?.id, { timeout: 15_000 })
    .not.toBeUndefined()
    .then(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name).id);
  const imported = await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: `${name}-profile`, name: `${name}-profile` } });
  expect(imported.status()).toBe(201);
  return (await imported.json()).id;
}

async function launch(page: Page, scenario: string, profile: string, input: object, timeoutMs = 120_000) {
  await page.getByLabel("Сценарий").selectOption(scenario);
  // The form refreshes profiles every 2 s: wait until the previous run has released this one.
  await expect(page.getByLabel("Профиль").getByRole("option", { name: profile, exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByLabel("Профиль").selectOption({ label: profile });
  await page.getByLabel("Input (JSON)").fill(JSON.stringify(input));
  await page.getByLabel("timeoutMs").fill(String(timeoutMs));
  await page.getByRole("button", { name: "Запустить" }).click();
  // The detail card switches to the new run; until then it still shows the previous one.
  await expect(page.getByTestId("run-detail").getByRole("heading", { level: 2 })).toContainText(scenario);
}

test("[REQ-RUN-009] operator launches a run and watches statuses, step screenshots and the transition journal", async ({ page }) => {
  test.setTimeout(90_000);
  await logIn(page);
  const profileId = await agentWithProfile(page, "runner-mac");
  await page.getByRole("button", { name: "Runs" }).click();
  await launch(page, "staging-smoke-test@1.0.0", "runner-mac-profile", { baseUrl: "http://127.0.0.1:4310" });

  const detail = page.getByTestId("run-detail");
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED", { timeout: 30_000 });
  for (const step of ["open-home", "open-wizard", "open-orders"]) {
    await expect(detail.getByTestId(`step-${step}`)).toContainText("✓");
    await expect(detail.getByTestId(`step-${step}`).getByRole("img")).toHaveJSProperty("complete", true);
  }
  await expect(detail.getByTestId("transitions")).toContainText("RUNNING → SUCCEEDED");
  await evidence(page, "S5", "run-succeeded");

  // Same Idempotency-Key twice → one run; other body with that key → conflict.
  const key = randomUUID();
  const body = { scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: "http://127.0.0.1:4310" } };
  const first = await (await page.request.post("/api/v1/runs", { data: body, headers: { "idempotency-key": key } })).json();
  const second = await (await page.request.post("/api/v1/runs", { data: body, headers: { "idempotency-key": key } })).json();
  expect(second.runId).toBe(first.runId);
  const conflict = await page.request.post("/api/v1/runs", { data: { ...body, timeoutMs: 1000 }, headers: { "idempotency-key": key } });
  expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  const mismatch = await page.request.post("/api/v1/runs", { data: { ...body, scenarioVersion: "2.0.0" }, headers: { "idempotency-key": randomUUID() } });
  expect((await mismatch.json()).error.code).toBe("SCENARIO_VERSION_MISMATCH");
  await expect.poll(async () => (await (await page.request.get(`/api/v1/runs/${first.runId}`)).json()).status, { timeout: 30_000 }).toBe("SUCCEEDED");

  await launch(page, "crash-page@1.0.0", "runner-mac-profile", { baseUrl: "http://127.0.0.1:4310" });
  await expect(detail.getByTestId("run-status")).toHaveText("FAILED", { timeout: 30_000 });
  await expect(detail.getByTestId("step-expect-orders")).toContainText("✗");
  await expect(detail.getByTestId("run-error")).toContainText("STEP_FAILED");
  await evidence(page, "S5", "run-failed-crash");

  await launch(page, "slow-page@1.0.0", "runner-mac-profile", { baseUrl: "http://127.0.0.1:4310", ms: 8000 }, 2000);
  await expect(detail.getByTestId("run-status")).toHaveText("FAILED", { timeout: 30_000 });
  await expect(detail.getByTestId("run-error")).toContainText("TIMEOUT");
  await evidence(page, "S5", "run-failed-timeout");
});
