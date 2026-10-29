import { type ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { startFakeLinkenSphere } from "../support/fake-linken-sphere.ts";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const site = "http://127.0.0.1:4310";
let agent: ChildProcess | undefined;
let ls: Awaited<ReturnType<typeof startFakeLinkenSphere>> | undefined;

test.afterAll(async () => {
  killAgent(agent);
  await ls?.stop();
});

test("[REQ-UI-011][REQ-AGENT-005] from «Недоработки» the operator works in the failed run's profile browser, closes it and marks the run fixed", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  // A Mac with Linken Sphere (the emulator starts real Chromium for each session).
  ls = await startFakeLinkenSphere(mkdtempSync(join(tmpdir(), "bap-e2e-remote-ls-")));
  const name = `remote-mac-${randomUUID().slice(0, 4)}`;
  const env = { ...process.env, BAP_AGENT_DATA: mkdtempSync(join(tmpdir(), "bap-e2e-remote-")), BAP_LS_API_URL: ls.url };
  const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
  await promisify(execFile)("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", name], { env });
  agent = spawnAgent(cli, env);
  const agentId = await expect
    .poll(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string; heartbeat: { lsAvailable: boolean } | null }) => a.name === name && a.heartbeat?.lsAvailable)?.id, { timeout: 20_000 })
    .not.toBeUndefined()
    .then(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name).id as string);
  const profile = `${name}-p`;
  const profileId = (await (await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: ls.createSession(profile), name: profile } })).json()).id;
  const { runId } = await (
    await page.request.post("/api/v1/runs", { data: { scenarioId: "crash-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site } }, headers: { "idempotency-key": randomUUID() } })
  ).json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).status, { timeout: 30_000 }).toBe("FAILED");

  await goTo(page, "Недоработки");
  const issue = page.getByTestId(`review-run-${runId}`);
  await issue.getByRole("button", { name: "Подключиться" }).click();
  const remote = page.getByTestId("remote-browser");
  await expect(remote.getByRole("heading")).toHaveText(`Браузер профиля ${profile} на ${name}`);
  // It opens where the run stopped, with the live picture of the page.
  await expect(remote.getByLabel("Адрес")).toHaveValue(`${site}/crash`, { timeout: 30_000 });
  await expect(remote.getByTestId("remote-frame")).toBeVisible();
  await evidence(page, "S17", "1-remote-browser");
  expect((await new AxeBuilder({ page }).include("[data-testid=remote-browser]").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

  await remote.getByLabel("Адрес").fill(`${site}/orders`);
  await remote.getByLabel("Адрес").press("Enter");
  await expect(remote.getByLabel("Адрес")).toHaveValue(`${site}/orders`);
  await expect(remote.getByRole("application")).toHaveAccessibleName(/Заказы/);
  await remote.getByRole("button", { name: "Назад" }).click();
  await expect(remote.getByLabel("Адрес")).toHaveValue(`${site}/crash`);
  await evidence(page, "S17", "2-navigated");

  // Closing the session offers to mark the run fixed.
  await remote.getByRole("button", { name: "Закрыть сессию" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toContainText("доработан?");
  await dialog.getByLabel("Что сделано").fill("Подключился к профилю, страница /crash отдаёт 500: стенд");
  await dialog.getByRole("button", { name: "Доработано" }).click();
  await expect(issue).toBeHidden();

  await page.getByRole("button", { name: "Доработанные" }).click();
  const done = page.getByTestId(`review-run-${runId}`);
  await done.getByRole("button", { name: "Слепок ошибки" }).click();
  await expect(done.getByTestId("remote-sessions")).toContainText("закрыта оператором");
  await expect(done.getByTestId("remote-sessions")).toContainText(`${site}/crash → ${site}/orders → ${site}/crash`);
  await evidence(page, "S17", "3-resolved-with-session");
});
