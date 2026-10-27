import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { LinkenSphereProvider, ProfileNotFoundError } from "@bap/browser-adapters";

// A stand-in for the Local API, answering with the shapes observed on LS 2.26.10.
const sessions = new Map<string, { name: string; status: string }>();
const calls: { method: string; url: string; body: unknown }[] = [];
let server: Server;
let apiUrl: string;

const readBody = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method!, url: req.url!, body });
    const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(data === undefined ? "" : JSON.stringify(data));
    const missing = (uuid: string) => json(404, { error: `No session with id ${uuid} found on the active desktop.` });
    const route = `${req.method} ${req.url}`;
    if (route === "GET /sessions") return json(200, [...sessions].map(([uuid, s]) => ({ uuid, ...s })));
    if (route === "POST /sessions/create_quick") {
      sessions.set("new-uuid", { name: "Desktop preset 1", status: "stopped" });
      return json(200, [{ name: "Desktop preset 1", uuid: "new-uuid" }]);
    }
    if (route === "POST /sessions/set_name") {
      sessions.get(body.uuid)!.name = body.name;
      return json(200, undefined);
    }
    if (route === "POST /sessions/start") {
      const s = sessions.get(body.uuid);
      if (!s) return missing(body.uuid);
      if (s.status !== "stopped") return json(409, { error: "Session is used by another client or operation." });
      s.status = "automationRunning";
      return json(200, { debug_port: 9999, uuid: body.uuid });
    }
    if (route === "POST /sessions/stop") {
      const s = sessions.get(body.uuid);
      if (!s) return missing(body.uuid);
      s.status = "stopped";
      return json(200, { uuid: body.uuid });
    }
    if (route === "DELETE /sessions") return sessions.delete(body.uuid) ? json(200, { uuid: body.uuid }) : missing(body.uuid);
    json(404, { error: "unknown route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  sessions.clear();
  calls.length = 0;
});

test("[REQ-LS-001] lists profiles as id and name only", async () => {
  sessions.set("u1", { name: "Shop", status: "stopped" });
  const provider = new LinkenSphereProvider({ apiUrl });
  expect(await provider.isAvailable()).toBe(true);
  expect(await provider.listProfiles()).toEqual([{ id: "u1", name: "Shop" }]);
});

test("[REQ-LS-007] an unknown profile is a ProfileNotFoundError before any session starts", async () => {
  const provider = new LinkenSphereProvider({ apiUrl });
  await expect(provider.openSession("ghost", "r1")).rejects.toBeInstanceOf(ProfileNotFoundError);
  expect(calls.map((c) => c.url)).toEqual(["/sessions"]);
});

test("creates, names, starts, stops and deletes sessions with the documented requests", async () => {
  const { api } = new LinkenSphereProvider({ apiUrl });
  const uuid = await api.createSession("bap-test-1");
  expect(sessions.get(uuid)).toEqual({ name: "bap-test-1", status: "stopped" });
  expect(await api.start(uuid, true)).toEqual({ debug_port: 9999, uuid });
  expect(calls.at(-1)).toEqual({ method: "POST", url: "/sessions/start", body: { uuid, headless: true } });
  await api.stop(uuid);
  await api.deleteSession(uuid);
  expect(sessions.size).toBe(0);
});

test("API errors carry the HTTP status and the Linken Sphere message", async () => {
  sessions.set("busy", { name: "Busy", status: "automationRunning" });
  const { api } = new LinkenSphereProvider({ apiUrl });
  await expect(api.start("busy", false)).rejects.toThrow('Linken Sphere POST /sessions/start: HTTP 409 {"error":"Session is used by another client or operation."}');
  await expect(api.stop("ghost")).rejects.toThrow(/HTTP 404 .*No session with id ghost/);
});

test("an unreachable Local API reports unavailable instead of throwing", async () => {
  const provider = new LinkenSphereProvider({ apiUrl: "http://127.0.0.1:1" });
  expect(await provider.isAvailable()).toBe(false);
});
