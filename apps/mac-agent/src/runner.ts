import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserProvider } from "@bap/browser-adapters";
import { CheckpointStore, InputValidationError, loadScenarioBundle, runScenario } from "@bap/engine";
import type { RunAssignPayload, RunEvent } from "@bap/protocol";
import type { AgentStore } from "./agent-store.ts";

export type EmitRunEvent = (event: Omit<RunEvent, "v" | "id" | "ts" | "seq">) => void;

export interface RunnerDeps {
  serverUrl: string;
  /** Current key: it may be rotated while the run executes. */
  agentKey: () => string;
  agentId: string;
  provider: BrowserProvider;
  dataDir: string;
  store: AgentStore;
  /** Queues the event in the outbox; it is delivered once connected and dropped only when acknowledged. */
  emit: EmitRunEvent;
  isCancelled: () => boolean;
  log: (line: string) => void;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Downloads the bundle once per checksum; the engine re-checks it against the manifest on load. */
async function fetchBundle(assign: RunAssignPayload, deps: RunnerDeps): Promise<string> {
  const { id, version, sha256: expected } = assign.scenario;
  const dir = join(deps.dataDir, "bundles");
  const file = `${id}@${version}-${expected.slice(0, 12)}.mjs`;
  const manifest = join(dir, `${id}@${version}-${expected.slice(0, 12)}.json`);
  if (!existsSync(join(dir, file)) || sha256(readFileSync(join(dir, file))) !== expected) {
    const res = await fetch(`${deps.serverUrl}/api/v1/scenarios/${id}/versions/${version}/bundle`, { headers: { authorization: `Bearer ${deps.agentKey()}` } });
    if (!res.ok) throw new RunnerError("BUNDLE_UNAVAILABLE", `bundle download failed: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (sha256(body) !== expected) throw new RunnerError("BUNDLE_CHECKSUM_MISMATCH", `bundle ${id}@${version} does not match sha256 ${expected}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  writeFileSync(manifest, JSON.stringify({ id, version, file, sha256: expected }));
  return manifest;
}

class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Executes (or resumes) one assigned run and reports it as run.* events through the outbox. */
export async function executeRun(assign: RunAssignPayload, deps: RunnerDeps): Promise<void> {
  const { runId } = assign;
  const { emit } = deps;
  emit({ type: "run.accepted", payload: { runId } });
  const checkpoints = new CheckpointStore(join(deps.dataDir, "agent.db"));
  const artifactsDir = join(deps.dataDir, "runs", runId);
  try {
    const scenario = await loadScenarioBundle(await fetchBundle(assign, deps));
    const resumeFrom = assign.resume ? checkpoints.latest(runId) : null;
    emit({ type: "run.started", payload: { runId, autoResume: scenario.autoResume, resumedAfter: resumeFrom?.lastCompletedStepId ?? null } });
    const result = await runScenario({
      scenario,
      input: assign.input,
      provider: deps.provider,
      profileId: assign.profileExternalId,
      runId,
      agentId: deps.agentId,
      artifactsDir,
      checkpoints,
      timeoutMs: assign.timeoutMs,
      resuming: assign.resume,
      resumeFrom,
      shouldCancel: deps.isCancelled,
      onStep: (step) => {
        // Upload first: the progress event refers to the screenshot by name.
        if (step.screenshot) deps.store.enqueueArtifact({ runId, name: step.screenshot, path: join(artifactsDir, step.screenshot) });
        emit({
          type: "run.progress",
          payload: {
            runId,
            step: {
              sequence: step.sequence,
              stepId: step.id,
              mutating: step.mutating,
              status: step.status,
              startedAt: step.startedAt,
              durationMs: step.durationMs,
              ...(step.error && { error: step.error }),
              ...(step.screenshot && { screenshot: step.screenshot }),
            },
          },
        });
      },
      onCheckpoint: (cp) =>
        emit({
          type: "run.checkpoint",
          payload: {
            runId,
            sequence: cp.sequence,
            stepId: cp.lastCompletedStepId,
            nextStepId: cp.resume.nextStepId,
            nextStepMutating: cp.resume.nextStepMutating,
            autoResume: cp.resume.autoResume,
            createdAt: cp.createdAt,
          },
        }),
    });
    if (result.status === "SUCCEEDED") emit({ type: "run.completed", payload: { runId } });
    else if (result.status === "CANCELLED") emit({ type: "run.cancelled", payload: { runId, afterStep: result.cancelledAfter ?? null } });
    else emit({ type: "run.failed", payload: { runId, status: result.status, errorCode: result.errorCode ?? "STEP_FAILED", message: result.errorMessage ?? "run failed" } });
    deps.log(`run ${runId}: ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}`);
  } catch (e) {
    const code = e instanceof RunnerError ? e.code : e instanceof InputValidationError ? "INPUT_INVALID" : "AGENT_ERROR";
    emit({ type: "run.failed", payload: { runId, status: "FAILED", errorCode: code, message: e instanceof Error ? e.message : String(e) } });
    deps.log(`run ${runId}: FAILED (${code})`);
  } finally {
    checkpoints.close();
  }
}
