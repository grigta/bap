import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserProvider } from "@bap/browser-adapters";
import { CheckpointStore, InputValidationError, type StepRecord, loadScenarioBundle, runRecording, runScenario } from "@bap/engine";
import { type Healer, type RecordDecision, type Recorder, recipeScenario, recipeSchema, recordTask, secretValues } from "@bap/recipe";
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

/** Downloads the bundle (or recipe) once per checksum; the engine re-checks a bundle against the manifest on load. */
async function fetchBundle(assign: RunAssignPayload, deps: RunnerDeps): Promise<string> {
  const { id, version, sha256: expected, kind } = assign.scenario;
  const dir = join(deps.dataDir, "bundles");
  const file = `${id}@${version}-${expected.slice(0, 12)}.${kind === "recipe" ? "json" : "mjs"}`;
  const manifest = join(dir, `${id}@${version}-${expected.slice(0, 12)}.manifest.json`);
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
  /** Read by the engine when this error fails a step (e.g. healing over budget). */
  get errorCode() {
    return this.code;
  }
}

/** Executes (or resumes) one assigned run and reports it as run.* events through the outbox. */
export async function executeRun(assign: RunAssignPayload, deps: RunnerDeps): Promise<void> {
  const { runId } = assign;
  const { emit } = deps;
  emit({ type: "run.accepted", payload: { runId } });
  const checkpoints = new CheckpointStore(join(deps.dataDir, "agent.db"));
  const artifactsDir = join(deps.dataDir, "runs", runId);
  const reportStep = (step: StepRecord) => {
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
          ...(step.intent && { intent: step.intent }),
          ...(step.resolution && { resolution: step.resolution }),
          ...(step.note && { note: step.note }),
        },
      },
    });
  };
  try {
    if (assign.recording) return await record(assign, deps, artifactsDir, reportStep);
    const manifest = await fetchBundle(assign, deps);
    const scenario =
      assign.scenario.kind === "recipe"
        ? recipeScenario({
            id: assign.scenario.id,
            version: assign.scenario.version,
            recipe: recipeSchema.parse(JSON.parse(readFileSync(join(dirname(manifest), (JSON.parse(readFileSync(manifest, "utf8")) as { file: string }).file), "utf8"))),
            heal: healer(runId, deps),
          })
        : await loadScenarioBundle(manifest);
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
      onStep: (step) => reportStep(step),
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

/** Calls the agent API of the Control Plane with the agent key; errors carry the server's code. */
async function agentCall<T>(deps: RunnerDeps, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${deps.serverUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.agentKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok || !json) throw new RunnerError(json?.error?.code ?? "SERVER_ERROR", json?.error?.message ?? `HTTP ${res.status} from ${path}`);
  return json;
}

/** Healing asks the server, which alone talks to the model (REQ-DOM-009). */
const healer = (runId: string, deps: RunnerDeps): Healer => async (request) =>
  agentCall(deps, `/api/v1/agents/me/runs/${runId}/heal`, { ...request, screenshot: request.screenshot.toString("base64") });

async function uploadNow(deps: RunnerDeps, runId: string, name: string, body: Buffer) {
  const res = await fetch(`${deps.serverUrl}/api/v1/runs/${runId}/artifacts/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${deps.agentKey()}`, "content-type": "image/png" },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new RunnerError("UPLOAD_FAILED", `screenshot upload failed: HTTP ${res.status}`);
}

/** A recording: the server decides each action from what the agent shows it (REQ-DOM-004). */
async function record(assign: RunAssignPayload, deps: RunnerDeps, artifactsDir: string, reportStep: (step: StepRecord) => void): Promise<void> {
  const { runId } = assign;
  const input = (assign.input ?? {}) as Record<string, unknown>;
  const secrets = secretValues({ inputs: assign.recording!.secretInputs.map((name) => ({ name, secret: true })) }, input);
  mkdirSync(artifactsDir, { recursive: true });
  let observed = 0;
  const path = `/api/v1/agents/me/runs/${runId}/record`;
  const recorder: Recorder = {
    async observe({ snapshot, screenshot, last }) {
      // The server shows the screenshot to the model, so it is uploaded before the question.
      const name = `look-${String(++observed).padStart(3, "0")}.png`;
      await uploadNow(deps, runId, name, screenshot);
      return agentCall<RecordDecision>(deps, path, { snapshot, screenshot: name, last });
    },
    poll: () => agentCall<RecordDecision>(deps, path, { poll: true }),
  };
  deps.emit({ type: "run.started", payload: { runId, autoResume: false, resumedAfter: null } });
  const result = await runRecording({
    provider: deps.provider,
    profileId: assign.profileExternalId,
    runId,
    record: (page) =>
      recordTask({
        page,
        startUrl: assign.recording!.startUrl,
        input,
        secrets,
        recorder,
        deadline: Date.now() + assign.timeoutMs,
        shouldCancel: deps.isCancelled,
        onStep: async (step) => {
          const screenshot = `${String(step.sequence).padStart(2, "0")}-${step.stepId}.png`;
          writeFileSync(join(artifactsDir, screenshot), step.screenshot);
          reportStep({ sequence: step.sequence, id: step.stepId, mutating: step.mutating, status: step.status, startedAt: step.startedAt, durationMs: step.durationMs, screenshot, intent: step.intent, resolution: step.resolution, ...(step.error && { error: step.error }) });
        },
      }),
  });
  if (result.status === "SUCCEEDED") deps.emit({ type: "run.completed", payload: { runId } });
  else if (result.status === "CANCELLED") deps.emit({ type: "run.cancelled", payload: { runId, afterStep: null } });
  else deps.emit({ type: "run.failed", payload: { runId, status: "FAILED", errorCode: result.errorCode ?? "RECORDING_FAILED", message: result.errorMessage ?? "recording failed" } });
  deps.log(`recording ${runId}: ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}`);
}
