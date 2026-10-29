import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { parseCsv } from "@bap/csv";
import { evidence } from "./evidence.ts";
import { confirmDialog, goTo, killAgent, localMac, logIn } from "./helpers.ts";

const agents: ChildProcess[] = [];
test.afterAll(() => agents.forEach(killAgent));

test("[REQ-UI-012][REQ-UI-013] the operator imports a table, links it to profiles by a column, edits cells and proxies, sees their state and exports it with our columns", async ({ page }) => {
  test.setTimeout(90_000);
  await logIn(page);
  const profile = await localMac(page, agents, `table-${randomUUID().slice(0, 4)}`);
  // Made-up people: the owner's real table never appears in tests or screenshots.
  const csv = `ФИО;Должность;Профиль\nИванов Тест Тестович;оператор;${profile}\nПетров Проба Пробович;стажёр;нет-такого\n`;

  // Another spec may have left its table: this one starts from none.
  await page.request.delete("/api/v1/pipeline");
  await goTo(page, "Конвейер");
  await page.getByRole("button", { name: "Таблица" }).click();
  await expect(page.getByText("Таблица не загружена")).toBeVisible();
  await page.getByLabel("Файл CSV").setInputFiles({ name: "сотрудники.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("pipeline-file")).toHaveText("сотрудники.csv");
  const table = page.getByTestId("pipeline-table");
  await expect(table.getByRole("columnheader")).toHaveText(["ФИО", "Должность", "Профиль", "Статус профиля", "Mac", "Последний проход", "Ошибка", "LS Clicker", "Прокси"]);
  await expect(table.getByTestId("pipeline-profile-status")).toHaveCount(0);

  await page.getByLabel("Колонка с профилем").selectOption({ label: "Профиль" });
  const [mine, stranger] = [table.getByTestId("pipeline-row").nth(0), table.getByTestId("pipeline-row").nth(1)];
  await expect(mine.getByTestId("pipeline-profile-status")).toHaveText("AVAILABLE");
  await expect(mine).toContainText(profile.replace(/-profile$/, ""));
  await expect(stranger.getByTestId("pipeline-profile-status")).toHaveCount(0);
  await page.getByLabel("Поиск по таблице").fill("Петров");
  await expect(table.getByTestId("pipeline-row")).toHaveCount(1);
  await page.getByLabel("Поиск по таблице").fill("");
  await evidence(page, "S18", "1-table");

  // Cells and the proxy are edited in place; the password of a proxy is not on screen.
  await mine.getByRole("button", { name: /^Должность, строка 1:/ }).click();
  await page.getByLabel("Должность, строка 1").fill("старший оператор");
  await page.getByLabel("Должность, строка 1").press("Enter");
  await expect(mine.getByRole("button", { name: /^Должность, строка 1:/ })).toHaveText("старший оператор");
  await mine.getByTestId("pipeline-proxy").click();
  await page.getByLabel("Прокси, строка 1").fill("10.0.0.7");
  await expect(page.getByText("ip:port или ip:port@login:pass")).toBeVisible();
  await page.getByLabel("Прокси, строка 1").fill("10.0.0.7:1080@user:secret-pass");
  await page.getByLabel("Прокси, строка 1").press("Enter");
  await expect(mine.getByTestId("pipeline-proxy")).toHaveText("10.0.0.7:1080@user:•••");
  await evidence(page, "S21", "1-table-proxy");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Выгрузить CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("сотрудники-конвейер.csv");
  const exported = parseCsv(readFileSync((await file.path())!, "utf8"));
  expect(exported.columns).toEqual(["ФИО", "Должность", "Профиль", "Статус профиля", "Mac", "Последний проход", "Статус прохода", "Ошибка", "Когда", "LS Clicker: Mac", "Прокси"]);
  expect(exported.rows[0]!.slice(0, 4)).toEqual(["Иванов Тест Тестович", "старший оператор", profile, "AVAILABLE"]);
  expect(exported.rows[0]!.at(-1)).toBe("10.0.0.7:1080@user:secret-pass");
  expect(exported.rows[1]!.slice(3)).toEqual(["", "", "", "", "", "", "", ""]);

  await page.getByRole("button", { name: "Очистить таблицу" }).click();
  await confirmDialog(page);
  await expect(page.getByText("Таблица не загружена")).toBeVisible();
  await evidence(page, "S18", "2-empty");
});
