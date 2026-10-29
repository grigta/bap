import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { goTo, killAgent, localMac, logIn } from "./helpers.ts";
const agents: ChildProcess[] = [];
test.afterAll(() => agents.forEach(killAgent));
// The list refreshes every 2 s and the panel ticks every second: an open menu must survive both.
test("[REQ-UI-002] an agent's menu stays open while the list refreshes underneath", async ({ page }) => {
  await logIn(page);
  const name = `menu-${randomUUID().slice(0, 4)}`;
  await localMac(page, agents, name);
  await goTo(page, "Агенты");
  await page.getByRole("button", { name: `Ещё действия с ${name}` }).click();
  const item = page.getByRole("menuitem", { name: "Сменить ключ" });
  await expect(item).toBeVisible();
  const handle = await item.elementHandle();
  await page.waitForTimeout(5000);
  expect(await handle!.evaluate((e) => e.isConnected)).toBe(true);
  await expect(item).toBeVisible();
});
