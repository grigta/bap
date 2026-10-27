import { mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { enroll, loadConfig, saveConfig } from "../../apps/mac-agent/src/config.ts";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.BAP_AGENT_DATA;
  process.env.BAP_AGENT_DATA = mkdtempSync(join(tmpdir(), "bap-config-"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.BAP_AGENT_DATA;
  else process.env.BAP_AGENT_DATA = previous;
});

test("agent credentials are saved readable by the owner only and load back", () => {
  const config = { serverUrl: "https://cp", agentId: "a1", agentKey: "secret", name: "mac" };
  saveConfig(config);
  expect(statSync(join(process.env.BAP_AGENT_DATA!, "agent.json")).mode & 0o777).toBe(0o600);
  expect(loadConfig()).toEqual(config);
});

test("starting without enrollment fails with a hint", () => {
  expect(() => loadConfig()).toThrow(/agent\.json not found — run bap-agent enroll first/);
});

test("enroll exchanges the invitation and reports server errors by code", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      const { token } = JSON.parse(body);
      if (token === "good") res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ agentId: "a1", agentKey: "k1" }));
      else res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "INVITATION_INVALID", message: "used" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect(await enroll(url, "good", "mac")).toEqual({ serverUrl: url, agentId: "a1", agentKey: "k1", name: "mac" });
    await expect(enroll(url, "bad", "mac")).rejects.toThrow("enrollment failed: INVITATION_INVALID used");
  } finally {
    server.close();
  }
});
