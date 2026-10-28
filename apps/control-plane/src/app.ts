import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { type Db, isDatabaseUnavailable } from "@bap/database";
import { sql } from "kysely";
import Fastify, { type FastifySchema } from "fastify";
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { SESSION_COOKIE, checkPassword, hashToken, newToken, requireOperator } from "./auth.ts";
import { audit } from "./audit.ts";
import { errorSchema, sendError } from "./errors.ts";
import { type Coordinator, type CoordinatorHooks, DEFAULT_SCHEDULER, type SchedulerConfig, createCoordinator } from "./coordinator.ts";
import { DEFAULT_FLEET, type FleetConfig, registerFleet } from "./fleet.ts";
import { DEFAULT_LIMITS, type LlmLimits, gatedModel } from "./llm/gate.ts";
import type { Model } from "./llm/model.ts";
import { registerFarming } from "./farming.ts";
import { registerProfiles } from "./profiles.ts";
import { registerRecipes } from "./recipes.ts";
import { registerRuns } from "./runs.ts";
import { purgeArtifacts } from "./retention.ts";
import { webHandler } from "./web.ts";
import type { ObjectStore } from "./storage.ts";

export interface AppOptions {
  db: Db;
  /** Secure cookies need HTTPS; off only for local development and tests. */
  secureCookies?: boolean;
  sessionTtlMs?: number;
  /** true logs to stdout; a stream receives JSON log lines (tests scan them for secrets). */
  logger?: boolean | { stream: NodeJS.WritableStream };
  fleet?: Partial<FleetConfig>;
  scheduler?: Partial<SchedulerConfig>;
  store: ObjectStore;
  /** Serve HTTPS with this certificate (REQ-SEC-001); without it the server is plain HTTP behind a TLS proxy or on localhost. */
  https?: { cert: Buffer | string; key: Buffer | string };
  /** The built panel (apps/web/dist) to serve next to the API; in development Vite serves it. */
  webDir?: string;
  /** Screenshots and reports of finished runs are deleted after this many days (REQ-SEC-010); off when omitted. */
  retention?: { artifactDays: number; sweepIntervalMs?: number };
  /** Model for recording and healing recipes; without it both are refused. Lives on the server only (REQ-DOM-009). */
  model?: Model | null;
  llmLimits?: Partial<LlmLimits>;
}

export interface RegisteredRoute {
  method: string;
  url: string;
  schema?: FastifySchema;
  auth: boolean;
  websocket: boolean;
}

export function buildApp({ db, secureCookies = true, sessionTtlMs = 12 * 60 * 60 * 1000, logger = false, fleet, scheduler, store, retention, https, webDir, model = null, llmLimits }: AppOptions) {
  // Request bodies are never logged; credentials in headers are redacted should headers ever be logged (REQ-SEC-008).
  const redact = ["req.headers.authorization", "req.headers.cookie", "req.headers[\"idempotency-key\"]", "res.headers[\"set-cookie\"]"];
  const app = Fastify({
    logger: logger === false ? false : { redact, ...(typeof logger === "object" && { stream: logger.stream }) },
    genReqId: () => randomUUID(),
    ...(https && { https }),
  }).withTypeProvider<ZodTypeProvider>();
  // Browsers must never fall back to plain HTTP once they have seen this server over HTTPS.
  if (https) app.addHook("onSend", async (_request, reply) => void reply.header("strict-transport-security", "max-age=31536000"));
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

  // Every changing API call is audited: who, which route, which target, allowed or denied (REQ-SEC-012).
  // Request bodies are never stored; only the login name and the agent name, which are not secrets.
  // Written before the response leaves: whatever the caller saw acknowledged is already in the journal.
  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions.url;
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method) || !route?.startsWith("/api/v1/") || request.agentId) return payload;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const params = (request.params ?? {}) as Record<string, string>;
    const details: Record<string, unknown> = { status: reply.statusCode };
    if (route === "/api/v1/auth/login" && typeof body.login === "string") details.login = body.login;
    if (route === "/api/v1/agents/enroll" && typeof body.name === "string") details.name = body.name;
    await audit(db, request, {
      action: `${request.method} ${route}`,
      outcome: reply.statusCode < 400 ? "ok" : "denied",
      ...(params.id && { targetId: params.id, targetType: route.split("/")[3] }),
      details,
    }).catch((e) => request.log.error(e));
    return payload;
  });

  app.setErrorHandler((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) return sendError(reply, request, 400, "VALIDATION_ERROR", err.message);
    // Fastify's own client errors (malformed body, unsupported media type) keep their 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendError(reply, request, status, "BAD_REQUEST", (err as Error).message);
    if (isDatabaseUnavailable(err)) {
      request.log.warn(`database unavailable: ${(err as Error).message}`);
      return sendError(reply, request, 503, "DATABASE_UNAVAILABLE", "The database is unavailable; try again shortly");
    }
    request.log.error(err);
    return sendError(reply, request, 500, "INTERNAL_ERROR", "Internal server error");
  });

  const auth = requireOperator(db);
  const unauthorized = { 401: errorSchema };

  app.get(
    "/api/v1/audit",
    {
      preHandler: auth,
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: {
          200: z.array(z.object({ at: z.string(), actor: z.string(), action: z.string(), outcome: z.enum(["ok", "denied"]), targetType: z.string().nullable(), targetId: z.string().nullable(), details: z.record(z.string(), z.unknown()) })),
          ...unauthorized,
        },
      },
    },
    async (request) =>
      (await db.selectFrom("audit_events").selectAll().orderBy("id", "desc").limit(request.query.limit).execute()).map((e) => ({
        at: e.at.toISOString(),
        actor: e.actor,
        action: e.action,
        outcome: e.outcome,
        targetType: e.target_type,
        targetId: e.target_id,
        details: e.details as Record<string, unknown>,
      })),
  );

  // The panel tells "Control Plane down" (no answer) from "database down" (503) by this route.
  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok"), database: z.literal("up") }),
          503: z.object({ status: z.literal("degraded"), database: z.literal("down") }),
        },
      },
    },
    async (_request, reply) => {
      try {
        await sql`SELECT 1`.execute(db);
        return { status: "ok" as const, database: "up" as const };
      } catch {
        return reply.code(503).send({ status: "degraded", database: "down" });
      }
    },
  );

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

  // Lets tests drive the scheduler directly (e.g. concurrent reservations).
  const internals: { coordinator: Coordinator | null } = { coordinator: null };
  app.decorate("internals", internals);

  // Registered as a plugin so it loads after @fastify/websocket, which websocket routes require.
  app.register(async (scoped) => {
    const fleetConfig = { ...DEFAULT_FLEET, ...fleet };
    const agents = registerFleet(scoped as unknown as App, db, fleetConfig, auth);
    registerProfiles(scoped as unknown as App, db, agents, fleetConfig, auth);
    const hooks: CoordinatorHooks = {};
    const coordinator = createCoordinator(db, agents, fleetConfig, { ...DEFAULT_SCHEDULER, ...scheduler }, hooks);
    registerRuns(scoped as unknown as App, { db, fleet: agents, coordinator, store, operatorAuth: auth });
    registerFarming(scoped as unknown as App, { db, coordinator, operatorAuth: auth });
    const gated = model && gatedModel(db, model, { ...DEFAULT_LIMITS, ...llmLimits }, (entry) => app.log.info(entry, "llm call"));
    hooks.onSucceeded = registerRecipes(scoped as unknown as App, { db, fleet: agents, coordinator, store, operatorAuth: auth, model: gated }).onSucceeded;
    internals.coordinator = coordinator;
    coordinator.start();
    scoped.addHook("onClose", () => coordinator.stop());
  });

  if (webDir) {
    const serveWeb = webHandler(webDir);
    app.setNotFoundHandler((request, reply) =>
      request.method === "GET" && !request.url.startsWith("/api/") ? serveWeb(request, reply) : sendError(reply, request, 404, "NOT_FOUND", `${request.method} ${request.url.split("?")[0]} does not exist`),
    );
  }

  if (retention) {
    const sweep = () =>
      purgeArtifacts(db, store, new Date(Date.now() - retention.artifactDays * 86_400_000))
        .then((purged) => purged > 0 && app.log.info({ purged }, "expired artifacts deleted"))
        .catch((e) => app.log.error(e, "artifact retention sweep failed"));
    let timer: NodeJS.Timeout | undefined;
    app.addHook("onReady", async () => {
      void sweep();
      timer = setInterval(sweep, retention.sweepIntervalMs ?? 3_600_000).unref();
    });
    app.addHook("onClose", async () => clearInterval(timer));
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;

declare module "fastify" {
  interface FastifyInstance {
    registeredRoutes: RegisteredRoute[];
    internals: { coordinator: Coordinator | null };
  }
}
