import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { goTo, killAgent, localMac, logIn } from "./helpers.ts";

const SEARCH = "http://127.0.0.1:4330";
const agents: ChildProcess[] = [];
const recipe = `warm-open-${Date.now().toString(36)}`;
test.afterAll(() => agents.forEach(killAgent));

test("[REQ-FARM-003][REQ-FARM-005] demo: a recipe on a new profile waits while the panel warms the profile up, then runs", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await logIn(page);
  const profile = await localMac(page, agents, `warm-${Date.now().toString(36)}`);
  const steps = [{ id: "s01", intent: "Открыть поисковик", action: "navigate", value: `${SEARCH}/`, mutating: false }];
  expect((await page.request.post(`/api/v1/recipes/${recipe}/versions`, { data: { schema: 1, goal: "Открыть поисковик", startUrl: `${SEARCH}/`, inputs: [], steps } })).status()).toBe(201);
  await page.request.post(`/api/v1/recipes/${recipe}/versions/1.0.0/publish`);

  // 1. The operator sets the warm-up: queries, threshold, sites, time on a site.
  await goTo(page, "Прогрев");
  await page.getByLabel("Поисковые запросы").fill("бухгалтерия для ИП\nучёт малого бизнеса");
  await page.getByLabel("Прогревов до допуска").fill("2");
  await page.getByLabel("Сайтов за сессию").fill("2");
  await page.getByLabel("Секунд на сайте").fill("2");
  await page.getByLabel("Поисковик").fill(`${SEARCH}/`);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Сохранено" })).toBeVisible();
  await expect(page.getByTestId(`warm-${profile}`).getByTestId("profile-warmth")).toHaveText("0/2");
  await evidence(page, "S14", "1-settings");

  // 2. A recipe on the cold profile: it waits, the warm-ups go first by themselves.
  await goTo(page, "Задания");
  await page.getByLabel("Сценарий").selectOption(`${recipe}@1.0.0`);
  await expect(page.getByLabel("Профиль").getByRole("option", { name: profile, exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByLabel("Профиль").selectOption({ label: profile });
  await page.getByRole("button", { name: "Запустить" }).click();
  const detail = page.getByTestId("run-detail");
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(recipe);
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED", { timeout: 180_000 });
  const runs = (await (await page.request.get("/api/v1/runs")).json()) as { id: string; kind: string; status: string; profileId: string; startedAt: string; finishedAt: string; scenarioId: string }[];
  const profileId = ((await (await page.request.get("/api/v1/profiles")).json()) as { id: string; name: string }[]).find((p) => p.name === profile)!.id;
  const mine = runs.filter((r) => r.profileId === profileId);
  const farms = mine.filter((r) => r.kind === "farm");
  expect(farms.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  expect(mine).toHaveLength(3);
  const own = mine.find((r) => r.scenarioId === recipe)!;
  for (const f of farms) expect(Date.parse(own.startedAt)).toBeGreaterThanOrEqual(Date.parse(f.finishedAt));
  await evidence(page, "S14", "2-recipe-after-warmup");

  // 3. The journal of a warm-up: the query, the sites and the time on each.
  await page.goto(`/runs/${farms[0]!.id}`);
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(/Прогрев: (бухгалтерия для ИП|учёт малого бизнеса)/);
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED");
  await expect(detail.getByTestId("step-note").first()).toContainText("запрос «");
  await expect(detail.getByText(/127\.0\.0\.1:\d+: \d+ с, прокруток \d+/).first()).toBeVisible();
  await evidence(page, "S14", "3-warmup-journal");

  // 4. The profile is admitted.
  await goTo(page, "Прогрев");
  await expect(page.getByTestId(`warm-${profile}`).getByTestId("profile-warmth")).toHaveText("допущен");
  await goTo(page, "Профили");
  await expect(page.getByTestId(`profile-${profile}`).getByTestId("profile-warmth")).toHaveText("допущен");
  await evidence(page, "S14", "4-admitted");

  // Other specs run recipes on fresh profiles.
  const settings = await (await page.request.get("/api/v1/farming/settings")).json();
  await page.request.put("/api/v1/farming/settings", { data: { ...settings, requiredWarmups: 0 } });
});
