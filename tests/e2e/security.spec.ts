import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { evidence } from "./evidence.ts";
import { agentMenu, confirmDialog, goTo, killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_PORTS } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const server = `http://127.0.0.1:${STACK_PORTS.controlPlane}`;
const control = (path: string) => fetch(`http://127.0.0.1:${STACK_PORTS.control}${path}`, { method: "POST" });

test("[REQ-UI-006][REQ-SEC-004][REQ-SEC-005][REQ-SEC-006] security demo: invitations, key rotation, tampered bundle and revocation, all visible in Audit", async ({ page }) => {
  test.setTimeout(120_000);
  // Unique per run: a developer's stack is reused between runs and agent names are unique.
  const run = randomUUID().slice(0, 4);
  const [name, expiredName, reuseName] = [`sec-mac-${run}`, `sec-expired-${run}`, `sec-reuse-${run}`];
  const data = mkdtempSync(join(tmpdir(), "bap-e2e-sec-"));
  mkdirSync(join(data, "profiles", `sec-profile-${run}`), { recursive: true });
  const env = { ...process.env, BAP_AGENT_DATA: data, BAP_PROVIDER: "local" };
  const enroll = (token: string, name: string) => spawnSync("node", [cli, "enroll", "--server", server, "--token", token, "--name", name], { env, encoding: "utf8" });
  const invite = async () => {
    await page.getByRole("button", { name: "Подключить Mac" }).click();
    await expect(page.getByTestId("invite-token")).not.toHaveText(previousToken);
    previousToken = (await page.getByTestId("invite-token").textContent())!;
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("invite")).toBeHidden();
    return previousToken;
  };
  let previousToken = "";
  let agent: ChildProcess | undefined;
  try {
    await logIn(page);
    await goTo(page, "Агенты");

    // 1. An expired invitation is refused.
    const expired = await invite();
    await control("/enrollments/expire");
    expect(enroll(expired, expiredName).stderr).toMatch(/INVITATION_INVALID/);

    // 2. A used invitation cannot be used again.
    const token = await invite();
    const first = enroll(token, name);
    expect(first.stdout, first.stderr).toContain(`enrolled as ${name}`);
    expect(enroll(token, reuseName).stderr).toMatch(/INVITATION_INVALID/);

    // 3. Key rotation: the agent switches keys and reconnects; the old key is rejected.
    const oldKey = JSON.parse(readFileSync(join(data, "agent.json"), "utf8")).agentKey as string;
    agent = spawnAgent(cli, env);
    const row = page.getByTestId(`agent-${name}`);
    await expect(row.getByTestId("agent-connection")).toHaveText("ONLINE", { timeout: 15_000 });
    await agentMenu(page, name, "Сменить ключ");
    await expect.poll(() => JSON.parse(readFileSync(join(data, "agent.json"), "utf8")).agentKey, { timeout: 10_000 }).not.toBe(oldKey);
    await expect(row.getByTestId("agent-connection")).toHaveText("ONLINE", { timeout: 10_000 });
    expect((await fetch(`${server}/api/v1/agents/me/key`, { method: "POST", headers: { authorization: `Bearer ${oldKey}` } })).status).toBe(401);
    await evidence(page, "S8", "3-key-rotated");

    // 6. A bundle swapped in storage fails the run with a checksum error.
    const agentId = (await (await page.request.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name).id;
    const profile = await (await page.request.post("/api/v1/profiles/import", { data: { agentId, externalProfileId: `sec-profile-${run}`, name: `sec-profile-${run}` } })).json();
    await control("/bundles/slow-page/tamper");
    try {
      const { runId } = await (
        await page.request.post("/api/v1/runs", { data: { scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId: profile.id, input: { baseUrl: "http://127.0.0.1:4310", ms: 10 } }, headers: { "idempotency-key": randomUUID() } })
      ).json();
      await goTo(page, "Конвейер");
      await page.getByTestId(`run-${runId}`).getByRole("link").first().click();
      await expect(page.getByTestId("run-detail").getByTestId("run-status")).toHaveText("FAILED", { timeout: 30_000 });
      await expect(page.getByTestId("run-error")).toContainText("BUNDLE_CHECKSUM_MISMATCH");
      await expect(page.getByTestId(`run-${runId}`)).toContainText("FAILED");
      await evidence(page, "S8", "6-bundle-checksum");
    } finally {
      await control("/bundles/slow-page/restore");
    }

    // 4. Revoke: the agent is cut off and a restart does not bring it back.
    await goTo(page, "Агенты");
    const exited = new Promise<number | null>((r) => agent!.once("exit", r));
    await agentMenu(page, name, "Отозвать доступ");
    await confirmDialog(page);
    await expect(row.getByTestId("agent-status")).toHaveText("REVOKED");
    await expect(row.getByTestId("agent-connection")).toHaveText("OFFLINE");
    expect(await exited).toBe(0);
    const restarted = spawn("node", [cli, "start"], { env, stdio: "pipe" });
    let output = "";
    restarted.stdout!.on("data", (c) => (output += c));
    restarted.stderr!.on("data", (c) => (output += c));
    expect(await new Promise((r) => restarted.once("exit", r))).not.toBeNull();
    expect(output).toMatch(/rejected the agent credentials \(401\)/);
    await evidence(page, "S8", "4-agent-revoked");

    // 7. Audit shows every step above, refusals included.
    await goTo(page, "Все логи");
    const rows = page.getByTestId("audit-row");
    for (const action of ["Приглашение агента", "Регистрация агента", "Ротация ключа (запрос)", "Ротация ключа (агент сменил ключ)", "Запуск задания", "Revoke агента"])
      await expect(rows.filter({ hasText: action }).first()).toBeVisible();
    await expect(rows.filter({ hasText: expiredName }).filter({ hasText: "DENIED" })).toHaveCount(1);
    await expect(rows.filter({ hasText: reuseName }).filter({ hasText: "DENIED" })).toHaveCount(1);
    await evidence(page, "S8", "7-audit");
    await page.getByRole("checkbox", { name: "Только отказы" }).check();
    await expect(rows.filter({ hasText: "OK" })).toHaveCount(0);
    await evidence(page, "S8", "1-2-audit-denied-invitations");
  } finally {
    killAgent(agent);
  }
});
