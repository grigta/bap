import { mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { checkServerUrl, enroll, loadConfig, saveConfig } from "../../apps/mac-agent/src/config.ts";
import { memorySecretStore } from "../../apps/mac-agent/src/secret-store.ts";

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

test("[REQ-SEC-007] with a keychain the agent key is kept there and agent.json holds no secret", () => {
  const keychain = memorySecretStore();
  const config = { serverUrl: "https://cp", agentId: "a2", agentKey: "very-secret-key", name: "mac" };
  saveConfig(config, keychain);
  const file = readFileSync(join(process.env.BAP_AGENT_DATA!, "agent.json"), "utf8");
  expect(file).not.toContain("very-secret-key");
  expect(JSON.parse(file)).toEqual({ serverUrl: "https://cp", agentId: "a2", name: "mac", keyStorage: "keychain" });
  expect(keychain.get("bap-agent", "a2")).toBe("very-secret-key");
  expect(loadConfig(keychain)).toEqual(config);
  expect(() => loadConfig(memorySecretStore())).toThrow(/agent key for a2 not found in the keychain storage/);
});

test("[REQ-SEC-007] a key left in agent.json by an older agent moves to the keychain", () => {
  const config = { serverUrl: "https://cp", agentId: "a3", agentKey: "old-file-key", name: "mac" };
  saveConfig(config, null);
  const keychain = memorySecretStore();
  expect(loadConfig(keychain)).toEqual(config);
  expect(readFileSync(join(process.env.BAP_AGENT_DATA!, "agent.json"), "utf8")).not.toContain("old-file-key");
  expect(keychain.get("bap-agent", "a3")).toBe("old-file-key");
  // Without a keychain the file stays as it is.
  saveConfig(config, null);
  expect(loadConfig(null)).toEqual(config);
  expect(readFileSync(join(process.env.BAP_AGENT_DATA!, "agent.json"), "utf8")).toContain("old-file-key");
});

test("[REQ-SEC-001] the agent talks to its server only over HTTPS, except on this Mac", () => {
  for (const ok of ["https://bap.example.com", "https://10.0.0.5:8443", "http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"]) expect(() => checkServerUrl(ok)).not.toThrow();
  for (const bad of ["http://bap.example.com", "http://10.0.0.5:3000", "ws://bap.example.com", "ftp://x", "not a url"]) expect(() => checkServerUrl(bad)).toThrow(/HTTPS/);
});
