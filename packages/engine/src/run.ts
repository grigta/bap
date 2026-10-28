import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BrowserProvider, type BrowserSession, ProfileNotFoundError } from "@bap/browser-adapters";
import type { Scenario, StepContext } from "@bap/scenario-sdk";
import { z } from "zod";
import type { Checkpoint, CheckpointStore } from "./checkpoints.ts";
import { renderReport } from "./report.ts";

export type RunStatus = "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW" | "CANCELLED";
export type RunErrorCode = "TIMEOUT" | "STEP_FAILED" | "UNVERIFIED" | "SESSION_START_FAILED" | "PROFILE_NOT_FOUND" | "BROWSER_DISCONNECTED";

export interface StepRecord {
  /** Position in the scenario (1-based); continues across a resume. */
  sequence: number;
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
  /** Last step completed before cancellation, when the run was cancelled. */
  cancelledAfter?: string | null;
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
  /** Polled before every step: cancellation applies at step boundaries only (REQ-RUN-003). */
  shouldCancel?: () => boolean;
  /** This is a resumed run (REQ-RUN-005): continue after resumeFrom, or from the start when there is no checkpoint. */
  resuming?: boolean;
  resumeFrom?: Checkpoint | null;
  /** Called after a confirmed step's checkpoint is saved locally. */
  onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
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
      // CDP refused: look at the session before retrying (REQ-LS-009), then stop it so the retry starts clean.
      const state = await opts.provider.profileState(opts.profileId).catch(() => "unknown");
      await session.closeSession().catch(() => {});
      if (attempt >= attempts) throw new SessionStartError(`browser session did not start after ${attempts} attempts: ${message(e)} (session state: ${state})`);
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

  let cancelledAfter: string | null | undefined;
  if (session) {
    try {
      const page = await session.getPage();
      const resume = opts.resumeFrom ?? null;
      const ctx: StepContext<unknown, unknown> = { page, input: parsed.data, state: resume ? resume.state : scenario.initialState(parsed.data) };
      let lastDone: string | null = resume?.lastCompletedStepId ?? null;

      const saveCheckpoint = async (index: number) => {
        const step = scenario.steps[index]!;
        const next = scenario.steps[index + 1];
        const checkpoint = {
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
        };
        checkpoints.save(checkpoint);
        lastDone = step.id;
        return checkpoint;
      };

      for (let index = resume ? resume.sequence : 0; index < scenario.steps.length; index++) {
        const step = scenario.steps[index]!;
        if (opts.shouldCancel?.()) {
          status = "CANCELLED";
          cancelledAfter = lastDone;
          break;
        }
        const stepStarted = Date.now();
        const remaining = deadline - stepStarted;
        page.setDefaultTimeout(Math.max(1, Math.min(opts.stepTimeoutMs ?? 10_000, remaining)));
        // The first step after a crash may have run partly. A mutating one is never repeated:
        // its verify decides whether it happened (REQ-RUN-006).
        const interrupted = opts.resuming === true && index === (resume?.sequence ?? 0) && step.mutating === true;
        let error: unknown;
        if (!interrupted) {
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
        }
        const timedOut = error instanceof DeadlineError || (error !== undefined && Date.now() >= deadline);
        // A mutating step is judged only by its verify, even if run() threw: the change may have happened.
        let ok: boolean;
        if (step.mutating) ok = await step.verify(ctx).catch(() => false);
        else ok = error === undefined && (step.verify ? await step.verify(ctx).catch(() => false) : true);

        const disconnected = page.isClosed() || (error !== undefined && /(Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Connection closed)/i.test(message(error)));
        let diagnostics = "";
        if (disconnected) {
          // REQ-LS-010: keep what is known about the browser at the moment it went away.
          const state = await opts.provider.profileState(profileId).catch(() => "unknown");
          diagnostics = ` [browser disconnected; profile state: ${state}; last url: ${page.isClosed() ? "n/a" : page.url()}]`;
        }

        const screenshot = `${String(index + 1).padStart(2, "0")}-${step.id}.png`;
        const shot = disconnected ? undefined : await page.screenshot({ path: join(artifactsDir, screenshot) }).then(() => screenshot, () => undefined);
        const failure = error !== undefined ? message(error) : interrupted && !ok ? "interrupted mutating step: verify could not confirm its effect" : !ok ? "verify did not confirm the step" : undefined;
        const record: StepRecord = {
          sequence: index + 1,
          id: step.id,
          mutating: step.mutating === true,
          status: ok ? "passed" : step.mutating ? "unverified" : "failed",
          startedAt: new Date(stepStarted).toISOString(),
          durationMs: Date.now() - stepStarted,
          ...(shot && { screenshot: shot }),
          ...(failure && { error: failure + diagnostics }),
        };
        steps.push(record);

        if (!ok) {
          await opts.onStep?.(record);
          status = step.mutating ? "NEEDS_REVIEW" : "FAILED";
          errorCode = timedOut ? "TIMEOUT" : step.mutating ? "UNVERIFIED" : disconnected ? "BROWSER_DISCONNECTED" : "STEP_FAILED";
          errorMessage = `step ${step.id}: ${record.error}`;
          break;
        }
        // Saved before the step is reported: after a crash the step is never re-run once reported.
        const checkpoint = await saveCheckpoint(index);
        await opts.onStep?.(record);
        await opts.onCheckpoint?.(checkpoint);
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
    ...(status === "CANCELLED" && { cancelledAfter: cancelledAfter ?? null }),
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPath: join(artifactsDir, "run-report.html"),
  };
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(result.reportPath, renderReport(result));
  return result;
}
