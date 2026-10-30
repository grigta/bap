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

test("[REQ-UI-012][REQ-UI-013][REQ-UI-014][REQ-LSC-007] the operator imports a table and sees it like a spreadsheet, picks the collapsed columns, opens a row to edit its cells and proxy, adds rows in the empty last row or as a list, deletes rows, pages through, and exports it with our columns", async ({ page }) => {
  test.setTimeout(90_000);
  await logIn(page);
  const profile = await localMac(page, agents, `table-${randomUUID().slice(0, 4)}`);
  // Made-up people: the owner's real table never appears in tests or screenshots.
  const csv = `ФИО;Должность;Профиль\nИванов Тест Тестович;оператор;${profile}\nПетров Проба Пробович;стажёр;нет-такого\n`;

  // Another spec may have left its table: this one starts from none.
  await page.request.delete("/api/v1/pipeline");
  await goTo(page, "Конвейер");
  await expect(page.getByText("Таблица не загружена")).toBeVisible();
  await page.getByLabel("Файл CSV").setInputFiles({ name: "сотрудники.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("pipeline-file")).toHaveText("сотрудники.csv");
  const table = page.getByTestId("pipeline-table");
  await expect(table.getByRole("columnheader")).toHaveText(["#", "ФИО", "Должность", "Профиль", "Прокси", "LS Clicker", "Статус профиля"]);
  await expect(table.getByTestId("pipeline-profile-status")).toHaveCount(0);

  expect((await page.request.put("/api/v1/pipeline/profile-column", { data: { column: 2 } })).status()).toBe(204);
  await page.reload();
  // Rows waiting for their proxy move to the top, so rows are found by their text.
  const [mine, stranger] = [table.getByTestId("pipeline-row").filter({ hasText: "Иванов" }), table.getByTestId("pipeline-row").filter({ hasText: "Петров" })];
  await expect(mine.getByTestId("pipeline-profile-status")).toHaveText("AVAILABLE");
  await expect(stranger.getByTestId("pipeline-profile-status")).toHaveCount(0);
  // Like a spreadsheet: every value on one line.
  await expect(mine).toContainText("Иванов Тест Тестович");
  await expect(mine.getByTestId("pipeline-proxy")).toHaveText("—");

  // «только новые строки»: the rows already there become history, LS Clicker starts with the next one added.
  await page.getByRole("button", { name: "только новые строки" }).click();
  await expect(page.getByTestId("pipeline-lsc-from")).toContainText("LS Clicker берёт строки с 3-й, выше — история");
  // History moves to «result.csv» below the table.
  await expect(mine).toHaveCount(0);
  await expect(page.getByTestId("pipeline-result-table").getByTestId("pipeline-row").filter({ hasText: "Иванов" }).getByTestId("pipeline-lsc")).toHaveText("история");
  await page.getByRole("button", { name: "брать с первой" }).click();
  // No proxy yet: the row waits for it.
  await expect(mine.getByTestId("pipeline-lsc")).toHaveText("wait info");

  // «Настройка» picks the columns of the collapsed view; «Развернуть» shows them all.
  await page.getByRole("button", { name: "Настройка" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Должность" }).click();
  await page.keyboard.press("Escape");
  await expect(table.getByRole("columnheader")).toHaveText(["#", "ФИО", "Профиль", "Прокси", "LS Clicker", "Статус профиля"]);
  await page.getByRole("button", { name: "Развернуть таблицу" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["#", "ФИО", "Должность", "Профиль", "Прокси", "LS Clicker", "Статус профиля"]);
  await page.getByRole("button", { name: "Свернуть таблицу" }).click();
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await page.reload();
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await page.getByRole("button", { name: "Развернуть таблицу" }).click();
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
  await expect(page.getByText(/^не похоже на прокси/)).toBeVisible();
  // Written as login:pass@ip:port, stored as ls-clicker takes it.
  await page.getByLabel("Прокси, строка 1").fill("user:secret-pass@10.0.0.7:1080");
  await page.getByLabel("Прокси, строка 1").press("Enter");
  await expect(sheet.getByTestId("pipeline-proxy-edit")).toHaveText("10.0.0.7:1080@user:•••");
  await evidence(page, "S21", "1-table-proxy");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(mine.getByTestId("pipeline-proxy")).toHaveText("10.0.0.7:1080@user:•••");
  await evidence(page, "S22", "0-table");
  // Base UI marks the close button of a stacked toast aria-hidden while keeping it focusable: not this page's markup.
  expect((await new AxeBuilder({ page }).exclude("[data-slot=toast-close]").withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  // The empty last row: what is typed there becomes a row once the focus leaves it, and a new empty row appears.
  await page.getByLabel("Новая строка: ФИО").fill("Сидоров Опыт Опытович");
  await page.getByLabel("Новая строка: Должность").fill("практикант");
  await page.getByRole("heading", { level: 1 }).click();
  await expect(table.getByTestId("pipeline-row")).toHaveCount(3);
  await expect(table.getByTestId("pipeline-row").filter({ hasText: "Сидоров Опыт Опытович" })).toHaveCount(1);
  await expect(page.getByLabel("Новая строка: ФИО")).toHaveValue("");

  // «Строки списком»: comma-separated values in the column order, one row per line.
  await page.getByRole("button", { name: "Строки списком" }).click();
  await page.getByRole("textbox", { name: "Строки" }).fill("\"Кузнецова, Проба\",,нет");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(table.getByTestId("pipeline-row")).toHaveCount(4);
  await expect(table.getByTestId("pipeline-row").filter({ hasText: "Кузнецова, Проба" })).toHaveCount(1);
  await evidence(page, "S22", "1-add-rows");

  // A row that has not gone to a Mac can be deleted from its card.
  await table.getByTestId("pipeline-row").filter({ hasText: "Кузнецова, Проба" }).click();
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

  // A long table is paged; a wide one moves sideways from the scrollbar above it, without scrolling down first.
  const fields = Array.from({ length: 80 }, (_, i) => `Поле ${i + 1}`);
  const line = fields.map(() => "x").join(";");
  await page.getByLabel("Файл CSV").setInputFiles({ name: "широкая.csv", mimeType: "text/csv", buffer: Buffer.from(`${fields.join(";")}\n${`${line}\n`.repeat(30)}`) });
  await expect(page.getByTestId("pipeline-file")).toHaveText("широкая.csv");
  await page.getByLabel("Строк на странице").selectOption("25");
  await expect(table.getByTestId("pipeline-row")).toHaveCount(25);
  await expect(page.getByTestId("pipeline-pages")).toContainText("1 из 2 · всего 30");
  await page.getByRole("button", { name: "Следующая страница" }).click();
  await expect(table.getByTestId("pipeline-row")).toHaveCount(5);
  await expect(table.getByTestId("pipeline-row").first().getByRole("button")).toHaveText("26");
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

test("[REQ-LSC-007][REQ-LSC-008] rows with a good or bad status (also set by hand) move to «result.csv» below; rows waiting for their number or proxy are on top", async ({ page }) => {
  await logIn(page);
  await page.request.delete("/api/v1/pipeline");
  // Made-up rows.
  await page.request.post("/api/v1/pipeline/import?name=status.csv", { data: "who,status,number\nann,good,1\nbob,,2\ncarl,BAD,3\ndora,,\n", headers: { "content-type": "text/csv" } });
  await page.request.patch("/api/v1/pipeline/rows/2", { data: { proxy: "10.9.9.9:1080" } });
  await goTo(page, "Конвейер");
  const rows = page.getByTestId("pipeline-table").getByTestId("pipeline-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("dora");
  await expect(rows.nth(0).getByTestId("pipeline-lsc")).toHaveText("wait info");
  await expect(rows.nth(1).getByTestId("pipeline-lsc")).toHaveText("готова");
  const result = page.getByTestId("pipeline-result-table").getByTestId("pipeline-row");
  await expect(result).toHaveCount(2);
  await expect(result.nth(0)).toContainText("ann");
  await expect(result.nth(1)).toContainText("carl");

  // By hand: bob is marked bad and joins them; «—» brings him back.
  await rows.filter({ hasText: "bob" }).getByLabel(/^Итог строки/).selectOption("bad");
  await expect(result).toHaveCount(3);
  await result.filter({ hasText: "bob" }).getByLabel(/^Итог строки/).selectOption("");
  await expect(result).toHaveCount(2);
  await expect(rows.filter({ hasText: "bob" })).toHaveCount(1);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать result.csv" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("result.csv");
  expect(parseCsv(readFileSync((await file.path())!, "utf8")).rows).toEqual([
    ["ann", "good", "1"],
    ["carl", "BAD", "3"],
  ]);
  await page.request.delete("/api/v1/pipeline");
});
