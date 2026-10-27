import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BrowserProvider, type BrowserSession, ProfileNotFoundError } from "@bap/browser-adapters";
import type { Scenario, StepContext } from "@bap/scenario-sdk";
import { z } from "zod";
import type { CheckpointStore } from "./checkpoints.ts";
import { renderReport } from "./report.ts";

export type RunStatus = "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW";
export type RunErrorCode = "TIMEOUT" | "STEP_FAILED" | "UNVERIFIED" | "SESSION_START_FAILED" | "PROFILE_NOT_FOUND";

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
  errorCode?: RunErrorCode;
  errorMessage?: string;
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
  /** Awaited before the next step starts, so callers can upload the step screenshot first. */
  onStep?: (step: StepRecord) => void | Promise<void>;
  /** Playwright timeout for each action inside a step. */
  stepTimeoutMs?: number;
  /** Budget for the whole run; exceeding it fails the current step with TIMEOUT. */
  timeoutMs?: number;
  /** Attempts to start the browser session before giving up (REQ-LS-008). */
  sessionAttempts?: number;
  sessionRetryDelayMs?: number;
}

export class InputValidationError extends Error {}

class DeadlineError extends Error {}
class SessionStartError extends Error {}

// Playwright colours its messages with ANSI codes; reports and logs need plain text.
// eslint-disable-next-line no-control-regex
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, "");

async function openWithRetries(opts: RunOptions): Promise<BrowserSession> {
  const attempts = opts.sessionAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    // A missing profile is a configuration error: openSession throws it and nothing is retried.
    const session = await opts.provider.openSession(opts.profileId, opts.runId);
    try {
      await session.attach();
      return session;
    } catch (e) {
      await session.closeSession().catch(() => {});
      if (attempt >= attempts) throw new SessionStartError(`browser session did not start after ${attempts} attempts: ${message(e)}`);
      await sleep((opts.sessionRetryDelayMs ?? 1000) * attempt);
    }
  }
}

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { scenario, profileId, runId, agentId, artifactsDir, checkpoints } = opts;
  // Validate before any browser work: bad input must never reach a profile.
  const parsed = scenario.inputSchema.safeParse(opts.input);
  if (!parsed.success) throw new InputValidationError(`invalid input for ${scenario.id}:\n${z.prettifyError(parsed.error)}`);

  mkdirSync(artifactsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + (opts.timeoutMs ?? Number.POSITIVE_INFINITY);
  const steps: StepRecord[] = [];
  let status: RunStatus = "SUCCEEDED";
  let errorCode: RunErrorCode | undefined;
  let errorMessage: string | undefined;

  let session: BrowserSession | null = null;
  try {
    session = await openWithRetries(opts);
  } catch (e) {
    status = "FAILED";
    errorCode = e instanceof ProfileNotFoundError ? "PROFILE_NOT_FOUND" : "SESSION_START_FAILED";
    errorMessage = message(e);
  }

  if (session) {
    try {
      const page = await session.getPage();
      const ctx: StepContext<unknown, unknown> = { page, input: parsed.data, state: scenario.initialState(parsed.data) };

      for (const [index, step] of scenario.steps.entries()) {
        const stepStarted = Date.now();
        const remaining = deadline - stepStarted;
        page.setDefaultTimeout(Math.max(1, Math.min(opts.stepTimeoutMs ?? 10_000, remaining)));
        let error: unknown;
        try {
          if (remaining <= 0) throw new DeadlineError(`run timeout of ${opts.timeoutMs} ms exceeded before step ${step.id}`);
          // The race cuts off steps that hang outside Playwright; closing the session afterwards stops them.
          const deadlineHit = Number.isFinite(remaining)
            ? sleep(remaining).then(() => Promise.reject(new DeadlineError(`run timeout of ${opts.timeoutMs} ms exceeded in step ${step.id}`)))
            : new Promise<never>(() => {});
          await Promise.race([step.run(ctx), deadlineHit]);
        } catch (e) {
          error = e;
        }
        const timedOut = error instanceof DeadlineError || (error !== undefined && Date.now() >= deadline);
        // A mutating step is judged only by its verify, even if run() threw: the change may have happened.
        let ok: boolean;
        if (step.mutating) ok = await step.verify(ctx).catch(() => false);
        else ok = error === undefined && (step.verify ? await step.verify(ctx).catch(() => false) : true);

        const screenshot = `${String(index + 1).padStart(2, "0")}-${step.id}.png`;
        const shot = await page.screenshot({ path: join(artifactsDir, screenshot) }).then(() => screenshot, () => undefined);
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
        await opts.onStep?.(record);

        if (!ok) {
          status = step.mutating ? "NEEDS_REVIEW" : "FAILED";
          errorCode = timedOut ? "TIMEOUT" : step.mutating ? "UNVERIFIED" : "STEP_FAILED";
          errorMessage = `step ${step.id}: ${record.error}`;
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
  }

  const result: RunResult = {
    runId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    profileId,
    status,
    ...(errorCode && { errorCode, errorMessage }),
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPath: join(artifactsDir, "run-report.html"),
  };
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(result.reportPath, renderReport(result));
  return result;
}
