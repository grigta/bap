import { setTimeout as sleep } from "node:timers/promises";
import { type PageSnapshot, type Snapshot, act, captureSnapshot, pageHasText, renderFingerprint, renderTemplate, resolve } from "@bap/dom-snapshot";
import { type Step, type StepContext, defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";
import { type Postcondition, type Recipe, type RecipeStep, secretValues } from "./schema.ts";

export type HealReason = "missing" | "ambiguous" | "postcondition";

export interface HealRequest {
  stepId: string;
  reason: HealReason;
  /** What went wrong, for the server log and the journal. */
  detail: string;
  snapshot: PageSnapshot;
  screenshot: Buffer;
}

/** The server's answer: a ref in the snapshot that was sent, already checked to be unique and visible. */
export interface HealAnswer {
  ref: string;
  /** Why the step was healed, in words for the journal. */
  note: string;
}

/** Asks the server for a new target of one step (REQ-DOM-007). */
export type Healer = (request: HealRequest) => Promise<HealAnswer>;

export interface RecipeScenarioOptions {
  id: string;
  version: string;
  recipe: Recipe;
  /** Without it a step that cannot find its target fails, as a scenario step would. */
  heal?: Healer;
  /** How long a step waits for its target to appear before it counts as missing. */
  findTimeoutMs?: number;
  /** How long a postcondition may take to come true. */
  postconditionTimeoutMs?: number;
  pollMs?: number;
}

interface RecipeState {
  outputs: Record<string, string>;
}

export class RecipeStepError extends Error {}

type Ctx = StepContext<Record<string, unknown>, RecipeState>;

/**
 * Turns a recipe into a scenario, so it runs through the same engine: steps, checkpoints, mutating
 * steps proven by verify, recovery (REQ-DOM-006). The model is never called here; healing goes to the server.
 */
export function recipeScenario(opts: RecipeScenarioOptions) {
  const { recipe } = opts;
  const findTimeoutMs = opts.findTimeoutMs ?? 8000;
  const postTimeoutMs = opts.postconditionTimeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 300;
  const secretsOf = (ctx: Ctx) => secretValues(recipe, ctx.input);

  /** Waits for the target; returns the snapshot it was found in, or why it was not. */
  const locate = async (ctx: Ctx, step: RecipeStep): Promise<{ snap: Snapshot; ref: string; score: number } | { snap: Snapshot; reason: HealReason; detail: string }> => {
    const fp = renderFingerprint(step.target!, ctx.input);
    const deadline = Date.now() + findTimeoutMs;
    for (;;) {
      const snap = await captureSnapshot(ctx.page, { secrets: secretsOf(ctx) });
      const found = resolve(fp, snap.page);
      if (found.kind === "found") return { snap, ref: found.ref, score: found.score };
      if (Date.now() >= deadline) {
        const detail =
          found.kind === "missing"
            ? `no element matches “${fp.name || fp.text}” (${fp.role})${found.best ? `; best candidate ${found.best.score}` : ""}`
            : `${found.candidates.length} elements match “${fp.name || fp.text}” equally`;
        return { snap, reason: found.kind, detail };
      }
      await snap.dispose();
      await sleep(pollMs);
    }
  };

  const postconditionHolds = async (ctx: Ctx, post: Postcondition | undefined, timeoutMs: number): Promise<boolean> => {
    if (!post) return true;
    const url = post.url && renderTemplate(post.url, ctx.input);
    const text = post.text && renderTemplate(post.text, ctx.input);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ok = !url || ctx.page.url().includes(url);
      if (ok && text) {
        const snap = await captureSnapshot(ctx.page, { secrets: secretsOf(ctx) }).catch(() => null);
        await snap?.dispose();
        ok = snap !== null && pageHasText(snap.page, text);
      }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  };

  const heal = async (ctx: Ctx, step: RecipeStep, snap: Snapshot, reason: HealReason, detail: string) => {
    if (!opts.heal) throw new RecipeStepError(`step ${step.id} (${step.intent}): ${detail}`);
    const screenshot = await ctx.page.screenshot();
    const answer = await opts.heal({ stepId: step.id, reason, detail, snapshot: snap.page, screenshot });
    const handle = snap.handles.get(answer.ref);
    if (!handle) throw new RecipeStepError(`step ${step.id}: the server chose ${answer.ref}, which is not in the snapshot`);
    return { handle, note: answer.note };
  };

  /** Finds the target (healing if needed) and acts on it. Returns the snapshot's handle for extract. */
  const perform = async (ctx: Ctx, step: RecipeStep) => {
    const located = await locate(ctx, step);
    try {
      let handle;
      if ("ref" in located) {
        handle = located.snap.handles.get(located.ref)!;
        ctx.annotate?.({ resolution: "found", note: `найден по отпечатку (${located.score})` });
      } else {
        const healed = await heal(ctx, step, located.snap, located.reason, located.detail);
        handle = healed.handle;
        ctx.annotate?.({ resolution: "healed", note: healed.note });
      }
      if (step.action === "extract") {
        const el = located.snap.page.elements.find((e) => located.snap.handles.get(e.ref) === handle)!;
        ctx.state.outputs[step.value!] = el.value ?? el.text;
        return;
      }
      const value = renderTemplate(step.value ?? "", ctx.input);
      await act(ctx.page, handle, step.action === "fill" ? { kind: "fill", value } : step.action === "select" ? { kind: "select", value } : { kind: "click" });
    } finally {
      await located.snap.dispose();
    }
  };

  const steps: Step<Record<string, unknown>, RecipeState>[] = recipe.steps.map((step) => {
    const run = async (ctx: Ctx) => {
      if (step.action === "navigate") await ctx.page.goto(renderTemplate(step.value!, ctx.input));
      else if (step.action === "wait") await sleep(Number(step.value));
      else if (step.action === "press") await ctx.page.keyboard.press(step.value!);
      else await perform(ctx, step);
      if (step.mutating) return; // verify proves it; repeating a mutating action is never an option
      if (await postconditionHolds(ctx, step.postcondition, postTimeoutMs)) return;
      // The target was there but the action led elsewhere: one healed attempt, it is a read-only step.
      if (!opts.heal || !step.target) throw new RecipeStepError(`step ${step.id} (${step.intent}): postcondition did not hold`);
      const snap = await captureSnapshot(ctx.page, { secrets: secretsOf(ctx) });
      try {
        const healed = await heal(ctx, step, snap, "postcondition", "postcondition did not hold after the action");
        ctx.annotate?.({ resolution: "healed", note: healed.note });
        await act(ctx.page, healed.handle, step.action === "fill" || step.action === "select" ? { kind: step.action, value: renderTemplate(step.value ?? "", ctx.input) } : { kind: "click" });
      } finally {
        await snap.dispose();
      }
      if (!(await postconditionHolds(ctx, step.postcondition, postTimeoutMs))) throw new RecipeStepError(`step ${step.id} (${step.intent}): postcondition did not hold after healing`);
    };
    return step.mutating
      ? { id: step.id, intent: step.intent, mutating: true as const, run, verify: (ctx: Ctx) => postconditionHolds(ctx, step.postcondition, postTimeoutMs) }
      : { id: step.id, intent: step.intent, run };
  });

  // Inputs are checked by name; values are whatever the recipe's templates need.
  const inputSchema = z.object(Object.fromEntries(recipe.inputs.map((i) => [i.name, z.string()]))).loose();
  return defineScenario({ id: opts.id, version: opts.version, inputSchema, autoResume: false, initialState: (): RecipeState => ({ outputs: {} }), steps });
}
