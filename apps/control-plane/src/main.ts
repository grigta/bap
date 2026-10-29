import { readFileSync } from "node:fs";
import { createDb, migrateToLatest } from "@bap/database";
import { buildApp } from "./app.ts";
import { ensureOperator } from "./auth.ts";
import { claudeCliModel } from "./llm/claude-cli.ts";
import { s3Store } from "./storage.ts";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`environment variable ${name} is required`);
  return value;
};

const db = createDb(env("DATABASE_URL", "postgres://bap:bap@127.0.0.1:5432/bap"));
await migrateToLatest(db);
if (process.env.BAP_OPERATOR_PASSWORD) await ensureOperator(db, env("BAP_OPERATOR_LOGIN", "operator"), process.env.BAP_OPERATOR_PASSWORD);

const store = await s3Store({
  endpoint: env("S3_ENDPOINT", "http://127.0.0.1:8333"),
  bucket: env("S3_BUCKET", "bap"),
  accessKeyId: env("S3_ACCESS_KEY_ID", "bap"),
  secretAccessKey: env("S3_SECRET_ACCESS_KEY", "bap"),
});
const app = buildApp({
  db,
  store,
  secureCookies: env("BAP_SECURE_COOKIES", "true") === "true",
  logger: true,
  // TLS here, or a TLS-terminating proxy in front of a localhost-only server (REQ-SEC-001).
  ...(process.env.TLS_CERT_FILE && { https: { cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(env("TLS_KEY_FILE")) } }),
  ...(process.env.BAP_WEB_DIR && { webDir: process.env.BAP_WEB_DIR }),
  retention: { artifactDays: Number(env("BAP_ARTIFACT_RETENTION_DAYS", "30")) },
  // Recording and healing recipes: Claude Code headless with the token from `claude setup-token` (ADR-0026).
  model: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? claudeCliModel({
        command: env("BAP_CLAUDE_BIN", "claude"),
        cwd: env("BAP_LLM_DIR", `${process.env.HOME ?? "/tmp"}/llm`),
        models: { record: env("BAP_LLM_RECORD_MODEL", "opus"), heal: env("BAP_LLM_HEAL_MODEL", "sonnet") },
      })
    : null,
  llmLimits: {
    recordCallsPerRun: Number(env("BAP_LLM_RECORD_CALLS", "60")),
    healCallsPerRun: Number(env("BAP_LLM_HEAL_CALLS", "20")),
    callsPerDay: Number(env("BAP_LLM_DAILY_CALLS", "500")),
  },
  ...(process.env.BAP_LS_CLICKER_PANEL_URL && { lsClicker: { panelUrl: process.env.BAP_LS_CLICKER_PANEL_URL } }),
});
await app.listen({ host: env("HOST", "127.0.0.1"), port: Number(env("PORT", "3000")) });
