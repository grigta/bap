import { setTimeout as sleep } from "node:timers/promises";
import { type ElementAction, type PageSnapshot, type Resolution, type Snapshot, act, captureSnapshot, pageHasText, renderFingerprint, renderTemplate, resolve, scrollFurther, settle } from "@bap/dom-snapshot";
import { type Step, type StepContext, defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";
import { type SeenRequest, navigation, watchChanges } from "./record.ts";
import { type Postcondition, type Recipe, type RecipeStep, matchesProof, secretValues } from "./schema.ts";

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
}

interface RecipeState {
  outputs: Record<string, string>;
}

export class RecipeStepError extends Error {}

/** How many wheel turns a target is looked for further down before it counts as missing. */
const MAX_SCROLL_TURNS = 60;

/** The browser action of a recipe step on its target. */
export function elementAction(action: RecipeStep["action"], value: string): ElementAction {
  if (action === "fill" || action === "select") return { kind: action, value };
  if (action === "upload") return { kind: "upload", files: value.split("\n").filter(Boolean) };
  if (action === "dblclick" || action === "rightclick" || action === "hover") return { kind: action };
  return { kind: "click" };
}

type Ctx = StepContext<Record<string, unknown>, RecipeState>;

/**
 * Turns a recipe into a scenario, so it runs through the same engine: steps, checkpoints, mutating
 * steps proven by verify, recovery (REQ-DOM-006). The model is never called here; healing goes to the server.
 */
export function recipeScenario(opts: RecipeScenarioOptions) {
  const { recipe } = opts;
  const secretsOf = (ctx: Ctx) => secretValues(recipe, ctx.input);
  /** How each step found its target, to keep in the journal next to how it was proven. */
  const found = new Map<string, string>();
  const watchers = new WeakMap<Ctx["page"], ReturnType<typeof watchChanges>>();
  const changesOf = (page: Ctx["page"]) => {
    if (!watchers.has(page)) watchers.set(page, watchChanges(page));
    return watchers.get(page)!;
  };

  /**
   * The target, as soon as it is there. Missing or ambiguous only once the page has finished loading
   * (REQ-DOM-006): a slow site is waited for, not failed; the run's deadline is the only limit.
   */
  const locate = async (ctx: Ctx, step: RecipeStep): Promise<{ snap: Snapshot; ref: string; score: number } | { snap: Snapshot; reason: HealReason; detail: string }> => {
    const fp = renderFingerprint(step.target!, ctx.input);
    let found: Resolution | null = null;
    const look = () => settle(ctx.page, { secrets: secretsOf(ctx), deadline: ctx.deadline, until: (s) => (found = resolve(fp, s.page)).kind === "found" });
    let { snap } = await look();
    let result = found ?? resolve(fp, snap.page);
    // Not found, or only look-alikes (other rows of a list): the right one may be further down.
    for (let turn = 0; result.kind !== "found" && turn < MAX_SCROLL_TURNS && (ctx.deadline === undefined || Date.now() < ctx.deadline); turn++) {
      if (!(await scrollFurther(ctx.page, snap))) break;
      await snap.dispose();
      found = null;
      ({ snap } = await look());
      result = found ?? resolve(fp, snap.page);
    }
    if (result.kind === "found") return { snap, ref: result.ref, score: result.score };
    const detail =
      result.kind === "missing"
        ? `no element matches “${fp.name || fp.text}” (${fp.role}) on the loaded page${result.best ? `; best candidate ${result.best.score}` : ""}`
        : `${result.candidates.length} elements match “${fp.name || fp.text}” equally`;
    return { snap, reason: result.kind, detail };
  };

  /** Checked once the page has finished what the action started; true as soon as it holds. */
  const postconditionHolds = async (ctx: Ctx, post: Postcondition | undefined): Promise<boolean> => {
    if (!post) return true;
    const url = post.url && renderTemplate(post.url, ctx.input);
    const text = post.text && renderTemplate(post.text, ctx.input);
    const holds = (s: Snapshot) => (!url || s.page.url.includes(url)) && (!text || pageHasText(s.page, text));
    const { snap, matched } = await settle(ctx.page, { secrets: secretsOf(ctx), deadline: ctx.deadline, until: holds });
    await snap.dispose();
    return matched || holds(snap);
  };

  /**
   * A mutating step is proven by the site's answer to the recorded request; without that request (the site changed
   * its API, or the agent restarted after the action) by the page (REQ-DOM-014). The journal says which.
   */
  const proven = async (ctx: Ctx, step: RecipeStep): Promise<boolean> => {
    const post = step.postcondition;
    const note = (text: string) => ctx.annotate?.({ note: [found.get(step.id), text].filter(Boolean).join("; ") });
    if (post?.request) {
      const proof = post.request;
      const seen: SeenRequest[] = [];
      const answered = () => (seen.push(...changesOf(ctx.page).take()), seen.some((r) => matchesProof(proof, r)));
      const { snap } = await settle(ctx.page, { secrets: secretsOf(ctx), deadline: ctx.deadline, until: answered });
      await snap.dispose();
      answered();
      const hit = seen.find((r) => matchesProof(proof, r));
      if (hit) {
        const ok = hit.status < 400;
        note(ok ? `подтверждён ответом сайта: ${hit.method} ${new URL(hit.url).pathname} ${hit.status}` : `сайт ответил ошибкой: ${hit.method} ${new URL(hit.url).pathname} ${hit.status}`);
        return ok;
      }
    }
    if (!post?.url && !post?.text) {
      note(`ответа сайта на ${post?.request ? `${post.request.method} ${post.request.path}` : "действие"} нет`);
      return false;
    }
    const ok = await postconditionHolds(ctx, { url: post.url, text: post.text });
    note(ok ? "подтверждён страницей" : "страница не подтвердила результат");
    return ok;
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
        found.set(step.id, `найден по отпечатку (${located.score})`);
        ctx.annotate?.({ resolution: "found", note: found.get(step.id) });
      } else {
        const healed = await heal(ctx, step, located.snap, located.reason, located.detail);
        handle = healed.handle;
        found.set(step.id, healed.note);
        ctx.annotate?.({ resolution: "healed", note: healed.note });
      }
      if (step.action === "extract") {
        const el = located.snap.page.elements.find((e) => located.snap.handles.get(e.ref) === handle)!;
        ctx.state.outputs[step.value!] = el.value ?? el.text;
        return;
      }
      const value = renderTemplate(step.value ?? "", ctx.input);
      await act(ctx.page, handle, elementAction(step.action, value));
    } finally {
      await located.snap.dispose();
    }
  };

  const steps: Step<Record<string, unknown>, RecipeState>[] = recipe.steps.map((step) => {
    const run = async (ctx: Ctx) => {
      if (step.action === "navigate") await ctx.page.goto(renderTemplate(step.value!, ctx.input), navigation(ctx.deadline));
      else if (step.action === "wait") await sleep(Number(step.value));
      else if (step.action === "press") await ctx.page.keyboard.press(step.value!);
      else {
        if (step.mutating) changesOf(ctx.page).take(); // only what this action sends counts as its proof
        await perform(ctx, step);
      }
      if (step.mutating) return; // verify proves it; repeating a mutating action is never an option
      if (await postconditionHolds(ctx, step.postcondition)) return;
      // The target was there but the action led elsewhere: one healed attempt, it is a read-only step.
      if (!opts.heal || !step.target) throw new RecipeStepError(`step ${step.id} (${step.intent}): postcondition did not hold`);
      const snap = await captureSnapshot(ctx.page, { secrets: secretsOf(ctx) });
      try {
        const healed = await heal(ctx, step, snap, "postcondition", "postcondition did not hold after the action");
        ctx.annotate?.({ resolution: "healed", note: healed.note });
        await act(ctx.page, healed.handle, elementAction(step.action, renderTemplate(step.value ?? "", ctx.input)));
      } finally {
        await snap.dispose();
      }
      if (!(await postconditionHolds(ctx, step.postcondition))) throw new RecipeStepError(`step ${step.id} (${step.intent}): postcondition did not hold after healing`);
    };
    return step.mutating
      ? { id: step.id, intent: step.intent, mutating: true as const, run, verify: (ctx: Ctx) => proven(ctx, step) }
      : { id: step.id, intent: step.intent, run };
  });

  // Inputs are checked by name; values are whatever the recipe's templates need.
  const inputSchema = z.object(Object.fromEntries(recipe.inputs.map((i) => [i.name, z.string()]))).loose();
  return defineScenario({ id: opts.id, version: opts.version, inputSchema, autoResume: false, initialState: (): RecipeState => ({ outputs: {} }), steps });
}
