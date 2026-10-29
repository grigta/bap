import { type ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
let agent: ChildProcess | undefined;
test.afterEach(() => killAgent(agent));

test("operator sees one run per profile, waiting runs with their reason, slots and drain", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-sched-"));
  for (const p of ["shared", "other"]) mkdirSync(join(data, "profiles", p), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local", BAP_MAX_SESSIONS: "2" };
  const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
  spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", "sched-mac"], { env });
  agent = spawnAgent(cli, env);
  await expect.poll(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string; maxSessions: number | null }) => a.name === "sched-mac")?.maxSessions, { timeout: 15_000 }).toBe(2);
  const agentId = (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === "sched-mac").id;
  const ids: Record<string, string> = {};
  for (const p of ["shared", "other"]) ids[p] = (await (await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: p, name: p } })).json()).id;

  const start = (profile: string, ms: number) =>
    page.request.post("/api/v1/runs", {
      data: { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId: ids[profile], input: { baseUrl: "http://127.0.0.1:4310", ms } },
      headers: { "idempotency-key": randomUUID() },
    });
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push((await (await start("shared", 2500)).json()).runId as string);

  await goTo(page, "Задания");
  await expect(page.locator("td", { hasText: "PROFILE_BUSY" })).toHaveCount(3, { timeout: 10_000 });
  await evidence(page, "S6", "runs-one-per-profile");
  await goTo(page, "Профили");
  await expect(page.getByTestId("profile-shared").getByTestId("profile-status")).toHaveText(/RESERVED|IN_USE/);
  await evidence(page, "S6", "profile-in-use");
  await goTo(page, "Агенты");
  await expect(page.getByTestId("agent-sched-mac").getByTestId("slots")).toHaveText("1 / 2");
  await evidence(page, "S6", "agent-slots");

  await page.getByTestId("agent-sched-mac").getByRole("button", { name: "Пауза" }).click();
  await expect(page.getByTestId("agent-sched-mac").getByTestId("agent-status")).toHaveText("DRAINING");
  const drained = (await (await start("other", 100)).json()).runId as string;
  await goTo(page, "Задания");
  await expect(page.getByTestId(`run-${drained}`)).toContainText("AGENT_DRAINING", { timeout: 10_000 });
  await evidence(page, "S6", "runs-drained");

  await goTo(page, "Агенты");
  await page.getByTestId("agent-sched-mac").getByRole("button", { name: "Возобновить" }).click();
  for (const id of [...runs, drained])
    await expect.poll(async () => (await (await page.request.get(`/api/v1/runs/${id}`)).json()).status, { timeout: 60_000 }).toBe("SUCCEEDED");
});
