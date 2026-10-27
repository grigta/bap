import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";

test.describe("test site", () => {
  test.use({ baseURL: "http://127.0.0.1:4310" });
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/orders");
  });

  test("counts visits per browser profile", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.locator("#visits")).toHaveText("1");
    await page.reload();
    await expect(page.locator("#visits")).toHaveText("2");
    expect((await context.cookies()).find((c) => c.name === "visits")?.value).toBe("2");
    await expect(page).toHaveScreenshot("test-site-second-visit.png");
    await evidence(page, "S0", "test-site-visits");
  });

  test("wizard creates exactly one order per submission", async ({ page }) => {
    await page.goto("/wizard");
    await page.getByLabel("Товар").fill("Кофе");
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Далее" }).click();
    await expect(page.getByRole("heading")).toHaveText("Шаг 4 из 5: оформление");
    await page.getByRole("button", { name: "Оформить заказ" }).click();
    await expect(page.locator("#order-id")).toHaveText("#1");
    await page.goto("/orders");
    await expect(page.locator("#orders-count")).toHaveText("1");
    await evidence(page, "S0", "test-site-orders");
  });

  test("slow page delays its response and crash page fails", async ({ page }) => {
    const started = Date.now();
    await page.goto("/slow?ms=300");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await expect(page.locator("#slow")).toBeVisible();
    expect((await page.goto("/crash"))?.status()).toBe(500);
  });
});
