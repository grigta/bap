import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAssignPayload } from "@bap/protocol";
import { expect, test } from "vitest";
import { AgentStore, type OutboxEvent } from "../../apps/mac-agent/src/agent-store.ts";

const event = (runId: string, type: string): OutboxEvent => ({ v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), type, payload: { runId } });

test("[REQ-PROTO-006] only runs that finished here with results still undelivered are reported as the agent's own", () => {
  const store = new AgentStore(mkdtempSync(join(tmpdir(), "bap-store-")));
  const assign = (runId: string) => ({ runId }) as RunAssignPayload;
  store.setRun("finished-offline", "running", assign("finished-offline"));
  store.setRun("finished-offline", "finished");
  store.enqueueEvent(event("finished-offline", "run.completed"));
  // Killed mid-run: its early events are still in the outbox, but nothing is executing it any more.
  store.setRun("interrupted", "running", assign("interrupted"));
  store.setRun("interrupted", "interrupted");
  store.enqueueEvent(event("interrupted", "run.progress"));
  store.setRun("delivered", "running", assign("delivered"));
  store.setRun("delivered", "finished");
  expect(store.finishedRunsWithUndeliveredEvents()).toEqual(["finished-offline"]);
  store.close();
});
