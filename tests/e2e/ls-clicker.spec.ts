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

test("[REQ-LSC-004] LS Clicker is run from BAP: the build rolls out, rows are sent, all Macs start, log, stage and plan are shown", async ({ page }) => {
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

  await goTo(page, "LS Clicker");
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Файл сборки ls-clicker").setInputFiles({ name: "ls-clicker", mimeType: "application/octet-stream", buffer: readFileSync(fake) });
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`).getByTestId("clicker-version")).toHaveText("fake-ls-clicker 1.0", { timeout: 20_000 });

  await page.getByRole("button", { name: /Отправить строки/ }).click();
  await expect(page.getByTestId(`clicker-${names[0]}`).getByTestId("clicker-rows")).toHaveText("0 из 2 обработано, в очереди 2", { timeout: 10_000 });
  await expect(page.getByTestId(`clicker-${names[1]}`).getByTestId("clicker-rows")).toHaveText("0 из 1 обработано, в очереди 1");

  await page.getByRole("button", { name: "Запустить на всех" }).click();
  for (const name of names) await expect(page.getByTestId(`clicker-${name}`).getByTestId("clicker-run")).toHaveText("SUCCEEDED", { timeout: 15_000 });
  const first = page.getByTestId(`clicker-${names[0]}`);
  await expect(first.getByTestId("clicker-stage")).toHaveText("Бизнес-форма");
  await expect(first.getByRole("listitem").filter({ hasText: "Бизнес-форма" })).toHaveAttribute("aria-current", "step");
  await first.getByRole("button", { name: "Журнал" }).click();
  await expect(page.getByTestId("clicker-log")).toContainText("строка 1: готово");
  await evidence(page, "S19", "1-ls-clicker");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  await first.getByRole("button", { name: "План ввода" }).click();
  await expect(page.getByTestId("clicker-plan")).toContainText("Legal business name");
  await page.keyboard.press("Escape");

  // The rows' results are in the table next to them.
  await goTo(page, "Конвейер");
  await page.getByRole("button", { name: "Таблица" }).click();
  await expect(page.getByTestId("pipeline-lsc").first()).toHaveText(`${names[0]} · обработана`, { timeout: 10_000 });
  await evidence(page, "S19", "2-table-results");
});
