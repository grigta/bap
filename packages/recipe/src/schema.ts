import { z } from "zod";

/** Mirrors Fingerprint from @bap/dom-snapshot; texts may hold {{input.key}} templates. */
export const fingerprintSchema = z.object({
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  text: z.string(),
  attrs: z.record(z.string(), z.string()),
  label: z.string(),
  context: z.string(),
  path: z.array(z.string()),
  frame: z.string(),
  shadowHost: z.string().optional(),
  interactive: z.boolean(),
  position: z.object({ x: z.number(), y: z.number() }),
});

/**
 * The request by which the site accepted a change while recording (REQ-DOM-014): method, path with ids as `*`,
 * and the status class. On replay a successful answer to the same request proves the step.
 */
export const requestProofSchema = z.object({
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().startsWith("/"),
  status: z.enum(["2xx", "3xx"]),
});

/** What must be true after the step; both texts may hold {{input.key}} templates. */
export const postconditionSchema = z
  .object({
    /** The address contains this (e.g. "/order/"). */
    url: z.string().min(1).optional(),
    /** The page shows this text somewhere. */
    text: z.string().min(1).optional(),
    request: requestProofSchema.optional(),
  })
  .refine((p) => p.url !== undefined || p.text !== undefined || p.request !== undefined, "a postcondition needs url, text or request");

export const RECIPE_ACTIONS = ["click", "dblclick", "rightclick", "hover", "fill", "select", "upload", "press", "navigate", "wait", "extract"] as const;
const TARGETED = new Set(["click", "dblclick", "rightclick", "hover", "fill", "select", "upload", "extract"]);
/** Actions that need nothing but their target. */
const POINTER = new Set(["click", "dblclick", "rightclick", "hover"]);

export const recipeStepSchema = z
  .object({
    id: z.string().regex(/^s\d{2,}$/),
    /** What the step does, in words: shown to the operator and given to the model when healing. */
    intent: z.string().min(1),
    action: z.enum(RECIPE_ACTIONS),
    target: fingerprintSchema.optional(),
    /**
     * fill/select: the value template ("{{input.name}}"); upload: a file path on the Mac (template);
     * press: the key; navigate: the URL template; wait: milliseconds; extract: the output name.
     */
    value: z.string().optional(),
    /** Changes site data: never repeated blindly, proven by its postcondition. */
    mutating: z.boolean(),
    postcondition: postconditionSchema.optional(),
    /** Screenshot taken while recording (artifact name of the recording run). */
    screenshot: z.string().optional(),
  })
  .refine((s) => !TARGETED.has(s.action) || s.target !== undefined, "this action needs a target")
  .refine((s) => POINTER.has(s.action) || s.value !== undefined, "this action needs a value")
  .refine((s) => !s.mutating || s.postcondition !== undefined, "a mutating step needs a postcondition to prove its effect");

export const recipeInputSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][\w-]*$/),
  /** Never shown to the model, never written to snapshots or logs (REQ-DOM-003). */
  secret: z.boolean().default(false),
});

/** A recorded solution of a task for one site (REQ-DOM-005). Versions are immutable. */
export const recipeSchema = z.object({
  schema: z.literal(1),
  goal: z.string().min(1),
  startUrl: z.url(),
  inputs: z.array(recipeInputSchema),
  steps: z.array(recipeStepSchema).min(1),
  /** The run that recorded this version, whose screenshots the steps refer to. */
  sourceRunId: z.uuid().optional(),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeStep = z.infer<typeof recipeStepSchema>;
export type RecipeInput = z.infer<typeof recipeInputSchema>;
export type Postcondition = z.infer<typeof postconditionSchema>;
export type RequestProof = z.infer<typeof requestProofSchema>;

/** A path as a pattern: numbers, uuids and long hex ids become `*`, so /order/17 matches /order/42. */
export function pathPattern(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? "*" : seg))
    .join("/");
}

/** Whether a request seen in the browser is the recorded one. */
export function matchesProof(proof: Pick<RequestProof, "method" | "path">, request: { method: string; url: string }): boolean {
  if (request.method !== proof.method) return false;
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }
  const want = proof.path.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((seg, i) => seg === "*" || seg === got[i]);
}

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/** The published JSON Schema of a recipe. */
export const recipeJsonSchema = () => z.toJSONSchema(recipeSchema, { io: "input" });

/** Secret input values of a run: masked in every snapshot the run takes. */
export function secretValues(recipe: Pick<Recipe, "inputs">, input: Record<string, unknown>): string[] {
  return recipe.inputs.filter((i) => i.secret).map((i) => input[i.name]).filter((v): v is string => typeof v === "string" && v.length > 0);
}
