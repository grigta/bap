import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserProvider } from "@bap/browser-adapters";
import { CheckpointStore, InputValidationError, loadScenarioBundle, runScenario } from "@bap/engine";
import type { RunAssignPayload, RunEvent } from "@bap/protocol";

export type EmitRunEvent = (event: Omit<RunEvent, "v" | "id" | "ts" | "seq">) => void;

export interface RunnerDeps {
  serverUrl: string;
  agentKey: string;
  agentId: string;
  provider: BrowserProvider;
  dataDir: string;
  emit: EmitRunEvent;
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
    const res = await fetch(`${deps.serverUrl}/api/v1/scenarios/${id}/versions/${version}/bundle`, { headers: { authorization: `Bearer ${deps.agentKey}` } });
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

/** Executes one assigned run end to end and reports it as run.* events. */
export async function executeRun(assign: RunAssignPayload, deps: RunnerDeps): Promise<void> {
  const { runId } = assign;
  const { emit } = deps;
  emit({ type: "run.accepted", payload: { runId } });
  const checkpoints = new CheckpointStore(join(deps.dataDir, "agent.db"));
  try {
    const scenario = await loadScenarioBundle(await fetchBundle(assign, deps));
    emit({ type: "run.started", payload: { runId } });
    let sequence = 0;
    const result = await runScenario({
      scenario,
      input: assign.input,
      provider: deps.provider,
      profileId: assign.profileExternalId,
      runId,
      agentId: deps.agentId,
      artifactsDir: join(deps.dataDir, "runs", runId),
      checkpoints,
      timeoutMs: assign.timeoutMs,
      onStep: async (step) => {
        sequence++;
        if (step.screenshot) {
          const res = await fetch(`${deps.serverUrl}/api/v1/runs/${runId}/artifacts/${step.screenshot}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${deps.agentKey}`, "content-type": "image/png" },
            body: readFileSync(join(deps.dataDir, "runs", runId, step.screenshot)),
          });
          if (!res.ok) deps.log(`screenshot upload for ${runId} failed: HTTP ${res.status}`);
        }
        emit({
          type: "run.progress",
          payload: {
            runId,
            step: {
              sequence,
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
    });
    if (result.status === "SUCCEEDED") emit({ type: "run.completed", payload: { runId } });
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
