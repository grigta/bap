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

test("[REQ-UI-012][REQ-UI-013][REQ-UI-014] the operator imports a table, sees which fields are filled, links it to profiles by a column, opens a row to edit its cells and proxy, adds and deletes rows, and exports it with our columns", async ({ page }) => {
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
  await expect(table.getByRole("columnheader")).toHaveText(["#", "ФИО", "Должность", "Профиль", "Прокси", "LS Clicker", "Статус профиля"]);
  await expect(table.getByTestId("pipeline-profile-status")).toHaveCount(0);

  await page.getByLabel("Колонка с профилем").selectOption({ label: "Профиль" });
  const [mine, stranger] = [table.getByTestId("pipeline-row").nth(0), table.getByTestId("pipeline-row").nth(1)];
  await expect(mine.getByTestId("pipeline-profile-status")).toHaveText("AVAILABLE");
  await expect(stranger.getByTestId("pipeline-profile-status")).toHaveCount(0);
  // The overview shows only whether a field is filled, not its value.
  await expect(mine).not.toContainText("Иванов");
  await expect(mine.getByLabel("ФИО: есть")).toBeVisible();
  await expect(mine.getByLabel("Прокси: пусто")).toBeVisible();
  await page.getByLabel("Поиск по таблице").fill("Петров");
  await expect(table.getByTestId("pipeline-row")).toHaveCount(1);
  await page.getByLabel("Поиск по таблице").fill("");
  await evidence(page, "S18", "1-table");

  // A click on the row opens it in full: cells and the proxy are edited there; the password of a proxy is not on screen.
  await mine.click();
  const sheet = page.getByTestId("pipeline-row-sheet");
  await expect(sheet.getByRole("button", { name: /^ФИО, строка 1:/ })).toHaveText("Иванов Тест Тестович");
  await expect(sheet).toContainText(profile.replace(/-profile$/, ""));
  await sheet.getByRole("button", { name: /^Должность, строка 1:/ }).click();
  await page.getByLabel("Должность, строка 1").fill("старший оператор");
  await page.getByLabel("Должность, строка 1").press("Enter");
  await expect(sheet.getByRole("button", { name: /^Должность, строка 1:/ })).toHaveText("старший оператор");
  await sheet.getByTestId("pipeline-proxy-edit").click();
  await page.getByLabel("Прокси, строка 1").fill("10.0.0.7");
  await expect(page.getByText("ip:port или ip:port@login:pass", { exact: true })).toBeVisible();
  await page.getByLabel("Прокси, строка 1").fill("10.0.0.7:1080@user:secret-pass");
  await page.getByLabel("Прокси, строка 1").press("Enter");
  await expect(sheet.getByTestId("pipeline-proxy-edit")).toHaveText("10.0.0.7:1080@user:•••");
  await evidence(page, "S21", "1-table-proxy");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(mine.getByLabel("Прокси: есть")).toBeVisible();
  await evidence(page, "S22", "0-compact");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  // «+ строка»: comma-separated values in the column order, one row per line.
  await page.getByRole("button", { name: "Строка", exact: true }).click();
  await page.getByRole("textbox", { name: "Строки" }).fill("Сидоров Опыт Опытович,практикант\n\"Кузнецова, Проба\",,нет");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(table.getByTestId("pipeline-row")).toHaveCount(4);
  await expect(table.getByTestId("pipeline-row").nth(3).getByLabel("Должность: пусто")).toBeVisible();
  await evidence(page, "S22", "1-add-rows");

  // A row that has not gone to a Mac can be deleted from its card.
  await table.getByTestId("pipeline-row").nth(3).click();
  await page.getByRole("button", { name: "Удалить строку" }).click();
  await confirmDialog(page);
  await expect(table.getByTestId("pipeline-row")).toHaveCount(3);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Выгрузить CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("сотрудники-конвейер.csv");
  const exported = parseCsv(readFileSync((await file.path())!, "utf8"));
  expect(exported.columns).toEqual(["ФИО", "Должность", "Профиль", "Статус профиля", "Mac", "Последний проход", "Статус прохода", "Ошибка", "Когда", "LS Clicker: Mac", "Прокси"]);
  expect(exported.rows[0]!.slice(0, 4)).toEqual(["Иванов Тест Тестович", "старший оператор", profile, "AVAILABLE"]);
  expect(exported.rows[0]!.at(-1)).toBe("10.0.0.7:1080@user:secret-pass");
  expect(exported.rows[1]!.slice(3)).toEqual(["", "", "", "", "", "", "", ""]);
  expect(exported.rows.slice(2).map((r) => r.slice(0, 3))).toEqual([["Сидоров Опыт Опытович", "практикант", ""]]);

  // A wide table moves sideways from the scrollbar above it, without scrolling down first.
  const fields = Array.from({ length: 80 }, (_, i) => `Поле ${i + 1}`);
  await page.getByLabel("Файл CSV").setInputFiles({ name: "широкая.csv", mimeType: "text/csv", buffer: Buffer.from(`${fields.join(";")}\n${fields.map(() => "x").join(";")}\n`) });
  await expect(page.getByTestId("pipeline-file")).toHaveText("широкая.csv");
  await page.setViewportSize({ width: 900, height: 700 });
  const moved = await page.evaluate(() => {
    const top = document.querySelector<HTMLElement>("[data-testid=pipeline-scroll-top]")!;
    const box = document.querySelector<HTMLElement>("[data-testid=pipeline-scroll]")!;
    top.scrollLeft = 120;
    top.dispatchEvent(new Event("scroll"));
    return { overflow: box.scrollWidth > box.clientWidth, left: box.scrollLeft };
  });
  expect(moved.overflow).toBe(true);
  expect(moved.left).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Очистить таблицу" }).click();
  await confirmDialog(page);
  await expect(page.getByText("Таблица не загружена")).toBeVisible();
  await evidence(page, "S18", "2-empty");
});
