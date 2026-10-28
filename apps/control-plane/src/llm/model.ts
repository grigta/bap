/** One question to the model; the answer must match `schema` (JSON Schema). */
export interface ModelRequest {
  purpose: "record" | "heal";
  runId: string;
  system: string;
  prompt: string;
  /** PNG screenshot of the page. */
  image?: Buffer;
  schema: Record<string, unknown>;
}

export interface ModelReply {
  output: unknown;
  model: string;
  durationMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The model as the server sees it. Only the server holds access to it (REQ-DOM-009). */
export interface Model {
  ask(request: ModelRequest): Promise<ModelReply>;
}

export class ModelError extends Error {}
