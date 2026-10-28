import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAssignPayload } from "@bap/protocol";
import { expect, test } from "vitest";
import { startAgent } from "../../apps/mac-agent/src/agent.ts";
import { AgentStore } from "../../apps/mac-agent/src/agent-store.ts";
import { purgeLocalRuns } from "../../apps/mac-agent/src/retention.ts";

const assign = (runId: string) => ({ runId }) as RunAssignPayload;

test("[REQ-SEC-010] the agent deletes local data of old finished runs, never of running or not yet uploaded ones", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bap-retention-"));
  const store = new AgentStore(dataDir);
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const runDir = (runId: string, old = true) => {
    const dir = join(dataDir, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-step.png"), "png");
    if (old) utimesSync(dir, longAgo, longAgo);
    return dir;
  };
  const oldFinished = runDir("old-finished");
  store.setRun("old-finished", "running", assign("old-finished"));
  store.setRun("old-finished", "finished");
  const recent = runDir("recent", false);
  store.setRun("recent", "finished", assign("recent"));
  const running = runDir("running");
  store.setRun("running", "running", assign("running"));
  const interrupted = runDir("interrupted");
  store.setRun("interrupted", "interrupted", assign("interrupted"));
  const notUploaded = runDir("not-uploaded");
  store.setRun("not-uploaded", "finished", assign("not-uploaded"));
  store.enqueueArtifact({ runId: "not-uploaded", name: "01-step.png", path: join(notUploaded, "01-step.png") });

  expect(purgeLocalRuns(store, dataDir, new Date(Date.now() - 7 * 86_400_000))).toEqual(["old-finished"]);
  expect(existsSync(oldFinished)).toBe(false);
  for (const kept of [recent, running, interrupted, notUploaded]) expect(existsSync(kept)).toBe(true);
  // The run itself stays known, so a repeated assignment is still refused.
  expect(store.runStatus("old-finished")).toBe("finished");
  store.close();
});

test("[REQ-SEC-010] an agent without run data has nothing to purge", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bap-retention-"));
  const store = new AgentStore(dataDir);
  expect(purgeLocalRuns(store, dataDir, new Date())).toEqual([]);
  store.close();
});

test("[REQ-SEC-010] a starting agent purges expired run data even before it reaches the server", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bap-retention-"));
  const dir = join(dataDir, "runs", "ancient");
  mkdirSync(dir, { recursive: true });
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(dir, longAgo, longAgo);
  const lines: string[] = [];
  const agent = startAgent({ serverUrl: "http://127.0.0.1:1", agentKey: "k", provider: null, providerName: "none", maxSessions: 1, dataDir, retentionDays: 7, log: (l) => lines.push(l) });
  try {
    await expect.poll(() => existsSync(dir)).toBe(false);
    expect(lines).toContain("deleted local data of 1 run(s) older than 7 days");
  } finally {
    agent.stop();
  }
});
