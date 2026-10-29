import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  test("[REQ-LSC-002] each run takes the next table row, placed under input.csv's own column names; its result comes back to the row", async () => {
    // mac-b already has an input.csv: another column order and an extra column.
    writeFileSync(join(dirs["mac-b"]!, "input.csv"), "who,note,company\n");
    expect((await api("POST", "/api/v1/pipeline/import?name=people.csv", Buffer.from(TABLE), "text/csv")).statusCode).toBe(201);
    expect((await overview()).unsent).toBe(5);

    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`)).statusCode).toBe(202);
    expect(readFileSync(join(dirs["mac-a"]!, "input.csv"), "utf8")).toBe("who,company\nann,Acme\n");
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/runs`)).statusCode).toBe(202);
    expect(readFileSync(join(dirs["mac-b"]!, "input.csv"), "utf8")).toBe("who,note,company\nbob,,Beta\n");
    expect((await overview()).unsent).toBe(3);

    await until("both done", overview, (o) => o.macs.every((m) => !m.state.run.running && m.state.outputRows === 1));
    const rows = await until("results came back", table, (t) => !!t[0]!.lsc?.result && !!t[1]!.lsc?.result);
    expect(rows[0]!.lsc).toEqual({ agentName: "mac-a", result: { header: ["who", "result"], cells: ["ann", "registered"] } });
    expect(rows[1]!.lsc!.agentName).toBe("mac-b");
    expect(rows[2]!.lsc).toBeNull();
    expect((await mac("mac-a")).processed).toBe(1);
  });

  test("[REQ-LSC-003] one run at a time per Mac, its log and stage; «run on all»; a Mac finishes its own unprocessed row before taking another", async () => {
    const a = ids["mac-a"]!;
    process.env.FAKE_LS_MS = "1500";
    expect((await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`)).statusCode).toBe(202);
    const again = await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("LS_CLICKER_RUNNING");
    expect((await overview()).unsent).toBe(2); // the refused run took nothing
    // The heartbeat may still show the previous run: the log tells this run's end.
    await until("finished", async () => (await api("GET", `/api/v1/agents/${a}/ls-clicker/log`)).json().lines, (l) => l.includes("строка 2: готово"));
    process.env.FAKE_LS_MS = "300";
    expect((await api("GET", `/api/v1/agents/${a}/ls-clicker/log`)).json().lines).toEqual(["строка 2: начинаю", "строка 2: готово"]);
    await until("idle", () => mac("mac-a"), (m) => !m.state.run.running);
    expect((await mac("mac-a")).state.stage).toMatchObject({ node: "businessDetails" });

    // dora → mac-a, fail → mac-b (which then fails).
    expect((await api("POST", "/api/v1/ls-clicker/runs")).json().started.sort()).toEqual(["mac-a", "mac-b"]);
    await until("both done", overview, (o) => o.macs.every((m) => !m.state.run.running) && o.unsent === 0);
    const b = await until("mac-b failed", () => mac("mac-b"), (m) => m.state.run.ok === false);
    expect(b.state).toMatchObject({ inputRows: 2, outputRows: 1 });
    // mac-b runs its own unprocessed row again; mac-a has nothing left to take.
    const all = (await api("POST", "/api/v1/ls-clicker/runs")).json();
    expect(all.started).toEqual(["mac-b"]);
    expect(all.skipped).toEqual([{ name: "mac-a", reason: "в таблице не осталось строк" }]);
    await until("mac-b done", () => mac("mac-b"), (m) => !m.state.run.running);
    expect((await mac("mac-b")).state.inputRows).toBe(2);
    expect((await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`)).json().error.code).toBe("NO_ROWS");
  });

  test("[REQ-LSC-003] a run can be stopped; the plan of the next row is shown to the operator", async () => {
    process.env.FAKE_LS_MS = "20000";
    await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/runs`);
    await until("running", () => mac("mac-b"), (m) => m.state.run.running);
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/stop`)).statusCode).toBe(202);
    await until("stopped", () => mac("mac-b"), (m) => !m.state.run.running && m.state.run.ok === false);
    process.env.FAKE_LS_MS = "300";
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/stop`)).json().error.code).toBe("LS_CLICKER_IDLE");
    expect((await api("GET", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/plan`)).json()).toEqual({ plan: { businessDetails: { "Legal business name": "next row" } } });
  });

  test("[REQ-LSC-002] the export carries LS Clicker's results; a table sharing no column with input.csv is refused without naming any value", async () => {
    const csv = parseCsv((await api("GET", "/api/v1/pipeline/export")).body);
    expect(csv.columns.slice(-4)).toEqual(["LS Clicker: Mac", "who", "result", "Прокси"]);
    expect(csv.rows[0]!.slice(-4)).toEqual(["mac-a", "ann", "registered", ""]);
    expect(csv.rows[4]!.slice(-4)).toEqual(["mac-b", "", "", ""]);

    await api("POST", "/api/v1/pipeline/import?name=other.csv", Buffer.from("name,city\nzed,Oslo\n"), "text/csv");
    const refused = await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "LS_CLICKER_HEADER_MISMATCH", message: "no column of the table matches input.csv on this Mac" });
    expect(readFileSync(join(dirs["mac-a"]!, "input.csv"), "utf8")).not.toContain("zed");
    expect((await overview()).unsent).toBe(1);
  });

  test("[REQ-LSC-001] a new build waits for a running row to finish; only operators reach LS Clicker; nothing of the rows is journalled", async () => {
    await api("POST", "/api/v1/pipeline/import?name=again.csv", Buffer.from("who,company\nella,Zeta\n"), "text/csv");
    process.env.FAKE_LS_MS = "2500";
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/runs`)).statusCode).toBe(202);
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

  test("[REQ-UI-013] a row's proxy goes with it to the engine (--proxy); a row left unprocessed on the Mac gets its proxy as edited; a sent row's cells are locked", async () => {
    await until("mac-a idle", () => mac("mac-a"), (m) => !m.state.run.running);
    await api("POST", "/api/v1/pipeline/import?name=proxies.csv", Buffer.from("who,company\nfail,Omega\nzoe,Sigma\n"), "text/csv");
    const patch = (n: number, payload: object) => app.inject({ method: "PATCH", url: `/api/v1/pipeline/rows/${n}`, payload, cookies: { bap_session: cookie } });
    expect((await patch(1, { proxy: "10.1.1.1:1080@u:p" })).statusCode).toBe(204);
    const log = () => readFileSync(join(dirs["mac-a"]!, "proxies.log"), "utf8").trim().split("\n").at(-1);

    // «fail» goes to mac-a with its proxy and stays unprocessed there.
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`)).statusCode).toBe(202);
    await until("ran with its proxy", () => existsSync(join(dirs["mac-a"]!, "proxies.log")) && log(), (l) => !!l && l.endsWith(" 10.1.1.1:1080@u:p"));
    await until("failed", () => mac("mac-a"), (m) => !m.state.run.running && m.state.run.ok === false);
    expect((await patch(1, { cells: ["fail", "edited"] })).json().error.code).toBe("ROW_SENT");

    // The operator changes the proxy; the Mac runs its own unprocessed row again, with the new one.
    expect((await patch(1, { proxy: "10.2.2.2:1080" })).statusCode).toBe(204);
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`)).statusCode).toBe(202);
    await until("ran with the edited proxy", log, (l) => !!l && l.endsWith(" 10.2.2.2:1080"));
    await until("idle", () => mac("mac-a"), (m) => !m.state.run.running);
    // The engine's log names the proxy only as «with its proxy».
    expect((await api("GET", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/log`)).json().lines.join("\n")).not.toContain("10.2.2.2");
  });
});
