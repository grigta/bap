import type { ChildProcess } from "node:child_process";
import { type Page, expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { confirmDialog, goTo, killAgent, localMac, logIn, openNewRun } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const SHOP = "http://127.0.0.1:4320";
const agents: ChildProcess[] = [];
const suffix = Date.now().toString(36);
const recipe = `shop-${suffix}`;

test.afterAll(() => agents.forEach(killAgent));

const modelCalls = async (runId: string) => (await (await fetch(`http://127.0.0.1:${STACK_PORTS.control}/llm-calls?run=${runId}`)).json()).calls as number;
const runIdFromUrl = (page: Page) => page.url().split("/runs/")[1]!.split("?")[0]!;

async function launch(page: Page, profile: string) {
  await goTo(page, "Конвейер");
  await openNewRun(page);
  await page.getByLabel("Сценарий").selectOption(`${recipe}@1.0.0`);
  await expect(page.getByLabel("Профиль").getByRole("option", { name: profile, exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByLabel("Профиль").selectOption({ label: profile });
  await page.getByLabel("Input (JSON)").fill(JSON.stringify({ baseUrl: SHOP, query: "Ноутбук", item: "Ноутбук Pro 15", name: "Анна Петрова", phone: "+7 900 123-45-67", address: "Москва, Тверская 1", delivery: "Курьер" }));
  await page.getByLabel("timeoutMs").fill("240000");
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.getByTestId("run-detail").getByRole("heading", { level: 2 })).toContainText(recipe);
  const detail = page.getByTestId("run-detail");
  await expect(detail.getByTestId("run-status")).toHaveText(/SUCCEEDED|FAILED|NEEDS_REVIEW/, { timeout: 120_000 });
  const runId = runIdFromUrl(page);
  const run = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
  const steps = await (await page.request.get(`/api/v1/runs/${runId}/steps`)).json();
  expect(run.status, `${run.errorCode}: ${run.errorMessage}\n${JSON.stringify(steps.map((s: { stepId: string; status: string; note: string | null }) => [s.stepId, s.status, s.note]))}`).toBe("SUCCEEDED");
  return runId;
}

test("[REQ-DOM-004][REQ-DOM-008][REQ-DOM-011][REQ-DOM-012][REQ-DOM-013] demo: a task is recorded on one Mac, published, replayed on another and healed after a redesign", async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fetch(`${SHOP}/api/orders`, { method: "DELETE" });
  await fetch(`${SHOP}/api/layout`, { method: "POST", body: JSON.stringify({ seed: 1, wording: 0 }) });
  await logIn(page);
  const first = await localMac(page, agents, `rec-a-${suffix}`);
  const second = await localMac(page, agents, `rec-b-${suffix}`);

  // 1. A new task for the site, recorded live; two actions that change data wait for the operator.
  await goTo(page, "Рецепты");
  await page.getByRole("button", { name: "Новая задача на сайте" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Название").fill(recipe);
  await form.getByLabel("Цель").fill("Купить {{input.item}} с доставкой курьером по адресу {{input.address}}");
  await form.getByLabel("Стартовый адрес").fill(`${SHOP}/`);
  await expect(form.getByLabel("Профиль").getByRole("option", { name: first, exact: true })).toBeEnabled({ timeout: 10_000 });
  await form.getByLabel("Профиль").selectOption({ label: first });
  const fields = Object.entries({ baseUrl: SHOP, query: "Ноутбук", item: "Ноутбук Pro 15", name: "Анна Петрова", phone: "+7 900 123-45-67", address: "Москва, Тверская 1", delivery: "Курьер" });
  for (const [i, [name, value]] of fields.entries()) {
    if (i > 0) await form.getByRole("button", { name: "Поле", exact: true }).click();
    await form.getByLabel(`Поле ${i + 1}: имя`).fill(name);
    await form.getByLabel(`Поле ${i + 1}: значение`).fill(value);
  }
  await evidence(page, "S11", "1-new-task");
  await form.getByRole("button", { name: "Записать" }).click();
  await page.waitForURL(/\/runs\//);
  const recording = runIdFromUrl(page);
  const detail = page.getByTestId("run-detail");
  for (const intent of ["Положить товар в корзину", "Оформить заказ"]) {
    const ask = detail.getByTestId("confirmation");
    await expect(ask).toContainText(intent, { timeout: 60_000 });
    await expect(ask.getByRole("img")).toHaveJSProperty("complete", true);
    if (intent === "Оформить заказ") await evidence(page, "S11", "1-awaiting-confirmation");
    await ask.getByRole("button", { name: "Подтвердить" }).click();
    await expect(ask).toBeHidden();
  }
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED", { timeout: 60_000 });
  await expect(detail.getByTestId("step-resolution").filter({ hasText: "подтверждён" })).toHaveCount(2);
  await evidence(page, "S11", "1-recorded");
  // The panel never mentions the model (ADR-0025).
  await expect(page.locator("body")).not.toContainText(/claude|модел|токен|LLM/i);

  // 2. The recipe: steps with intents and screenshots, then publish.
  await goTo(page, "Рецепты");
  await page.getByTestId(`recipe-${recipe}`).getByRole("link", { name: recipe }).click();
  const card = page.getByTestId("recipe-detail");
  await expect(card.getByTestId("version-1.0.0")).toContainText("черновик");
  await expect(card.getByTestId("recipe-step-s04").getByRole("img")).toHaveJSProperty("complete", true);
  await expect(card.getByTestId("recipe-step-s04")).toContainText("меняет данные");
  await evidence(page, "S11", "2-recipe-draft");
  await card.getByRole("button", { name: "Опубликовать" }).click();
  await confirmDialog(page);
  await expect(card.getByTestId("version-1.0.0")).toContainText("опубликован");

  // 3. Another Mac replays it: every step found by its fingerprint, no model calls.
  await fetch(`${SHOP}/api/layout`, { method: "POST", body: JSON.stringify({ seed: 8, wording: 0 }) });
  const replay = await launch(page, second);
  await expect(page.getByTestId("run-detail").getByTestId("step-resolution").filter({ hasText: "вылечен" })).toHaveCount(0);
  await expect(page.getByTestId("run-detail").getByTestId("step-resolution").filter({ hasText: "найден" }).first()).toBeVisible();
  await evidence(page, "S11", "3-replayed-on-another-mac");
  expect(await modelCalls(replay)).toBe(0);

  // 4. The shop is redesigned: the run heals the changed steps and version 2 appears.
  await fetch(`${SHOP}/api/layout`, { method: "POST", body: JSON.stringify({ seed: 9, wording: 1 }) });
  const healing = await launch(page, second);
  const healed = page.getByTestId("run-detail").getByTestId("step-resolution").filter({ hasText: "вылечен" });
  expect(await healed.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("run-detail")).toContainText("теперь называется «Подтвердить покупку»");
  await evidence(page, "S11", "4-healed");
  expect(await modelCalls(healing)).toBe(await healed.count());
  await goTo(page, "Рецепты");
  await page.getByTestId(`recipe-${recipe}`).getByRole("link", { name: recipe }).click();
  await expect(page.getByTestId("version-2.0.0")).toContainText("вылечен");
  await page.getByTestId("version-2.0.0").click();
  await expect(page.getByTestId("recipe-detail")).toContainText("Что изменилось");
  await evidence(page, "S11", "4-version-2");

  // 5. The same redesign again: no model at all.
  const again = await launch(page, second);
  await expect(page.getByTestId("run-detail").getByTestId("step-resolution").filter({ hasText: "вылечен" })).toHaveCount(0);
  await evidence(page, "S11", "5-no-model-after-healing");
  expect(await modelCalls(again)).toBe(0);
  expect((await (await fetch(`${SHOP}/api/orders`)).json()).length).toBe(4);
  expect(recording).toBeTruthy();
});
