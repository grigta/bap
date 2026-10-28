import type { Page } from "playwright-core";
import type { z } from "zod";

export const SDK_VERSION = "0.1.0";

/** How a step found what it acted on; shown in the run's journal (REQ-DOM-012). */
export interface StepNote {
  resolution?: "found" | "healed" | "confirmed" | "recorded";
  note?: string;
}

export interface StepContext<Input, State> {
  page: Page;
  input: Input;
  /** Serializable scenario state, saved in every checkpoint. */
  state: State;
  /** Adds to the journal entry of the current step. */
  annotate?: (note: StepNote) => void;
}

interface BaseStep<Input, State> {
  id: string;
  /** What the step does, in words, for the journal. */
  intent?: string;
  run(ctx: StepContext<Input, State>): Promise<void>;
}

/** A step that only reads: safe to repeat. */
export interface ReadStep<Input, State> extends BaseStep<Input, State> {
  mutating?: false;
  verify?: (ctx: StepContext<Input, State>) => Promise<boolean>;
}

/** A step that changes site data: must prove its effect, it is never retried blindly. */
export interface MutatingStep<Input, State> extends BaseStep<Input, State> {
  mutating: true;
  verify: (ctx: StepContext<Input, State>) => Promise<boolean>;
}

export type Step<Input, State> = ReadStep<Input, State> | MutatingStep<Input, State>;

export interface ScenarioDefinition<Schema extends z.ZodType, State> {
  id: string;
  version: string;
  inputSchema: Schema;
  /** Resume without the operator after a failure when it is provably safe. */
  autoResume: boolean;
  initialState: (input: z.infer<Schema>) => State;
  steps: Step<z.infer<Schema>, State>[];
}

export type Scenario<Schema extends z.ZodType = z.ZodType, State = unknown> = Readonly<ScenarioDefinition<Schema, State>> & {
  readonly sdkVersion: string;
};

export class ScenarioDefinitionError extends Error {}

/** Validates the definition at registration time; bundles built from plain JS bypass the type checks. */
export function defineScenario<Schema extends z.ZodType, State>(definition: ScenarioDefinition<Schema, State>): Scenario<Schema, State> {
  const fail = (message: string) => {
    throw new ScenarioDefinitionError(`scenario ${definition.id}: ${message}`);
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.id)) fail("id must be kebab-case");
  if (!/^\d+\.\d+\.\d+$/.test(definition.version)) fail(`version ${definition.version} is not semver`);
  if (definition.steps.length === 0) fail("has no steps");
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (seen.has(step.id)) fail(`duplicate step id ${step.id}`);
    seen.add(step.id);
    if (step.mutating && typeof step.verify !== "function") fail(`mutating step ${step.id} has no verify`);
  }
  return Object.freeze({ ...definition, sdkVersion: SDK_VERSION });
}
