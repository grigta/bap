import type { ChildProcess } from "node:child_process";
import { type Page, expect, test } from "@playwright/test";
import type { Page as CorePage } from "playwright-core";
import { SHOP_INPUT, shapeshiftRecipe } from "../support/shapeshift-recipe.ts";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, localMac, logIn, openNewRun } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const SHOP = "http://127.0.0.1:4320";
const agents: ChildProcess[] = [];
const recipe = `shop-proof-${Date.now().toString(36)}`;
test.afterAll(() => agents.forEach(killAgent));

const layout = (l: { seed: number; wording: number; failOrder?: boolean }) => fetch(`${SHOP}/api/layout`, { method: "POST", body: JSON.stringify({ failOrder: false, ...l }) });
const modelCalls = async (runId: string) => (await (await fetch(`http://127.0.0.1:${STACK_PORTS.control}/llm-calls?run=${runId}`)).json()).calls as number;

async function launch(page: Page, profile: string, expected: string) {
  await goTo(page, "Конвейер");
  await openNewRun(page);
  await page.getByLabel("Сценарий").selectOption(`${recipe}@1.0.0`);
  await expect(page.getByLabel("Профиль").getByRole("option", { name: profile, exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByLabel("Профиль").selectOption({ label: profile });
  await page.getByLabel("Input (JSON)").fill(JSON.stringify({ baseUrl: SHOP, ...SHOP_INPUT }));
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const detail = page.getByTestId("run-detail");
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(recipe);
  await expect(detail.getByTestId("run-status")).toHaveText(expected, { timeout: 120_000 });
  await detail.getByTestId("step-s11").scrollIntoViewIfNeeded();
  return page.url().split("/runs/")[1]!.split("?")[0]!;
}

test("[REQ-DOM-014][REQ-DOM-015] demo: word forms are found without the model, the order is proven by the site's answer, a server error goes to review", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const written = await shapeshiftRecipe(page as unknown as CorePage, SHOP);
  await logIn(page);
  const profile = await localMac(page, agents, `proof-${Date.now().toString(36)}`);
  expect((await page.request.post(`/api/v1/recipes/${recipe}/versions`, { data: written })).status()).toBe(201);
  await page.request.post(`/api/v1/recipes/${recipe}/versions/1.0.0/publish`);

  // 1. «Оформление заказа», «В корзинку», «Заказ принят»: found by word forms, proven by the site's answer.
  await layout({ seed: 14, wording: 2 });
  await fetch(`${SHOP}/api/orders`, { method: "DELETE" });
  const forms = await launch(page, profile, "SUCCEEDED");
  const detail = page.getByTestId("run-detail");
  await expect(detail.getByTestId("step-resolution").filter({ hasText: "вылечен" })).toHaveCount(0);
  await expect(detail.getByTestId("step-s11").getByTestId("step-note")).toContainText("подтверждён ответом сайта: POST /order 303");
  await evidence(page, "S12", "1-word-forms-proven-by-answer");
  expect(await modelCalls(forms)).toBe(0);

  // 2. The server refuses the order: the run stops for review, nothing is repeated.
  await layout({ seed: 14, wording: 0, failOrder: true });
  await fetch(`${SHOP}/api/orders`, { method: "DELETE" });
  await launch(page, profile, "NEEDS_REVIEW");
  await expect(detail.getByTestId("step-s11").getByTestId("step-note")).toContainText("сайт ответил ошибкой: POST /order 500");
  await evidence(page, "S12", "2-server-error-to-review");
  expect((await (await fetch(`${SHOP}/api/orders`)).json()).length).toBe(0);
  await layout({ seed: 1, wording: 0 });
  await goTo(page, "Недоработки");
  await expect(page.getByRole("main")).toContainText("UNVERIFIED");
});
