import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { Db } from "@bap/database";
import Fastify, { type FastifySchema } from "fastify";
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { SESSION_COOKIE, checkPassword, hashToken, newToken, requireOperator } from "./auth.ts";
import { errorSchema, sendError } from "./errors.ts";
import { DEFAULT_FLEET, type FleetConfig, registerFleet } from "./fleet.ts";
import { registerProfiles } from "./profiles.ts";
import { registerRuns } from "./runs.ts";
import type { ObjectStore } from "./storage.ts";

export interface AppOptions {
  db: Db;
  /** Secure cookies need HTTPS; off only for local development and tests. */
  secureCookies?: boolean;
  sessionTtlMs?: number;
  logger?: boolean;
  fleet?: Partial<FleetConfig>;
  store: ObjectStore;
}

export interface RegisteredRoute {
  method: string;
  url: string;
  schema?: FastifySchema;
  auth: boolean;
  websocket: boolean;
}

export function buildApp({ db, secureCookies = true, sessionTtlMs = 12 * 60 * 60 * 1000, logger = false, fleet, store }: AppOptions) {
  const app = Fastify({ logger, genReqId: () => randomUUID() }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cookie);
  app.register(websocket);

  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) {
      if (method !== "HEAD") routes.push({ method, url: r.url, schema: r.schema, auth: r.preHandler !== undefined, websocket: r.websocket === true });
    }
  });
  app.decorate("registeredRoutes", routes);

  app.setErrorHandler((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) return sendError(reply, request, 400, "VALIDATION_ERROR", err.message);
    request.log.error(err);
    return sendError(reply, request, 500, "INTERNAL_ERROR", "Internal server error");
  });

  const auth = requireOperator(db);
  const unauthorized = { 401: errorSchema };

  app.get("/api/v1/health", { schema: { response: { 200: z.object({ status: z.literal("ok") }) } } }, async () => ({
    status: "ok" as const,
  }));

  app.post(
    "/api/v1/auth/login",
    { schema: { body: z.object({ login: z.string().min(1), password: z.string().min(1) }), response: { 204: z.null(), ...unauthorized } } },
    async (request, reply) => {
      const operatorId = await checkPassword(db, request.body.login, request.body.password);
      if (!operatorId) return sendError(reply, request, 401, "UNAUTHORIZED", "Invalid login or password");
      const token = newToken();
      const expiresAt = new Date(Date.now() + sessionTtlMs);
      await db.insertInto("operator_sessions").values({ operator_id: operatorId, token_hash: hashToken(token), expires_at: expiresAt }).execute();
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/", expires: expiresAt });
      return reply.code(204).send(null);
    },
  );

  app.post("/api/v1/auth/logout", { preHandler: auth, schema: { response: { 204: z.null(), ...unauthorized } } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await db.deleteFrom("operator_sessions").where("token_hash", "=", hashToken(token)).execute();
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send(null);
  });

  app.get("/api/v1/auth/me", { preHandler: auth, schema: { response: { 200: z.object({ login: z.string() }), ...unauthorized } } }, async (request) => {
    const operator = await db.selectFrom("operators").select("login").where("id", "=", request.operatorId!).executeTakeFirstOrThrow();
    return { login: operator.login };
  });

  app.post(
    "/api/v1/auth/tokens",
    {
      preHandler: auth,
      schema: { body: z.object({ name: z.string().min(1) }), response: { 201: z.object({ id: z.string(), token: z.string() }), ...unauthorized } },
    },
    async (request, reply) => {
      const token = newToken();
      const row = await db
        .insertInto("api_tokens")
        .values({ operator_id: request.operatorId!, name: request.body.name, token_hash: hashToken(token) })
        .returning("id")
        .executeTakeFirstOrThrow();
      return reply.code(201).send({ id: row.id, token });
    },
  );

  // Registered as a plugin so it loads after @fastify/websocket, which websocket routes require.
  app.register(async (scoped) => {
    const fleetConfig = { ...DEFAULT_FLEET, ...fleet };
    const agents = registerFleet(scoped as unknown as App, db, fleetConfig, auth);
    registerProfiles(scoped as unknown as App, db, agents, fleetConfig, auth);
    registerRuns(scoped as unknown as App, { db, fleet: agents, store, operatorAuth: auth });
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;

declare module "fastify" {
  interface FastifyInstance {
    registeredRoutes: RegisteredRoute[];
  }
}
