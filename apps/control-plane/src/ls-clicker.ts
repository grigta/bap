import type { preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { errorSchema, sendError } from "./errors.ts";

const remoteRunSchema = z.object({
  running: z.boolean(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  ok: z.boolean().nullable(),
  tail: z.array(z.string()),
});
const remoteStatusSchema = z.object({ run: remoteRunSchema });

export interface LsClickerOptions {
  panelUrl?: string;
  fetch?: typeof globalThis.fetch;
  operatorAuth: preHandlerAsyncHookHandler;
}

export function registerLsClicker(app: App, { panelUrl, fetch: request = globalThis.fetch, operatorAuth }: LsClickerOptions) {
  const baseUrl = panelUrl && new URL(panelUrl);
  if (baseUrl && !["http:", "https:"].includes(baseUrl.protocol)) throw new Error("LS Clicker panel URL must use HTTP or HTTPS");
  const remote = async (path: string, init?: RequestInit) => {
    if (!baseUrl) return null;
    try {
      return await request(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(5_000) });
    } catch {
      return undefined;
    }
  };

  app.get(
    "/api/v1/ls-clicker/status",
    { preHandler: operatorAuth, schema: { response: { 200: z.object({ configured: z.literal(true), run: remoteRunSchema }), 502: errorSchema, 503: errorSchema } } },
    async (request, reply) => {
      const res = await remote("/api/status");
      if (res === null) return sendError(reply, request, 503, "LS_CLICKER_NOT_CONFIGURED", "LS Clicker panel URL is not configured");
      if (!res || !res.ok) return sendError(reply, request, 502, "LS_CLICKER_UNAVAILABLE", "LS Clicker panel did not answer");
      const body = remoteStatusSchema.safeParse(await res.json());
      if (!body.success) return sendError(reply, request, 502, "LS_CLICKER_INVALID_RESPONSE", "LS Clicker panel returned an invalid status");
      return { configured: true as const, run: body.data.run };
    },
  );

  app.post(
    "/api/v1/ls-clicker/runs",
    { preHandler: operatorAuth, schema: { response: { 202: z.object({ accepted: z.literal(true) }), 409: errorSchema, 502: errorSchema, 503: errorSchema } } },
    async (request, reply) => {
      const res = await remote("/api/run", { method: "POST" });
      if (res === null) return sendError(reply, request, 503, "LS_CLICKER_NOT_CONFIGURED", "LS Clicker panel URL is not configured");
      if (!res) return sendError(reply, request, 502, "LS_CLICKER_UNAVAILABLE", "LS Clicker panel did not answer");
      if (res.status === 409) return sendError(reply, request, 409, "LS_CLICKER_RUNNING", "LS Clicker already has a running job");
      if (!res.ok) return sendError(reply, request, 502, "LS_CLICKER_UNAVAILABLE", `LS Clicker panel returned HTTP ${res.status}`);
      return reply.code(202).send({ accepted: true as const });
    },
  );
}
