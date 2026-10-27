import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Db } from "@bap/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors.ts";

export const SESSION_COOKIE = "bap_session";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

/** Creates the single operator or replaces its password. */
export async function ensureOperator(db: Db, login: string, password: string): Promise<void> {
  const passwordHash = await hash(password);
  await db
    .insertInto("operators")
    .values({ login, password_hash: passwordHash })
    .onConflict((oc) => oc.column("login").doUpdateSet({ password_hash: passwordHash }))
    .execute();
}

export async function checkPassword(db: Db, login: string, password: string): Promise<string | null> {
  const operator = await db.selectFrom("operators").select(["id", "password_hash"]).where("login", "=", login).executeTakeFirst();
  if (!operator || !(await verify(operator.password_hash, password))) return null;
  return operator.id;
}

/** Resolves the operator from the session cookie or a Bearer API token. */
export async function authenticate(db: Db, request: FastifyRequest): Promise<string | null> {
  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  if (bearer) {
    const token = await db
      .selectFrom("api_tokens")
      .select("operator_id")
      .where("token_hash", "=", hashToken(bearer))
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return token?.operator_id ?? null;
  }
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const session = await db
    .selectFrom("operator_sessions")
    .select("operator_id")
    .where("token_hash", "=", hashToken(cookie))
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  return session?.operator_id ?? null;
}

export function requireOperator(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const operatorId = await authenticate(db, request);
    if (!operatorId) return sendError(reply, request, 401, "UNAUTHORIZED", "Authentication required");
    request.operatorId = operatorId;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    operatorId?: string;
  }
}
