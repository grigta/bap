import { type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { confirmDialog, goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_FLEET, STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const server = `http://127.0.0.1:${STACK_PORTS.controlPlane}`;

test("[REQ-UI-002] operator invites an agent, watches its connection and drains, then revokes it", async ({ page }) => {
  test.setTimeout(60_000);
  const env = { ...process.env, BAP_AGENT_DATA: mkdtempSync(join(tmpdir(), "bap-e2e-agent-")), BAP_LS_API_URL: "" };
  let agent: ChildProcess | undefined;
  try {
    await logIn(page);
    await goTo(page, "Агенты");
    await page.getByRole("button", { name: "Подключить Mac" }).click();
    const token = (await page.getByTestId("invite-token").textContent())!;
    await evidence(page, "S3", "invite");

    const enroll = (name: string) => spawnSync("node", [cli, "enroll", "--server", server, "--token", token, "--name", name], { env, encoding: "utf8" });
    expect(enroll("e2e-mac").stdout).toMatch(/enrolled as e2e-mac/);
    const reused = enroll("e2e-mac-2");
    expect(reused.status).toBe(3);
    expect(reused.stderr).toMatch(/INVITATION_INVALID/);

    agent = spawnAgent(cli, env);
    // The connect dialog follows its invitation: registered, then online.
    await expect(page.getByTestId("invite-status")).toContainText("e2e-mac", { timeout: 10_000 });
    await expect(page.getByTestId("invite-status").getByText("ONLINE")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    const row = page.getByTestId("agent-e2e-mac");
    await expect(row.getByTestId("agent-status")).toHaveText("ACTIVE", { timeout: 10_000 });
    await expect(row.getByTestId("agent-connection")).toHaveText("ONLINE");
    await expect(row).toContainText("с назад");
    await evidence(page, "S3", "agents-online");

    await row.getByRole("link", { name: "e2e-mac" }).click();
    await expect(page.getByTestId("agent-card")).toContainText(/Последние [2-9]\d* heartbeat/, { timeout: 10_000 });
    await evidence(page, "S3", "agent-card");
    await page.keyboard.press("Escape"); // the card is a side sheet over the table
    await expect(page.getByTestId("agent-card")).toBeHidden();

    agent.kill("SIGSTOP");
    await expect(row.getByTestId("agent-connection")).toHaveText("SUSPECT", { timeout: STACK_FLEET.suspectAfterMs + 4000 });
    await evidence(page, "S3", "agents-suspect");
    await expect(row.getByTestId("agent-connection")).toHaveText("OFFLINE", { timeout: STACK_FLEET.offlineAfterMs + 4000 });
    await evidence(page, "S3", "agents-offline");
    agent.kill("SIGCONT");
    await expect(row.getByTestId("agent-connection")).toHaveText("ONLINE", { timeout: 8000 });

    await row.getByRole("button", { name: "Drain" }).click();
    await expect(row.getByTestId("agent-status")).toHaveText("DRAINING");

    const exited = new Promise<number | null>((r) => agent!.once("exit", r));
    await row.getByRole("button", { name: "Revoke" }).click();
    await confirmDialog(page);
    await expect(row.getByTestId("agent-status")).toHaveText("REVOKED");
    expect(await exited).toBe(0);
    await evidence(page, "S3", "agents-revoked");
  } finally {
    killAgent(agent);
  }
});
