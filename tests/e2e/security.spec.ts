import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const server = `http://127.0.0.1:${STACK_PORTS.controlPlane}`;
const control = (path: string) => fetch(`http://127.0.0.1:${STACK_PORTS.control}${path}`, { method: "POST" });

test("[REQ-UI-006][REQ-SEC-004][REQ-SEC-005][REQ-SEC-006] security demo: invitations, key rotation, tampered bundle and revocation, all visible in Audit", async ({ page }) => {
  test.setTimeout(120_000);
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-sec-"));
  mkdirSync(join(data, "profiles", "sec-profile"), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const enroll = (token: string, name: string) => spawnSync("node", [cli, "enroll", "--server", server, "--token", token, "--name", name], { env, encoding: "utf8" });
  const invite = async () => {
    await page.getByRole("button", { name: "Пригласить агента" }).click();
    await expect(page.getByTestId("invite-token")).not.toHaveText(previousToken);
    return (previousToken = (await page.getByTestId("invite-token").textContent())!);
  };
  let previousToken = "";
  let agent: ChildProcess | undefined;
  try {
    await logIn(page);

    // 1. An expired invitation is refused.
    const expired = await invite();
    await control("/enrollments/expire");
    expect(enroll(expired, "sec-expired").stderr).toMatch(/INVITATION_INVALID/);

    // 2. A used invitation cannot be used again.
    const token = await invite();
    expect(enroll(token, "sec-mac").stdout).toMatch(/enrolled as sec-mac/);
    expect(enroll(token, "sec-mac-2").stderr).toMatch(/INVITATION_INVALID/);

    // 3. Key rotation: the agent switches keys and reconnects; the old key is rejected.
    const oldKey = JSON.parse(readFileSync(join(data, "agent.json"), "utf8")).agentKey as string;
    agent = spawnAgent(cli, env);
    const row = page.getByTestId("agent-sec-mac");
    await expect(row.locator(".badge").nth(1)).toHaveText("ONLINE", { timeout: 15_000 });
    await row.getByRole("button", { name: "Rotate key" }).click();
    await expect.poll(() => JSON.parse(readFileSync(join(data, "agent.json"), "utf8")).agentKey, { timeout: 10_000 }).not.toBe(oldKey);
    await expect(row.locator(".badge").nth(1)).toHaveText("ONLINE", { timeout: 10_000 });
    expect((await fetch(`${server}/api/v1/agents/me/key`, { method: "POST", headers: { authorization: `Bearer ${oldKey}` } })).status).toBe(401);
    await evidence(page, "S8", "3-key-rotated");

    // 6. A bundle swapped in storage fails the run with a checksum error.
    const agentId = (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === "sec-mac").id;
    const profile = await (await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: "sec-profile", name: "sec-profile" } })).json();
    await control("/bundles/slow-page/tamper");
    try {
      const { runId } = await (
        await page.request.post("/api/v1/runs", { data: { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId: profile.id, input: { baseUrl: "http://127.0.0.1:4310", ms: 10 } }, headers: { "idempotency-key": crypto.randomUUID() } })
      ).json();
      await page.getByRole("button", { name: "Runs" }).click();
      await page.getByTestId(`run-${runId}`).getByRole("button").first().click();
      await expect(page.getByTestId("run-detail").getByTestId("run-status")).toHaveText("FAILED", { timeout: 30_000 });
      await expect(page.getByTestId("run-error")).toContainText("BUNDLE_CHECKSUM_MISMATCH");
      await expect(page.getByTestId(`run-${runId}`)).toContainText("FAILED");
      await evidence(page, "S8", "6-bundle-checksum");
    } finally {
      await control("/bundles/slow-page/restore");
    }

    // 4. Revoke: the agent is cut off and a restart does not bring it back.
    await page.getByRole("button", { name: "Agents" }).click();
    const exited = new Promise<number | null>((r) => agent!.once("exit", r));
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(row.locator(".badge").first()).toHaveText("REVOKED");
    await expect(row.locator(".badge").nth(1)).toHaveText("OFFLINE");
    expect(await exited).toBe(0);
    const restarted = spawn("node", [cli, "start"], { env, stdio: "pipe" });
    let output = "";
    restarted.stdout!.on("data", (c) => (output += c));
    restarted.stderr!.on("data", (c) => (output += c));
    expect(await new Promise((r) => restarted.once("exit", r))).not.toBeNull();
    expect(output).toMatch(/rejected the agent credentials \(401\)/);
    await evidence(page, "S8", "4-agent-revoked");

    // 7. Audit shows every step above, refusals included.
    await page.getByRole("button", { name: "Audit" }).click();
    const rows = page.getByTestId("audit-row");
    for (const action of ["Приглашение агента", "Регистрация агента", "Ротация ключа (запрос)", "Ротация ключа (агент сменил ключ)", "Запуск задания", "Revoke агента"])
      await expect(rows.filter({ hasText: action }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "sec-expired" }).filter({ hasText: "DENIED" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "sec-mac-2" }).filter({ hasText: "DENIED" })).toHaveCount(1);
    await evidence(page, "S8", "7-audit");
    await page.getByLabel("Только отказы").check();
    await expect(rows.filter({ hasText: "OK" })).toHaveCount(0);
    await evidence(page, "S8", "1-2-audit-denied-invitations");
  } finally {
    killAgent(agent);
  }
});
