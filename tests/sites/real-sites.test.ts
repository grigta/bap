// S11.5: recipes on real public demo sites with the real model (Claude Code headless on this machine).
// Local only, never in CI: `pnpm test:sites` with CLAUDE_CODE_OAUTH_TOKEN set. Writes the report for the team
// to docs/evidence/S11/real-sites.md — the panel never shows model calls or costs (ADR-0025).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { claudeCliModel } from "../../apps/control-plane/src/llm/claude-cli.ts";
import type { Model } from "../../apps/control-plane/src/llm/model.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

interface Task {
  id: string;
  goal: string;
  startUrl: string;
  inputs: { name: string; secret: boolean; value: string }[];
}

const TASKS: Task[] = [
  {
    id: "saucedemo-checkout",
    goal: "Войти под логином {{input.user}} и паролем {{input.password}}, положить в корзину товар «{{input.item}}» и оформить заказ на имя {{input.first}} {{input.last}} с почтовым индексом {{input.zip}}. Задача выполнена, когда магазин благодарит за заказ.",
    startUrl: "https://www.saucedemo.com/",
    inputs: [
      { name: "user", secret: false, value: "standard_user" },
      { name: "password", secret: true, value: "secret_sauce" },
      { name: "item", secret: false, value: "Sauce Labs Backpack" },
      { name: "first", secret: false, value: "Anna" },
      { name: "last", secret: false, value: "Petrova" },
      { name: "zip", secret: false, value: "101000" },
    ],
  },
  {
    id: "the-internet-login",
    goal: "Через раздел Form Authentication войти в защищённую зону с логином {{input.user}} и паролем {{input.password}}. Задача выполнена, когда видно сообщение об успешном входе.",
    startUrl: "https://the-internet.herokuapp.com/",
    inputs: [
      { name: "user", secret: false, value: "tomsmith" },
      { name: "password", secret: true, value: "SuperSecretPassword!" },
    ],
  },
  {
    id: "the-internet-dropdown",
    goal: "Открыть раздел Dropdown и выбрать в выпадающем списке вариант «{{input.option}}». Задача выполнена, когда он выбран.",
    startUrl: "https://the-internet.herokuapp.com/",
    inputs: [{ name: "option", secret: false, value: "Option 2" }],
  },
  {
    id: "books-find",
    goal: "В категории {{input.category}} найти книгу «{{input.title}}» и открыть её страницу. Задача выполнена, когда на странице книги видна её цена.",
    startUrl: "https://books.toscrape.com/",
    inputs: [
      { name: "category", secret: false, value: "Poetry" },
      { name: "title", secret: false, value: "The Black Maria" },
    ],
  },
];
const REPLAYS = 2;
/** BAP_SITES=id,id runs a subset while debugging; the team report is written only for the full set. */
const ONLY = process.env.BAP_SITES?.split(",");
const FLEET = { heartbeatIntervalMs: 500, suspectAfterMs: 3000, offlineAfterMs: 6000, enrollmentTtlMs: 60_000 };

const work = mkdtempSync(join(tmpdir(), "bap-sites-"));
const provider = new LocalChromiumProvider({ profilesDir: join(work, "profiles") });
const prompts: string[] = [];
let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let cookie: string;
let agent: RunningAgent | null = null;
let agentId: string;

interface Outcome {
  task: string;
  recorded: { status: string; error: string | null; steps: number; calls: number; costUsd: number; seconds: number; confirmations: number };
  replays: { status: string; error: string | null; calls: number; seconds: number }[];
}
const outcomes: Outcome[] = [];

const api = (method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers, cookies: { bap_session: cookie } });
const run = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json();
const final = (s: string) => ["SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"].includes(s);
const seconds = (r: { startedAt: string | null; finishedAt: string | null; createdAt: string }) => Math.round((Date.parse(r.finishedAt!) - Date.parse(r.startedAt ?? r.createdAt)) / 100) / 10;
const calls = async (runId: string) => {
  const row = await db.selectFrom("llm_calls").select([db.fn.countAll<string>().as("n"), db.fn.sum<string>("cost_usd").as("cost")]).where("run_id", "=", runId).executeTakeFirstOrThrow();
  return { calls: Number(row.n), costUsd: Math.round(Number(row.cost ?? 0) * 10000) / 10000 };
};

beforeAll(async () => {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for real sites");
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  const claude = claudeCliModel({ cwd: join(work, "llm"), models: { record: process.env.BAP_LLM_RECORD_MODEL ?? "opus", heal: process.env.BAP_LLM_HEAL_MODEL ?? "sonnet" } });
  // Every prompt is kept to check that secrets never reach the model (REQ-DOM-003).
  const model: Model = { ask: (req) => (prompts.push(req.prompt), claude.ask(req)) };
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET, model });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  const { token: invite } = (await api("POST", "/api/v1/agents/enrollments")).json();
  let agentKey: string;
  ({ agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token: invite, name: "sites-mac", platform: "darwin", architecture: "arm64" } })).json());
  agent = startAgent({ serverUrl: baseUrl, agentKey, provider, providerName: "local-chromium", maxSessions: 1, dataDir: join(work, "agent"), log: (l) => process.env.BAP_TEST_AGENT_LOG && console.log(`[sites-agent] ${l}`) });
  for (let i = 0; i < 100 && (await api("GET", `/api/v1/agents/${agentId}`)).json().maxSessions !== 1; i++) await sleep(100);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
  if (outcomes.length === 0 || ONLY) return;
  const dir = resolve(import.meta.dirname, "../../docs/evidence/S11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "real-sites.json"), JSON.stringify({ at: new Date().toISOString(), outcomes }, null, 2) + "\n");
  writeFileSync(join(dir, "real-sites.md"), report(outcomes));
});

function report(list: Outcome[]): string {
  const ok = list.filter((o) => o.recorded.status === "SUCCEEDED");
  const lines = [
    "# S11.5. Рецепты на публичных демо-сайтах",
    "",
    `Прогон ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Модель: Claude Code в безголовом режиме (ADR-0026), запись и лечение на сервере, воспроизведение на Mac без модели. Отчёт для команды; в панели модель и расход не показываются (ADR-0025).`,
    "",
    "| Задача | Запись | Шагов | Подтверждений | Вызовов модели при записи | Стоимость записи, $ | Время записи, с | Повторы | Вызовов модели при повторах | Время повтора, с |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...list.map((o) =>
      `| ${o.task} | ${o.recorded.status} | ${o.recorded.steps} | ${o.recorded.confirmations} | ${o.recorded.calls} | ${o.recorded.costUsd} | ${o.recorded.seconds} | ${o.replays.map((r) => r.status).join(", ") || "—"} | ${o.replays.reduce((n, r) => n + r.calls, 0)} | ${o.replays.map((r) => r.seconds).join(", ") || "—"} |`,
    ),
    "",
    `Итого: записано ${ok.length} из ${list.length}; повторов без изменений вёрстки — ${list.flatMap((o) => o.replays).length}, вызовов модели в них — ${list.flatMap((o) => o.replays).reduce((n, r) => n + r.calls, 0)}.`,
    "",
    ...(() => {
      const errors = list.flatMap((o) => [o.recorded.error, ...o.replays.map((r) => r.error)].filter(Boolean).map((e) => `- ${o.task}: ${String(e).replace(/\s+/g, " ")}`));
      return errors.length ? [...errors, ""] : [];
    })(),
    "Стоимость — оценка Claude Code (`total_cost_usd`); при подписке это не счёт, а условная величина.",
    "",
  ];
  return lines.join("\n");
}

describe("real sites", { timeout: 900_000 }, () => {
  for (const task of TASKS.filter((t) => !ONLY || ONLY.includes(t.id))) {
    test(`[REQ-DOM-013][REQ-DOM-004][REQ-DOM-003] ${task.id}: recorded on the live site, replayed ${REPLAYS} times without the model`, async () => {
      // A profile of its own: a task that ends in review does not block the next one.
      provider.createProfile(task.id);
      const profileId = (await api("POST", "/api/v1/profiles/import", { agentId, externalProfileId: task.id, name: task.id })).json().id;
      const input = Object.fromEntries(task.inputs.map((i) => [i.name, i.value]));
      const started = await api("POST", "/api/v1/recipes", { id: task.id, goal: task.goal, startUrl: task.startUrl, inputs: task.inputs.map(({ name, secret }) => ({ name, secret })), profileId, input, timeoutMs: 1_200_000 });
      expect(started.statusCode, started.body).toBe(202);
      const { runId } = started.json();
      let confirmations = 0;
      let rec = await run(runId);
      // The operator here confirms every mutating action; on a live site that is the person at the panel.
      while (!final(rec.status)) {
        const pending = (await api("GET", `/api/v1/runs/${runId}/confirmation`)).json().pending;
        if (pending) {
          confirmations++;
          await api("POST", `/api/v1/runs/${runId}/confirmation`, { decision: "confirm" });
        }
        await sleep(1000);
        rec = await run(runId);
      }
      const steps = (await api("GET", `/api/v1/runs/${runId}/steps`)).json() as unknown[];
      const outcome: Outcome = {
        task: task.id,
        recorded: { status: rec.status, error: rec.errorCode && `${rec.errorCode}: ${rec.errorMessage}`, steps: steps.length, ...(await calls(runId)), seconds: seconds(rec), confirmations },
        replays: [],
      };
      outcomes.push(outcome);
      expect(rec.status, outcome.recorded.error ?? "").toBe("SUCCEEDED");

      const version = rec.scenarioVersion as string;
      const recipe = (await api("GET", `/api/v1/recipes/${task.id}/versions/${version}`)).json().recipe;
      for (const secret of task.inputs.filter((i) => i.secret)) {
        expect(JSON.stringify(recipe)).not.toContain(secret.value);
        expect(prompts.some((p) => p.includes(secret.value))).toBe(false);
      }
      const evidenceDir = resolve(import.meta.dirname, "../../docs/evidence/S11/recipes");
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, `${task.id}.json`), JSON.stringify(recipe, null, 2) + "\n");
      await api("POST", `/api/v1/recipes/${task.id}/versions/${version}/publish`);
      for (let i = 0; i < REPLAYS; i++) {
        const res = await api("POST", "/api/v1/runs", { scenarioId: task.id, scenarioVersion: version, profileId, input, timeoutMs: 600_000 }, { "idempotency-key": randomUUID() });
        if (res.statusCode !== 202) {
          outcome.replays.push({ status: "NOT_STARTED", error: res.json().error.code, calls: 0, seconds: 0 });
          break;
        }
        const replayId = res.json().runId;
        let r = await run(replayId);
        while (!final(r.status)) {
          await sleep(1000);
          r = await run(replayId);
        }
        outcome.replays.push({ status: r.status, error: r.errorCode && `${r.errorCode}: ${r.errorMessage}`, calls: (await calls(replayId)).calls, seconds: seconds(r) });
        if (r.status !== "SUCCEEDED") {
          // The failed step's own screenshot and the journal show what the page looked like.
          const journal = (await api("GET", `/api/v1/runs/${replayId}/steps`)).json() as { stepId: string; status: string; note: string | null; error: string | null; screenshotArtifactId: string | null }[];
          const failed = journal.find((st) => st.status !== "passed");
          const dir = resolve(import.meta.dirname, "../../docs/evidence/S11/recipes");
          writeFileSync(join(dir, `${task.id}-replay-${i + 1}-journal.json`), JSON.stringify(journal, null, 2) + "\n");
          if (failed?.screenshotArtifactId) writeFileSync(join(dir, `${task.id}-replay-${i + 1}-${failed.stepId}.png`), (await api("GET", `/api/v1/runs/${replayId}/artifacts/${failed.screenshotArtifactId}/content`)).rawPayload);
        }
      }
      expect(outcome.replays.map((r) => r.status)).toEqual(Array(REPLAYS).fill("SUCCEEDED"));
      expect(outcome.replays.every((r) => r.calls === 0)).toBe(true);
    });
  }
});
