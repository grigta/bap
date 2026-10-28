import { readFileSync } from "node:fs";
import { createDb, migrateToLatest } from "@bap/database";
import { buildApp } from "./app.ts";
import { ensureOperator } from "./auth.ts";
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
  retention: { artifactDays: Number(env("BAP_ARTIFACT_RETENTION_DAYS", "30")) },
});
await app.listen({ host: env("HOST", "127.0.0.1"), port: Number(env("PORT", "3000")) });
