import type { Page } from "@playwright/test";
import { E2E_OPERATOR, STACK_PORTS } from "./stack-config.ts";

export const control = (action: "stop" | "start") =>
  fetch(`http://127.0.0.1:${STACK_PORTS.control}/control-plane/${action}`, { method: "POST" });

export async function logIn(page: Page, password: string = E2E_OPERATOR.password) {
  await page.goto("/");
  await page.getByLabel("Логин").fill(E2E_OPERATOR.login);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
}
