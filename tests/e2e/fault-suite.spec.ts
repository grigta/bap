// Fault-suite (PRD §13.2, gate of S9): each case breaks one thing under a working system and records
// what was broken, what was expected, what was observed and the panel before/during/after.
// tests/e2e/fault-report.ts turns the results into reports/fault-suite/index.html.
import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { startFakeLinkenSphere } from "../support/fake-linken-sphere.ts";
import { outageProxy } from "../support/outage-proxy.ts";
import { killAgent, logIn, spawnAgent } from "./helpers.ts";
import { STACK_FLEET, STACK_PORTS, STACK_SCHEDULER } from "./stack-config.ts";

const cli = resolve(import.meta.dirname, "../../apps/mac-agent/src/cli.ts");
const site = "http://127.0.0.1:4310";
const control = (path: string) => fetch(`http://127.0.0.1:${STACK_PORTS.control}${path}`, { method: "POST" });
const setMode = (mode: object) => fetch(`${site}/api/mode`, { method: "POST", body: JSON.stringify(mode) });
const ordersFor = async (item: string) => ((await (await fetch(`${site}/api/orders`)).json()) as { item: string }[]).filter((o) => o.item === item).length;

interface Agent {
  name: string;
  id: string;
  data: string;
  env: NodeJS.ProcessEnv;
  process: ChildProcess;
}

// The agents reach the Control Plane through a proxy the suite can cut (network loss, lost acknowledgements).
const net = outageProxy(STACK_PORTS.controlPlane);
let netPort: number;
let ls: Awaited<ReturnType<typeof startFakeLinkenSphere>>;
let admin: Page;
let api: APIRequestContext;
let mac: Agent;
let lsMac: Agent;

test.describe.configure({ mode: "serial" });

async function enroll(name: string, extraEnv: NodeJS.ProcessEnv): Promise<Agent> {
  const data = mkdtempSync(join(tmpdir(), `bap-fault-${name}-`));
  const env = { ...process.env, BAP_AGENT_DATA: data, ...extraEnv };
  const { token } = await (await api.post("/api/v1/agents/enrollments")).json();
  // Asynchronous: the proxy to the Control Plane runs in this process and must keep forwarding.
  await promisify(execFile)("node", [cli, "enroll", "--server", `http://127.0.0.1:${netPort}`, "--token", token, "--name", name], { env });
  const agent = { name, data, env, process: spawnAgent(cli, env), id: "" };
  await expect.poll(async () => (await agentView(name))?.maxSessions ?? null, { timeout: 20_000 }).not.toBeNull();
  agent.id = (await agentView(name)).id;
  return agent;
}
const agentView = async (name: string) => (await (await api.get("/api/v1/agents")).json()).find((a: { name: string }) => a.name === name);

/** A fresh profile per case, so a case never inherits another case's review or lease. */
async function newProfile(agent: Agent, name: string): Promise<string> {
  const external = agent === lsMac ? ls.createSession(name) : (mkdirSync(join(agent.data, "profiles", name), { recursive: true }), name);
  const res = await api.post("/api/v1/profiles/import", { data: { agentId: agent.id, externalProfileId: external, name } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function startRun(body: object): Promise<string> {
  const res = await api.post("/api/v1/runs", { data: body, headers: { "idempotency-key": randomUUID() } });
  expect(res.status()).toBe(202);
  return (await res.json()).runId;
}
const runView = async (id: string) => (await api.get(`/api/v1/runs/${id}`)).json();
const profileView = async (id: string) => (await api.get(`/api/v1/profiles/${id}`)).json();
async function waitRun(id: string, statuses: string[], timeout = 60_000) {
  await expect.poll(async () => (await runView(id)).status, { timeout }).toMatch(new RegExp(`^(${statuses.join("|")})$`));
  return runView(id);
}
const transitions = (run: { transitions: { to: string }[] }) => run.transitions.map((t) => t.to).join(" → ");

/** Main Chromium processes (not helpers) started for this profile directory right now. */
const browserPids = (dir: string) =>
  execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(`--user-data-dir=${dir}`) && !l.includes("--type="))
    .map((l) => Number(l.trim().split(" ")[0]));
const browsersFor = (dir: string) => browserPids(dir).length;

// ---- recording a case ----
function fault(broke: string, expected: string) {
  test.info().annotations.push({ type: "broke", description: broke }, { type: "expected", description: expected });
}
function observed(text: string) {
  test.info().annotations.push({ type: "observed", description: text });
}
async function shot(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}
async function openRun(page: Page, runId: string) {
  await page.getByRole("button", { name: "Runs" }).click();
  await page.getByTestId(`run-${runId}`).getByRole("button").first().click();
  return page.getByTestId("run-detail");
}
const agentRow = (page: Page, name: string) => page.getByTestId(`agent-${name}`);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  netPort = await net.listen();
  ls = await startFakeLinkenSphere(mkdtempSync(join(tmpdir(), "bap-fault-ls-")));
  admin = await browser.newPage();
  await logIn(admin);
  api = admin.request;
  // Unique per run: a developer's stack is reused between runs and agent names are unique.
  const suffix = randomUUID().slice(0, 4);
  mac = await enroll(`fault-mac-${suffix}`, { BAP_PROVIDER: "local" });
  lsMac = await enroll(`fault-ls-mac-${suffix}`, { BAP_LS_API_URL: ls.url });
});

test.afterAll(async () => {
  for (const a of [mac, lsMac]) {
    if (a?.process.pid) process.kill(a.process.pid, "SIGCONT");
    killAgent(a?.process);
  }
  await ls?.stop();
  await net.close();
  await fetch(`${site}/api/orders`, { method: "DELETE" });
});

test.beforeEach(async ({ page }) => {
  await logIn(page);
});

test("1. Потеря связи с Mac", async ({ page }) => {
  test.setTimeout(120_000);
  fault(
    "Во время задания обрываем все соединения агента с Control Plane на 10 с (дольше порога OFFLINE и lease).",
    "Агент SUSPECT → OFFLINE; после возврата связи агент снова ONLINE, задание в актуальном статусе, шаги и скриншоты без пропусков и дублей.",
  );
  const profileId = await newProfile(mac, "net-p");
  const runId = await startRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site, ms: 9000 } });
  await waitRun(runId, ["RUNNING"]);
  await expect(agentRow(page, mac.name).locator(".badge").nth(1)).toHaveText("ONLINE");
  await shot(page, "до: агент ONLINE");

  net.down();
  await expect(agentRow(page, mac.name).locator(".badge").nth(1)).toHaveText("OFFLINE", { timeout: STACK_FLEET.offlineAfterMs + 4000 });
  const during = (await runView(runId)).status;
  await shot(page, "обрыв: агент OFFLINE");
  await sleep(3000);
  net.up();

  await expect(agentRow(page, mac.name).locator(".badge").nth(1)).toHaveText("ONLINE", { timeout: 20_000 });
  const done = await waitRun(runId, ["SUCCEEDED", "FAILED", "NEEDS_REVIEW", "RECOVERY_PENDING"]);
  const steps = await (await api.get(`/api/v1/runs/${runId}/steps`)).json();
  const detail = await openRun(page, runId);
  await expect(detail.getByTestId("run-status")).toHaveText(done.status);
  await shot(page, "после: задание и журнал переходов");
  observed(`Агент ONLINE → OFFLINE → ONLINE. Задание во время обрыва: ${during}; итог: ${done.status} (${transitions(done)}); шагов ${steps.length}, со скриншотом ${steps.filter((s: { screenshotArtifactId: string | null }) => s.screenshotArtifactId).length}.`);
  expect(done.status).toBe("SUCCEEDED");
  expect(steps).toHaveLength(1);
});

test("2. Перезапуск Control Plane", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Останавливаем Control Plane и запускаем снова на той же базе.", "Панель показывает offline, затем online; история заданий и статусы те же; агенты переподключаются сами; новые задания выполняются.");
  const before = (await (await api.get("/api/v1/runs")).json()) as { id: string; status: string }[];
  await page.getByRole("button", { name: "Runs" }).click();
  await shot(page, "до: история заданий");

  await control("/control-plane/stop");
  await expect(page.getByTestId("health")).toHaveText("Control Plane: offline", { timeout: 6000 });
  await shot(page, "остановлен: панель offline");
  await control("/control-plane/start");
  await expect(page.getByTestId("health")).toHaveText("Control Plane: online", { timeout: 6000 });

  const after = (await (await api.get("/api/v1/runs")).json()) as { id: string; status: string }[];
  expect(after.map((r) => `${r.id}:${r.status}`)).toEqual(before.map((r) => `${r.id}:${r.status}`));
  await page.getByRole("button", { name: "Agents" }).click();
  for (const name of [mac.name, lsMac.name]) await expect(agentRow(page, name).locator(".badge").nth(1)).toHaveText("ONLINE", { timeout: 20_000 });
  const runId = await startRun({ scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId: await newProfile(mac, "restart-p"), input: { baseUrl: site } });
  const done = await waitRun(runId, ["SUCCEEDED", "FAILED"]);
  await shot(page, "после: агенты снова ONLINE");
  observed(`Заданий до и после: ${before.length} = ${after.length}, статусы совпадают. Оба агента переподключились. Новое задание: ${done.status}.`);
  expect(done.status).toBe("SUCCEEDED");
});

test("3. Недоступность PostgreSQL", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Обрываем все соединения Control Plane с PostgreSQL и не даём открыть новые на 8 с.", "API отвечает 503 DATABASE_UNAVAILABLE, панель показывает баннер; процесс не падает; после возврата базы баннер исчезает и работа продолжается.");
  await shot(page, "до");
  await control("/database/down");
  await expect(page.getByTestId("database-banner")).toBeVisible({ timeout: 8000 });
  const failed = await api.get("/api/v1/runs");
  const body = await failed.json();
  await shot(page, "база недоступна: баннер");
  await sleep(4000);
  await control("/database/up");
  await expect(page.getByTestId("database-banner")).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId("health")).toHaveText("Control Plane: online");

  const runId = await startRun({ scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId: await newProfile(mac, "db-p"), input: { baseUrl: site } });
  const done = await waitRun(runId, ["SUCCEEDED", "FAILED"]);
  await openRun(page, runId);
  await shot(page, "после: новое задание выполнено");
  observed(`Во время отказа API: HTTP ${failed.status()} ${body.error?.code}; баннер показан и скрыт после возврата. Новое задание: ${done.status}.`);
  expect(failed.status()).toBe(503);
  expect(body.error.code).toBe("DATABASE_UNAVAILABLE");
  expect(done.status).toBe("SUCCEEDED");
});

test("4. Аварийное завершение браузера", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Посреди шага убиваем процесс Chromium профиля (kill -9).", "Задание FAILED с кодом и диагностикой; профиль проходит VERIFYING и возвращается в AVAILABLE (браузер действительно закрыт).");
  const profileId = await newProfile(mac, "crash-p");
  const runId = await startRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site, ms: 8000 } });
  await waitRun(runId, ["RUNNING"]);
  const dir = join(mac.data, "profiles", "crash-p");
  await expect.poll(() => browsersFor(dir), { timeout: 10_000 }).toBe(1);
  await sleep(1000); // the step is inside page.goto of a page that answers after 8 s
  const killed = browserPids(dir);
  for (const pid of killed) process.kill(pid, "SIGKILL");
  const detail = await openRun(page, runId);
  await shot(page, "сразу после kill -9 браузера");

  const done = await waitRun(runId, ["FAILED", "NEEDS_REVIEW", "SUCCEEDED"]);
  await expect(detail.getByTestId("run-status")).toHaveText(done.status, { timeout: 5000 });
  await shot(page, "после: задание с диагностикой");
  await expect.poll(async () => (await profileView(profileId)).status, { timeout: 20_000 }).toBe("AVAILABLE");
  await page.getByRole("button", { name: "Profiles" }).click();
  await shot(page, "профиль снова AVAILABLE");
  observed(`Убито процессов Chromium: ${killed.length}. Задание: ${done.status}, ${done.errorCode}: ${done.errorMessage}. Профиль: ${(await profileView(profileId)).status}; браузеров профиля: ${browsersFor(dir)}.`);
  expect(done).toMatchObject({ status: "FAILED", errorCode: "BROWSER_DISCONNECTED" });
});

test("5. Недоступность Local API", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Local API Linken Sphere (эмулятор с настоящим Chromium) перестаёт отвечать.", "Агент «LS ✗»; новое задание на его профиль не назначается и ждёт с причиной PROVIDER_UNAVAILABLE; после возврата API — «LS ✓», задание выполняется.");
  const profileId = await newProfile(lsMac, "ls-p");
  const row = agentRow(page, lsMac.name);
  await expect(row).toContainText("✓");
  await shot(page, "до: LS ✓");
  await ls.down();
  await expect(row.locator("td").nth(5)).toHaveText("✗", { timeout: 10_000 });
  const runId = await startRun({ scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site } });
  await sleep(2500);
  const waiting = await runView(runId);
  await page.getByRole("button", { name: "Runs" }).click();
  await shot(page, "API недоступен: LS ✗, задание в очереди");
  await ls.up();
  const done = await waitRun(runId, ["SUCCEEDED", "FAILED"]);
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(row.locator("td").nth(5)).toHaveText("✓", { timeout: 10_000 });
  await shot(page, "после: LS ✓");
  observed(`Пока API недоступен: задание ${waiting.status}, причина ${waiting.queueReason}. После возврата: ${done.status} (${transitions(done)}).`);
  expect(waiting).toMatchObject({ status: "QUEUED", queueReason: "PROVIDER_UNAVAILABLE" });
  expect(done.status).toBe("SUCCEEDED");
});

test("6. Повторная доставка сообщений", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Во время задания подтверждения сервера теряются (агент → сервер доходит, ответы нет), затем связь рвётся: агент отправляет неподтверждённое повторно.", "Повторы отброшены (счётчик дублей на карточке агента растёт); в журнале переходов и в шагах дублей нет.");
  const before = (await agentView(mac.name)).duplicateMessages as number;
  const profileId = await newProfile(mac, "dup-p");
  const runId = await startRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site, ms: 3000 } });
  await waitRun(runId, ["RUNNING"]);
  net.muteReplies("websocket"); // screenshot uploads (HTTP) still get answers
  await sleep(6000); // the run finishes; its events are stored but their acknowledgements are lost
  await net.outage(500);
  const done = await waitRun(runId, ["SUCCEEDED", "FAILED"]);
  await expect.poll(async () => (await agentView(mac.name)).duplicateMessages, { timeout: 15_000 }).toBeGreaterThan(before);
  const after = (await agentView(mac.name)).duplicateMessages as number;
  const steps = await (await api.get(`/api/v1/runs/${runId}/steps`)).json();
  const tos = done.transitions.map((t: { to: string }) => t.to);
  await openRun(page, runId);
  await shot(page, "задание: переходы без дублей");
  await page.getByRole("button", { name: "Agents" }).click();
  await agentRow(page, mac.name).getByRole("button", { name: mac.name }).click();
  await expect(page.getByTestId("duplicates")).toContainText(String(after));
  await shot(page, "карточка агента: отброшенные дубли");
  observed(`Отброшено повторов: ${after - before}. Переходы: ${tos.join(" → ")}; шагов: ${steps.length}.`);
  expect(done.status).toBe("SUCCEEDED");
  expect(new Set(tos).size).toBe(tos.length);
  expect(steps).toHaveLength(1);
});

test("7. Истечение lease при работающем браузере", async ({ page }) => {
  test.setTimeout(150_000);
  fault(
    "Замораживаем процесс агента (SIGSTOP) посреди задания: браузер продолжает работать, heartbeat нет, lease истекает. Ставим второе задание на тот же профиль.",
    "Второй браузер на профиле не стартует, пока прежний владелец не подтвердил освобождение; после разморозки агент забирает первое задание назад и доводит до финального статуса (шаг, переживший заморозку, может упасть по таймауту), затем выполняется второе.",
  );
  const profileId = await newProfile(mac, "lease-p");
  const dir = join(mac.data, "profiles", "lease-p");
  let maxBrowsers = 0;
  const sampler = setInterval(() => (maxBrowsers = Math.max(maxBrowsers, browsersFor(dir))), 300);
  try {
    const first = await startRun({ scenarioId: "slow-page", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site, ms: 20_000 } });
    await waitRun(first, ["RUNNING"]);
    process.kill(mac.process.pid!, "SIGSTOP");
    await sleep(STACK_SCHEDULER.leaseTtlMs + STACK_FLEET.offlineAfterMs);
    const second = await startRun({ scenarioId: "staging-smoke-test", scenarioVersion: "1.0.0", profileId, input: { baseUrl: site } });
    await sleep(3000);
    const [firstDuring, secondDuring, profileDuring] = [await runView(first), await runView(second), await profileView(profileId)];
    await page.getByRole("button", { name: "Profiles" }).click();
    await shot(page, "агент заморожен, lease истёк: профиль");
    await page.getByRole("button", { name: "Runs" }).click();
    await shot(page, "второе задание ждёт");
    process.kill(mac.process.pid!, "SIGCONT");

    const firstDone = await waitRun(first, ["SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"], 90_000);
    const secondDone = await waitRun(second, ["SUCCEEDED", "FAILED", "NEEDS_REVIEW"], 90_000);
    await openRun(page, first);
    await shot(page, "после: первое задание");
    observed(
      `Пока агент заморожен: первое ${firstDuring.status}, второе ${secondDuring.status} (${secondDuring.queueReason}), профиль ${profileDuring.status}. ` +
        `Итог: первое ${firstDone.status} (${transitions(firstDone)}), второе ${secondDone.status}. Максимум браузеров профиля одновременно: ${maxBrowsers}.`,
    );
    expect(secondDuring.status).toBe("QUEUED");
    expect(maxBrowsers).toBe(1);
    // The first run is no longer stuck in RECOVERY_PENDING: the agent took it back and ended it.
    expect(firstDone.transitions.map((t: { to: string }) => t.to)).toContain("RECOVERY_PENDING");
    expect(secondDone.status).toBe("SUCCEEDED");
  } finally {
    clearInterval(sampler);
    process.kill(mac.process.pid!, "SIGCONT");
  }
});

test("8. Неоднозначное действие", async ({ page }) => {
  test.setTimeout(120_000);
  fault(
    "Сайт принял заказ, но не отвечает браузеру дольше таймаута задания, а проверка заказов отвечает 503: подтвердить, прошёл ли заказ, нельзя.",
    "Задание и профиль — NEEDS_REVIEW с причиной; автоповтора нет: заказ один, второго запроса не было.",
  );
  const profileId = await newProfile(mac, "amb-p");
  const item = `coffee-${randomUUID().slice(0, 6)}`;
  await setMode({ orderHoldMs: 10_000, ambiguous: true });
  try {
    const runId = await startRun({ scenarioId: "wizard-order", scenarioVersion: "1.1.0", profileId, input: { baseUrl: site, item }, timeoutMs: 6000 });
    const done = await waitRun(runId, ["NEEDS_REVIEW", "FAILED", "SUCCEEDED"]);
    await sleep(6000); // a retry, if there were one, would place a second order meanwhile
    await setMode({});
    const orders = await ordersFor(item);
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByTestId(`review-run-${runId}`)).toBeVisible();
    await shot(page, "очередь Review");
    observed(`Задание: ${done.status} (${done.errorCode}: ${done.errorMessage?.slice(0, 120)}); профиль: ${(await profileView(profileId)).status}; заказов с этим товаром: ${orders}.`);
    expect(done.status).toBe("NEEDS_REVIEW");
    expect((await profileView(profileId)).status).toBe("NEEDS_REVIEW");
    expect(orders).toBe(1);
  } finally {
    await setMode({});
  }
});

test("9. Отмена во время шага, изменяющего данные", async ({ page }) => {
  test.setTimeout(120_000);
  fault("Оператор нажимает Cancel, пока выполняется шаг оформления заказа.", "Шаг доводится до конца и проверяется, затем задание CANCELLED; заказ ровно один, оставшиеся шаги не выполняются.");
  const profileId = await newProfile(mac, "cancel-p");
  const item = `coffee-${randomUUID().slice(0, 6)}`;
  await setMode({ orderHoldMs: 4000 });
  try {
    const runId = await startRun({ scenarioId: "wizard-order", scenarioVersion: "1.1.0", profileId, input: { baseUrl: site, item } });
    await expect.poll(() => ordersFor(item), { timeout: 30_000 }).toBe(1); // the site took the order; the browser still waits
    const detail = await openRun(page, runId);
    await shot(page, "до: шаг оформления выполняется");
    page.once("dialog", (d) => d.accept());
    await detail.getByRole("button", { name: "Cancel" }).click();
    const done = await waitRun(runId, ["CANCELLED", "SUCCEEDED", "FAILED", "NEEDS_REVIEW"]);
    const steps = (await (await api.get(`/api/v1/runs/${runId}/steps`)).json()) as { stepId: string; status: string }[];
    await expect(detail.getByTestId("run-status")).toHaveText(done.status, { timeout: 5000 });
    await shot(page, "после: CANCELLED");
    observed(`Задание: ${done.status} (${transitions(done)}); шаги: ${steps.map((s) => `${s.stepId}:${s.status}`).join(", ")}; заказов: ${await ordersFor(item)}.`);
    expect(done.status).toBe("CANCELLED");
    expect(steps.map((s) => s.stepId)).not.toContain("check-orders");
    expect(await ordersFor(item)).toBe(1);
  } finally {
    await setMode({});
  }
});
