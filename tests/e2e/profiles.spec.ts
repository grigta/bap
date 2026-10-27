import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { logIn } from "./helpers.ts";
import { STACK_FLEET, STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");

test("[REQ-UI-003] operator imports profiles, verifies, disables and enables them and sees an unreachable node", async ({ page }) => {
  test.setTimeout(90_000);
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-profiles-"));
  for (const p of ["shop-a", "shop-b"]) mkdirSync(join(data, "profiles", p), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  let agent: ChildProcess | undefined;
  try {
    await logIn(page);
    const invite = await page.request.post("/api/v1/agents/enrollments");
    expect(invite.status()).toBe(201);
    const { token } = await invite.json();
    const enrolled = spawnSync("node", [cli, "enroll", "--server", `http://127.0.0.1:${STACK_PORTS.controlPlane}`, "--token", token, "--name", "profiles-mac"], { env, encoding: "utf8" });
    expect(enrolled.stderr).toBe("");
    agent = spawn("node", [cli, "start"], { env, stdio: "ignore" });

    await page.getByRole("button", { name: "Profiles" }).click();
    await expect(page.getByRole("option", { name: "profiles-mac" })).toBeAttached({ timeout: 10_000 });
    await page.getByLabel("Агент").selectOption({ label: "profiles-mac" });
    const listed = page.locator(".provider-profiles li");
    await expect(listed).toHaveCount(2);
    for (const name of ["shop-a", "shop-b"]) {
      await listed.filter({ hasText: name }).getByRole("button", { name: "Импортировать" }).click();
      await expect(listed.filter({ hasText: name }).getByRole("button")).toHaveText("Импортирован");
    }
    const a = page.getByTestId("profile-shop-a");
    const b = page.getByTestId("profile-shop-b");
    await expect(a.locator(".badge").last()).toHaveText("AVAILABLE");
    await evidence(page, "S4", "profiles-imported");

    await a.getByRole("button", { name: "Verify" }).click();
    await expect(a.locator(".badge").last()).toHaveText("AVAILABLE", { timeout: 20_000 });
    await expect(a.locator("td").nth(4)).not.toHaveText("—");
    await evidence(page, "S4", "profile-verified");

    rmSync(join(data, "profiles", "shop-b"), { recursive: true });
    await b.getByRole("button", { name: "Verify" }).click();
    await expect(b.locator(".badge").last()).toHaveText("NEEDS_REVIEW", { timeout: 20_000 });
    await expect(b).toContainText("configuration error");
    await evidence(page, "S4", "profile-not-found");

    await a.getByRole("button", { name: "Disable" }).click();
    await expect(a.locator(".badge").last()).toHaveText("DISABLED");
    await evidence(page, "S4", "profile-disabled");
    await a.getByRole("button", { name: "Enable" }).click();
    await expect(a.locator(".badge").last()).toHaveText("AVAILABLE", { timeout: 20_000 });

    agent.kill("SIGSTOP");
    await expect(a).toContainText("узел недоступен", { timeout: STACK_FLEET.suspectAfterMs + 4000 });
    await expect(a.locator(".badge").last()).toHaveText("AVAILABLE");
    await evidence(page, "S4", "profile-node-unreachable");
  } finally {
    agent?.kill("SIGKILL");
  }
});
