// The panel shell: addressable pages, URL state, Cmd+K, theme, overview numbers and accessibility.
import { type ChildProcess, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
let agent: ChildProcess | undefined;
let runId = "";

test.describe.configure({ mode: "serial" });
test.afterAll(() => killAgent(agent));

/** One finished run to look at: an agent on local Chromium, a profile and the smoke scenario. */
test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await browser.newPage();
  await logIn(page);
  const api = page.request;
  const name = `ui-mac-${crypto.randomUUID().slice(0, 4)}`;
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-ui-"));
  mkdirSync(join(data, "profiles", `${name}-p`), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const { token } = await (await api.post("/api/v1/agents/enrollments")).json();
  await promisify(execFile)("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", name], { env });
  agent = spawnAgent(cli, env);
  await expect.poll(async () => (await agentByName(api, name))?.maxSessions ?? null, { timeout: 20_000 }).not.toBeNull();
  const agentId = (await agentByName(api, name)).id;
  const profile = await (await api.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: `${name}-p`, name: `${name}-p` } })).json();
  runId = (
    await (
      await api.post("/api/v1/runs", {
        data: { scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId: profile.id, input: { baseUrl: "http://127.0.0.1:4310" } },
        headers: { "idempotency-key": crypto.randomUUID() },
      })
    ).json()
  ).runId;
  await expect.poll(async () => (await (await api.get(`/api/v1/runs/${runId}`)).json()).status, { timeout: 30_000 }).toBe("SUCCEEDED");
  await page.close();
});

const agentByName = async (api: APIRequestContext, name: string) => (await (await api.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name);

test("[REQ-UI-004] a run has its own address: it opens after a reload and after signing in", async ({ page }) => {
  await logIn(page);
  await page.goto(`/runs/${runId}`);
  const detail = page.getByTestId("run-detail");
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED");
  await page.reload();
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED");

  await page.getByRole("button", { name: "Выйти" }).click();
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByLabel("Логин").fill("operator");
  await page.getByLabel("Пароль").fill("e2e-password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(detail.getByTestId("run-status")).toHaveText("SUCCEEDED");
  expect(new URL(page.url()).pathname).toBe(`/runs/${runId}`);
});

test("the run status filter lives in the URL, so back and forward restore it", async ({ page }) => {
  await logIn(page);
  await goTo(page, "Задания");
  const filter = page.getByLabel("Фильтр статуса");
  await filter.selectOption("SUCCEEDED");
  await expect(page).toHaveURL(/status=SUCCEEDED/);
  await expect(page.getByTestId(`run-${runId}`)).toBeVisible();
  for (const s of await page.getByTestId("run-row-status").allTextContents()) expect(s).toBe("SUCCEEDED");
  await filter.selectOption("FAILED");
  await expect(page).toHaveURL(/status=FAILED/);
  await expect(page.getByTestId(`run-${runId}`)).toBeHidden();
  await page.goBack();
  await expect(filter).toHaveValue("SUCCEEDED");
  await expect(page.getByTestId(`run-${runId}`)).toBeVisible();
});

test("Cmd+K finds a run by the start of its id and opens it", async ({ page }) => {
  await logIn(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Раздел, id задания, агент, профиль…").fill(runId.slice(0, 6));
  await expect(page.getByRole("option").first()).toContainText(runId.slice(0, 8));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByTestId("run-detail").getByTestId("run-status")).toHaveText("SUCCEEDED");
});

test("the chosen theme applies at once and survives a reload", async ({ page }) => {
  await logIn(page);
  const html = page.locator("html");
  await page.getByRole("button", { name: "Тема оформления" }).click();
  await page.getByRole("menuitemradio", { name: "Тёмная" }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Тема оформления" }).click();
  await page.getByRole("menuitemradio", { name: "Светлая" }).click();
  await expect(html).not.toHaveClass(/dark/);
});

test("the overview shows the same numbers as the API", async ({ page }) => {
  await logIn(page);
  const api = page.request;
  const [agents, runs, review] = await Promise.all(["/api/v1/agents", "/api/v1/runs?limit=500", "/api/v1/review"].map(async (u) => (await api.get(u)).json()));
  const fleet = agents.filter((a: { status: string }) => a.status !== "REVOKED");
  const value = (id: string) => page.getByTestId(id).locator("[data-slot=value]");
  await expect(value("reading-online")).toHaveText(String(fleet.filter((a: { connection: string }) => a.connection === "ONLINE").length));
  await expect(value("reading-queued")).toHaveText(String(runs.filter((r: { status: string }) => r.status === "QUEUED").length));
  await expect(value("reading-review")).toHaveText(String(review.runs.length + review.profiles.length));
});

/** WCAG 2 A/AA by axe-core: serious and critical findings fail the page. */
async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

for (const scheme of ["light", "dark"] as const) {
  test(`every page passes axe WCAG 2 AA checks in the ${scheme} theme`, async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ colorScheme: scheme, baseURL: `http://127.0.0.1:${STACK_PORTS.web}` }); // axe needs a context of its own
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("heading", { name: "Вход" }).waitFor();
    const found: Record<string, string[]> = { login: await axe(page) };
    await logIn(page);
    for (const path of ["/", "/agents", "/profiles", "/runs", `/runs/${runId}`, "/recipes", "/review", "/audit"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForTimeout(800); // data arrives with the first poll
      found[path] = await axe(page);
    }
    expect(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length > 0))).toEqual({});
    await context.close();
  });
}
