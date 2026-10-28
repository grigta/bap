import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCliModel } from "./claude-cli.ts";
import { ModelError } from "./model.ts";

const dir = mkdtempSync(join(tmpdir(), "bap-claude-cli-"));

/** A stand-in for the `claude` executable: answers what it was asked, the way `claude -p` prints its result. */
function fakeClaude(mode: "ok" | "error" | "crash"): string {
  const file = join(dir, `claude-${mode}`);
  writeFileSync(
    file,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const msg = JSON.parse(input);
  const flag = (name) => args[args.indexOf(name) + 1];
  if (${JSON.stringify(mode)} === "crash") { process.stderr.write("boom"); process.exit(3); }
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  const result = ${JSON.stringify(mode)} === "ok"
    ? { type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.012, usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 42 },
        structured_output: { cwd: process.cwd(), tools: flag("--tools"), model: flag("--model"), safe: args.includes("--safe-mode"), schema: JSON.parse(flag("--json-schema")), system: flag("--system-prompt"), content: msg.message.content.map((c) => c.type), token: process.env.CLAUDE_CODE_OAUTH_TOKEN } }
    : { type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401" };
  console.log(JSON.stringify(result));
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe("claude -p model", () => {
  test("[REQ-DOM-009] calls Claude Code headless without tools or project settings, with the screenshot and the answer schema", async () => {
    const cwd = join(dir, "llm");
    const model = claudeCliModel({ command: fakeClaude("ok"), cwd, models: { record: "opus", heal: "sonnet" }, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" } });
    const reply = await model.ask({ purpose: "heal", runId: "r", system: "sys", prompt: "page", image: Buffer.from("png"), schema: { type: "object" } });
    expect(reply.output).toEqual({ cwd: expect.stringContaining("llm"), tools: "", model: "sonnet", safe: true, schema: { type: "object" }, system: "sys", content: ["text", "image"], token: "sk-ant-oat01-test" });
    expect(reply).toMatchObject({ model: "sonnet", durationMs: 1200, costUsd: 0.012, inputTokens: 910, outputTokens: 42 });
  });

  test("[REQ-DOM-009] a failed call or a crashed process is an error, not an answer", async () => {
    const ask = (command: string) => claudeCliModel({ command, cwd: join(dir, "llm") }).ask({ purpose: "record", runId: "r", system: "", prompt: "", schema: {} });
    await expect(ask(fakeClaude("error"))).rejects.toThrow(/401/);
    await expect(ask(fakeClaude("crash"))).rejects.toThrow(/exited with 3: boom/);
    await expect(ask(join(dir, "missing"))).rejects.toBeInstanceOf(ModelError);
  });
});
