import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseCsv } from "@bap/csv";
import { type Db, createDb, migrateToLatest } from "@bap/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningAgent, startAgent } from "../../apps/mac-agent/src/agent.ts";
import { type App, buildApp } from "../../apps/control-plane/src/app.ts";
import { ensureOperator } from "../../apps/control-plane/src/auth.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

// Made-up rows only; the engine is a stand-in script that registers nothing anywhere.
const FAKE = readFileSync(resolve(import.meta.dirname, "../fixtures/ls-clicker/fake-ls-clicker.mjs"));
const FAKE_SHA = createHash("sha256").update(FAKE).digest("hex");
const TABLE = "who,company\nann,Acme\nbob,Beta\ncarl,Gamma\ndora,Delta\nfail,Epsilon\n";
const FLEET = { heartbeatIntervalMs: 200, suspectAfterMs: 1000, offlineAfterMs: 2000, enrollmentTtlMs: 60_000 };

let postgres: StartedPostgreSqlContainer;
let db: Db;
let app: App;
let baseUrl: string;
let cookie: string;
const agents: RunningAgent[] = [];
const dirs: Record<string, string> = {};
const ids: Record<string, string> = {};

const api = (method: "GET" | "POST", url: string, payload?: object | Buffer, contentType?: string) =>
  app.inject({ method, url, payload, cookies: { bap_session: cookie }, ...(contentType && { headers: { "content-type": contentType } }) });
async function until<T>(what: string, read: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(value)?.slice(0, 400)}`);
    await sleep(100);
  }
}
const overview = async () => (await api("GET", "/api/v1/ls-clicker")).json() as { build: { sha256: string } | null; unsent: number; macs: { agentId: string; name: string; sent: number; processed: number; state: { sha256: string | null; version: string | null; inputRows: number; outputRows: number; run: { running: boolean; ok: boolean | null }; stage: { node: string } | null } }[] };
const mac = async (name: string) => (await overview()).macs.find((m) => m.name === name)!;
const table = async () => (await api("GET", "/api/v1/pipeline")).json().rows as { cells: string[]; lsc: { agentName: string; result: { header: string[]; cells: string[] } | null } | null }[];

beforeAll(async () => {
  process.env.FAKE_LS_MS = "300";
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = createDb(postgres.getConnectionUri());
  await migrateToLatest(db);
  await ensureOperator(db, "operator", "pw");
  app = buildApp({ db, store: memoryStore(), secureCookies: false, fleet: FLEET });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cookie = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { login: "operator", password: "pw" } })).cookies[0]!.value;
  for (const name of ["mac-a", "mac-b"]) {
    const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
    const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name, platform: "darwin", architecture: "arm64" } })).json();
    ids[name] = agentId;
    dirs[name] = join(mkdtempSync(join(tmpdir(), "bap-lsc-")), "ls-clicker");
    agents.push(startAgent({ serverUrl: baseUrl, agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: mkdtempSync(join(tmpdir(), "bap-lsc-agent-")), log: () => {}, model: null, lsClickerDir: dirs[name] }));
  }
  await until("both Macs report LS Clicker", overview, (o) => o.macs.length === 2);
});

afterAll(async () => {
  for (const a of agents) a.stop();
  await app?.close();
  await db?.destroy();
  await postgres?.stop();
});

describe("LS Clicker in BAP, without a panel of its own", () => {
  test("[REQ-LSC-001] an uploaded build rolls out to every Mac by itself, checked by sha256", async () => {
    expect((await overview()).build).toBeNull();
    expect((await mac("mac-a")).state).toMatchObject({ sha256: null, version: null, inputRows: 0, outputRows: 0 });
    const uploaded = await api("POST", "/api/v1/ls-clicker/builds", FAKE, "application/octet-stream");
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ sha256: FAKE_SHA, sizeBytes: FAKE.length, uploadedBy: "operator" });
    const rolled = await until("rolled out", overview, (o) => o.macs.every((m) => m.state.sha256 === FAKE_SHA && m.state.version === "fake-ls-clicker 1.0"));
    expect(rolled.build!.sha256).toBe(FAKE_SHA);
    expect(existsSync(join(dirs["mac-a"]!, "ls-clicker"))).toBe(true);
  });

  test("[REQ-LSC-002] rows of the table go to the Macs evenly, appended to input.csv in the engine's format", async () => {
    expect((await api("POST", "/api/v1/pipeline/import?name=people.csv", Buffer.from(TABLE), "text/csv")).statusCode).toBe(201);
    expect((await overview()).unsent).toBe(5);
    const res = await api("POST", "/api/v1/ls-clicker/distribute", {});
    expect(res.json()).toEqual({ sent: [{ name: "mac-a", rows: 3 }, { name: "mac-b", rows: 2 }], failed: [] });
    expect(readFileSync(join(dirs["mac-a"]!, "input.csv"), "utf8")).toBe("who,company\nann,Acme\ncarl,Gamma\nfail,Epsilon\n");
    expect(readFileSync(join(dirs["mac-b"]!, "input.csv"), "utf8")).toBe("who,company\nbob,Beta\ndora,Delta\n");
    expect((await overview()).unsent).toBe(0);
    expect((await api("POST", "/api/v1/ls-clicker/distribute", {})).json()).toEqual({ sent: [], failed: [] });
    await until("Macs count their rows", overview, (o) => o.macs.every((m) => m.state.inputRows === m.sent));
    expect((await table()).map((r) => r.lsc?.agentName)).toEqual(["mac-a", "mac-b", "mac-a", "mac-b", "mac-a"]);
  });

  test("[REQ-LSC-003] a run takes the next row; its log, stage and result reach the panel; one run at a time per Mac", async () => {
    const a = ids["mac-a"]!;
    expect((await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`)).statusCode).toBe(202);
    const again = await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("LS_CLICKER_RUNNING");
    await until("finished", () => mac("mac-a"), (m) => !m.state.run.running && m.state.run.ok === true);
    expect((await api("GET", `/api/v1/agents/${a}/ls-clicker/log`)).json().lines).toEqual(["строка 1: начинаю", "строка 1: готово"]);
    expect((await mac("mac-a")).state.stage).toMatchObject({ node: "businessDetails" });
    const rows = await until("result came back", table, (t) => t[0]!.lsc?.result !== null);
    expect(rows[0]!.lsc).toEqual({ agentName: "mac-a", result: { header: ["who", "result"], cells: ["ann", "registered"] } });
    expect(rows[2]!.lsc!.result).toBeNull();
    expect((await mac("mac-a")).processed).toBe(1);
  });

  test("[REQ-LSC-003] «run on all» starts every free Mac with unprocessed rows; a failing row ends not ok", async () => {
    const res = (await api("POST", "/api/v1/ls-clicker/runs")).json();
    expect(res.started.sort()).toEqual(["mac-a", "mac-b"]);
    // mac-a: its second row; mac-b: its first.
    await until("both done", overview, (o) => o.macs.every((m) => !m.state.run.running && m.state.outputRows === (m.name === "mac-a" ? 2 : 1)));
    await until("results", table, (t) => t.filter((r) => r.lsc?.result).length === 3);
    // mac-a has one row left: «fail».
    await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`);
    const failed = await until("failed row", () => mac("mac-a"), (m) => !m.state.run.running && m.state.run.ok === false);
    expect(failed.state.outputRows).toBe(2);
    // The failed row stays unprocessed on mac-a; mac-b still has its second row.
    await until("mac-b free", () => mac("mac-b"), (m) => !m.state.run.running);
    expect((await api("POST", "/api/v1/ls-clicker/runs")).json().started.sort()).toEqual(["mac-a", "mac-b"]);
    await until("both done again", overview, (o) => o.macs.every((m) => !m.state.run.running && m.state.outputRows === 2));
  });

  test("[REQ-LSC-003] a run can be stopped; the plan of the next row is shown to the operator", async () => {
    await until("idle", () => mac("mac-a"), (m) => !m.state.run.running);
    process.env.FAKE_LS_MS = "20000";
    await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`);
    await until("running", () => mac("mac-a"), (m) => m.state.run.running);
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/stop`)).statusCode).toBe(202);
    await until("stopped", () => mac("mac-a"), (m) => !m.state.run.running && m.state.run.ok === false);
    process.env.FAKE_LS_MS = "300";
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/stop`)).json().error.code).toBe("LS_CLICKER_IDLE");
    expect((await api("GET", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/plan`)).json()).toEqual({ plan: { businessDetails: { "Legal business name": "next row" } } });
  });

  test("[REQ-LSC-002] the export carries LS Clicker's results; another table's columns are refused without naming any value", async () => {
    const csv = parseCsv((await api("GET", "/api/v1/pipeline/export")).body);
    expect(csv.columns.slice(-3)).toEqual(["LS Clicker: Mac", "who", "result"]);
    expect(csv.rows[0]!.slice(-3)).toEqual(["mac-a", "ann", "registered"]);
    expect(csv.rows[4]!.slice(-3)).toEqual(["mac-a", "", ""]);

    await api("POST", "/api/v1/pipeline/import?name=other.csv", Buffer.from("name,city\nzed,Oslo\n"), "text/csv");
    const res = (await api("POST", "/api/v1/ls-clicker/distribute", { agentIds: [ids["mac-b"]] })).json();
    expect(res.sent).toEqual([]);
    expect(res.failed).toEqual([{ name: "mac-b", code: "LS_CLICKER_HEADER_MISMATCH", message: "the table's columns differ from input.csv on this Mac" }]);
    expect(readFileSync(join(dirs["mac-b"]!, "input.csv"), "utf8")).not.toContain("zed");
  });

  test("[REQ-LSC-001] a new build waits for a running row to finish; only operators reach LS Clicker; nothing of the rows is journalled", async () => {
    await api("POST", "/api/v1/pipeline/import?name=again.csv", Buffer.from("who,company\nella,Zeta\n"), "text/csv");
    await api("POST", "/api/v1/ls-clicker/distribute", { agentIds: [ids["mac-b"]] });
    process.env.FAKE_LS_MS = "2500";
    await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/runs`);
    await until("running", () => mac("mac-b"), (m) => m.state.run.running);
    const v2 = Buffer.concat([FAKE, Buffer.from("\n// v2\n")]);
    const sha2 = createHash("sha256").update(v2).digest("hex");
    await api("POST", "/api/v1/ls-clicker/builds", v2, "application/octet-stream");
    await sleep(800);
    expect((await mac("mac-b")).state.sha256).toBe(FAKE_SHA);
    await until("installed after the run", () => mac("mac-b"), (m) => m.state.sha256 === sha2, 20_000);
    process.env.FAKE_LS_MS = "300";

    expect((await app.inject({ method: "GET", url: "/api/v1/ls-clicker" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/ls-clicker/runs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/v1/agents/me/ls-clicker/build?sha256=${FAKE_SHA}` })).statusCode).toBe(401);
    const journal = JSON.stringify(await db.selectFrom("audit_events").selectAll().execute());
    for (const value of ["ann", "Acme", "registered", "ella"]) expect(journal).not.toContain(value);
  });
});
