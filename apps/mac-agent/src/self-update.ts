import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The build an installed agent runs: 12 hex of its file's sha256 (what the server compares). */
export const buildOf = (file: string) => sha256(readFileSync(file)).slice(0, 12);

/** The build of an agent run from a repository: "dev-<commit>", or "dev" outside git. */
export function devBuild(): string {
  try {
    return `dev-${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dirname(import.meta.filename), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}`;
  } catch {
    return "dev";
  }
}

/**
 * Fetches the server's current agent build with this agent's key and puts it in place of `file`
 * atomically, only if it matches the checksum the server announced. Returns the new build.
 */
export async function installBuild(serverUrl: string, agentKey: string, file: string, expectedSha256?: string): Promise<string> {
  const res = await fetch(`${serverUrl}/api/v1/agents/install/bundle`, { headers: { authorization: `Bearer ${agentKey}` } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = sha256(body);
  if (actual !== res.headers.get("x-bap-sha256") || (expectedSha256 && actual !== expectedSha256)) throw new Error("the downloaded agent does not match its checksum");
  writeFileSync(`${file}.new`, body);
  renameSync(`${file}.new`, file);
  return actual.slice(0, 12);
}
