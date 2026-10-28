import { type ChildProcess, spawn } from "node:child_process";
import type { Page } from "@playwright/test";
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

export type Section = "Обзор" | "Агенты" | "Профили" | "Задания" | "Проверка" | "Аудит";

/** Opens a section from the sidebar. */
export async function goTo(page: Page, section: Section) {
  await page.getByRole("navigation").or(page.locator("[data-sidebar=sidebar]")).getByRole("link", { name: section, exact: true }).click();
  await page.getByRole("heading", { level: 1, name: section }).waitFor();
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
  return spawn("node", [cli, "start"], { env, stdio: "ignore", detached: true });
}

export function killAgent(agent: ChildProcess | undefined): void {
  if (!agent?.pid) return;
  try {
    process.kill(-agent.pid, "SIGKILL");
  } catch {
    // already gone
  }
}
