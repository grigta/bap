import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { control, logIn } from "./helpers.ts";

test.afterEach(async () => {
  await control("start");
});

test("[REQ-UI-001] health indicator turns offline within 5 s after the Control Plane stops and recovers", async ({ page }) => {
  await logIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Обзор" })).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1, name: "Обзор" })).toBeVisible();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
});
