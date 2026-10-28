import { setTimeout as sleep } from "node:timers/promises";
import { type PageSnapshot, ActionError, act, renderTemplate, scrollFurther, settle } from "@bap/dom-snapshot";
import { elementAction } from "./interpret.ts";
import type { Page } from "playwright-core";

/** The server's answer to an observation during a recording (REQ-DOM-004). */
export type RecordDecision =
  | {
      type: "act";
      stepId: string;
      intent: string;
      /** scroll is exploration while recording (a list further down); it never becomes a recipe step. */
      action: "click" | "dblclick" | "rightclick" | "hover" | "fill" | "select" | "upload" | "press" | "scroll";
      /** Element of the observed snapshot; none for press. */
      ref?: string;
      /** Template: {{input.key}} is filled in here, on the agent; secrets never travel back. */
      value?: string;
      mutating: boolean;
      /** The operator confirmed this mutating action (REQ-DOM-008). */
      confirmed: boolean;
    }
  /** A mutating action waits for the operator: ask again later, the page stays as it is. */
  | { type: "wait" }
  | { type: "done"; version: string }
  | { type: "fail"; code: string; message: string };

export interface Observation {
  snapshot: PageSnapshot;
  screenshot: Buffer;
  /** Outcome of the previous action; null before the first one. */
  last: { ok: boolean; action?: string; error?: string; requests?: SeenRequest[] } | null;
}

/** A request that changes data (not GET) and its answer, seen while the page settled after an action. */
export interface SeenRequest {
  method: string;
  url: string;
  status: number;
}

/** Requests that change data: what a site answers to them proves a mutating step (REQ-DOM-014). */
export function watchChanges(page: Page): { take: () => SeenRequest[] } {
  let seen: SeenRequest[] = [];
  page.on("response", (res) => {
    const req = res.request();
    if (req.method() !== "GET" && req.method() !== "HEAD" && ["document", "xhr", "fetch"].includes(req.resourceType())) seen.push({ method: req.method(), url: req.url(), status: res.status() });
  });
  return {
    take: () => {
      const out = seen;
      seen = [];
      return out;
    },
  };
}

export interface Recorder {
  observe(observation: Observation): Promise<RecordDecision>;
  poll(): Promise<RecordDecision>;
}

export interface RecordedStep {
  sequence: number;
  stepId: string;
  intent: string;
  mutating: boolean;
  resolution: "recorded" | "confirmed";
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  error?: string;
  /** The page the step acted on. */
  screenshot: Buffer;
}

export interface RecordOptions {
  page: Page;
  startUrl: string;
  input: Record<string, unknown>;
  secrets: string[];
  recorder: Recorder;
  onStep: (step: RecordedStep) => Promise<void>;
  shouldCancel?: () => boolean;
  /** Safety net against a loop that never finishes; the server's model budget is the real limit. */
  maxSteps?: number;
  /** How often to ask whether the operator has decided. */
  pollMs?: number;
  /** End of the run's time (epoch ms): the only limit on waiting for the site. */
  deadline?: number;
}

export interface RecordOutcome {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  errorCode?: string;
  errorMessage?: string;
  version?: string;
}

/**
 * Navigation returns once the server answers; `settle` then waits for the page itself. No timeout of its own:
 * only the run's deadline, so a slow site is waited for, not failed.
 */
export const navigation = (deadline?: number) => ({ waitUntil: "commit" as const, timeout: deadline === undefined ? 0 : Math.max(1, deadline - Date.now()) });

/**
 * The agent's half of a recording: shows the page to the server and does what it decides.
 * The model runs on the server only; the agent never sees it (REQ-DOM-009).
 */
export async function recordTask(opts: RecordOptions): Promise<RecordOutcome> {
  const { page, recorder } = opts;
  const pollMs = opts.pollMs ?? 1500;
  const cancelled = (): RecordOutcome | null => (opts.shouldCancel?.() ? { status: "CANCELLED" } : null);

  const changes = watchChanges(page);
  const opened = Date.now();
  await page.goto(opts.startUrl, navigation(opts.deadline));
  const loaded = await settle(page, { secrets: opts.secrets, deadline: opts.deadline });
  await loaded.snap.dispose();
  await opts.onStep({ sequence: 1, stepId: "s01", intent: "Открыть сайт", mutating: false, resolution: "recorded", status: "passed", startedAt: new Date(opened).toISOString(), durationMs: Date.now() - opened, screenshot: await page.screenshot() });

  let last: Observation["last"] = null;
  for (let sequence = 2; sequence <= (opts.maxSteps ?? 60) + 1; sequence++) {
    const stop = cancelled();
    if (stop) return stop;
    // The next look waits for what the last action started to finish loading.
    const { snap } = await settle(page, { secrets: opts.secrets, deadline: opts.deadline });
    try {
      const screenshot = await page.screenshot();
      // Requests sent by the last action have been answered while the page settled.
      if (last) last = { ...last, requests: changes.take() };
      let decision = await recorder.observe({ snapshot: snap.page, screenshot, last });
      while (decision.type === "wait") {
        const waiting = cancelled();
        if (waiting) return waiting;
        await sleep(pollMs);
        decision = await recorder.poll();
      }
      if (decision.type === "done") return { status: "SUCCEEDED", version: decision.version };
      if (decision.type === "fail") return { status: "FAILED", errorCode: decision.code, errorMessage: decision.message };

      const started = Date.now();
      changes.take();
      const value = renderTemplate(decision.value ?? "", opts.input);
      try {
        if (decision.action === "press") await page.keyboard.press(value);
        else if (decision.action === "scroll") {
          if (!(await scrollFurther(page, snap))) throw new ActionError("nothing further down to scroll to");
        } else {
          const handle = decision.ref ? snap.handles.get(decision.ref) : undefined;
          if (!handle) throw new ActionError(`element ${decision.ref} is not on the page`);
          await act(page, handle, elementAction(decision.action, value));
        }
        last = { ok: true, action: decision.action };
      } catch (e) {
        last = { ok: false, action: decision.action, error: e instanceof Error ? e.message : String(e) };
      }
      await opts.onStep({
        sequence,
        stepId: decision.stepId,
        intent: decision.intent,
        mutating: decision.mutating,
        resolution: decision.confirmed ? "confirmed" : "recorded",
        status: last.ok ? "passed" : "failed",
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        ...(last.error && { error: last.error }),
        screenshot,
      });
    } finally {
      await snap.dispose();
    }
  }
  return { status: "FAILED", errorCode: "RECORDING_TOO_LONG", errorMessage: `no result after ${opts.maxSteps ?? 60} steps` };
}
