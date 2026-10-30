import { type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const fake = resolve(import.meta.dirname, "../fixtures/ls-clicker/fake-ls-clicker.mjs");
const agents: ChildProcess[] = [];
test.afterAll(() => agents.forEach(killAgent));

test("[REQ-LSC-004][REQ-LSC-008][REQ-LSC-009] LS Clicker is run from BAP: the build rolls out, every ticked Mac takes the next ready table row by itself, log, stage and plan are shown; a failed run lands on «Недоработки»", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  // Two Macs with an LS Clicker directory; the engine is a stand-in that registers nothing.
  const suffix = randomUUID().slice(0, 4);
  const names = [`clicker-a-${suffix}`, `clicker-b-${suffix}`];
  for (const name of names) {
    const env = { ...process.env, BAP_AGENT_DATA: mkdtempSync(join(tmpdir(), "bap-e2e-lsc-")), BAP_PROVIDER: "local", BAP_LS_CLICKER_DIR: join(mkdtempSync(join(tmpdir(), "bap-e2e-lsc-dir-")), "ls-clicker"), FAKE_LS_MS: "400" };
    const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
    expect(spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", name], { env, encoding: "utf8" }).stderr).toBe("");
    agents.push(spawnAgent(cli, env));
  }
  // The site's flow (normally set once by the operator): made-up steps.
  await page.request.put("/api/v1/ls-clicker/flow", { data: [{ key: "start", label: "Начало", aliases: ["start"] }, { key: "form", label: "Бизнес-форма", aliases: ["businessdetails"], action: "Next", fields: ["Название ← колонка"] }, { key: "done", label: "Готово", aliases: ["done"] }] });
  // Made-up rows.
  await page.request.post("/api/v1/pipeline/import?name=lsc.csv", { data: "who,company\nann,Acme\nbob,Beta\ncarl,Gamma\n", headers: { "content-type": "text/csv" } });
  // carl has no proxy yet: he waits («wait info»).
  for (const n of [1, 2]) await page.request.patch(`/api/v1/pipeline/rows/${n}`, { data: { proxy: "10.9.9.9:1080" } });

  // LS Clicker is on «Конвейер», above the table and the runs.
  await goTo(page, "Конвейер");
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Файл сборки ls-clicker").setInputFiles({ name: "ls-clicker", mimeType: "application/octet-stream", buffer: readFileSync(fake) });
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`).getByTestId("clicker-version")).toHaveText("fake-ls-clicker 1.0", { timeout: 20_000 });

  await expect(page.getByTestId("clicker-unsent")).toHaveText("Готовы к прогону: 2 · прогоны на Mac: 0 из 2");
  // A ticked Mac takes the next ready row by itself.
  for (const name of names) await page.getByRole("checkbox", { name: `Использовать ${name} для прогонов` }).click();
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`).getByTestId("clicker-run")).toHaveText("SUCCEEDED", { timeout: 15_000 });
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`).getByTestId("clicker-rows")).toHaveText("1 из 1 обработано");
  await expect(page.getByTestId("clicker-unsent")).toHaveText("Готовы к прогону: 0 · прогоны на Mac: 2 из 2");
  const first = page.getByTestId(`clicker-${names[0]}`);
  await expect(first.getByTestId("clicker-stage")).toHaveText("Бизнес-форма");
  await first.getByRole("button", { name: "Журнал" }).click();
  const details = page.getByTestId("clicker-details");
  await expect(details.getByRole("listitem").filter({ hasText: "Бизнес-форма" })).toHaveAttribute("aria-current", "step");
  await expect(details.getByTestId("clicker-log")).toContainText("строка 1: готово");
  await evidence(page, "S19", "1-ls-clicker");
  // Base UI marks the close button of a stacked toast aria-hidden while keeping it focusable: not this page's markup.
  expect((await new AxeBuilder({ page }).exclude("[data-slot=toast-close]").withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  await first.getByRole("button", { name: "План ввода" }).click();
  await expect(page.getByTestId("clicker-plan")).toContainText("Legal business name");
  await page.keyboard.press("Escape");

  // The rows' results are in the table below, on the same page.
  // carl waits for his proxy at the top of the table; the rows done follow.
  await expect(page.getByTestId("pipeline-lsc").nth(0)).toHaveText("wait info");
  await expect(page.getByTestId("pipeline-lsc").nth(1)).toHaveText(/clicker-[ab]-\w+ · обработана/, { timeout: 10_000 });
  await evidence(page, "S19", "2-table-results");
  for (const name of names) await page.getByRole("checkbox", { name: `Использовать ${name} для прогонов` }).click();
  await expect(page.getByTestId("clicker-unsent")).toContainText("прогоны на Mac: 0 из 2");

  // A failed run goes to «Недоработки»: its error, and on opening its log and stage.
  await page.request.post("/api/v1/pipeline/rows", { data: { text: "fail,Omega" } });
  const rows = (await (await page.request.get("/api/v1/pipeline")).json()).rows as { n: number; cells: string[] }[];
  await page.request.patch(`/api/v1/pipeline/rows/${rows.find((r) => r.cells[0] === "fail")!.n}`, { data: { proxy: "10.9.9.9:1080" } });
  await page.getByRole("checkbox", { name: `Использовать ${names[0]} для прогонов` }).click();
  await expect(page.getByTestId(`clicker-${names[0]}`).getByTestId("clicker-run")).toHaveText("FAILED", { timeout: 15_000 });
  await page.getByRole("checkbox", { name: `Использовать ${names[0]} для прогонов` }).click();
  await goTo(page, "Недоработки");
  const failure = page.getByTestId("review-lsc").filter({ hasText: names[0] });
  await expect(failure.getByTestId("review-lsc-error")).toHaveText("ОШИБКА: форма не принята", { timeout: 15_000 });
  await failure.getByRole("button", { name: /Строка/ }).click();
  await expect(failure.getByTestId("review-lsc-log")).toContainText("строка 2: начинаю");
  await expect(failure.getByTestId("review-lsc-details")).toContainText("businessDetails");
  // The page the engine stopped on: its error message and its buttons.
  await expect(failure.getByTestId("review-lsc-alerts")).toHaveText("That code didn't work.");
  await expect(failure.getByTestId("review-lsc-elements")).toContainText("Resend code");
  await evidence(page, "S22", "2-ls-clicker-failure");
  await failure.getByRole("button", { name: "Доработано" }).click();
  await page.getByLabel("Что сделано").fill("проверил форму");
  await page.getByRole("dialog").getByRole("button", { name: "Доработано" }).click();
  await expect(failure).toHaveCount(0);
});
