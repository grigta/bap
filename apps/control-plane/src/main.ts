import { createDb, migrateToLatest } from "@bap/database";
import { buildApp } from "./app.ts";
import { ensureOperator } from "./auth.ts";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`environment variable ${name} is required`);
  return value;
};

const db = createDb(env("DATABASE_URL", "postgres://bap:bap@127.0.0.1:5432/bap"));
await migrateToLatest(db);
if (process.env.BAP_OPERATOR_PASSWORD) await ensureOperator(db, env("BAP_OPERATOR_LOGIN", "operator"), process.env.BAP_OPERATOR_PASSWORD);

const app = buildApp({ db, secureCookies: env("BAP_SECURE_COOKIES", "true") === "true", logger: true });
await app.listen({ host: env("HOST", "127.0.0.1"), port: Number(env("PORT", "3000")) });
