import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_KEY_SERVICE, type SecretStore, hasKeychain, keychainStore } from "./secret-store.ts";

export interface AgentConfig {
  serverUrl: string;
  agentId: string;
  agentKey: string;
  name: string;
}

/** What agent.json holds: the key itself only with file storage (tests, platforms without a keychain). */
interface StoredConfig {
  serverUrl: string;
  agentId: string;
  name: string;
  keyStorage?: "keychain" | "file";
  agentKey?: string;
}

export const dataDir = () => process.env.BAP_AGENT_DATA ?? join(homedir(), ".bap");
const configPath = () => join(dataDir(), "agent.json");

/** macOS keeps the agent key in the Keychain (REQ-SEC-007); BAP_KEY_STORAGE=file forces the file. */
export function defaultSecretStore(): SecretStore | null {
  if (process.env.BAP_KEY_STORAGE === "file" || !hasKeychain()) return null;
  return keychainStore(process.env.BAP_KEYCHAIN || undefined);
}

export function saveConfig(config: AgentConfig, secrets: SecretStore | null = defaultSecretStore()): void {
  mkdirSync(dataDir(), { recursive: true });
  const stored: StoredConfig = { serverUrl: config.serverUrl, agentId: config.agentId, name: config.name };
  if (secrets) {
    secrets.set(AGENT_KEY_SERVICE, config.agentId, config.agentKey);
    stored.keyStorage = "keychain";
  } else {
    stored.keyStorage = "file";
    stored.agentKey = config.agentKey;
  }
  // Readable by the owner only, whether or not it holds the key.
  writeFileSync(configPath(), JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

export function loadConfig(secrets: SecretStore | null = defaultSecretStore()): AgentConfig {
  if (!existsSync(configPath())) throw new Error(`${configPath()} not found — run bap-agent enroll first`);
  const stored: StoredConfig = JSON.parse(readFileSync(configPath(), "utf8"));
  const agentKey = stored.agentKey ?? (stored.keyStorage === "keychain" ? secrets?.get(AGENT_KEY_SERVICE, stored.agentId) : null);
  if (!agentKey) throw new Error(`agent key for ${stored.agentId} not found in the ${stored.keyStorage ?? "file"} storage — enroll again`);
  const config = { serverUrl: stored.serverUrl, agentId: stored.agentId, name: stored.name, agentKey };
  // An agent enrolled before keychain storage keeps its key in the file until it first starts with a keychain.
  if (stored.agentKey && secrets) saveConfig(config, secrets);
  return config;
}

/** The agent talks to its server only over HTTPS/WSS (REQ-SEC-001); plain HTTP only to this Mac (development, SSH tunnels). */
export function checkServerUrl(serverUrl: string): void {
  let url: URL | null = null;
  try {
    url = new URL(serverUrl);
  } catch {
    // reported below
  }
  const loopback = url !== null && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url?.protocol === "https:" || (url?.protocol === "http:" && loopback)) return;
  throw new Error(`server ${serverUrl} must be an HTTPS address (plain HTTP is allowed only to 127.0.0.1)`);
}

/** Exchanges a one-time invitation for permanent agent credentials. */
export async function enroll(serverUrl: string, token: string, name: string): Promise<AgentConfig> {
  checkServerUrl(serverUrl);
  const res = await fetch(`${serverUrl}/api/v1/agents/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name, platform: process.platform, architecture: process.arch }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`enrollment failed: ${body.error?.code ?? res.status} ${body.error?.message ?? ""}`.trim());
  return { serverUrl, agentId: body.agentId, agentKey: body.agentKey, name };
}
