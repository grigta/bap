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
const PROXY = "10.9.9.9:1080";
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

const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object | Buffer, contentType?: string) =>
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
const overview = async () => (await api("GET", "/api/v1/ls-clicker")).json() as { build: { sha256: string } | null; unsent: number; macs: { agentId: string; name: string; auto: boolean; sent: number; processed: number; state: { sha256: string | null; version: string | null; inputRows: number; outputRows: number; run: { running: boolean; ok: boolean | null; finishedAt: string | null }; stage: { node: string } | null } }[] };
async function addMac(name: string) {
  const { token } = (await api("POST", "/api/v1/agents/enrollments")).json();
  const { agentId, agentKey } = (await app.inject({ method: "POST", url: "/api/v1/agents/enroll", payload: { token, name, platform: "darwin", architecture: "arm64" } })).json();
  ids[name] = agentId;
  dirs[name] = join(mkdtempSync(join(tmpdir(), "bap-lsc-")), "ls-clicker");
  agents.push(startAgent({ serverUrl: baseUrl, agentKey, provider: null, providerName: "none", maxSessions: 1, dataDir: mkdtempSync(join(tmpdir(), "bap-lsc-agent-")), log: () => {}, model: null, lsClickerDir: dirs[name] }));
}
/** Imports a table whose rows all have a proxy: without one a row waits («wait info») and never runs. */
const importReady = async (name: string, csv: string) => {
  const res = await api("POST", `/api/v1/pipeline/import?name=${name}`, Buffer.from(csv), "text/csv");
  for (const r of (await api("GET", "/api/v1/pipeline")).json().rows as { n: number }[]) await api("PATCH", `/api/v1/pipeline/rows/${r.n}`, { proxy: PROXY });
  return res;
};
const mac = async (name: string) => (await overview()).macs.find((m) => m.name === name)!;
/** The Mac's run that started at or after `since` has ended: a heartbeat sent before the start does not count. */
const endedSince = (name: string, since: number) => until(`${name}: run ended`, () => mac(name), (m) => !m.state.run.running && !!m.state.run.finishedAt && Date.parse(m.state.run.finishedAt) >= since);
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
  for (const name of ["mac-a", "mac-b"]) await addMac(name);
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

  test("[REQ-LSC-002][REQ-LSC-007] each run takes the next table row (none above the starting row, none already good or bad), placed under input.csv's own column names; its result comes back to the row", async () => {
    // mac-b already has an input.csv: another column order and an extra column.
    writeFileSync(join(dirs["mac-b"]!, "input.csv"), "who,note,company\n");
    expect((await importReady("people.csv", TABLE)).statusCode).toBe(201);
    expect((await overview()).unsent).toBe(5);
    // Rows above the starting row are history: they wait for nothing and never run.
    const from = (n: number | null) => app.inject({ method: "PUT", url: "/api/v1/pipeline/lsc-from", payload: { n }, cookies: { bap_session: cookie } });
    expect((await from(4)).statusCode).toBe(204);
    expect((await overview()).unsent).toBe(2);
    expect((await api("GET", "/api/v1/pipeline")).json().import.lscFrom).toBe(4);
    expect((await from(0)).statusCode).toBe(400);
    expect((await from(null)).statusCode).toBe(204);
    expect((await overview()).unsent).toBe(5);
    // A row whose status is good or bad (any case) has been done: it is not run again.
    expect((await importReady("done.csv", "who,Status\nann,good\nbob, BAD \ncarl,\ndora,гуд\neve,new\n")).statusCode).toBe(201);
    expect((await overview()).unsent).toBe(2);
    expect((await importReady("people.csv", TABLE)).statusCode).toBe(201);
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
    const both = Date.now();
    expect((await api("POST", "/api/v1/ls-clicker/runs")).json().started.sort()).toEqual(["mac-a", "mac-b"]);
    await endedSince("mac-a", both);
    const b = await endedSince("mac-b", both);
    expect(b.state.run.ok).toBe(false);
    expect((await overview()).unsent).toBe(0);
    expect(b.state).toMatchObject({ inputRows: 2, outputRows: 1 });
    // mac-b runs its own unprocessed row again; mac-a has nothing left to take.
    const again2 = Date.now();
    const all = (await api("POST", "/api/v1/ls-clicker/runs")).json();
    expect(all.started).toEqual(["mac-b"]);
    expect(all.skipped).toEqual([{ name: "mac-a", reason: "в таблице не осталось строк" }]);
    await endedSince("mac-b", again2);
    expect((await mac("mac-b")).state.inputRows).toBe(2);
    expect((await api("POST", `/api/v1/agents/${a}/ls-clicker/runs`)).json().error.code).toBe("NO_ROWS");
  });

  test("[REQ-LSC-009] every failed run goes to «Недоработки» with its error, whole log and stage; the operator closes it with a note", async () => {
    // mac-b failed on «fail» (table row 5) in the test before.
    const [f] = await until("recorded", async () => (await api("GET", "/api/v1/ls-clicker/failures")).json() as { id: string; agentName: string; rowN: number | null; error: string; log: string[]; stage: { node: string; url: string }; lsProfile: string | null; screenshot: boolean; page: { alerts: string[]; elements: { text: string }[] } | null; pageScreenshot: boolean; html: boolean }[], (l) => l.some((x) => x.agentName === "mac-b"));
    expect(f).toMatchObject({ agentName: "mac-b", rowN: 5, error: "ОШИБКА: форма не принята", lsProfile: "0f0e0d0c-0b0a-4908-8706-050403020100", screenshot: false, stage: { node: "businessDetails", url: "https://qbo.example/businessdetails" } });
    expect(f!.log).toContain("ОШИБКА: форма не принята");
    expect((await api("GET", `/api/v1/ls-clicker/failures/${f!.id}/screenshot`)).statusCode).toBe(404);
    // The engine's dump of the page it stopped on: errors shown there, its controls, the page as an image and HTML.
    expect(f!.page).toMatchObject({ alerts: ["That code didn't work."], elements: [{ text: "Resend code" }] });
    expect(f).toMatchObject({ pageScreenshot: true, html: true });
    const page = await api("GET", `/api/v1/ls-clicker/failures/${f!.id}/page`);
    expect([page.statusCode, page.headers["content-type"], page.rawPayload.length]).toEqual([200, "image/png", 200]);
    const html = await api("GET", `/api/v1/ls-clicker/failures/${f!.id}/html`);
    expect(html.headers["content-disposition"]).toMatch(/^attachment/);
    expect(html.body).toContain("Enter the code");
    // A failure is recorded once, however many heartbeats report it.
    await sleep(600);
    expect((await api("GET", "/api/v1/ls-clicker/failures")).json().filter((x: { id: string }) => x.id === f!.id)).toHaveLength(1);

    const resolve = (note: string) => app.inject({ method: "POST", url: `/api/v1/ls-clicker/failures/${f!.id}/resolve`, payload: { note }, cookies: { bap_session: cookie } });
    expect((await resolve("")).statusCode).toBe(400);
    expect((await resolve("повторил строку")).statusCode).toBe(204);
    expect((await resolve("ещё раз")).statusCode).toBe(404);
    expect((await api("GET", "/api/v1/ls-clicker/failures")).json().some((x: { id: string }) => x.id === f!.id)).toBe(false);
    expect((await api("GET", "/api/v1/ls-clicker/failures?resolved=true")).json()[0]).toMatchObject({ id: f!.id, resolvedBy: "operator", resolvedNote: "повторил строку" });
    expect((await app.inject({ method: "GET", url: "/api/v1/ls-clicker/failures" })).statusCode).toBe(401);
  });

  test("[REQ-LSC-003] a run can be stopped; the plan of the next row is shown to the operator", async () => {
    process.env.FAKE_LS_MS = "20000";
    const started = Date.now();
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/runs`)).statusCode).toBe(202);
    // Stopping goes to the agent, which knows its run at once (no heartbeat needed).
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/stop`)).statusCode).toBe(202);
    expect((await endedSince("mac-b", started)).state.run.ok).toBe(false);
    process.env.FAKE_LS_MS = "300";
    expect((await api("POST", `/api/v1/agents/${ids["mac-b"]}/ls-clicker/stop`)).json().error.code).toBe("LS_CLICKER_IDLE");
    expect((await api("GET", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/plan`)).json()).toEqual({ plan: { businessDetails: { "Legal business name": "next row" } } });
  });

  test("[REQ-LSC-002] the export carries LS Clicker's results; a table sharing no column with input.csv is refused without naming any value", async () => {
    const csv = parseCsv((await api("GET", "/api/v1/pipeline/export")).body);
    expect(csv.columns.slice(-4)).toEqual(["LS Clicker: Mac", "who", "result", "Прокси"]);
    expect(csv.rows[0]!.slice(-4)).toEqual(["mac-a", "ann", "registered", PROXY]);
    expect(csv.rows[4]!.slice(-4)).toEqual(["mac-b", "", "", PROXY]);

    await importReady("other.csv", "name,city\nzed,Oslo\n");
    const refused = await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "LS_CLICKER_HEADER_MISMATCH", message: "no column of the table matches input.csv on this Mac" });
    expect(readFileSync(join(dirs["mac-a"]!, "input.csv"), "utf8")).not.toContain("zed");
    expect((await overview()).unsent).toBe(1);
  });

  test("[REQ-LSC-001] a new build waits for a running row to finish; only operators reach LS Clicker; nothing of the rows is journalled", async () => {
    await importReady("again.csv", "who,company\nella,Zeta\n");
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
    const first = Date.now();
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`)).statusCode).toBe(202);
    await until("ran with its proxy", () => existsSync(join(dirs["mac-a"]!, "proxies.log")) && log(), (l) => !!l && l.endsWith(" 10.1.1.1:1080@u:p"));
    expect((await endedSince("mac-a", first)).state.run.ok).toBe(false);
    expect((await patch(1, { cells: ["fail", "edited"] })).json().error.code).toBe("ROW_SENT");
    const remove = await app.inject({ method: "DELETE", url: "/api/v1/pipeline/rows/1", cookies: { bap_session: cookie } });
    expect([remove.statusCode, remove.json().error.code]).toEqual([409, "ROW_SENT"]);

    // The operator changes the proxy; the Mac runs its own unprocessed row again, with the new one.
    expect((await patch(1, { proxy: "10.2.2.2:1080" })).statusCode).toBe(204);
    const second = Date.now();
    expect((await api("POST", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/runs`)).statusCode).toBe(202);
    await until("ran with the edited proxy", log, (l) => !!l && l.endsWith(" 10.2.2.2:1080"));
    await endedSince("mac-a", second);
    // The engine's log names the proxy only as «with its proxy».
    expect((await api("GET", `/api/v1/agents/${ids["mac-a"]}/ls-clicker/log`)).json().lines.join("\n")).not.toContain("10.2.2.2");
  });

  test("[REQ-LSC-008] a row waits for its number and proxy («wait info»); a ticked Mac takes ready rows by itself, an unticked one does not; «Повторить» gives a Mac its last row again", async () => {
    // A fresh Mac: the others keep a failing row of the earlier tests, which stops their automatic runs.
    await addMac("mac-c");
    const build = (await overview()).build!.sha256;
    await until("mac-c has the build", () => mac("mac-c"), (m) => m?.state.sha256 === build);
    const patch = (n: number, payload: object) => app.inject({ method: "PATCH", url: `/api/v1/pipeline/rows/${n}`, payload, cookies: { bap_session: cookie } });
    const auto = (name: string, enabled: boolean) => app.inject({ method: "PUT", url: `/api/v1/agents/${ids[name]}/ls-clicker/auto`, payload: { enabled }, cookies: { bap_session: cookie } });
    process.env.FAKE_LS_STATUS = "bad";
    await api("POST", "/api/v1/pipeline/import?name=wait.csv", Buffer.from("who,number,status\nnina,,\nomar,555,\n"), "text/csv");
    expect((await overview()).unsent).toBe(0); // no proxies yet
    expect((await patch(2, { proxy: PROXY })).statusCode).toBe(204);
    expect((await patch(1, { proxy: PROXY })).statusCode).toBe(204);
    expect((await overview()).unsent).toBe(1); // nina still has no number

    const before = (await mac("mac-c")).state.inputRows;
    const aSent = (await mac("mac-a")).sent;
    expect((await auto("mac-c", true)).statusCode).toBe(204);
    expect((await mac("mac-c")).auto).toBe(true);
    await until("omar ran by itself", () => existsSync(join(dirs["mac-c"]!, "input.csv")) && readFileSync(join(dirs["mac-c"]!, "input.csv"), "utf8"), (t) => !!t && t.includes("omar"));
    // Once its number is filled in, nina goes too, with no button pressed.
    expect((await patch(1, { cells: ["nina", "777", ""] })).statusCode).toBe(204);
    await until("nina ran by itself", () => readFileSync(join(dirs["mac-c"]!, "input.csv"), "utf8"), (t) => t.includes("nina"));
    await until("both done", () => mac("mac-c"), (m) => !m.state.run.running && m.state.inputRows === before + 2 && m.state.outputRows === before + 2);
    expect((await mac("mac-a")).sent).toBe(aSent); // mac-a is not ticked: it took nothing
    // The engine's verdict becomes the table row's status: both rows are done (bad) and leave the working table.
    const statuses = await until("verdicts came back", async () => (await api("GET", "/api/v1/pipeline")).json().rows.map((r: { cells: string[] }) => r.cells[2]), (v: string[]) => v.every((x) => x === "bad"));
    expect(statuses).toEqual(["bad", "bad"]);
    delete process.env.FAKE_LS_STATUS;
    expect((await auto("mac-c", false)).statusCode).toBe(204);

    // «Повторить»: the Mac has nothing left of its own; its last row goes to it again as a new line of input.csv.
    await until("mac-c idle", () => mac("mac-c"), (m) => !m.state.run.running);
    const retried = await app.inject({ method: "POST", url: `/api/v1/agents/${ids["mac-c"]}/ls-clicker/runs`, payload: { retry: true }, cookies: { bap_session: cookie } });
    expect(retried.statusCode).toBe(202);
    await until("nina ran again", () => mac("mac-c"), (m) => !m.state.run.running && m.state.inputRows === before + 3 && m.state.outputRows === before + 3);
    expect(readFileSync(join(dirs["mac-c"]!, "input.csv"), "utf8").match(/nina/g)).toHaveLength(2);
    expect((await api("GET", "/api/v1/pipeline")).json().rows[0].lsc.agentName).toBe("mac-c");
    expect((await app.inject({ method: "PUT", url: `/api/v1/agents/${ids["mac-c"]}/ls-clicker/auto`, payload: { enabled: true } })).statusCode).toBe(401);
  });
});
