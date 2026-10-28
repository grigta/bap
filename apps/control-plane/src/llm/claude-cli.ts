import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { type Model, type ModelReply, type ModelRequest, ModelError } from "./model.ts";

export interface ClaudeCliOptions {
  /** The `claude` executable (Claude Code). */
  command?: string;
  /** Model per purpose: recording needs the strongest one, healing one element does not. */
  models?: { record: string; heal: string };
  /** An empty directory of its own: no project settings, and prompt caching is keyed by it. */
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ResultLine {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * Claude Code in headless mode (`claude -p`), signed in with CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
 * (ADR-0026). No tools, no project settings: the model only reads the page and answers by the schema.
 */
export function claudeCliModel(opts: ClaudeCliOptions): Model {
  const command = opts.command ?? "claude";
  const models = opts.models ?? { record: "opus", heal: "sonnet" };
  mkdirSync(opts.cwd, { recursive: true });
  return {
    async ask(req: ModelRequest): Promise<ModelReply> {
      const model = models[req.purpose];
      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--safe-mode",
        "--tools", "",
        "--disallowedTools", "mcp__*",
        "--system-prompt", req.system,
        "--model", model,
        "--max-turns", "3",
        "--no-session-persistence",
        "--json-schema", JSON.stringify(req.schema),
      ];
      const content: unknown[] = [{ type: "text", text: req.prompt }];
      if (req.image) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: req.image.toString("base64") } });
      const input = JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }) + "\n";
      const started = Date.now();
      const stdout = await run(command, args, input, opts.cwd, opts.timeoutMs ?? 180_000, opts.env ?? process.env);
      const result = stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { type?: string })
        .findLast((m): m is ResultLine => m.type === "result");
      if (!result) throw new ModelError("claude returned no result");
      if (result.is_error || result.structured_output === undefined) throw new ModelError(`claude: ${result.subtype}: ${(result.result ?? "no structured output").slice(0, 300)}`);
      return {
        output: result.structured_output,
        model,
        durationMs: result.duration_ms ?? Date.now() - started,
        costUsd: result.total_cost_usd ?? null,
        inputTokens: result.usage ? (result.usage.input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) : null,
        outputTokens: result.usage?.output_tokens ?? null,
      };
    },
  };
}

function run(command: string, args: string[], input: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ModelError(`cannot start ${command}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A failed call still prints its result line; only a missing one is an error here.
      if (out.includes('"type":"result"')) resolve(out);
      else reject(new ModelError(`${command} exited with ${signal ?? code}: ${err.trim().slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}
