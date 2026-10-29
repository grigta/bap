import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, expect } from "@playwright/test";
import { E2E_OPERATOR, STACK_PORTS } from "./stack-config.ts";

export const control = (action: "stop" | "start") =>
  fetch(`http://127.0.0.1:${STACK_PORTS.control}/control-plane/${action}`, { method: "POST" });

export async function logIn(page: Page, password: string = E2E_OPERATOR.password) {
  await page.goto("/");
  await page.getByLabel("Логин").fill(E2E_OPERATOR.login);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  // Wait for the outcome: API calls made right after must carry the session cookie.
  await page.getByRole("button", { name: "Выйти" }).or(page.getByRole("alert")).waitFor();
}

export type Section = "Обзор" | "Агенты" | "Конвейер" | "LS Clicker" | "Недоработки" | "Все логи" | "Рецепты" | "Прогрев";

/** Opens a section from the sidebar. */
export async function goTo(page: Page, section: Section) {
  await page.getByRole("navigation").or(page.locator("[data-sidebar=sidebar]")).getByRole("link", { name: section, exact: true }).click();
  await page.getByRole("heading", { level: 1, name: section }).waitFor();
}

/** Picks an item from the "⋯" menu of an agent row on «Агенты». */
export async function agentMenu(page: Page, agent: string, item: "Отключить" | "Сменить ключ" | "Отозвать доступ") {
  await page.getByRole("button", { name: `Ещё действия с ${agent}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Accepts the in-app confirmation dialog that the last click opened. */
export async function confirmDialog(page: Page) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await dialog.getByRole("button").last().click();
  await dialog.waitFor({ state: "hidden" });
}

/** Starts `bap-agent start` in its own process group, so killAgent also takes down its browsers. */
export function spawnAgent(cli: string, env: NodeJS.ProcessEnv): ChildProcess {
  // The developer's Mac may hold the real LS Clicker (~/Developer/ls-clicker): test agents never touch it unless a test says so.
  return spawn("node", [cli, "start"], { env: { BAP_LS_CLICKER_DIR: "", ...env }, stdio: "ignore", detached: true });
}

export function killAgent(agent: ChildProcess | undefined): void {
  if (!agent?.pid) return;
  try {
    process.kill(-agent.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Enrolls a local-Chromium "Mac" with one profile and imports it; returns the profile name. Kill the agents after. */
export async function localMac(page: Page, agents: ChildProcess[], name: string): Promise<string> {
  const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-mac-"));
  mkdirSync(join(data, "profiles", `${name}-profile`), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const { token } = await (await page.request.post("/api/v1/agents/enrollments")).json();
  const enrolled = spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", name], { env, encoding: "utf8" });
  expect(enrolled.stderr).toBe("");
  agents.push(spawnAgent(cli, env));
  await expect.poll(async () => (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string; maxSessions: number | null }) => a.name === name && a.maxSessions !== null), { timeout: 15_000 }).toBeTruthy();
  const agentId = (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name).id;
  expect((await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: `${name}-profile`, name: `${name}-profile` } })).status()).toBe(201);
  return `${name}-profile`;
}
