import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  serverUrl: string;
  agentId: string;
  agentKey: string;
  name: string;
}

export const dataDir = () => process.env.BAP_AGENT_DATA ?? join(homedir(), ".bap");
const configPath = () => join(dataDir(), "agent.json");

// The key moves to the macOS Keychain later; until then the file is readable by the owner only.
export function saveConfig(config: AgentConfig): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

export function loadConfig(): AgentConfig {
  if (!existsSync(configPath())) throw new Error(`${configPath()} not found — run bap-agent enroll first`);
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

/** Exchanges a one-time invitation for permanent agent credentials. */
export async function enroll(serverUrl: string, token: string, name: string): Promise<AgentConfig> {
  const res = await fetch(`${serverUrl}/api/v1/agents/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name, platform: process.platform, architecture: process.arch }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`enrollment failed: ${body.error?.code ?? res.status} ${body.error?.message ?? ""}`.trim());
  return { serverUrl, agentId: body.agentId, agentKey: body.agentKey, name };
}
