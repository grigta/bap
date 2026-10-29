import { type ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { confirmDialog, goTo, killAgent, logIn, spawnAgent, openNewRun } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const site = "http://127.0.0.1:4310";
let agent: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;
test.afterEach(async () => {
  killAgent(agent);
  await fetch(`${site}/api/orders`, { method: "DELETE" });
});

const setMode = (mode: object) => fetch(`${site}/api/mode`, { method: "POST", body: JSON.stringify(mode) });
const ordersFor = async (item: string) => ((await (await fetch(`${site}/api/orders`)).json()) as { item: string }[]).filter((o) => o.item === item).length;
/** kill -9 of the agent alone: its browser stays behind, like after a real crash. */
const crashAndRestart = async () => {
  process.kill(agent!.pid!, "SIGKILL");
  killAgent(agent); // the abandoned browser is in the same process group; the restarted agent would close it anyway
  agent = spawnAgent(cli, env);
};

async function launch(page: Page, item: string) {
  await goTo(page, "Конвейер");
  await openNewRun(page);
  await page.getByLabel("Сценарий").selectOption("wizard-order@1.1.0");
  await expect(page.getByLabel("Профиль").getByRole("option", { name: "rec-p", exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.getByLabel("Профиль").selectOption({ label: "rec-p" });
  await page.getByLabel("Input (JSON)").fill(JSON.stringify({ baseUrl: site, item }));
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.getByTestId("run-detail").getByRole("heading", { level: 2 })).toContainText("wizard-order");
  return page.getByTestId("run-detail");
}

test("[REQ-UI-004][REQ-UI-005] operator resumes a crashed run, cancels a running one and releases a profile from review", async ({ page }) => {
  test.setTimeout(180_000);
  await logIn(page);
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-rec-"));
  mkdirSync(join(data, "profiles", "rec-p"), { recursive: true });
  env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
  const enrolled = spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", "recovery-mac"], { env, encoding: "utf8" });
  expect(enrolled.stderr).toBe("");
  agent = spawnAgent(cli, env);
  await expect.poll(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === "recovery-mac")?.maxSessions, { timeout: 15_000 }).toBe(2);
  const agentId = (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === "recovery-mac").id;
  await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: "rec-p", name: "rec-p" } });

  // 1. kill -9 in a read step → RECOVERY_PENDING → Resume → SUCCEEDED, one order.
  await setMode({ holdStep: 3, holdMs: 5000 });
  const first = `coffee-${randomUUID().slice(0, 6)}`;
  let detail = await launch(page, first);
  await expect(detail.getByTestId("step-review")).toContainText("checkpoint", { timeout: 20_000 });
  await crashAndRestart();
  await setMode({});
  await expect(detail.getByTestId("run-status")).toHaveText("RECOVERY_PENDING", { timeout: 30_000 });
  await evidence(page, "S7", "recovery-pending");
  await detail.getByRole("button", { name: "Resume" }).click();
  await confirmDialog(page);
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED", { timeout: 60_000 });
  await expect(detail.getByTestId("transitions")).toContainText("resumed after checkpoint review");
  expect(await ordersFor(first)).toBe(1);
  await evidence(page, "S7", "resumed-succeeded");

  // 2. Cancel during the mutating step: it finishes and verifies, then the run stops. One order.
  await setMode({ orderHoldMs: 4000 });
  const second = `coffee-${randomUUID().slice(0, 6)}`;
  detail = await launch(page, second);
  await expect.poll(() => ordersFor(second), { timeout: 30_000 }).toBe(1);
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.getByTestId("run-status")).toHaveText("CANCELLED", { timeout: 30_000 });
  await expect(detail.getByTestId("transitions")).toContainText("cancelled after step place-order");
  expect(await ordersFor(second)).toBe(1);
  await evidence(page, "S7", "cancelled-after-mutating-step");

  // 3. The site cannot confirm the interrupted order: run and profile wait for review; release.
  await setMode({ orderHoldMs: 5000 });
  const third = `coffee-${randomUUID().slice(0, 6)}`;
  detail = await launch(page, third);
  await expect.poll(() => ordersFor(third), { timeout: 30_000 }).toBe(1);
  await crashAndRestart();
  await setMode({ ambiguous: true });
  await expect(detail.getByTestId("run-status")).toHaveText("RECOVERY_PENDING", { timeout: 30_000 });
  await detail.getByRole("button", { name: "Resume" }).click();
  await confirmDialog(page);
  await expect(detail.getByTestId("run-status")).toHaveText("NEEDS_REVIEW", { timeout: 60_000 });
  await setMode({});
  expect(await ordersFor(third)).toBe(1);

  await goTo(page, "Недоработки");
  const queued = page.getByTestId("review-profile-rec-p");
  await expect(queued).toContainText("interrupted mutating step");
  await evidence(page, "S7", "review-queue");
  await queued.getByRole("button", { name: "Вернуть в работу" }).click();
  await confirmDialog(page);
  await expect(queued).toHaveCount(0);
  const profile = await (await page.request.get("/api/v1/profiles")).json();
  expect(profile.find((p: { name: string }) => p.name === "rec-p").status).toBe("AVAILABLE");
});
