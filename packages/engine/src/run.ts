import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserProvider } from "@bap/browser-adapters";
import type { Scenario, StepContext } from "@bap/scenario-sdk";
import { z } from "zod";
import type { CheckpointStore } from "./checkpoints.ts";
import { renderReport } from "./report.ts";

export type RunStatus = "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW";

export interface StepRecord {
  id: string;
  mutating: boolean;
  /** `unverified`: a mutating step whose effect could not be confirmed. */
  status: "passed" | "failed" | "unverified";
  startedAt: string;
  durationMs: number;
  screenshot?: string;
  error?: string;
}

export interface RunResult {
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  profileId: string;
  status: RunStatus;
  steps: StepRecord[];
  startedAt: string;
  finishedAt: string;
  reportPath: string;
}

export interface RunOptions {
  // The engine validates input with the scenario's own schema and never looks inside state,
  // so any concrete scenario is accepted (function parameters make the generics invariant).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scenario: Scenario<any, any>;
  input: unknown;
  provider: BrowserProvider;
  profileId: string;
  runId: string;
  agentId: string;
  artifactsDir: string;
  checkpoints: CheckpointStore;
  onStep?: (step: StepRecord) => void;
  /** Playwright timeout for each action inside a step. */
  stepTimeoutMs?: number;
}

export class InputValidationError extends Error {}

// Playwright colours its messages with ANSI codes; reports and logs need plain text.
// eslint-disable-next-line no-control-regex
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, "");

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { scenario, provider, profileId, runId, agentId, artifactsDir, checkpoints } = opts;
  // Validate before any browser work: bad input must never reach a profile.
  const parsed = scenario.inputSchema.safeParse(opts.input);
  if (!parsed.success) throw new InputValidationError(`invalid input for ${scenario.id}:\n${z.prettifyError(parsed.error)}`);

  mkdirSync(artifactsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const steps: StepRecord[] = [];
  let status: RunStatus = "SUCCEEDED";

  const session = await provider.openSession(profileId, runId);
  try {
    await session.attach();
    const page = await session.getPage();
    page.setDefaultTimeout(opts.stepTimeoutMs ?? 10_000);
    const ctx: StepContext<unknown, unknown> = { page, input: parsed.data, state: scenario.initialState(parsed.data) };

    for (const [index, step] of scenario.steps.entries()) {
      const stepStarted = Date.now();
      let error: unknown;
      try {
        await step.run(ctx);
      } catch (e) {
        error = e;
      }
      // A mutating step is judged only by its verify, even if run() threw: the change may have happened.
      let ok: boolean;
      if (step.mutating) ok = await step.verify(ctx).catch(() => false);
      else ok = error === undefined && (step.verify ? await step.verify(ctx).catch(() => false) : true);

      const screenshot = `${String(index + 1).padStart(2, "0")}-${step.id}.png`;
      const shot = await ctx.page.screenshot({ path: join(artifactsDir, screenshot) }).then(() => screenshot, () => undefined);
      const record: StepRecord = {
        id: step.id,
        mutating: step.mutating === true,
        status: ok ? "passed" : step.mutating ? "unverified" : "failed",
        startedAt: new Date(stepStarted).toISOString(),
        durationMs: Date.now() - stepStarted,
        ...(shot && { screenshot: shot }),
        ...(error !== undefined ? { error: message(error) } : !ok && { error: "verify did not confirm the step" }),
      };
      steps.push(record);
      opts.onStep?.(record);

      if (!ok) {
        status = step.mutating ? "NEEDS_REVIEW" : "FAILED";
        break;
      }
      const next = scenario.steps[index + 1];
      checkpoints.save({
        runId,
        agentId,
        profileId,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        sdkVersion: scenario.sdkVersion,
        lastCompletedStepId: step.id,
        sequence: index + 1,
        createdAt: new Date().toISOString(),
        state: JSON.parse(JSON.stringify(ctx.state ?? null)),
        resume: { nextStepId: next?.id ?? null, nextStepMutating: next?.mutating === true, autoResume: scenario.autoResume },
      });
    }
  } finally {
    await session.closeSession();
  }

  const result: RunResult = {
    runId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    profileId,
    status,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPath: join(artifactsDir, "run-report.html"),
  };
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(result.reportPath, renderReport(result));
  return result;
}
