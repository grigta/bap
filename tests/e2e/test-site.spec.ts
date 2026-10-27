import { expect, test } from "@playwright/test";

test("test site counts visits per browser profile", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#visits")).toHaveText("1");
  await page.reload();
  await expect(page.locator("#visits")).toHaveText("2");
  await expect(page).toHaveScreenshot("test-site-second-visit.png");
});
