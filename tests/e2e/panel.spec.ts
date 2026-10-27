import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { E2E_OPERATOR, STACK_PORTS } from "./stack-config.ts";

const control = (action: "stop" | "start") =>
  fetch(`http://127.0.0.1:${STACK_PORTS.control}/control-plane/${action}`, { method: "POST" });

test.afterEach(async () => {
  await control("start");
});

async function logIn(page: import("@playwright/test").Page, password: string = E2E_OPERATOR.password) {
  await page.goto("/");
  await page.getByLabel("Логин").fill(E2E_OPERATOR.login);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
}

test("[REQ-UI-001] health indicator turns offline within 5 s after the Control Plane stops and recovers", async ({ page }) => {
  await logIn(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  const health = page.getByTestId("health");
  await expect(health).toHaveText("Control Plane: online");
  await evidence(page, "S0", "panel-online");

  await control("stop");
  const stoppedAt = Date.now();
  await expect(health).toHaveText("Control Plane: offline", { timeout: 5000 });
  expect(Date.now() - stoppedAt).toBeLessThanOrEqual(5000);
  await evidence(page, "S0", "panel-offline");

  await control("start");
  await expect(health).toHaveText("Control Plane: online", { timeout: 5000 });
});

test("[REQ-SEC-011] panel requires login, rejects a wrong password and logs out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await evidence(page, "S0", "panel-login");

  await logIn(page, "wrong");
  await expect(page.getByRole("alert")).toHaveText("Неверный логин или пароль");

  await logIn(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
});
