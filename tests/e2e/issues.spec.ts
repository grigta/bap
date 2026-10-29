import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, localMac, logIn } from "./helpers.ts";

const agents: ChildProcess[] = [];
test.afterAll(() => agents.forEach(killAgent));

test("[REQ-UI-010] the sidebar: work sections on top, frozen ones at the bottom, no profiles page", async ({ page }) => {
  await logIn(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByRole("link")).toHaveText(["Обзор", "Агенты", "Конвейер", "Недоработки", "Все логи", "Рецепты", "Прогрев"]);
  await expect(sidebar.getByText("Заморожено")).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Профили" })).toHaveCount(0);
  await evidence(page, "S16", "1-menu");
});

test("[REQ-UI-008][REQ-UI-009] a failed run shows up on «Недоработки» with a snapshot of the page; the operator closes it with a note", async ({ page }) => {
  test.setTimeout(90_000);
  await logIn(page);
  const profile = await localMac(page, agents, `issues-${randomUUID().slice(0, 4)}`);
  const profiles = (await (await page.request.get("/api/v1/profiles")).json()) as { id: string; name: string }[];
  const profileId = profiles.find((p) => p.name === profile)!.id;
  const { runId } = await (
    await page.request.post("/api/v1/runs", { data: { scenarioId: "crash-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: "http://127.0.0.1:4310" } }, headers: { "idempotency-key": randomUUID() } })
  ).json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).status, { timeout: 30_000 }).toBe("FAILED");

  // «Конвейер»: the run with its profile's state and the Mac.
  await goTo(page, "Конвейер");
  const row = page.getByTestId(`run-${runId}`);
  await expect(row).toContainText(profile);
  await expect(row.getByTestId("run-profile-status")).toHaveText(/AVAILABLE|VERIFYING/);
  await evidence(page, "S16", "2-pipeline");

  // «Недоработки»: the failure in detail.
  await goTo(page, "Недоработки");
  const issue = page.getByTestId(`review-run-${runId}`);
  await expect(issue).toContainText("STEP_FAILED");
  await issue.getByRole("button", { name: "Слепок ошибки" }).click();
  const details = issue.getByTestId("issue-details");
  await expect(details.getByTestId("failure-url")).toHaveText("http://127.0.0.1:4310/crash");
  await expect(details.getByTestId("failure-elements")).toBeVisible();
  await expect(details.getByRole("img", { name: /Страница при ошибке шага expect-orders/ })).toBeVisible();
  await expect(details).toContainText("expect-orders");
  await expect(details.getByRole("link", { name: "Скачать слепок" })).toHaveAttribute("download", /failure-.*\.json/);
  await evidence(page, "S16", "3-issue-snapshot");

  await issue.getByRole("button", { name: "Доработано" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Доработано" })).toBeDisabled();
  await dialog.getByLabel("Что сделано").fill("Страница /crash отдаёт ошибку: поправил стенд вручную");
  await evidence(page, "S16", "4-resolve-dialog");
  await dialog.getByRole("button", { name: "Доработано" }).click();
  await expect(issue).toBeHidden();

  await page.getByRole("button", { name: "Доработанные" }).click();
  await expect(page.getByTestId(`review-run-${runId}`).getByTestId("issue-resolution")).toContainText("operator: Страница /crash отдаёт ошибку");
  await evidence(page, "S16", "5-resolved");
});
