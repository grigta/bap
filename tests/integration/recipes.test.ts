import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type LaunchedChromium, LocalChromiumProvider, closeChromium, launchChromium } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import type { Recipe } from "@bap/recipe";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { BudgetExceededError, gatedModel } from "../../apps/control-plane/src/llm/gate.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";
import { type FakeModel, fakeShopModel } from "../support/fake-model.ts";
import { SHOP_INPUT, shapeshiftRecipe } from "../support/shapeshift-recipe.ts";
import { startTestSite } from "../support/test-site.ts";
import { withoutWarmup } from "../support/no-warmup.ts";

const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };
const DAILY_CALLS = 400;
const work = mkdtempSync(join(tmpdir(), "bap-recipes-"));
const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let model: FakeModel;
let cookie: string;
let agent: RunningAgent | null = null;
let profileId: string;
let site: Awaited<ReturnType<typeof startTestSite>>;
let launched: LaunchedChromium;
let browser: Browser;
let manual: Recipe;

const api = (method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers, cookies: { bap_session: cookie } });
const run = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
const steps = async (id: string) => (await api("GET", `/api/v1/runs/${id}/steps`)).json() as Promise<{ stepId: string; status: string; resolution: string | null; note: string | null; intent: string | null; mutating: boolean }[]>;
const shopInput = () => ({ baseUrl: site.url, ...SHOP_INPUT });
const layout = (l: { seed: number; wording: number; failOrder?: boolean }) => fetch(`${site.url}/api/layout`, { method: "POST", body: JSON.stringify({ failOrder: false, ...l }) });
const orders = async () => (await (await fetch(`${site.url}/api/orders`)).json()) as { items: string[]; name: string; address: string; delivery: string }[];
const llmCalls = async (runId?: string) => Number((await (runId ? db.selectFrom("llm_calls").where("run_id", "=", runId) : db.selectFrom("llm_calls")).select(db.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last value ${JSON.stringify(value)}`);
    await sleep(150);
  }
}
const finished = (id: string) => until(`run ${id} to finish`, () => run(id), (r) => ["SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"].includes(r.status), 120_000);
const startRun = async (scenarioId: string, scenarioVersion: string) => {
  const res = await api("POST", "/api/v1/runs", { scenarioId, scenarioVersion, profileId, input: shopInput(), timeoutMs: 240_000 }, { "idempotency-key": randomUUID() });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().runId as string;
};

beforeAll(async () => {
  site = await startTestSite("shapeshift-site");
  launched = await launchChromium(mkdtempSync(join(tmpdir(), "bap-recipe-author-")), true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${launched.port}`);
  manual = await shapeshiftRecipe(await browser.contexts()[0]!.newPage(), site.url);

  provider.createProfile("p1");
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  await withoutWarmup(db);
  model = fakeShopModel();
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET, model, llmLimits: { recordCallsPerRun: 40, healCallsPerRun: 20, callsPerDay: DAILY_CALLS } });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name: "mac-recipes", platform: "darwin", architecture: "arm64" } })).json();
  agent = startAgent({ serverUrl: baseUrl, agentKey, provider, providerName: "local-chromium", maxSessions: 1, dataDir: join(work, "agent"), log: (l) => process.env.BAP_TEST_AGENT_LOG && console.log(`[recipes-agent] ${l}`) });
  await until("agent capabilities", async () => (await api("GET", `/api/v1/agents/${agentId}`)).json(), (a) => a.maxSessions === 1);
  profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: "p1", name: "P1" })).json().id;
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await browser?.close();
  if (launched) await closeChromium(launched);
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  await site?.stop();
});

describe("recipes", { timeout: 240_000 }, () => {
  test("[REQ-DOM-005][REQ-DOM-011][REQ-DOM-006] a hand-written recipe runs only once published, then on another layout without a single model call", async () => {
    const bad = structuredClone(manual);
    delete bad.steps.at(-1)!.postcondition;
    expect((await api("POST", "/api/v1/recipes/shop-manual/versions", bad)).statusCode).toBe(400);

    const created = await api("POST", "/api/v1/recipes/shop-manual/versions", manual);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().version).toBe("1.0.0");
    const draft = await api("POST", "/api/v1/runs", { scenarioId: "shop-manual", scenarioVersion: "1.0.0", profileId, input: shopInput() }, { "idempotency-key": randomUUID() });
    expect(draft.json().error.code).toBe("RECIPE_NOT_PUBLISHED");
    expect((await api("GET", "/api/v1/scenarios")).json().map((s: { id: string }) => s.id)).not.toContain("shop-manual");
    expect((await api("POST", "/api/v1/recipes/shop-manual/versions/1.0.0/publish")).json().publishedAt).not.toBeNull();
    expect((await api("GET", "/api/v1/recipes/schema")).json()).toMatchObject({ type: "object", required: expect.arrayContaining(["steps"]) });

    await layout({ seed: 7, wording: 0 });
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const runId = await startRun("shop-manual", "1.0.0");
    const done = await finished(runId);
    expect(done.status, `${done.errorCode}: ${done.errorMessage}`).toBe("SUCCEEDED");
    const journal = await steps(runId);
    expect(journal.map((s) => s.stepId)).toEqual(manual.steps.map((s) => s.id));
    expect(journal.filter((s) => s.stepId !== "s01").every((s) => s.resolution === "found" && s.note?.startsWith("найден по отпечатку"))).toBe(true);
    expect(journal.find((s) => s.stepId === "s11")).toMatchObject({ intent: "Оформить заказ", mutating: true, status: "passed" });
    expect(await orders()).toEqual([expect.objectContaining({ items: ["p1"], name: SHOP_INPUT.name, address: SHOP_INPUT.address, delivery: "Курьер" })]);
    expect(model.calls).toHaveLength(0);
    expect(await llmCalls()).toBe(0);
  });

  test("[REQ-DOM-004][REQ-DOM-008][REQ-DOM-012] a task is recorded with two operator confirmations and replays on another layout without the model", async () => {
    await layout({ seed: 3, wording: 0 });
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const started = await api("POST", "/api/v1/recipes", {
      id: "shop-recorded",
      goal: "Купить товар {{input.item}} с доставкой курьером",
      startUrl: `${site.url}/`,
      inputs: ["baseUrl", ...Object.keys(SHOP_INPUT)].map((name) => ({ name, secret: false })),
      profileId,
      input: shopInput(),
    });
    expect(started.statusCode, started.body).toBe(202);
    const { runId } = started.json();

    for (const intent of ["Положить товар в корзину", "Оформить заказ"]) {
      const pending = await until(`confirmation of ${intent}`, async () => (await api("GET", `/api/v1/runs/${runId}/confirmation`)).json().pending, (p) => p !== null);
      expect(pending).toMatchObject({ intent, screenshotArtifactId: expect.any(String) });
      // Nothing changed on the site while the action waits for the operator.
      expect(await orders()).toHaveLength(0);
      expect((await api("POST", `/api/v1/runs/${runId}/confirmation`, { decision: "confirm" })).statusCode).toBe(204);
    }
    const done = await finished(runId);
    expect(done.status, `${done.errorCode}: ${done.errorMessage}`).toBe("SUCCEEDED");
    expect(done).toMatchObject({ kind: "record", scenarioVersion: "1.0.0" });
    expect(await orders()).toHaveLength(1);
    const journal = await steps(runId);
    expect(journal.filter((s) => s.resolution === "confirmed").map((s) => s.intent)).toEqual(["Положить товар в корзину", "Оформить заказ"]);
    expect(journal.filter((s) => s.resolution === "recorded").length).toBeGreaterThanOrEqual(8);
    const recordCalls = await llmCalls(runId);
    expect(recordCalls).toBeGreaterThan(5);

    const recipe = (await api("GET", "/api/v1/recipes/shop-recorded")).json();
    expect(recipe.versions).toEqual([expect.objectContaining({ version: "1.0.0", origin: "recorded", publishedAt: null, sourceRunId: runId })]);
    const body = (await api("GET", "/api/v1/recipes/shop-recorded/versions/1.0.0")).json().recipe as Recipe;
    expect(body.steps.filter((s) => s.mutating).every((s) => s.postcondition)).toBe(true);
    expect(body.steps.find((s) => s.action === "fill" && s.intent.includes("Имя"))?.value).toBe("{{input.name}}");
    const shot = body.steps.find((s) => s.screenshot)!.screenshot!;
    expect((await api("GET", `/api/v1/recipes/shop-recorded/screenshots/${shot}`)).headers["content-type"]).toBe("image/png");
    expect(JSON.stringify(body)).not.toContain(SHOP_INPUT.address);
    // The site's answers to the two mutating actions were recorded as their proof (REQ-DOM-014).
    expect(body.steps.find((s) => s.intent === "Положить товар в корзину")?.postcondition).toEqual({ url: "/cart", text: "{{input.item}}", request: { method: "POST", path: "/cart/add", status: "3xx" } });
    expect(body.steps.find((s) => s.intent === "Оформить заказ")?.postcondition?.request).toEqual({ method: "POST", path: "/order", status: "3xx" });

    await api("POST", "/api/v1/recipes/shop-recorded/versions/1.0.0/publish");
    await layout({ seed: 11, wording: 0 });
    const replay = await startRun("shop-recorded", "1.0.0");
    expect((await finished(replay)).status).toBe("SUCCEEDED");
    expect(await llmCalls(replay)).toBe(0);
    expect(await orders()).toHaveLength(2);
  });

  test("[REQ-DOM-008] an operator who refuses a mutating action stops the recording before it happens", async () => {
    await layout({ seed: 4, wording: 0 });
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const { runId } = (await api("POST", "/api/v1/recipes", { id: "shop-refused", goal: "Купить {{input.item}}", startUrl: `${site.url}/`, inputs: [{ name: "query", secret: false }, { name: "item", secret: false }], profileId, input: { query: "Ноутбук", item: SHOP_INPUT.item } })).json();
    await until("confirmation", async () => (await api("GET", `/api/v1/runs/${runId}/confirmation`)).json().pending, (p) => p !== null);
    await api("POST", `/api/v1/runs/${runId}/confirmation`, { decision: "reject" });
    expect(await finished(runId)).toMatchObject({ status: "FAILED", errorCode: "OPERATOR_REJECTED" });
    expect((await api("POST", `/api/v1/runs/${runId}/confirmation`, { decision: "confirm" })).json().error.code).toBe("NOTHING_TO_CONFIRM");
    expect((await fetch(`${site.url}/cart`)).ok).toBe(true);
    expect(await orders()).toHaveLength(0);
  });

  test("[REQ-DOM-007][REQ-DOM-012] after a redesign the run heals its steps, publishes version 2 and the next run needs no model", async () => {
    await layout({ seed: 5, wording: 1 });
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const runId = await startRun("shop-manual", "1.0.0");
    const done = await finished(runId);
    expect(done.status, `${done.errorCode}: ${done.errorMessage}`).toBe("SUCCEEDED");
    const journal = await steps(runId);
    const healed = journal.filter((s) => s.resolution === "healed");
    expect(healed.length).toBeGreaterThanOrEqual(5);
    expect(healed.find((s) => s.stepId === "s11")?.note).toBe("Элемент теперь называется «Подтвердить покупку»; подтверждён ответом сайта: POST /order 303");
    expect(await llmCalls(runId)).toBe(healed.length);
    expect(await orders()).toHaveLength(1);

    const versions = (await api("GET", "/api/v1/recipes/shop-manual")).json().versions;
    expect(versions.at(-1)).toMatchObject({ version: "2.0.0", origin: "healed", parentVersion: "1.0.0", sourceRunId: runId, publishedAt: expect.any(String) });

    // The next run is created for 1.0.0 but gets the newest published version.
    const again = await startRun("shop-manual", "1.0.0");
    expect((await finished(again)).status).toBe("SUCCEEDED");
    expect((await run(again)).scenarioVersion).toBe("2.0.0");
    expect((await steps(again)).every((s) => s.resolution !== "healed")).toBe(true);
    expect(await llmCalls(again)).toBe(0);
  });

  test("[REQ-DOM-010] over the daily model budget healing stops the run with LLM_BUDGET_EXCEEDED", async () => {
    const filler = Array.from({ length: DAILY_CALLS }, () => ({ purpose: "heal" as const, run_id: randomUUID(), model: "x", ok: true, duration_ms: 1, cost_usd: null, input_tokens: null, output_tokens: null, error: null }));
    await db.insertInto("llm_calls").values(filler).execute();
    try {
      await layout({ seed: 6, wording: 0 }); // the healed version 2 now meets the old wording
      const runId = await startRun("shop-manual", "2.0.0");
      expect(await finished(runId)).toMatchObject({ status: "FAILED", errorCode: "LLM_BUDGET_EXCEEDED" });
    } finally {
      await db.deleteFrom("llm_calls").where("model", "=", "x").execute();
    }
    const gate = gatedModel(db, model, { recordCallsPerRun: 1, healCallsPerRun: 1, callsPerDay: 1000 }, () => {});
    const runId = randomUUID();
    await gate.ask({ purpose: "heal", runId, system: "", prompt: "", schema: {} });
    await expect(gate.ask({ purpose: "heal", runId, system: "", prompt: "", schema: {} })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("[REQ-DOM-015][REQ-DOM-014] other word forms are found without the model; the order is proven by the site's answer when its wording changed", async () => {
    await api("POST", "/api/v1/recipes/shop-forms/versions", manual);
    await api("POST", "/api/v1/recipes/shop-forms/versions/1.0.0/publish");
    await layout({ seed: 12, wording: 2 }); // «Оформление заказа», «В корзинку», «Заказ принят» instead of «оформлен»
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const runId = await startRun("shop-forms", "1.0.0");
    const done = await finished(runId);
    expect(done.status, `${done.errorCode}: ${done.errorMessage}`).toBe("SUCCEEDED");
    const journal = await steps(runId);
    expect(journal.filter((s) => s.stepId !== "s01").every((s) => s.resolution === "found")).toBe(true);
    expect(journal.find((s) => s.stepId === "s11")?.note).toMatch(/подтверждён ответом сайта: POST \/order 303$/);
    expect(journal.find((s) => s.stepId === "s04")?.note).toMatch(/подтверждён ответом сайта: POST \/cart\/add 303$/);
    expect(await llmCalls(runId)).toBe(0);
    expect(await orders()).toHaveLength(1);
  });

  test("[REQ-DOM-014] a site that answers the order with an error leaves the run for review, and the order is not repeated", async () => {
    await layout({ seed: 12, wording: 0, failOrder: true });
    await fetch(`${site.url}/api/orders`, { method: "DELETE" });
    const runId = await startRun("shop-forms", "1.0.0");
    const done = await finished(runId);
    expect(done).toMatchObject({ status: "NEEDS_REVIEW", errorCode: "UNVERIFIED" });
    const s11 = (await steps(runId)).find((s) => s.stepId === "s11")!;
    expect(s11).toMatchObject({ status: "unverified" });
    expect(s11.note).toMatch(/сайт ответил ошибкой: POST \/order 500$/);
    expect(await orders()).toHaveLength(0);
    await layout({ seed: 12, wording: 0 });
    // The profile waits for review after an unconfirmed change; release it for the next tests.
    await api("POST", `/api/v1/profiles/${profileId}/release-review`);
  });
});
