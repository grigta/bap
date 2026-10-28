// A stand-in for the Linken Sphere 2 Local API (shapes observed on LS 2.26.10) that starts real
// Chromium for each session. Lets CI and fault tests run the real LinkenSphereProvider, including
// "the Local API stops answering". Checked against the provider contract in tests/integration.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { join } from "node:path";
import { type LaunchedChromium, closeChromium, launchChromium } from "@bap/browser-adapters";

interface FakeSession {
  name: string;
  browser: LaunchedChromium | null;
}

const readBody = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

export async function startFakeLinkenSphere(sessionsDir: string) {
  const sessions = new Map<string, FakeSession>();
  const dir = (uuid: string) => join(sessionsDir, uuid);
  const status = (s: FakeSession) => (s.browser && s.browser.process.exitCode === null && s.browser.process.signalCode === null ? "automationRunning" : "stopped");

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const json = (code: number, data?: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(data === undefined ? "" : JSON.stringify(data));
    const session = sessions.get(body.uuid);
    const missing = () => json(404, { error: `No session with id ${body.uuid} found on the active desktop.` });
    const route = `${req.method} ${req.url}`;
    if (route === "GET /sessions") return json(200, [...sessions].map(([uuid, s]) => ({ name: s.name, status: status(s), uuid })));
    if (route === "POST /sessions/create_quick") {
      const uuid = randomUUID();
      sessions.set(uuid, { name: `Desktop preset ${sessions.size + 1}`, browser: null });
      mkdirSync(dir(uuid), { recursive: true });
      return json(200, [{ name: sessions.get(uuid)!.name, uuid }]);
    }
    if (!session) return missing();
    if (route === "POST /sessions/set_name") return (session.name = body.name), json(200);
    if (route === "POST /sessions/start") {
      if (status(session) !== "stopped") return json(409, { error: "Session is used by another client or operation." });
      // Always headless: tests must not open windows on the developer's screen.
      session.browser = await launchChromium(dir(body.uuid), true);
      return json(200, { debug_port: session.browser.port, uuid: body.uuid });
    }
    if (route === "POST /sessions/stop" || route === "POST /sessions/force_stop") {
      if (session.browser) {
        if (route.endsWith("force_stop")) session.browser.process.kill("SIGKILL");
        else await closeChromium(session.browser);
      }
      session.browser = null;
      return json(200, { uuid: body.uuid });
    }
    if (route === "DELETE /sessions") return sessions.delete(body.uuid), json(200, { uuid: body.uuid });
    json(404, { error: `unknown route ${route}` });
  });

  const listen = (port = 0) => new Promise<number>((r) => server.listen(port, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  const port = await listen();
  return {
    url: `http://127.0.0.1:${port}`,
    /** Creates a session (an LS "profile") and returns its uuid. */
    createSession(name: string, uuid: string = randomUUID()) {
      sessions.set(uuid, { name, browser: null });
      mkdirSync(dir(uuid), { recursive: true });
      return uuid;
    },
    /** The Local API stops answering; running browsers keep running, as when LS hangs. */
    async down() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
    async up() {
      await listen(port);
    },
    async stop() {
      for (const s of sessions.values()) if (s.browser) s.browser.process.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
